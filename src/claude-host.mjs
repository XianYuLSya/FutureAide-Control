// Claude Desktop host operations for FutureAide Control.
//
// This module is the program-callable surface for the *lifecycle* of a Claude
// Desktop session: create on the first turn, interrupt, destroy, resume, and the
// default model. It drives only what the installed application really exposes:
//
//   1. Native session records `<configRoot>/sessions/<pid>.json` (written by the
//      app when a session actually starts) and their transcripts under
//      `<configRoot>/projects/<munged-cwd>/<sessionId>.jsonl`.
//   2. The renderer's documented deep links (`claude://code/new?q=&folder=`,
//      `claude://code/continue?session=local_<id>`). Checked against the shipped
//      bundle: `new` only prefills the composer, `continue` targets an existing
//      session through its `hostSessionId`.
//   3. A minimal UI operation surface (Windows UI Automation, see
//      `scripts/claude-host.ps1`) for the two things that have no native entry
//      point: pressing send, and interrupting a running turn.
//
// `LocalSessions.start/sendMessage/interrupt/stop/setModel` exist in the main
// process bundle (`index.chunk-CEuIhp7O.js`) but are renderer-only IPC, so they
// are not reachable from this process and are not used.
//
// Nothing here starts a Claude CLI or SDK model, imports a former three-way
// implementation, or keeps an LLM as a scheduler. A UI driver may be injected;
// when it is missing every operation that needs it fails explicitly instead of
// reporting a made-up success.
import { readdir, readFile, stat, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NATIVE_HOST = 'claude-desktop';
/** Exact user message the app appends to a transcript when a turn is stopped. */
export const INTERRUPT_MARKER = '[Request interrupted by user]';
/** Deep-link prompt cap measured in the shipped bundle (`KN`). */
export const DEEP_LINK_PROMPT_LIMIT = 14336;
const SESSION_FILE = /^([1-9][0-9]*)\.json$/;
const HOST_SESSION_ID = /^local_[A-Za-z0-9-]{1,64}$/;
const REQUEST_ID = /^[a-zA-Z0-9-]{1,100}$/;
const BINDING_NONCE = /^[A-Za-z0-9._:-]{8,80}$/;
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_POLL_MS = 250;
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
const configRoot = env => path.resolve(env?.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function defaultIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/** The one line this module injects so a session can be bound without guessing. */
export function markerLine(requestId, bindingNonce) {
  return `[FutureAide Control request ${requestId} · binding ${bindingNonce}]`;
}

// ---------------------------------------------------------------- arguments

export function assertRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) {
    throw fail('invalid-request-id', `requestId must match ${REQUEST_ID}; received ${JSON.stringify(value)}.`);
  }
  return value;
}

export function assertBindingNonce(value) {
  if (typeof value !== 'string' || !BINDING_NONCE.test(value)) {
    throw fail('invalid-binding-nonce',
      `bindingNonce must be 8-80 characters of [A-Za-z0-9._:-]; received ${JSON.stringify(value)}.`);
  }
  return value;
}

/** Markdown-safe text that survives the deep-link `q` parameter and the composer. */
export function assertMessage(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('message-empty', 'message must be non-empty text.');
  return value;
}

async function assertWorkspace(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw fail('invalid-workspace', `workspace must be an absolute path; received ${JSON.stringify(value)}.`);
  }
  const resolved = path.resolve(value);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) throw fail('invalid-workspace', `workspace is not a directory: ${resolved}`);
  return resolved;
}

// ------------------------------------------------------------ native records

function normalizeRecord(record, directory) {
  return Object.freeze({
    nativeSessionId: record.sessionId,
    hostSessionId: typeof record.hostSessionId === 'string' ? record.hostSessionId : undefined,
    pid: record.pid,
    name: typeof record.name === 'string' ? record.name : undefined,
    status: record.status,
    workspace: record.cwd,
    procStart: record.procStart,
    pidDomain: record.pidDomain,
    socketPath: record.messagingSocketPath,
    startedAt: record.startedAt,
    version: record.version,
    kind: record.kind,
    entrypoint: record.entrypoint,
    recordFile: path.join(directory, `${record.pid}.json`),
  });
}

