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
export const INTERRUPT_MARKER_TOOL = '[Request interrupted by user for tool use]';
/**
 * Every exact sentence the app writes when it stops a turn. Both were observed
 * on this host: a plain stop writes the first, a stop while a tool was running
 * writes the second. A record is an interrupt only when one of these is the
 * whole text of a user-side part.
 */
export const INTERRUPT_MARKERS = Object.freeze([INTERRUPT_MARKER, INTERRUPT_MARKER_TOOL]);
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
 * Ownership is decided by the *first complete input* alone: the marker must
 * appear exactly once inside it. The host records that same input twice — the
 * queue-operation that carried it and the user message it becomes — and it also
 * re-renders it later inside request blobs; neither is a second submission and
 * neither can grant ownership on its own. The session id is the identity: this
 * transcript belongs to exactly one native session.
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
  // The host records one submission twice: the queue-operation that carries the
  // text and the user message it becomes. Those are the same submission, so the
  // count is of distinct texts, while the raw record count stays for evidence.
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  const markerTexts = inputs.filter(text => text.includes(marker));
  const markerCount = new Set(markerTexts.map(normalize)).size;
  const markerRecords = markerTexts.length;
  // Ownership proof: the marker's occurrences inside the first input itself.
  const openerText = head.firstInput?.text ?? '';
  const openerOccurrences = openerText ? (openerText.split(marker).length - 1) : 0;
  // The same input can appear as the queue record and the user message it becomes.
  const openerNormalized = openerText ? normalize(openerText) : '';
  const openerRecords = openerNormalized ? inputs.filter(value => normalize(value) === openerNormalized).length : 0;
  const mirrorFound = openerRecords > 1;
  const laterMentions = head.events
    .filter(event => event.type !== 'user' && event.type !== 'queue-operation')
    .filter(event => (event.enqueueText ?? event.text ?? '').includes(marker)).length;
  let deepCount;
  if (deep) {
    const { events } = await readTranscriptEvents(file);
    deepCount = events
      .filter(event => event.role === 'user' || event.type === 'queue-operation')
      .map(event => event.text ?? '')
      .filter(text => text.includes(marker)).length;
  }
  const firstInput = head.firstInput
    ? {
      kind: head.firstInput.kind,
      index: head.firstInput.index,
      timestamp: head.firstInput.timestamp,
      length: head.firstInput.text.length,
      hasMarker: openerOccurrences > 0,
      markerOccurrences: openerOccurrences,
      owned: openerOccurrences === 1,
    }
    : undefined;
  return {
    file,
    firstInput,
    markerCount,
    markerRecords,
    mirrorFound,
    laterMentions,
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
    const parts = event.textParts ?? [];
    const marker = INTERRUPT_MARKERS.find(candidate => parts.includes(candidate));
    if (!marker) continue;
    return { type: event.type, uuid: event.uuid, timestamp: event.timestamp, marker, matched: 'exact-text-part' };
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
    tasksPanel: refuse,
    taskRows: refuse,
    taskStop: refuse,
    sessionMenu: refuse,
    deleteSession: refuse,
    readModel: refuse,
    modelSnapshot: refuse,
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
    async tasksPanel({ title, mode = 'open' } = {}) {
      return run('tasks-panel', { title, mode }, { timeoutMs: Math.max(timeoutMs, 60000) });
    },
    async taskRows() { return run('tasks-rows'); },
    async taskStop({ match = '', index = undefined } = {}) {
      return run('task-stop', { match, index }, { timeoutMs: Math.max(timeoutMs, 60000) });
    },
    async sessionMenu({ title }) { return run('menu-dump', { title }); },
    async deleteSession({ title, deleteLabel = DEFAULT_DELETE_LABEL, confirmLabels = DEFAULT_DELETE_CONFIRM_LABELS }) {
      return run('session-delete', { title, deleteLabel, confirmLabels }, { timeoutMs: Math.max(timeoutMs, 60000) });
    },
    async readModel() { return run('model-read'); },
    async modelSnapshot(input = {}) {
      return run('model-snapshot', input, { timeoutMs: Math.max(timeoutMs, 60000) });
    },
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
    if (binding.firstInput?.owned) matches.push({ record, binding });
  }
  if (matches.length > 1) {
    throw fail('ambiguous-created-session',
      `${matches.length} sessions carry this request marker; refusing to pick one by time or path.`,
      { candidates: matches.map(match => match.record.nativeSessionId) });
  }
  if (!matches.length) return undefined;
  const [{ record, binding }] = matches;
  // A genuinely repeated delivery shows up as a second distinct input carrying
  // the marker; the queue mirror and later request blobs do not count.
  if (binding.markerCount !== 1) {
    throw fail('marker-not-unique',
      `The request marker appears in ${binding.markerCount} distinct inputs of session ${record.nativeSessionId}.`,
      { nativeSessionId: record.nativeSessionId, firstInput: binding.firstInput, markerRecords: binding.markerRecords });
  }
  return {
    ...bindingOf(record),
    requestId: request,
    bindingNonce: nonce,
    transcriptFile: binding.file,
    submittedBy: binding.firstInput?.kind,
    firstInput: binding.firstInput,
    submittedAt: binding.firstInput?.timestamp,
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
  // The caller owns the window lock, because the window is shared with every other
  // session name. Only the part that touches the window runs inside it; waiting for
  // the native session and its marker happens outside, so a slow confirmation does
  // not block other names.
  withUiLock = undefined,
  // Runs inside the lock, immediately before the single send, which is the moment a
  // delivery becomes real. A caller records its attempt here.
  onBeforeSubmit = undefined,
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

  // Looking for an earlier delivery of this exact request is not a lookup that may
  // fail quietly: a marker already written somewhere, or several candidates, is
  // written evidence that this request may have been delivered, so the answer is
  // uncertain and the caller must keep its attempt instead of sending again under
  // the same nonce. Any other read failure is passed on as it is, marked retryable,
  // rather than being turned into "nothing was found".
  let reused;
  try {
    reused = await findCreatedSession({ workspace: directory, requestId: request, bindingNonce: nonce }, { env, isAlive });
  } catch (error) {
    const carriesEvidence = error?.code === 'marker-not-unique' || error?.code === 'ambiguous-created-session';
    throw Object.assign(error, carriesEvidence
      ? { uncertain: true, retryable: false, attempted: true }
      : { uncertain: false, retryable: true, attempted: false });
  }
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
  const runLocked = typeof withUiLock === 'function' ? withUiLock : (action => action());
  const attempt = await runLocked(async () => {
    const opened = await ui.openNewSession({ workspace: directory, prompt: payload, allowDeepLink, allowExecutable,
      trustWorkspace, prefill: prefillViaLink, ...(folderLabel ? { folderLabel } : {}) });
    // No keystroke is sent into a page that did not become the new session: input
    // in an unidentified page could reach somebody else's conversation.
    if (opened?.navigated === false) {
      return { attempted: false, launch: opened,
        blocked: opened?.blocked === 'workspace-trust-prompt' ? 'workspace-trust-prompt' : 'launch-not-navigated' };
    }
    if (typeof onBeforeSubmit === 'function') {
      await onBeforeSubmit({ workspace: directory, requestId: request, bindingNonce: nonce, launch: opened });
    }
    const sent = await ui.submit({ prompt: payload, prefilled: opened?.prefilled === true, trustWorkspace });
    return { attempted: true, launch: opened, submitted: sent };
  });
  const launch = attempt.launch;
  const submitted = attempt.submitted;
  if (attempt.attempted === false) {
    // Nothing was typed and nothing was sent, so this is a visible stop the caller
    // can repeat, not an unknown outcome.
    return {
      created: false, status: 'unconfirmed', attempted: false, retryable: true, visible: true,
      reason: attempt.blocked,
      requestId: request, bindingNonce: nonce, workspace: directory, evidence: { launch }, startedAt,
      detail: 'The draft never became a new session, so nothing was typed or sent.',
      elapsedMs: Date.now() - Date.parse(startedAt),
    };
  }

  const deadline = Date.now() + timeoutMs;
  let observed;
  let bound = false;
  let bindingError;
  let otherNewSessions = 0;
  while (Date.now() < deadline) {
    const { sessions } = await scanNativeSessions({ env, isAlive });
    const fresh = sessions.filter(session => session.alive && !baseline.has(session.nativeSessionId)
      && samePath(session.workspace, directory));
    // Other names can start their own first turn in the same window at the same
    // time. A new session belongs to this call only when its own opening carries
    // this request marker, so the others are ignored and never make this call
    // ambiguous.
    const bindings = [];
    for (const candidate of fresh) {
      bindings.push({ record: candidate, binding: await firstTurnBinding({ env, record: candidate, marker }) });
    }
    const mine = bindings.filter(entry => entry.binding.firstInput?.owned);
    otherNewSessions = fresh.length - mine.length;
    if (mine.length === 0 && !observed && bindings.length) {
      // Remember what a new session looked like, so a timeout can say whether a
      // session appeared without this marker instead of only that nothing did.
      const fallback = bindings[bindings.length - 1];
      observed = { record: fallback.record, file: fallback.binding.file,
        count: fallback.binding.markerCount, binding: fallback.binding };
    }
    if (mine.length > 1) {
      return { created: false, status: 'ambiguous', reason: 'marker-in-several-sessions',
        candidates: mine.map(entry => entry.record.nativeSessionId), requestId: request, workspace: directory,
        marker, evidence: { launch, submitted, otherNewSessions } };
    }
    if (mine.length === 1) {
      const record = mine[0].record;
      const binding = mine[0].binding;
      const count = binding.markerCount;
      const file = binding.file;
      observed = { record, file, count, binding };
      if (binding.firstInput?.owned && count === 1) {
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
    evidence: { launch, submitted, otherNewSessions,
      session: observed ? { nativeSessionId: observed.record.nativeSessionId, markerCount: observed.count,
        firstInput: observed.binding?.firstInput, complete: observed.binding?.complete } : undefined },
    startedAt, elapsedMs: Date.now() - Date.parse(startedAt),
  };
}// ---------------------------------------------------------------- interrupt

/**
 * What a stop actually covers. The app's stop control ends the current turn of
 * one session; background children it spawned keep running and hand back on
 * their own schedule (observed: the child kept heart-beating for ~40s after the
 * stop). Tree-wide cancellation is therefore never claimed from a stop.
 */
export const INTERRUPT_SCOPE = 'session-turn';
export const INTERRUPT_SCOPE_NOTE = Object.freeze({
  childrenMayContinue: true,
  scopeNote: 'This cancels the current turn of one session. A background child task is not stopped by it and may still hand back later; a tree-wide cancel has to be driven separately.',
});

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
      nativeSessionId, verifiedBy: ['host-process-exited'], scope: INTERRUPT_SCOPE, ...INTERRUPT_SCOPE_NOTE };
  }
  const ui = requireDriver(driver, 'interrupting a turn');
  const visible = await ensureSessionVisible(record, { driver: ui, allowDeepLink, env });
  const file = await findTranscript({ env, nativeSessionId: record.nativeSessionId, workspace: record.workspace });
  if (!file) throw fail('transcript-missing', `No transcript for session ${nativeSessionId}; refusing to interrupt unverifiably.`);
  const before = await readTranscriptEvents(file);
  const since = before.events.at(-1)?.timestamp ?? new Date().toISOString();
  const press = await ui.interrupt();

  // No stop control next to the prompt box means this session is not generating:
  // there is nothing to press and nothing to wait for. Waiting for a marker that
  // cannot appear only costs the whole timeout, and the registry can look busy
  // because of background children, so it is not the signal either. The tree is
  // not claimed settled: a background child can still be running and is stopped
  // through the task panel.
  if (press?.stopButtonFound === false) {
    return {
      interrupted: false, cancelled: true, status: 'idle-no-turn', reason: 'no-stop-control',
      mayStillHaveChildren: true,
      note: 'The composer has no stop control, so this session is not generating. A background child can still be running; stop it through the task panel before treating the tree as settled.',
      nativeSessionId, method: press?.method,
      stopControl: { method: press?.method, name: press?.stopButtonName ?? null, ancestry: press?.ancestry ?? null },
      verifiedBy: ['host-stop-control-absent'], revealed: visible.revealed,
      scope: INTERRUPT_SCOPE, ...INTERRUPT_SCOPE_NOTE,
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await readTranscriptEvents(file);
    const evidence = interruptEvidence(now.events, since);
    if (evidence) {
      return { interrupted: true, cancelled: true, status: 'interrupted', nativeSessionId,
        method: press?.method, verifiedBy: ['transcript-interrupt-marker'], evidence, revealed: visible.revealed,
        stopControl: { method: press?.method, name: press?.stopButtonName ?? null, ancestry: press?.ancestry ?? null },
        scope: INTERRUPT_SCOPE, ...INTERRUPT_SCOPE_NOTE };
    }
    await sleep(pollMs);
  }

  // No interrupt record. If the host was already idle there was nothing to stop,
  // which still satisfies a cancel request; that is stated, not dressed up as an
  // interrupt.
  // A pressed stop can land just after the poll window: the record is written a
  // moment later, so read once more before calling the result unconfirmed.
  await sleep(Math.max(pollMs, 250));
  const settled = await readTranscriptEvents(file);
  const landed = interruptEvidence(settled.events, since);
  if (landed) {
    return { interrupted: true, cancelled: true, status: 'already-stopped', nativeSessionId,
      method: press?.method, verifiedBy: ['transcript-interrupt-marker',
        ...(press?.stopButtonFound === false ? ['host-stop-control-absent'] : [])],
      evidence: landed, revealed: visible.revealed, stopControl: { method: press?.method,
        name: press?.stopButtonName ?? null, ancestry: press?.ancestry ?? null },
      scope: INTERRUPT_SCOPE, ...INTERRUPT_SCOPE_NOTE };
  }
  // A stop was pressed, so this session was generating when it was pressed. No
  // record and an idle registry now is not evidence that the press took effect, so
  // that stays unconfirmed rather than being dressed up as nothing to do.
  const afterwards = await resolveNativeSession(nativeSessionId, { env, isAlive }).catch(() => record);
  return { interrupted: false, cancelled: false, status: 'unconfirmed', reason: 'interrupt-marker-not-written',
    nativeSessionId, method: press?.method, revealed: visible.revealed,
    stopControl: { method: press?.method, name: press?.stopButtonName ?? null, ancestry: press?.ancestry ?? null },
    evidence: { since, transcriptFile: file, stopButtonFound: press?.stopButtonFound,
      registryStatus: afterwards?.status ?? null } };
}// ------------------------------------------------- background tasks (children)

