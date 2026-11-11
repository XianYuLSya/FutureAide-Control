import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControl, endedState, modelTurnError } from './control.mjs';
import { FutureAideClient } from './futureaide-api.mjs';
import { resolveModel } from './agents.mjs';
import { actualModelName, resolveModelSelection, sameModelSelection } from './model-selection.mjs';
import { callCodexOwner, readCodexOwnerTurns, readCodexOwnerItems } from './codex-notify.mjs';
import { callingThread, ownerIdFor, ownerIdForSource, resolveCallingContext, threadFromResult, trustedCaller } from './calling-context.mjs';
import { bindClaude, currentRecord, discoverClaude, readClaudeEvents, sendClaude } from './claude-inbox.mjs';
import { resolveNativeSession } from './claude-sessions.mjs';
import { RosterStore, submissionRef } from './roster-store.mjs';
import { canSleep } from './idle-monitor-eligibility.mjs';
import { idleSignal } from './idle-monitor.mjs';
import { ensureSharedMonitor, monitorAlive } from './shared-monitor.mjs';
import { diagnoseTarget, DSH_HOST_METHODS, hostLabel, normalizeTarget, readStatusModels, REMOVED_TARGETS, removedTarget, resolveBackend,
  TARGET_LABELS, targetOf } from './agent-backend.mjs';
import { captureWorkspace, diffWorkspace } from './workspace-diff.mjs';
import { FINAL_REPORT_REMINDER } from './report-contract.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const uid = prefix => `${prefix}-${randomUUID().replaceAll('-', '')}`;
const now = () => new Date().toISOString();
const ACTIVE = new Set(['creating', 'running', 'awaiting_input', 'awaiting_report', 'reconnecting', 'delivery_pending', 'cleaning']);
const METHODS = DSH_HOST_METHODS;
const TREE_PROTOCOL = 1;
const REPORT_PROTOCOL = 1;
const UNCONFIRMED_AFTER_MS = 30 * 60 * 1000;
const EXPIRE_UNSENT_AFTER_MS = 6 * 60 * 60 * 1000;
const CONFIRM_ABSENCE_AFTER_MS = 2 * 60 * 1000;
const terminalNotice = notice => ['delivered', 'blocked'].includes(notice?.state);
let codexProbePromise;
/** codex-host's own registration probe, imported lazily so only the Codex path loads it. */
function defaultCodexProbe() {
  codexProbePromise ??= import('./codex-host.mjs')
    .then(module => module.probeCodexReportRegistration)
    .catch(() => undefined);
  return codexProbePromise;
}
const reportProtocolError = (host = 'DSH') => Object.assign(new Error(`Update the ${host} plugin bridge and reload the plugin/MCP connection to enable explicit reports; restarting ${host} is not required.`), { code: 'report-protocol-required' });
const treeProtocolError = (host = 'DSH') => Object.assign(new Error(`The ${host} bridge and caller must support task-tree protocol 1. Update the plugin bridge and reload the plugin/MCP connection; restarting ${host} is not required.`), { code: 'tree-protocol-required' });
const safeError = error => ({ code: error?.code ?? 'operation-failed', message: String(error?.message ?? error).slice(0, 1200) });
const readOnlyTarget = record => REMOVED_TARGETS.includes(record?.target);
function requireWritableTarget(record) {
  if (readOnlyTarget(record)) throw removedTarget(record.target);
  return record;
}

function assertName(name) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name)) {
    throw new Error('Use a nonempty subagent name of at most 80 characters, without leading/trailing whitespace.');
  }
  return name;
}
function textMessage(message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw new Error('A message of 1–100000 characters is required.');
  return message;
}
function stableHost(identity, target) {
  // Codex home changes wholesale when FAswitch switches profiles, and the thread
  // read is the real ownership test. Compare only the application there.
  if (target === 'codex-desktop' || target === 'claude-cli') return { application: identity.application ?? null };
  return { application: identity.application ?? null, dataRoot: path.resolve(identity.dataRoot ?? '') };
}
// The compact view keeps the one label that stops a snapshot guess reading as a confirmed write.
const fileSummary = change => ({ path: change.path, operation: change.operation,
  ...(change.agentPath ? { agentPath: change.agentPath } : {}),
  ...(change.attribution === 'unconfirmed' ? { attribution: change.attribution } : {}) });
const compactText = (value, length) => typeof value === 'string' && value.length > length ? value.slice(0, length) + '…' : value;

// Native IDs stay internal. Even a malformed snapshot cannot expose an unrelated
// session: a node must have an acyclic parent chain to this named agent's root.
function ownedTree(record, view) {
  const source = view.tree?.nodes ?? [];
  const byId = new Map(source.filter(node => typeof node?.sessionId === 'string').map(node => [node.sessionId, node]));
  const root = byId.get(record.sessionId);
  const nodes = [];
  if (root && root.parentSessionId == null) {
    for (const node of byId.values()) {
      const names = [], visited = new Set();
      let current = node;
      while (current && !visited.has(current.sessionId)) {
        visited.add(current.sessionId);
        if (current.sessionId === record.sessionId) {
          names.unshift(record.name);
          nodes.push({ node, agentPath: names, depth: names.length - 1 });
          break;
        }
        names.unshift(typeof current.name === 'string' && current.name ? current.name : 'subagent');
        current = byId.get(current.parentSessionId);
      }
    }
  }
  nodes.sort((a, b) => a.depth - b.depth);
  return { nodes, complete: nodes.length > 0 && nodes.length === source.length };
}

function treeSettled(record, view) {
  return !record.task?.cancelPending && view.tree?.settled === true && view.tree.running === false && ownedTree(record, view).complete;
}

function rootSummary(view) {
  const summary = view.tree?.rootSummary;
  return summary?.ready === true && typeof summary.reply === 'string'
    && ['completed', 'failed', 'cancelled'].includes(summary.state) ? summary : undefined;
}

// What a workspace comparison can and cannot see. It is stated wherever the covered
// files are, because a short list next to a silent claim of completeness is misleading.
const WORKSPACE_LIMITATION = 'Compared before and after the task with git status, not watched live: edits made meanwhile by other processes or other assistants look identical, and paths covered by .gitignore or outside a git repository are invisible.';
const workspaceCoverage = (reason, truncated = false) => ({ source: 'git-status-diff', complete: false,
  limitation: WORKSPACE_LIMITATION, ...(reason ? { reason } : {}), ...(truncated ? { truncated: true } : {}) });