/**
 * Every native session record the app has registered, stale files included.
 * `*.key` files (peer tokens) are never opened: the name filter accepts digits
 * only.
 */
export async function scanNativeSessions({ env = process.env, isAlive = defaultIsAlive } = {}) {
  const directory = path.join(configRoot(env), 'sessions');
  let names;
  try { names = await readdir(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return { directory, sessions: [] };
    throw error;
  }
  const sessions = [];
  for (const name of names) {
    const match = SESSION_FILE.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    let record;
    try { record = JSON.parse((await readFile(path.join(directory, name), 'utf8')).replace(/^\uFEFF/, '')); }
    catch { continue; } // a half-written or vanished record is not a session
    if (record?.entrypoint !== 'claude-desktop' || record.pid !== pid || typeof record.sessionId !== 'string') continue;
    sessions.push({ ...normalizeRecord(record, directory), alive: isAlive(record.pid) });
  }
  return { directory, sessions };
}

/** Live native sessions only. */
export async function listNativeSessions({ env = process.env, isAlive = defaultIsAlive, workspace } = {}) {
  const { sessions } = await scanNativeSessions({ env, isAlive });
  return sessions.filter(session => session.alive && (!workspace || samePath(session.workspace, workspace)));
}

/**
 * Resolve one native session by the identifier the plugin stored for it.
 * A record that no longer exists is reported as unknown; a stale file for a dead
 * process still resolves and carries `alive: false`.
 */
export async function resolveNativeSession(nativeSessionId, { env = process.env, isAlive = defaultIsAlive, workspace } = {}) {
  if (typeof nativeSessionId !== 'string' || !nativeSessionId.trim()) {
    throw fail('invalid-native-session', 'nativeSessionId must be the Claude session id string.');
  }
  const { sessions } = await scanNativeSessions({ env, isAlive });
  const matches = sessions.filter(session => session.nativeSessionId === nativeSessionId);
  if (!matches.length) throw fail('unknown-native-session', `Claude Desktop has no registered session ${nativeSessionId}.`);
  if (matches.length > 1) throw fail('ambiguous-native-session', `Claude Desktop registered ${matches.length} processes for session ${nativeSessionId}.`);
  const [record] = matches;
  if (workspace && !samePath(record.workspace, workspace)) {
    throw fail('session-workspace-mismatch',
      `Session ${nativeSessionId} belongs to ${record.workspace}, not ${path.resolve(workspace)}.`);
  }
  return record;
}

function mungedProject(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/** Transcript file for a session: the munged-path guess first, then a scan. */
export async function findTranscript({ env = process.env, nativeSessionId, workspace } = {}) {
  const root = path.join(configRoot(env), 'projects');
  if (workspace) {
    const guess = path.join(root, mungedProject(workspace), `${nativeSessionId}.jsonl`);
    const info = await stat(guess).catch(() => null);
    if (info?.isFile()) return guess;
  }
  let projects = [];
  try { projects = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const found = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const file = path.join(root, project.name, `${nativeSessionId}.jsonl`);
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) found.push(file);
  }
  if (found.length > 1) throw fail('ambiguous-transcript', `Session ${nativeSessionId} has ${found.length} transcripts.`);
  return found[0];
}

/**
 * Parsed events of a transcript, reading at most the last `maxBytes`. Only the
 * fields a caller can verify against are kept; nothing is echoed verbatim except
 * text the user or the assistant wrote in this session.
 */
export async function readTranscriptEvents(file, { maxBytes = TRANSCRIPT_TAIL_BYTES } = {}) {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return { file, events: [], size: 0 };
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop a partial first line
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event !== 'object') continue;
      const content = event.message?.content;
      events.push({
        type: event.type,
        uuid: event.uuid,
        timestamp: event.timestamp,
        model: event.message?.model,
        text: typeof content === 'string' ? content
          : (Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : ''),
      });
    }
    return { file, events, size, partial: start > 0 };
  } finally { await handle.close(); }
}

function userText(event) { return event?.type === 'user' ? event.text ?? '' : ''; }

/** How many user messages carry exactly this marker (0, 1, or more). */
export function countMarker(events, marker) {
  return events.filter(event => userText(event).includes(marker)).length;
}