/** The one control a task row offers, and the states it moves through. */
export const STOP_BUTTON_NAME = /^(停止此任务|Stop this task)$/i;
export const STOP_BUSY_NAME = /(正在停止|Stopping)/i;
export const STOP_DONE_NAME = /(已停止|Stopped)/i;
export const TASKS_PANEL_NAME = /(后台任务|background tasks)/i;
/** Stopping together with archiving is a different action and is never clicked. */
/**
 * The session row in the sidebar has its own menu: open in, pin, mark unread,
 * rename, fork, move, archive, delete. Recognising it by its items is how a caller
 * that opened the wrong more-options control says so instead of clicking an item
 * from the wrong menu.
 */
export const SESSION_LIST_MENU_NAME = /^(打开方式|置顶|标记未读|重命名|分叉|移至|归档|Open in|Pin|Mark as unread|Rename|Fork|Move to|Archive)/i;

/** Which menu a list of item names belongs to, judged by the names alone. */
export function classifySessionMenu(items = []) {
  const names = items.filter(name => typeof name === "string" && name.trim());
  const list = names.filter(name => SESSION_LIST_MENU_NAME.test(name));
  const tasks = names.filter(name => TASKS_PANEL_NAME.test(name));
  if (tasks.length) return { kind: "session", tasksEntry: tasks[0], listItems: list, items: names };
  if (list.length >= 2) return { kind: "session-list", listItems: list, items: names };
  return { kind: "unknown", listItems: list, items: names };
}

