// Claude Desktop host operations for FutureAide Control.
//
// This module is the program-callable surface for the *lifecycle* of a Claude
// Desktop session: create on the first turn, interrupt, delete, resume, and the
// model. It drives only what the installed application really exposes:
//
//   1. Native session records `<configRoot>/sessions/<pid>.json` (written by the
//      app when a session actually starts) and their transcripts under
//      `<configRoot>/projects/<munged-cwd>/<sessionId>.jsonl`, plus the
//      per-session `session-env` / `file-history` directories.
//   2. The renderer's documented deep links (`claude://code/new?q=&folder=`,
//      `claude://code/continue?session=local_<id>`), checked against the shipped
//      bundle: `new` only prefills the composer, `continue` targets an existing
//      session through its `hostSessionId`.
//   3. A minimal UI operation surface (Windows UI Automation, see
//      `scripts/claude-host.ps1`) for what has no native entry point: the
//      sidebar's "new session in this folder", pressing send, interrupting a
//      running turn, and the sidebar's own "more options -> delete".
//
// `LocalSessions.*` exists in the main-process bundle but is renderer-only IPC,
// so it is unreachable from this process and is not used. Nothing here starts a
// Claude CLI or SDK model, imports a former three-way implementation, or keeps an
// LLM as a scheduler. A UI driver may be injected; when it is missing every
// operation that needs it fails explicitly instead of reporting a fake success.
import { readdir, readFile, stat, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NATIVE_HOST = 'claude-desktop';
/** Exact user message the app appends to a transcript when a turn is stopped. */
export const INTERRUPT_MARKER = '[Request interrupted by user]';
/** Deep-link prompt cap measured in the shipped bundle. */
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
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
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
 * A record for a dead process still resolves and carries `alive: false`.
 */
export async function resolveNativeSession(nativeSessionId, {
  env = process.env, isAlive = defaultIsAlive, workspace,
} = {}) {
  if (typeof nativeSessionId !== 'string' || !nativeSessionId.trim()) {
    throw fail('invalid-native-session', 'nativeSessionId must be the Claude session id string.');
  }
  const { sessions } = await scanNativeSessions({ env, isAlive });
  const matches = sessions.filter(session => session.nativeSessionId === nativeSessionId);
  if (!matches.length) throw fail('unknown-native-session', `Claude Desktop has no registered session ${nativeSessionId}.`);
  if (matches.length > 1) {
    throw fail('ambiguous-native-session', `Claude Desktop registered ${matches.length} processes for session ${nativeSessionId}.`);
  }
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

/** Parsed events of a transcript, reading at most the last `maxBytes`. */
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
      events.push(normalizeEvent(event));
    }
    return { file, events, size, partial: start > 0 };
  } finally { await handle.close(); }
}

const HEAD_INITIAL_BYTES = 1024 * 1024;
const HEAD_MAX_BYTES = 16 * 1024 * 1024;

/** One transcript record in the shape the readers use. */
function normalizeEvent(event) {
  const content = event.message?.content;
  const parts = Array.isArray(content) ? content : [];
  const textParts = typeof content === 'string' ? [content.trim()]
    : parts.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text.trim());
  const enqueueText = event.type === 'queue-operation' && typeof event.content === 'string' ? event.content : undefined;
  return {
    type: event.type,
    operation: event.operation,
    uuid: event.uuid,
    timestamp: event.timestamp,
    role: event.message?.role,
    model: event.message?.model,
    effort: event.effort ?? event.perTurnEffort,
    stopReason: event.message?.stop_reason,
    textParts,
    text: typeof content === 'string' ? content : (textParts.length ? textParts.join('\n') : ''),
    enqueueText,
  };
}

/**
 * The first record the user actually put into the session: the native enqueue
 * (`queue-operation` with the message text) or the user message itself.
 */
export function firstInputOf(events) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === 'queue-operation' && typeof event.enqueueText === 'string' && event.enqueueText.trim()) {
      return { index, kind: 'enqueue', text: event.enqueueText, timestamp: event.timestamp };
    }
    if (event.type === 'user' && event.role === 'user' && typeof event.text === 'string' && event.text.trim()) {
      return { index, kind: 'user', text: event.text, timestamp: event.timestamp };
    }
  }
  return undefined;
}

/**
 * The opening of a transcript: whole records only, from the first bytes.
 *
 * A first turn is written at the top of the file, so a session whose transcript
 * has grown past any tail window still carries it in its head. The window starts
 * at 1 MiB (a 100k first message fits comfortably) and grows only while the
 * first record is still cut off, up to 16 MiB; if even that is not enough the
 * result says `truncated` instead of pretending the record is absent.
 */
export async function readTranscriptHead(file, { initialBytes = HEAD_INITIAL_BYTES, maxBytes = HEAD_MAX_BYTES } = {}) {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return { file, events: [], size: 0, truncated: false, bytesRead: 0 };
  try {
    const { size } = await handle.stat();
    let window = Math.min(initialBytes, Math.max(size, 1));
    for (;;) {
      const buffer = Buffer.alloc(window);
      const { bytesRead } = await handle.read(buffer, 0, window, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const complete = bytesRead >= size;
      const whole = complete ? text : text.slice(0, text.lastIndexOf('\n') + 1);
      const events = [];
      for (const line of whole.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(normalizeEvent(JSON.parse(line))); } catch { /* partial or foreign line */ }
      }
      const firstInput = firstInputOf(events);
      if (firstInput || complete || window >= maxBytes || window >= size) {
        return { file, events, size, bytesRead, truncated: !complete && window >= maxBytes, firstInput };
      }
      window = Math.min(window * 2, maxBytes, size);
    }
  } finally { await handle.close(); }
}

/**
 * Whether this session's first turn is the request this caller is looking for.
 *
 * The opener is matched against the exact request+binding marker, so a native
 * enqueue that already carries it counts as the first turn having been
 * submitted — which is what lets a binding be persisted before the assistant
 * has answered anything.
 */
export async function firstTurnBinding({ env = process.env, record, marker, deep = false }) {
  const file = await findTranscript({ env, nativeSessionId: record.nativeSessionId, workspace: record.workspace })
    .catch(() => undefined);
  if (!file) return { file: undefined, firstInput: undefined, markerCount: 0, complete: false };
  const head = await readTranscriptHead(file);
  const inputs = head.events
    .filter(event => event.type === 'user' || event.type === 'queue-operation')
    .map(event => event.enqueueText ?? event.text ?? '')
    .filter(text => text.length > 0);
  const markerCount = inputs.filter(text => text.includes(marker)).length;
  let deepCount;
  if (deep) {
    const { events } = await readTranscriptEvents(file);
    deepCount = events
      .filter(event => event.role === 'user' || event.type === 'queue-operation')
      .map(event => event.text ?? '')
      .filter(text => text.includes(marker)).length;
  }
  const firstInput = head.firstInput
    ? { ...head.firstInput, length: head.firstInput.text.length, hasMarker: head.firstInput.text.includes(marker) }
    : undefined;
  return {
    file,
    firstInput,
    markerCount,
    complete: !head.truncated,
    ...(deep ? { deepCount } : {}),
  };
}
function userText(event) { return event?.role === 'user' || event?.type === 'user' ? event.text ?? '' : ''; }

/** How many user messages carry this marker line (0, 1, or more). */
export function countMarker(events, marker) {
  return events.filter(event => userText(event).includes(marker)).length;
}

/**
 * The app's own record of an interrupt. It is a *user* message whose text is
 * exactly the interrupt sentence, either on its own or as one part of the next
 * request; a longer text that merely quotes it, a tool result that mentions it,
 * or an older interrupt is not a new one.
 */
export function interruptEvidence(events, sinceIso) {
  const since = sinceIso ? Date.parse(sinceIso) : -Infinity;
  for (const event of events) {
    const at = Date.parse(event.timestamp);
    if (!(at >= since)) continue;
    if (event.role !== 'user') continue;
    if (!(event.textParts ?? []).includes(INTERRUPT_MARKER)) continue;
    return { type: event.type, uuid: event.uuid, timestamp: event.timestamp, matched: 'exact-text-part' };
  }
  return undefined;
}

/** True when the app recorded an interrupt after `sinceIso`. */
export function interruptedSince(events, sinceIso) {
  return Boolean(interruptEvidence(events, sinceIso));
}// ------------------------------------------------------------------- driver

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
    readSessionArgs: refuse,
    clickButton: refuse,
    submit: refuse,
    interrupt: refuse,
    revealSession: refuse,
    sessionMenu: refuse,
    deleteSession: refuse,
    readModel: refuse,
    selectModel: refuse,
  };
}

function scriptPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'claude-host.ps1');
}

/**
 * Anchors of the Claude Desktop conversation UI, localized. Measured on
 * Claude 4.4212.0.0: the composer is the `Edit` named with the prompt label, the
 * model control is the button whose name starts with the model label, and the
 * sidebar offers a "new session in <folder>" button per folder group.
 * Every label travels to the bridge as JSON, never as a script literal.
 */
export const DEFAULT_UI_PATTERNS = Object.freeze({
  composer: '^(提示词|Prompt|Message to Claude)$',
  modelButton: '^模型[:：]|^Model[:：]',
  send: '^(发送|Send)$',
  stop: '^(停止|Stop)$',
  newInFolder: '^(在 .+ 中新建会话|New session in .+)$',
  newSession: '^(新建|New chat|New session)$',
  trust: '^(信任工作区|信任|Trust workspace|Trust)$',
  cancel: '^(取消|Cancel)$',
});

/** The app's own workspace-trust question on a fresh Claude Code page. */
export const DEFAULT_TRUST_PATTERN = '^(信任工作区|信任|Trust workspace|Trust)$';
/** The sidebar menu entry that starts the host's own session deletion. */
export const DEFAULT_DELETE_LABEL = '删除';
/** Buttons the host's deletion confirmation may offer; only these are pressed. */
export const DEFAULT_DELETE_CONFIRM_LABELS = Object.freeze(['删除', 'Delete', '删除会话', 'Delete session']);

/**
 * The real UI bridge: one PowerShell script, JSON in on stdin, JSON out on a
 * file. Non-ASCII text (window titles, composer text, folder names) never
 * travels through argv.
 */