/** True when the app recorded an interrupt after `sinceIso`. */
export function interruptedSince(events, sinceIso) {
  const since = sinceIso ? Date.parse(sinceIso) : -Infinity;
  return events.some(event => event.type === 'user' && userText(event).includes(INTERRUPT_MARKER)
    && !(Date.parse(event.timestamp) < since));
}

// ------------------------------------------------------------------- driver

/** A driver that refuses every UI action with a code the caller can surface. */
export function createNullDriver(reason = 'ui-driver-unavailable') {
  const refuse = async () => { throw fail('ui-driver-unavailable',
    'No Claude Desktop UI bridge is available, so this host operation cannot be performed.'); };
  return {
    kind: 'none',
    reason,
    available: false,
    async probe() { return { available: false, reason }; },
    async currentView() { return { available: false, reason }; },
    openNewSession: refuse,
    submit: refuse,
    interrupt: refuse,
    revealSession: refuse,
    readModel: refuse,
    selectModel: refuse,
  };
}

function scriptPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'claude-host.ps1');
}

/**
 * Anchors of the Claude Desktop conversation UI, localized. Measured on
 * Claude 4.4212.0.0: the composer is `Edit "提示词"`, the model control is the
 * button named `模型：…` and the sidebar offers `在 <folder> 中新建会话`.
 * Every label travels to the bridge as JSON, never as a script literal.
 */
export const DEFAULT_UI_PATTERNS = Object.freeze({
  composer: '^(提示词|Prompt|Message to Claude)$',
  modelButton: '^模型[:：]|^Model[:：]',
  send: '^(发送|Send)$',
  stop: '^(停止|Stop)$',
  newInFolder: '^(在 .+ 中新建会话|New session in .+)$',
  newSession: '^(新建|New chat|New session)$',
});

/**
 * The real UI bridge: one PowerShell script, JSON in on stdin, JSON out on a
 * file. Non-ASCII text (window titles, composer text, folder names) never
 * travels through argv.
 */