export const STOP_ARCHIVE_NAME = /(停止任务并归档|停止全部|Stop task and archive|Stop tasks and archive)/i;

/** A single row comes back as an object, not a one element array. */
function rowsOf(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

function runningTaskRows(rows = [], targets) {
  rows = rowsOf(rows);
  const wanted = Array.isArray(targets) && targets.length
    ? targets.map(value => String(value).toLowerCase())
    : undefined;
  // A row that is already stopping or already stopped is not running, whether the
  // bridge flags it or its own text says so.
  return rows
    .filter(row => row && row.enabled !== false && !row.busy && !row.done)
    .filter(row => !STOP_BUSY_NAME.test(String(row.rowText ?? '')) && !STOP_DONE_NAME.test(String(row.rowText ?? '')))
    .filter(row => !wanted || wanted.some(value => `${row.rowText ?? ''} ${row.rowName ?? ''}`.toLowerCase().includes(value)));
}

/**
 * Stop the background tasks of one managed session through the host's own panel.
 *
 * The panel is a snapshot: it does not refresh itself, so it is closed and
 * reopened between rounds to see tasks that started meanwhile. Each task row has
 * one stop control whose accessible name is the same for every row, so a row is
 * addressed by its own text plus its position, and a batch is never resolved by
 * clicking the first match. Stopping a child does not finish the tree: the root
 * still has to be interrupted afterwards, which is stated in the result.
 */
export async function stopBackgroundTasks({ nativeSessionId, targets = undefined, rounds = 3 } = {}, {
  driver = createNullDriver(),
  env = process.env,
  isAlive = defaultIsAlive,
  allowDeepLink = true,
} = {}) {
  const record = await resolveNativeSession(nativeSessionId, { env, isAlive });
  if (!record.alive) {
    return { nativeSessionId, pid: record.pid, stopped: [], status: 'not-running', reason: 'session-process-gone',
      rootInterruptRequired: false, verifiedBy: ['host-process-exited'] };
  }
  const ui = requireDriver(driver, 'stopping background tasks');
  const visible = await ensureSessionVisible(record, { driver: ui, allowDeepLink, env });
  const title = visible.title || record.name;
  const panel = await ui.tasksPanel({ title, mode: 'open' });
  let rows = rowsOf(panel?.rows);
  const stopped = [];
  // A panel that has not refreshed yet still shows a row as stoppable, so a row
  // that was already asked to stop is never asked twice.
  const attempted = new Set();
  let panelOpened = 1;
  for (let round = 0; round < Math.max(1, rounds); round += 1) {
    const running = runningTaskRows(rows, targets)
      .filter(row => !attempted.has(row.index) && !attempted.has(row.title));
    if (!running.length) break;
    const row = running[0];
    attempted.add(row.index);
    if (row.title) attempted.add(row.title);
    const attempt = await ui.taskStop({ match: row.rowText, index: row.index })
      .catch(error => ({ clicked: false, code: error.code, message: error.message }));
    stopped.push({
      index: row.index,
      rowText: row.rowText,
      rowName: row.rowName,
      clicked: Boolean(attempt?.clicked),
      busySeen: Boolean(attempt?.busySeen),
      doneSeen: Boolean(attempt?.doneSeen),
      state: attempt?.doneSeen ? 'stopped' : (attempt?.busySeen ? 'stopping' : 'requested'),
      at: attempt?.at,
      ...(attempt?.clicked ? {} : { error: { code: attempt?.code ?? 'task-stop-refused', message: attempt?.message } }),
    });
    // refresh: the panel only shows tasks that exist when it is opened
    const again = await ui.tasksPanel({ title, mode: 'refresh' })
      .catch(() => ({ rows }));
    rows = rowsOf(again?.rows).length ? rowsOf(again?.rows) : rows;
    panelOpened += 1;
  }
  const remaining = runningTaskRows(rows, targets);
  const archiveOnly = remaining.length > 0 && remaining.every(row => STOP_ARCHIVE_NAME.test(String(row.rowText ?? '')));
  return {
    nativeSessionId,
    pid: record.pid,
    scope: 'session-background-tasks',
    panel: {
      opened: Boolean(panel?.opened),
      entry: panel?.entry ?? null,
      entryCount: (() => {
        const match = /(\d+)\s*$/.exec(String(panel?.entry ?? ''));
        return match ? Number(match[1]) : null;
      })(),
      locator: panel?.fallback ? 'title-fallback' : 'view-options',
      openedTimes: panelOpened,
    },
    rows: (rows ?? []).map(row => ({ index: row.index, rowText: row.rowText, busy: row.busy, done: row.done,
      depth: row.depth ?? null })),
    nestedDetected: (rows ?? []).some(row => Number(row.depth ?? 0) > 0),
    stopped,
    remaining: remaining.map(row => ({ index: row.index, rowText: row.rowText })),
    ...(archiveOnly ? { archiveOnly: true, stoppedNothing: true } : {}),
    rootInterruptRequired: true,
    verifiedBy: ['panel-stop-button'],
    ...INTERRUPT_SCOPE_NOTE,
  };
}

// ------------------------------------------------------------------ destroy

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
/**
 * The archive found once stays found.
 *
 * Resolving it means asking the window where the running executable lives, which
 * costs a bridge start. That answer only changes when the application is updated,
 * which the file timestamp accounts for, so it is remembered per process and
 * checked with a stat before it is reused.
 */
let knownAsar;

export async function resolveAppAsar({ driver, env = process.env } = {}) {
  if (typeof env?.CLAUDE_APP_ASAR === 'string' && env.CLAUDE_APP_ASAR.trim()) {
    return { asar: path.resolve(env.CLAUDE_APP_ASAR.trim()), source: 'env' };
  }
  if (knownAsar) {
    const info = await stat(knownAsar).catch(() => null);
    if (info?.isFile()) return { asar: knownAsar, source: 'remembered-app' };
    knownAsar = undefined;
  }
  if (driverAvailable(driver) && typeof driver.probe === 'function') {
    const probe = await driver.probe().catch(() => undefined);
    const executable = probe?.window?.executable;
    if (typeof executable === 'string' && executable.toLowerCase().endsWith('claude.exe')) {
      // The executable lives in <app>/ and the archive in <app>/resources/, but a
      // packaged build can also put resources one level up; both are checked.
      for (const candidate of [path.join(path.dirname(executable), 'resources', 'app.asar'),
        path.join(path.dirname(executable), '..', 'resources', 'app.asar')]) {
        const info = await stat(candidate).catch(() => null);
        if (info?.isFile()) { knownAsar = path.resolve(candidate); return { asar: knownAsar, source: 'running-app' }; }
      }
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
/** Where the running app keeps its own state, including each session record. */
export function sessionStoreRoot({ env = process.env } = {}) {
  if (typeof env.CLAUDE_DESKTOP_USER_DATA === "string" && env.CLAUDE_DESKTOP_USER_DATA) return env.CLAUDE_DESKTOP_USER_DATA;
  const local = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Local") : undefined);
  if (!local) return undefined;
  return path.join(local, "Claude-Data", "claude_pzs8sxrjxfjjc");
}

/**
 * The app own record for one session.
 *
 * The desktop app persists each session as
 * claude-code-sessions/<account>/<org>/local_<hostSessionId>.json under its user
 * data directory, with the model and effort that session is set to. Reading it is
 * a file read: no window is opened, nothing is clicked and no turn is spent. The
 * record also carries the native session id, which is what proves the file is
 * about the session the caller asked for.
 */
export async function readStoredSession({ env = process.env, hostSessionId, nativeSessionId, userData = undefined } = {}) {
  if (!hostSessionId) return { found: false, reason: "host-session-id-missing" };
  const root = userData ?? sessionStoreRoot({ env });
  if (!root) return { found: false, reason: "user-data-unknown" };
  const base = path.join(root, "claude-code-sessions");
  // the registry already carries the local_ prefix; the file name has exactly one
  const wanted = "local_" + String(hostSessionId).replace(/^local_/, "") + ".json";
  for (const account of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!account.isDirectory()) continue;
    const accountDir = path.join(base, account.name);
    for (const org of await readdir(accountDir, { withFileTypes: true }).catch(() => [])) {
      if (!org.isDirectory()) continue;
      const file = path.join(accountDir, org.name, wanted);
      const raw = await readFile(file, "utf8").catch(() => undefined);
      if (!raw) continue;
      let record;
      try { record = JSON.parse(raw); } catch { continue; }
      const info = await stat(file).catch(() => undefined);
      const identityIds = [record.sessionId, record.cliSessionId].filter(value => typeof value === "string");
      const identity = !nativeSessionId ? "host-session-id"
        : (identityIds.includes(nativeSessionId) ? "native-session-id" : (identityIds.length ? "mismatch" : "host-session-id"));
      return { found: true, file, root, record, persistedAt: info?.mtime?.toISOString(), identity, identityIds };
    }
  }
  return { found: false, reason: "session-record-missing", root };
}

export async function readCurrentModel({ nativeSessionId, workspace = undefined, folderLabel = undefined, source = "ui" }, {
  driver = createNullDriver(), env = process.env, isAlive = defaultIsAlive, catalog = undefined, asar = undefined,
  batch = true, allowDeepLink = true,
} = {}) {
  const modelCatalog = catalog ?? await loadModelCatalog({ asar, driver, env });
  const record = await resolveNativeSession(nativeSessionId, { env, isAlive });
  // The window is the authority for a current selection. The app's own per-session
  // record is readable without touching the window, but it is only a record of what
  // was last written: whether a selection made without a turn is written straight
  // away is unverified, so it is offered as history (source "store") and never as
  // the current control unless the caller asks for it explicitly.
  if (source === "store" || source === "auto") {
    const stored = await readStoredSession({ env, hostSessionId: record.hostSessionId, nativeSessionId: record.nativeSessionId });
    if (stored.found && stored.identity !== "mismatch" && typeof stored.record.model === "string") {
      const known = modelCatalog.models.find(model => model.id === stored.record.model);
      const effort = typeof stored.record.effort === "string" ? stored.record.effort : undefined;
      const file = await findTranscript({ env, nativeSessionId: record.nativeSessionId, workspace: record.workspace })
        .catch(() => undefined);
      let transcriptModel;
      let transcriptEffort;
      if (file) {
        const { events } = await readTranscriptEvents(file);
        const last = [...events].reverse().find(event => event.role === "assistant" && event.model);
        transcriptModel = last?.model;
        transcriptEffort = last?.effort;
      }
      const historyDiffers = Boolean(transcriptModel && transcriptModel !== stored.record.model)
        || Boolean(transcriptEffort && effort && transcriptEffort !== effort);
      return {
        nativeSessionId,
        provider: "anthropic",
        model: stored.record.model,
        reasoningEffort: effort,
        resolved: Boolean(known),
        status: known ? "read" : "unmapped",
        label: known?.name ?? null,
        effortLabel: effort ? (EFFORT_LABEL_FOR[effort] ?? null) : null,
        source: "session-store",
        windowTouched: false,
        authoritative: false,
        selectionObserved: false,
        historical: true,
        targetConfirmedBy: stored.identity === "native-session-id" ? "session-record-native-id" : "session-record",
        verifiedBy: ["session-store", ...(stored.identity === "native-session-id" ? ["native-session-id"] : [])],
        persistedAt: stored.persistedAt,
        sessionStoreFile: stored.file,
        lastTurnEdgeAt: stored.record.lastTurnEdgeAt ?? null,
        title: (stored.record.title ?? "").trim() || null,
        catalogSource: modelCatalog.catalogSource,
        evidence: { control: null, store: { model: stored.record.model, effort, identity: stored.identity }, history: { transcriptModel, transcriptEffort } },
        historyDiffers,
        ...(known ? {} : { reason: "model-id-not-in-catalog", unresolvedModel: stored.record.model }),
        ...(historyDiffers ? { note: "The stored record differs from what this session last ran; the record is the current setting, the transcript is history." } : {}),
        detail: "Read from the app per-session record, so the window was not touched. It is the last written value, and whether a selection without a turn is written immediately is unverified; read the composer control (source ui) when the current selection must be authoritative.",
      };
    }
  }
  const ui = requireDriver(driver, "reading the current model");
  // The session's own control is all this needs, so it is taken in the same single
  // bridge call as the default read. Identity comes from the document title the
  // snapshot reports; anything unclear falls back to the step-by-step path, which
  // also confirms by page content.
  if (batch !== false && typeof ui.modelSnapshot === 'function') {
    const snapshot = await ui.modelSnapshot({ title: record.name, workspace: workspace ?? record.workspace,
      folderLabel: folderLabel ?? (record.workspace ? path.basename(record.workspace) : undefined), wantDefault: false })
      .catch(() => undefined);
    const control = describeControl(modelCatalog, snapshot?.current?.raw ?? null);
    const titleMatches = Boolean(snapshot?.documentName && displayTitle(snapshot.documentName) === record.name);
    if (control.label && titleMatches) {
      const history = await readModelHistory({ env, record, driver });
      const historyDiffers = Boolean((history.transcript?.model && control.model && history.transcript.model !== control.model))
        || Boolean((history.transcript?.effort && control.reasoningEffort && history.transcript.effort !== control.reasoningEffort))
        || Boolean((history.launchArgs?.model && control.model && history.launchArgs.model !== control.model));
      return {
        nativeSessionId,
        provider: control.provider ?? 'anthropic',
        model: control.model,
        reasoningEffort: control.reasoningEffort ?? undefined,
        resolved: control.resolved,
        status: control.resolved ? 'read' : 'unmapped',
        label: control.label,
        effortLabel: control.effortLabel,
        source: 'composer-control',
        targetConfirmedBy: 'document-title',
        verifiedBy: ['session-model-control'],
        catalogSource: modelCatalog.catalogSource,
        evidence: { control, history, documentName: snapshot.documentName },
        historyDiffers,
        singleCall: true,
        ...(control.resolved ? {} : { reason: 'label-not-in-catalog', unresolvedLabel: control.label, unresolvedEffort: control.effortLabel }),
        ...(historyDiffers ? {
          note: 'The control differs from what this session ran before; that is a selection change, and the control is the current value.',
        } : {}),
      };
    }
  }
  const visible = await ensureSessionVisible(record, { driver: ui, allowDeepLink, env });
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
/** Map a control's own text through the catalogue, once, for a whole snapshot. */
export function describeControl(catalog, raw) {
  const info = modelInfo(raw ?? undefined);
  const models = catalog?.models ?? BUILT_IN_MODEL_CATALOG.models;
  const known = info.label ? models.find(entry => entry.name === info.label) : undefined;
  const effort = info.effort ? EFFORT_LABELS[info.effort] : undefined;
  return {
    raw: raw ?? null,
    label: info.label ?? null,
    effortLabel: info.effort ?? null,
    provider: known ? 'anthropic' : null,
    model: known?.id ?? null,
    reasoningEffort: effort ?? null,
    resolved: Boolean(known) && Boolean(effort),
  };
}

/**
 * Read what the session is set to and what a new draft starts at, in one bridge
 * call.
 *
 * The value is read from the host every time: nothing is cached across tasks, so
 * a default the user changed a minute ago is still followed. The single call
 * exists only to avoid paying six process starts and their sleeps for one answer.
 */
export async function readModelSnapshot({ nativeSessionId = undefined, workspace = undefined, folderLabel = undefined, wantDefault = true } = {}, {
  driver = createNullDriver(), env = process.env, isAlive = defaultIsAlive,
  catalog = undefined, asar = undefined,
} = {}) {
  const ui = requireDriver(driver, 'reading the model');
  if (typeof ui.modelSnapshot !== 'function') throw fail('snapshot-unsupported', 'This driver cannot take a model snapshot.');
  const record = nativeSessionId
    ? await resolveNativeSession(nativeSessionId, { env, isAlive }).catch(() => undefined)
    : undefined;
  const target = workspace ?? record?.workspace;
  const started = Date.now();
  const snapshot = await ui.modelSnapshot({
    title: record?.name,
    workspace: target,
    folderLabel: folderLabel ?? (target ? path.basename(target) : undefined),
    wantDefault,
  });
  const modelCatalog = catalog ?? await loadModelCatalog({ asar, driver: ui, env });
  const documentName = snapshot?.documentName ?? null;
  const titleMatches = record?.name ? Boolean(documentName && displayTitle(documentName) === record.name) : undefined;
  return {
    nativeSessionId: record?.nativeSessionId ?? null,
    documentName,
    titleMatchesRecord: titleMatches,
    current: describeControl(modelCatalog, snapshot?.current?.raw),
    default: wantDefault ? describeControl(modelCatalog, snapshot?.default?.raw) : null,
    navigation: snapshot?.navigation ?? null,
    notes: snapshot?.notes ?? [],
    selectionSource: modelCatalog.selectionSource ?? 'global_default',
    catalogSource: modelCatalog.catalogSource,
    catalogVersion: modelCatalog.catalogVersion,
    singleCall: true,
    elapsedMs: Date.now() - started,
    verifiedBy: wantDefault ? ['composer-control', 'draft-control'] : ['composer-control'],
  };
}

export async function readDefaultModel({
  driver = createNullDriver(), env = process.env, isAlive = defaultIsAlive,
  catalog = undefined, asar = undefined, workspace = undefined, folderLabel = undefined, readOnly = false,
  batch = true,
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
  // One call answers both questions when the driver can do it; the step-by-step
  // path below stays for drivers that cannot and for the cases it refuses.
  if (batch !== false && !readOnly && typeof ui.modelSnapshot === 'function') {
    const snapshot = await ui.modelSnapshot({ workspace, folderLabel, wantDefault: true }).catch(() => undefined);
    const notes = snapshot?.notes ?? [];
    if (snapshot?.default?.raw && !notes.includes('unsent-text-present')) {
      const control = describeControl(modelCatalog, snapshot.default.raw);
      if (control.resolved) {
        return {
          provider: control.provider, model: control.model, reasoningEffort: control.reasoningEffort,
          label: control.label, effortLabel: control.effortLabel, resolved: true, verified: true, status: 'read',
          selectionSource: summary.selectionSource, catalogSource: modelCatalog.catalogSource,
          catalogVersion: modelCatalog.catalogVersion,
          evidence: { control: { label: control.label, effort: control.effortLabel, raw: control.raw }, catalog: summary },
          navigation: { ...snapshot.navigation, previousDocumentName: snapshot.previousDocumentName ?? null },
          notes, singleCall: true,
        };
      }
    }
  }
  const startView = await readViewStable(ui);
  // The composer always holds a newline; only trimmed text counts as an unsent draft.
  const composerLength = Number(startView?.composerTrimmedLength ?? startView?.composerLength ?? 0);
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
      // The title is what the reveal verifies itself against; without it the
      // sidebar fallback never runs and a swallowed deep link looks like success.
      const revealed = await ui.revealSession({ hostSessionId: previous.hostSessionId, title: previous.name, allowDeepLink: true })
        .catch(() => undefined);
      const back = await readViewStable(ui);
      const marker = await sessionContentMarker({ env, record: previous });
      const ok = viewMatchesSession(back, previous) || pageShowsSession(back, marker);
      return ok ? 'session' : (revealed ? 'unconfirmed' : 'failed');
    };
    if (launch?.blocked === 'workspace-trust-prompt' || draftView?.trustPrompt) {
      const restored = await restore();
      // A trust question is a definite stop, not an unknown outcome: nothing was
      // typed, nothing was sent, and the same call can be repeated once the
      // question is answered, so the caller can see and retry it.
      throw fail('workspace-trust-prompt',
        'Opening a draft for that folder asks the host\'s workspace-trust question; it is not answered on the caller\'s behalf.',
        { launch, restored, attempted: false, retryable: true, visible: true,
          reason: 'workspace-trust-prompt',
          detail: 'The draft was opened and left untouched; answer the trust question in the window and call again.' });
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
  const before = await readCurrentModel({ nativeSessionId, source: 'ui' }, { driver: ui, env, isAlive, catalog: modelCatalog });
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
  const after = await readCurrentModel({ nativeSessionId, source: 'ui' }, { driver: ui, env, isAlive, catalog: modelCatalog });
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
  const usage = 'usage: node src/claude-host.mjs <probe|sessions|model|current-model|create|interrupt|stop-tasks|destroy|resume|select-model> [json]';
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
      'stop-tasks': () => stopBackgroundTasks(payload, { driver }),
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