// Windows paths are case-insensitive, so a confirmed and a snapshotted spelling of the
// same file must not both survive.
const pathKey = value => {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * Snapshot entries are unconfirmed: they name a path that changed, not an agent's own
 * write. A path the target's file tools already reported is the same change, so the
 * snapshot copy is dropped rather than counted twice.
 */
function withWorkspaceChanges(changes, workspace, name) {
  const found = workspace?.changes;
  if (!Array.isArray(found) || !found.length) return changes;
  const known = new Set(changes.map(change => pathKey(change.path)));
  const extra = found.filter(change => !known.has(pathKey(change.path)))
    .map(change => ({ path: change.path, operation: change.operation, source: 'workspace-diff',
      attribution: 'unconfirmed', agentPath: [name] }));
  return [...changes, ...extra];
}

function attributedChanges(record, view, workspace = record.task?.workspace) {
  const tree = ownedTree(record, view);
  const changes = tree.nodes.length
    ? tree.nodes.flatMap(({ node, agentPath }) => (node.changes ?? []).map(change => {
        const { sessionId, parentSessionId, agentId, ...file } = change;
        return { ...file, agentPath };
      }))
    : (view.changes ?? []).map(change => ({ ...change, agentPath: [record.name] }));
  return withWorkspaceChanges(changes, workspace, record.name);
}

function publicTree(record, view) {
  const { nodes, complete } = ownedTree(record, view);
  const observationError = view.tree?.observationError ?? view.observationError;
  return { settled: complete && view.tree?.settled === true && view.tree.running === false,
    running: view.tree?.running ?? view.running ?? false,
    ...(observationError ? { observationError: safeError(observationError) } : {}),
    nodes: nodes.map(({ node, agentPath, depth }) => ({ name: agentPath.at(-1),
      parentName: depth ? agentPath.at(-2) : null, agentPath, depth, status: node.status,
      activity: node.activity, changes: (node.changes ?? []).slice(0, 12).map(change => fileSummary({ ...change, agentPath })),
      coverage: node.coverage ?? 'Not observed' })) };
}

function treeCoverage(record, view, workspace) {
  const { nodes } = ownedTree(record, view);
  // The workspace entry says what a zero count does not: whether a snapshot was even
  // taken, and why not when it was not.
  const covered = workspace ?? record.task?.workspace?.coverage ?? workspaceCoverage('not-captured');
  const own = typeof view.coverage === 'object' && view.coverage ? view.coverage
    : { note: view.coverage ?? 'Not observed yet; zero known files is not a complete filesystem audit.' };
  return nodes.length > 1 ? { scope: `${hostLabel(record)} task tree`,
    nodes: nodes.map(({ node, agentPath }) => ({ agentPath, coverage: node.coverage ?? 'Not observed' })),
    workspace: covered }
    : { ...own, workspace: covered };
}

function publicResult(record, { fullResult = false } = {}) {
  const task = record.task;
  const lastDispatch = task?.dispatches?.at(-1);
  const error = record.error ?? task?.cancelError ?? (lastDispatch?.state === 'failed' ? lastDispatch.failure : undefined)
    ?? (!['completed', 'cancelled'].includes(lastDispatch?.state) ? lastDispatch?.error : undefined);
  const view = record.observation ?? {};
  const changes = attributedChanges(record, view);
  const explicitReports = (task?.reports ?? []).filter(report => !report.failure);
  return {
    name: record.name, lifetime: record.lifetime, target: targetOf(record), state: record.state,
    // The full ID the target actually uses, never the caller's substring. The
    // explicit pin is a separate value and is only reported by a dispatch receipt;
    // list/wait must not present an intended selection as an observed model. An
    // unpinned Codex name starts null and becomes known from the live observation
    // before record.model catches up.
    actualModel: record.modelPin && targetOf(record) !== 'claude-cli'
      ? actualModelName(record.model) ?? actualModelName(record.observation?.currentModel)
      : actualModelName(record.observation?.currentModel) ?? actualModelName(record.model),
    task: task ? { text: compactText(task.message, 240), state: task.state, startedAt: task.startedAt,
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.result ? { result: { state: task.result.state,
        ...(fullResult ? { reply: task.result.reply } : { summary: compactText(task.result.reply, 800) }),
        files: (task.result.changes ?? []).slice(0, 12).map(fileSummary), coverage: task.result.coverage } } : {}) } : null,
    activity: view.activity ?? (record.state === 'idle' ? 'Waiting for a task' : record.state),
    // unconfirmed is counted over the whole list, not the 12 paths this answer can
    // afford: a compact view must not under-report how much is unattributed.
    changes: { count: changes.length, unconfirmed: changes.filter(change => change.attribution === 'unconfirmed').length,
      files: changes.slice(0, 12).map(fileSummary),
      coverage: treeCoverage(record, view),
      observedAt: view.capturedAt ?? null, stale: Boolean(view.stale) },
    questions: (view.questions ?? []).filter(question => question.state === 'pending').map(question => ({ message: question.message })),
    tree: publicTree(record, view),
    reports: { total: explicitReports.length, pending: explicitReports.filter(report => !terminalNotice(report.delivery)).length,
      ...(explicitReports.length ? { latest: { summary: compactText(explicitReports.at(-1).message, 240), final: explicitReports.at(-1).final, delivery: explicitReports.at(-1).delivery.state,
        ...(explicitReports.at(-1).delivery.error ? { error: explicitReports.at(-1).delivery.error } : {}) } } : {}) },
    delivery: explicitReports.find(report => !terminalNotice(report.delivery))?.delivery.state ?? explicitReports.at(-1)?.delivery.state ?? null, updatedAt: record.updatedAt,
    ...(record.callbackBlocked ? { callbackError: { code: 'native-callback-unavailable', message: 'The desktop does not permit background reports to this native multi-agent v2 sub-agent.' } } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Native receipt for a Claude notice. Our request id survives as the queue,
 * attachment or user uuid, so the delivery record — not the transcript text — is
 * the evidence: the reader truncates text at 8k, which would drop the trailing
 * marker of a long report.
 * @param {Array<{requestId: string, stage: string, seq?: number}>} deliveries
 * @param {string} requestId
 */
export function claudeNoticeReceipt(deliveries, requestId) {
  if (!Array.isArray(deliveries) || typeof requestId !== 'string') return undefined;
  return deliveries.find(item => item?.requestId === requestId && ['accepted', 'inserted'].includes(item.stage));
}

const CLAUDE_STALE_BINDING = ['claude-session-changed', 'claude-process-replaced', 'claude-inbox-key-mismatch',
  'claude-binding-mismatch', 'claude-transcript-unresolved', 'claude-binding-invalid', 'claude-transcript-replaced'];

/** A cached Claude transport binding the session has outgrown: refresh it once. */
export const claudeBindingStale = error =>
  CLAUDE_STALE_BINDING.some(code => String(error?.message ?? error ?? '').includes(code));

const CLAUDE_PAGE_BYTES = 1 << 20;
const CLAUDE_MAX_PAGE_BYTES = 16 << 20;
const CLAUDE_PAGES_PER_POLL = 8;

/**
 * Complete-line byte cursor at the current end of a transcript: where a new notice
 * starts looking for its receipt. Only a small tail window is read, so a long parent
 * chat costs the same as an empty one.
 */
export async function transcriptCursor(binding) {
  const handle = await open(binding.transcriptFile, 'r');
  try {
    const { size } = await handle.stat();
    const window = Math.min(size, 64 * 1024);
    if (!window) return 0;
    const buffer = Buffer.alloc(window);
    await handle.read(buffer, 0, window, size - window);
    const lastBreak = buffer.lastIndexOf(10);
    // A tail with no line break cannot be a cursor; start over rather than misalign.
    return lastBreak === -1 ? 0 : size - window + lastBreak + 1;
  } finally { await handle.close(); }
}

/**
 * Follow one notice's page window for its own request id, advancing the saved cursor
 * as it goes. Pages continue on the next poll instead of rescanning history, and a
 * line longer than a page retries at the reader's 16MiB ceiling.
 * @param {object} binding Native transport binding.
 * @param {{id: string, cursor?: number}} notice Persisted notice; its cursor advances.
 */
export const claudeNoticeRequestId = id => /^[a-zA-Z0-9-]{1,100}$/.test(id)
  ? id : `notice-${createHash('sha256').update(id).digest('hex')}`;

/**
 * Failures older builds recorded as unknown although sendClaude stops before it opens
 * a socket: nothing reached the session, so these notices may be sent again.
 */
const claudeNeverWritten = notice => notice.error?.code === 'ENOENT'
  || (claudeNoticeRequestId(notice.id) !== notice.id && notice.error?.message === 'claude-request-id-invalid');

export async function findClaudeReceipt(binding, notice, readEvents = readClaudeEvents) {
  let cursor = Number.isSafeInteger(notice.cursor) ? notice.cursor : 0;
  for (let page = 0; page < CLAUDE_PAGES_PER_POLL; page++) {
    let read;
    try { read = await readEvents(binding, { offset: cursor, maxBytes: CLAUDE_PAGE_BYTES }); }
    catch (error) {
      if (!String(error?.message ?? '').includes('line-exceeds-page') || CLAUDE_PAGE_BYTES >= CLAUDE_MAX_PAGE_BYTES) throw error;
      read = await readEvents(binding, { offset: cursor, maxBytes: CLAUDE_MAX_PAGE_BYTES });
    }
    const matched = claudeNoticeReceipt(read.deliveries, claudeNoticeRequestId(notice.id));
    const next = Number.isSafeInteger(read.offset) ? read.offset : cursor;
    notice.cursor = next;
    if (matched) return matched;
    if (read.hasMore !== true || next <= cursor) return undefined;
    cursor = next;
  }
  return undefined;
}

/**
 * Whether a turn that just ended owes its agent one reminder that no final report
 * arrived. Only a task created with the marker is reminded, so a task already waiting
 * when this rule shipped is never woken by it, and a reminder already sent is never
 * repeated.
 * @param {{terminal?: string, task?: object, view?: object, target?: string, supplements?: Array<object>}} input
 * @returns {boolean} True when exactly one reminder should be dispatched now.
 */
export function finalReminderDue({ terminal, task, view, target, supplements } = {}) {
  if (terminal !== undefined) return false;
  if (task?.finalReminder !== 'armed') return false;
  const final = [...(task.reports ?? []), ...(view?.reports ?? [])].some(report => report.final === true);
  if (final) return false;
  // Desktop targets deliver input through their own durable queue; this reminder is
  // only wired for DSH, which reads a supplement on its next step.
  if (target !== 'dsh') return false;
  return !(supplements ?? []).some(item => item.task === task.taskId && !['accepted', 'blocked'].includes(item.status));
}

const RETRY_CAP_MS = 30000;
// A delivery whose parent chat is gone keeps failing forever. Past this many attempts it
// backs off to five minutes instead of hammering a channel that cannot answer; a live
// channel never reaches it (a few attempts at most), so normal delivery is unchanged.
const ABANDONED_AFTER = 20;
const ABANDONED_RETRY_CAP_MS = 300000;
const FAST_POLL_DUE_MS = 2000;

/** Retry spacing for one delivery or dispatch attempt. */
export function retryDelayMs(attempts) {
  const cap = attempts > ABANDONED_AFTER ? ABANDONED_RETRY_CAP_MS : RETRY_CAP_MS;
  return Math.min(cap, 1000 * 2 ** Math.min(attempts, 9));
}

/**
 * The observation to store for this round. When only the capture moment moved, the
 * previous object is kept verbatim — its stamp included — so the record still
 * serialises to the body already in the roster and save() writes nothing.
 */
export function captureObservation(previous, payload, at) {
  return previous && sameObservation(previous, payload) ? previous : { ...payload, capturedAt: at };
}

function sameObservation(left, right) {
  const keysOf = value => Object.keys(value ?? {}).filter(key => key !== 'capturedAt');
  const leftKeys = keysOf(left), rightKeys = keysOf(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!(key in (right ?? {}))) return false;
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false;
  }
  return true;
}

/**
 * Does this name owe something a five-second cadence would slow down? Only work that is
 * about to be retried: a report or question notice whose own backoff is due (or was
 * never set), a dispatch waiting to be retried, an attempt about to become due. A name
 * that is merely delivery_pending is not here: its own nextAttemptAt decides, so a
 * delivery that has been failing for days is not re-polled every second.
 */
export function owesFastPoll(record, at = Date.now()) {
  if (!record || record.closed || record.sleep) return false;
  const dueSoon = notice => Boolean(notice) && !['delivered', 'blocked'].includes(notice.state ?? 'pending')
    && (!notice.nextAttemptAt || notice.nextAttemptAt <= at + FAST_POLL_DUE_MS);
  if ((record.task?.reports ?? []).some(report => dueSoon(report.delivery))) return true;
  if (Object.values(record.task?.questionNotices ?? {}).some(dueSoon)) return true;
  if ((record.task?.dispatches ?? []).some(dispatch => dispatch.state === 'retrying' && dueSoon(dispatch))) return true;
  return typeof record.nextAttemptAt === 'number' && record.nextAttemptAt <= at + FAST_POLL_DUE_MS;
}

/** Name-addressed operations; owner and native identifiers never come from tool arguments. */
export function createScopedAgents(config, {
  store = new RosterStore(path.join(config.stateDirectory, 'roster.sqlite')),
  callCodex = undefined,
  nativeRequest = undefined,
  codexInvoke = undefined,
  clientFactory = settings => new FutureAideClient({ dataHome: settings.dataRoot, dshDataHome: settings.dshDataRoot,
    target: settings.target, instanceFile: settings.instanceFile, preferredInstanceFile: settings.preferredInstanceFile,
    baseUrl: settings.baseUrl, timeoutMs: settings.timeoutMs, hostBridgeFile: settings.hostBridgeFile }),
  controlFactory = createControl,
  startSharedMonitor = ensureSharedMonitor,
  monitorFailureGraceMs = 60000,
  removeTree = rm,
  backendAdapters = {},
  backendAdapterLoader = undefined,
  codexReportReady = undefined,
  codexToolsStatus = undefined,
  codexProbeRegistration = undefined,
  captureFiles = captureWorkspace,
  onPollComplete = () => {},
  // A drill may replace the Claude transport. Production leaves this empty.
  claudeInbox = {},
  // Work queued in this process (a supplement, a cancel, a first dispatch) is a wake
  // a listener living in the same process can act on at once. A caller in another
  // process cannot be seen this way and waits for the monitor's own sweep.
  onWorkQueued = () => {},
} = {}) {
  const claudeSend = claudeInbox.send ?? sendClaude;
  const claudeDiscover = claudeInbox.discover ?? discoverClaude;
  const claudeReadEvents = claudeInbox.readEvents ?? readClaudeEvents;
  const claudeBind = claudeInbox.bind ?? bindClaude;
  const clients = new Map();
  const operationBackends = new WeakMap();
  const inflight = new Map(), monitorInflight = new Map();
  // One shared Codex-owner entry for reads and sends: native RPC first, app-tools
  // only when the debug port is unavailable. Tests may inject the transport seams,
  // but never replace this routing with a callCodex override.
  const codexOwnerCall = callCodex ?? ((threadId, toolName, args) => callCodexOwner(threadId, toolName, args,
    { ...(nativeRequest ? { nativeRequest } : {}), ...(codexInvoke ? { invoke: codexInvoke } : {}) }));
  // A snapshot write started by a dispatch is not awaited by it, so its promise is kept
  // per task: reading the baseline and shutting down both wait for it here.
  const baselineWrites = new Map();
  const nextPollAt = new Map();
  // Names that owe something a five-second cadence would slow down.
  const fastPoll = new Set();
  // Names whose own poll has just found new work: one immediate re-poll, so a final is
  // not held back by the floor, and only once, so this cannot become a burst.
  const urgentPoll = new Set();
  let draining = false;
  let monitorUnavailableSince, monitorError;
  const agentDirectory = record => path.join(config.stateDirectory, 'scoped', record.ownerId, record.agentId);
  const workspaceBaselineFile = record => path.join(agentDirectory(record), 'workspace-baseline.json');
  // The snapshot is started before the dispatch is written and saved after it without
  // being awaited, so git runs next to the dispatch instead of in front of it. It is
  // kept beside the agent's own state: the record body is saved on every poll and is
  // far too large to carry a file list.
  function startWorkspaceBaseline(record) {
    const taskId = record.task?.taskId;
    if (!taskId) return undefined;
    const pending = Promise.resolve()
      .then(() => captureFiles(record.workspace))
      .catch(() => ({ available: false, reason: 'capture-failed' }));
    return { taskId, pending };
  }

  async function saveWorkspaceBaseline(record, baseline) {
    if (!baseline) return;
    try {
      const capture = await baseline.pending;
      const file = workspaceBaselineFile(record);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ taskId: baseline.taskId, workspace: record.workspace,
        capturedAt: now(), capture }), 'utf8');
    } catch { /* best effort: a missing snapshot only costs coverage, never the task */ }
  }

  /**
   * Hand the snapshot write to the roster instead of the dispatching caller: git keeps
   * running while the target already has its task, and every reader waits on the map.
   * saveWorkspaceBaseline swallows its own errors, so these promises never reject.
   */
  function trackWorkspaceBaseline(record, baseline) {
    if (!baseline) return;
    const taskId = baseline.taskId;
    const write = saveWorkspaceBaseline(record, baseline)
      .finally(() => { if (baselineWrites.get(taskId) === write) baselineWrites.delete(taskId); });
    baselineWrites.set(taskId, write);
  }

  async function readWorkspaceBaseline(record) {
    try {
      const saved = JSON.parse(await readFile(workspaceBaselineFile(record), 'utf8'));
      return saved?.taskId === record.task?.taskId ? saved : undefined;
    } catch { return undefined; }
  }

  /**
   * The task's workspace changes, computed once its tree has settled. Anything that
   * keeps the comparison from being trustworthy is reported as coverage rather than
   * thrown, because the report itself must still be delivered.
   */
  async function workspaceDiff(record) {
    // The write outlives the dispatch that started it, so the file may still be missing.
    const pending = baselineWrites.get(record.task?.taskId);
    if (pending) await pending;
    const baseline = await readWorkspaceBaseline(record);
    if (!baseline) return { changes: [], coverage: workspaceCoverage('no-baseline') };
    if (baseline.capture?.available !== true) {
      return { changes: [], coverage: workspaceCoverage(baseline.capture?.reason ?? 'capture-failed') };
    }
    let after;
    try { after = await captureFiles(record.workspace); }
    catch { return { changes: [], coverage: workspaceCoverage('capture-failed') }; }
    if (after?.available !== true) return { changes: [], coverage: workspaceCoverage(after?.reason ?? 'capture-failed') };
    const changes = diffWorkspace(baseline.capture, after);
    // A clipped comparison is a coverage fact, so it rides with the other limits
    // instead of disappearing with the dropped paths.
    return { changes, coverage: workspaceCoverage(undefined, changes.truncated === true), ...(changes.truncated ? { truncated: true } : {}) };
  }
  const settings = record => ({ ...config, target: targetOf(record), workspace: record.workspace,
    stateDirectory: agentDirectory(record), codexThreadId: undefined, futureaideSessionId: undefined });
  const hostArgs = record => ({ ownerId: record.ownerId, agentId: record.agentId,
    sessionId: record.sessionId, workspace: record.workspace, treeProtocol: TREE_PROTOCOL, reportProtocol: REPORT_PROTOCOL,
    ...(record.task ? { taskId: record.task.taskId } : {}) });
  // Handles an adapter needs on the shared side: the target's own state in its own
  // row (never inside the record the shared layer will save again) and one host
  // lock per target application, reusing the existing lease table.
  const adapterDeps = record => {
    const load = () => store.get(record.agentId) ?? record;
    const target = targetOf(record);
    return {
      load,
      requestDirectory: () => agentDirectory(load()),
      readNativeState: () => store.backendState(record.agentId),
      writeNativeState: value => store.saveBackendState(record.agentId, value),
      withHostLock: (action, { key } = {}) => store.locked(`backend:${target}${key ? `:${key}` : ''}`, action),
      ensureCodexReports: () => beginCodexReports(record),
      readCodexReportState: () => readParentSubmissions(load()),
      ...(target === 'claude-cli' ? {
        readParentSubmissions: () => readParentSubmissions(load()),
        claudeReportConfig: requestId => ({ mcpServers: { futureaide: { type: 'stdio', command: process.execPath,
          args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url)), '--claude-cli-reports',
            store.location, record.agentId, load().task.taskId, requestId] } } }),
      } : {}),
      // The Codex probe reads its protocol readiness only; this must never start a
      // session, so it is the same read-only evidence status uses.
      readCodexReportStatus: () => readCodexReportStatus(record),
    };
  };
  // The chosen backend is rebuilt per operation from the live record, so a new
  // task id or state never hides behind a cached binding. Only the DSH client
  // (one authenticated connection per agent) is kept.
  async function backendFor(record) {
    if (operationBackends.has(record)) return operationBackends.get(record);
    const pending = resolveRecordBackend(record);
    operationBackends.set(record, pending);
    try { return await pending; }
    catch (error) { operationBackends.delete(record); throw error; }
  }
  async function resolveRecordBackend(record) {
    const target = targetOf(record);
    const load = () => store.get(record.agentId) ?? record;
    const deps = { ...adapterDeps(record), reuseObservation: true };
    if (target === 'dsh') {
      if (!clients.has(record.agentId)) clients.set(record.agentId, clientFactory(settings(record)));
      const client = clients.get(record.agentId);
      return resolveBackend(record, { target, load, deps, dsh: { client, requestDirectory: deps.requestDirectory,
        control: () => controlFactory(settings(load()), { client, managed: hostArgs(load()) }),
        hostArgs: () => hostArgs(load()) } });
    }
    return resolveBackend(record, { target, load, deps, adapters: backendAdapters, ...(backendAdapterLoader ? { adapterLoader: backendAdapterLoader } : {}) });
  }
  const forgetBackend = record => { clients.delete(record.agentId); operationBackends.delete(record); };
  // A target without a usable adapter is refused before the name is taken, and is
  // never answered by the DSH path instead. Pre-conditions that would only fail
  // later (unfinished protocols, a tool service that never came up) are settled
  // here too, so a broken name is never left in the roster.
  async function ensureTargetBackend(record) {
    const target = targetOf(record);
    if (target === 'dsh') return target;
    const deps = adapterDeps(record);
    const backend = await resolveBackend(record, { target, load: () => record, deps, adapters: backendAdapters,
      ...(backendAdapterLoader ? { adapterLoader: backendAdapterLoader } : {}) });
    const probe = await backend.probe();
    const required = backend.requiredMethods ?? probe.methods ?? [];
    const label = backend.labels?.host ?? hostLabel(record);
    if (!required.every(method => probe.methods?.includes(method))) {
      throw Object.assign(new Error(`${backend.labels?.bridge ?? `The ${label} backend`} needs this plugin version installed before subagents can be created.`), { code: 'managed-host-required' });
    }
    if (probe.treeProtocol !== TREE_PROTOCOL) throw treeProtocolError(label);
    if (probe.reportProtocol !== REPORT_PROTOCOL) throw reportProtocolError(label);
    // A Codex Desktop name is useless without its own ask/report tool surface, and
    // an online endpoint alone does not mean those tools are registered.
    if (target === 'codex-desktop') {
      const endpoint = await deps.ensureCodexReports();
      if (endpoint?.ready !== true) {
        const reason = endpoint?.reason ?? { code: 'codex-tools-not-registered' };
        throw Object.assign(new Error('The Codex Desktop tool service is not ready; no subagent was created.'),
          { code: reason.code ?? 'codex-tools-not-registered', detail: reason, registered: endpoint?.registered === true });
      }
    }
    return target;
  }

  async function context(extra) {
    // The owner comes from a verified caller (Codex chat metadata or a verified
    // Claude native session); owner ids are namespaced by source, so the same name
    // in two applications never collides.
    const caller = trustedCaller(extra);
    const ownerId = caller ? ownerIdForSource(caller.source, caller.nativeSessionId) : ownerIdFor(callingThread(extra));
    return store.saveOwner(await resolveCallingContext(extra,
      { knownOwner: store.owner(ownerId), callCodex: codexOwnerCall, nativeRequest, verifyClaude, bindOwner: bindClaude }));
  }
  /**
   * Records this owner can see: its own, plus every managed descendant that a
   * session beneath it created — including descendants on another application,
   * which have their own owner id. One tree, one state machine.
   */
  function visibleRecords(ownerId) {
    const own = store.list(ownerId);
    return { own, all: [...own, ...store.descendantsOf(own.map(record => record.agentId))] };
  }
  function named(owner, name) {
    // Addressable names are this chat's own, exactly as in 0.5.7: a descendant's name
    // belongs to the session that created it and never hijacks this chat's namespace.
    const record = store.named(owner.ownerId, assertName(name));
    if (!record) throw Object.assign(new Error(`No subagent named “${name}” exists in this chat.`), { code: 'agent-not-found' });
    return record;
  }

  /** A Claude caller is checked against the native registry before it becomes an owner. */
  async function verifyClaude(caller) {
    const session = await resolveNativeSession(caller.nativeSessionId,
      { ...(caller.workspace ? { workspace: caller.workspace } : {}) });
    return { pid: session?.pid, workspace: session?.cwd ?? session?.workspace ?? caller.workspace };
  }

  /**
   * Codex and Claude CLI explicit callbacks arrive through the shared submission queue. The
   * adapter surfaces them as its own questions/reports; the one state machine owns
   * delivery, so no second task or notice machine exists.
   */
  function readParentSubmissions(record) {
    if (!record?.task) return { questions: [], reports: [] };
    const pending = store.submissions(record.agentId, record.task.taskId);
    // Both lists carry the task they belong to: the Codex backend filters by taskId, so
    // a question without it would be dropped before the shared layer ever saw it.
    return {
      questions: pending.filter(item => item.kind === 'ask').map(item => ({ id: submissionRef(item.id),
        taskId: record.task.taskId, state: 'pending', message: item.message, createdAt: item.created })),
      reports: pending.filter(item => item.kind === 'report').map(item => ({ id: submissionRef(item.id),
        taskId: record.task.taskId, message: item.message, final: item.final, createdAt: item.created })),
    };
  }
  /**
   * Position of a record in the managed graph: root/child/grand. It comes from the
   * saved parentAgentId edges, never from a name lookup, so same-named records at
   * different depths are reported separately.
   */
  function managedPath(record) {
    const names = [];
    const seen = new Set();
    let current = record;
    while (current && !seen.has(current.agentId)) {
      seen.add(current.agentId);
      names.unshift(current.name);
      current = current.parentAgentId ? store.get(current.parentAgentId) : undefined;
    }
    return names.join('/');
  }

  /**
   * The one read-only registration probe: a trusted entry in this project's effective
   * config that points at the same DEV tree and roster, plus that entry's real MCP
   * tools/list — exactly what codex-host.probeCodexReportRegistration answers. It never
   * starts a Codex session and never sends a model turn, so sessionVerified stays false
   * until a real dispatch proves otherwise.
   *
   * A caller may inject its own probe (tests, a host that owns the check); otherwise the
   * default is codex-host's own function, imported lazily so only the Codex path ever
   * loads it. Either way it is asked about this record's workspace and this config file.
   */
  async function probeCodexRegistration(record) {
    const probe = typeof codexProbeRegistration === 'function' ? codexProbeRegistration : await defaultCodexProbe();
    if (typeof probe !== 'function') {
      return { ready: false, registered: false, sessionVerified: false,
        reason: { code: 'codex-tools-not-registered', message: 'This build has no Codex registration probe.' } };
    }
    try {
      return (await probe({ workspace: record?.workspace ?? config.workspace,
        configPath: config.configFile })) ?? undefined;
    } catch (error) { return { ready: false, registered: false, sessionVerified: false, reason: safeError(error) }; }
  }
  /** Read-only Codex tool registration, for status: it never starts a session. */
  async function readCodexToolsStatus(record) {
    const probed = await probeCodexRegistration(record);
    if (probed) return probed;
    if (typeof codexToolsStatus !== 'function') return { registered: false };
    try { return (await codexToolsStatus(record)) ?? { registered: false }; }
    catch (error) { return { registered: false, reason: safeError(error) }; }
  }
  /**
   * Read-only status for the Codex backend's own probe, which fills reportProtocol
   * from it. `registered` means this project's effective MCP registration points at the
   * DEV entry over this same roster and that entry's tools/list carries ask_parent and
   * report_parent — verified by reading, never by starting a Codex session and never by
   * an HTTP answer. The first real dispatch proves the integration in a real session.
   */
  async function readCodexReportStatus(record) {
    const value = await readCodexToolsStatus(record);
    const registered = provenRegistration(value);
    return { ...value, ready: registered, registered, evidence: value?.evidence ?? 'registration',
      sessionVerified: value?.sessionVerified === true };
  }
  /** Both tool names, proven by whichever evidence the adapter has. */
  function provenRegistration(value) {
    return value?.registered === true && Array.isArray(value.tools)
      && ['ask_parent', 'report_parent'].every(tool => value.tools.includes(tool));
  }
  function codexToolsDiagnostics(value) {
    const registered = provenRegistration(value);
    return { ready: registered, present: true, registered, evidence: value?.evidence ?? 'registration',
      ...(registered ? {} : { reason: value?.reason ?? { code: 'codex-tools-not-registered',
        message: 'The Codex-side ask/report registration was not verified for this project.' } }) };
  }
  async function beginCodexReports(record) {
    // Preflight is read-only registration verification only: the project's effective MCP
    // entry must be the DEV entry over this roster and list both tools. It must not
    // create or reuse a Codex session — the first dispatch is the real integration test,
    // and a zero-model create stays zero-model. The host probe is the one source of that
    // evidence; codexReportReady stays as a fallback for a host that supplies it instead.
    const probed = await probeCodexRegistration(record);
    if (probed) {
      const registered = provenRegistration(probed);
      return { ...probed, ready: registered && probed.ready !== false, registered,
        evidence: probed.evidence ?? 'registration', sessionVerified: probed.sessionVerified === true,
        ...(registered ? {} : { reason: probed.reason ?? { code: 'codex-tools-not-registered',
          message: 'The Codex-side ask/report registration was not verified for this project.' } }) };
    }
    if (typeof codexReportReady !== 'function') {
      return { ready: false, registered: false,
        reason: { code: 'codex-tools-not-registered', message: 'This build does not register the Codex-side ask/report tools yet.' } };
    }
    const value = (await codexReportReady(record, { phase: 'preflight' })) ?? {};
    const registered = provenRegistration(value);
    if (value.ready !== true || !registered) {
      return { ...value, ready: false, registered,
        reason: value.reason ?? { code: 'codex-tools-not-registered',
          message: 'The Codex-side ask/report registration is not verified for this project.' } };
    }
    return { ...value, ready: true, registered, evidence: value.evidence ?? 'registration' };
  }

  /**
   * Fold pending explicit submissions into the task: a report becomes a task
   * report, an ask becomes a pending question. Task changes and consumption commit
   * together; the durable submission remains readable by the Codex backend.
   */
  function absorbSubmissions(record) {
    const pending = store.pendingSubmissions(record.agentId, record.task.taskId);
    if (!pending.length) return;
    let changed = false;
    for (const item of pending) {
      changed = true;
      if (item.kind === 'report') {
        record.task.reports ??= [];
        if (!record.task.reports.some(report => report.id === submissionRef(item.id))) {
          record.task.reports.push({ id: submissionRef(item.id), taskId: record.task.taskId,
            message: item.message, final: item.final, createdAt: item.created, delivery: { state: 'pending' } });
        }
      } else {
        record.observation ??= {};
        record.observation.questions ??= [];
        if (!record.observation.questions.some(question => question.id === submissionRef(item.id))) {
          record.observation.questions.push({ id: submissionRef(item.id), state: 'pending', message: item.message });
        }
        record.state = 'awaiting_input';
      }
    }
    if (changed) store.saveAndConsumeSubmissions(record, pending.map(item => item.id));
  }
  async function withName(extra, name, action, options) {
    const owner = await context(extra);
    const record = named(owner, name);
    return store.locked(record.agentId, async () => {
      const fresh = store.get(record.agentId);
      if (!fresh || fresh.ownerId !== owner.ownerId) throw new Error('This subagent instance has already been removed.');
      return action(fresh, owner);
    }, options);
  }

  async function checkHost(record, { creation = false, taskTree = false } = {}) {
    const backend = await backendFor(record);
    const probe = await backend.probe();
    const target = targetOf(record);
    const stable = stableHost(probe.identity, target);
    const labels = backend.labels ?? {};
    const recorded = target === 'codex-desktop'
      ? (record.host?.application ? { application: record.host.application } : undefined)
      : record.host;
    if (recorded && JSON.stringify(recorded) !== JSON.stringify(stable)) {
      throw Object.assign(new Error(`The original ${labels.host ?? target} data store is not connected. The task was not sent to another host.`), { code: 'host-ownership-mismatch' });
    }
    if (creation || taskTree) {
      const required = backend.requiredMethods ?? probe.methods ?? [];
      if (!required.every(method => probe.methods?.includes(method))) {
        throw Object.assign(new Error(`${labels.bridge ?? `The ${target} backend`} needs this plugin version installed before subagents can be created.`), { code: 'managed-host-required' });
      }
      if (probe.treeProtocol !== TREE_PROTOCOL) throw treeProtocolError(labels.host ?? hostLabel(record));
      if (probe.reportProtocol !== REPORT_PROTOCOL) throw reportProtocolError(labels.host ?? hostLabel(record));
    }
    // Do not rewrite an existing Codex host row: its historical dataRoot is
    // irrelevant and is deliberately ignored rather than migrated.
    record.host ??= stable;
    return backend;
  }

  // DSH readiness for status, derived from the one host probe status already made.
  function dshDiagnostics(host, status) {
    if (!host) return { ready: false, connected: false, treeProtocol: null, reportProtocol: null,
      reason: safeError(status.hostError ?? { message: 'The DSH host is not reachable.' }) };
    const connected = status.dshConnected === true;
    // A host that renamed one of the internals this plugin borrows answers ping but
    // cannot run a task; saying which ones at status time is the whole point.
    const missingInternals = Array.isArray(host.compatibility?.missing) ? host.compatibility.missing : [];
    const entry = { ready: connected && host.treeProtocol === TREE_PROTOCOL && host.reportProtocol === REPORT_PROTOCOL
        && missingInternals.length === 0,
      connected, treeProtocol: host.treeProtocol ?? null, reportProtocol: host.reportProtocol ?? null,
      ...(connected ? {} : { missing: METHODS.filter(method => !host.methods?.includes(method)) }),
      ...(missingInternals.length ? { missingInternals } : {}) };
    if (!connected) entry.reason = { code: 'managed-host-required', message: 'Install the current managed DSH bridge.' };
    else if (entry.treeProtocol !== TREE_PROTOCOL) entry.reason = safeError(treeProtocolError());
    else if (entry.reportProtocol !== REPORT_PROTOCOL) entry.reason = safeError(reportProtocolError());
    else if (missingInternals.length) entry.reason = { code: 'dsh-internals-changed',
      message: `This DSH host no longer provides ${missingInternals.join(', ')}. Update the FutureAide Control plugin for this DSH version.` };
    return entry;
  }

  // Does this name still owe the shared monitor a poll? Sleeping names are driven
  // by the monitor's existing DSH host-state wake path instead.

  function needsPoll(record) {
    if (readOnlyTarget(record)) return false;
    if (record?.state === 'cleaning') return true;
    if (!record || record.closed || record.sleep) return false;
    if (ACTIVE.has(record.state)) return true;
    // The scan projection already carries both of these, so a roster sweep no longer
    // runs one supplement query per name. A record loaded whole has neither field
    // and takes the queries below.
    if (record.hasSupplement === true) return true;
    if (record.pendingReports !== undefined) return !record.callbackBlocked && record.pendingReports > 0;
    if (store.supplements(record.agentId).some(item => item.task === record.task?.taskId && item.status !== 'blocked')) return true;
    return !record.callbackBlocked
      && (record.task?.reports ?? []).some(report => !['delivered', 'blocked'].includes(report.delivery.state));
  }

  async function ensureMonitor() {
    try { return await startSharedMonitor(config, store); }
    catch (error) {
      monitorError = safeError(error);
      return false;
    }
  }

  // One monitor serves every name: this only makes sure it exists and, for a
  // sleeping name, clears the marker so the same durable task is polled again.
  /** Tell a listener in this process that a name now owes work. */
  function announceWork(agentId) { try { if (agentId) onWorkQueued(agentId); } catch { /* a hint is never worth failing a call for */ } }

  async function ensureWorker(record, { wake = false } = {}) {
    if (!record || readOnlyTarget(record)) return false;
    if (wake && record.sleep) {
      if (!await ensureMonitor()) {
        // Nothing can watch this installation right now. Keep the sleeping
        // baseline so a later call resumes the same task instead of losing it.
        store.setError(record.agentId, monitorError ?? { code: 'monitor-unavailable', message: 'The shared monitor could not start.' });
        return false;
      }
      store.wake(record.agentId, record.sleep.taskId);
      record = store.get(record.agentId) ?? record;
    }
    if (record.sleep) return true;
    if (!needsPoll(record)) return false;
    const ready = await ensureMonitor();
    if (!ready) store.setError(record.agentId, monitorError ?? { code: 'monitor-unavailable', message: 'The shared monitor could not start.' });
    // Only an explicit wake — new work arriving from outside — is news for the loop. A
    // poll also calls this, and announcing from there would make every poll re-hint its
    // own name and turn the loop into a self-feeding burst.
    else if (wake) announceWork(record.agentId);
    return ready;
  }

  /** The record's own backend observation, exactly as its host reported it. */
  async function observeOwn(record) {
    const backend = await checkHost(record);
    const observed = await backend.observe();
    if (observed.sessionId !== record.sessionId || (record.task && observed.taskId !== record.task.taskId)) {
      throw new Error('The host returned a different subagent task.');
    }
    if (record.task?.treeProtocol === TREE_PROTOCOL && !observed.tree) throw treeProtocolError(hostLabel(record));
    return observed;
  }

  /**
   * One view for the whole managed tree: the record's own native tree plus every
   * managed descendant's native tree, each child's native root hanging under the
   * parent's own node. Everything downstream (settled, public shape, changes,
   * coverage, finish gate, history snapshots, inspect) reads this view and nothing
   * else, so no interface grows its own tree logic.
   *
   * The root's questions and reports stay the root's own: a child's questions and
   * reports are delivered through that child's own state machine, never folded into
   * the root's report.
   */
  async function observe(record) {
    const own = await observeOwn(record);
    const keyOf = (agentId, native) => agentId === record.agentId ? native : `${agentId}:${native}`;
    const nodes = (own.tree?.nodes ?? []).map(node => ({ ...node,
      name: node.sessionId === record.sessionId ? record.name : node.name,
      backendKey: record.agentId, nativeSessionId: node.sessionId }));
    const managed = new Map([[record.agentId, { record, backend: await backendFor(record), rootKey: record.sessionId }]]);
    let settled = own.tree?.settled === true && !record.task?.cancelPending;
    let running = own.tree?.running === true || record.task?.cancelPending === true;
    for (const child of store.descendantsOf([record.agentId])) {
      const parentEntry = managed.get(child.parentAgentId);
      if (!parentEntry) continue;
      const parentKey = parentEntry.rootKey;
      const entry = { record: child, backend: undefined, view: undefined, rootKey: keyOf(child.agentId, child.sessionId) };
      managed.set(child.agentId, entry);
      // A child owns its adapter under its own operation lock. Reading its durable
      // observation never races its request/receipt writes or blocks this parent.
      const saved = child.observation;
      entry.view = saved?.sessionId === child.sessionId && saved?.taskId === child.task?.taskId
        ? saved : undefined;
      const childNodes = (entry.view?.tree?.nodes ?? []).filter(node => !node.archived
        && (!node.backendKey || node.backendKey === child.agentId));
      if (childNodes.length) {
        entry.rootKey = keyOf(child.agentId, child.sessionId);
        for (const node of childNodes) nodes.push({ ...node,
          sessionId: keyOf(child.agentId, node.sessionId),
          parentSessionId: node.parentSessionId ? keyOf(child.agentId, node.parentSessionId) : parentKey,
          name: node.sessionId === child.sessionId ? child.name : node.name,
          backendKey: child.agentId, nativeSessionId: node.sessionId });
      } else {
        // A managed child with no native tree of its own still belongs in the tree, so
        // an unfinished child can never let the parent settle early.
        nodes.push({ sessionId: entry.rootKey, parentSessionId: parentKey, name: child.name,
          status: child.closed ? 'closed' : child.state, activity: child.state, changes: [], coverage: 'Not observed',
          backendKey: child.agentId, nativeSessionId: child.sessionId, synthetic: true });
      }
      const pendingReports = (child.task?.reports ?? []).some(report => !terminalNotice(report.delivery));
      const pendingQuestions = (entry.view?.questions ?? []).some(question => question.state === 'pending');
      const busy = Boolean(child.task) && (pendingReports || pendingQuestions
        || ACTIVE.has(child.state) || child.state === 'cleanup_failed'
        || !['completed', 'failed', 'cancelled'].includes(child.task.state));
      const childSettled = !child.task
        ? true
        : entry.view?.capturedAt && !entry.view.stale && entry.view?.tree?.settled === true
          && entry.view?.tree?.running === false && !busy;
      settled = settled && childSettled;
      running = running || entry.view?.tree?.running === true || busy;
    }
    // Removed one-shot children remain part of this task's evidence. Live records
    // take precedence while cleanup is in progress or being retried.
    for (const entry of managed.values()) {
      const latest = store.get(entry.record.agentId);
      const snapshots = latest?.task?.taskId === entry.record.task?.taskId
        ? latest?.task?.childSnapshots : entry.record.task?.childSnapshots;
      for (const snapshot of snapshots ?? []) {
        if (managed.has(snapshot.agentId)) continue;
        const snapshotKey = native => `${snapshot.agentId}:${native}`;
        for (const node of snapshot.nodes ?? []) nodes.push({ ...node,
          sessionId: snapshotKey(node.sessionId),
          parentSessionId: node.parentSessionId ? snapshotKey(node.parentSessionId) : entry.rootKey,
          archived: true });
      }
    }
    const composed = { ...own, tree: { ...(own.tree ?? {}), nodes, settled, running } };
    composed.managed = managed;
    // Everything persisted stays plain data: backends and the managed map are live
    // objects and must never reach the roster.
    const { managed: _managed, ...storable } = composed;
    // Keep the stored observation when nothing but the capture moment moved. A poll that
    // observed the same tree used to rewrite the whole body and invalidate every cached
    // projection, which is most of what a quiet round cost. capturedAt therefore means
    // "when this observation last changed"; the live view returned below still carries
    // this round's stamp for the answer the caller gets.
    record.observation = captureObservation(record.observation, storable, now());
    record.error = undefined;
    return composed;
  }

  function hasModelRequest(input = {}) {
    return input.model !== undefined || input.effort !== undefined;
  }

  function selectionRequest(input = {}) {
    return {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
    };
  }

  // A Codex turn cannot change model or effort while it is running: turn/steer
  // only adds input to the live turn. This checks the shared state as well as the
  // last observation, so an async queue cannot slip a rejected selection through.
  function codexTurnRunning(record) {
    if (targetOf(record) !== 'codex-desktop' || !record.task) return false;
    if (['completed', 'cancelled', 'failed'].includes(record.task.state)) return false;
    return record.state === 'running' || record.task.state === 'running'
      || record.observation?.tree?.running === true;
  }

  function modelChangeRefused() {
    return Object.assign(new Error('Codex Desktop cannot change model or effort while a turn is running. Wait for the current turn to end, then send the new selection.'),
      { code: 'codex-model-change-while-running', terminal: true });
  }

  async function resolveRequestedPin(record, input) {
    const request = selectionRequest(input);
    if (request.model === undefined && !record.modelPin) {
      // Fail before a catalog read: an effort alone may only refine an already
      // explicit choice, never silently pin the host's current default.
      return resolveModelSelection({ groups: [] }, request, { pinned: record.modelPin });
    }
    const backend = await backendFor(record);
    return resolveModelSelection(await backend.models(), request, { pinned: record.modelPin });
  }

  /**
   * Confirm one DSH selection before its dispatch. Only a live host observation proves
   * what the session will use; a roster snapshot may have been migrated while asleep.
   * An observation that reports modelSelectionObserved:false carries a historical
   * value, stale exactly when the user changed the model in the UI without sending a
   * turn — then the real next-turn control is read instead. `sessionOnly` is set for
   * explicit pins and omitted for default-follow, which keeps the old DSH behavior.
   */
  async function confirmDshSelection(backend, target, dispatch, selection, observed, { sessionOnly = false } = {}) {
    const current = observed && observed.modelSelectionObserved !== false
      ? observed.currentModel
      : await backend.model();
    if (sameModelSelection(current, selection)) return;
    const selected = await backend.selectModel({ ...selection, requestId: `${dispatch.requestId}-model`,
      ...(sessionOnly ? { sessionOnly: true } : {}) });
    if (selected.accepted !== true) {
      throw Object.assign(new Error(`${backend.labels?.host ?? target} did not confirm the selected model.`),
        { code: 'model-selection-unconfirmed', uncertain: selected.status === 'unknown' });
    }
  }

  async function followHostModel(record, dispatch, observed) {
    if (dispatch.modelReady) return;
    const backend = await backendFor(record);
    const target = targetOf(record);
    const explicit = dispatch.explicitModel === true && dispatch.model !== undefined;
    if (explicit) {
      if (target === 'dsh') {
        await confirmDshSelection(backend, target, dispatch, dispatch.model, observed, { sessionOnly: true });
        record.model = { ...dispatch.model };
      }
      // Codex applies the model on its own turn/start. Calling its selectModel would
      // either fake a selection or touch the user's defaults, so it is never used.
      dispatch.modelReady = true;
      store.save(record);
      return;
    }
    if (target !== 'dsh') {
      // Native inheritance: read the actual model for display, but never select or
      // send one for a name that did not ask for an explicit selection.
      const current = observed && observed.modelSelectionObserved !== false && observed.currentModel
        ? observed.currentModel
        : await backend.model();
      dispatch.model = current ? { ...current } : undefined;
      if (current) record.model = { ...current };
      dispatch.modelReady = true;
      store.save(record);
      return;
    }
    // DSH default-follow keeps the old resolveModel and its catalog validation.
    if (!dispatch.model) {
      dispatch.model = resolveModel(await backend.models(), {});
      store.save(record);
    }
    await confirmDshSelection(backend, target, dispatch, dispatch.model, observed);
    record.model = { ...dispatch.model };
    dispatch.modelReady = true;
    store.save(record);
  }

  async function sendDispatch(record, message, kind = 'task', answerIds = [], requestId = uid('request'), observed, extra = {}) {
    const task = record.task;
    const baseline = Number.isSafeInteger(observed?.throughSeq)
      ? observed : await (await backendFor(record)).cursor();
    // `extra` is written with the dispatch, before the first save, so a reminder is
    // recognisable as one even if the process dies on the way to the native send.
    // The selection is frozen here: later pin changes must not rewrite an input that
    // is already queued or being recovered. `freezeModel` on a queued supplement
    // records that it had no pin when it was accepted, so a later pin cannot leak in.
    const { model: frozenModel, freezeModel, ...dispatchExtra } = extra;
    const selected = frozenModel !== undefined ? frozenModel
      : freezeModel === true ? undefined : record.modelPin;
    const dispatch = { requestId, message, kind, answerIds, state: 'sending', afterSeq: baseline.throughSeq, startedAt: now(),
      ...(selected ? { model: { ...selected }, explicitModel: true } : {}), ...dispatchExtra };
    task.dispatches.push(dispatch);
    record.state = 'running'; task.state = 'running';
    store.save(record); // The intent survives a caller or worker exiting during the write.
    await dispatchOnce(record, dispatch, observed);
    return dispatch;
  }

  async function dispatchOnce(record, dispatch, observed) {
    const current = store.get(record.agentId);
    if (current?.task?.taskId !== record.task?.taskId || current.closed || current.task.cancelRequested) return;
    if (dispatch.nextAttemptAt > Date.now()) return;
    let delivering = false;
    try {
      await followHostModel(record, dispatch, observed);
      // The model this request runs on is frozen with the dispatch, so a backend never
      // has to guess it from a catalog default that may have moved since the preflight.
      // Codex receives the model object only when the caller explicitly selected one;
      // every other turn keeps native inheritance and sends no model or effort.
      const backend = await backendFor(record);
      delivering = true;
      const explicit = dispatch.explicitModel === true && dispatch.model !== undefined;
      const sent = await backend.deliver({ requestId: dispatch.requestId,
        message: dispatch.message, kind: dispatch.kind,
        ...(explicit ? { model: dispatch.model, explicitModel: true } : { explicitModel: false }) });
      Object.assign(dispatch, { state: sent.accepted ? 'running' : sent.status ?? 'unknown', accepted: sent.accepted === true,
        afterSeq: sent.afterSeq ?? dispatch.afterSeq, ...(sent.accepted ? { error: undefined, nextAttemptAt: undefined } : {}) });
      if (sent.accepted === true && explicit && targetOf(record) === 'codex-desktop') {
        // The native turn now runs with the pinned model; record the real display value.
        record.model = { ...dispatch.model };
      }
      if (!sent.accepted && ['retryable', 'retrying'].includes(dispatch.state)) {
        dispatch.state = 'retrying'; deferRetry(dispatch);
      }
    } catch (error) {
      // A model request that cannot be resolved is a caller-visible refusal, never a
      // transient transport failure: retrying it would loop forever and hide the typo.
      const modelError = ['model-required', 'model-required-for-effort', 'model-not-found',
        'effort-not-supported', 'model-default-invalid', 'codex-model-change-while-running'].includes(error.code);
      const retryable = !modelError && (error.retryableRead === true
        || (targetOf(record) !== 'dsh' && (!delivering || error.code === 'agent-busy')));
      const state = error.terminal === true || modelError ? 'failed'
        : targetOf(record) !== 'dsh' && !delivering ? 'retrying'
          : error.uncertain ? 'unknown' : retryable ? 'retrying' : 'failed';
      Object.assign(dispatch, { state, afterSeq: error.afterSeq ?? dispatch.afterSeq, error: safeError(error) });
      if (dispatch.state === 'retrying' && targetOf(record) !== 'dsh') deferRetry(dispatch);
    }
    store.save(record);
    const latest = store.get(record.agentId);
    if (latest?.task?.taskId === record.task.taskId && latest.task.cancelRequested) {
      record.task.cancelRequested = true;
      record.task.cancelVerified = false;
      store.save(record);
      const result = await (await checkHost(record)).cancel();
      retainCancelError(record, result);
      if (result.cancelRequested === true) {
        store.confirmCancel(record, result);
        record.task.cancelVerified = true;
        record.task.cancelPending = result.cancelPending === true;
        store.save(record);
      }
    }
  }

  function deferRetry(value) {
    value.retryAttempts = (value.retryAttempts ?? 0) + 1;
    value.nextAttemptAt = Date.now() + retryDelayMs(value.retryAttempts);
  }

  function firstDispatchDeferred(record) {
    const dispatches = record.task?.dispatches ?? [];
    const first = dispatches[0];
    // A supplementary input's backoff must never stop observation or delivery
    // for work already admitted by the native session.
    return !record.task?.cancelRequested && dispatches.length === 1 && first.kind === 'task'
      && !first.accepted && first.state === 'retrying' && first.nextAttemptAt > Date.now();
  }

  // A native refusal is often a normal return value, not an exception. Keep its
  // bounded explanation with the cancellation intent so observe() cannot erase it.
  function retainCancelError(record, result) {
    const task = record.task;
    if (result.treeSettled === true) { task.cancelError = undefined; return; }
    const rounds = (result.cancelRounds ?? []).slice(-3);
    const refused = rounds.some(round => round.action === 'stop-tasks-unsupported'
      || (round.action === 'interrupt-root' && round.interrupted === false)
      || (round.detail ?? []).some(row => row.clicked === false));
    if (result.cancelRequested !== false && !refused) return;
    const details = rounds.map(round => ({ action: round.action,
      ...(round.reason ? { reason: compactText(String(round.reason), 200) } : {}),
      ...(round.status ? { status: round.status } : {}),
      ...(typeof round.clicked === 'number' ? { clicked: round.clicked } : {}),
      ...(typeof round.remaining === 'number' ? { remaining: round.remaining } : {}),
      ...(round.detail?.length ? { rows: round.detail.slice(0, 4).map(row => ({
        row: compactText(String(row.rowText ?? ''), 200), clicked: row.clicked === true, state: row.state,
        ...(row.error ? { error: { code: row.error.code ?? 'native-stop-refused',
          message: compactText(String(row.error.message ?? ''), 240) } } : {}),
      })) } : {}),
    }));
    task.cancelError = { code: result.cancelRequested === false ? 'native-cancel-unconfirmed' : 'native-cancel-partial',
      message: result.cancelRequested === false
        ? 'The native host has not accepted a stop. Cancellation remains pending and will retry.'
        : 'The native host refused part of the stop. Cancellation remains pending and will retry.',
      detail: { ...(result.reason ? { reason: compactText(String(result.reason), 200) } : {}), rounds: details } };
    if (targetOf(record) !== 'dsh') deferRetry(record);
    store.save(record);
  }

  const CODEX_PROFILE_MISSING = '当前 Codex 档案里看不到这个对话；报告正文已保留。请在 FAswitch 切回创建它的档案，或删除这个名称后重新派单；不会继续重试。';
  const terminalCodexOwnerError = error => error?.terminal === true || error?.code === 'codex-thread-not-found';
  function blockCodexNotice(record, notice, error) {
    notice.state = 'blocked';
    notice.error = { code: 'codex-thread-not-found', message: CODEX_PROFILE_MISSING };
    record.error = { code: 'codex-thread-not-found', message: CODEX_PROFILE_MISSING, detail: safeError(error) };
  }

  function blockUndelivered(notice, reason, message) {
    notice.state = 'blocked';
    notice.blockedAt = now();
    notice.error = { code: reason === 'expired' ? 'delivery-expired' : 'delivery-unconfirmed', message, reason };
  }

  const noticeAge = notice => Date.now() - Date.parse(notice.createdAt ?? '');
  const attemptAge = notice => Date.now() - Date.parse(notice.attemptedAt ?? notice.createdAt ?? '');

  /**
   * A Codex owner's notification marker sits in the first user message, which a
   * summary page already carries. Only when that is absent do we read the few
   * turns started (or still running) after the attempt, one turn at a time.
   * `complete` is false when the summary page was not the whole relevant window.
   */
  async function findCodexNotice(owner, notice, marker) {
    const summary = await readCodexOwnerTurns(owner.threadId, { limit: 30, itemsView: 'summary' }, { nativeRequest });
    if (JSON.stringify(summary).includes(marker)) return { delivered: true, complete: true };
    const attempted = Date.parse(notice.attemptedAt ?? notice.createdAt ?? '');
    const turns = Array.isArray(summary.data) ? summary.data : [];
    const started = turns.map(turn => Number(turn.startedAt) * 1000).filter(Number.isFinite);
    const oldest = started.length ? Math.min(...started) : undefined;
    const candidates = turns.filter(turn => {
      const start = Number(turn.startedAt) * 1000, end = Number(turn.completedAt) * 1000;
      return turn.status === 'inProgress'
        || (Number.isFinite(start) && start >= attempted - 5000)
        || (Number.isFinite(end) && end >= attempted - 5000);
    });
    const complete = (!summary.nextCursor || (Number.isFinite(attempted) && oldest !== undefined && attempted >= oldest))
      && candidates.length <= 5;
    let allItemsRead = true;
    for (const turn of candidates.slice(0, 5)) {
      if (typeof turn.id !== 'string') continue;
      let cursor;
      let pages = 0;
      while (true) {
        const page = await readCodexOwnerItems(owner.threadId, turn.id, { limit: 100,
          ...(cursor ? { cursor } : {}) }, { nativeRequest });
        if (JSON.stringify(page).includes(marker)) return { delivered: true, complete: true };
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
        pages++;
        if (!cursor) break;
        if (pages >= 5) { allItemsRead = false; break; }
      }
    }
    return { delivered: false, complete: complete && allItemsRead };
  }

  async function verifyOwner(owner) {
    const thread = threadFromResult(await codexOwnerCall(owner.threadId, 'read_thread', {
      threadId: owner.threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100,
    }));
    // Native RPC thread records do not carry app-tools' kind/hostId fields. The
    // stable ownership check is the exact chat id plus its local absolute cwd.
    if (thread?.id?.toLowerCase() !== owner.threadId
        || typeof thread.cwd !== 'string' || await realpath(thread.cwd) !== owner.workspace) {
      throw new Error('The original Codex chat project could not be re-verified.');
    }
  }

  function failureReason(record, view, finalDispatch) {
    const reason = [record.error?.message, finalDispatch?.failure?.message,
      finalDispatch?.error?.message, finalDispatch?.failure?.code, finalDispatch?.error?.code,
      rootSummary(view)?.reply].find(value => typeof value === 'string' && value.trim()) ?? '模型执行失败';
    // A generic message such as "model execution failed" says nothing on its own;
    // the stable code (QUOTA, a rate limit) is what the parent can act on.
    const code = [record.error?.code, finalDispatch?.failure?.code, finalDispatch?.error?.code]
      .find(value => typeof value === 'string' && value.trim());
    return compactText(code && !String(reason).includes(code) ? `${code}：${reason}` : String(reason), 200);
  }

  /**
   * One terminal failure notice per task. It rides the same owner delivery path
   * (and the same notice id/dedup) as reports, so a transient Codex/Claude outage
   * retries naturally and a delivered notice is never sent twice.
   */
  async function notifyFailure(record, terminal, view, finalDispatch) {
    const task = record.task;
    if (!task || terminal !== 'failed' || task.cancelRequested) return;
    const text = `${hostLabel(record)}「${record.name}」执行失败：${failureReason(record, view, finalDispatch)}`;
    task.reports ??= [];
    let failure = task.reports.find(report => report.failure === true);
    if (!failure) {
      failure = { id: `failure-${task.taskId}`, taskId: task.taskId, message: text, final: false,
        failure: true, createdAt: now(), delivery: { id: `failure-notice-${task.taskId}`, state: 'pending', createdAt: now() } };
      task.reports.push(failure);
    }
    await deliver(record, failure.delivery, failure.message);
  }

  async function deliver(record, notice, text) {
    if (notice.state === 'delivered') return;
    if (notice.state === 'blocked') return;
    // Only the report's own createdAt (or the notice's creation time) may date it.
    // An old row with no real timestamp is expired, never stamped with "now".
    if (!Number.isFinite(Date.parse(notice.createdAt ?? ''))) {
      blockUndelivered(notice, 'expired', 'This notice has no original creation time. Its body is kept and it was not sent.');
      store.save(record);
      return;
    }
    // A monitor restart can release many old rows at once. Never flood the chat:
    // anything older than six hours is terminal, and anything still unconfirmed
    // after thirty minutes stops waiting so later notices and new tasks can move.
    if (noticeAge(notice) >= EXPIRE_UNSENT_AFTER_MS) {
      blockUndelivered(notice, 'expired', 'This notice was created more than 6 hours ago and was never sent. Its body is kept.');
      store.save(record);
      return;
    }
    if (attemptAge(notice) >= UNCONFIRMED_AFTER_MS) {
      blockUndelivered(notice, 'unconfirmed', 'Delivery could not be confirmed within 30 minutes. Its body is kept.');
      store.save(record);
      return;
    }
    if (notice.nextAttemptAt && notice.nextAttemptAt > Date.now()) return;
    const owner = store.owner(record.ownerId);
    notice.id ??= uid('notice');
    notice.attempts = (notice.attempts ?? 0) + 1;
    notice.nextAttemptAt = Date.now() + retryDelayMs(notice.attempts);
    const marker = `<!-- futureaide-control:${notice.id} -->`;
    const claude = owner?.source === 'claude-desktop' || Boolean(owner?.nativeSessionId);
    // These exact legacy failures happened before sendClaude opened a socket. They
    // can resume; other unknown outcomes stay read-only.
    if (claude && notice.state === 'unknown' && claudeNeverWritten(notice)) notice.state = 'pending';
    if (notice.state === 'unknown' || notice.state === 'sending') {
      try {
        if (claude) {
          // The native receipt is the request id itself: our envelope uuid survives
          // as the queue/attachment/user uuid. Transcript text is truncated at 8k,
          // so a long report's trailing marker is never reliable — deliveries are.
          // The scan starts at this notice's own cursor, so a long parent chat is
          // never rescanned and a page boundary simply continues on the next poll.
          const settled = await findClaudeReceipt(await claudeNoticeBinding(owner), notice, claudeReadEvents);
          Object.assign(notice, settled
            ? { state: 'delivered', deliveredAt: now(), recovered: true, receipt: settled, error: undefined }
            : { state: 'unknown' });
        } else if (typeof nativeRequest === 'function') {
          const found = await findCodexNotice(owner, notice, marker);
          if (found.delivered) {
            Object.assign(notice, { state: 'delivered', deliveredAt: now(), recovered: true, error: undefined });
          } else if (found.complete && Date.now() - (Date.parse(notice.attemptedAt ?? notice.createdAt ?? '') || Date.now()) >= CONFIRM_ABSENCE_AFTER_MS && !notice.resendAttempted) {
            // The whole relevant turn window was read and the marker is absent.
            // Re-send exactly once; this is no longer a blind write.
            Object.assign(notice, { state: 'pending', resendAttempted: true, nextAttemptAt: undefined, error: undefined });
          } else notice.state = 'unknown';
        } else {
          // No debug port: the ordinary app-tools read remains the fallback.
          const history = await codexOwnerCall(owner.threadId, 'read_thread', {
            threadId: owner.threadId, turnLimit: 30, includeOutputs: true, maxOutputCharsPerItem: 100000,
          });
          if (!history?.isError && JSON.stringify(history).includes(marker)) {
            Object.assign(notice, { state: 'delivered', deliveredAt: now(), recovered: true, error: undefined });
          } else notice.state = 'unknown';
        }
      } catch (error) {
        if (terminalCodexOwnerError(error)) blockCodexNotice(record, notice, error);
        else notice.state = 'unknown';
      }
      store.save(record);
      return;
    }
    // A newly confirmed channel rejection must not rewrite an older ambiguous
    // delivery: the read-back branch above remains its only recovery path.
    if (record.callbackBlocked) { notice.state = 'blocked'; store.save(record); return; }
    try { await (claude ? claudeNoticeBinding(owner) : verifyOwner(owner)); }
    catch (error) {
      if (!claude && terminalCodexOwnerError(error)) blockCodexNotice(record, notice, error);
      else Object.assign(notice, { state: 'pending', error: safeError(error) });
      store.save(record);
      return;
    }
    // A previous attempt may have reached the desktop. Never send a second copy blindly.
    Object.assign(notice, { state: 'sending', attemptedAt: now() });
    store.save(record);
    try {
      if (claude) {
        // The Claude inbox answers 'written' when the channel accepted the text,
        // which is not that the session read it: stay unknown until the read-back
        // branch finds our request id in the native deliveries. A definite channel
        // failure stays 'pending'. The cached binding is reused; only a binding the
        // session outgrew is refreshed, and the parent session is never replaced.
        const binding = await claudeNoticeBinding(owner);
        // Remember where the transcript ends before writing: the receipt can only
        // appear after this point, so later polls start here instead of rescanning.
        notice.cursor = await transcriptCursor(binding).catch(() => undefined);
        const send = target => claudeSend(target, `${text}\n\n${marker}`, { requestId: claudeNoticeRequestId(notice.id) });
        const resend = async () => {
          const fresh = await refreshClaudeBinding(owner);
          notice.cursor = await transcriptCursor(fresh).catch(() => undefined);
          return send(fresh);
        };
        let sent;
        try { sent = await send(binding); }
        catch (error) {
          // A binding is refreshed only when the write provably failed before it
          // happened; a written/uncertain channel is never retried here.
          if (!claudeBindingStale(error)) throw error;
          sent = await resend();
        }
        // The pipe never opened, so nothing was written. A session that crashed leaves
        // its old record behind, and only a fresh lookup finds where it came back.
        if (sent?.status === 'failed') sent = await resend();
        if (sent?.status === 'failed') Object.assign(notice, { state: 'pending', error: { message: 'The Claude inbox rejected this notice before acceptance.' } });
        else Object.assign(notice, { state: 'unknown', error: undefined });
      } else {
        const result = await codexOwnerCall(owner.threadId, 'send_message_to_thread', { threadId: owner.threadId, prompt: `${text}\n\n${marker}` });
        const unavailable = result?.isError && JSON.stringify(result).includes('direct app-server input is not allowed for multi-agent v2 sub-agents');
        if (unavailable) record.callbackBlocked = true;
        Object.assign(notice, unavailable ? { state: 'blocked', error: { code: 'native-callback-unavailable' } } : result?.isError ? { state: 'pending', error: { message: 'The desktop rejected this notice before acceptance.' } }
          : { state: 'delivered', deliveredAt: now(), error: undefined });
      }
    } catch (error) {
      // sendClaude throws only before its write, and a session that cannot be found was
      // never written to, so a Claude notice that lands here can be sent again. A
      // Codex owner that disappeared with the profile is a terminal notice instead.
      if (!claude && terminalCodexOwnerError(error)) blockCodexNotice(record, notice, error);
      else Object.assign(notice, { state: claude ? 'pending' : 'unknown', error: safeError(error) });
    }
    store.save(record);
  }

  /**
   * Transport binding for the Claude session that owns this name. A saved binding
   * is re-validated natively by sendClaude/readClaudeEvents on every use, so the
   * normal path runs no discovery and no rebind, and a cold process resumes straight
   * from the roster.
   */
  async function claudeNoticeBinding(owner) {
    const cached = owner?.binding;
    if (cached?.socketPath && cached?.recordFile && cached?.transcriptFile) return cached;
    return refreshClaudeBinding(owner);
  }
  async function refreshClaudeBinding(owner) {
    if (!owner?.nativeSessionId) throw Object.assign(new Error('This owner has no native Claude session to answer.'),
      { code: 'callback-target-missing' });
    const wanted = String(owner.nativeSessionId).toLowerCase();
    const { sessions } = await claudeDiscover();
    const session = (sessions ?? []).find(item => String(item.sessionId).toLowerCase() === wanted);
    if (!session) throw Object.assign(new Error('The Claude session that owns this name is not running.'),
      { code: 'callback-target-missing' });
    // Same native session, same parent context: only the transport binding is
    // refreshed, never the conversation it belongs to.
    const binding = await claudeBind({ pid: session.pid, sessionId: session.sessionId, workspace: owner.workspace });
    store.saveOwner({ ...(store.owner(owner.ownerId) ?? owner), hostSessionId: owner.nativeSessionId, binding });
    store.rebindOwner(owner.ownerId, binding);
    return binding;
  }

  /**
   * What status may claim about the way back to this caller. A Claude session keeps
   * its id across a restart but not its process or pipe, so a saved binding proves
   * nothing until it matches the live record. The caller is verified here, which makes
   * this the moment to replace a binding it has outgrown.
   */
  async function returnChannel(owner) {
    if (!owner.nativeSessionId) return { returnChannel: 'chat-verified' };
    try {
      try { currentRecord(await claudeNoticeBinding(owner)); }
      catch (error) { if (!claudeBindingStale(error)) throw error; await refreshClaudeBinding(owner); }
      return { returnChannel: 'chat-verified' };
    } catch (error) { return { returnChannel: 'unavailable', returnChannelError: safeError(error) }; }
  }

  async function prepare(record) {
    const backend = await checkHost(record, { creation: true });
    store.save(record);
    const created = await backend.create();
    if (created.sessionId !== record.sessionId || created.modelRequestsStarted !== 0) throw new Error(`${backend.labels?.host ?? targetOf(record)} did not confirm the requested empty subagent.`);
    // An explicit pin is applied before the first input, without starting a turn.
    // DSH records it on the session; `sessionOnly` keeps it out of the user's global
    // default. Codex has no session-only select API: its adapter applies the pin on
    // the first turn/start, so the resolved ID is the display value until then.
    if (record.modelPin) {
      if (targetOf(record) === 'dsh') {
        if (!sameModelSelection(created.model, record.modelPin)) {
          const selected = await backend.selectModel({ ...record.modelPin,
            requestId: `${record.agentId}-model`, sessionOnly: true });
          if (selected.accepted !== true) {
            throw Object.assign(new Error(`${backend.labels?.host ?? targetOf(record)} did not confirm the selected model.`),
              { code: 'model-selection-unconfirmed', uncertain: selected.status === 'unknown' });
          }
        }
        record.model = { ...record.modelPin };
      }
      // Codex has no session-only select API: the resolved pin is reported by the
      // creation receipt, but its actualModel stays unobserved until the first turn.
    } else {
      // No explicit choice: keep the host's own model display and resolve the live
      // default only when the first input is sent.
      record.model = created.model;
    }
    record.created = true; record.state = 'idle'; record.error = undefined; store.save(record);
  }

  async function negotiateTree(record, force = false) {
    if (!force && record.task.treeProtocol === TREE_PROTOCOL && record.task.reportProtocol === REPORT_PROTOCOL) return;
    const backend = await checkHost(record, { taskTree: true });
    const after = record.task.dispatches[0]?.afterSeq;
    const started = await backend.beginTask({
      ...(Number.isSafeInteger(after) && after >= -1 ? { taskStartSeq: after } : {}) });
    if (started.treeProtocol !== TREE_PROTOCOL) throw treeProtocolError(hostLabel(record));
    if (started.reportProtocol !== REPORT_PROTOCOL) throw reportProtocolError(hostLabel(record));
    record.task.treeProtocol = TREE_PROTOCOL;
    record.task.reportProtocol = REPORT_PROTOCOL;
    store.save(record);
    return started;
  }

  async function beginTask(record) {
    const baseline = startWorkspaceBaseline(record);
    try {
      const observed = await negotiateTree(record, true);
      // A task freezes its selection at creation. The desktop first dispatch is
      // delayed through the worker queue, so reading the live pin here would let a
      // later change rewrite an input the caller had already accepted.
      const frozen = Object.prototype.hasOwnProperty.call(record.task, 'modelSelection')
        ? { model: record.task.modelSelection, freezeModel: true } : {};
      await sendDispatch(record, record.task.message, 'task', [], undefined, observed, frozen);
    } finally { trackWorkspaceBaseline(record, baseline); }
  }

  async function resolveAnswer(record, answer) {
    if (answer.questionIds) return;
    const result = await (await backendFor(record)).answer({ answerId: answer.answerId, message: answer.message });
    if (!result.consumedQuestionIds?.length) throw new Error('This subagent has no unanswered question.');
    answer.questionIds = result.consumedQuestionIds;
    answer.continuation = result.continuation ?? `主控回答：\n${answer.message}\n请继续完成原任务。`;
    store.save(record);
  }

  // DSH ends the asking turn inside ask_parent, and a headless CLI turn owns its
  // session until it exits, so both read the answer as their next turn. A Codex Desktop
  // helper keeps working after its question is recorded: its answer is sent at once
  // and the adapter steers it into the turn that is still running.
  const answersMidTurn = record => targetOf(record) === 'codex-desktop';

  /**
   * Send every resolved answer that has not gone out yet, joined into one input. The
   * last answer intent owns the selection frozen for that dispatch; an answer recorded
   * before the field existed keeps the old live-pin fallback.
   * @returns {Promise<object|undefined>} The dispatch, or undefined when nothing was due.
   */
  async function dispatchAnswers(record, view) {
    const task = record.task;
    const ready = (task.answers ?? []).filter(answer => !answer.dispatched && answer.questionIds);
    if (!ready.length || task.cancelRequested) return undefined;
    for (const answer of ready) answer.dispatched = true;
    const last = ready.at(-1);
    const frozen = Object.prototype.hasOwnProperty.call(last, 'modelSelection')
      ? { model: last.modelSelection, freezeModel: true } : {};
    return sendDispatch(record, ready.map(answer => answer.continuation).join('\n\n'), 'answer',
      ready.flatMap(answer => answer.questionIds), undefined, view, frozen);
  }

  /**
   * Close one name and everything created beneath it. Children go first: a child that
   * cannot be cleaned keeps the parent in cleanup_failed (still listed, still retryable)
   * instead of vanishing from the roster while its session survives. A child already in
   * cleanup_failed is retried too — closed is not the same as cleaned.
   */
  async function clearRecord(record, { autoClaimed = false } = {}) {
    requireWritableTarget(record);
    record.state = 'cleaning'; record.closed = true;
    if (!autoClaimed) store.save(record);
    try {
      for (const child of store.childrenOf(record.agentId)) {
        const current = store.get(child.agentId);
        if (!current || current.agentId === record.agentId) continue;
        const verdict = await store.locked(current.agentId, async () => {
          const fresh = store.get(current.agentId);
          return fresh ? clearRecord(fresh) : { deleted: true };
        }, { waitMs: 0 });
        if (verdict?.deleted !== true) {
          throw Object.assign(new Error(`The managed subagent “${current.name}” could not be cleaned; this name stays listed so cleanup can be retried.`),
            { code: verdict?.queued ? 'agent-busy' : 'child-cleanup-failed', child: current.name, childError: verdict?.error });
        }
      }
      if (record.lifetime === 'once' && record.parentAgentId) await keepChildSnapshot(record);
      if (!record.nativeDestroyed) {
        const backend = await checkHost(record);
        const result = await backend.destroy();
        if (result.destroyed !== true) throw new Error(result.message ?? `${backend.labels?.host ?? targetOf(record)} has not confirmed complete session cleanup.`);
        if (result.nativeSessionRetained !== undefined) record.nativeSessionRetained = result.nativeSessionRetained;
        record.nativeDestroyed = true; store.save(record);
      }
      const directory = agentDirectory(record);
      const root = path.resolve(config.stateDirectory, 'scoped');
      const relative = path.relative(root, path.resolve(directory));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The subagent state directory is outside its owned root.');
      try {
        const meta = await lstat(directory);
        if (meta.isSymbolicLink() || !meta.isDirectory()) throw new Error('The owned state path is not a plain directory.');
        const resolved = await realpath(directory);
        const actualRoot = await realpath(root);
        const actualRelative = path.relative(actualRoot, resolved);
        if (!actualRelative || actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) throw new Error('The state directory resolves outside its owned root.');
        await removeTree(directory, { recursive: true, force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      store.remove(record);
      forgetBackend(record);
      return { name: record.name, deleted: true, sessionDataRemoved: !record.nativeSessionRetained,
        ...(record.nativeSessionRetained !== undefined ? { nativeSessionRetained: record.nativeSessionRetained } : {}) };
    } catch (error) {
      const current = store.get(record.agentId);
      // An uncertain destroy is a write whose outcome is unknown, not a failed cleanup:
      // the host may already be finishing it. A busy or queued child makes the parent
      // wait the same way. Neither is reported as an error, or a queued cleanup would
      // be listed as failed.
      if (current && (error.uncertain === true || error.code === 'agent-busy')) {
        current.state = 'cleaning'; current.closed = true; current.error = safeError(error); deferRetry(current); store.save(current);
        return { name: record.name, deleted: false, queued: true, state: 'cleaning' };
      }
      if (current) { current.state = 'cleanup_failed'; current.closed = true; current.error = safeError(error); store.save(current); }
      return { name: record.name, deleted: false, state: 'cleanup_failed', error: safeError(error) };
    }
  }

  /**
   * Keep a one-shot child's terminal tree, files and history inside the parent's
   * current task snapshot, in the fields the task already has. No second state machine.
   */
  async function keepChildSnapshot(child) {
    const parent = store.get(child.parentAgentId);
    if (!parent?.task) return;
    const view = child.nativeDestroyed ? child.observation ?? {} : await observe(child);
    const nodes = [];
    for (const { node } of ownedTree(child, view).nodes) {
      const saved = { ...node };
      if (!saved.archivedHistory && !child.nativeDestroyed) {
        const backend = view.managed?.get(node.backendKey)?.backend ?? await backendFor(child);
        const page = await backend.history({ targetSessionId: node.nativeSessionId ?? node.sessionId,
          running: false, maxMessages: 100 });
        saved.archivedHistory = { messages: page.messages ?? [], hasMore: page.hasMore === true,
          ...(page.note ? { note: page.note } : {}) };
      }
      nodes.push(saved);
    }
    store.saveChildSnapshot(parent.agentId, parent.task.taskId,
      { agentId: child.agentId, taskId: child.task?.taskId, nodes });
  }

  // Only persisted report_parent calls may wake the parent chat.
  async function deliverReports(record) {
    let finalTerminal = true;
    for (const report of record.task.reports ?? []) {
      // Prefer the report's own time. An old fixture/report without one may use the
      // task's start time (still a real time); a truly timeless old notice expires.
      const reportCreated = report.createdAt ?? record.task?.startedAt;
      if (reportCreated) report.delivery.createdAt = reportCreated;
      if (report.failure) {
        await deliver(record, report.delivery, report.message);
        continue;
      }
      if (report.final && !report.treeSettledConfirmed) { finalTerminal = false; continue; }
      await deliver(record, report.delivery, `${hostLabel(record)}「${record.name}」${report.final ? '交付' : '汇报'}：\n${report.message}`);
      // An older non-final notice must never hold back the final report that
      // follows it. The final report itself still has to reach a terminal state.
      if (report.final && !terminalNotice(report.delivery)) finalTerminal = false;
    }
    return finalTerminal;
  }

  /**
   * The caller can only order the next task after reading the final report, so that
   * notice's native receipt is already in the transcript. Re-read it here instead of
   * waiting for the next 30-second delivery batch. Only a notice whose write outcome
   * is still ambiguous is re-read this way; delivered and blocked ones are untouched,
   * so no report is ever written twice.
   */
  async function settleDelivery(record) {
    for (const report of record.task?.reports ?? []) {
      const notice = report.delivery;
      if (notice && ['unknown', 'sending'].includes(notice.state)) notice.nextAttemptAt = undefined;
    }
    store.save(record);
    await deliverReports(record);
    const task = record.task;
    const final = (task?.reports ?? []).find(report => report.final);
    // The same finish gate a poll uses, so a settled report closes its task once.
    if (final?.treeSettledConfirmed && task.result
        && task.reports.filter(report => report.final).every(report => terminalNotice(report.delivery))) await finishDeliveredReport(record);
  }

  async function finishDeliveredReport(record) {
    const task = record.task;
    const current = store.get(record.agentId);
    if (current?.task?.taskId === task.taskId && current.task.cancelRequested) {
      task.cancelRequested = true;
      task.cancelPending = current.task.cancelPending === true;
    }
    if (task.cancelRequested && (!task.cancelVerified || task.cancelPending || !task.cancelTreeSettled)) {
      record.state = task.state = 'running';
      store.save(record);
      return publicResult(record);
    }
    task.state = task.cancelRequested ? 'cancelled' : task.result.state;
    task.finishedAt ??= now();
    const finalDelivered = task.reports.filter(report => report.final)
      .every(report => report.delivery.state === 'delivered');
    // A blocked final is a terminal delivery outcome, not a delivered report.
    // Keep the name, task body and notification for the parent; a persistent name
    // returns to idle so it can accept work, and a one-shot stays listed for delete.
    if (!finalDelivered) {
      record.state = 'idle';
      store.save(record);
      return publicResult(record);
    }
    if (record.lifetime === 'once' && task.state === 'completed' && finalDelivered) {
      if (store.claimAutoCleanup(record)) return clearRecord(record, { autoClaimed: true });
      const latest = store.get(record.agentId);
      if (latest?.task?.taskId === task.taskId && latest.task.cancelRequested) {
        task.cancelRequested = true;
        record.state = task.state = 'running';
        store.save(record);
        return publicResult(record);
      }
      if (store.supplementSummary(record.agentId, task.taskId).blocked) {
        record.state = 'supplement_blocked';
        store.save(record);
        return publicResult(record);
      }
      else return publicResult(latest ?? record);
    }
    record.state = task.state === 'completed' ? 'idle' : task.state;
    store.save(record);
    return publicResult(record);
  }

  async function finishReports(record, view) {
    const task = record.task;
    task.reports ??= [];
    for (const incoming of view.reports ?? []) {
      if (incoming.taskId !== task.taskId || typeof incoming.id !== 'string'
          || typeof incoming.message !== 'string' || !incoming.message.trim()
          || typeof incoming.final !== 'boolean') throw new Error('The bridge returned an invalid explicit report.');
      const previous = task.reports.find(report => report.id === incoming.id);
      if (previous) {
        if (previous.message !== incoming.message || previous.final !== incoming.final) throw new Error('A persisted report identity changed.');
      } else task.reports.push({ id: incoming.id, taskId: incoming.taskId, message: incoming.message,
        final: incoming.final, createdAt: incoming.createdAt, delivery: { id: 'report-' + incoming.id, state: 'pending',
          createdAt: incoming.createdAt ?? now() } });
    }
    const final = task.reports.find(report => report.final);
    if (final && treeSettled(record, view) && !(view.questions ?? []).some(question => question.state === 'pending')) final.treeSettledConfirmed = true;
    if (final && final.treeSettledConfirmed) {
      task.result = { state: task.cancelRequested || rootSummary(view)?.state === 'cancelled' ? 'cancelled' : task.state === 'failed' || rootSummary(view)?.state === 'failed' ? 'failed' : 'completed',
        reply: final.message, changes: attributedChanges(record, view), coverage: treeCoverage(record, view), tree: publicTree(record, view) };
      task.state = task.result.state;
    }
    // Persist the terminal outcome before delivery can succeed or become ambiguous.
    store.save(record);
    const delivered = await deliverReports(record);
    if (final && final.treeSettledConfirmed) {
      // Compared only after the tree settled and only once, because polls repeat this
      // block until delivery ends. The report never waits for git and a failed
      // comparison is coverage, not an error.
      if (!task.workspace) {
        task.workspace = await workspaceDiff(record);
        if (task.result) {
          task.result.changes = attributedChanges(record, view);
          task.result.coverage = treeCoverage(record, view);
        }
        store.save(record);
      }
      if (delivered) {
        if (final.delivery.state === 'blocked' && final.delivery.error?.code === 'codex-thread-not-found') {
          record.state = task.state = 'failed';
          record.error = final.delivery.error;
        } else return finishDeliveredReport(record);
      } else {
        record.state = record.callbackBlocked && ['failed', 'cancelled'].includes(task.result.state)
          && (!task.cancelRequested || (task.cancelVerified && task.cancelTreeSettled)) ? task.result.state : 'delivery_pending';
      }
    }
    store.save(record);
    return publicResult(record);
  }

  function waitForTree(record, view, summaryOnly = false) {
    record.state = record.task.state = 'running';
    record.observation = { ...view, activity: summaryOnly ? `Waiting for the top-level ${hostLabel(record)} summary` : `Waiting for the ${hostLabel(record)} task tree and notifications to settle` };
    store.save(record);
    return publicResult(record);
  }

  async function recoverDispatch(record, dispatch, { allowResend = true } = {}) {
    if (dispatch.accepted || !['sending', 'retrying', 'unknown'].includes(dispatch.state)) return;
    if (dispatch.nextAttemptAt > Date.now()) return;
    // The backend owns its own receipt format; undefined means this saved intent
    // never reached a native write.
    const receipt = await (await backendFor(record)).receipt({ requestId: dispatch.requestId });
    if (!receipt) {
      if (!['sending', 'retrying'].includes(dispatch.state)) return;
      // The receipt is written before entering the native send. No receipt means
      // this intent never reached that send; keep the exact request ID.
      if (!allowResend) return 'not-sent';
      await dispatchOnce(record, dispatch);
      return;
    }
    dispatch.afterSeq = receipt.afterSeq ?? dispatch.afterSeq;
    if (receipt.status === 'accepted') Object.assign(dispatch, { accepted: true, state: 'running', error: undefined, failure: undefined, nextAttemptAt: undefined, retryAttempts: undefined });
    if (receipt.status === 'rejected') dispatch.state = 'failed';
    if (receipt.status === 'retryable') {
      if (!allowResend) return 'not-sent';
      await dispatchOnce(record, dispatch);
    }
  }

  async function drainSupplements(record) {
    if (record.task.cancelRequested) store.blockQueued(record.agentId, record.task.taskId, 'task-cancelled');
    else if (record.task.reports?.some(report => report.final)) store.blockQueued(record.agentId, record.task.taskId, 'final-submitted');
    const sealed = record.task.cancelRequested || record.task.reports?.some(report => report.final);
    if (!sealed && (!(record.task.dispatches?.[0]?.accepted) || (record.task.answers ?? []).some(answer => !answer.dispatched))) return;
    for (const item of store.supplements(record.agentId)) {
      if (item.task !== record.task?.taskId) { store.setSupplement(item.requestId, 'blocked', 'task-changed'); continue; }
      if (item.status === 'blocked') continue;
      const current = store.get(record.agentId);
      if (!current || current.ownerId !== item.owner || current.sessionId !== item.session || current.task?.taskId !== item.task) {
        store.setSupplement(item.requestId, 'blocked', current?.task?.taskId !== item.task ? 'task-changed' : current?.task?.cancelRequested ? 'task-cancelled' : 'task-closed'); return;
      }
      const prior = record.task.dispatches.find(dispatch => dispatch.requestId === item.requestId);
      if (prior) {
        const recovered = await recoverDispatch(record, prior, { allowResend: false });
        if (recovered === 'not-sent') {
          const view = sealed ? undefined : await observe(record);
          if (sealed || (view.reports ?? []).some(report => report.final)) {
            store.setSupplement(item.requestId, 'blocked', record.task.cancelRequested ? 'task-cancelled' : 'final-submitted');
            prior.state = 'blocked';
            store.save(record);
            continue;
          }
          await dispatchOnce(record, prior);
        }
        if (!prior.accepted && prior.state !== 'failed' && Number.isSafeInteger(prior.afterSeq)) {
          const observed = await (await backendFor(record)).turn({ requestId: prior.requestId,
            afterSeq: prior.afterSeq, timeoutSeconds: 0, maxMessages: 100 });
          if (observed.state === 'ended' && observed.correlation === 'request-id') Object.assign(prior,
            { accepted: true, state: endedState(observed.completionReason), endSeq: observed.endSeq, error: undefined, nextAttemptAt: undefined, retryAttempts: undefined,
              failure: observed.failure ?? modelTurnError(observed.completionReason) });
        }
        store.save(record);
        if (prior.accepted) { store.setSupplement(item.requestId, 'accepted'); continue; }
        store.setSupplement(item.requestId, prior.state === 'failed' ? 'blocked' : 'unknown', prior.error?.code ?? (prior.state === 'failed' ? 'send-failed' : 'acceptance-unknown')); return;
      }
      const priorAnswer = (record.task.answers ?? []).find(answer => answer.answerId === item.requestId);
      if (priorAnswer && sealed) {
        store.setSupplement(item.requestId, priorAnswer.questionIds ? 'accepted' : 'unknown', priorAnswer.questionIds ? null : 'answer-confirmation-unknown');
        if (!priorAnswer.questionIds) return;
        continue;
      }
      if (current.closed || current.task.cancelRequested || ['cleaning','cleanup_failed','cancelled','failed','idle','delivery_pending'].includes(current.state)) {
        store.setSupplement(item.requestId, 'blocked', current.task.cancelRequested ? 'task-cancelled' : 'task-closed'); continue;
      }
      if (priorAnswer) {
        if (!priorAnswer.questionIds) await answerLocked(record, item.message, item.requestId,
          { modelSelection: item.selection ?? null });
        store.setSupplement(item.requestId, 'accepted');
        if (!priorAnswer.dispatched) return;
        continue;
      }
      const view = await observe(record);
      if ((view.reports ?? []).some(report => report.final)) { store.blockQueued(record.agentId, record.task.taskId, 'final-submitted'); store.setSupplement(item.requestId, 'blocked', 'final-submitted'); return; }
      // A headless CLI turn owns the session until it exits. Leave the input
      // in the shared queue so the next process can resume that same session.
      if (targetOf(record) === 'claude-cli' && view.running) return;
      // A queued input keeps the selection frozen when it was accepted. Do not
      // compare it with record.modelPin: that is the latest intended selection,
      // not the model of the turn currently running, and a later pin change must
      // not discard an earlier input. The Codex adapter checks the live thread's
      // real model/effort and refuses an incompatible turn itself; send() rejects
      // a new selection change while the turn is running at the entry.
      store.setSupplement(item.requestId, 'sending');
      if ((view.questions ?? []).some(question => question.state === 'pending')) {
        await answerLocked(record, item.message, item.requestId, { modelSelection: item.selection ?? null });
        store.setSupplement(item.requestId, 'accepted');
        return;
      } else {
        const dispatch = await sendDispatch(record, item.message, 'supplement', [], item.requestId, view,
          { model: item.selection, freezeModel: true });
        store.setSupplement(item.requestId, dispatch.accepted ? 'accepted' : dispatch.state === 'failed' ? 'blocked' : 'unknown', dispatch.accepted ? null : dispatch.error?.code ?? (dispatch.state === 'failed' ? 'send-failed' : 'acceptance-unknown'));
        if (!dispatch.accepted) return;
      }
    }
  }

  async function pollLocked(record) {
    if (readOnlyTarget(record)) return publicResult(record);
    if (record.nextAttemptAt > Date.now()) return publicResult(record);
    if (firstDispatchDeferred(record)) return publicResult(record);
    if (record.state === 'cleaning') return clearRecord(record);
    if (record.closed || record.state === 'cleanup_failed' || record.state === 'idle') return publicResult(record);
    const task = record.task;
    try {
      // Explicit ask/report that a Codex-side tool wrote into the shared queue join
      // the same task as questions/reports before anything else looks at them.
      if (task) absorbSubmissions(record);
      if (task?.cancelRequested && (!task.cancelVerified || task.cancelPending)) {
        const result = await (await checkHost(record)).cancel();
        retainCancelError(record, result);
        if (result.cancelRequested === true) {
          store.confirmCancel(record, result);
          task.cancelAccepted = true; task.cancelVerified = true;
          task.cancelPending = result.cancelPending === true;
          if (task.cancelPending) task.cancelTreeSettled = false;
          store.save(record);
        }
      }
      if (task && store.supplements(record.agentId).length) await drainSupplements(record);
      // Never migrate an automatic result into an explicit report or cleanup.
      if (task?.result && task.reportProtocol !== REPORT_PROTOCOL) {
        if (['sending', 'unknown'].includes(task.delivery?.state)) await deliver(record, task.delivery, '');
        task.legacyAutomaticResult = task.result;
        delete task.result; task.delivery = undefined;
        record.state = task.state = 'awaiting_report';
        store.save(record);
        return publicResult(record);
      }
      if (task?.reports?.length) {
        await deliverReports(record);
        const final = task.reports.find(report => report.final && report.treeSettledConfirmed);
        if (final && task.result && task.reports.filter(report => report.final).every(report => terminalNotice(report.delivery))
            && (!task.cancelRequested || (task.cancelVerified && task.cancelTreeSettled))) {
          return finishDeliveredReport(record);
        }
      }
      if (!record.created) { await prepare(record); return publicResult(record); }
      if (!task) return publicResult(record);
      if (!task.dispatches.length && !task.cancelRequested && !task.legacyAutomaticResult) {
        await beginTask(record);
        record.nextAttemptAt = undefined; record.retryAttempts = 0;
        if (task.dispatches[0]?.state === 'retrying' && task.dispatches[0].nextAttemptAt > Date.now()) return publicResult(record);
      }
      else await negotiateTree(record);
      for (const answer of task.answers ?? []) if (!answer.questionIds && !task.cancelRequested) await resolveAnswer(record, answer);
      const view = await observe(record);
      if (task.cancelRequested && task.cancelVerified && !view.running && treeSettled(record, view)) {
        task.cancelTreeSettled = true;
        task.cancelError = undefined;
        store.save(record);
      }
      // Persist and deliver explicit reports before inspecting older dispatches:
      // an ordinary history/read failure must not suppress an accepted report.
      const reported = await finishReports(record, view);
      if ((task.reports ?? []).some(report => report.final && report.treeSettledConfirmed)) return reported;
      // The helper that asked is still working: its answer must not wait for that turn
      // to end, or for a later question, before it is written into the conversation.
      if (answersMidTurn(record) && !(task.reports ?? []).some(report => report.final)) await dispatchAnswers(record, view);
      const unanswered = (view.questions ?? []).filter(question => question.state === 'pending');
      for (const question of unanswered) {
        task.questionNotices ??= {};
        const notice = task.questionNotices[question.id] ??= { state: 'pending', createdAt: now() };
        await deliver(record, notice,
          `${hostLabel(record)} 子代理「${record.name}」等待回答：\n${question.message}\n\n请调用 futureaide_answer_agent，name=${JSON.stringify(record.name)}，message 为回答正文。任务保持等待；无需文件、命令或内部编号。`);
      }
      for (const dispatch of task.dispatches) {
        if (['completed', 'cancelled', 'failed', 'blocked'].includes(dispatch.state)) continue;
        await recoverDispatch(record, dispatch);
        if (['completed', 'cancelled', 'failed', 'blocked'].includes(dispatch.state)) continue;
        if (dispatch.state === 'retrying' && dispatch.nextAttemptAt > Date.now()) continue;
        const result = await (await backendFor(record)).turn({ requestId: dispatch.requestId,
          ...(Number.isSafeInteger(dispatch.afterSeq) ? { afterSeq: dispatch.afterSeq } : {}), timeoutSeconds: 0, maxMessages: 100 });
        dispatch.afterSeq ??= result.afterSeq;
        if (result.state === 'ended' && (dispatch.accepted || result.correlation === 'request-id')) {
          Object.assign(dispatch, { state: endedState(result.completionReason), accepted: true, error: undefined, nextAttemptAt: undefined, retryAttempts: undefined,
            endSeq: result.endSeq, failure: result.failure ?? modelTurnError(result.completionReason) });
        }
      }
      // A reminder is best-effort: its own dispatch never decides how the task ended,
      // and an undecided outcome for it is not work the task is still waiting on. A
      // reminder that did arrive starts a turn, which view.running already reports.
      const outstanding = task.dispatches.some(dispatch => !['completed', 'cancelled', 'failed', 'blocked'].includes(dispatch.state)
        && !(dispatch.reminder && ['unknown', 'failed'].includes(dispatch.state)));
      if (task.cancelRequested && !view.running && treeSettled(record, view)) {
        for (const dispatch of task.dispatches) if (!['completed', 'cancelled', 'failed'].includes(dispatch.state)) dispatch.state = 'cancelled';
      } else if (outstanding || view.running || task.cancelRequested) {
        record.state = unanswered.length ? 'awaiting_input' : 'running';
        task.state = record.state;
        store.save(record);
        return await finishReports(record, view);
      }
      if (unanswered.length && !task.cancelRequested) {
        record.state = task.state = 'awaiting_input'; store.save(record); return await finishReports(record, view);
      }
      // Every other target reads its answer as the next turn, once this one has ended.
      if (await dispatchAnswers(record, view)) return publicResult(record);
      if (!treeSettled(record, view)) {
        waitForTree(record, view);
        return await finishReports(record, view);
      }
      // How the task ended is decided by its own dispatches; the reminder rides along.
      const finalDispatch = task.dispatches.filter(dispatch => !dispatch.reminder).at(-1);
      const terminal = task.cancelRequested || rootSummary(view)?.state === 'cancelled' ? 'cancelled'
        : rootSummary(view)?.state === 'failed' || finalDispatch?.state === 'failed' ? 'failed'
          : finalDispatch?.state === 'cancelled' ? 'cancelled' : undefined;
      // A turn that ends with the answer only in ordinary text leaves the caller with
      // nothing, so the agent is told once. The marker is persisted before the send:
      // a crash between the two sends nothing twice, and the reminder's own turn
      // decides the next state instead of this one settling the task.
      if (finalReminderDue({ terminal, task, view, target: targetOf(record), supplements: store.supplements(record.agentId) })) {
        task.finalReminder = 'sent';
        store.save(record);
        // A failed or undecided reminder is not the task's outcome: it is marked as a
        // reminder, so the next poll settles normally instead of failing the turn.
        await sendDispatch(record, FINAL_REPORT_REMINDER, 'supplement', [], undefined, view, { reminder: true });
        record.state = task.state = 'running';
        return publicResult(record);
      }
      record.state = task.state = terminal ?? 'awaiting_report';
      if (terminal === 'failed' && !task.cancelRequested) await notifyFailure(record, terminal, view, finalDispatch);
      return await finishReports(record, view);
    } catch (error) {
      // A missing thread after a profile switch is a terminal state, not a
      // transient transport failure: keep the exact error and stop polling it.
      const terminal = error.terminal === true;
      record.state = terminal ? 'failed' : record.task?.result ? 'delivery_pending' : 'reconnecting';
      record.error = safeError(error);
      if (terminal && record.task) {
        record.task.state = 'failed';
        if (!record.task.cancelRequested) {
          try { await notifyFailure(record, 'failed', record.observation ?? {}, undefined); }
          catch { /* the pending failure report is retried by the next scan */ }
        }
      }
      record.observation = { ...record.observation, stale: true };
      if (terminal) record.nextAttemptAt = undefined;
      else if (targetOf(record) !== 'dsh') deferRetry(record);
      forgetBackend(record);
      store.save(record);
      return publicResult(record);
    }
  }

  const service = {
    store,
    async status(extra) {
      const status = { toolsLoaded: true, contextVerified: false, dshConnected: false, returnChannel: 'not-checked' };
      let owner;
      try {
        owner = await context(extra);
        Object.assign(status, { contextVerified: true, workspace: owner.workspace, ...await returnChannel(owner),
          agents: typeof store.count === 'function' ? store.count(owner.ownerId) : store.list(owner.ownerId).length });
      } catch (error) { status.contextError = safeError(error); }
      let client, host;
      try {
        client = clientFactory(config);
        host = await client.hostStatus();
        status.dshConnected = METHODS.every(method => host.methods?.includes(method));
        status.treeProtocolReady = host.treeProtocol === TREE_PROTOCOL;
        status.reportProtocolReady = host.reportProtocol === REPORT_PROTOCOL;
        if (!status.dshConnected) status.hostError = { message: 'Install the current managed DSH bridge.' };
        else if (!status.treeProtocolReady) status.hostError = safeError(treeProtocolError());
      } catch (error) { status.hostError = safeError(error); }
      status.ready = status.contextVerified && status.returnChannel === 'chat-verified' && status.dshConnected
        && status.treeProtocolReady === true && status.reportProtocolReady === true;
      // Catalog probes do not reserve a name or start a model turn.
      const codexProbe = { agentId: 'agent-status-probe', ownerId: owner?.ownerId ?? 'status', name: 'status-probe',
        lifetime: 'once', target: 'codex-desktop', workspace: owner?.workspace ?? config.workspace,
        state: 'probing', createdAt: now(), updatedAt: now(), history: [] };
      const emptyCatalog = { models: [], defaultModel: null };
      const probeAdapter = record => diagnoseTarget(record.target, { adapters: backendAdapters,
        ...(backendAdapterLoader ? { adapterLoader: backendAdapterLoader } : {}), record, deps: adapterDeps(record) });
      const [dshModels, codexEntry, claudeEntry] = await Promise.all([
        host ? readStatusModels(() => controlFactory(config, { client }).models()) : emptyCatalog,
        probeAdapter(codexProbe),
        probeAdapter({ ...codexProbe, target: 'claude-cli' }),
      ]);
      status.backends = {
        dsh: { ...dshDiagnostics(host, status), ...dshModels },
        'codex-desktop': { ...emptyCatalog, ...codexEntry, ...(codexEntry.ready
          ? { ...codexToolsDiagnostics(await readCodexToolsStatus(codexProbe)), evidence: 'native-rpc' } : {}) },
        'claude-cli': { ...emptyCatalog, ...claudeEntry },
      };
      return status;
    },
    async create({ name, lifetime, target, model, effort }, extra) {
      assertName(name);
      if (!['once', 'persistent'].includes(lifetime)) throw new Error('lifetime must be once or persistent.');
      const backendTarget = normalizeTarget(target);
      const owner = await context(extra);
      // A cross-application call: when the caller is itself a managed Codex child, the
      // new name is its child and follows that owner tree. A verified Claude caller has
      // no Codex thread to look up — it owns its names flat, so it is never asked for one.
      const parent = trustedCaller(extra) ? undefined : store.agentForCodexThread(callingThread(extra));
      const record = { agentId: uid('agent'), ownerId: owner.ownerId, sessionId: uid('session-codex'), name, lifetime,
        target: backendTarget, workspace: owner.workspace, state: 'creating', createdAt: now(), updatedAt: now(), history: [],
        ...(parent ? { parentAgentId: parent.agentId } : {}) };
      await ensureTargetBackend(record);
      if (hasModelRequest({ model, effort })) {
        // Resolve against the live target catalog before the name exists, so a typo
        // creates nothing and a valid pin is part of the first durable record.
        record.modelPin = await resolveRequestedPin(record, { model, effort });
      }
      store.insert(record); // The database's (owner,name) constraint arbitrates parallel creation.
      return store.locked(record.agentId, async () => {
        if (!store.get(record.agentId)) throw new Error('This subagent was removed while it was being created.');
        try {
          await prepare(record);
          return { ...publicResult(record), created: true, modelRequestsStarted: 0,
            // A creation receipt reports the resolved pin even when the target has
            // no session-level selection API yet; list/wait still report only an
            // observed actual model.
            actualModel: actualModelName(record.model) ?? actualModelName(record.modelPin) };
        } catch (error) {
          record.state = 'reconnecting'; record.error = safeError(error); store.save(record); await ensureWorker(record);
          return { ...publicResult(record), created: false };
        }
      });
    },
    async send({ name, message, model, effort }, extra) {
      textMessage(message);
      const request = { model, effort };
      const wantsSelection = hasModelRequest(request);
      const supplementStates = new Set(['running', 'awaiting_input', 'awaiting_report', 'reconnecting']);
      let enteredOperation = false;
      const queued = (record, pin) => ({
        name: record.name, accepted: false, queued: true, state: record.state,
        // The receipt reports the full ID resolved for this input, not a stale
        // display value from before the pin changed.
        actualModel: actualModelName(pin) ?? actualModelName(record.model),
        ...(record.callbackBlocked ? { callbackError: { code: 'native-callback-unavailable', message: 'The desktop does not permit background reports to this native multi-agent v2 sub-agent.' } } : {}),
      });
      const persistPin = (record, pin) => {
        if (!wantsSelection) return;
        record.modelPin = { ...pin };
        store.save(record);
      };
      const queue = async (record, pin, { usePinnedModel = false, savePin = false } = {}) => {
        const requestId = uid('request');
        const previous = record.modelPin;
        if (savePin) record.modelPin = { ...pin };
        let changed;
        try {
          // With no explicit selection the SQL copies the live pin in the same
          // INSERT SELECT, so a poll's stale body cannot overwrite a newer value.
          changed = store.enqueueSupplement(record, requestId, message, pin ? { ...pin } : undefined,
            { ...(usePinnedModel ? { usePinnedModel: true } : {}), ...(savePin ? { saveRecord: true } : {}) });
        } catch (error) {
          if (savePin) record.modelPin = previous;
          throw error;
        }
        if (!changed) {
          if (savePin) record.modelPin = previous;
          throw Object.assign(new Error('The task changed, stopped or is no longer accepting supplements.'), { code: 'supplement-unavailable' });
        }
        await ensureWorker(store.get(record.agentId) ?? record, { wake: true });
        const current = store.get(record.agentId) ?? record;
        // The INSERT SELECT may have captured a newer live pin than this caller
        // read; report the selection actually frozen on the queued row.
        const frozen = store.supplements(record.agentId).find(item => item.requestId === requestId)?.selection;
        return queued(current, pin ?? frozen ?? current.modelPin);
      };
      // The no-wait path is only for a supplement that changes no selection: the
      // INSERT SELECT itself freezes the current pin. An explicit model/effort must
      // take the ordinary 10s lock so a poll cannot save an older body over modelPin.
      const enqueueWithoutWait = async record => {
        const fresh = store.get(record.agentId) ?? record;
        return queue(fresh, undefined, { usePinnedModel: true });
      };
      // Named so the busy retry below runs exactly this body against a fresh record.
      const operation = async record => {
        enteredOperation = true;
        requireWritableTarget(record);
        const closing = ['cleaning', 'cleanup_failed', 'creating', 'supplement_blocked'];
        if (record.closed || closing.includes(record.state)) throw new Error('This subagent is closing, has blocked supplements, or is not yet ready.');
        let previousReport;
        if (record.state === 'delivery_pending') {
          const prior = (record.task?.reports ?? []).filter(report => !report.failure).at(-1);
          previousReport = prior ? { delivered: prior.delivery.state === 'delivered',
            summary: compactText(prior.message, 299) } : undefined;
          await settleDelivery(record);
          // Settling a one-shot agent's final finishes its task and removes the name on
          // the spot, so the ordinary closing error applies instead of a new dispatch.
          if (record.closed || !store.get(record.agentId) || closing.includes(record.state)) throw new Error('This subagent is closing, has blocked supplements, or is not yet ready.');
          if (record.state === 'delivery_pending') {
            // The caller is demonstrably still here (it just called send). Stop
            // waiting for confirmation, keep the body, and let the new task start.
            for (const report of record.task?.reports ?? []) {
              if (!terminalNotice(report.delivery)) blockUndelivered(report.delivery, 'unconfirmed',
                'A new task was assigned before this report’s delivery was confirmed. Its body is kept.');
            }
            await settleDelivery(record);
            const latest = store.get(record.agentId);
            if (!latest || latest.closed || closing.includes(latest.state)) throw new Error('This subagent is closing, has blocked supplements, or is not yet ready.');
            record = latest;
          }
          const latest = store.get(record.agentId);
          if (latest) record = latest;
          if (previousReport) previousReport.delivered = previousReport.delivered === true
            || (record.task?.reports ?? []).filter(report => !report.failure).at(-1)?.delivery.state === 'delivered';
        }
        if (!record.created) throw new Error('This subagent is still connecting; check its list status before sending a task.');
        if (targetOf(record) === 'dsh') await checkHost(record);
        const stoppedTask = record.task && ['cancelled', 'failed'].includes(record.state);
        const pendingReports = (record.task?.reports ?? []).some(report => !terminalNotice(report.delivery));
        if (stoppedTask && (record.lifetime === 'once' || pendingReports)) throw new Error('This task stopped; delete the one-shot agent or wait for its submitted reports before reusing a persistent agent.');
        if (record.state !== 'idle' && !stoppedTask && record.task?.reports?.some(report => report.final)) throw new Error('The agent has submitted its final report; wait for delivery or explicitly delete the agent.');
        const existingQueued = !stoppedTask && store.supplements(record.agentId).some(item => item.task === record.task?.taskId && item.status !== 'blocked');
        // All rejections that must not touch the name are now past. Resolve a
        // requested substring to its real ID first, so an unknown model still lists
        // the catalog; only then decide whether a running Codex turn forbids a change.
        const resolvePin = async () => {
          if (!wantsSelection) return record.modelPin;
          const pin = await resolveRequestedPin(record, request);
          if (targetOf(record) === 'codex-desktop' && codexTurnRunning(record)
              && (!record.modelPin || !sameModelSelection(pin, record.modelPin))) {
            throw modelChangeRefused();
          }
          return pin;
        };
        if (existingQueued) {
          const pin = await resolvePin();
          // An explicit pin and its queued supplement commit in one transaction
          // before the worker can wake; no-selection input copies the live pin.
          return wantsSelection
            ? queue(record, pin, { savePin: true })
            : queue(record, undefined, { usePinnedModel: true });
        }
        if (record.task && ACTIVE.has(record.state)) {
          if (targetOf(record) !== 'dsh' || !record.task.dispatches.length) {
            const pin = await resolvePin();
            return wantsSelection
              ? queue(record, pin, { savePin: true })
              : queue(record, undefined, { usePinnedModel: true });
          }
          // DSH can switch on its next step. Observe first, so a final report or a
          // broken observation refuses the input before the pin is persisted.
          await negotiateTree(record);
          const view = await observe(record);
          if ((view.reports ?? []).some(report => report.final)) throw new Error('The agent has already submitted its final report.');
          const pin = await resolvePin();
          persistPin(record, pin);
          if ((view.questions ?? []).some(question => question.state === 'pending')) return answerLocked(record, message);
          await sendDispatch(record, message, 'supplement', [], undefined, view);
        } else {
          const pin = await resolvePin();
          persistPin(record, pin);
          if (record.task) store.appendHistory(record.agentId, { ...record.task, changes: attributedChanges(record, record.observation ?? {}),
            coverage: treeCoverage(record, record.observation ?? {}), tree: publicTree(record, record.observation ?? {}) });
          // finalReminder marks this task as one that may be reminded once when a turn
          // ends without a final report. Tasks created before this rule carry no
          // marker, so a sleeping awaiting_report from an older version stays quiet.
          // The selected model is frozen with the task: a desktop first dispatch is
          // delayed through the worker queue and must not read a later pin change.
          record.task = { taskId: uid('task'), message, state: 'starting', startedAt: now(), dispatches: [], answers: [],
            modelSelection: pin ? { ...pin } : null, finalReminder: 'armed' };
          record.state = 'running'; record.observation = undefined; record.error = undefined;
          record.nextAttemptAt = undefined; record.retryAttempts = 0; store.save(record);
          if (targetOf(record) !== 'dsh') {
            await ensureWorker(record, { wake: true });
            return { ...queued(record, pin), ...(previousReport ? { previousReport } : {}) };
          }
          try { await beginTask(record); }
          catch (error) { record.state = 'reconnecting'; record.error = safeError(error); store.save(record); }
        }
        await ensureWorker(record, { wake: true });
        const current = store.get(record.agentId) ?? record;
        const dispatch = record.task.dispatches.at(-1);
        const error = current.error ?? dispatch?.error;
        return { name: current.name, accepted: dispatch?.accepted === true, state: current.state,
          actualModel: actualModelName(current.model) ?? actualModelName(current.modelPin),
          ...(dispatch?.state === 'retrying' ? { retrying: true } : {}),
          ...(previousReport ? { previousReport } : {}),
          ...(error ? { error } : {}),
          ...(current.callbackBlocked ? { callbackError: { code: 'native-callback-unavailable', message: 'The desktop does not permit background reports to this native multi-agent v2 sub-agent.' } } : {}) };
      };
      try { return await withName(extra, name, operation, { waitMs: 0 }); } catch (error) {
        if (enteredOperation || error.code !== 'agent-busy') throw error;
        const owner = await context(extra);
        const record = requireWritableTarget(named(owner, name));
        if (wantsSelection) {
          // Resolve first: a missing ID must report the catalog, not a busy state.
          const pin = await resolveRequestedPin(record, request);
          if (targetOf(record) === 'codex-desktop' && codexTurnRunning(record)) {
            if (record.modelPin && sameModelSelection(pin, record.modelPin)) {
              // The active turn already runs this exact pin; this is an ordinary
              // supplement, not a selection change, so no lock or pin write is due.
              return queue(record, pin);
            }
            throw modelChangeRefused();
          }
          // DSH, or a Codex name between turns: take the normal 10s lock so the
          // pin is saved against the live body rather than a poll's stale snapshot.
          return withName(extra, name, operation);
        }
        // A poll holds this lock for one round only. A no-selection supplement keeps
        // the old no-wait durable queue; anything that starts a task should wait.
        if (record.state === 'delivery_pending' || !supplementStates.has(record.state)) {
          return withName(extra, name, operation);
        }
        return enqueueWithoutWait(record);
      }
    },
    /**
     * Create the name if it is new and send the task, in one call. An existing name
     * keeps its own application and lifetime, so a conflicting explicit value is
     * refused instead of quietly running the task on the wrong backend.
     */
    async run({ name, message, lifetime, target, model, effort } = {}, extra) {
      textMessage(message);
      const owner = await context(extra);
      const wanted = normalizeTarget(target);
      const createdLifetime = lifetime ?? 'once';
      if (!['once', 'persistent'].includes(createdLifetime)) throw new Error('lifetime must be once or persistent.');
      const sent = result => ({ state: result.state, accepted: result.accepted === true,
        actualModel: result.actualModel ?? null,
        ...(result.queued ? { queued: true } : {}), ...(result.retrying ? { retrying: true } : {}),
        ...(result.callbackError ? { callbackError: result.callbackError } : {}), ...(result.error ? { error: result.error } : {}) });
      const existing = name === undefined ? undefined : store.named(owner.ownerId, assertName(name));
      if (existing) {
        // send only says "closing, blocked or not ready"; a caller that picked this
        // name needs to know the name is on its way out rather than misbound.
        if (existing.closed || ['cleaning', 'cleanup_failed'].includes(existing.state)) {
          throw Object.assign(new Error(`The name “${existing.name}” is still being cleaned up. Wait until it leaves list, or use another name.`),
            { code: 'name-closing' });
        }
        const boundTarget = targetOf(existing);
        if (target !== undefined && wanted !== boundTarget) throw Object.assign(new Error(`The name “${existing.name}” is already bound to ${hostLabel(existing)}; it cannot run on ${TARGET_LABELS[wanted]}. Omit target to continue this name, or use another name.`), { code: 'target-conflict' });
        if (lifetime !== undefined && lifetime !== existing.lifetime) throw Object.assign(new Error(`The name “${existing.name}” is already a ${existing.lifetime} subagent; omit lifetime, pass ${existing.lifetime}, or use another name.`), { code: 'lifetime-conflict' });
        const result = await service.send({ name: existing.name, message, model, effort }, extra);
        return { name: existing.name, lifetime: existing.lifetime, ...(boundTarget !== 'dsh' ? { target: boundTarget } : {}), ...sent(result), reused: true };
      }
      let chosen = name === undefined ? undefined : assertName(name);
      if (chosen === undefined) {
        for (let attempt = 0; attempt < 5 && chosen === undefined; attempt++) {
          const candidate = `助手-${randomUUID().replaceAll('-', '').slice(0, 4)}`;
          if (!store.named(owner.ownerId, candidate)) chosen = candidate;
        }
        if (chosen === undefined) throw new Error('Could not generate an unused subagent name; pass one explicitly.');
      }
      const created = await service.create({ name: chosen, lifetime: createdLifetime, target: wanted, model, effort }, extra);
      // A failed creation keeps its own receipt: sending into a name that never
      // connected would report a delivery nobody is waiting for.
      if (created.created !== true || created.error) return created;
      try {
        const result = await service.send({ name: chosen, message, model, effort }, extra);
        return { name: chosen, lifetime: createdLifetime, ...(wanted !== 'dsh' ? { target: wanted } : {}), ...sent(result), created: true };
      } catch (error) {
        // The name exists now, so a thrown send would hide the name the caller must
        // use to continue; report the created name with the failure instead.
        const current = store.named(owner.ownerId, chosen);
        return { name: chosen, lifetime: createdLifetime, ...(wanted !== 'dsh' ? { target: wanted } : {}),
          created: true, state: current?.state ?? 'reconnecting', accepted: false,
          actualModel: actualModelName(current?.model) ?? actualModelName(current?.modelPin), error: safeError(error) };
      }
    },
    async answer({ name, message }, extra) {
      textMessage(message);
      return withName(extra, name, record => answerLocked(requireWritableTarget(record), message));
    },
    async list(extra) {
      const owner = await context(extra);
      // Own names only, each with its own composed tree; managed descendants appear
      // inside that tree, never as extra entries in this chat's list.
      for (const record of store.list(owner.ownerId)) await ensureWorker(record);
      const records = store.list(owner.ownerId);
      return { items: records.map(record => ({ ...publicResult(record),
        monitor: record.sleep ? (record.sleep.wakePending ? 'waking' : 'sleeping') : (monitorAlive(store) ? 'running' : 'stopped'),
        supplements: store.supplementSummary(record.agentId, record.task?.taskId ?? '') })), total: records.length };
    },
    async changes({ name, task = 0 }, extra) {
      return withName(extra, name, async record => {
        if (task !== 0) {
          const historical = store.historyFor(record.agentId, { limit: task }).at(-task);
          if (!historical) throw new Error('That earlier task is not available. Use 0 for the current or latest task.');
          return { name, task, message: historical.message, changes: historical.changes ?? historical.result?.changes ?? [],
            coverage: historical.coverage, tree: historical.tree ?? historical.result?.tree };
        }
        try { await observe(record); store.save(record); } catch (error) { record.error = safeError(error); }
        // A running task has no stored comparison yet, so it is computed for this
        // answer only: an unfinished task must not look like a query that changed it.
        const live = record.task && !record.task.workspace ? await workspaceDiff(record) : undefined;
        const changes = attributedChanges(record, record.observation ?? {});
        // The composed view already carries every managed descendant's attributed
        // changes under its own agentPath, so no second walk happens here.
        return { name, task: 0, changes: withWorkspaceChanges(changes, live, record.name),
          tree: publicTree(record, record.observation ?? {}),
          coverage: treeCoverage(record, record.observation ?? {}, live?.coverage),
          stale: Boolean(record.error || record.observation?.stale), ...(record.error ? { error: record.error } : {}) };
      });
    },
    async inspect({ name, maxMessages = 20 }, extra) {
      if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) throw new Error('Inspect between 1 and 100 messages per tree node.');
      return withName(extra, name, async record => {
        const view = await observe(record);
        store.save(record);
        // Newly created and historical idle leaf records need no execution
        // handshake just to read their own history.
        const inspectionView = ownedTree(record, view).nodes.length ? view : { ...view,
          tree: { ...view.tree, settled: false, nodes: [{ sessionId: record.sessionId, parentSessionId: null,
            status: view.status, activity: view.activity, changes: view.changes, coverage: view.coverage }] } };
        const tree = publicTree(record, inspectionView);
        const nodes = ownedTree(record, inspectionView).nodes;
        let rootHistory, rootError;
        // Every node — this record's own sessions and managed descendants on any
        // application — reads its history through the backend that owns it. The public
        // shape stays the existing tree.nodes[].messages/agentPath/depth; internal ids
        // and bindings never leave this loop.
        const backend = await backendFor(record);
        for (let index = 0; index < nodes.length; index++) {
          const { node } = nodes[index];
          if (node.archived) {
            const page = node.archivedHistory ?? { messages: [], hasMore: false };
            Object.assign(tree.nodes[index], { ...page, messages: page.messages.slice(-maxMessages),
              hasMore: page.hasMore || page.messages.length > maxMessages });
            continue;
          }
          const owner = node.backendKey && node.backendKey !== record.agentId ? view.managed?.get(node.backendKey) : undefined;
          const nodeBackend = backend;
          const targetSessionId = node.nativeSessionId ?? node.sessionId;
          if (node.synthetic && !owner?.view) { tree.nodes[index].status = tree.nodes[index].status ?? node.status; continue; }
          try {
            const dispatch = node.sessionId === record.sessionId ? record.task?.dispatches?.at(-1) : undefined;
            // Upgrade old failed records from this inspection's own page, and only
            // when it contains this task's original request. The backend reads its
            // own native history: no target format is parsed in this shared layer.
            const upgrade = dispatch?.state === 'failed' && !dispatch.failure;
            const request = { targetSessionId, running: node.status === 'running',
              maxMessages, ...(upgrade ? { requestId: dispatch.requestId, afterSeq: dispatch.afterSeq ?? -1 } : {}) };
            const page = owner ? await store.locked(owner.record.agentId, async () => {
              const child = store.get(owner.record.agentId);
              if (!child) throw Object.assign(new Error('This child finished; inspect the refreshed tree.'), { code: 'agent-removed' });
              return (await backendFor(child)).history(request);
            }, { waitMs: 0 }) : await nodeBackend.history(request);
            if (!Array.isArray(page?.messages)) throw Object.assign(new Error(`${nodeBackend.labels?.bridge ?? `The ${targetOf(record)} backend`} returned invalid session history.`), { code: 'invalid-response' });
            if (upgrade && page.failure) { dispatch.failure = page.failure; store.save(record); }
            const selected = { messages: page.messages, hasMore: page.hasMore === true,
              ...(page.note ? { note: page.note } : {}) };
            Object.assign(tree.nodes[index], selected);
            if (node.sessionId === record.sessionId) rootHistory = selected;
          } catch (error) {
            tree.nodes[index].error = safeError(error);
            if (node.sessionId === record.sessionId) rootError = safeError(error);
          }
        }
        return { ...publicResult(record), ...(rootHistory ?? {}), ...(rootError ? { error: rootError } : {}),
          reports: { ...publicResult(record).reports, items: (record.task?.reports ?? []).map(report => ({ message: report.message, final: report.final, delivery: report.delivery.state })) },
          tree,
          inspectionIncomplete: tree.nodes.some(node => node.error !== undefined),
          historyCount: store.historyCount(record.agentId),
          history: store.historyFor(record.agentId, { limit: 20 }).reverse().map((task, index) => ({ task: index + 1, message: compactText(task.message, 240),
            state: task.state, startedAt: task.startedAt, finishedAt: task.finishedAt })) };
      });
    },
    async cancel({ name }, extra) {
      const owner = await context(extra);
      const record = requireWritableTarget(named(owner, name));
      if (!record.task || record.closed) return { name, accepted: false, state: record.state };
      if (!store.requestCancel(record)) return { name, accepted: false, state: store.get(record.agentId)?.state ?? 'removed' };
      if (targetOf(record) !== 'dsh') {
        for (const child of store.descendantsOf([record.agentId])) {
          if (!readOnlyTarget(child) && !child.closed && child.task && store.requestCancel(child)) await ensureWorker(store.get(child.agentId), { wake: true });
        }
        await ensureWorker(store.get(record.agentId), { wake: true });
        return { name, accepted: false, queued: true, state: 'cancelling' };
      }
      try {
        const result = await (await checkHost(record)).cancel();
        if (result.cancelRequested === true) store.confirmCancel(record, result);
        // Descendants on any application stop with their parent; each keeps its own
        // record and report, so nothing is dropped from the tree.
        for (const child of store.descendantsOf([record.agentId])) {
          if (readOnlyTarget(child) || child.closed || !child.task) continue;
          if (targetOf(child) !== 'dsh') {
            if (store.requestCancel(child)) await ensureWorker(store.get(child.agentId), { wake: true });
            continue;
          }
          try {
            await store.locked(child.agentId, async () => {
              const current = store.get(child.agentId);
              if (!current || current.closed || !store.requestCancel(current)) return;
              const cancelled = await (await checkHost(current)).cancel();
              if (cancelled.cancelRequested === true) store.confirmCancel(current, cancelled);
            });
          } catch { /* its own poll reports the failure on that record. */ }
        }
        return { name, accepted: result.cancelRequested === true, state: 'cancelling' };
      } finally {
        const current = store.get(record.agentId);
        if (current?.task?.taskId === record.task.taskId) await ensureWorker(current);
      }
    },
    async delete({ name }, extra) {
      const owner = await context(extra);
      const record = requireWritableTarget(named(owner, name));
      if (targetOf(record) === 'dsh') {
        const result = await withName(extra, name, current => clearRecord(current));
        if (result.queued) await ensureWorker(store.get(record.agentId), { wake: true });
        return result;
      }
      const queued = store.requestCleanup(record);
      if (queued) await ensureWorker(store.get(record.agentId), { wake: true });
      return { name, deleted: false, queued, state: queued ? 'cleaning' : 'removed',
        ...(targetOf(record) === 'claude-cli' ? { nativeHistoryPolicy: 'retain' } : {}) };
    },
    /**
     * Explicit ask/report from a managed Codex Desktop child, called from that
     * child's own chat. The caller is found from its chat metadata (never a tool
     * argument) through the binding its backend recorded, and the submission joins
     * the same task so the one state machine delivers it to the parent.
     */
    async submitToParent({ kind, message, final = false }, extra) {
      textMessage(message);
      if (!['ask', 'report'].includes(kind)) throw new Error('kind must be ask or report.');
      const threadId = callingThread(extra);
      const bound = store.agentForCodexThread(threadId);
      const receipt = store.submitParentMessage(bound?.agentId, { kind, message, final });
      await ensureWorker(store.get(bound.agentId), { wake: true });
      return receipt;
    },
    async wait({ names, timeoutSeconds = 0 } = {}, extra) {
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 45) throw new Error('Wait between 0 and 45 seconds.');
      const owner = await context(extra);
      if (names) names.forEach(assertName);
      const available = store.list(owner.ownerId);
      const selected = available.filter(record => !names || names.includes(record.name));
      const selectedIds = selected.map(record => record.agentId);
      const notListed = new Set((names ?? []).filter(name => !available.some(record => record.name === name)));
      const deadline = Date.now() + timeoutSeconds * 1000;
      let items;
      do {
        items = [];
        for (const id of selectedIds) {
          const record = store.get(id);
          if (!record) { notListed.add(selected.find(item => item.agentId === id).name); continue; }
          items.push(publicResult(record, { fullResult: true }));
        }
        if (!selectedIds.length || notListed.size || items.some(item => item.error || ['awaiting_input', 'awaiting_report', 'cancelled', 'idle', 'delivery_pending', 'cleanup_failed', 'failed'].includes(item.state))) break;
        if (Date.now() >= deadline) break;
        await wait(Math.min(250, deadline - Date.now()));
      } while (true);
      return { items, notListed: [...notListed],
        ...(notListed.size ? { note: 'These names are not in this chat’s current list. Absence alone does not prove task completion; use the delivered result.' } : {}),
        timedOut: Date.now() >= deadline && items.some(item => item.state === 'running') };
    },
    poll(agentId) {
      if (inflight.has(agentId)) return inflight.get(agentId);
      if (draining) return Promise.resolve({ draining: true });
      let beforeUpdatedAt, afterUpdatedAt;
      const work = store.locked(agentId, async () => {
        const record = store.get(agentId);
        beforeUpdatedAt = record?.updatedAt;
        const result = record ? await pollLocked(record) : { removed: true };
        afterUpdatedAt = record?.updatedAt;
        return result;
      }, { waitMs: 0 })
        .finally(() => {
          inflight.delete(agentId);
          // A quiet poll must not wake the loop; a poll that wrote durable state may
          // have found work, exactly as the original wake contract intended.
          if (afterUpdatedAt !== beforeUpdatedAt) onPollComplete();
        });
      inflight.set(agentId, work);
      return work;
    },
    async resume() {
      const records = typeof store.listWorkerCandidates === 'function' ? store.listWorkerCandidates() : store.list();
      const pending = records.filter(record => record.sleep?.wakePending === true || needsPoll(record));
      if (!pending.length) return;
      if (await ensureMonitor()) return;
      // One listener serves every name: record the failure on each waiting name
      // instead of starting a process per agent.
      for (const record of pending) {
        store.setError(record.agentId, monitorError ?? { code: 'monitor-unavailable', message: 'The shared monitor could not start.' });
      }
    },
    // One shared round: poll every name that still owes work through the same
    // state machine. The shared monitor calls this each round, and the degraded
    // in-process sweep below reuses it when no monitor can be started.
    async monitorScan({ only = null, fresh = null, sweep = true, force = false, deferred = [] } = {}) {
      if (draining) return inflight.size > 0 || monitorInflight.size > 0;
      const wanted = new Set(only ?? []);
      // Only a real hint — a file event or work queued in this process — may skip a
      // name's own one-second floor. A name that merely owes fast work is polled again
      // as soon as the floor allows, not on every round: otherwise every completion
      // signals another round and the loop spins at ten rounds a second.
      const hints = new Set(fresh ?? []);
      // A round that was pointed at particular names does not pay for the roster
      // sweep; the last sweep is at most SWEEP_MS old, and every name it would have
      // found is polled by the sweep that follows.
      if (!sweep && !wanted.size) return inflight.size > 0 || monitorInflight.size > 0;
      const candidates = sweep && typeof store.listWorkerCandidates === 'function' ? store.listWorkerCandidates() : [];
      const queue = candidates.map(candidate => ({ agentId: candidate.agentId, candidate }));
      const seen = new Set(queue.map(item => item.agentId));
      for (const agentId of wanted) if (!seen.has(agentId)) queue.push({ agentId, candidate: undefined });
      let busy = inflight.size > 0 || monitorInflight.size > 0;
      for (const { agentId, candidate } of queue) {
        const hinted = hints.has(agentId);
        // A hint is news about that name, so it is polled even if its own last poll
        // just finished; the ordinary 1s floor still applies to the sweep.
        if (!needsPoll(candidate ?? store.get(agentId))) { fastPoll.delete(agentId); continue; }
        busy = true;
        // A poll already in flight cannot take this hint: hand it back so the round
        // after that poll ends still knows the name moved, instead of waiting for the
        // next sweep.
        // Re-queueing a name that is merely in the fast set would hand it back as a
        // hint for ever, so only a real hint is deferred.
        if (monitorInflight.has(agentId)) { if (hints.has(agentId)) deferred.push(agentId); continue; }
        if (!hinted && !urgentPoll.has(agentId) && nextPollAt.get(agentId) > Date.now()) continue;
        if (candidate) {
          if (owesFastPoll(candidate)) fastPoll.add(agentId); else fastPoll.delete(agentId);
        }
        const candidateNextAt = Math.max(candidate?.nextAttemptAt ?? 0, candidate?.noticeNextAt ?? 0);
        if (!hinted && !urgentPoll.has(agentId) && !force && candidateNextAt > Date.now()) continue;
        // Large retained histories must not turn resolved-promise polls into a
        // single uninterrupted CPU burst that starves the shared HTTP listener.
        await yieldToIO();
        if (draining) break;
        const record = store.get(agentId);
        if (!record || !needsPoll(record)) { fastPoll.delete(agentId); continue; }
        if (owesFastPoll(record)) fastPoll.add(record.agentId); else fastPoll.delete(record.agentId);
        busy = true;
        if (monitorInflight.has(record.agentId)) { if (hints.has(agentId)) deferred.push(agentId); continue; }
        const urgent = urgentPoll.delete(record.agentId);
        if (!hinted && !urgent && !force && nextPollAt.get(record.agentId) > Date.now()) continue;
        if (firstDispatchDeferred(record)) continue;
        if (!hinted && !urgent && !force && record.nextAttemptAt > Date.now()) continue;
        let becameFast = false;
        const work = service.poll(record.agentId)
          // The record this poll was scheduled from is already stale: the poll is what
          // found the report. Deciding again on what the poll just wrote is what keeps a
          // final from waiting out the five-second sweep — a brand new report or question
          // has no nextAttemptAt yet, so the name becomes fast here and is polled again on
          // the next round (250ms floor) until delivery starts or the tree settles.
          .then(() => {
            const latest = store.get(record.agentId);
            if (!latest) { fastPoll.delete(record.agentId); return; }
            // Only something the poll itself just found is worth waking the loop for;
            // a poll that changed nothing must not start another round.
            const before = fastPoll.has(record.agentId);
            if (owesFastPoll(latest)) fastPoll.add(record.agentId); else fastPoll.delete(record.agentId);
            if (!before && fastPoll.has(record.agentId)) { becameFast = true; urgentPoll.add(record.agentId); }
          })
          .then(() => service.trySleep(record.agentId))
          .catch(() => { /* The next round retries from durable state. */ })
          .finally(() => {
            monitorInflight.delete(record.agentId);
            if (store.get(record.agentId)) nextPollAt.set(record.agentId, Date.now() + 1000);
            else nextPollAt.delete(record.agentId);
            // A poll that found nothing new is not news: waking the loop for it is what
            // turns "one round per second" into a self-feeding burst.
            if (becameFast) onPollComplete();
          });
        monitorInflight.set(record.agentId, work);
      }
      return busy;
    },
    async drainPolls() {
      draining = true;
      await Promise.allSettled([...monitorInflight.values(), ...inflight.values()]);
      // A baseline write survives the poll that started it; a shutdown that only waited
      // for polls could close the database with half a snapshot still being written.
      while (baselineWrites.size) await Promise.allSettled([...baselineWrites.values()]);
    },
    async ensureIdleMonitor() {
      const records = typeof store.listWorkerCandidates === 'function' ? store.listWorkerCandidates() : store.list();
      const pending = records.some(record => record.sleep?.wakePending === true || needsPoll(record));
      if (!store.hasSleeping() && !pending) { monitorUnavailableSince = undefined; return false; }
      let ready = false;
      try { ready = await startSharedMonitor(config, store); } catch { ready = false; }
      if (ready) { monitorUnavailableSince = undefined; return true; }
      monitorUnavailableSince ??= Date.now();
      if (Date.now() - monitorUnavailableSince >= monitorFailureGraceMs) {
        // Degraded mode: sweep in this process instead of spawning one per name.
        monitorUnavailableSince = Date.now();
        try { await service.monitorScan(); } catch { /* The next call retries. */ }
        return true;
      }
      return false;
    },
    /** Names that owe time-critical work; the listener polls these every second. */
    fastPollNames() { return [...fastPoll]; },
    async wake(agentId, taskId) {
      const record = store.get(agentId);
      if (!record || readOnlyTarget(record) || record.sleep?.taskId !== taskId || record.sleep.sessionId !== record.sessionId) return false;
      await ensureWorker(record, { wake: true });
      return true;
    },
    async trySleep(agentId) {
      return store.locked(agentId, async () => {
        const record = store.get(agentId);
        if (!record || readOnlyTarget(record) || !canSleep(record, store.supplements(agentId), treeSettled)) return false;
        if (!await startSharedMonitor(config, store)) return false;
        return store.sleep(record, idleSignal({ ...record.observation, taskId: record.task.taskId }));
      });
    },
    close() { store.close(); },
  };

  async function answerLocked(record, message, queuedAnswerId, { modelSelection } = {}) {
    if (!record.task || record.closed || record.task.cancelRequested) throw new Error('This subagent has no open task waiting for an answer.');
    await negotiateTree(record);
    await checkHost(record);
    const view = await observe(record);
    const existing = (record.task.answers ?? []).find(answer => queuedAnswerId ? answer.answerId === queuedAnswerId : !answer.questionIds && answer.message === message);
    if (!existing && !(view.questions ?? []).some(question => question.state === 'pending')) throw new Error('This subagent has no unanswered question.');
    record.task.answers ??= [];
    const answer = existing ?? { answerId: queuedAnswerId ?? uid('answer'), message, dispatched: false };
    // The continuation is dispatched on a later poll. Freeze the selection on the
    // answer intent now: a queued supplement carries its enqueue-time selection,
    // while a direct answer freezes the name's current pin.
    if (!Object.prototype.hasOwnProperty.call(answer, 'modelSelection')) {
      const frozen = modelSelection !== undefined ? modelSelection : record.modelPin;
      answer.modelSelection = frozen ? { ...frozen } : null;
    }
    if (!existing) record.task.answers.push(answer);
    store.save(record);
    try { await resolveAnswer(record, answer); }
    catch (error) { record.error = safeError(error); store.save(record); await ensureWorker(record); throw error; }
    // A final report seals its task: the helper has finished and reads nothing more.
    // An answer that comes after it still closes the question, which releases the held
    // report, but it is never written into the conversation, and the caller is told
    // exactly that instead of "resuming".
    if ([...(record.task.reports ?? []), ...(view.reports ?? [])].some(report => report.final === true)) {
      answer.dispatched = true; answer.undelivered = 'final-submitted';
      store.save(record);
      await ensureWorker(record, { wake: true });
      return { name: record.name, answered: false, state: record.state,
        error: { code: 'answer-not-delivered', message: `“${record.name}” had already submitted its final report, so this answer was not delivered. The final report is released to you now; if the work should continue, assign it again with futureaide_send_agent or futureaide_run_agent.` } };
    }
    record.state = 'running'; record.task.state = 'running'; store.save(record);
    await ensureWorker(record, { wake: true });
    return { name: record.name, answered: true, state: 'resuming',
      actualModel: actualModelName(answer.modelSelection) ?? actualModelName(record.model) };
  }
  return service;
}