export function createPowerShellDriver({
  script = scriptPath(), timeoutMs = 20000, powershell = 'powershell.exe',
  patterns = DEFAULT_UI_PATTERNS,
} = {}) {
  async function run(action, payload = {}, { timeoutMs: actionTimeout = timeoutMs } = {}) {
    const outFile = path.join(os.tmpdir(), `futureaide-claude-host-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const body = JSON.stringify({ ...payload, action, patterns });
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Action', action, '-OutFile', outFile], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FA_CLAUDE_HOST_ACTION: action },
    });
    const stderr = [];
    child.stderr.on('data', chunk => { if (stderr.length < 40) stderr.push(chunk.toString('utf8')); });
    child.stdout.on('data', () => {});
    child.stdin.on('error', () => {}); // the bridge may exit before reading
    // The payload (including every localized label and the prompt) travels on
    // stdin as UTF-8, never through argv.
    child.stdin.end(body, 'utf8');
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, actionTimeout);
    const exit = await new Promise(resolve => {
      child.once('error', error => resolve({ code: 'spawn-error', error }));
      child.once('close', code => resolve({ code: 'exit', status: code }));
    });
    clearTimeout(timer);
    let parsed;
    try { parsed = JSON.parse((await readFile(outFile, 'utf8')).replace(/^\uFEFF/, '')); }
    catch { parsed = undefined; }
    if (!parsed) {
      throw fail('ui-bridge-failed',
        `The Claude Desktop UI bridge (${action}) produced no result${stderr.length ? `: ${stderr.join('').trim().slice(0, 400)}` : ''}.`,
        { action, exit });
    }
    if (parsed.ok !== true) throw fail(parsed.code ?? 'ui-bridge-refused', parsed.message ?? `The ${action} action was refused.`, { action, detail: parsed });
    return parsed.value;
  }
  return {
    kind: 'powershell-uia',
    available: true,
    async probe() { return run('probe'); },
    async currentView() { return run('view'); },
    async openNewSession({ workspace, prompt, allowDeepLink = true, folderLabel }) {
      return run('new-session', { workspace, prompt, allowDeepLink, folderLabel: folderLabel ?? path.basename(workspace) });
    },
    async submit({ prompt } = {}) { return run('submit', { prompt }); },
    async interrupt() { return run('interrupt'); },
    async revealSession({ hostSessionId, title, allowDeepLink = true }) {
      return run('reveal', { hostSessionId, title, allowDeepLink });
    },
    async readModel() { return run('model-read'); },
    async selectModel({ label }) { return run('model-select', { label }); },
  };
}

function driverAvailable(driver) {
  return Boolean(driver) && driver.available !== false && driver.kind !== 'none';
}

function requireDriver(driver, operation) {
  if (!driverAvailable(driver)) {
    throw fail('ui-driver-unavailable',
      `Claude Desktop exposes no programmatic API for ${operation}; a UI driver is required and none is available.`);
  }
  return driver;
}

// -------------------------------------------------------------------- views

/** Does the visible Claude page belong to this session? Never guess by title alone. */
export function viewMatchesSession(view, record) {
  if (!view?.available || typeof view.documentName !== 'string') return false;
  if (!record?.name) return false;
  const name = record.name.trim();
  const document = view.documentName;
  return document === name || document.startsWith(`${name} - `) || document.startsWith(`${name} — `);
}

async function ensureSessionVisible(record, { driver, env, allowDeepLink }) {
  const view = await driver.currentView().catch(() => undefined);
  if (viewMatchesSession(view, record)) return { view, revealed: false };
  const revealed = await driver.revealSession({ hostSessionId: record.hostSessionId, title: record.name, allowDeepLink })
    .catch(error => ({ revealed: false, error: { code: error.code, message: error.message } }));
  const after = await driver.currentView().catch(() => undefined);
  if (!viewMatchesSession(after, record)) {
    throw fail('session-not-visible',
      `The Claude Desktop window is not showing ${record.name ?? record.nativeSessionId}; refusing to send UI input that could reach another session.`,
      { view: after, reveal: revealed });
  }
  return { view: after, revealed: true };
}

// ------------------------------------------------------------------ creating

async function findDeliveredSession({ env, workspace, request, isAlive }) {
  const { sessions } = await scanNativeSessions({ env, isAlive });
  const candidates = sessions.filter(session => session.alive && samePath(session.workspace, workspace));
  for (const record of candidates) {
    const file = await findTranscript({ env, nativeSessionId: record.nativeSessionId, workspace: record.workspace });
    if (!file) continue;
    const { events } = await readTranscriptEvents(file);
    if (events.some(event => userText(event).includes(`[FutureAide Control request ${request} ·`))) return record;
  }
  return undefined;
}

function newSessionDeepLink({ workspace, prompt }) {
  const params = new URLSearchParams();
  if (prompt) {
    if (prompt.length > DEEP_LINK_PROMPT_LIMIT) {
      throw fail('prompt-exceeds-deep-link',
        `The first message is ${prompt.length} characters; the Claude deep link carries at most ${DEEP_LINK_PROMPT_LIMIT}.`);
    }
    params.set('q', prompt);
  }
  params.append('folder', path.resolve(workspace));
  params.set('src', 'external');
  return `claude://code/new?${params.toString()}`;
}

function continueSessionDeepLink({ hostSessionId }) {
  if (typeof hostSessionId !== 'string' || !HOST_SESSION_ID.test(hostSessionId)) {
    throw fail('invalid-host-session-id', `Not a Claude host session id: ${JSON.stringify(hostSessionId)}.`);
  }
  return `claude://code/continue?session=${encodeURIComponent(hostSessionId)}`;
}

export const deepLinks = Object.freeze({ newSessionDeepLink, continueSessionDeepLink });

/**
 * Create the session with its first turn.
 *
 * A Claude Desktop session does not exist until a message is actually sent, so
 * this is the only place a session is created. The caller's request id and
 * binding nonce are written into the first message; the session is reported as
 * created only when a *new* native record registers in this workspace and its
 * transcript carries that marker exactly once.
 */
export async function createFirstTurn({
  workspace, requestId, message, bindingNonce, model = undefined,
}, {
  env = process.env,
  driver = createNullDriver(),
  isAlive = defaultIsAlive,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  allowDeepLink = true,
} = {}) {
  const directory = await assertWorkspace(workspace);
  const request = assertRequestId(requestId);
  const nonce = assertBindingNonce(bindingNonce);
  const text = assertMessage(message).trimEnd();
  const marker = markerLine(request, nonce);
  if (text.includes(marker)) throw fail('message-already-marked', 'message already carries this request marker.');
  if (text.includes('[FutureAide Control request ')) {
    throw fail('message-already-marked', 'message already carries a FutureAide request marker.');
  }
  const payload = `${text}\n\n${marker}`;

  const reused = await findDeliveredSession({ env, workspace: directory, request, isAlive });
  if (reused) {
    return { created: false, reused: true, status: 'already-delivered', nativeSessionId: reused.nativeSessionId,
      hostSessionId: reused.hostSessionId, pid: reused.pid, requestId: request, workspace: directory,
      verifiedBy: ['existing-transcript-marker'] };
  }

  const ui = requireDriver(driver, 'creating a session');
  const baseline = new Set((await scanNativeSessions({ env, isAlive })).sessions.map(session => session.nativeSessionId));
  const startedAt = new Date().toISOString();
  const launch = await ui.openNewSession({ workspace: directory, prompt: payload, allowDeepLink });
  const submitted = await ui.submit({ prompt: payload, prefilled: launch?.prefilled === true });

  const deadline = Date.now() + timeoutMs;
  let observed;
  while (Date.now() < deadline) {
    const { sessions } = await scanNativeSessions({ env, isAlive });
    const fresh = sessions.filter(session => session.alive && !baseline.has(session.nativeSessionId)
      && samePath(session.workspace, directory));
    if (fresh.length > 1) {
      return { created: false, status: 'ambiguous', reason: 'several-new-sessions', candidates: fresh.map(session => session.nativeSessionId),
        requestId: request, workspace: directory, evidence: { launch, submitted } };
    }
    if (fresh.length === 1) {
      const record = fresh[0];
      const file = await findTranscript({ env, nativeSessionId: record.nativeSessionId, workspace: record.workspace });
      if (file) {
        const { events } = await readTranscriptEvents(file);
        const hits = countMarker(events, marker);
        observed = { record, file, hits };
        if (hits === 1) {
          return {
            created: true,
            status: 'sent',
            nativeSessionId: record.nativeSessionId,
            hostSessionId: record.hostSessionId,
            pid: record.pid,
            name: record.name,
            workspace: directory,
            recordFile: record.recordFile,
            transcriptFile: file,
            requestId: request,
            bindingNonce: nonce,
            marker,
            verifiedBy: ['native-record-created', 'transcript-marker-once'],
            strategy: launch?.strategy,
            submit: submitted?.method,
            model: model === undefined ? undefined
              : { requested: model, applied: false, note: 'the deep link carries no model; the session uses the host default' },
            startedAt,
            elapsedMs: Date.now() - Date.parse(startedAt),
          };
        }
      }
    }
    await sleep(pollMs);
  }

  return {
    created: false,
    status: 'unconfirmed',
    reason: observed ? `transcript-marker-count-${observed.hits}` : 'no-native-session-registered',
    requestId: request,
    bindingNonce: nonce,
    workspace: directory,
    evidence: {
      launch,
      submitted,
      session: observed ? { nativeSessionId: observed.record.nativeSessionId, markerCount: observed.hits } : undefined,
    },
    startedAt,
    elapsedMs: Date.now() - Date.parse(startedAt),
  };
}

// ---------------------------------------------------------------- interrupt

/**
 * Stop the running turn of one session. Verification is the app's own marker,
 * never "the click succeeded".
 */
export async function interrupt({ nativeSessionId }, {
  env = process.env,
  driver = createNullDriver(),
  isAlive = defaultIsAlive,
  timeoutMs = 20000,
  pollMs = DEFAULT_POLL_MS,
  allowDeepLink = true,
} = {}) {
  const record = await resolveNativeSession(nativeSessionId, { env, isAlive });
  if (!record.alive) {
    return { interrupted: false, status: 'not-running', reason: 'session-process-gone', nativeSessionId, verifiedBy: [] };
  }
  const ui = requireDriver(driver, 'interrupting a turn');
  const visible = await ensureSessionVisible(record, { driver: ui, env, allowDeepLink });
  const file = await findTranscript({ env, nativeSessionId: record.nativeSessionId, workspace: record.workspace });
  if (!file) throw fail('transcript-missing', `No transcript for session ${nativeSessionId}; refusing to interrupt unverifiably.`);
  const before = await readTranscriptEvents(file);
  const since = before.events.at(-1)?.timestamp ?? new Date().toISOString();
  const press = await ui.interrupt();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await readTranscriptEvents(file);
    if (interruptedSince(now.events, since)) {
      return { interrupted: true, status: 'interrupted', nativeSessionId, method: press?.method,
        verifiedBy: ['transcript-interrupt-marker'], revealed: visible.revealed };
    }
    await sleep(pollMs);
  }
  return { interrupted: false, status: 'unconfirmed', reason: 'interrupt-marker-not-written',
    nativeSessionId, method: press?.method, revealed: visible.revealed,
    evidence: { since, transcriptFile: file } };
}

// ------------------------------------------------------------------ destroy

/**
 * End a session by ending its own host process. This never deletes a transcript,
 * a project directory, or any user data, and it refuses to act on a session the
 * caller did not supply by id.
 */
export async function destroy({ nativeSessionId }, {
  env = process.env,
  isAlive = defaultIsAlive,
  kill = pid => process.kill(pid),
  timeoutMs = 15000,
  pollMs = DEFAULT_POLL_MS,
  protectedPids = [],
} = {}) {
  const record = await resolveNativeSession(nativeSessionId, { env, isAlive });
  if (protectedPids.includes(record.pid)) {
    throw fail('protected-pid', `Refusing to stop pid ${record.pid}: it is a protected process.`);
  }
  if (!record.procStart || !record.pidDomain) {
    throw fail('unbound-record', `Session ${nativeSessionId} has no process identity; refusing to stop it.`);
  }
  const file = await findTranscript({ env, nativeSessionId, workspace: record.workspace }).catch(() => undefined);
  if (!record.alive) {
    return { destroyed: false, status: 'already-stopped', nativeSessionId, deleted: false,
      transcriptKept: Boolean(file), verifiedBy: ['process-not-running'] };
  }
  try { kill(record.pid); }
  catch (error) {
    if (error.code !== 'ESRCH') throw fail('destroy-failed', `Could not stop pid ${record.pid}: ${error.message}`, { nativeSessionId });
  }
  const deadline = Date.now() + timeoutMs;
  let gone = false;
  while (Date.now() < deadline) {
    if (!isAlive(record.pid)) { gone = true; break; }
    await sleep(pollMs);
  }
  let recordRemoved = false;
  try { await stat(record.recordFile); }
  catch (error) { if (error.code === 'ENOENT') recordRemoved = true; }
  return {
    destroyed: gone,
    status: gone ? 'ended' : 'unconfirmed',
    reason: gone ? undefined : 'process-still-running',
    nativeSessionId,
    pid: record.pid,
    deleted: false,
    recordRemoved,
    transcriptKept: Boolean(file),
    verifiedBy: gone ? ['process-exit'] : [],
  };
}

// ------------------------------------------------------------------- resume

/**
 * Reattach to a session. A live session needs no window work: the caller keeps
 * delivering through the native inbox. A dead session is reopened through the
 * `code/continue` deep link and only reported resumed when a record for the same
 * session id registers again.
 */
export async function resume({ nativeSessionId, hostSessionId: hint }, {
  env = process.env,
  driver = createNullDriver(),
  isAlive = defaultIsAlive,
  timeoutMs = 30000,
  pollMs = DEFAULT_POLL_MS,
  allowDeepLink = true,
} = {}) {
  const record = await resolveNativeSession(nativeSessionId, { env, isAlive }).catch(error => {
    if (error.code === 'unknown-native-session') return undefined;
    throw error;
  });
  if (record?.alive) {
    return { resumed: true, mode: 'live', nativeSessionId, hostSessionId: record.hostSessionId, pid: record.pid,
      workspace: record.workspace, name: record.name, verifiedBy: ['record-and-process-live'] };
  }
  const hostSessionId = record?.hostSessionId ?? hint;
  if (!hostSessionId) {
    return { resumed: false, status: 'gone', reason: 'unknown-native-session',
      nativeSessionId, detail: 'No record and no hostSessionId to reopen; nothing was created.' };
  }
  const ui = requireDriver(driver, 'resuming a closed session');
  const opened = await ui.revealSession({ hostSessionId, title: record?.name, allowDeepLink });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { sessions } = await scanNativeSessions({ env, isAlive });
    const match = sessions.find(session => session.nativeSessionId === nativeSessionId && session.alive);
    if (match) {
      return { resumed: true, mode: 'reopened', nativeSessionId, hostSessionId: match.hostSessionId,
        pid: match.pid, workspace: match.workspace, name: match.name,
        verifiedBy: ['native-record-registered'], opened };
    }
    await sleep(pollMs);
  }
  return { resumed: false, status: 'unconfirmed', reason: 'no-session-record-after-reopen',
    nativeSessionId, hostSessionId, opened };
}

// ------------------------------------------------------------------- models

/** Effort words the composer's model control appends after the model name. */
export const EFFORT_WORDS = Object.freeze(['最高', '高', '中', '低', 'Max', 'High', 'Medium', 'Low']);

/**
 * Split the model control's accessible name into a model label and an effort.
 * Measured name: `模型：Opus 5.5 最高 3.5× 或更多用量` -> `Opus 5.5` / `最高`.
 */
export function parseModelControl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { label: null, raw };
  let text = raw.trim();
  const colon = text.search(/[:：]/);
  if (colon >= 0) text = text.slice(colon + 1).trim();
  const cross = text.search(/[×]/); // a usage hint follows ('3.5× or more')
  if (cross > 0) {
    let index = cross;
    while (index > 0 && /[\d.\s]/.test(text[index - 1])) index -= 1;
    text = text.slice(0, index).trim();
  }
  let effort;
  for (const word of EFFORT_WORDS) {
    if (text.endsWith(word) && text.length > word.length) {
      effort = word;
      text = text.slice(0, -word.length).trim();
      break;
    }
  }
  return { label: text || null, effort, raw };
}