export function createPowerShellDriver({
  script = scriptPath(), timeoutMs = 20000, powershell = 'powershell.exe',
  patterns = DEFAULT_UI_PATTERNS, trustPattern = DEFAULT_TRUST_PATTERN,
} = {}) {
  async function run(action, payload = {}, { timeoutMs: actionTimeout = timeoutMs } = {}) {
    const outFile = path.join(os.tmpdir(),
      `futureaide-claude-host-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const body = JSON.stringify({ ...payload, action, patterns, trustPattern });
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Action', action, '-OutFile', outFile], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', chunk => { if (stderr.length < 40) stderr.push(chunk.toString('utf8')); });
    child.stdout.on('data', () => {});
    child.stdin.on('error', () => {}); // the bridge may exit before reading
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
    if (parsed.ok !== true) {
      throw fail(parsed.code ?? 'ui-bridge-refused', parsed.message ?? `The ${action} action was refused.`, { action, detail: parsed });
    }
    return parsed.value;
  }
  return {
    kind: 'powershell-uia',
    available: true,
    async probe() { return run('probe'); },
    async currentView() { return run('view'); },
    async openNewSession({ workspace, prompt, allowDeepLink = true, folderLabel, launchVia = 'protocol',
      allowExecutable = true, trustWorkspace = false, prefill = undefined }) {
      return run('new-session', { workspace, prompt, allowDeepLink, launchVia, allowExecutable, trustWorkspace,
        prefill, folderLabel: folderLabel ?? path.basename(workspace) }, { timeoutMs: Math.max(timeoutMs, 120000) });
    },
    async readSessionArgs({ pid }) { return run('session-args', { pid }); },
    async clickButton({ namePattern }) { return run('click-button', { namePattern }); },
    async submit({ prompt, prefilled, trustWorkspace = false } = {}) {
      return run('submit', { prompt, prefilled, trustWorkspace });
    },
    async interrupt() { return run('interrupt'); },
    async revealSession({ hostSessionId, title, allowDeepLink = true, launchVia = 'protocol' }) {
      return run('reveal', { hostSessionId, title, allowDeepLink, launchVia });
    },
    async sessionMenu({ title }) { return run('menu-dump', { title }); },
    async deleteSession({ title, deleteLabel = DEFAULT_DELETE_LABEL, confirmLabels = DEFAULT_DELETE_CONFIRM_LABELS }) {
      return run('session-delete', { title, deleteLabel, confirmLabels }, { timeoutMs: Math.max(timeoutMs, 60000) });
    },
    async readModel() { return run('model-read'); },
    async selectModel({ label, effortLabel = undefined }) { return run('model-select', { label, effortLabel }); },
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

/**
 * The title the host shows for the page it is displaying. Claude names a code
 * page `<title> - Claude Code`; a registered record's own `name` can be a
 * placeholder written before the title was derived, so the page is the truth.
 */
export function displayTitle(documentName) {
  if (typeof documentName !== 'string' || !documentName.trim()) return undefined;
  const suffix = ' - Claude Code';
  return documentName.endsWith(suffix) ? documentName.slice(0, -suffix.length).trim() : documentName.trim();
}

/** Does the visible Claude page belong to this session? Never guess by title alone. */
export function viewMatchesSession(view, record) {
  if (!view?.available || typeof view.documentName !== 'string') return false;
  if (!record?.name) return false;
  const name = record.name.trim();
  const document = view.documentName;
  return document === name || document.startsWith(`${name} - `) || document.startsWith(`${name} — `);
}

/** A distinctive slice of what this session said or was told, to find it on screen. */
async function sessionContentMarker({ env, record }) {
  const file = await findTranscript({ env, nativeSessionId: record.nativeSessionId, workspace: record.workspace })
    .catch(() => undefined);
  if (!file) return undefined;
  const { events } = await readTranscriptEvents(file);
  const text = [...events].reverse().map(event => event.text ?? '').find(value => value.trim().length > 24);
  if (!text) return undefined;
  return text.replace(/\s+/g, ' ').trim().slice(0, 32);
}

/** Is this session's own content on the displayed page? Titles are not identity. */
export function pageShowsSession(view, marker) {
  if (!marker || !Array.isArray(view?.texts)) return false;
  const haystack = view.texts.join(' ').replace(/\s+/g, ' ');
  return haystack.includes(marker);
}

/** UI Automation can read a window mid-repaint; retry before concluding anything. */
async function readViewStable(driver, { attempts = 5, delayMs = 300 } = {}) {
  let last;
  for (let index = 0; index < attempts; index += 1) {
    last = await driver.currentView().catch(() => undefined);
    if (last?.available) return last;
    await sleep(delayMs);
  }
  return last;
}

async function ensureSessionVisible(record, { driver, allowDeepLink, env = process.env }) {
  const marker = await sessionContentMarker({ env, record });
  const view = await readViewStable(driver);
  if (viewMatchesSession(view, record)) {
    return { view, revealed: false, title: displayTitle(view.documentName), titleMatchesRecord: true,
      targetConfirmedBy: 'document-title' };
  }
  if (pageShowsSession(view, marker)) {
    // The record name can be a placeholder; the session's own text on screen is
    // stronger identity than the title.
    return { view, revealed: false, title: displayTitle(view.documentName), titleMatchesRecord: false,
      targetConfirmedBy: 'page-content' };
  }
  const revealed = await driver.revealSession({ hostSessionId: record.hostSessionId, title: record.name, allowDeepLink })
    .catch(error => ({ revealed: false, error: { code: error.code, message: error.message } }));
  const after = await readViewStable(driver);
  const title = displayTitle(after?.documentName);
  const titleMatches = viewMatchesSession(after, record);
  const contentMatches = pageShowsSession(after, marker);
  if (!titleMatches && !contentMatches) {
    throw fail('session-not-visible',
      `The Claude Desktop window is not showing ${record.name ?? record.nativeSessionId}; refusing to send UI input that could reach another session.`,
      { view: after, reveal: revealed, marker });
  }
  return { view: after, revealed: true, title, titleMatchesRecord: titleMatches,
    targetConfirmedBy: contentMatches ? 'page-content-after-reveal' : 'document-title-after-reveal' };
}

// ------------------------------------------------------------------ creating

/** The identity a caller can persist for this host session. */
export function bindingOf(record) {
  return {
    nativeSessionId: record.nativeSessionId,
    hostSessionId: record.hostSessionId,
    pid: record.pid,
    name: record.name,
    workspace: record.workspace,
    recordFile: record.recordFile,
    alive: record.alive,
  };
}

/**
 * Read-only: the session that already received this request's first turn.
 *
 * The match is the unique marker line (request id + binding nonce) appearing
 * exactly once in a live session transcript in that workspace. A shared cwd, a
 * start time, or a similar title is never used as evidence.
 */
export async function findCreatedSession({ workspace, requestId, bindingNonce }, {
  env = process.env, isAlive = defaultIsAlive,
} = {}) {
  const directory = await assertWorkspace(workspace);
  const request = assertRequestId(requestId);
  const nonce = assertBindingNonce(bindingNonce);
  const marker = markerLine(request, nonce);
  const { sessions } = await scanNativeSessions({ env, isAlive });
  const candidates = sessions.filter(session => samePath(session.workspace, directory));
  const matches = [];
  for (const record of candidates) {
    const binding = await firstTurnBinding({ env, record, marker });
    if (binding.firstInput?.hasMarker) matches.push({ record, binding });
  }
  if (matches.length > 1) {
    throw fail('ambiguous-created-session',
      `${matches.length} sessions carry this request marker; refusing to pick one by time or path.`,
      { candidates: matches.map(match => match.record.nativeSessionId) });
  }
  if (!matches.length) return undefined;
  const [{ record, binding }] = matches;
  if (binding.markerCount !== 1) {
    throw fail('marker-not-unique',
      `The request marker appears ${binding.markerCount} times in the opening of session ${record.nativeSessionId}.`,
      { nativeSessionId: record.nativeSessionId, firstInput: binding.firstInput });
  }
  return {
    ...bindingOf(record),
    requestId: request,
    bindingNonce: nonce,
    transcriptFile: binding.file,
    submittedBy: binding.firstInput?.kind,
    firstInput: binding.firstInput,
    verifiedBy: ['first-input-marker-once'],
  };
}

/** The routes the shipped bundle accepts, for callers that open a page themselves. */
function newSessionDeepLink({ workspace, prompt }) {
  const params = new URLSearchParams();
  if (prompt) {
    if (prompt.length > DEEP_LINK_PROMPT_LIMIT) {
      throw fail('prompt-exceeds-deep-link',
        `The first message is ${prompt.length} characters; the deep link carries at most ${DEEP_LINK_PROMPT_LIMIT}. Use the composer surface for longer text.`);
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
 * binding nonce go into the first message; the session is reported as created
 * only when a *new* native record registers in this workspace and its transcript
 * carries that marker exactly once. `onBound` is awaited the moment the session
 * is identified, so a tool call can persist the binding before anything else.
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
  allowExecutable = true,
  folderLabel = undefined,
  trustWorkspace = false,
  onBound = undefined,
} = {}) {
  const directory = await assertWorkspace(workspace);
  const request = assertRequestId(requestId);
  const nonce = assertBindingNonce(bindingNonce);
  const text = assertMessage(message).trimEnd();
  const marker = markerLine(request, nonce);
  if (text.includes(marker) || text.includes('[FutureAide Control request ')) {
    throw fail('message-already-marked', 'message already carries a FutureAide request marker.');
  }
  const payload = `${text}\n\n${marker}`;

  const reused = await findCreatedSession({ workspace: directory, requestId: request, bindingNonce: nonce }, { env, isAlive })
    .catch(() => undefined);
  if (reused) {
    return { created: false, reused: true, status: 'already-delivered', ...reused, workspace: directory };
  }

  const ui = requireDriver(driver, 'creating a session');
  const baseline = new Set((await scanNativeSessions({ env, isAlive })).sessions.map(session => session.nativeSessionId));
  const startedAt = new Date().toISOString();
  // The deep link carries at most DEEP_LINK_PROMPT_LIMIT characters, so a longer
  // first message is not truncated: the page is opened without a prompt and the
  // whole text is filled into the host's own composer before one send.
  const prefillViaLink = payload.length <= DEEP_LINK_PROMPT_LIMIT;
  const launch = await ui.openNewSession({ workspace: directory, prompt: payload, allowDeepLink, allowExecutable,
    trustWorkspace, prefill: prefillViaLink, ...(folderLabel ? { folderLabel } : {}) });
  // No keystroke is sent into a page that did not become the new session: input
  // in an unidentified page could reach somebody else's conversation.
  if (launch?.navigated === false) {
    return {
      created: false, status: 'unconfirmed',
      reason: launch?.blocked === 'workspace-trust-prompt' ? 'workspace-trust-prompt' : 'launch-not-navigated',
      requestId: request, bindingNonce: nonce, workspace: directory, evidence: { launch }, startedAt,
      elapsedMs: Date.now() - Date.parse(startedAt),
    };
  }
  const submitted = await ui.submit({ prompt: payload, prefilled: launch?.prefilled === true, trustWorkspace });

  const deadline = Date.now() + timeoutMs;
  let observed;
  let bound = false;
  let bindingError;
  while (Date.now() < deadline) {
    const { sessions } = await scanNativeSessions({ env, isAlive });
    const fresh = sessions.filter(session => session.alive && !baseline.has(session.nativeSessionId)
      && samePath(session.workspace, directory));
    if (fresh.length > 1) {
      return { created: false, status: 'ambiguous', reason: 'several-new-sessions',
        candidates: fresh.map(session => session.nativeSessionId), requestId: request, workspace: directory,
        evidence: { launch, submitted } };
    }
    if (fresh.length === 1) {
      const record = fresh[0];
      const binding = await firstTurnBinding({ env, record, marker });
      const count = binding.markerCount;
      const file = binding.file;
      observed = { record, file, count, binding };
      if (binding.firstInput?.hasMarker && count === 1) {
        if (!bound && typeof onBound === 'function') {
          bound = true;
          try { await onBound(bindingOf(record)); }
          catch (error) { bindingError = { code: error.code, message: error.message }; }
        }
        return {
          created: true, status: 'sent',
          ...bindingOf(record),
          transcriptFile: file,
          requestId: request,
          bindingNonce: nonce,
          marker,
          submittedBy: binding.firstInput?.kind,
          firstInput: binding.firstInput,
          verifiedBy: ['native-record-created', 'first-input-marker-once'],
          strategy: launch?.strategy,
          submit: submitted?.method,
          submitDetail: submitted,
          onBoundCalled: bound,
          ...(bindingError ? { bindingError } : {}),
          model: model === undefined ? undefined
            : { requested: model, applied: false, note: 'a deep link carries no model; the session uses the host default' },
          startedAt,
          elapsedMs: Date.now() - Date.parse(startedAt),
        };
      }
    }
    await sleep(pollMs);
  }

  return {
    created: false, status: 'unconfirmed',
    reason: observed ? `transcript-marker-count-${observed.count}` : 'no-native-session-registered',
    requestId: request, bindingNonce: nonce, workspace: directory,
    evidence: { launch, submitted,
      session: observed ? { nativeSessionId: observed.record.nativeSessionId, markerCount: observed.count,
        firstInput: observed.binding?.firstInput, complete: observed.binding?.complete } : undefined },
    startedAt, elapsedMs: Date.now() - Date.parse(startedAt),
  };
}// ---------------------------------------------------------------- interrupt

/**
 * Stop the running turn of one session.
 *
 * Confirmation is the app's own interrupt record: a *user* message whose text is
 * exactly the interrupt sentence, written after this request started. When the
 * app has nothing running, the stop is still honoured — a cancel that arrives
 * after the turn ended is reported as already satisfied, not as an error.
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
    return { interrupted: false, cancelled: true, status: 'not-running', reason: 'session-process-gone',
      nativeSessionId, verifiedBy: ['host-process-exited'] };
  }
  const ui = requireDriver(driver, 'interrupting a turn');
  const visible = await ensureSessionVisible(record, { driver: ui, allowDeepLink, env });
  const file = await findTranscript({ env, nativeSessionId: record.nativeSessionId, workspace: record.workspace });
  if (!file) throw fail('transcript-missing', `No transcript for session ${nativeSessionId}; refusing to interrupt unverifiably.`);
  const before = await readTranscriptEvents(file);
  const since = before.events.at(-1)?.timestamp ?? new Date().toISOString();
  const press = await ui.interrupt();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await readTranscriptEvents(file);
    const evidence = interruptEvidence(now.events, since);
    if (evidence) {
      return { interrupted: true, cancelled: true, status: 'interrupted', nativeSessionId,
        method: press?.method, verifiedBy: ['transcript-interrupt-marker'], evidence, revealed: visible.revealed };
    }
    await sleep(pollMs);
  }

  // No interrupt record. If the host was already idle there was nothing to stop,
  // which still satisfies a cancel request; that is stated, not dressed up as an
  // interrupt.
  const afterwards = await resolveNativeSession(nativeSessionId, { env, isAlive }).catch(() => record);
  const idle = press?.stopButtonFound === false && String(afterwards?.status ?? '').toLowerCase() === 'idle';
  if (idle) {
    return { interrupted: false, cancelled: true, status: 'idle-no-turn', reason: 'no-running-turn',
      nativeSessionId, method: press?.method,
      verifiedBy: ['host-stop-control-absent', 'registry-idle'], revealed: visible.revealed };
  }
  return { interrupted: false, cancelled: false, status: 'unconfirmed', reason: 'interrupt-marker-not-written',
    nativeSessionId, method: press?.method, revealed: visible.revealed,
    evidence: { since, transcriptFile: file, stopButtonFound: press?.stopButtonFound } };
}// ------------------------------------------------------------------ destroy

/**
 * Everything the host keeps for one session, so a deletion can be verified:
 * the registry record, the transcript, the per-session directory (which holds
 * `subagents/`), and the cached session directories.
 */
export async function sessionArtifacts({ env = process.env, record, workspace, nativeSessionId } = {}) {
  const root = configRoot(env);
  const id = nativeSessionId ?? record?.nativeSessionId;
  const cwd = workspace ?? record?.workspace;
  const recordFile = record?.recordFile ?? path.join(root, 'sessions', 'unknown.json');
  const transcriptFile = await findTranscript({ env, nativeSessionId: id, workspace: cwd }).catch(() => undefined);
  const sessionDirectory = cwd ? path.join(root, 'projects', mungedProject(cwd), id) : undefined;
  const subagentDirectory = sessionDirectory ? path.join(sessionDirectory, 'subagents') : undefined;
  const sessionEnvDirectory = path.join(root, 'session-env', id);
  const fileHistoryDirectory = path.join(root, 'file-history', id);
  const kind = async value => {
    if (!value) return false;
    const info = await stat(value).catch(() => null);
    if (!info) return false;
    return info.isDirectory() ? 'directory' : 'file';
  };
  const subagentFiles = subagentDirectory
    ? (await readdir(subagentDirectory).catch(() => [])).filter(name => name.endsWith('.jsonl'))
    : [];
  return {
    recordFile,
    transcriptFile,
    sessionDirectory,
    subagentDirectory,
    sessionEnvDirectory,
    fileHistoryDirectory,
    subagentFiles,
    state: {
      recordFile: record?.recordFile ? await kind(record.recordFile) : false,
      transcriptFile: transcriptFile ? await kind(transcriptFile) : false,
      sessionDirectory: await kind(sessionDirectory),
      subagentDirectory: await kind(subagentDirectory),
      sessionEnvDirectory: await kind(sessionEnvDirectory),
      fileHistoryDirectory: await kind(fileHistoryDirectory),
    },
  };
}

function leftoversOf(state) {
  return Object.entries(state).filter(([, value]) => Boolean(value)).map(([key]) => key);
}

/**
 * Delete a session the way the application deletes it: the sidebar entry's own
 * "more options" menu, then the host's own confirmation, then verification of
 * the host's own state — registry record, transcript, session directory with its
 * subagents, cached directories and the host process.
 *
 * `binding` (from `bindingOf`) lets a repeated call confirm a deletion that
 * already happened: with the registry record gone, the known paths are checked
 * and `destroyed: true, alreadyDeleted: true` is returned only when nothing of
 * that session is left. Leftovers are never reported as success, and a running
 * host is never terminated on the plugin's behalf.
 */
export async function destroy({ nativeSessionId, binding = undefined }, {
  env = process.env,
  driver = createNullDriver(),
  isAlive = defaultIsAlive,
  timeoutMs = 40000,
  pollMs = 500,
  protectedPids = [],
  deleteLabel = DEFAULT_DELETE_LABEL,
  confirmLabels = DEFAULT_DELETE_CONFIRM_LABELS,
} = {}) {
  let record;
  try {
    record = await resolveNativeSession(nativeSessionId, { env, isAlive });
  } catch (error) {
    if (error.code !== 'unknown-native-session') throw error;
    const workspace = binding?.workspace;
    if (!workspace) {
      return { destroyed: false, deleted: false, status: 'unknown', reason: 'unknown-native-session',
        detail: 'No registry record and no binding to check the known paths with; nothing is claimed.',
        nativeSessionId };
    }
    const known = await sessionArtifacts({ env, workspace, nativeSessionId });
    const left = leftoversOf(known.state).filter(key => key !== 'recordFile');
    if (left.length === 0) {
      return { destroyed: true, deleted: true, alreadyDeleted: true, status: 'already-deleted',
        nativeSessionId, title: binding?.name, workspace,
        removed: { recordFile: true, transcriptFile: true, sessionDirectory: true, subagentDirectory: true,
          sessionEnvDirectory: true, fileHistoryDirectory: true, process: !isAlive(binding?.pid) },
        verifiedBy: ['registry-record-absent', 'known-paths-clear'], kept: { projectFiles: true } };
    }
    return { destroyed: false, deleted: false, status: 'leftovers', nativeSessionId, workspace,
      leftovers: left, state: known.state, subagentFiles: known.subagentFiles,
      detail: 'The registry record is gone but parts of the session are still on disk; not reported as deleted.' };
  }

  if (protectedPids.includes(record.pid)) {
    throw fail('protected-pid', `Refusing to delete pid ${record.pid}: it is a protected process.`);
  }
  if (!record.name) {
    throw fail('session-title-missing',
      `Session ${nativeSessionId} has no title, so its sidebar entry cannot be addressed unambiguously.`);
  }
  const ui = requireDriver(driver, 'deleting a session');
  // The sidebar entry carries the title the host derived, which can differ from
  // the record's placeholder name; bring the session up and read that title.
  const visible = await ensureSessionVisible(record, { driver: ui, allowDeepLink: true, env });
  const title = visible.title ?? record.name;
  const before = await sessionArtifacts({ env, record });
  if (!before.state.recordFile) {
    return { destroyed: false, deleted: false, status: 'already-gone', nativeSessionId, title,
      before: before.state, kept: { projectFiles: true }, verifiedBy: ['registry-record-already-absent'] };
  }
  const hostAction = await ui.deleteSession({ title, deleteLabel, confirmLabels });

  const deadline = Date.now() + timeoutMs;
  let after = before;
  let processGone = !record.alive;
  while (Date.now() < deadline) {
    after = await sessionArtifacts({ env, record });
    processGone = !isAlive(record.pid);
    const left = leftoversOf(after.state);
    if (left.length === 0 && processGone) break;
    await sleep(pollMs);
  }

  const recordGone = !after.state.recordFile;
  const transcriptGone = !after.state.transcriptFile;
  const directoriesGone = !after.state.sessionDirectory && !after.state.subagentDirectory
    && !after.state.sessionEnvDirectory && !after.state.fileHistoryDirectory;
  const deleted = recordGone && transcriptGone;
  const destroyed = deleted && processGone && directoriesGone;
  const verifiedBy = [];
  if (recordGone) verifiedBy.push('registry-record-gone');
  if (transcriptGone) verifiedBy.push('transcript-gone');
  if (!after.state.sessionDirectory && !after.state.subagentDirectory) verifiedBy.push('session-directory-gone');
  if (processGone) verifiedBy.push('host-process-exited');
  if (!after.state.sessionEnvDirectory && !after.state.fileHistoryDirectory) verifiedBy.push('session-directories-gone');
  return {
    destroyed, deleted,
    status: destroyed ? 'deleted' : recordGone ? 'partially-deleted' : 'unconfirmed',
    nativeSessionId, title, recordName: record.name, pid: record.pid,
    titleMatchesRecord: visible.titleMatchesRecord, targetConfirmedBy: visible.targetConfirmedBy,
    before: { ...before.state, subagents: before.subagentFiles.length },
    after: { ...after.state, subagents: after.subagentFiles.length },
    removed: {
      recordFile: recordGone,
      transcriptFile: transcriptGone,
      sessionDirectory: !after.state.sessionDirectory,
      subagentDirectory: !after.state.subagentDirectory,
      sessionEnvDirectory: !after.state.sessionEnvDirectory,
      fileHistoryDirectory: !after.state.fileHistoryDirectory,
      process: processGone,
    },
    kept: { projectFiles: true, note: 'The workspace, its files and any git state are untouched.' },
    verifiedBy,
    ...(destroyed ? {} : {
      detail: 'The host did not remove all session state within the timeout; the remaining pieces are listed in `after`.',
      leftovers: leftoversOf(after.state),
    }),
    hostAction,
  };
}// ------------------------------------------------------------------- resume

/**
 * Reattach to a session. A live session needs no window work: the caller keeps
 * delivering through the native inbox. A closed session is reopened through the
 * `code/continue` deep link and reported resumed only when a record for the same
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
    return { resumed: false, status: 'gone', reason: 'unknown-native-session', nativeSessionId,
      detail: 'No record and no hostSessionId to reopen; nothing was created.' };
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

// ------------------------------------------------------------ model catalog

/**
 * The model catalogue the application ships with.
 *
 * The installed app carries the authoritative id/name pairs and effort options
 * inside its main bundle (`model_selector_config`, one entry per surface). This
 * is read straight out of the app's own resources, read-only, so the mapping is
 * the app's own data instead of a table maintained by hand.
 */
const ASAR_HEADER_OFFSET = 16;

function asarHeader(handle) {
  const head = Buffer.alloc(64);
  return handle.read(head, 0, 64, 0).then(({ bytesRead }) => {
    if (bytesRead < ASAR_HEADER_OFFSET + 8) throw fail('asar-truncated', 'The app archive header is unreadable.');
    const headerSize = head.readUInt32LE(4);
    const headerLength = head.readUInt32LE(12);
    const dataBase = 8 + headerSize;
    const buffer = Buffer.alloc(headerLength);
    return handle.read(buffer, 0, headerLength, ASAR_HEADER_OFFSET)
      .then(({ bytesRead: read }) => ({ dataBase, header: JSON.parse(buffer.subarray(0, read).toString('utf8')) }));
  });
}

function collectAsarFiles(node, prefix = '', out = []) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const filePath = prefix ? `${prefix}/${name}` : name;
    if (entry.files) collectAsarFiles(entry, filePath, out);
    else out.push({ path: filePath, offset: Number(entry.offset), size: Number(entry.size) });
  }
  return out;
}

/** Balanced `[...]` starting at `from`, aware of strings and escapes. */
export function sliceBalancedArray(source, from) {
  const start = source.indexOf('[', from);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}

/** The value of a JS single-quoted string literal starting at `quoteIndex`. */
export function readQuotedLiteral(source, quoteIndex) {
  if (source[quoteIndex] !== "'") return undefined;
  let out = '';
  for (let index = quoteIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      const next = source[index + 1];
      if (next === undefined) return undefined;
      if (next === "'" || next === '"' || next === '\\') { out += next; index += 1; continue; }
      if (next === 'n') { out += '\n'; index += 1; continue; }
      if (next === 'r') { out += '\r'; index += 1; continue; }
      if (next === 't') { out += '\t'; index += 1; continue; }
      if (next === 'u') { out += String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16)); index += 5; continue; }
      out += next; index += 1; continue;
    }
    if (character === "'") return out;
    out += character;
  }
  return undefined;
}

/** The catalog metadata sits just before the surfaces literal in the bundle. */
function catalogMetaNear(source, index) {
  const window = source.slice(Math.max(0, index - 400), index);
  const version = /,\s*version:(\d+)/.exec(window)?.[1];
  return {
    version: version ? Number(version) : undefined,
    issuedAt: /issued_at:"([^"]+)"/.exec(window)?.[1],
    expiresAt: /expires_at:"([^"]+)"/.exec(window)?.[1],
    keyId: /key_id:"([^"]+)"/.exec(window)?.[1],
  };
}

/**
 * The embedded model catalog the app ships: `surfaces:JSON.parse('<json>')`
 * holding one `model_selector_config` per surface. The JSON is parsed as data;
 * no bundle code is evaluated.
 */
export function extractEmbeddedCatalog(source) {
  const marker = "JSON.parse('";
  let index = source.indexOf(marker);
  while (index !== -1) {
    const literal = readQuotedLiteral(source, index + marker.length - 1);
    // The catalog literal holds the surface map itself (`surfaces:JSON.parse('<json>')`),
    // so the guard is on the payload, not on a key outside it.
    if (literal && literal.includes('model_selector_config')) {
      try {
        const parsed = JSON.parse(literal);
        if (parsed && typeof parsed === 'object') {
          // The literal is the value of `surfaces`, so it is the surface map
          // itself; older shapes nest it under `surfaces`.
          const surfaces = (parsed.surfaces && typeof parsed.surfaces === 'object') ? parsed.surfaces
            : (parsed.ccd || parsed.cc) ? parsed : undefined;
          if (surfaces) return { surfaces, meta: catalogMetaNear(source, index) };
        }
      } catch { /* another JSON.parse literal */ }
    }
    index = source.indexOf(marker, index + marker.length);
  }
  return undefined;
}

/** Every `model_selector_config` array found in a bundle's source. */
export function extractModelSelectorConfigs(source) {
  const found = [];
  const key = '"model_selector_config"';
  let index = source.indexOf(key);
  while (index !== -1) {
    const json = sliceBalancedArray(source, index + key.length);
    if (json) {
      try {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) found.push(...parsed);
      } catch { /* a different shape in this build */ }
    }
    index = source.indexOf(key, index + key.length);
  }
  return found;
}

function normalizeSurface(entry) {
  const models = (entry?.models ?? []).map(model => ({
    id: model.id,
    name: model.name,
    shortName: model.short_name,
    section: model.section,
    effortOptions: (model.thinking?.effort_options ?? []).map(option => ({
      id: option.id,
      name: option.name,
      recommended: option.badge?.message ?? undefined,
      tooltip: option.tooltip?.content ?? undefined,
    })),
  }));
  const efforts = models[0]?.effortOptions ?? [];
  return {
    surface: entry?.id,
    models,
    efforts: efforts.length ? efforts : [{ id: 'medium', name: 'Medium', recommended: 'Recommended' }],
    byId: new Map(models.map(model => [model.id, model])),
    byName: new Map(models.map(model => [model.name, model])),
    recommendedEffort: efforts.find(option => option.recommended)?.id,
  };
}

/** The catalogue this build was read with, if the app archive cannot be read. */
export const BUILT_IN_MODEL_CATALOG = Object.freeze({
  source: 'built-in-snapshot',
  surface: 'ccd',
  selectionSource: 'global_default',
  models: Object.freeze([
    { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main' },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', section: 'main' },
    { id: 'claude-fable-5-1', name: 'Fable 5.1', section: 'main' },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5', section: 'main' },
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', section: 'overflow' },
    { id: 'claude-sonnet-5', name: 'Sonnet 5', section: 'overflow' },
    { id: 'claude-opus-5', name: 'Opus 5', section: 'overflow' },
    { id: 'claude-fable-5', name: 'Fable 5', section: 'overflow' },
    { id: 'claude-opus-4-8', name: 'Opus 4.8', section: 'overflow' },
    { id: 'claude-opus-4-7', name: 'Opus 4.7', section: 'overflow' },
    { id: 'claude-opus-4-6', name: 'Opus 4.6', section: 'overflow' },
    { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', section: 'overflow' },
    { id: 'claude-opus-4-1-20250805', name: 'Opus 4.1', section: 'overflow' },
  ]),
  efforts: Object.freeze([
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium', recommended: 'Recommended' },
    { id: 'high', name: 'High' },
    { id: 'xhigh', name: 'Extra' },
    { id: 'max', name: 'Max' },
  ]),
});

function snapshotSurface(catalog) {
  const models = catalog.models.map(model => ({ ...model, effortOptions: [] }));
  return {
    surface: catalog.surface,
    models,
    efforts: catalog.efforts,
    byId: new Map(models.map(model => [model.id, model])),
    byName: new Map(models.map(model => [model.name, model])),
    recommendedEffort: catalog.efforts.find(option => option.recommended)?.id,
    selectionSource: catalog.selectionSource,
  };
}

/** Where the app archive is, from the running app itself when possible. */
export async function resolveAppAsar({ driver, env = process.env } = {}) {
  if (typeof env?.CLAUDE_APP_ASAR === 'string' && env.CLAUDE_APP_ASAR.trim()) {
    return { asar: path.resolve(env.CLAUDE_APP_ASAR.trim()), source: 'env' };
  }
  if (driverAvailable(driver) && typeof driver.probe === 'function') {
    const probe = await driver.probe().catch(() => undefined);
    const executable = probe?.window?.executable;
    if (typeof executable === 'string' && executable.toLowerCase().endsWith('claude.exe')) {
      const candidate = path.join(path.dirname(executable), '..', 'resources', 'app.asar');
      const info = await stat(candidate).catch(() => null);
      if (info?.isFile()) return { asar: path.resolve(candidate), source: 'running-app' };
    }
  }
  return { asar: undefined, source: 'unavailable' };
}

const catalogCache = new Map();

/**
 * Read the shipped model catalogue. Falls back to the snapshot this build was
 * developed against only when the archive cannot be read; the result always says
 * which one it used.
 */
export async function loadModelCatalog({ asar = undefined, driver, env = process.env } = {}) {
  const resolved = asar ? { asar, source: 'explicit' } : await resolveAppAsar({ driver, env });
  if (!resolved.asar) {
    return { ...snapshotSurface(BUILT_IN_MODEL_CATALOG), catalogSource: 'built-in-snapshot', asar: undefined };
  }
  const info = await stat(resolved.asar).catch(() => null);
  if (!info?.isFile()) {
    return { ...snapshotSurface(BUILT_IN_MODEL_CATALOG), catalogSource: 'built-in-snapshot',
      asar: resolved.asar, note: 'archive-not-found' };
  }
  const cacheKey = `${resolved.asar}:${info.mtimeMs}:${info.size}`;
  const cached = catalogCache.get(cacheKey);
  if (cached) return cached;
  const handle = await open(resolved.asar, 'r').catch(() => null);
  if (!handle) {
    return { ...snapshotSurface(BUILT_IN_MODEL_CATALOG), catalogSource: 'built-in-snapshot', asar: resolved.asar };
  }
  try {
    const { dataBase, header } = await asarHeader(handle);
    const bundles = collectAsarFiles(header).filter(entry => /^\.vite\/build\/index\.chunk-.*\.js$/.test(entry.path));
    let surface;
    let selectionSource;
    let usedBundle;
    let catalogMeta;
    for (const bundle of bundles) {
      const buffer = Buffer.alloc(bundle.size);
      await handle.read(buffer, 0, bundle.size, dataBase + bundle.offset);
      const source = buffer.toString('utf8');
      const embedded = extractEmbeddedCatalog(source);
      const surfaceConfig = embedded?.surfaces?.ccd?.model_selector_config
        ?? embedded?.surfaces?.cc?.model_selector_config;
      const configs = Array.isArray(surfaceConfig) ? surfaceConfig : extractModelSelectorConfigs(source);
      const ccd = configs.find(entry => entry?.id === 'ccd') ?? configs.find(entry => entry?.id === 'cc');
      if (!ccd) continue;
      catalogMeta = embedded?.meta;
      surface = normalizeSurface(ccd);
      const match = /"selection_source"\s*:\s*"([a-z_]+)"/.exec(source);
      selectionSource = match?.[1];
      usedBundle = bundle.path;
      break;
    }
    if (!surface) {
      return { ...snapshotSurface(BUILT_IN_MODEL_CATALOG), catalogSource: 'built-in-snapshot',
        asar: resolved.asar, note: 'catalog-not-found-in-archive' };
    }
    const result = { ...surface, selectionSource, catalogSource: 'app-asar', asar: resolved.asar, bundle: usedBundle,
      catalogVersion: catalogMeta?.version, catalogIssuedAt: catalogMeta?.issuedAt, catalogExpiresAt: catalogMeta?.expiresAt };
    catalogCache.set(cacheKey, result);
    return result;
  } catch (error) {
    return { ...snapshotSurface(BUILT_IN_MODEL_CATALOG), catalogSource: 'built-in-snapshot',
      asar: resolved.asar, note: error.code ?? 'archive-read-failed' };
  } finally { await handle.close(); }
}
// ------------------------------------------------------------------- models

/** Effort words the composer's model control appends after the model name. */
export const EFFORT_WORDS = Object.freeze(['最大', '最高', '最低', '超高', '中等', '高', '中', '低',
  'Extra', 'XHigh', 'Max', 'High', 'Medium', 'Low']);

/**
 * The effort scale as the app's own catalogue and menu present it: the shipped
 * catalogue carries the option ids and names (`low/medium/high/xhigh/max`), and
 * this build shows them localized. Every label below was seen on this machine's
 * composer; `medium` is the recommended, preselected option.
 */
export const EFFORT_LABEL_FOR = Object.freeze({
  low: '低', medium: '中等', high: '高', xhigh: '超高', max: '最高',
});

export const EFFORT_LABELS = Object.freeze(Object.fromEntries(
  Object.entries(EFFORT_LABEL_FOR).flatMap(([value, label]) => [[label, value], [label.toUpperCase(), value]]),
));

/** Is this effort value one the app's catalogue offers? */
export function isOfferedEffort(value, catalog = undefined) {
  const efforts = catalog?.efforts ?? BUILT_IN_MODEL_CATALOG.efforts;
  return efforts.some(option => option.id === value);
}

/** The model menu as the shipped catalogue arranges it, for callers that need it. */
export const MODEL_MENU = Object.freeze({
  primary: Object.freeze(BUILT_IN_MODEL_CATALOG.models.filter(model => model.section === 'main').map(model => model.name)),
  more: Object.freeze(BUILT_IN_MODEL_CATALOG.models.filter(model => model.section !== 'main').map(model => model.name)),
});

/** Every model label the catalogue offers, primary entries first (snapshot view). */
export function offeredModelLabels(catalog = undefined) {
  const models = catalog?.models ?? BUILT_IN_MODEL_CATALOG.models;
  return [...models].sort((left, right) => (left.section === 'main' ? 0 : 1) - (right.section === 'main' ? 0 : 1))
    .map(model => model.name);
}

export function isOfferedModelLabel(label, catalog = undefined) {
  return offeredModelLabels(catalog).includes(String(label ?? '').trim());
}

/**
 * Split the model control's accessible name into a model label and an effort.
 * Measured name: `模型：Opus 5.5 最高 3.5× 或更多用量` -> `Opus 5.5` / `最高`.
 */
export function parseModelControl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { label: null, raw };
  let text = raw.trim();
  const colon = text.search(/[:：]/);
  if (colon >= 0) text = text.slice(colon + 1).trim();
  text = text.replace(/[（(]\s*(推荐|recommended)\s*[)）]/gi, '').trim();
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

/** Resolve a model id to the name the app's own catalogue gives it. */
export function labelForModel({ provider = 'anthropic', model } = {}, catalog = undefined) {
  const models = catalog?.models ?? BUILT_IN_MODEL_CATALOG.models;
  const known = models.find(entry => entry.id === model);
  if (!known) {
    return { resolved: false, reason: 'unmapped-model-id', model, provider, known: models.map(entry => entry.id) };
  }
  if (provider !== 'anthropic') {
    return { resolved: false, reason: 'provider-mismatch', model, provider, expectedProvider: 'anthropic' };
  }
  return { resolved: true, provider, model, label: known.name, section: known.section,
    evidence: 'app catalogue model_selector_config (id/name pair)' };
}

/** The model a session actually ran, from its own transcript. */
async function transcriptModel({ env, record }) {
  const file = await findTranscript({ env, nativeSessionId: record.nativeSessionId, workspace: record.workspace })
    .catch(() => undefined);
  if (!file) return undefined;
  const { events } = await readTranscriptEvents(file);
  const models = [];
  const efforts = [];
  let current;
  for (const event of events) {
    if (typeof event.effort === 'string' && !efforts.includes(event.effort)) efforts.push(event.effort);
    if (event.type !== 'assistant' || typeof event.model !== 'string' || event.model === '<synthetic>') continue;
    if (!models.includes(event.model)) models.push(event.model);
    current = { model: event.model, effort: typeof event.effort === 'string' ? event.effort : undefined, timestamp: event.timestamp };
  }
  return { nativeSessionId: record.nativeSessionId, name: record.name, models, efforts, current };
}

/** Corroboration only: what the host's own sessions recorded, per session. */
export async function hostModelEvidence({ env = process.env, isAlive = defaultIsAlive, workspace } = {}) {
  const { sessions } = await scanNativeSessions({ env, isAlive });
  const live = sessions.filter(session => session.alive && (!workspace || samePath(session.workspace, workspace)));
  const observed = [];
  for (const record of live) {
    const info = await transcriptModel({ env, record });
    if (info) observed.push(info);
  }
  return { sessions: observed };
}

/** Merge label-shaped reflections of one model across sessions (never a proof). */
export function resolveModelEvidence({ label, effortLabel, evidence = {}, provider = 'anthropic' }) {
  const sessions = evidence.sessions ?? [];
  const currentModels = [...new Set(sessions.map(session => session.current?.model).filter(Boolean))];
  const observedEfforts = [...new Set(sessions.flatMap(session => session.efforts ?? []))];
  const base = {
    provider, label: label ?? null, effortLabel: effortLabel ?? null,
    model: null, reasoningEffort: undefined, resolved: false,
    evidence: { sessions, observedEfforts },
  };
  if (currentModels.length > 1) return { ...base, reason: 'conflicting-model-evidence', candidates: currentModels };
  if (currentModels.length === 0) {
    return { ...base, reason: sessions.length ? 'no-model-recorded-yet' : 'no-host-session-to-observe' };
  }
  const model = currentModels[0];
  let reasoningEffort;
  let effortResolution;
  if (!effortLabel) effortResolution = { source: 'no-ui-effort-label', observedEfforts };
  else {
    const mapped = EFFORT_LABELS[effortLabel];
    if (!mapped) effortResolution = { source: 'unmapped-effort-label', label: effortLabel, observedEfforts, unresolved: true };
    else if (observedEfforts.length === 1 && observedEfforts[0] === mapped) {
      reasoningEffort = mapped;
      effortResolution = { source: 'paired-observation', label: effortLabel, observed: observedEfforts[0] };
    } else {
      reasoningEffort = mapped;
      effortResolution = { source: 'label-table', label: effortLabel, mapped, observedEfforts, verified: false };
    }
  }
  return { ...base, model, reasoningEffort, resolved: true, effortResolution };
}

/** What the host launched a session with (its own argv), when a driver is given. */
async function launchArgsOf({ driver, record }) {
  if (!driverAvailable(driver) || typeof driver.readSessionArgs !== 'function' || !record?.pid) return undefined;
  return driver.readSessionArgs({ pid: record.pid }).catch(() => undefined);
}

/**
 * The model the *next* turn of this session will use: the composer control when
 * the session is on screen, corroborated by what its transcript recorded and what
 * the host launched it with. Disagreement is reported, not averaged.
 */
/** What this session ran before: context for a control reading, never a substitute. */
async function readModelHistory({ env, record, driver }) {
  const transcript = await transcriptModel({ env, record }).catch(() => undefined);
  const launchArgs = await launchArgsOf({ driver, record });
  return { transcript: transcript?.current ?? null, launchArgs: launchArgs ?? null };
}

/**
 * The model the *next* turn of this session will use.
 *
 * The session is located in the window first (the same identity check the other
 * operations use) and its model control is read; if that control cannot be read
 * the call fails explicitly. What the session ran before is returned as context
 * only — a past turn cannot prove the next one. A control that differs from the
 * transcript is a normal selection change, and the control wins.
 */
export async function readCurrentModel({ nativeSessionId }, {
  driver = createNullDriver(), env = process.env, isAlive = defaultIsAlive, catalog = undefined, asar = undefined,
} = {}) {
  const modelCatalog = catalog ?? await loadModelCatalog({ asar, driver, env });
  const ui = requireDriver(driver, 'reading the current model');
  const record = await resolveNativeSession(nativeSessionId, { env, isAlive });
  const visible = await ensureSessionVisible(record, { driver: ui, allowDeepLink: true, env });
  const raw = modelInfo(await ui.readModel());
  const history = await readModelHistory({ env, record, driver });
  if (!raw.label) {
    return {
      nativeSessionId, provider: 'anthropic', model: null, reasoningEffort: undefined,
      resolved: false, status: 'unreadable', reason: 'model-control-unreadable',
      label: null, effortLabel: null, targetConfirmedBy: visible.targetConfirmedBy,
      evidence: { control: null, history },
      detail: 'The session is on screen but its model control could not be read; what it used before does not prove the next turn.',
    };
  }
  const known = modelCatalog.models.find(model => model.name === raw.label);
  const reasoningEffort = raw.effort ? EFFORT_LABELS[raw.effort] : undefined;
  const historyDiffers = Boolean((history.transcript?.model && known?.id && history.transcript.model !== known.id))
    || Boolean((history.transcript?.effort && reasoningEffort && history.transcript.effort !== reasoningEffort))
    || Boolean((history.launchArgs?.model && known?.id && history.launchArgs.model !== known.id));
  return {
    nativeSessionId,
    provider: 'anthropic',
    model: known?.id ?? null,
    reasoningEffort,
    resolved: Boolean(known?.id),
    status: known?.id ? 'read' : 'unmapped',
    label: raw.label,
    effortLabel: raw.effort,
    source: 'composer-control',
    targetConfirmedBy: visible.targetConfirmedBy,
    verifiedBy: ['session-model-control'],
    catalogSource: modelCatalog.catalogSource,
    evidence: { control: raw, history },
    historyDiffers,
    ...(known ? {} : { reason: 'label-not-in-catalog', unresolvedLabel: raw.label }),
    ...(historyDiffers ? {
      note: 'The control differs from what this session ran before; that is a selection change, and the control is the current value.',
    } : {}),
  };
}

/**
 * The default a *new* session would start with, read from a draft composer.
 *
 * A draft page shows the global default, so it is read in place when the window
 * already shows one (nothing is typed, so the user's draft text is untouched).
 * When the window shows a session instead, the same new-session navigation that
 * creation uses opens a fresh draft, the control is read, and the previous view
 * is restored. A page whose composer holds unsent text is never navigated away
 * from, so a user draft is never overwritten. No message is ever sent, so this
 * costs no model turn.
 */
export async function readDefaultModel({
  driver = createNullDriver(), env = process.env, isAlive = defaultIsAlive,
  catalog = undefined, asar = undefined, workspace = undefined, folderLabel = undefined, readOnly = false,
} = {}) {
  const modelCatalog = catalog ?? await loadModelCatalog({ asar, driver, env });
  const ui = requireDriver(driver, 'reading the default model');
  const summary = {
    surface: modelCatalog.surface,
    models: modelCatalog.models.map(model => ({ id: model.id, name: model.name, section: model.section })),
    efforts: modelCatalog.efforts,
    catalogSource: modelCatalog.catalogSource,
    catalogVersion: modelCatalog.catalogVersion,
    selectionSource: modelCatalog.selectionSource ?? 'global_default',
  };
  const startView = await readViewStable(ui);
  const composerLength = Number(startView?.composerLength ?? 0);
  const isDraft = Boolean(startView?.composerFound) && Number(startView?.messages ?? 0) === 0;

  let control;
  let navigation;
  if (isDraft) {
    control = modelInfo(await ui.readModel());
    navigation = { navigated: false, draft: 'in-place', draftPreserved: true,
      previousDocumentName: startView?.documentName };
  } else if (readOnly) {
    // A caller that must not touch the window (a status probe) gets an explicit
    // answer instead of a page navigation.
    return {
      provider: 'anthropic', model: null, reasoningEffort: undefined, label: null, effortLabel: null,
      resolved: false, verified: false, status: 'not-a-draft', reason: 'draft-not-shown',
      selectionSource: summary.selectionSource, catalogSource: modelCatalog.catalogSource,
      evidence: { control: null, catalog: summary },
      navigation: { navigated: false, draft: 'none', previousDocumentName: startView?.documentName },
      detail: 'The window is not showing a draft and this caller asked for a read-only answer, so no page was opened.',
    };
  } else {
    if (composerLength > 0) {
      throw fail('unsent-text-present',
        'The composer holds unsent text; refusing to navigate away and overwrite it just to read the default.',
        { documentName: startView?.documentName, composerLength });
    }
    const previousTitle = displayTitle(startView?.documentName);
    const { sessions } = await scanNativeSessions({ env, isAlive });
    const previous = sessions.find(session => session.alive && session.name && session.name === previousTitle);
    const targetWorkspace = workspace ?? previous?.workspace;
    if (!targetWorkspace) {
      throw fail('workspace-required',
        'No workspace to open a draft in; pass one explicitly (a folder the user already works in).',
        { documentName: startView?.documentName });
    }
    const launch = await ui.openNewSession({ workspace: targetWorkspace, prompt: undefined, prefill: false,
      allowDeepLink: true, allowExecutable: true, trustWorkspace: false,
      ...(folderLabel ? { folderLabel } : {}) });
    const draftView = await readViewStable(ui);
    const restore = async () => {
      if (!previous?.hostSessionId) return 'none';
      const revealed = await ui.revealSession({ hostSessionId: previous.hostSessionId, allowDeepLink: true })
        .catch(() => undefined);
      const back = await readViewStable(ui);
      const marker = await sessionContentMarker({ env, record: previous });
      const ok = viewMatchesSession(back, previous) || pageShowsSession(back, marker);
      return ok ? 'session' : (revealed ? 'unconfirmed' : 'failed');
    };
    if (launch?.blocked === 'workspace-trust-prompt' || draftView?.trustPrompt) {
      const restored = await restore();
      throw fail('workspace-trust-prompt',
        'Opening a draft for that folder asks the host\'s workspace-trust question; it is not answered on the caller\'s behalf.',
        { launch, restored });
    }
    const draftReady = Boolean(draftView?.hasComposer ?? draftView?.composerFound)
      && Number(draftView?.messages ?? 0) === 0;
    if (!draftReady) {
      const restored = await restore();
      throw fail('draft-not-opened', 'The window did not reach a fresh draft, so no default was read.',
        { launch, view: draftView, restored });
    }
    control = modelInfo(await ui.readModel());
    const restored = await restore();
    navigation = { navigated: true, draft: 'fresh', restored,
      previousDocumentName: startView?.documentName, workspace: targetWorkspace,
      launch: launch?.strategy ?? null };
  }

  if (!control.label) {
    return {
      provider: 'anthropic', model: null, reasoningEffort: undefined, label: null, effortLabel: null,
      resolved: false, verified: false, status: 'unreadable', reason: 'model-control-unreadable',
      selectionSource: summary.selectionSource, catalogSource: modelCatalog.catalogSource,
      evidence: { control: null, catalog: summary }, navigation,
      detail: 'The draft is on screen but its model control could not be read.',
    };
  }
  const known = modelCatalog.models.find(model => model.name === control.label);
  const reasoningEffort = control.effort ? EFFORT_LABELS[control.effort] : undefined;
  return {
    provider: 'anthropic',
    model: known?.id ?? null,
    reasoningEffort,
    label: control.label,
    effortLabel: control.effort,
    resolved: Boolean(known?.id),
    verified: Boolean(known?.id),
    status: known?.id ? 'read' : 'unmapped',
    source: 'draft-control+app-catalog',
    selectionSource: summary.selectionSource,
    catalogSource: modelCatalog.catalogSource,
    catalogVersion: modelCatalog.catalogVersion,
    verifiedBy: ['draft-model-control', 'app-catalog-id-pair'],
    ...(known ? {} : { reason: 'label-not-in-catalog', unresolvedLabel: control.label }),
    evidence: { control, catalog: summary },
    navigation,
    gaps: [
      'The label list is the app catalogue (sections main and overflow); a catalogue entry can be hidden from the visible menu, so the control stays the source of the current value.',
    ],
  };
}
/** The model of the newest assistant turn; used to confirm a selection. */
export async function confirmModelAfterTurn({ nativeSessionId, after } = {}, {
  env = process.env, isAlive = defaultIsAlive,
} = {}) {
  const record = await resolveNativeSession(nativeSessionId, { env, isAlive });
  const info = await transcriptModel({ env, record });
  if (!info?.current) return null;
  if (after && !(Date.parse(info.current.timestamp) >= Date.parse(after))) return null;
  return {
    nativeSessionId, provider: 'anthropic', model: info.current.model,
    reasoningEffort: info.current.effort, timestamp: info.current.timestamp,
    verifiedBy: ['session-transcript-assistant-turn'],
  };
}

/**
 * Select a model for one session by model id and effort through the host's own
 * control, then read the control back. The id/name pairs and the allowed effort
 * ids come from the app's shipped catalogue, so a future model needs no proof
 * beyond the catalogue entry itself.
 */
export async function selectModel({ nativeSessionId, provider = 'anthropic', model, reasoningEffort }, {
  driver = createNullDriver(), env = process.env, isAlive = defaultIsAlive, catalog = undefined, asar = undefined,
  timeoutMs = 15000, pollMs = 250,
} = {}) {
  const modelCatalog = catalog ?? await loadModelCatalog({ asar, driver, env });
  const mapped = labelForModel({ provider, model }, modelCatalog);
  if (!mapped.resolved) {
    throw fail(mapped.reason,
      `Cannot resolve ${JSON.stringify(model)} through the app catalogue: ${mapped.reason}. Known ids: ${mapped.known?.join(', ')}.`,
      mapped);
  }
  if (reasoningEffort && !isOfferedEffort(reasoningEffort, modelCatalog)) {
    throw fail('unmapped-effort',
      `reasoningEffort ${JSON.stringify(reasoningEffort)} is not in the app's effort options (${modelCatalog.efforts.map(option => option.id).join(' / ')}).`,
      { efforts: modelCatalog.efforts });
  }
  const effortLabel = reasoningEffort ? EFFORT_LABEL_FOR[reasoningEffort] : undefined;
  const record = await resolveNativeSession(nativeSessionId, { env, isAlive });
  const ui = requireDriver(driver, 'selecting a model');
  await ensureSessionVisible(record, { driver: ui, allowDeepLink: true, env });
  const before = await readCurrentModel({ nativeSessionId }, { driver: ui, env, isAlive, catalog: modelCatalog });
  const attempt = await ui.selectModel({ label: mapped.label, effortLabel });
  let shown = modelInfo(attempt?.observed ?? await ui.readModel().catch(() => undefined));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && (shown.label !== mapped.label || (effortLabel && shown.effort !== effortLabel))) {
    await sleep(pollMs);
    shown = modelInfo(await ui.readModel().catch(() => undefined));
  }
  const labelOk = shown.label === mapped.label;
  const effortOk = !effortLabel || shown.effort === effortLabel;
  if (!labelOk || !effortOk) {
    return {
      accepted: false, status: 'unconfirmed', requested: { provider, model, reasoningEffort },
      observedBefore: { label: before.label, effortLabel: before.effortLabel },
      observedAfter: { label: shown.label ?? null, effortLabel: shown.effort ?? null }, attempt,
      catalogSource: modelCatalog.catalogSource,
      detail: 'The Claude Desktop model control did not show the requested model/effort, so no selection is claimed.',
    };
  }
  const after = await readCurrentModel({ nativeSessionId }, { driver: ui, env, isAlive, catalog: modelCatalog });
  return {
    accepted: true, requested: { provider, model, reasoningEffort },
    before: { label: before.label, model: before.model, reasoningEffort: before.reasoningEffort },
    after: { label: after.label, effortLabel: after.effortLabel, provider: after.provider,
      model: after.model, reasoningEffort: after.reasoningEffort, source: after.source, conflicts: after.conflicts },
    verifiedBy: ['ui-model-control-read-back', 'session-state'],
    catalogSource: modelCatalog.catalogSource,
    attempt,
  };
}// -------------------------------------------------------------------- probe