/** Normalize whatever a driver returned into `{label, effort, raw}`. */
export function modelInfo(value) {
  if (typeof value === 'string') return parseModelControl(value);
  if (!value || typeof value !== 'object') return { label: null };
  if (typeof value.raw === 'string' && value.raw.trim()) {
    const parsed = parseModelControl(value.raw);
    return { ...parsed, effort: value.effort ?? parsed.effort };
  }
  if (typeof value.label === 'string' && value.label.trim()) {
    return { label: value.label.trim(), effort: value.effort, raw: value.raw };
  }
  return { label: null };
}

/** Read the model the composer would use. Null beats a guess. */
export async function readDefaultModel({ driver = createNullDriver() } = {}) {
  if (!driverAvailable(driver)) {
    return { model: null, label: null, source: 'unavailable', verified: false, reason: 'ui-driver-unavailable' };
  }
  const view = await driver.readModel();
  const info = modelInfo(view);
  if (!info.label) {
    return { model: null, label: null, source: 'unavailable', verified: false, reason: 'model-control-not-found' };
  }
  return { model: null, label: info.label, effort: info.effort, raw: info.raw,
    source: 'ui-model-control', verified: true };
}

/**
 * Select the model through the host's own control and confirm it by reading the
 * control back. `accepted` is false unless the host shows the new value.
 */
export async function selectModel({ model, nativeSessionId = undefined }, {
  driver = createNullDriver(), env = process.env, isAlive = defaultIsAlive, timeoutMs = 10000, pollMs = 200,
} = {}) {
  const label = typeof model === 'string' ? model.trim() : '';
  if (!label) throw fail('invalid-model', 'model must be a model label such as "Opus 5.5".');
  if (nativeSessionId !== undefined) {
    const record = await resolveNativeSession(nativeSessionId, { env, isAlive });
    await ensureSessionVisible(record, { driver: requireDriver(driver, 'selecting a model'), env, allowDeepLink: true });
  }
  const ui = requireDriver(driver, 'selecting a model');
  const before = modelInfo(await ui.readModel().catch(() => undefined));
  const attempt = await ui.selectModel({ label });
  let after = attempt?.observed ? modelInfo(attempt.observed) : { label: null };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!after.label) after = modelInfo(await ui.readModel().catch(() => undefined));
    if (after.label === label) {
      return { accepted: true, model: label, requested: label,
        before: before.label, after: after.label, attempt };
    }
    await sleep(pollMs);
  }
  return { accepted: false, status: 'unconfirmed', requested: label, observedBefore: before.label,
    observedAfter: after.label, attempt,
    detail: 'The Claude Desktop model control did not show the requested model, so no selection is claimed.' };
}