/**
 * What this host can really do right now. Each capability is reported as
 * verified or unavailable — never as "probably fine".
 */
export async function probeClaudeHost({ env = process.env, driver = createNullDriver(), isAlive = defaultIsAlive } = {}) {
  const { directory, sessions } = await scanNativeSessions({ env, isAlive });
  const live = sessions.filter(session => session.alive);
  const ui = driverAvailable(driver)
    ? await driver.probe().catch(error => ({ available: false, reason: error.code ?? 'ui-bridge-failed' }))
    : { available: false, reason: 'ui-driver-unavailable' };
  // A probe must never navigate the user's window; it reads a draft only if one is showing.
  const model = await readDefaultModel({ driver, env, isAlive, readOnly: true })
    .catch(error => ({ model: null, verified: false, reason: error.code ?? 'unavailable' }));
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
      // A deletion is the host's own sidebar action; without a UI bridge the
      // plugin refuses rather than terminating a process behind the app.
      destroy: ui.available ? 'verified-surface' : 'unavailable',
      resume: { live: 'verified-surface', closed: ui.available ? 'unverified' : 'unavailable' },
      readDefaultModel: model.verified ? 'verified-surface' : 'unavailable',
      // The control is read back, but the option list inside it has not been
      // exercised against a live app, so the capability is not claimed yet.
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
 * a human or a supervisor can verify the surface without a test harness. The
 * payload is JSON on the command line or on stdin; prompts never travel through
 * argv text.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const stdin = Buffer.concat(chunks).toString('utf8').trim();
  const inline = process.argv[3]?.startsWith('{') ? process.argv[3] : '';
  const usage = 'usage: node src/claude-host.mjs <probe|sessions|model|current-model|create|interrupt|destroy|resume|select-model> [json]';
  try {
    const payload = JSON.parse(inline || stdin || '{}');
    const driver = createPowerShellDriver();
    const handler = {
      probe: () => probeClaudeHost({ driver }),
      sessions: () => listNativeSessions({ workspace: payload.workspace }),
      model: () => readDefaultModel({ driver, readOnly: payload.navigate !== true }),
      current: () => readCurrentModel(payload, { driver }),
      'current-model': () => readCurrentModel(payload, { driver }),
      create: () => createFirstTurn(payload, {
        driver,
        allowDeepLink: payload.allowDeepLink !== false,
        allowExecutable: payload.allowExecutable !== false,
        trustWorkspace: payload.trustWorkspace === true,
        ...(typeof payload.folderLabel === 'string' && payload.folderLabel ? { folderLabel: payload.folderLabel } : {}),
        ...(Number.isSafeInteger(payload.timeoutMs) ? { timeoutMs: payload.timeoutMs } : {}),
      }),
      interrupt: () => interrupt(payload, {
        driver,
        allowDeepLink: payload.allowDeepLink !== false,
        ...(Number.isSafeInteger(payload.timeoutMs) ? { timeoutMs: payload.timeoutMs } : {}),
      }),
      destroy: () => destroy(payload, { driver, protectedPids: payload.protectedPids ?? [],
        ...(payload.binding ? { binding: payload.binding } : {}) }),
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