// -------------------------------------------------------------------- probe

/**
 * What this host can really do right now. Each capability is reported as
 * verified, unavailable, or unsupported — never as "probably fine".
 */
export async function probeClaudeHost({ env = process.env, driver = createNullDriver(), isAlive = defaultIsAlive } = {}) {
  const { directory, sessions } = await scanNativeSessions({ env, isAlive });
  const live = sessions.filter(session => session.alive);
  const ui = driverAvailable(driver) ? await driver.probe().catch(error => ({ available: false, reason: error.code ?? 'ui-bridge-failed' })) : { available: false, reason: 'ui-driver-unavailable' };
  const model = await readDefaultModel({ driver }).catch(() => ({ model: null, verified: false }));
  return {
    application: NATIVE_HOST,
    configRoot: configRoot(env),
    sessionDirectory: directory,
    sessions: { total: sessions.length, live: live.length },
    ui,
    model,
    capabilities: {
      createFirstTurn: ui.available ? 'verified-surface' : 'unavailable',
      interrupt: ui.available ? 'verified-surface' : 'unavailable',
      destroy: 'verified-surface',
      resume: { live: 'verified-surface', closed: ui.available ? 'unverified' : 'unavailable' },
      readDefaultModel: model.verified ? 'verified-surface' : 'unavailable',
      selectModel: ui.available ? 'unverified' : 'unavailable',
      nativeInbox: 'separate-module',
    },
    deepLinks: {
      newSession: 'prefill-only',
      continueSession: 'requires-hostSessionId',
      promptLimit: DEEP_LINK_PROMPT_LIMIT,
    },
  };
}

// ----------------------------------------------------------------- print-run

/**
 * `node src/claude-host.mjs <action> [json]` — one command per host operation, so
 * a human or a supervisor can verify the surface without a UI test harness.
 * The payload is JSON on the command line or on stdin; prompts never travel
 * through argv text.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const stdin = Buffer.concat(chunks).toString('utf8').trim();
  const inline = process.argv[3]?.startsWith('{') ? process.argv[3] : '';
  const usage = 'usage: node src/claude-host.mjs <probe|sessions|model|create|interrupt|destroy|resume|select-model> [json]';
  try {
    const payload = JSON.parse(inline || stdin || '{}');
    const driver = createPowerShellDriver();
    const handler = {
      probe: () => probeClaudeHost({ driver }),
      sessions: () => listNativeSessions({ workspace: payload.workspace }),
      model: () => readDefaultModel({ driver }),
      create: () => createFirstTurn(payload, { driver,
        allowDeepLink: payload.allowDeepLink !== false,
        ...(Number.isSafeInteger(payload.timeoutMs) ? { timeoutMs: payload.timeoutMs } : {}) }),
      interrupt: () => interrupt(payload, { driver,
        allowDeepLink: payload.allowDeepLink !== false,
        ...(Number.isSafeInteger(payload.timeoutMs) ? { timeoutMs: payload.timeoutMs } : {}) }),
      // The window process and the partner session a person is talking to are
      // never destroyed from the command line by accident.
      destroy: () => destroy(payload, { protectedPids: payload.protectedPids ?? [] }),
      resume: () => resume(payload, { driver }),
      'select-model': () => selectModel(payload, { driver }),
    }[action];
    if (!handler) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: usage })}\n`);
      process.exitCode = 2;
    } else {
      process.stdout.write(`${JSON.stringify(await handler(), null, 2)}\n`);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message })}\n`);
    process.exitCode = 1;
  }
}
