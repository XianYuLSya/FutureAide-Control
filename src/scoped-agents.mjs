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
import { isCancelledRound, RosterStore, submissionNoticeId, submissionRef } from './roster-store.mjs';
import { canReleaseThreads, canSleep, hasPendingDelivery, RELEASE_RECHECK_MS, releaseDue,
  releaseRetryDelay } from './idle-monitor-eligibility.mjs';
import { idleSignal } from './idle-monitor.mjs';
import { ensureSharedMonitor, monitorAlive } from './shared-monitor.mjs';
import { diagnoseTarget, DSH_HOST_METHODS, hostLabel, normalizeTarget, readStatusModels, REMOVED_TARGETS, removedTarget, resolveBackend,
  TARGET_LABELS, targetOf } from './agent-backend.mjs';
import { captureWorkspace, diffWorkspace } from './workspace-diff.mjs';
import { FINAL_REPORT_REMINDER, presentedNativeQuestion } from './report-contract.mjs';
import { absentClaudeReportReminder, claudeCallbackReminderMs, createDesktopToastNotifier } from './claude-report-reminder.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const uid = prefix => `${prefix}-${randomUUID().replaceAll('-', '')}`;
const now = () => new Date().toISOString();
const ACTIVE = new Set(['creating', 'running', 'awaiting_input', 'awaiting_report', 'reconnecting', 'delivery_pending', 'cleaning']);
const METHODS = DSH_HOST_METHODS;
const TREE_PROTOCOL = 1;
const REPORT_PROTOCOL = 1;
const UNCONFIRMED_AFTER_MS = 30 * 60 * 1000;
const EXPIRE_UNSENT_AFTER_MS = 6 * 60 * 60 * 1000;
const dispatchExpired = created => Date.now() - Date.parse(created ?? '') >= EXPIRE_UNSENT_AFTER_MS;
const CONFIRM_ABSENCE_AFTER_MS = 2 * 60 * 1000;
const terminalNotice = notice => ['delivered', 'blocked'].includes(notice?.state);
const awaitingNoticeReceipt = notice => ['sending', 'unknown'].includes(notice?.state);
const fromSubmission = id => typeof id === 'string' && id.startsWith('submission:');
const MISSING_THREAD_CODE = 'codex-thread-not-found';
const MISSING_CODEX_TREE = '任务树无法确认：线程不在当前 Codex 档案';
const NATIVE_ANSWER_REFUSALS = new Set(['native-answer-invalid', 'native-question-not-pending', 'native-answer-unconfirmed']);

/**
 * Has this round already ended, and how? This is the one structural answer every send
 * path shares: a finished round settles what it owes and sends nothing more. A missing
 * thread recorded by a build that had no `treeUnavailable` marker counts as failed —its
 * body, its error and the notice it already got are the only evidence left.
 * @param {object} record Live roster record.
 * @returns {'failed'|'cancelled'|'completed'|undefined} The state it ended in.
 */
export function terminalRound(record) {
  if (!record) return undefined;
  const task = record.task;
  // The marker our own paths write is explicit evidence; the bare error code is only
  // trusted on a Codex row that is already failed —an active row can carry the same code
  // in a parent notice (blockCodexNotice) and must not be judged finished by it.
  if (task?.treeUnavailable === MISSING_THREAD_CODE) return 'failed';
  const missingThread = record.state === 'failed' && record.error?.code === MISSING_THREAD_CODE;
  if (missingThread) return 'failed';
  if (['failed', 'cancelled'].includes(record.state)) return record.state;
  if (task && ['failed', 'cancelled'].includes(task.state)) return task.state;
  // A completed task never produces another turn, whatever its final notice still owes:
  // delivery is a settlement and once-cleanup gate, never a permission to send.
  if (record.state === 'completed' || task?.state === 'completed' || task?.legacyAutomaticResult) return 'completed';
  return undefined;
}


/** Adopt evidence from old task bodies before any attempt with the canonical ID. */
function submissionNotice(item, projection) {
  const id = submissionNoticeId(item.id);
  const sources = [item.delivery, projection].filter(Boolean);
  const terminal = sources.find(notice => notice.state === 'delivered')
    ?? sources.find(notice => notice.state === 'blocked');
  const ambiguous = sources.filter(entry => awaitingNoticeReceipt(entry)
    && !(entry.state === 'unknown' && entry.error?.message === 'claude-request-id-invalid'
      && claudeNoticeRequestId(entry.id) !== entry.id));
  const saved = terminal ?? ambiguous[0] ?? sources.find(entry => !awaitingNoticeReceipt(entry));
  const notice = { state: 'pending', ...saved, id, createdAt: item.created };
  if (!terminal && ambiguous.length) {
    const aliases = new Set(ambiguous.flatMap(entry => [entry.id, ...(entry.readbackIds ?? [])])
      .filter(value => typeof value === 'string' && value));
    aliases.delete(id);
    if (aliases.size) {
      const newAlias = [...aliases].some(alias => !(saved.readbackIds ?? []).includes(alias) && alias !== saved.id);
      notice.readbackIds = [...aliases];
      if (newAlias) delete notice.cursor;
      const oldest = ambiguous.map(entry => Date.parse(entry.attemptedAt ?? entry.createdAt ?? ''))
        .filter(Number.isFinite).reduce((a, b) => Math.min(a, b), Infinity);
      if (Number.isFinite(oldest)) notice.attemptedAt = new Date(oldest).toISOString();
    }
  }
  return notice;
}
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
    // Why work of this round was never sent, including an expired supplement that is not
    // the newest dispatch. Bounded on purpose: a count and the latest item, so a long-lived
    // name never carries a growing array. `list` surfaces this at its own top level.
    ...(task?.expired || record.expired?.latest ? { expired: {
      ...(task?.expired ?? record.expired.latest),
      ...(record.expired?.latest ? { count: record.expired.count,
        ...(task?.expired ? { latestSupplement: record.expired.latest } : {}) } : {}) } } : {}),
    ...(record.callbackBlocked ? { callbackError: { code: 'native-callback-unavailable', message: 'The desktop does not permit background reports to this native multi-agent v2 sub-agent.' } } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Every input of the current task, including ones whose native receipt is already
 * accepted. `inspect` returns these rows so one requestId can be followed from the
 * local queue to its actual route. Fields absent from historical rows stay absent.
 */
function taskInputs(store, record) {
  const task = record.task;
  if (!task) return [];
  // Delivery labels that prove a native write versus only a local wait. `answered` is
  // the display label for an answer whose text actually reached the target; the raw
  // route (turnId/afterTurnId) stays beside it. `accepted` alone never tells current
  // from new, and `answer.dispatched` alone is not delivery proof.
  const acceptedRoute = route => ['current-turn', 'new-turn', 'answered'].includes(route);
  const waitingRoute = route => ['after-current', 'local-pending', 'answer-pending'].includes(route);
  const rows = new Map();
  const put = (requestId, row) => {
    if (!requestId) return;
    const prior = rows.get(requestId) ?? {};
    const merged = { ...prior, ...row };
    // A frozen older row never overrides a value another record already proved.
    for (const [key, value] of Object.entries(row)) if (value === undefined && prior[key] !== undefined) merged[key] = prior[key];
    rows.set(requestId, merged);
  };
  const lifecycle = delivery => delivery === 'blocked' ? 'blocked'
    : delivery === 'unknown' ? 'unknown'
      : waitingRoute(delivery) ? 'queued'
        : acceptedRoute(delivery) || delivery === 'accepted-route-unknown' ? 'accepted'
          : undefined;

  // Durable queue rows: accepted inputs are hidden from the work queue but still belong
  // to this task's inspect answer. The store derives blocked/local-pending for rows
  // written before receipts existed instead of leaving those states absent.
  let queued = [];
  try { queued = store.supplementInputs(record.agentId, task.taskId) ?? []; } catch { queued = []; }
  const blockedInputs = new Set();
  for (const item of queued) {
    if (item.delivery === 'blocked') blockedInputs.add(item.requestId);
    const status = lifecycle(item.delivery) ?? item.status;
    put(item.requestId, {
      requestId: item.requestId,
      ...(item.mode ? { mode: item.mode } : {}),
      ...(item.delivery ? { delivery: item.delivery } : {}),
      accepted: item.accepted === true,
      queued: item.queued === true,
      ...(item.turnId ? { turnId: item.turnId } : {}),
      // A current-turn write has only that turnId. Any afterTurnId on it is the
      // queued-wait route the input never took; every other row keeps its history.
      ...(item.delivery !== 'current-turn' && item.afterTurnId ? { afterTurnId: item.afterTurnId } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
      ...(status ? { status } : {}),
      ...(item.createdAt ? { createdAt: item.createdAt } : {}),
    });
  }

  // A dispatch is the actual write intent/evidence. Its route fills fields a queue row
  // written before receipts existed could not have. A blocked queue row keeps its final
  // reason: a stale intent must never turn "not sent" back into a pending input.
  for (const dispatch of task.dispatches ?? []) {
    if (dispatch.kind === 'answer') continue;
    if (blockedInputs.has(dispatch.requestId)) continue;
    const existing = rows.get(dispatch.requestId);
    const delivery = dispatch.delivery
      ?? (dispatch.state === 'blocked' || (dispatch.state === 'failed' && dispatch.error) ? 'blocked'
        : ['sending', 'queued', 'retrying'].includes(dispatch.state) ? 'local-pending' : undefined);
    const status = lifecycle(delivery) ?? dispatch.state;
    put(dispatch.requestId, {
      requestId: dispatch.requestId,
      ...(dispatch.mode ? { mode: dispatch.mode } : {}),
      ...(delivery ? { delivery } : {}),
      accepted: dispatch.accepted === true,
      queued: dispatch.accepted !== true && (waitingRoute(delivery) || ['sending', 'queued', 'retrying'].includes(dispatch.state)),
      ...(dispatch.turnId ? { turnId: dispatch.turnId } : {}),
      ...(delivery !== 'current-turn' && dispatch.afterTurnId ? { afterTurnId: dispatch.afterTurnId } : {}),
      ...(dispatch.error?.code ? { reason: dispatch.error.code } : {}),
      ...(status ? { status } : {}),
      ...(existing?.createdAt ? {} : dispatch.startedAt ? { createdAt: dispatch.startedAt } : {}),
    });
  }

  // Answers keep the caller-visible request id the send/run receipt returned (the
  // answerId), so the caller can find the row it was told about. The native text write
  // is found through the dispatch's answerIds against the answer's questionIds. Only
  // that write's receipt can say the text reached a turn; a failed write is blocked,
  // and accepted-without-route is "accepted, route unknown" rather than answered.
  const answerDispatches = (task.dispatches ?? []).filter(dispatch => dispatch.kind === 'answer');
  const matchedDispatches = new Set();
  for (const answer of task.answers ?? []) {
    const questionIds = Array.isArray(answer.questionIds) ? answer.questionIds : [];
    // A requestId match is the strongest link (a supplement used as the answer keeps
    // its enqueue id). Otherwise the dispatch's answerIds carries the question ids the
    // answer consumed. A retried answer prefers its accepted write over an older failure.
    const candidates = answerDispatches.filter(entry => entry.requestId === answer.answerId)
      .concat(questionIds.length ? answerDispatches.filter(entry =>
        (entry.answerIds ?? []).some(id => questionIds.includes(id))) : []);
    const dispatch = candidates.find(entry => entry.accepted === true) ?? candidates.at(-1);
    for (const candidate of candidates) matchedDispatches.add(candidate);
    const route = dispatch?.delivery;
    const existing = rows.get(answer.answerId);
    let delivery, accepted = false, queued = false, reason;
    if (answer.undelivered) {
      delivery = 'blocked'; reason = answer.undelivered;
    } else if (answer.nativeAnswered === true) {
      // The adapter answered the native question card itself; that is the delivery,
      // not a text turn, so no turn id is invented for it.
      delivery = 'answered'; accepted = true;
    } else if (dispatch) {
      if (dispatch.accepted === true && acceptedRoute(route)) {
        delivery = 'answered'; accepted = true;
      } else if (dispatch.accepted !== true
          && (waitingRoute(route) || ['sending', 'queued', 'retrying'].includes(dispatch.state))) {
        delivery = 'answer-pending'; queued = true;
      } else if (dispatch.accepted === true) {
        delivery = 'accepted-route-unknown'; accepted = true;
      } else if (route === 'blocked' || dispatch.state === 'blocked'
          || (dispatch.state === 'failed' && dispatch.error)) {
        delivery = 'blocked'; reason = dispatch.error?.code ?? 'send-failed';
      } else {
        delivery = 'unknown'; reason = dispatch.error?.code ?? 'answer-outcome-unknown';
      }
    } else if (questionIds.length && answer.dispatched !== true) {
      // Registered against a real question and waiting for its dispatch.
      delivery = 'answer-pending'; queued = true;
    } else {
      // A row that claims it was dispatched with no dispatch record, or one that never
      // matched a question, is not evidence that the answer was delivered.
      delivery = 'unknown'; reason = answer.dispatched === true ? 'answer-dispatch-unconfirmed' : 'answer-question-unconfirmed';
    }
    put(answer.answerId, {
      requestId: answer.answerId,
      mode: 'steer',
      delivery,
      accepted,
      queued,
      ...(dispatch?.turnId ?? answer.turnId ? { turnId: dispatch?.turnId ?? answer.turnId } : {}),
      ...(dispatch?.afterTurnId ?? answer.afterTurnId ? { afterTurnId: dispatch?.afterTurnId ?? answer.afterTurnId } : {}),
      ...(reason ? { reason } : {}),
      status: lifecycle(delivery) ?? 'unknown',
      ...(existing?.createdAt ? {} : dispatch?.startedAt ? { createdAt: dispatch.startedAt } : {}),
    });
  }
  // An answer dispatch with no surviving answer row is still a real input; keep it
  // visible under its own request id instead of dropping the write from inspect.
  for (const dispatch of answerDispatches) {
    if (matchedDispatches.has(dispatch)) continue;
    const route = dispatch.delivery;
    const delivery = dispatch.accepted === true && acceptedRoute(route) ? 'answered'
      : dispatch.accepted === true ? 'accepted-route-unknown'
        : waitingRoute(route) ? route
          : ['sending', 'queued', 'retrying'].includes(dispatch.state) ? 'answer-pending'
            : route ?? (dispatch.state === 'failed' || dispatch.state === 'blocked' ? 'blocked' : 'unknown');
    put(dispatch.requestId, {
      requestId: dispatch.requestId,
      ...(dispatch.mode ? { mode: dispatch.mode } : {}),
      delivery,
      accepted: dispatch.accepted === true,
      queued: dispatch.accepted !== true && (waitingRoute(delivery) || ['sending', 'queued', 'retrying'].includes(dispatch.state)),
      ...(dispatch.turnId ? { turnId: dispatch.turnId } : {}),
      ...(dispatch.afterTurnId ? { afterTurnId: dispatch.afterTurnId } : {}),
      ...(dispatch.error?.code ? { reason: dispatch.error.code } : {}),
      status: lifecycle(delivery) ?? 'unknown',
      ...(dispatch.startedAt ? { createdAt: dispatch.startedAt } : {}),
    });
  }
  return [...rows.values()].sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
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
// Version 2 finds the request marker inside Claude Desktop's absorbed
// queued_command/remove records. A notice written by an older reader has a cursor
// that may already have passed its receipt, so that cursor is discarded once.
export const CLAUDE_RECEIPT_PARSER = 2;

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

/** Current byte length: the fixed cutoff for one old notice's upgrade scan. */
export async function transcriptSize(binding) {
  const handle = await open(binding.transcriptFile, 'r');
  try { return (await handle.stat()).size; } finally { await handle.close(); }
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
  const requestIds = [notice.id, ...(notice.readbackIds ?? [])].map(claudeNoticeRequestId);
  let cursor;
  if (notice.receiptParser !== CLAUDE_RECEIPT_PARSER) {
    // An older reader could advance past a Desktop receipt it did not understand.
    // Discard that cursor exactly once. The transcript end at this first sight is
    // the scan's fixed cutoff: pages found there are evidence, while records
    // appended later belong to a new send and are never made to extend this wait.
    notice.receiptParser = CLAUDE_RECEIPT_PARSER;
    notice.cursor = 0;
    const through = await transcriptSize(binding).catch(() => undefined);
    notice.receiptScan = { parser: CLAUDE_RECEIPT_PARSER,
      ...(Number.isSafeInteger(through) ? { through } : {}), complete: false };
    cursor = 0;
  } else cursor = Number.isSafeInteger(notice.cursor) ? notice.cursor : 0;
  const through = Number.isSafeInteger(notice.receiptScan?.through) ? notice.receiptScan.through : undefined;
  // Once the one-time scan has seen the transcript as it stood at first sight,
  // drop the cutoff: later polls follow new records from the saved cursor.
  const scanComplete = () => { if (notice.receiptScan) { notice.receiptScan.complete = true; delete notice.receiptScan.through; } };
  for (let page = 0; page < CLAUDE_PAGES_PER_POLL; page++) {
    const remaining = through === undefined ? CLAUDE_PAGE_BYTES : through - cursor;
    if (remaining <= 0) { scanComplete(); return undefined; }
    const maxBytes = Math.min(CLAUDE_PAGE_BYTES, remaining);
    let read;
    const lineExceeds = error => String(error?.message ?? '').includes('line-exceeds-page');
    try { read = await readEvents(binding, { offset: cursor, maxBytes }); }
    catch (error) {
      if (!lineExceeds(error)) throw error;
      // No cutoff means an ordinary page: retry at the reader's full ceiling.
      // A fixed cutoff keeps its remaining bytes and should end on a line boundary.
      const retryBytes = through === undefined ? CLAUDE_MAX_PAGE_BYTES : Math.min(CLAUDE_MAX_PAGE_BYTES, remaining);
      // The fixed window ends inside a line that cannot fit in what remains.
      // This round saw every complete line; keep its cursor for a later ordinary
      // read instead of failing over a trailing partial record.
      if (through !== undefined && remaining <= maxBytes) { scanComplete(); return undefined; }
      try { read = await readEvents(binding, { offset: cursor, maxBytes: retryBytes }); }
      catch (retryError) {
        if (!lineExceeds(retryError)) throw retryError;
        if (through !== undefined && remaining <= retryBytes) { scanComplete(); return undefined; }
        throw retryError;
      }
    }
    const matched = requestIds.map(id => claudeNoticeReceipt(read.deliveries, id)).find(Boolean);
    const next = Number.isSafeInteger(read.offset) ? read.offset : cursor;
    notice.cursor = next;
    if (matched) return matched;
    if (through !== undefined && next >= through) { scanComplete(); return undefined; }
    if (read.hasMore !== true || next <= cursor) { scanComplete(); return undefined; }
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
  // A report that keeps finding its Claude session gone is handed to the Windows
  // notification area. A drill replaces this seam; nothing is ever shown in a test.
  notifyDesktop = undefined,
} = {}) {
  const notify = notifyDesktop ?? createDesktopToastNotifier();
  // One reminder is due once this notice has found its session gone for this long.
  const callbackReminderWait = claudeCallbackReminderMs(config.claudeCallbackReminderMs);
  const claudeSend = claudeInbox.send ?? sendClaude;
  const claudeDiscover = claudeInbox.discover ?? discoverClaude;
  const claudeReadEvents = claudeInbox.readEvents ?? readClaudeEvents;
  const claudeBind = claudeInbox.bind ?? bindClaude;
  const clients = new Map();
  const operationBackends = new WeakMap();
  const inflight = new Map(), monitorInflight = new Map();
  // A release attempt is deliberately NOT in `inflight`: it belongs to a round that is
  // already over, and putting it there would make the next round's poll wait for an
  // unload instead of running.
  const releaseInflight = new Map(), releaseSignals = new Map();
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
  // The earliest release re-check the last sweep found; the listener sleeps to it
  // instead of polling a finished name while it waits.
  let releaseWakeAt;
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
      // The release attempt is one field of the Codex document, and only this target has
      // it: the flag that makes the store merge it inside SQL is set for Codex alone, and
      // not at all while the feature is switched off, so no other path pays for it.
      writeNativeState: value => store.saveBackendState(record.agentId, value,
        { keepRelease: target === 'codex-desktop' && config.idleSessionCleanup !== false }),
      ...(target === 'codex-desktop' ? {
        // The atomic patch the adapter uses for that field: it names the round and the
        // attempt, so a document read before another connection wrote cannot undo it.
        writeNativeRelease: (value, fence = {}) => store.saveBackendRelease(record.agentId, value, fence),
        // The adapter's own host reads the same switch the monitor's gate reads.
        hostOptions: { idleSessionCleanup: config.idleSessionCleanup !== false },
      } : {}),
      withHostLock: (action, { key } = {}) => store.locked(`backend:${target}${key ? `:${key}` : ''}`, action),
      ensureCodexReports: () => beginCodexReports(record),
      readCodexReportState: () => readParentSubmissions(load()),
      ...(target === 'claude-cli' ? {
        readParentSubmissions: () => readParentSubmissions(load()),
        claudeReportConfig: requestId => ({ mcpServers: { futureaide: { type: 'stdio', command: process.execPath,
          args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url)), '--claude-cli-reports',
            store.location, record.agentId, load().task.taskId, requestId,
            ...(config.idleSessionCleanup === false ? ['--no-idle-session-cleanup'] : [])] } } }),
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
      questions: (isCancelledRound(record) ? [] : pending.filter(item => item.kind === 'ask')).map(item => ({ id: submissionRef(item.id),
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
  function absorbSubmissions(record, pending) {
    if (!pending.length) return;
    for (const item of pending) {
      if (item.kind === 'report') {
        record.task.reports ??= [];
        if (!record.task.reports.some(report => report.id === submissionRef(item.id))) {
          record.task.reports.push({ id: submissionRef(item.id), taskId: record.task.taskId,
            message: item.message, final: item.final, createdAt: item.created, delivery: submissionNotice(item) });
        }
      } else if (!isCancelledRound(record) && !record.task.treeUnavailable) {
        record.observation ??= {};
        record.observation.questions ??= [];
        if (!record.observation.questions.some(question => question.id === submissionRef(item.id))) {
          record.observation.questions.push({ id: submissionRef(item.id), state: 'pending', message: item.message, createdAt: item.created });
        }
        // A round that already ended still delivers the question as a notice, but it never
        // reopens for it: reopening is what used to send an old body out again.
        if (!terminalRound(record)) record.state = 'awaiting_input';
      }
    }
    // The round owes work again. Clear its sleep marker and any release ticket in
    // the same save that transfers the raw rows to the task.
    delete record.sleep;
    invalidateRelease(record);
    store.saveAndConsumeSubmissions(record, pending.map(item => item.id));
  }

  // The submission owns delivery after absorption too. Current task bodies and
  // archives supply legacy evidence by submission ID, never a second sender.
  async function drainSubmissions(record, { currentOnly = false, readOnDemand = false } = {}) {
    if (record.closed || (currentOnly && !record.task)) return;
    const task = record.task;
    // Some old report projections carry a submission ID but no inbox row.
    // Rehydrate them once so their old receipt can be adopted by this sender.
    for (const report of task?.reports ?? []) {
      if (!fromSubmission(report.id)) continue;
      const id = report.id.slice('submission:'.length);
      if (report.delivery?.id !== submissionNoticeId(id)) {
        store.enqueueSubmission({ id, ownerId: record.ownerId, agentId: record.agentId, taskId: task.taskId,
          kind: 'report', message: report.message, final: report.final, created: report.createdAt ?? task.startedAt });
      }
    }
    const rows = store.submissionWork(record.agentId, currentOnly ? task.taskId : undefined);
    absorbSubmissions(record, rows.filter(item => item.state === 'pending' && item.taskId === task?.taskId));
    const history = new Map();
    for (const item of rows) {
      const current = item.taskId === task?.taskId;
      if (!current && !history.has(item.taskId)) {
        history.set(item.taskId, store.historyTask(record.agentId, item.taskId));
      }
      const round = current ? task : history.get(item.taskId);
      const ref = submissionRef(item.id);
      let report = item.kind === 'report' ? round?.reports?.find(entry => entry.id === ref) : undefined;
      const notice = submissionNotice(item, report?.delivery ?? round?.questionNotices?.[ref]);
      const persist = () => {
        const previousReport = report, previousReports = task?.reports;
        const previousDelivery = report?.delivery, previousQuestions = task?.questionNotices;
        if (current) {
          if (item.kind === 'report') {
            if (!report) {
              report = { id: ref, taskId: item.taskId, message: item.message, final: item.final, createdAt: item.created };
              task.reports = [...(previousReports ?? []), report];
            }
            report.delivery = { ...notice };
          } else task.questionNotices = { ...previousQuestions, [ref]: { ...notice } };
        }
        let saved;
        try { saved = store.saveSubmissionDelivery(item.id, notice, { expected: item.deliveryVersion, record: current ? record : undefined }); }
        finally {
          if (!saved && current) {
            if (previousReport) previousReport.delivery = previousDelivery;
            report = previousReport;
            task.reports = previousReports;
            task.questionNotices = previousQuestions;
          }
        }
        if (!saved) {
          throw Object.assign(new Error('The submission delivery changed in another worker.'), { code: 'submission-delivery-changed' });
        }
        item.deliveryVersion = JSON.stringify(notice);
      };
      if (terminalNotice(notice)) { persist(); continue; }
      const name = `${hostLabel(record)}「${record.name}」`;
      let text;
      const missingTree = round?.treeUnavailable === 'codex-thread-not-found' && !report?.treeSettledConfirmed;
      let ready = item.kind !== 'report' || !item.final || !current || report?.treeSettledConfirmed || missingTree;
      if (item.kind === 'ask') {
        const answered = round?.answers?.some(answer => answer.questionIds?.includes(ref));
        const active = current && !answered && !round.treeUnavailable && !terminalRound(store.get(record.agentId) ?? record)
          && !isCancelledRound(store.get(record.agentId) ?? record);
        if (active && presentedNativeQuestion(record)) ready = false;
        text = active ? questionPrompt(record, item.message) : `${name}旧轮次提问：\n${item.message}`;
      } else {
        const label = current ? (item.final ? '交付' : '汇报') : (item.final ? '旧轮次最终汇报' : '旧轮次汇报');
        text = `${name}${label}：\n${item.message}${item.final && missingTree ? '\n\n' + MISSING_CODEX_TREE : ''}`;
      }
      if ((notice.waitingForTree && ready) || (readOnDemand && awaitingNoticeReceipt(notice))) {
        delete notice.waitingForTree;
        delete notice.nextAttemptAt;
      }
      await deliver(record, notice, text, { persist, allowSend: ready, submission: true,
        // Only a real report is reminded to the user; an ask is answered, not read later.
        ...(item.kind === 'report' ? { reportSummary: item.message } : {}) });
    }
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

  /**
   * Enabled Codex name that has entered the release path for the task it holds now.
   * Nothing else in the roster is this feature's business: DSH, Claude and a name under
   * the switch keep the state machine they had.
   */
  function inReleasePath(record) {
    return config.idleSessionCleanup !== false
      && targetOf(record) === 'codex-desktop'
      && typeof record.releaseState?.taskId === 'string'
      && record.releaseState.taskId === record.task?.taskId;
  }

  /**
   * A finished round that still carries a retry stamp. A projection can only hint this:
   * the same field holds any target's own retry, so the caller reads that one name whole
   * before this feature touches it.
   */
  function mayHoldReleaseSchedule(record) {
    // Under the switch this field is not evidence of anything this feature wrote, and
    // asking again is the caller's job only when the feature is on.
    if (config.idleSessionCleanup === false) return false;
    return Boolean(record) && record.nextAttemptAt !== undefined
      && ['idle', 'failed', 'cancelled'].includes(record.state);
  }

  /**
   * The release re-check this name itself still owes, and nothing else. Only a full
   * record can prove it: the schedule the release wrote names the same task and the same
   * moment as the record's own retry field. Anything else is left to the old state
   * machine.
   * @param {object} record Full record.
   * @returns {number|undefined} Due time of the release re-check.
   */
  function releaseRecheckAt(record) {
    if (!record?.releaseState || record.closed) return undefined;
    if (!['idle', 'failed', 'cancelled'].includes(record.state)) return undefined;
    if (!inReleasePath(record)) return undefined;
    const release = record.releaseState;
    if (release.nextCheckAt === undefined || release.nextCheckAt !== record.nextAttemptAt) return undefined;
    return release.nextCheckAt;
  }

  function pendingInbox() {
    return new Map((store.pendingSubmissionAgents?.() ?? []).map(({ agentId, dueAt }) => [agentId, dueAt]));
  }

  function needsPoll(record, hasSubmission = false) {
    if (readOnlyTarget(record)) return false;
    if (record?.state === 'cleaning') return true;
    if (!record || record.closed) return false;
    if (hasSubmission) return true;
    if (record.sleep) return false;
    if (ACTIVE.has(record.state)) return true;
    // The scan projection already carries both of these, so a roster sweep no longer
    // runs one supplement query per name. A record loaded whole has neither field
    // and takes the queries below.
    if (record.hasSupplement === true) return true;
    if (record.pendingReports !== undefined) {
      if (!record.callbackBlocked && record.pendingReports > 0) return true;
      // A finished round may still hold a release re-check; the caller reads it whole.
      return mayHoldReleaseSchedule(record);
    }
    if (store.supplements(record.agentId).some(item => item.task === record.task?.taskId && item.status !== 'blocked')) return true;
    return (!record.callbackBlocked
      && (record.task?.reports ?? []).some(report => !['delivered', 'blocked'].includes(report.delivery.state)))
      || releaseRecheckAt(record) !== undefined;
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

  async function ensureWorker(record, { wake = false, hasSubmission = false, ensure = ensureMonitor } = {}) {
    if (!record || readOnlyTarget(record)) return false;
    if (wake && record.sleep) {
      if (!await ensure()) {
        // Nothing can watch this installation right now. Keep the sleeping
        // baseline so a later call resumes the same task instead of losing it.
        store.setError(record.agentId, monitorError ?? { code: 'monitor-unavailable', message: 'The shared monitor could not start.' });
        return false;
      }
      store.wake(record.agentId, record.sleep.taskId);
      record = store.get(record.agentId) ?? record;
    }
    if (record.sleep) return true;
    if (!needsPoll(record, hasSubmission)) return false;
    const ready = await ensure();
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
  async function observe(record, { checkingRestoredProfile = false } = {}) {
    const own = await observeOwn(record);
    const keyOf = (agentId, native) => agentId === record.agentId ? native : `${agentId}:${native}`;
    const nodes = (own.tree?.nodes ?? []).map(node => ({ ...node,
      name: node.sessionId === record.sessionId ? record.name : node.name,
      backendKey: record.agentId, nativeSessionId: node.sessionId }));
    const managed = new Map([[record.agentId, { record, backend: await backendFor(record), rootKey: record.sessionId }]]);
    const cancelPending = !checkingRestoredProfile && record.task?.cancelPending === true;
    let settled = own.tree?.settled === true && !cancelPending;
    let running = own.tree?.running === true || cancelPending;
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
      const busy = store.submissionDebt(child.agentId) > 0 || (Boolean(child.task) && (pendingReports || pendingQuestions
        || ACTIVE.has(child.state) || child.state === 'cleanup_failed'
        || !['completed', 'failed', 'cancelled'].includes(child.task.state)));
      const childSettled = !busy && (!child.task || (entry.view?.capturedAt && !entry.view.stale
        && entry.view?.tree?.settled === true && entry.view?.tree?.running === false));
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

  /**
   * An installation can run DSH on its own default model only (dshDefaultModelOnly).
   * Then a caller's model and effort are ignored for DSH names, a pin saved before the
   * switch is never applied, and every DSH input follows the host default.
   */
  const dshDefaultOnly = record => config.dshDefaultModelOnly === true && targetOf(record) === 'dsh';

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

  function normalizeRequestedMode(mode) {
    if (mode === undefined || mode === null) return undefined;
    if (mode === 'steer' || mode === 'queue') return mode;
    throw Object.assign(new Error('mode must be "steer" or "queue" when it is given.'),
      { code: 'mode-invalid', terminal: true });
  }

  /**
   * The live turn's own start selection is the only evidence that a running Codex
   * root can accept an explicit selection. A provider is compared only when both
   * sides name one: the native thread summary can omit it while the catalog id is
   * already the resolved model.
   */
  function sameTurnSelection(left, right) {
    if (!left || !right) return false;
    const text = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
    const model = text(left.model);
    if (!model || model !== text(right.model)) return false;
    if ((text(left.reasoningEffort) || '') !== (text(right.reasoningEffort) || '')) return false;
    return !text(left.provider) || !text(right.provider) || text(left.provider) === text(right.provider);
  }

  function deliveryAccepted(delivery) {
    return ['current-turn', 'new-turn', 'answered', 'accepted-route-unknown'].includes(delivery);
  }

  function deliveryQueued(delivery) {
    return ['after-current', 'local-pending', 'answer-pending'].includes(delivery);
  }

  /**
   * What the target says about its root turn. Only a Codex adapter can answer this
   * for the root alone; every other target uses its observed session state. A
   * missing adapter method falls back to the saved observation, never to the whole
   * tree's running flag for a scheduling decision when a fresh read is available.
   */
  async function rootTurnFor(record) {
    const backend = await backendFor(record);
    if (typeof backend.rootTurn === 'function') {
      const root = await backend.rootTurn();
      if (!root || typeof root !== 'object') return { known: false };
      // A native root read that could not confirm its state is not an idle root: the
      // scheduler must keep the input local rather than inventing an after-current.
      if (root.confirmed === false) return { known: false, reason: root.reason };
      return { known: true, running: root.running === true,
        turnId: typeof root.turnId === 'string' ? root.turnId : undefined,
        selection: root.selection && typeof root.selection === 'object' ? root.selection : undefined };
    }
    if (targetOf(record) === 'codex-desktop') {
      return { known: true, running: codexTurnRunning(record), turnId: undefined, selection: undefined };
    }
    return { known: true, running: undefined, turnId: undefined, selection: undefined };
  }

  /** The selection the active root turn was started with, from native or saved evidence. */
  function activeTurnSelection(record, root) {
    if (root?.selection) return root.selection;
    // A saved task dispatch is evidence only for the exact turn the root reports. A
    // later turn B in the same task must not borrow the first dispatch's selection.
    const turnId = root?.turnId;
    if (!turnId) return undefined;
    const started = (record.task?.dispatches ?? []).find(dispatch => dispatch.kind === 'task'
      && dispatch.accepted === true && dispatch.selectionExplicit === true && dispatch.model
      && dispatch.turnId === turnId);
    return started?.model;
  }

  /**
   * An explicit selection may join a running root only when the target's own
   * comparison proves the same catalog selection. `matchRootSelection` resolves the
   * catalog preset to its wire slug, so preset-a and wire-a are never compared
   * directly. Different is a model change; unknown or idle is refused as unconfirmed.
   */
  async function rootSelectionMatch(record, selection, root) {
    const backend = await backendFor(record);
    if (typeof backend.matchRootSelection === 'function') {
      const match = await backend.matchRootSelection({ selection,
        ...(root?.turnId ? { turnId: root.turnId } : {}) });
      return match?.status;
    }
    const active = activeTurnSelection(record, root);
    return active ? (sameTurnSelection(selection, active) ? 'same' : 'different') : 'unknown';
  }

  async function assertExplicitSelectionForRunning(record, pin, root) {
    const status = await rootSelectionMatch(record, pin, root);
    if (status === 'same') return;
    if (status === 'idle') {
      throw Object.assign(new Error('The root turn already ended; this selection was not written into it.'),
        { code: 'round-finished', terminal: true, notSent: true });
    }
    if (status === 'different') throw modelChangeRefused();
    throw Object.assign(new Error('The running turn’s model and reasoning effort could not be confirmed, so this selection was not sent.'),
      { code: 'model-selection-unconfirmed', uncertain: true, terminal: true });
  }

  function modeUnsupported(record, requested, supportedModes) {
    const target = targetOf(record);
    return {
      name: record.name, accepted: false, queued: false, state: record.state,
      mode: requested ?? supportedModes[0],
      error: { code: 'mode-unsupported', target, supportedModes },
      code: 'mode-unsupported', target, supportedModes,
    };
  }

  function dispatchReceipt(dispatch) {
    if (!dispatch) return {};
    return {
      ...(dispatch.delivery ? { delivery: dispatch.delivery } : {}),
      ...(dispatch.turnId ? { turnId: dispatch.turnId } : {}),
      ...(dispatch.delivery !== 'current-turn' && dispatch.afterTurnId ? { afterTurnId: dispatch.afterTurnId } : {}),
      ...(dispatch.deliveryIntent?.method ? { method: dispatch.deliveryIntent.method } : {}),
      ...(dispatch.deliveryIntent?.expectedTurnId ? { expectedTurnId: dispatch.deliveryIntent.expectedTurnId } : {}),
      ...(dispatch.mode ? { mode: dispatch.mode } : {}),
      selectionExplicit: dispatch.selectionExplicit === true,
    };
  }

  /**
   * Persist the native/scheduling receipt on the supplement row. The fourth
   * argument is the new storage contract; an older store simply ignores it.
   */
  function saveSupplementReceipt(requestId, status, reason = null, receipt = undefined) {
    if (!requestId) return;
    try { store.setSupplement(requestId, status, reason, receipt); }
    catch (error) {
      if (arguments.length < 4 || error?.code !== 'ERR_INVALID_ARG_TYPE') throw error;
      store.setSupplement(requestId, status, reason);
    }
  }

  /** The caller-visible receipt for one supplement, from its row and its dispatch. */
  function supplementReceipt(record, requestId, fallback = {}) {
    const current = store.get(record.agentId) ?? record;
    // An accepted row is no longer in the pending queue, but its stored receipt is
    // the evidence this caller must get back. supplement() reads the row by id.
    const item = store.supplement(requestId);
    const dispatch = (current.task?.dispatches ?? []).find(entry => entry.requestId === requestId);
    const stored = item?.receipt ?? {};
    // A terminal row already recorded by the scheduler outranks any optimistic
    // fallback the entry carried into this call: blocked stays blocked and accepted
    // keeps the route the native receipt proved.
    const terminalDelivery = item?.status === 'blocked' ? 'blocked'
      : item?.status === 'accepted' ? (stored.delivery ?? dispatch?.delivery ?? 'accepted-route-unknown')
        : item?.status === 'unknown' ? 'unknown' : undefined;
    const delivery = terminalDelivery ?? stored.delivery ?? dispatch?.delivery ?? fallback.delivery
      ?? 'local-pending';
    const accepted = item?.status === 'blocked' ? false
      : item?.status === 'accepted' || dispatch?.accepted === true || deliveryAccepted(delivery);
    const queued = !accepted && item?.status !== 'blocked' && (deliveryQueued(delivery)
      || ['queued', 'sending'].includes(item?.status ?? 'queued'));
    const turnId = stored.turnId ?? dispatch?.turnId ?? fallback.turnId;
    // A current-turn write has only that turnId. Every other delivery keeps any
    // known queued-turn history, including a queue row that has since opened B.
    const afterTurnId = delivery === 'current-turn' ? undefined
      : stored.afterTurnId ?? dispatch?.afterTurnId ?? fallback.afterTurnId;
    const reason = item?.reason ?? dispatch?.error?.code ?? fallback.reason;
    return {
      name: current.name, state: current.state, accepted, queued,
      requestId,
      mode: item?.mode ?? stored.mode ?? fallback.mode ?? 'steer',
      delivery,
      ...(turnId ? { turnId } : {}),
      ...(afterTurnId ? { afterTurnId } : {}),
      ...(reason ? { error: { code: reason, message: reason === 'dispatch-expired'
        ? 'This input passed its six hours before it could be sent.'
        : 'This input could not be delivered; its body is kept.' } } : {}),
      actualModel: actualModelName(item?.selection) ?? actualModelName(fallback.pin)
        ?? actualModelName(current.model) ?? actualModelName(current.modelPin),
      ...(current.callbackBlocked ? { callbackError: { code: 'native-callback-unavailable',
        message: 'The desktop does not permit background reports to this native multi-agent v2 sub-agent.' } } : {}),
      ...(fallback.previousReport ? { previousReport: fallback.previousReport } : {}),
    };
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

  /**
   * The preparation of a dispatch is asynchronous, so the round may be gone by the time it
   * returns. Anything written after such an await is fenced on the round it belongs to.
   */
  const roundMovedOn = (record, latest = store.get(record.agentId)) =>
    !latest || latest.closed || latest.task?.taskId !== record.task?.taskId || Boolean(terminalRound(latest));

  function dispatchRefused(code = 'round-finished') {
    return Object.assign(new Error(code === 'dispatch-expired'
      ? 'This input passed its six hours before it could be sent.'
      : 'This round already ended. Nothing was sent for it.'), { code, terminal: true, notSent: true });
  }

  function saveDispatch(record) {
    if (!store.save(record, { dispatch: true })) throw dispatchRefused();
  }

  async function followHostModel(record, dispatch, observed) {
    if (dispatch.modelReady) return;
    // Every save below happens after an await, so each one is fenced on the round this
    // dispatch belongs to: a stale copy must never overwrite a round that has moved on.
    const backend = await backendFor(record);
    const target = targetOf(record);
    if (dshDefaultOnly(record)) {
      // Frozen before the installation locked DSH to its default: never applied.
      delete dispatch.model;
      dispatch.explicitModel = false;
      dispatch.selectionExplicit = false;
    }
    const explicit = dispatch.selectionExplicit === true && dispatch.model !== undefined;
    if (target === 'dsh') {
      if (!dispatch.model) {
        // DSH default-follow keeps the old resolveModel and its catalog validation.
        dispatch.model = resolveModel(await backend.models(), {});
        saveDispatch(record);
      }
      await confirmDshSelection(backend, target, dispatch, dispatch.model, observed, { sessionOnly: explicit });
      record.model = { ...dispatch.model };
      dispatch.modelReady = true;
      saveDispatch(record);
      return;
    }
    if (explicit) {
      // Codex applies the model on its own turn/start. Calling its selectModel would
      // either fake a selection or touch the user's defaults, so it is never used.
      dispatch.modelReady = true;
      saveDispatch(record);
      return;
    }
    // An input accepted without a new selection carries the selection frozen when the
    // caller wrote it. That value is for a future turn/start and is never compared with
    // a running turn. Only a record without any frozen value reads the live value for
    // display; a steer never sends either value.
    if (dispatch.model) {
      dispatch.modelReady = true;
      saveDispatch(record);
      return;
    }
    const current = observed && observed.modelSelectionObserved !== false && observed.currentModel
      ? observed.currentModel
      : await backend.model();
    if (current) {
      dispatch.model = { ...current };
      record.model = { ...current };
    }
    dispatch.modelReady = true;
    saveDispatch(record);
  }

  async function sendDispatch(record, message, kind = 'task', answerIds = [], requestId = uid('request'), observed, extra = {}) {
    const task = record.task;
    // The one structural gate every send path shares. A caller assigning new work writes a
    // new task first, so a finished round can never produce another turn by itself.
    if (terminalRound(record)) throw dispatchRefused();
    const baseline = Number.isSafeInteger(observed?.throughSeq)
      ? observed : await (await backendFor(record)).cursor();
    // Waiting for the cursor is asynchronous: the round is read again before the intent is
    // written, so a round that ended, closed or moved on in the meantime gets no dispatch.
    const fresh = store.get(record.agentId);
    if (!fresh || fresh.task?.taskId !== task.taskId || fresh.closed
        || fresh.task?.cancelRequested || terminalRound(fresh)) {
      throw dispatchRefused();
    }
    // `extra` is written with the dispatch, before the first save, so a reminder is
    // recognisable as one even if the process dies on the way to the native send.
    // The selection is frozen here: later pin changes must not rewrite an input that
    // is already queued or being recovered. `freezeModel` on a queued supplement
    // records that it had no pin when it was accepted, so a later pin cannot leak in.
    const { model: frozenModel, freezeModel, mode, selectionExplicit, ...dispatchExtra } = extra;
    const selected = dshDefaultOnly(record) ? undefined
      : frozenModel !== undefined ? frozenModel
      : freezeModel === true ? undefined : record.modelPin;
    const dispatch = { requestId, message, kind, answerIds, state: 'sending', afterSeq: baseline.throughSeq, startedAt: now(),
      mode: mode === 'queue' ? 'queue' : mode === 'steer' ? 'steer' : record.task?.mode ?? 'steer',
      ...(selected ? { model: { ...selected } } : {}),
      ...(selectionExplicit === true && selected ? { explicitModel: true, selectionExplicit: true }
        : selectionExplicit === false ? { selectionExplicit: false } : {}),
      ...dispatchExtra };
    // A new round ends any release attempt at once: the ticket stops matching, the host's
    // own critical-point check refuses, and the subscription is restored by this write.
    invalidateRelease(record);
    task.dispatches.push(dispatch);
    record.state = 'running'; task.state = 'running';
    saveDispatch(record); // The intent survives a caller or worker exiting during the write.
    await dispatchOnce(record, dispatch, observed);
    return dispatch;
  }

  /**
   * The same answer an adapter asks for at its own last moment, computed the same way:
   * synchronous, read-only, and from the original clock —a retry never refreshes it.
   * Adapters with their own asynchronous preparation call this right before they write.
   * @returns {'dispatch-expired'|'round-finished'|undefined} Why the write must not happen.
   */
  function writeBlockReason(agentId, { taskId, requestId, kind } = {}) {
    const record = store.get(agentId);
    if (!record || record.closed || !record.task || record.task.taskId !== taskId) return 'round-finished';
    if (record.task.cancelRequested || terminalRound(record)) return 'round-finished';
    // Accepted evidence beats age: an intent that already arrived is never blocked because
    // it is old, and a matched answer's receipt is proof of the same thing.
    const intent = requestId === undefined ? undefined
      : (record.task.dispatches ?? []).find(entry => entry.requestId === requestId);
    if (intent?.accepted === true) return undefined;
    if (kind === 'task') return dispatchExpired(record.task.startedAt) ? 'dispatch-expired' : undefined;
    // A final that arrived through the inbox while the adapter was preparing (a helper can
    // submit one without the name lock) ends the round for everything else: a supplement,
    // an answer or a reminder is never written after it. That final settles normally.
    if ((record.task.reports ?? []).some(report => report.final)
        || store.hasFinalNotice(agentId, record.task.taskId)) return 'round-finished';
    const item = store.supplement(requestId);
    // A direct supplement of an active round has no queue row; its own persisted intent then
    // carries the original clock, so a retry never refreshes that either.
    return dispatchExpired(item?.created ?? intent?.requestedAt ?? intent?.startedAt) ? 'dispatch-expired' : undefined;
  }

  /**
   * Seal one input that will never be sent. Only that input is closed: a supplement keeps
   * its body and the running task is untouched; the task itself becomes failed only when
   * it is the task that expired.
   */
  function sealBlockedInput(record, dispatch, reason, message) {
    const item = store.supplement(dispatch.requestId);
    if (reason === 'dispatch-expired') {
      expireInput(record, dispatch, item);
      return;
    }
    dispatch.state = 'blocked';
    dispatch.accepted = false;
    dispatch.error = { code: reason, message: message
      ?? (reason === 'round-finished' ? 'This round already ended; the input was not sent.' : 'This input was not sent.') };
    if (item) store.setSupplement(item.requestId, 'blocked', reason,
      { delivery: 'blocked', accepted: false, queued: false });
  }

  async function dispatchOnce(record, dispatch, observed) {
    const current = store.get(record.agentId);
    if (roundMovedOn(record, current)) throw dispatchRefused();
    if (current.task.cancelRequested) return;
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
      // Preparing the write is asynchronous, so the round is read again right before it
      // leaves: a dispatch prepared while the round was open must never land after it
      // ended, was closed or was cancelled.
      const beforeSend = store.get(record.agentId);
      if (!beforeSend || beforeSend.task?.taskId !== record.task?.taskId || beforeSend.closed
          || beforeSend.task?.cancelRequested || terminalRound(beforeSend)) {
        // Never write this copy back: it still carries the round it was prepared for, and a
        // save would overwrite whatever the newer round has already committed. The current
        // round closes itself on its own poll.
        throw dispatchRefused();
      }
      const explicit = dispatch.explicitModel === true && dispatch.model !== undefined;
      const target = targetOf(record);
      const modern = typeof backend.rootTurn === 'function';
      // A queued input may only start a turn. Re-read the root right before the write:
      // an active root keeps it in the durable queue with the turn it waits behind.
      let root;
      if (target === 'codex-desktop') {
        try { root = await rootTurnFor(record); }
        catch (error) { root = { known: false, error }; }
        if (dispatch.mode === 'queue' && root?.known !== false && root.running) {
          Object.assign(dispatch, { state: 'queued', accepted: false, delivery: 'after-current',
            afterTurnId: root.turnId });
          if (dispatch.kind === 'supplement') saveSupplementReceipt(dispatch.requestId, 'queued', null, dispatchReceipt(dispatch));
          saveDispatch(record);
          return;
        }
        if (root?.known === false) {
          // No write happened. Keep the same request in the local queue; a later poll
          // re-reads the root and starts it under this same request id.
          Object.assign(dispatch, { state: 'queued', accepted: false, delivery: 'local-pending' });
          if (dispatch.kind === 'supplement') saveSupplementReceipt(dispatch.requestId, 'queued', null, dispatchReceipt(dispatch));
          saveDispatch(record);
          return;
        }
      }
      // Persist the intended native method and its target before the RPC: a process
      // that dies after the write can only recover the route from this record.
      const method = target === 'codex-desktop'
        ? (root?.running ? 'steer' : 'start')
        : (observed?.running === true && dispatch.mode !== 'queue' ? 'steer' : 'start');
      dispatch.deliveryIntent = { method, mode: dispatch.mode,
        ...(method === 'steer' && root?.turnId ? { expectedTurnId: root.turnId } : {}),
        ...(method === 'start' && root?.turnId ? { afterTurnId: root.turnId } : {}) };
      saveDispatch(record);
      // The adapter has its own asynchronous preparation (host lock, state reads, preflight,
      // writes), so it is given the same gate to consult immediately before it writes.
      const reasonFor = () => writeBlockReason(record.agentId,
        { taskId: dispatch.taskId ?? record.task?.taskId, requestId: dispatch.requestId, kind: dispatch.kind });
      const blocked = reasonFor();
      if (blocked) throw dispatchRefused(blocked);
      // A normal steer may join a running root, but it must not open B while an earlier
      // queue row is waiting: the scheduler owns FIFO. If the root went idle after this
      // dispatch was prepared, the adapter hands it back without writing.
      const waitingRows = store.supplements(record.agentId);
      const position = waitingRows.findIndex(row => row.requestId === dispatch.requestId);
      const earlierQueue = position > 0 && waitingRows.slice(0, position).some(row =>
        row.task === record.task?.taskId && row.mode === 'queue' && row.status !== 'blocked');
      const allowStart = !(target === 'codex-desktop' && dispatch.kind === 'supplement'
        && dispatch.mode !== 'queue' && earlierQueue);
      const sent = await backend.deliver({ requestId: dispatch.requestId,
        message: dispatch.message, kind: dispatch.kind,
        writeBlockReason: reasonFor,
        allowStart,
        mode: dispatch.mode === 'queue' ? 'queue' : 'steer',
        ...(dispatch.selectionExplicit === undefined ? {}
          : { selectionExplicit: dispatch.selectionExplicit === true }),
        ...(modern
          ? (dispatch.model ? { model: dispatch.model } : {})
          : (explicit ? { model: dispatch.model, explicitModel: true } : { explicitModel: false })) });
      // A native receipt names the actual route. When it does not, a Codex write is
      // never reported as current or new from `accepted` alone.
      const delivery = typeof sent.delivery === 'string' ? sent.delivery
        : (sent.reschedule === true || sent.waiting === true || sent.status === 'waiting') ? 'local-pending'
          : target === 'codex-desktop' ? (sent.accepted === true ? 'accepted-route-unknown' : sent.status ?? 'unknown')
            : sent.accepted !== true ? (['retryable', 'retrying'].includes(sent.status) ? 'local-pending' : sent.status ?? 'unknown')
              : dispatch.kind === 'answer' ? 'answered'
                : method === 'steer' ? 'current-turn' : 'new-turn';
      const accepted = sent.accepted === true || deliveryAccepted(delivery);
      const state = accepted ? 'running'
        : ['after-current', 'local-pending', 'answer-pending'].includes(delivery) ? 'queued'
          : delivery === 'blocked' ? 'blocked' : ['unknown', 'accepted-route-unknown'].includes(delivery) ? 'unknown'
            : sent.status ?? 'failed';
      Object.assign(dispatch, { delivery, state, accepted,
        ...(sent.turnId ? { turnId: sent.turnId } : {}),
        ...(sent.afterTurnId ?? (delivery === 'after-current' ? sent.turnId ?? root?.turnId : undefined)
          ? { afterTurnId: sent.afterTurnId ?? sent.turnId ?? root?.turnId } : {}),
        ...(sent.afterSeq !== undefined ? { afterSeq: sent.afterSeq } : {}),
        ...(accepted ? { error: undefined, nextAttemptAt: undefined } : {}) });
      // A steer into the current turn has only that turnId; an afterTurnId here is
      // the queued-wait route it never took. A queue row that opened B keeps its
      // known A as history.
      if (delivery === 'current-turn') delete dispatch.afterTurnId;
      if (accepted && explicit && target === 'codex-desktop') {
        // The native turn now runs with the pinned model; record the real display value
        // and only now make it the name's intended selection. A refused or still
        // waiting input never changes the pin.
        record.model = { ...dispatch.model };
        record.modelPin = { ...dispatch.model };
      }
      if (dispatch.kind === 'supplement') {
        saveSupplementReceipt(dispatch.requestId, accepted ? 'accepted'
          : delivery === 'blocked' ? 'blocked' : delivery === 'unknown' ? 'unknown' : 'queued',
        accepted ? null : dispatch.error?.code ?? sent.reason ?? null, dispatchReceipt(dispatch));
      }
      if (!accepted && ['retryable', 'retrying'].includes(dispatch.state)) {
        dispatch.state = 'retrying'; deferRetry(dispatch);
      }
    } catch (error) {
      // The adapter refused at its own last moment and proved nothing was written. A round
      // that moved on, closed or ended must not have this copy saved back over it; a round
      // that is merely too old seals this one input and keeps everything else.
      if (error?.notSent === true && error?.terminal === true) {
        const code = error.code;
        const reason = code === 'dispatch-expired' ? 'dispatch-expired'
          : ['round-finished', 'task-cancelled', 'final-submitted', 'task-changed'].includes(code) ? 'round-finished'
            : code ?? 'send-blocked';
        const latest = store.get(record.agentId);
        if (!roundMovedOn(record, latest) && !latest.task?.cancelRequested) {
          sealBlockedInput(record, dispatch, reason, error.message);
          saveDispatch(record);
        }
        throw error;
      }
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
    saveDispatch(record);
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
   * Record that this attempt found the Claude session that owns the name definitely
   * gone — the attempt wrote nothing — and, for a real report only, hand that report to
   * the operating system's notification area once the same notice has been absent for
   * the configured wait.
   *
   * The original notice owns both facts: `callbackMissingSince` dates the absence and
   * `reminder` is the one-shot claim, written through the same persist (and the same
   * compare-and-swap for a submission) that owns the notice, before anything is shown.
   * The report itself is untouched — still pending, still retried on its own schedule,
   * still read back — so a session that comes back is owed the delivery it always was.
   * Nothing here starts a timer: the notice's existing nextAttemptAt is the only clock.
   */
  async function noteClaudeAbsence(record, owner, notice, error, { persist, reportSummary }) {
    if (error?.code !== 'callback-target-missing') {
      // Another outcome says nothing about the session being away, so any wait in
      // progress was not consecutive and restarts at the next definite absence.
      if (notice.callbackMissingSince !== undefined) { delete notice.callbackMissingSince; persist(); }
      return;
    }
    if (!Number.isFinite(Date.parse(notice.callbackMissingSince ?? ''))) {
      notice.callbackMissingSince = now();
      persist();
    }
    // A question or an automatic failure prompt is not a report: it is never turned into
    // a user reminder, and no caller reaches here for one.
    if (reportSummary === undefined) return;
    const claim = notice.reminder;
    // Only a reminder the system refused before showing it may be tried again. A claim
    // that was submitted, or one whose call was still in flight, is never repeated, and
    // from then on the report keeps its own retry spacing untouched.
    if (claim && claim.state !== 'failed') return;
    // The retry backoff grows to five minutes on a name that has been failing for long,
    // which would hold the reminder minutes past its own time. Only the reminder's own
    // schedule is pulled forward to that time; the delivery keeps its backoff.
    const dueAt = Date.parse(notice.callbackMissingSince) + callbackReminderWait;
    if (Date.now() < dueAt) {
      if (!(notice.nextAttemptAt <= dueAt)) { notice.nextAttemptAt = dueAt; persist(); }
      return;
    }
    Object.assign(notice, { reminder: { id: `reminder-${notice.id}`, claimedAt: now(), state: 'claiming',
      attempts: (claim?.attempts ?? 0) + 1, missingSince: notice.callbackMissingSince } });
    // The claim is durable before anything is shown: a restarted monitor reads it back
    // and stays quiet instead of showing the same report twice.
    persist();
    let outcome;
    try {
      await notify(absentClaudeReportReminder({ name: record.name,
        sessionId: owner?.nativeSessionId ?? owner?.binding?.sessionId, summary: reportSummary }));
      outcome = { state: 'submitted', submittedAt: now() };
    } catch (failure) {
      outcome = failure?.beforeSubmit === true
        ? { state: 'failed', error: safeError(failure) }
        : { state: 'unknown', error: safeError(failure) };
    }
    notice.reminder = { ...notice.reminder, ...outcome };
    persist();
  }

  /**
   * A Codex owner's notification marker sits in the first user message, which a
   * summary page already carries. Only when that is absent do we read the few
   * turns started (or still running) after the attempt, one turn at a time.
   * `complete` is false when the summary page was not the whole relevant window.
   */
  async function findCodexNotice(owner, notice, hasMarker) {
    const summary = await readCodexOwnerTurns(owner.threadId, { limit: 30, itemsView: 'summary' }, { nativeRequest });
    if (hasMarker(summary)) return { delivered: true, complete: true };
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
        if (hasMarker(page)) return { delivered: true, complete: true };
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

  async function deliver(record, notice, text, {
    persist = () => store.save(record), allowSend = true, submission = false, reportSummary = undefined,
  } = {}) {
    if (notice.state === 'delivered') return;
    if (notice.state === 'blocked') return;
    // Only the report's own createdAt (or the notice's creation time) may date it.
    // An old row with no real timestamp is expired, never stamped with "now".
    if (!Number.isFinite(Date.parse(notice.createdAt ?? ''))) {
      blockUndelivered(notice, 'expired', 'This notice has no original creation time. Its body is kept and it was not sent.');
      persist();
      return;
    }
    // A monitor restart can release many old rows at once. Never flood the chat:
    // anything older than six hours is terminal, and anything still unconfirmed
    // after thirty minutes stops waiting so later notices and new tasks can move.
    if (noticeAge(notice) >= EXPIRE_UNSENT_AFTER_MS) {
      blockUndelivered(notice, 'expired', notice.attempts
        ? `This notice could not be delivered for 6 hours (${notice.attempts} attempts). Its body is kept.`
        : 'This notice was created more than 6 hours ago and was never sent. Its body is kept.');
      persist();
      return;
    }
    // Thirty minutes counts from the send. A final that waited longer than that for
    // its task tree was never sent at all; for a notice nobody has tried to deliver,
    // the six-hour expiry above is the only age limit.
    const sent = Boolean(notice.attemptedAt) || awaitingNoticeReceipt(notice);
    const owner = store.owner(record.ownerId);
    const claude = owner?.source === 'claude-desktop' || Boolean(owner?.nativeSessionId);
    // A notice written by the old reader may already be over thirty minutes old
    // when this build first sees it. Give that notice one versioned, paginated,
    // read-only scan of the transcript as it stood at this first sight. Evidence
    // found there is delivered; reaching that fixed cutoff without evidence falls
    // back to the existing timeout rule. Already blocked notices returned above.
    const claudeRescanPending = claude && awaitingNoticeReceipt(notice)
      && (notice.receiptParser !== CLAUDE_RECEIPT_PARSER
        || (notice.receiptScan?.parser === CLAUDE_RECEIPT_PARSER && notice.receiptScan.complete !== true));
    if (sent && attemptAge(notice) >= UNCONFIRMED_AFTER_MS && claudeRescanPending) {
      notice.id ??= uid('notice');
      let settled;
      try { settled = await findClaudeNoticeReceipt(owner, notice); }
      catch {
        // The binding may fail before findClaudeReceipt can record a scan. At the
        // deadline an unreadable channel is no evidence, so settle it on the
        // existing timeout rule instead of leaving an eternal unknown.
        notice.receiptScan = { parser: CLAUDE_RECEIPT_PARSER, complete: true };
      }
      if (settled) {
        Object.assign(notice, { state: 'delivered', deliveredAt: now(), recovered: true, receipt: settled, error: undefined });
        persist();
        return;
      }
      if (notice.receiptScan?.complete !== true) {
        notice.state = 'unknown';
        persist();
        return;
      }
    }
    if (sent && attemptAge(notice) >= UNCONFIRMED_AFTER_MS) {
      blockUndelivered(notice, 'unconfirmed', 'Delivery could not be confirmed within 30 minutes. Its body is kept.');
      persist();
      return;
    }
    // Waiting on a final's tree cannot disable the expiry rule. A successful
    // tree proof clears this timer and sends it through the same notice path.
    if (!allowSend && !awaitingNoticeReceipt(notice)) {
      if (!notice.waitingForTree) {
        notice.waitingForTree = true;
        notice.nextAttemptAt = Date.parse(notice.createdAt) + EXPIRE_UNSENT_AFTER_MS;
        persist();
      }
      return;
    }
    if (notice.nextAttemptAt && notice.nextAttemptAt > Date.now()) return;
    notice.id ??= uid('notice');
    notice.attempts = (notice.attempts ?? 0) + 1;
    notice.nextAttemptAt = Date.now() + retryDelayMs(notice.attempts);
    const marker = `<!-- futureaide-control:${notice.id} -->`;
    const markers = [marker, ...(notice.readbackIds ?? []).map(id => `<!-- futureaide-control:${id} -->`)];
    const hasMarker = value => {
      const content = JSON.stringify(value);
      return markers.some(entry => content?.includes(entry));
    };
    // These exact legacy failures happened before sendClaude opened a socket. They
    // can resume; other unknown outcomes stay read-only.
    if (!submission && claude && notice.state === 'unknown' && claudeNeverWritten(notice)) notice.state = 'pending';
    if (awaitingNoticeReceipt(notice)) {
      try {
        if (claude) {
          // The native receipt is the request id itself: our envelope uuid survives
          // as the queue/attachment/user uuid. Transcript text is truncated at 8k,
          // so a long report's trailing marker is never reliable — deliveries are.
          // The scan starts at this notice's own cursor, so a long parent chat is
          // never rescanned and a page boundary simply continues on the next poll.
          const settled = await findClaudeNoticeReceipt(owner, notice);
          Object.assign(notice, settled
            ? { state: 'delivered', deliveredAt: now(), recovered: true, receipt: settled, error: undefined }
            : { state: 'unknown' });
        } else if (typeof nativeRequest === 'function') {
          const found = await findCodexNotice(owner, notice, hasMarker);
          if (found.delivered) {
            Object.assign(notice, { state: 'delivered', deliveredAt: now(), recovered: true, error: undefined });
          } else if (!submission && found.complete && Date.now() - (Date.parse(notice.attemptedAt ?? notice.createdAt ?? '') || Date.now()) >= CONFIRM_ABSENCE_AFTER_MS && !notice.resendAttempted) {
            // The whole relevant turn window was read and the marker is absent.
            // Re-send exactly once; this is no longer a blind write.
            Object.assign(notice, { state: 'pending', resendAttempted: true, nextAttemptAt: undefined, error: undefined });
          } else notice.state = 'unknown';
        } else {
          // No debug port: the ordinary app-tools read remains the fallback.
          const history = await codexOwnerCall(owner.threadId, 'read_thread', {
            threadId: owner.threadId, turnLimit: 30, includeOutputs: true, maxOutputCharsPerItem: 100000,
          });
          if (!history?.isError && hasMarker(history)) {
            Object.assign(notice, { state: 'delivered', deliveredAt: now(), recovered: true, error: undefined });
          } else notice.state = 'unknown';
        }
      } catch (error) {
        if (terminalCodexOwnerError(error)) blockCodexNotice(record, notice, error);
        else notice.state = 'unknown';
      }
      persist();
      return;
    }
    // A newly confirmed channel rejection must not rewrite an older ambiguous
    // delivery: the read-back branch above remains its only recovery path.
    if (record.callbackBlocked) { notice.state = 'blocked'; persist(); return; }
    try { await (claude ? claudeNoticeBinding(owner) : verifyOwner(owner)); }
    catch (error) {
      if (!claude && terminalCodexOwnerError(error)) {
        blockCodexNotice(record, notice, error);
        persist();
        return;
      }
      Object.assign(notice, { state: 'pending', error: safeError(error) });
      // Only a real report to a Claude owner has anything to tell the user about; a
      // question, an automatic failure prompt and every Codex row keep their own fields.
      if (claude && reportSummary !== undefined) {
        await noteClaudeAbsence(record, owner, notice, error, { persist, reportSummary });
      }
      persist();
      return;
    }
    // The lookup above proves nothing by itself: a saved binding is only re-validated
    // when the write happens, so an absence can only be ended below, by a write the
    // session accepted. A previous attempt may also have reached the desktop, so a second
    // copy is never sent blindly.
    Object.assign(notice, { state: 'sending', attemptedAt: now() });
    persist();
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
        // The parser version is recorded with that pre-send cursor, so a notice
        // written by this build is never mistaken for one that needs a backscan.
        notice.receiptParser = CLAUDE_RECEIPT_PARSER;
        notice.cursor = await transcriptCursor(binding).catch(() => undefined);
        const send = target => claudeSend(target, `${text}\n\n${marker}`, { requestId: claudeNoticeRequestId(notice.id) });
        const resend = async () => {
          const fresh = await refreshClaudeBinding(owner);
          notice.receiptParser = CLAUDE_RECEIPT_PARSER;
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
        else {
          // An accepted write is the only proof the session is there again, so the
          // absence ends here and any later one starts its own wait.
          Object.assign(notice, { state: 'unknown', error: undefined });
          delete notice.callbackMissingSince;
        }
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
      else {
        Object.assign(notice, { state: claude ? 'pending' : 'unknown', error: safeError(error) });
        // A binding refreshed mid-send that finds no session is the same definite
        // absence the verify above reports, and nothing reached the session.
        if (claude && reportSummary !== undefined) {
          await noteClaudeAbsence(record, owner, notice, error, { persist, reportSummary });
        }
      }
    }
    persist();
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
    const candidates = (sessions ?? []).filter(item => String(item.sessionId).toLowerCase() === wanted);
    if (!candidates.length) throw Object.assign(new Error('The Claude session that owns this name is not running.'),
      { code: 'callback-target-missing' });
    // A crashed process leaves its record behind and Windows reuses its pid, so the
    // same session can be listed twice. Only the record whose process really is the
    // session binds; trying just the first one listed could miss the live session on
    // every attempt.
    let failure;
    for (const session of candidates) {
      // Same native session, same parent context: only the transport binding is
      // refreshed, never the conversation it belongs to.
      let binding;
      try { binding = await claudeBind({ pid: session.pid, sessionId: session.sessionId, workspace: owner.workspace }); }
      catch (error) { failure = error; continue; }
      store.saveOwner({ ...(store.owner(owner.ownerId) ?? owner), hostSessionId: owner.nativeSessionId, binding });
      store.rebindOwner(owner.ownerId, binding);
      return binding;
    }
    throw failure;
  }

  /**
   * Read one Claude notice's native receipt, refreshing a binding the session has
   * outgrown once. Used both by the normal read-back and the bounded upgrade scan.
   */
  async function findClaudeNoticeReceipt(owner, notice) {
    let binding;
    try {
      binding = await claudeNoticeBinding(owner);
      return await findClaudeReceipt(binding, notice, claudeReadEvents);
    } catch (error) {
      if (!claudeBindingStale(error)) throw error;
      binding = await refreshClaudeBinding(owner);
      return findClaudeReceipt(binding, notice, claudeReadEvents);
    }
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
    if (record.modelPin && !dshDefaultOnly(record)) {
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
    if (record.task.cancelRequested) store.save(record);
    else saveDispatch(record);
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
        ? { model: record.task.modelSelection, freezeModel: true,
          selectionExplicit: record.task.selectionExplicit === true } : {};
      await sendDispatch(record, record.task.message, 'task', [], record.task.requestId, observed, frozen);
    } finally { trackWorkspaceBaseline(record, baseline); }
  }

  async function resolveAnswer(record, answer) {
    if (answer.questionIds) return true;
    const backend = await backendFor(record);
    if (roundMovedOn(record)) throw dispatchRefused();
    const item = store.supplement(answer.answerId);
    if (item && dispatchExpired(item.created)) {
      expireInput(record, undefined, item);
      saveDispatch(record);
      return false;
    }
    let result;
    try {
      const canAnswer = () => {
        const latest = store.get(record.agentId);
        return !roundMovedOn(record, latest) && !latest.task.cancelRequested && (!item || !dispatchExpired(item.created));
      };
      result = await backend.answer({ answerId: answer.answerId, message: answer.message,
        ...(targetOf(record) === 'codex-desktop' ? { canAnswer } : {}) });
    } catch (error) {
      if (targetOf(record) === 'codex-desktop' && NATIVE_ANSWER_REFUSALS.has(error.code)) {
        Object.assign(answer, { dispatched: true, undelivered: error.code });
        if (item) store.setSupplement(item.requestId, 'blocked', error.code);
        saveDispatch(record);
      }
      throw error;
    }
    if (!result.consumedQuestionIds?.length) throw new Error('This subagent has no unanswered question.');
    answer.questionIds = result.consumedQuestionIds;
    if (result.nativeAnswered === true) {
      answer.dispatched = true;
      answer.nativeAnswered = true;
      answer.delivery = 'answered';
      answer.accepted = true;
      // A native card reply lands in the turn that asked. Read that exact root turn
      // once so the receipt names it instead of leaving the caller to infer it.
      if (targetOf(record) === 'codex-desktop') {
        try {
          const root = await rootTurnFor(record);
          if (root.known && root.turnId) answer.turnId = root.turnId;
        } catch { /* the answer already succeeded; its route stays as the card path */ }
      }
      if (record.observation?.questions) record.observation.questions = record.observation.questions.map(question =>
        answer.questionIds.includes(question.id) ? { ...question, state: 'answered' } : question);
    } else {
      answer.continuation = result.continuation ?? `主控回答：\n${answer.message}\n请继续完成原任务。`;
      if (result.nativeFallback === true) answer.nativeFallback = true;
    }
    saveDispatch(record);
    return true;
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
    if (task.cancelRequested) return undefined;
    const ready = [];
    let expired = false;
    let queuedAnswer;
    for (const answer of task.answers ?? []) {
      if (answer.dispatched || !answer.questionIds) continue;
      const item = store.supplement(answer.answerId);
      const created = item?.created ?? answer.created;
      if (created && dispatchExpired(created)) {
        // The original input is already six hours old. There is no native write for a
        // never-dispatched continuation, so nothing can be accepted; record the age as
        // a settled blocked input instead of writing it or holding the final forever.
        const placeholder = { requestId: item?.requestId ?? answer.answerId, kind: 'answer',
          answerIds: [...answer.questionIds], state: 'unknown', accepted: false,
          startedAt: created, requestedAt: created };
        task.dispatches.push(placeholder);
        expireInput(record, placeholder, item);
        placeholder.state = 'unknown';
        Object.assign(answer, { dispatched: true, undelivered: 'dispatch-expired', delivery: 'unknown' });
        expired = true;
        continue;
      }
      // A supplement used as an answer keeps its original request ID and
      // enqueue time all the way to the adapter's last send check.
      if (item) {
        if (!ready.length) { ready.push(answer); queuedAnswer = item; }
        break;
      }
      ready.push(answer);
    }
    if (expired) saveDispatch(record);
    if (!ready.length) return undefined;
    for (const answer of ready) answer.dispatched = true;
    const last = ready.at(-1);
    const frozen = Object.prototype.hasOwnProperty.call(last, 'modelSelection')
      ? { model: last.modelSelection, freezeModel: true,
        selectionExplicit: last.selectionExplicit === true,
        ...(last.created ? { requestedAt: last.created } : {}) } : {};
    const dispatch = await sendDispatch(record, ready.map(answer => answer.continuation).join('\n\n'), 'answer',
      ready.flatMap(answer => answer.questionIds), queuedAnswer?.requestId ?? last.answerId, view, frozen);
    // The answer's own inspect row must carry the route the native write actually took.
    // A later poll cannot reconstruct which turn received the text from the name state.
    for (const answer of ready) {
      Object.assign(answer, {
        delivery: dispatch.accepted ? 'answered'
          : dispatch.delivery === 'unknown' ? 'unknown' : 'answer-pending',
        ...(dispatch.turnId ? { turnId: dispatch.turnId } : {}),
        ...(dispatch.afterTurnId ? { afterTurnId: dispatch.afterTurnId } : {}),
        accepted: dispatch.accepted === true,
      });
    }
    saveDispatch(record);
    return dispatch;
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
  async function deliverReports(record, { readOnDemand = false } = {}) {
    await drainSubmissions(record, { currentOnly: true, readOnDemand });
    let finalTerminal = true;
    for (const report of record.task?.reports ?? []) {
      if (fromSubmission(report.id)) {
        if (report.final && !terminalNotice(report.delivery)) finalTerminal = false;
        continue;
      }
      // Prefer the report's own time. An old fixture/report without one may use the
      // task's start time (still a real time); a truly timeless old notice expires.
      const reportCreated = report.createdAt ?? record.task?.startedAt;
      if (reportCreated) report.delivery.createdAt = reportCreated;
      if (report.failure) {
        await deliver(record, report.delivery, report.message);
        continue;
      }
      if (report.final && !report.treeSettledConfirmed) { finalTerminal = false; continue; }
      await deliver(record, report.delivery, `${hostLabel(record)}「${record.name}」${report.final ? '交付' : '汇报'}：\n${report.message}`,
        { reportSummary: report.message });
      // An older non-final notice must never hold back the final report that
      // follows it. The final report itself still has to reach a terminal state.
      if (report.final && !terminalNotice(report.delivery)) finalTerminal = false;
    }
    return finalTerminal;
  }

  const questionPrompt = (record, message) =>
    `${hostLabel(record)} 子代理「${record.name}」等待回答：\n${message}\n\n请调用 futureaide_answer_agent，name=${JSON.stringify(record.name)}，message 为回答正文。任务保持等待；无需文件、命令或内部编号。`;

  async function deliverQuestions(record, questions) {
    for (const question of questions) {
      if (fromSubmission(question.id)) continue;
      if (targetOf(record) === 'codex-desktop' && typeof question.id === 'string' && question.id.startsWith('native-')
          && !presentedNativeQuestion(record)
          && readParentSubmissions(record).questions.some(pending =>
            !record.task.answers?.some(answer => answer.questionIds?.includes(pending.id)))) continue;
      record.task.questionNotices ??= {};
      const notice = record.task.questionNotices[question.id] ??= { state: 'pending', createdAt: question.createdAt ?? now() };
      await deliver(record, notice, questionPrompt(record, question.message));
    }
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
      if (!fromSubmission(report.id) && awaitingNoticeReceipt(notice)) notice.nextAttemptAt = undefined;
    }
    store.save(record);
    await deliverReports(record, { readOnDemand: true });
    const task = record.task;
    const final = (task?.reports ?? []).find(report => report.final);
    // The same finish gate a poll uses, so a settled report closes its task once.
    if (final?.treeSettledConfirmed && task.result
        && task.reports.filter(report => report.final).every(report => terminalNotice(report.delivery))) await finishDeliveredReport(record);
  }

  async function requireSettledSubmissions(record) {
    const taskId = record.task?.taskId;
    const count = taskId ? store.submissionDebt(record.agentId, taskId) : 0;
    if (!count) return;
    await ensureWorker(record, { wake: true, hasSubmission: true });
    throw Object.assign(new Error(`上一轮还有 ${count} 条请示或回报未送达。请等投递确认或进入终态后重试。`),
      { code: 'previous-delivery-pending', retryable: true, count });
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
      return afterTerminal(record);
    }
    if (record.lifetime === 'once' && task.state === 'completed' && finalDelivered) {
      if (store.claimAutoCleanup(record)) return clearRecord(record, { autoClaimed: true });
      const hold = store.autoCleanupHold(record.agentId);
      if (hold.pending || hold.blocked) {
        record.state = hold.pending ? 'delivery_pending'
          : store.supplementSummary(record.agentId, task.taskId).blocked ? 'supplement_blocked' : 'idle';
        if (hold.blocked) task.autoCleanupHeld = true;
        store.save(record);
        return hold.pending ? publicResult(record) : afterTerminal(record);
      }
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
    return afterTerminal(record);
  }

  async function finishReports(record, view) {
    const task = record.task;
    task.reports ??= [];
    // An observation can see a newly accepted callback, but only its submission
    // row can project or send it. Absorb again before proving the final gate.
    await drainSubmissions(record, { currentOnly: true });
    for (const incoming of view.reports ?? []) {
      if (incoming.taskId !== task.taskId || typeof incoming.id !== 'string'
          || typeof incoming.message !== 'string' || !incoming.message.trim()
          || typeof incoming.final !== 'boolean') throw new Error('The bridge returned an invalid explicit report.');
      if (fromSubmission(incoming.id)) continue;
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
      task.result = { state: task.cancelRequested || task.state === 'cancelled' || rootSummary(view)?.state === 'cancelled' ? 'cancelled' : task.state === 'failed' || rootSummary(view)?.state === 'failed' ? 'failed' : 'completed',
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
    return afterTerminal(record);
  }

  /**
   * The ticket a release attempt is made with, written under the name lock and nothing
   * else: the remote call runs outside it, so assigning the next task never waits on an
   * unload. A dispatch invalidates the ticket, and the host re-reads the same fence at the
   * point where it would send the unsubscribe.
   */
  function prepareRelease(record) {
    const taskId = record.task?.taskId;
    if (!taskId) return undefined;
    const attempts = (record.releaseState?.taskId === taskId ? record.releaseState.attempts ?? 0 : 0) + 1;
    const ticket = uid('release');
    // The attempt keeps its own bounded re-check time while it is out. A worker that dies
    // during the call therefore leaves a round the sweep can pick up again, and a poll
    // before that moment cannot re-send for the same round. Only a verdict replaces it.
    const nextCheckAt = Date.now() + RELEASE_RECHECK_MS;
    record.releaseState = { taskId, ticket, state: 'sending', attempts, at: now(), nextCheckAt };
    record.nextAttemptAt = nextCheckAt;
    fastPoll.delete(record.agentId); urgentPoll.delete(record.agentId); nextPollAt.delete(record.agentId);
    store.save(record);
    return ticket;
  }

  /**
   * The synchronous answer the host asks for at its own critical point: may this request
   * still land? It reads the roster directly, so a dispatch or a parent message that
   * arrived during the call wins without any coordination.
   * @returns {boolean} False means the host must not send the unsubscribe.
   */
  function canReleaseNow(agentId, taskId, ticket) {
    const record = store.get(agentId);
    if (!record || record.closed) return false;
    if (record.task?.taskId !== taskId) return false;
    if (record.releaseState?.ticket !== ticket || record.releaseState.taskId !== taskId) return false;
    // Absorbed is not the same as gone. Another poll can fold a late ask into this round's
    // questions and empty the inbox, which would leave the old ticket looking valid, so the
    // whole gate is re-read here: terminal state, nothing owed, nothing queued.
    if (!['idle', 'failed', 'cancelled'].includes(record.state)) return false;
    if (owesWork(record)) return false;
    if (store.submissionDebt(agentId, taskId)) return false;
    const view = record.observation;
    const settled = view && view.stale !== true ? treeSettled(record, view) : undefined;
    return canReleaseThreads(record, store.supplements(agentId), settled);
  }

  /**
   * One release attempt, outside every name lock and outside the poll's in-flight entry:
   * the round that asked for it is already over, and a slow unload must never hold up the
   * next dispatch for this name.
   */
  function startRelease({ agentId, taskId, ticket }) {
    // A newer ticket must not be dropped because an older attempt for the same name is
    // still in the air: it waits its turn and then runs on its own ticket, while the older
    // one is refused by the fence when it reaches its critical point.
    const previous = releaseInflight.get(agentId);
    const work = (previous ? previous.catch(() => {}) : Promise.resolve())
      .then(() => runRelease(agentId, taskId, ticket));
    const tracked = work.catch(() => {}).finally(() => {
      if (releaseInflight.get(agentId) === tracked) releaseInflight.delete(agentId);
    });
    releaseInflight.set(agentId, tracked);
    return tracked;
  }

  async function runRelease(agentId, taskId, ticket) {
    const record = store.get(agentId);
    if (!record) return;
    const controller = new AbortController();
    releaseSignals.set(agentId, controller);
    try {
      let backend;
      try { backend = await backendFor(record); }
      catch (error) { await finishRelease(agentId, taskId, ticket, { state: 'deferred', reason: safeError(error) }); return; }
      // A build without the release path keeps today's behaviour; the ticket simply ends.
      if (typeof backend.releaseIdleThreads !== 'function') {
        await finishRelease(agentId, taskId, ticket, { state: 'deferred', reason: 'release-unsupported' });
        return;
      }
      let outcome;
      try {
        // The ticket travels with the request: the adapter stores its own release document
        // under the same fence, so a round that moves on cannot keep an old attempt alive.
        outcome = await backend.releaseIdleThreads({ taskId, ticket,
          canRelease: () => canReleaseNow(agentId, taskId, ticket), signal: controller.signal });
      } catch (error) { outcome = { state: 'deferred', reason: safeError(error) }; }
      await finishRelease(agentId, taskId, ticket, outcome ?? {});
    } finally {
      if (releaseSignals.get(agentId) === controller) releaseSignals.delete(agentId);
    }
  }

  /**
   * Write the verdict back only onto the same round and the same ticket. A dispatch that
   * arrived while the request was out has already invalidated both, and its round stands.
   */
  async function finishRelease(agentId, taskId, ticket, outcome) {
    let scheduled = false;
    try {
      await store.locked(agentId, () => {
        const record = store.get(agentId);
        if (!record || record.task?.taskId !== taskId) return;
        if (record.releaseState?.ticket !== ticket) return;
        // Only the target's own complete answer is a release: a guard, an unfinished idle
        // grace and a transport failure are all "not confirmed" and are never recorded as
        // done.
        const state = ['complete', 'waiting', 'deferred'].includes(outcome?.state) ? outcome.state : 'deferred';
        const attempts = record.releaseState.attempts ?? 1;
        const delay = state === 'complete' ? undefined : releaseRetryDelay(attempts, outcome?.reason);
        record.releaseState = { taskId, ticket, state, attempts, at: now(),
          ...(delay === undefined ? {} : { nextCheckAt: Date.now() + delay }),
          ...(outcome?.reason === undefined ? {} : { reason: outcome.reason }) };
        record.nextAttemptAt = record.releaseState.nextCheckAt;
        scheduled = record.nextAttemptAt !== undefined;
        store.save(record);
      }, { waitMs: 5000 });
    } catch { /* A lock that stayed busy loses only this verdict; the next touch re-asks. */ }
    // Only a schedule that was actually written needs the listener. A verdict written onto
    // a ticket that no longer exists asks for nothing and must not start one.
    if (scheduled) { try { await ensureMonitor(); } catch { /* the next sweep retries */ } }
  }

  /**
   * Drop the schedule this release wrote for its own task, and nothing else. A retry
   * stamp belonging to another target or to a name under the switch is never touched.
   */
  function stopRecheck(record) {
    if (!inReleasePath(record) || releaseRecheckAt(record) === undefined) return;
    record.nextAttemptAt = undefined;
    store.save(record);
  }

  /**
   * A new round invalidates any release attempt at once: the ticket stops matching, the
   * host's own check refuses, and a signal in the air is cancelled.
   */
  function invalidateRelease(record) {
    const scheduled = record.releaseState?.nextCheckAt !== undefined
      && record.releaseState.nextCheckAt === record.nextAttemptAt;
    if (record.releaseState === undefined && !scheduled) return false;
    delete record.releaseState;
    if (scheduled) record.nextAttemptAt = undefined;
    const controller = releaseSignals.get(record.agentId);
    if (controller) { controller.abort(); releaseSignals.delete(record.agentId); }
    return true;
  }

  /** Is this round still owed a write, a notice or an answer? */
  function owesWork(record) {
    if (hasPendingDelivery(record)) return true;
    const task = record.task;
    if (task?.taskId && store.submissionDebt(record.agentId, task.taskId)) return true;
    if ((task?.answers ?? []).some(answer => !answer.dispatched && !answer.undelivered)) return true;
    if (store.supplements(record.agentId).some(item => item.task === task?.taskId && item.status !== 'blocked')) return true;
    return (record.observation?.questions ?? []).some(question => question.state === 'pending');
  }

  /**
   * End a round: decide whether a release is due and, if it is, leave only a ticket
   * behind. The remote call is started by the caller after the name lock is released, so
   * the verdict can never hold up the next dispatch for this name.
   */
  async function afterTerminal(record) {
    const result = publicResult(record);
    try {
      if (config.idleSessionCleanup === false || targetOf(record) !== 'codex-desktop'
          || !['persistent', 'once'].includes(record.lifetime)) return result;
      const taskId = record.task?.taskId;
      if (record.task?.treeUnavailable || (taskId && store.submissionDebt(record.agentId, taskId))) return result;
      if (!releaseDue(record.releaseState, taskId)) return result;
      const view = record.observation;
      const settled = view && view.stale !== true ? treeSettled(record, view) : undefined;
      // A round that stopped owing the release again —a supplement arrived, a notice is on
      // its way once more —must not keep the sweep waking for it.
      if (!canReleaseThreads(record, store.supplements(record.agentId), settled)) { stopRecheck(record); return result; }
      const ticket = prepareRelease(record);
      if (ticket) result.releaseAttempt = { agentId: record.agentId, taskId, ticket };
    } catch (error) {
      record.releaseState = { taskId: record.task?.taskId, state: 'deferred', attempts: 0, at: now(), reason: safeError(error) };
      store.save(record);
    }
    return result;
  }

  function waitForTree(record, view, summaryOnly = false) {
    record.state = record.task.state = 'running';
    record.observation = { ...view, activity: summaryOnly ? `Waiting for the top-level ${hostLabel(record)} summary` : `Waiting for the ${hostLabel(record)} task tree and notifications to settle` };
    store.save(record);
    return publicResult(record);
  }

  async function recoverDispatch(record, dispatch, { allowResend = true } = {}) {
    if (dispatch.accepted || !['sending', 'retrying', 'unknown', 'queued'].includes(dispatch.state)) return;
    if (dispatch.nextAttemptAt > Date.now()) return;
    // The backend owns its own receipt format; undefined means this saved intent
    // never reached a native write.
    const receipt = await (await backendFor(record)).receipt({ requestId: dispatch.requestId });
    if (!receipt) {
      if (!['sending', 'retrying', 'queued'].includes(dispatch.state)) return;
      // The receipt is written before entering the native send. No receipt means
      // this intent never reached that send; keep the exact request ID. A direct
      // answer or a first task dispatch has no supplement row, so this loop is the
      // only place that can retry it after a transient root read.
      if (!allowResend) return 'not-sent';
      await dispatchOnce(record, dispatch);
      return;
    }
    dispatch.afterSeq = receipt.afterSeq ?? dispatch.afterSeq;
    if (receipt.delivery === 'after-current' || receipt.delivery === 'local-pending') {
      Object.assign(dispatch, { state: 'queued', accepted: false, delivery: receipt.delivery,
        ...(receipt.afterTurnId ? { afterTurnId: receipt.afterTurnId } : {}) });
      return;
    }
    if (receipt.status === 'accepted') Object.assign(dispatch, { accepted: true, state: 'running', error: undefined, failure: undefined, nextAttemptAt: undefined, retryAttempts: undefined,
      delivery: receipt.delivery ?? dispatch.delivery ?? 'accepted-route-unknown',
      ...(receipt.turnId ? { turnId: receipt.turnId } : {}),
      ...(receipt.afterTurnId ? { afterTurnId: receipt.afterTurnId } : {}) });
    if (receipt.status === 'accepted' && receipt.delivery === 'current-turn') delete dispatch.afterTurnId;
    if (receipt.status === 'rejected') dispatch.state = 'failed';
    if (receipt.status === 'retryable') {
      if (!allowResend) return 'not-sent';
      await dispatchOnce(record, dispatch);
    }
  }

  async function expiredReceipt(record, dispatch) {
    if (!dispatch) return 'not-sent';
    if (dispatch.accepted === true) return 'accepted';
    try {
      const backend = await backendFor(record);
      const receipt = await backend.receipt({ requestId: dispatch.requestId });
      dispatch.afterSeq = receipt?.afterSeq ?? dispatch.afterSeq;
      if (receipt?.status === 'accepted') {
        Object.assign(dispatch, { accepted: true, state: 'running', error: undefined,
          delivery: receipt.delivery ?? dispatch.delivery ?? 'accepted-route-unknown',
          ...(receipt.turnId ? { turnId: receipt.turnId } : {}),
          ...(receipt.afterTurnId ? { afterTurnId: receipt.afterTurnId } : {}),
          nextAttemptAt: undefined, retryAttempts: undefined });
        if (receipt.delivery === 'current-turn') delete dispatch.afterTurnId;
        return 'accepted';
      }
      if (['rejected', 'retryable', 'failed'].includes(receipt?.status)
          || (!receipt && ['sending', 'retrying', 'failed'].includes(dispatch.state))) return 'not-sent';
      const turn = await backend.turn({ requestId: dispatch.requestId,
        ...(Number.isSafeInteger(dispatch.afterSeq) ? { afterSeq: dispatch.afterSeq } : {}),
        timeoutSeconds: 0, maxMessages: 100 });
      if (turn?.correlation === 'request-id' && ['running', 'ended'].includes(turn.state)) {
        Object.assign(dispatch, { accepted: true, state: turn.state === 'running' ? 'running' : endedState(turn.completionReason),
          error: undefined, nextAttemptAt: undefined, retryAttempts: undefined,
          ...(turn.state === 'ended' ? { endSeq: turn.endSeq, failure: turn.failure ?? modelTurnError(turn.completionReason) } : {}) });
        return 'accepted';
      }
    } catch { /* The original write could not be confirmed. */ }
    return 'unknown';
  }

  /**
   * Deliver every supplement that is due, in rowid order, under the schedule the
   * native root allows: an answer always takes the next turn; a steer joins the
   * running root; a queue starts one turn of its own only after the root is idle.
   * One call starts at most one new turn. Waiting is durable and never resent when
   * the write outcome is unknown.
   */
  async function drainSupplements(record, { view: suppliedView } = {}) {
    const task = record.task;
    if (!task) return;
    if (task.cancelRequested) store.blockQueued(record.agentId, task.taskId, 'task-cancelled');
    else if ((task.reports ?? []).some(report => report.final)) store.blockQueued(record.agentId, task.taskId, 'final-submitted');
    const sealed = task.cancelRequested || (task.reports ?? []).some(report => report.final);
    // An answer that is ready — or whose continuation is still an unaccepted local
    // intent — owns the next turn. Any queue behind it waits even when this same
    // poll already sees an idle root; the dispatch loop retries the answer first.
    const readyAnswers = (task.answers ?? []).some(answer => !answer.dispatched
      || (task.dispatches ?? []).some(dispatch => dispatch.kind === 'answer'
        && (dispatch.answerIds ?? []).includes(answer.answerId)
        && dispatch.accepted !== true && !['blocked', 'failed', 'cancelled'].includes(dispatch.state)));
    if (!sealed && (!(task.dispatches?.[0]?.accepted) || readyAnswers)) return;
    const target = targetOf(record);
    let view = suppliedView;
    const loadView = async () => view ??= await observe(record);
    let root;
    if (!sealed && target === 'codex-desktop') {
      try { root = await rootTurnFor(record); }
      catch { root = { known: false }; }
    }

    /** Start or steer this one input under its own request id and persist its receipt. */
    const startItem = async (item, mode) => {
      const current = store.get(record.agentId);
      if (!current || current.task?.taskId !== task.taskId) return undefined;
      // The entry's observation can go stale while the name lock waits. Re-read the
      // target's own state before a mode that only works while idle: a DSH queue and
      // a CLI steer must be refused, never written as the other mode.
      if ((target === 'dsh' && mode === 'queue') || (target === 'claude-cli' && mode === 'steer')) {
        const latest = await observe(record);
        if (latest.running === true) {
          saveSupplementReceipt(item.requestId, 'blocked', 'mode-unsupported',
            { delivery: 'blocked', mode, accepted: false, queued: false });
          return undefined;
        }
        view = latest;
      }
      store.setSupplement(item.requestId, 'sending');
      // Mutate the record this poll is saving, not a second copy: a later save of the
      // poll's own record would otherwise erase the dispatch this start just wrote.
      const targetRecord = record.task?.taskId === task.taskId ? record : current;
      const dispatch = await sendDispatch(targetRecord, item.message, 'supplement', [], item.requestId, view,
        { model: item.selection, freezeModel: true, mode,
          ...(item.selectionExplicit === undefined ? {}
            : { selectionExplicit: item.selectionExplicit === true }) });
      const receipt = dispatchReceipt(dispatch);
      if (dispatch.accepted) saveSupplementReceipt(item.requestId, 'accepted', null, receipt);
      else if (dispatch.delivery === 'after-current' || dispatch.delivery === 'local-pending'
        || dispatch.state === 'queued' || dispatch.state === 'retrying') saveSupplementReceipt(item.requestId, 'queued', null, receipt);
      else saveSupplementReceipt(item.requestId, dispatch.state === 'failed' ? 'blocked' : 'unknown',
        dispatch.error?.code ?? (dispatch.state === 'failed' ? 'send-failed' : 'acceptance-unknown'), receipt);
      return dispatch;
    };

    /** Later queue rows wait behind the turn that just opened, not the earlier one. */
    const retargetWaiting = (startedId, turnId) => {
      if (typeof turnId !== 'string' || !turnId) return;
      for (const other of store.supplements(record.agentId)) {
        if (other.requestId === startedId || other.mode !== 'queue' || other.status !== 'queued') continue;
        const prior = (task.dispatches ?? []).find(entry => entry.requestId === other.requestId);
        if (prior?.accepted === true) continue;
        saveSupplementReceipt(other.requestId, 'queued', null,
          { delivery: 'after-current', afterTurnId: turnId, mode: 'queue', accepted: false, queued: true });
      }
    };
    for (const item of store.supplements(record.agentId)) {
      // A blocked row keeps its original reason even when the task has since changed.
      if (item.status === 'blocked') continue;
      if (item.task !== task.taskId) { store.setSupplement(item.requestId, 'blocked', 'task-changed'); continue; }
      // The age check runs again immediately before the send, from the moment the caller
      // wrote the supplement: waiting behind anything does not extend its six hours.
      const current = store.get(record.agentId);
      if (!current || current.ownerId !== item.owner || current.sessionId !== item.session || current.task?.taskId !== item.task) {
        store.setSupplement(item.requestId, 'blocked', current?.task?.taskId !== item.task ? 'task-changed' : current?.task?.cancelRequested ? 'task-cancelled' : 'task-closed'); return;
      }
      if (dispatchExpired(item.created) && !(task.dispatches ?? []).some(dispatch => dispatch.requestId === item.requestId && dispatch.accepted === true)) {
        const prior = (task.dispatches ?? []).find(dispatch => dispatch.requestId === item.requestId);
        if (roundMovedOn(record)) throw dispatchRefused();
        expireInput(record, prior, item);
        saveDispatch(record);
        continue;
      }
      const prior = (task.dispatches ?? []).find(dispatch => dispatch.requestId === item.requestId);
      if (prior) {
        // A queue request that was never written waits under its original id. When the
        // root is idle it starts; while the root runs it stays after the same turn.
        if (prior.accepted !== true && (prior.state === 'queued' || prior.delivery === 'after-current' || prior.delivery === 'local-pending')) {
          if (sealed) {
            prior.state = 'blocked';
            saveSupplementReceipt(item.requestId, 'blocked', record.task.cancelRequested ? 'task-cancelled' : 'final-submitted');
            saveDispatch(record);
            continue;
          }
          if (target === 'codex-desktop') {
            if (!root || root.known === false) {
              saveSupplementReceipt(item.requestId, 'queued', null, { ...dispatchReceipt(prior), delivery: 'local-pending' });
              return;
            }
            if (root.running) {
              if (prior.mode === 'queue') {
                Object.assign(prior, { state: 'queued', delivery: 'after-current', afterTurnId: root.turnId });
                saveSupplementReceipt(item.requestId, 'queued', null, dispatchReceipt(prior));
                saveDispatch(record);
                continue;
              }
              // A steer that was only queued locally still belongs in the running turn.
            }
          }
          await dispatchOnce(record, prior, view);
          if (prior.accepted) {
            saveSupplementReceipt(item.requestId, 'accepted', null, dispatchReceipt(prior));
            continue;
          }
          saveSupplementReceipt(item.requestId, prior.state === 'failed' ? 'blocked'
            : prior.state === 'unknown' ? 'unknown' : 'queued',
          prior.error?.code ?? null, dispatchReceipt(prior));
          if (prior.state !== 'queued' && prior.state !== 'retrying') return;
          continue;
        }
        const recovered = await recoverDispatch(record, prior, { allowResend: false });
        if (prior.expired) {
          store.setSupplement(item.requestId, 'blocked', prior.expired);
          continue;
        }
        if (recovered === 'not-sent') {
          const latestView = sealed ? undefined : await loadView();
          if (sealed || (latestView.reports ?? []).some(report => report.final)) {
            store.setSupplement(item.requestId, 'blocked', record.task.cancelRequested ? 'task-cancelled' : 'final-submitted');
            prior.state = 'blocked';
            store.save(record);
            continue;
          }
          await dispatchOnce(record, prior, latestView);
        }
        if (!prior.accepted && prior.state !== 'failed' && Number.isSafeInteger(prior.afterSeq)) {
          const observed = await (await backendFor(record)).turn({ requestId: prior.requestId,
            afterSeq: prior.afterSeq, timeoutSeconds: 0, maxMessages: 100 });
          if (observed.state === 'ended' && observed.correlation === 'request-id') Object.assign(prior,
            { accepted: true, state: endedState(observed.completionReason), endSeq: observed.endSeq, error: undefined, nextAttemptAt: undefined, retryAttempts: undefined,
              failure: observed.failure ?? modelTurnError(observed.completionReason) });
        }
        store.save(record);
        if (prior.accepted) { saveSupplementReceipt(item.requestId, 'accepted', null, dispatchReceipt(prior)); continue; }
        saveSupplementReceipt(item.requestId, prior.state === 'failed' ? 'blocked' : 'unknown',
          prior.error?.code ?? (prior.state === 'failed' ? 'send-failed' : 'acceptance-unknown'), dispatchReceipt(prior));
        return;
      }
      const priorAnswer = (record.task.answers ?? []).find(answer => answer.answerId === item.requestId);
      if (priorAnswer && sealed) {
        saveSupplementReceipt(item.requestId, priorAnswer.questionIds ? 'accepted' : 'unknown',
          priorAnswer.questionIds ? null : 'answer-confirmation-unknown',
          { delivery: priorAnswer.questionIds ? 'answer-pending' : 'unknown' });
        if (!priorAnswer.questionIds) return;
        continue;
      }
      if (current.closed || current.task.cancelRequested || ['cleaning','cleanup_failed','cancelled','failed','idle','delivery_pending'].includes(current.state)) {
        store.setSupplement(item.requestId, 'blocked', current.task.cancelRequested ? 'task-cancelled' : 'task-closed'); continue;
      }
      if (priorAnswer) {
        if (!priorAnswer.questionIds) await answerLocked(record, item.message, item.requestId,
          { modelSelection: item.selection ?? null, selectionExplicit: item.selectionExplicit === true,
            created: item.created });
        if (store.supplement(item.requestId)?.status !== 'blocked') {
          saveSupplementReceipt(item.requestId, 'accepted', null,
            { delivery: priorAnswer.nativeAnswered ? 'answered' : 'answer-pending', mode: 'steer' });
        }
        if (!priorAnswer.dispatched) return;
        continue;
      }
      const scheduled = await loadView();
      if ((scheduled.reports ?? []).some(report => report.final)) {
        store.blockQueued(record.agentId, record.task.taskId, 'final-submitted');
        store.setSupplement(item.requestId, 'blocked', 'final-submitted'); return;
      }
      const mode = item.mode === 'queue' ? 'queue' : 'steer';
      const pendingQuestion = (scheduled.questions ?? []).some(question => question.state === 'pending');
      if (pendingQuestion && mode !== 'queue') {
        // An ordinary input to a waiting helper is its answer; explicit queue never is.
        store.setSupplement(item.requestId, 'sending');
        await answerLocked(record, item.message, item.requestId,
          { modelSelection: item.selection ?? null, selectionExplicit: item.selectionExplicit === true,
            created: item.created });
        if (store.supplement(item.requestId)?.status !== 'blocked') {
          const answer = (record.task.answers ?? []).find(entry => entry.answerId === item.requestId);
          saveSupplementReceipt(item.requestId, 'accepted', null,
            { delivery: answer?.nativeAnswered ? 'answered' : 'answer-pending', mode: 'steer' });
        }
        return;
      }
      if (pendingQuestion && mode === 'queue') {
        // Explicit queue waits, and the question stays unanswered for a separate answer.
        if (root?.running) saveSupplementReceipt(item.requestId, 'queued', null,
          { delivery: 'after-current', afterTurnId: root.turnId, mode: 'queue' });
        else saveSupplementReceipt(item.requestId, 'queued', null, { delivery: 'local-pending', mode: 'queue' });
        continue;
      }
      if (target === 'claude-cli') {
        // A headless CLI turn owns its session until the process exits. Every ordinary
        // supplement waits between turns; an explicit steer was refused at the entry.
        if (scheduled.running === true) {
          saveSupplementReceipt(item.requestId, 'queued', null,
            { delivery: 'after-current', mode: 'queue' });
          return;
        }
        const started = await startItem(item, mode);
        if (started?.delivery === 'new-turn') retargetWaiting(item.requestId, started.turnId);
        return;
      }
      if (target === 'dsh') {
        if (scheduled.running === true && mode !== 'queue') {
          await startItem(item, 'steer');
          continue;
        }
        if (scheduled.running === true) {
          saveSupplementReceipt(item.requestId, 'queued', null, { delivery: 'after-current', mode: 'queue' });
          continue;
        }
        const started = await startItem(item, mode);
        if (started?.delivery === 'new-turn') retargetWaiting(item.requestId, started.turnId);
        return;
      }
      // Codex: only the root turn decides. An unreadable root leaves everything local.
      if (!root || root.known === false) {
        saveSupplementReceipt(item.requestId, 'queued', null, { delivery: 'local-pending', mode });
        return;
      }
      if (root.running) {
        // The write-time check uses the native catalog/wire comparison. A different
        // selection is blocked with its own reason; an unprovable one stays local and
        // is checked again on a later poll. Neither writes or changes the name pin.
        if (item.selectionExplicit === true && item.selection) {
          let status;
          try { status = await rootSelectionMatch(record, item.selection, root); }
          catch { status = 'unknown'; }
          if (status === 'different') {
            saveSupplementReceipt(item.requestId, 'blocked', 'codex-model-change-while-running',
              { delivery: 'blocked', mode, accepted: false, queued: false });
            continue;
          }
          if (status !== 'same') {
            saveSupplementReceipt(item.requestId, 'queued', null,
              { delivery: 'local-pending', mode, accepted: false, queued: true });
            return;
          }
        }
        if (mode === 'queue') {
          saveSupplementReceipt(item.requestId, 'queued', null,
            { delivery: 'after-current', afterTurnId: root.turnId, mode: 'queue' });
          continue;
        }
        await startItem(item, 'steer');
        continue;
      }
      const started = await startItem(item, mode);
      if (started?.delivery === 'new-turn') retargetWaiting(item.requestId, started.turnId);
      return;
    }
  }

  function retainMissingTreeFailure(record) {
    // A failed Codex row whose error is the missing-thread one is the legacy shape: it has
    // no marker yet. Writing the marker here, before the inbox is drained, lets this same
    // round's final carry the explanation instead of looking like a live round.
    if (record.task?.treeUnavailable === undefined && record.state === 'failed'
        && record.error?.code === MISSING_THREAD_CODE && targetOf(record) === 'codex-desktop') {
      record.task.treeUnavailable = MISSING_THREAD_CODE;
      record.task.finishedAt ??= now();
      record.observation = { ...record.observation, stale: true };
      store.save(record);
    }
    if (record.task?.treeUnavailable !== MISSING_THREAD_CODE) return false;
    if (record.state !== 'failed' || record.task.state !== 'failed') {
      record.state = record.task.state = 'failed';
      delete record.nextAttemptAt;
      store.save(record);
    }
    return true;
  }

  /**
   * A finished round sends nothing more. Everything it already owes is written out (its
   * own notices, the messages an older round left behind), every queued supplement of
   * that round is closed with its body kept, and nothing is armed to wake it again.
   */
  async function settleFinishedRound(record) {
    const ended = terminalRound(record);
    if (!ended) return publicResult(record);
    let changed = false;
    if (ended !== 'completed' && record.state !== ended) { record.state = ended; changed = true; }
    if (ended !== 'completed' && record.task && record.task.state !== ended) { record.task.state = ended; changed = true; }
    // A missing thread from an older build gains the marker now, so later polls take the
    // cheap path instead of going looking for a thread that is gone.
    if (ended === 'failed' && record.task && record.task.treeUnavailable === undefined
        && record.error?.code === MISSING_THREAD_CODE) {
      record.task.treeUnavailable = MISSING_THREAD_CODE;
      record.task.finishedAt ??= now();
      record.observation = { ...record.observation, stale: true };
      changed = true;
    }
    // Only the schedule this feature wrote is cleared; any other retry stamp on this name
    // belongs to something else and is left exactly as it is.
    stopRecheck(record);
    if (changed) store.save(record);
    // The final a finished round still owes is settled by the same code a live round uses,
    // from one read-only observation: nothing is dispatched here and nothing waits for a
    // send. A tree that cannot be read keeps its notice for the usual delivery path.
    const task = record.task;
    const final = task?.reports?.find(report => report.final);
    for (const item of store.supplements(record.agentId)) {
      if (item.status === 'blocked') continue;
      // An input whose accepted evidence already exists is kept, not closed: the receipt is
      // the proof, whatever the round did afterwards.
      const prior = task?.dispatches?.find(entry => entry.requestId === item.requestId);
      if (inputAccepted(record, item)
          || (prior && await expiredReceipt(record, prior) === 'accepted')) {
        store.setSupplement(item.requestId, 'accepted');
        if (prior) store.save(record);
        continue;
      }
      const reason = record.task && item.task !== record.task.taskId ? 'task-changed'
        : ended === 'cancelled' ? 'task-cancelled' : final ? 'final-submitted' : 'task-failed';
      store.setSupplement(item.requestId, 'blocked', reason);
    }
    if (task?.legacyAutomaticResult && !final) return publicResult(record);
    if (final && !final.treeSettledConfirmed && !task.treeUnavailable) {
      let view;
      try {
        view = await observe(record);
      } catch (error) {
        record.observation = { ...record.observation, stale: true };
        if (targetOf(record) === 'codex-desktop' && error.code === MISSING_THREAD_CODE) {
          record.error = safeError(error);
          task.treeUnavailable = MISSING_THREAD_CODE;
          record.state = task.state = 'failed';
        }
        store.save(record);
      }
      if (view) return finishReports(record, view);
    }
    if (hasPendingDelivery(record)) await deliverReports(record);
    if (final?.treeSettledConfirmed && task.result && task.reports.filter(report => report.final).every(report => terminalNotice(report.delivery))) {
      return finishDeliveredReport(record);
    }
    return task?.treeUnavailable ? publicResult(record) : afterTerminal(record);
  }

  /** Does this queued supplement already have accepted evidence on the round? */
  function inputAccepted(record, item) {
    const dispatch = (record.task?.dispatches ?? []).find(entry => entry.requestId === item.requestId);
    if (dispatch?.accepted === true) return true;
    const answer = (record.task?.answers ?? []).find(entry => entry.answerId === item.requestId);
    return Boolean(answer?.questionIds?.length);
  }

  function expireInput(record, dispatch, item, outcome = 'not-sent') {
    const unconfirmed = outcome === 'unknown';
    const createdAt = item?.created ?? (dispatch?.kind === 'task' ? record.task.startedAt
      : dispatch?.requestedAt ?? dispatch?.startedAt);
    const reason = 'dispatch-expired';
    if (dispatch) Object.assign(dispatch, { state: dispatch.kind === 'answer' ? 'unknown' : 'blocked',
      accepted: false, expired: reason,
      nextAttemptAt: undefined, error: { code: reason, message: unconfirmed
        ? 'This input expired after six hours with no confirmed receipt. Its body is kept.'
        : 'This input expired after six hours without being sent. Its body is kept.' } });
    if (dispatch?.kind === 'answer') {
      for (const answer of record.task.answers ?? []) {
        if ((dispatch.answerIds ?? []).includes(answer.answerId)) {
          Object.assign(answer, { dispatched: true, undelivered: reason, delivery: 'unknown' });
        }
      }
    }
    if (item) {
      store.setSupplement(item.requestId, 'blocked', reason);
      const answer = record.task.answers?.find(entry => entry.answerId === item.requestId);
      if (answer) Object.assign(answer, { dispatched: true, undelivered: reason });
    }
    if (item || dispatch?.kind !== 'task') {
      record.expired = { count: (record.expired?.count ?? 0) + 1,
        retainBody: record.expired?.retainBody || !item,
        latest: { reason, kind: 'supplement', requestId: item?.requestId ?? dispatch?.requestId, createdAt,
          ...(unconfirmed ? { unconfirmed } : {}) } };
    } else {
      record.state = record.task.state = 'failed';
      record.task.finishedAt ??= now();
      record.task.expired = { reason, kind: 'task', at: now(), startedAt: createdAt,
        ...(unconfirmed ? { unconfirmed } : {}) };
      record.expired = { ...record.expired, retainBody: true };
    }
  }

  /**
   * Nothing this round queued is sent after its own six hours. The window is the notice
   * window and the clock is the original one: a task with no accepted dispatch is aged
   * from its start (a retry never refreshes it), a queued supplement from the moment the
   * caller wrote it. Expired work keeps its body and says so; an expired supplement never
   * ends a task that is still running.
   * @returns {Promise<boolean>} True when the task itself expired.
   */
  async function expireStaleWork(record) {
    const task = record.task;
    if (!task) return false;
    let changed = false;
    const dispatched = task.dispatches ?? [];
    const primary = dispatched.find(dispatch => dispatch.kind === 'task')
      ?? dispatched.find(dispatch => dispatch.kind === undefined && !dispatch.reminder);
    if (dispatchExpired(task.startedAt) && primary?.accepted !== true) {
      const outcome = await expiredReceipt(record, primary);
      if (roundMovedOn(record)) throw dispatchRefused();
      if (outcome !== 'accepted') {
        if (primary) primary.kind ??= 'task';
        expireInput(record, primary ?? { kind: 'task' }, undefined, outcome);
      }
      changed = true;
    }
    for (const item of store.supplements(record.agentId)) {
      if (item.status === 'blocked' || item.task !== task.taskId || !dispatchExpired(item.created)) continue;
      const prior = dispatched.find(dispatch => dispatch.requestId === item.requestId);
      const outcome = await expiredReceipt(record, prior);
      if (roundMovedOn(record)) throw dispatchRefused();
      if (outcome === 'accepted') store.setSupplement(item.requestId, 'accepted');
      else expireInput(record, prior, item, !prior && item.status === 'unknown' ? 'unknown' : outcome);
      changed = true;
    }
    for (const dispatch of dispatched) {
      if (dispatch.kind !== 'supplement' || dispatch.accepted === true || dispatch.expired
          || !dispatchExpired(dispatch.startedAt) || store.supplement(dispatch.requestId)) continue;
      const outcome = await expiredReceipt(record, dispatch);
      if (roundMovedOn(record)) throw dispatchRefused();
      if (outcome !== 'accepted') expireInput(record, dispatch, undefined, outcome);
      changed = true;
    }
    if (changed) saveDispatch(record);
    return Boolean(task.expired);
  }

  async function pollLocked(record) {
    if (readOnlyTarget(record)) return publicResult(record);
    if (record.state === 'cleaning') {
      return record.nextAttemptAt > Date.now() ? publicResult(record) : clearRecord(record);
    }
    if (record.closed || record.state === 'cleanup_failed') return publicResult(record);
    const missingTree = retainMissingTreeFailure(record);
    // What the helper already wrote is taken in before anything decides that a finished
    // round may skip work: an accepted late ask or report is this round's work, and a
    // release re-check must never walk past it.
    try { await drainSubmissions(record); }
    catch (error) { record.error = safeError(error); store.save(record); return publicResult(record); }
    if (missingTree) {
      // The round is closed, so its queued input is closed with it and nothing is armed to
      // wake it again; its own notices still go out. This is what keeps a legacy missing
      // thread from turning into a polling hot loop.
      return await settleFinishedRound(record);
    }
    // A round the target has not confirmed releasing yet owes nothing else —that is what
    // the release gate proved when it wrote the schedule —so this poll asks the release
    // again and reads nothing else: a conversation read is what would resume the very
    // thread being released.
    const recheckAt = releaseRecheckAt(record);
    if (recheckAt !== undefined) {
      if (owesWork(record)) stopRecheck(record);
      else if (recheckAt > Date.now()) return publicResult(record);
      // One attempt at a time: the ticket already in the air is the only release this
      // round gets until it answers.
      else if (releaseInflight.has(record.agentId)) return publicResult(record);
      else return afterTerminal(record);
    }
    // A round that entered the release path and owes nothing is not read again: the
    // observe below would subscribe the thread the release just let go of. Every other
    // name keeps exactly the round it had before this feature existed.
    if (inReleasePath(record) && ['idle', 'failed', 'cancelled'].includes(record.state)
        && !owesWork(record)) return publicResult(record);
    const task = record.task;
    try {
      // Historical automatic results remain quarantined as before. Their marker
      // makes the old round terminal for sending even if it is still listed here.
      if (task?.result && task.reportProtocol !== REPORT_PROTOCOL) {
        if (['sending', 'unknown'].includes(task.delivery?.state)) await deliver(record, task.delivery, '');
        task.legacyAutomaticResult = task.result;
        delete task.result; task.delivery = undefined;
        record.state = 'awaiting_report';
        store.save(record);
        return publicResult(record);
      }
      const stopping = task?.cancelRequested && (!task.cancelVerified || task.cancelPending || !task.cancelTreeSettled);
      if (terminalRound(record) && !stopping) return await settleFinishedRound(record);
      if (!task?.cancelRequested && await expireStaleWork(record)) return await settleFinishedRound(record);
      if (record.nextAttemptAt > Date.now() || firstDispatchDeferred(record)) return publicResult(record);
      if (record.state === 'idle') {
        if (!hasPendingDelivery(record)) return publicResult(record);
        await deliverReports(record);
        return afterTerminal(record);
      }
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
      for (const answer of task.answers ?? []) {
        if (!answer.questionIds && !answer.dispatched && !task.cancelRequested) {
          try { await resolveAnswer(record, answer); }
          catch (error) { if (!NATIVE_ANSWER_REFUSALS.has(error.code)) throw error; }
        }
      }
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
      await deliverQuestions(record, unanswered);
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
      // A write that refused at its own last moment and proved it was never sent: this copy
      // is stale by definition, so none of it is saved. The newer round keeps what it has.
      if (error?.notSent === true && error?.terminal === true) {
        return publicResult(store.get(record.agentId) ?? record);
      }
      // A missing thread after a profile switch is a terminal state, not a
      // transient transport failure: keep the exact error and stop polling it.
      const missingThread = targetOf(record) === 'codex-desktop' && error.code === 'codex-thread-not-found';
      const terminal = missingThread || error.terminal === true;
      record.state = terminal ? 'failed' : record.task?.result ? 'delivery_pending' : 'reconnecting';
      record.error = safeError(error);
      if (terminal && record.task) {
        record.task.state = 'failed';
        if (missingThread) {
          record.task.treeUnavailable = 'codex-thread-not-found';
          record.task.finishedAt ??= now();
        }
      }
      record.observation = { ...record.observation, stale: true };
      if (terminal) record.nextAttemptAt = undefined;
      else if (targetOf(record) !== 'dsh') deferRetry(record);
      forgetBackend(record);
      store.save(record);
      if (terminal && record.task && !store.get(record.agentId)?.task?.cancelRequested) {
        try { await notifyFailure(record, 'failed', record.observation ?? {}, undefined); }
        catch { /* the pending failure report is retried by the next scan */ }
      }
      if (missingThread) await drainSubmissions(record, { currentOnly: true });
      return terminal ? afterTerminal(record) : publicResult(record);
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
      // Locked to the host default, DSH offers callers that one model and nothing else.
      const dshChoices = summary => config.dshDefaultModelOnly !== true ? summary
        : { ...summary, models: summary.defaultModel ? [summary.defaultModel] : [], modelLocked: true };
      const [dshModels, codexEntry, claudeEntry] = await Promise.all([
        host ? readStatusModels(() => controlFactory(config, { client }).models()).then(dshChoices) : emptyCatalog,
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
      const parent = trustedCaller(extra) ? undefined : store.agentForCodexThread(callingThread(extra), { includeAutoClosed: true });
      const record = { agentId: uid('agent'), ownerId: owner.ownerId, sessionId: uid('session-codex'), name, lifetime,
        target: backendTarget, workspace: owner.workspace, state: 'creating', createdAt: now(), updatedAt: now(), history: [],
        ...(parent ? { parentAgentId: parent.agentId } : {}) };
      await ensureTargetBackend(record);
      if (hasModelRequest({ model, effort }) && !dshDefaultOnly(record)) {
        // Resolve against the live target catalog before the name exists, so a typo
        // creates nothing and a valid pin is part of the first durable record.
        record.modelPin = await resolveRequestedPin(record, { model, effort });
      }
      store.insert(record, { requireOpenParent: Boolean(parent) });
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
    async send({ name, message, model, effort, mode }, extra) {
      textMessage(message);
      const requestedMode = normalizeRequestedMode(mode);
      let request = { model, effort };
      let wantsSelection = hasModelRequest(request);
      // A DSH name of an installation locked to the host default takes no selection:
      // the input is sent as if the caller had named no model and no effort.
      const ignoreSelectionFor = record => {
        if (dshDefaultOnly(record)) { request = {}; wantsSelection = false; }
      };
      const supplementStates = new Set(['running', 'awaiting_input', 'awaiting_report', 'reconnecting']);
      let enteredOperation = false;
      // What this call means on this target when the caller did not name a mode.
      // A headless CLI supplement is read between turns (= queue); Codex and DSH
      // add an ordinary supplement to the live turn when one is running (= steer).
      const effectiveMode = (record, { answer = false, start = false } = {}) => {
        if (requestedMode) return requestedMode;
        if (answer || start) return 'steer';
        return targetOf(record) === 'claude-cli' ? 'queue' : 'steer';
      };
      const queued = (record, pin, extraReceipt = {}) => ({
        name: record.name, accepted: false, queued: true, state: record.state,
        requestId: extraReceipt.requestId,
        mode: extraReceipt.mode ?? 'steer',
        delivery: extraReceipt.delivery ?? 'local-pending',
        ...(extraReceipt.afterTurnId ? { afterTurnId: extraReceipt.afterTurnId } : {}),
        ...(extraReceipt.turnId ? { turnId: extraReceipt.turnId } : {}),
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
      const queue = async (record, pin, { usePinnedModel = false, savePin = false,
        requestId = uid('request'), mode, selectionExplicit = false, afterTurnId } = {}) => {
        const previous = record.modelPin;
        if (savePin) record.modelPin = { ...pin };
        let changed;
        try {
          // With no explicit selection the SQL copies the live pin in the same
          // INSERT SELECT, so a poll's stale body cannot overwrite a newer value.
          changed = store.enqueueSupplement(record, requestId, message, pin ? { ...pin } : undefined,
            { ...(usePinnedModel ? { usePinnedModel: true } : {}), ...(savePin ? { saveRecord: true } : {}),
              mode: mode ?? 'steer', selectionExplicit: selectionExplicit === true });
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
        const queuedMode = mode ?? 'steer';
        // A steer is never registered behind a turn. Only an explicit queue may carry
        // the afterTurnId it waits behind, even if a caller passes one by mistake.
        const waitTurnId = queuedMode === 'queue' ? afterTurnId : undefined;
        // A queue that the caller can already place behind a named turn persists that
        // route now, so the first inspect after this receipt says the same thing.
        if (waitTurnId) saveSupplementReceipt(requestId, 'queued', null,
          { delivery: 'after-current', afterTurnId: waitTurnId, mode: queuedMode,
            accepted: false, queued: true, selectionExplicit: selectionExplicit === true });
        // The INSERT SELECT may have captured a newer live pin than this caller
        // read; report the selection actually frozen on the queued row.
        const frozen = (store.supplements(record.agentId) ?? []).find(item => item.requestId === requestId)?.selection;
        return queued(current, pin ?? frozen ?? current.modelPin,
          { requestId, mode: queuedMode, delivery: waitTurnId ? 'after-current' : 'local-pending',
            ...(waitTurnId ? { afterTurnId: waitTurnId } : {}) });
      };
      // The no-wait path is only for a supplement that changes no selection: the
      // INSERT SELECT itself freezes the current pin. An explicit model/effort must
      // take the ordinary 10s lock so a poll cannot save an older body over modelPin.
      const enqueueWithoutWait = async (record, { mode, afterTurnId } = {}) => {
        const fresh = store.get(record.agentId) ?? record;
        return queue(fresh, undefined, { usePinnedModel: true, mode, afterTurnId });
      };
      const answerReceipt = async (record, requestId, pin, { selectionExplicit = false } = {}) => {
        const result = await answerLocked(record, message, requestId,
          { modelSelection: pin, selectionExplicit });
        const delivery = result.error?.code === 'answer-not-delivered' ? 'blocked'
          : result.answered !== true ? 'answer-pending'
            : result.delivery === 'native-question' ? 'answered' : 'answer-pending';
        return { ...result, requestId, mode: 'steer', delivery,
          accepted: delivery === 'answered', queued: delivery === 'answer-pending' };
      };
      // Named so the busy retry below runs exactly this body against a fresh record.
      const operation = async record => {
        enteredOperation = true;
        requireWritableTarget(record);
        ignoreSelectionFor(record);
        const closing = ['cleaning', 'cleanup_failed', 'creating', 'supplement_blocked'];
        if (record.closed || closing.includes(record.state)) throw new Error('This subagent is closing, has blocked supplements, or is not yet ready.');
        retainMissingTreeFailure(record);
        // A terminal row may still have a callback accepted by another process.
        // Fold it into that round before deciding whether this input is a new task.
        if (!ACTIVE.has(record.state) || terminalRound(record)) {
          await drainSubmissions(record, { currentOnly: true, readOnDemand: true });
        }
        let previousReport;
        if (record.state === 'delivery_pending') {
          const prior = (record.task?.reports ?? []).filter(report => !report.failure).at(-1);
          previousReport = prior ? { delivered: prior.delivery.state === 'delivered',
            summary: compactText(prior.message, 299) } : undefined;
          await settleDelivery(record);
          // Settling a one-shot agent's final finishes its task and removes the name on
          // the spot, so the ordinary closing error applies instead of a new dispatch.
          if (record.closed || !store.get(record.agentId) || closing.includes(record.state)) throw new Error('This subagent is closing, has blocked supplements, or is not yet ready.');
          await requireSettledSubmissions(record);
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
        const stoppedTask = Boolean(terminalRound(record));
        if (!ACTIVE.has(record.state) || stoppedTask) await requireSettledSubmissions(record);
        const pendingReports = (record.task?.reports ?? []).filter(report => !terminalNotice(report.delivery));
        // A delivered final can leave an earlier callback in backoff. Keep that
        // callback on this round until its delivery outcome is recorded.
        const pendingIdleCallback = record.state === 'idle' && pendingReports.some(report => report.id?.startsWith('submission:'));
        if ((stoppedTask && (record.lifetime === 'once' || pendingReports.length)) || pendingIdleCallback) {
          if (pendingReports.length) await ensureWorker(record, { wake: true });
          throw new Error(stoppedTask
            ? 'This task stopped; delete the one-shot agent or wait for its submitted reports before reusing a persistent agent.'
            : 'Wait for this task’s submitted reports before reusing the name.');
        }
        if (record.state !== 'idle' && !stoppedTask && record.task?.reports?.some(report => report.final)) {
          await requireSettledSubmissions(record);
          throw new Error('The agent has submitted its final report; wait for delivery or explicitly delete the agent.');
        }
        const target = targetOf(record);
        const activeTask = record.task && !stoppedTask && ACTIVE.has(record.state);
        // An input that arrives behind an existing queue takes its place at the tail
        // and never jumps a queued start, even when this caller could write at once.
        const queuedAhead = () => activeTask
          && (store.supplements(record.agentId) ?? []).some(item => item.task === record.task?.taskId && item.status !== 'blocked');
        // Everything that must refuse before touching the name is past. A requested
        // substring is resolved to its real ID before any busy/model decision, so an
        // unknown model still reports the catalog.
        const resolvePin = async (root, view) => {
          if (!wantsSelection) return dshDefaultOnly(record) ? undefined : record.modelPin;
          const pin = await resolveRequestedPin(record, request);
          if (target === 'codex-desktop' && activeTask) {
            if (!root || root.known === false) {
              throw Object.assign(new Error('The running turn’s model and reasoning effort could not be confirmed, so this selection was not sent.'),
                { code: 'model-selection-unconfirmed', uncertain: true, terminal: true });
            }
            if (root.running) await assertExplicitSelectionForRunning(record, pin, root);
          }
          return pin;
        };
        if (activeTask) {
          // Before the first write there is no native root to read yet. An ordinary
          // supplement without a new selection is stored straight away; probing the
          // host here would turn a normal queue write into a failed send.
          if (target === 'codex-desktop' && !wantsSelection
              && record.task.dispatches?.[0]?.accepted !== true) {
            const mode = effectiveMode(record);
            const receipt = await queue(record, undefined, { usePinnedModel: true, mode, selectionExplicit: false });
            return supplementReceipt(record, receipt.requestId, { mode, delivery: 'local-pending' });
          }
          if (target === 'dsh') await negotiateTree(record);
          let view;
          try { view = await observe(record); }
          catch (error) {
            if (target !== 'codex-desktop') throw error;
            // A root observation failure is not permission to drop the input. An
            // ordinary queue is stored first and reported local-pending; the worker
            // will read the root when it is readable again.
            const pin = wantsSelection ? await resolveRequestedPin(record, request)
              : dshDefaultOnly(record) ? undefined : record.modelPin;
            const mode = effectiveMode(record);
            const receipt = await queue(record, pin, { ...(wantsSelection ? {} : { usePinnedModel: true }),
              mode, selectionExplicit: wantsSelection });
            return supplementReceipt(record, receipt.requestId, { pin, mode, delivery: 'local-pending' });
          }
          if ((view.reports ?? []).some(report => report.final)) throw new Error('The agent has already submitted its final report.');
          const pendingQuestion = (view.questions ?? []).some(question => question.state === 'pending');
          // DSH supports steering only. A native turn that ended in ask_parent still
          // leaves a pending question: that is busy too, and explicit queue must never
          // turn the problem into an answer or a supplement. awaiting_report without a
          // question is idle, so both modes start a new turn there.
          if (target === 'dsh' && requestedMode === 'queue' && (view.running === true || pendingQuestion)) {
            return modeUnsupported(record, 'queue', ['steer']);
          }
          if (target === 'claude-cli') {
            // An omitted mode or explicit steer given while a question is pending is
            // the answer, never a queued supplement: the caller is answering.
            if (pendingQuestion && requestedMode !== 'queue') {
              const pin = await resolvePin(undefined, view);
              return answerReceipt(record, uid('request'), pin, { selectionExplicit: wantsSelection });
            }
            if (pendingQuestion && requestedMode === 'queue') {
              const pin = await resolvePin(undefined, view);
              const receipt = await queue(record, pin, { ...(wantsSelection ? { savePin: true } : { usePinnedModel: true }),
                mode: 'queue', selectionExplicit: wantsSelection });
              return supplementReceipt(record, receipt.requestId, { pin, mode: 'queue', delivery: 'local-pending' });
            }
            if (view.running === true && requestedMode === 'steer') {
              return modeUnsupported(record, 'steer', ['queue']);
            }
            const pin = await resolvePin(undefined, view);
            const ahead = queuedAhead();
            // An explicit steer between turns starts now; an omitted or queue input
            // waits for the next resume. Neither is ever reported as a steer.
            const cliMode = requestedMode === 'steer' ? 'steer' : 'queue';
            const receipt = await queue(record, pin, { ...(wantsSelection ? { savePin: true } : { usePinnedModel: true }),
              mode: cliMode, selectionExplicit: wantsSelection });
            if (!ahead) await drainSupplements(record, { view });
            return supplementReceipt(store.get(record.agentId) ?? record, receipt.requestId,
              { pin, mode: cliMode, delivery: 'local-pending' });
          }
          if (target === 'dsh') {
            if (pendingQuestion) {
              const pin = await resolvePin(undefined, view);
              persistPin(record, pin);
              return answerReceipt(record, uid('request'), pin, { selectionExplicit: wantsSelection });
            }
            const pin = await resolvePin(undefined, view);
            persistPin(record, pin);
            const ahead = queuedAhead();
            const receipt = await queue(record, pin, { ...(wantsSelection ? { savePin: true } : { usePinnedModel: true }),
              mode: 'steer', selectionExplicit: wantsSelection });
            if (!ahead) await drainSupplements(record, { view });
            return supplementReceipt(store.get(record.agentId) ?? record, receipt.requestId,
              { pin, mode: 'steer' });
          }
          // Codex: only the native root turn decides current vs next turn. A read
          // failure leaves the input local; it never guesses an idle root.
          let root;
          try { root = await rootTurnFor(record); }
          catch { root = { known: false }; }
          if (pendingQuestion && effectiveMode(record) === 'queue') {
            const pin = await resolvePin(root, view);
            // A running turn cannot change its selection through a queue row either.
            // The pin is written only after a native start proves the new turn used it.
            const receipt = await queue(record, pin, { ...(wantsSelection ? {} : { usePinnedModel: true }),
              mode: 'queue', selectionExplicit: wantsSelection,
              ...(root.running && root.turnId ? { afterTurnId: root.turnId } : {}) });
            // The return value is not the only place this route must survive: inspect
            // reads the row later, after the caller's receipt is gone.
            saveSupplementReceipt(receipt.requestId, 'queued', null,
              { delivery: root.running ? 'after-current' : 'local-pending',
                ...(root.running && root.turnId ? { afterTurnId: root.turnId } : {}),
                mode: 'queue', accepted: false, queued: true, selectionExplicit: wantsSelection === true });
            return supplementReceipt(record, receipt.requestId,
              { pin, mode: 'queue', delivery: root.running ? 'after-current' : 'local-pending',
                ...(root.running && root.turnId ? { afterTurnId: root.turnId } : {}) });
          }
          if (pendingQuestion) {
            const pin = await resolvePin(root, view);
            return answerReceipt(record, uid('request'), pin, { selectionExplicit: wantsSelection });
          }
          const pin = await resolvePin(root, view);
          const mode = effectiveMode(record);
          const ahead = queuedAhead();
          // Only an explicit queue is registered behind the running turn. A steer is
          // written into that turn; until a native receipt proves it, the input is a
          // local pending write and must not claim a wait it is not in.
          const waitTurnId = mode === 'queue' && root.running && root.turnId ? root.turnId : undefined;
          const receipt = await queue(record, pin, { ...(wantsSelection ? {} : { usePinnedModel: true }),
            mode, selectionExplicit: wantsSelection,
            ...(waitTurnId ? { afterTurnId: waitTurnId } : {}) });
          // A running root can take a steer even when earlier queue rows wait; only an
          // idle root with rows ahead must leave the new input at the tail.
          if (!ahead || root.running) await drainSupplements(record, { view });
          return supplementReceipt(store.get(record.agentId) ?? record, receipt.requestId,
            { pin, mode, delivery: waitTurnId ? 'after-current' : 'local-pending',
              ...(waitTurnId ? { afterTurnId: waitTurnId } : {}) });
        }
        // No live task: a new name/round starts normally. This is the one path where
        // both modes mean the same thing.
        if (record.task?.treeUnavailable === MISSING_THREAD_CODE || record.task?.expired?.unconfirmed) {
          const view = await observe(record, { checkingRestoredProfile: true });
          // An earlier cancellation request can no longer keep a missing task open.
          // After the profile returns, verify that the old tree has actually stopped.
          const settled = view.tree?.settled === true && view.tree.running === false && ownedTree(record, view).complete;
          if (view.running || !settled) {
            throw Object.assign(new Error('The previous task is visible again but its task tree has not settled.'),
              { code: 'previous-task-unsettled', retryable: true });
          }
        }
        const pin = await resolvePin(undefined, undefined);
        const snapshot = record.task ? { ...record.task, changes: attributedChanges(record, record.observation ?? {}),
          coverage: treeCoverage(record, record.observation ?? {}), tree: publicTree(record, record.observation ?? {}) } : undefined;
        // finalReminder marks this task as one that may be reminded once when a turn
        // ends without a final report. Tasks created before this rule carry no marker,
        // so a sleeping awaiting_report from an older version stays quiet.
        // The selected model is frozen with the task: a desktop first dispatch is
        // delayed through the worker queue and must not read a later pin change.
        const requestId = uid('request');
        const next = { ...record, state: 'running', observation: undefined, error: undefined,
          nextAttemptAt: undefined, retryAttempts: 0, sleep: undefined,
          ...(wantsSelection ? { modelPin: { ...pin } } : {}),
          // A pin saved before the lock was turned on goes with the next task.
          ...(dshDefaultOnly(record) ? { modelPin: undefined } : {}),
          task: { taskId: uid('task'), requestId, message, mode: requestedMode ?? 'steer',
            state: 'starting', startedAt: now(), dispatches: [], answers: [],
            modelSelection: pin ? { ...pin } : null, selectionExplicit: wantsSelection, finalReminder: 'armed' } };
        // A task assignment ends the previous round for good: its release attempt loses
        // its ticket here, so the host refuses it at the point where it would unsubscribe
        // and the new turn is free to subscribe the thread again.
        invalidateRelease(next);
        if (!store.replaceTask(next, record, snapshot)) {
          const latest = store.get(record.agentId);
          if (!latest) throw new Error('This subagent instance has already been removed.');
          return operation(latest);
        }
        record = next;
        if (targetOf(record) !== 'dsh') {
          await ensureWorker(record, { wake: true });
          return { ...queued(record, pin, { requestId, mode: effectiveMode(record, { start: true }),
            delivery: 'local-pending' }), ...(previousReport ? { previousReport } : {}) };
        }
        try { await beginTask(record); }
        catch (error) {
          if (error?.notSent === true) {
            if (store.get(record.agentId)?.task?.taskId !== record.task.taskId) throw error;
          } else {
            record.state = 'reconnecting'; record.error = safeError(error); store.save(record);
          }
        }
        await ensureWorker(record, { wake: true });
        const current = store.get(record.agentId) ?? record;
        const dispatch = record.task.dispatches.at(-1);
        const error = current.error ?? dispatch?.error;
        return { name: current.name, accepted: dispatch?.accepted === true, state: current.state,
          requestId, mode: effectiveMode(record, { start: true }), delivery: dispatch?.delivery,
          ...(dispatch?.turnId ? { turnId: dispatch.turnId } : {}),
          ...(dispatch?.afterTurnId ? { afterTurnId: dispatch.afterTurnId } : {}),
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
        ignoreSelectionFor(record);
        const target = targetOf(record);
        const activeTask = record.task && !terminalRound(record) && ACTIVE.has(record.state);
        // Capability refusals do not wait for the name lock: they never write.
        if (activeTask && target === 'dsh' && effectiveMode(record) === 'queue') {
          return modeUnsupported(record, 'queue', ['steer']);
        }
        if (activeTask && target === 'claude-cli' && effectiveMode(record) === 'steer') {
          let view;
          try { view = await observe(record); } catch { view = undefined; }
          if (view?.running === true && !(view.questions ?? []).some(question => question.state === 'pending')) {
            return modeUnsupported(record, 'steer', ['queue']);
          }
        }
        let root;
        if (activeTask && target === 'codex-desktop') {
          try { root = await rootTurnFor(record); }
          catch { root = { known: false }; }
        }
        if (wantsSelection && activeTask && target === 'codex-desktop') {
          const pin = await resolveRequestedPin(record, request);
          if (!root || root.known === false) {
            throw Object.assign(new Error('The running turn’s model and reasoning effort could not be confirmed, so this selection was not sent.'),
              { code: 'model-selection-unconfirmed', uncertain: true, terminal: true });
          }
          if (root.running) {
            await assertExplicitSelectionForRunning(record, pin, root);
            // The same selection needs no pin write: queue it directly under the lock-
            // free durable path. The worker will steer or start it. Only a queue is
            // placed behind the running turn; a steer stays local until it is written.
            const busyMode = effectiveMode(record);
            return queue(record, pin, { mode: busyMode, selectionExplicit: true,
              ...(busyMode === 'queue' && root.running && root.turnId ? { afterTurnId: root.turnId } : {}) });
          }
        }
        if (wantsSelection) {
          // Resolve first: a missing ID must report the catalog, not a busy state.
          await resolveRequestedPin(record, request);
          // DSH, a CLI between turns, or a Codex name between turns: take the normal
          // 10s lock so the pin is saved against the live body rather than a poll's
          // stale snapshot.
          return withName(extra, name, operation);
        }
        // A poll holds this lock for one round only. A no-selection supplement keeps
        // the old no-wait durable queue; anything that starts a task should wait.
        if (record.state === 'delivery_pending' || !supplementStates.has(record.state)) {
          return withName(extra, name, operation);
        }
        const busyMode = effectiveMode(record);
        return enqueueWithoutWait(record, { mode: busyMode,
          ...(busyMode === 'queue' && root?.running && root.turnId ? { afterTurnId: root.turnId } : {}) });
      }
    },
    /**
     * Create the name if it is new and send the task, in one call. An existing name
     * keeps its own application and lifetime, so a conflicting explicit value is
     * refused instead of quietly running the task on the wrong backend.
     */
    async run({ name, message, lifetime, target, model, effort, mode } = {}, extra) {
      textMessage(message);
      const requestedMode = normalizeRequestedMode(mode);
      const owner = await context(extra);
      const wanted = normalizeTarget(target);
      const createdLifetime = lifetime ?? 'once';
      if (!['once', 'persistent'].includes(createdLifetime)) throw new Error('lifetime must be once or persistent.');
      const sent = result => ({ state: result.state, accepted: result.accepted === true,
        ...(result.requestId ? { requestId: result.requestId } : {}),
        ...(result.mode ? { mode: result.mode } : {}),
        ...(result.delivery ? { delivery: result.delivery } : {}),
        ...(result.turnId ? { turnId: result.turnId } : {}),
        ...(result.afterTurnId ? { afterTurnId: result.afterTurnId } : {}),
        actualModel: result.actualModel ?? null,
        ...(result.queued !== undefined ? { queued: result.queued === true } : {}), ...(result.retrying ? { retrying: true } : {}),
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
        const result = await service.send({ name: existing.name, message, model, effort, mode: requestedMode }, extra);
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
        const result = await service.send({ name: chosen, message, model, effort, mode: requestedMode }, extra);
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
      let ensured;
      const ensure = () => ensured ??= ensureMonitor();
      for (const record of store.list(owner.ownerId)) await ensureWorker(record, { ensure });
      const records = store.list(owner.ownerId);
      const running = records.some(record => !record.sleep)
        && await monitorAlive(store, Date.now(), { idleSessionCleanup: config.idleSessionCleanup !== false });
      return { items: records.map(record => ({ ...publicResult(record),
        monitor: record.sleep ? (record.sleep.wakePending ? 'waking' : 'sleeping')
          : (running ? 'running' : 'stopped'),
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
          inputs: taskInputs(store, record),
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
      const record = store.get(bound.agentId);
      await ensureWorker(record, { wake: true, hasSubmission: record?.task?.taskId === receipt.taskId });
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
      let beforeUpdatedAt, afterUpdatedAt, attempt;
      const work = store.locked(agentId, async () => {
        const record = store.get(agentId);
        beforeUpdatedAt = record?.updatedAt;
        const result = record ? await pollLocked(record) : { removed: true };
        afterUpdatedAt = record?.updatedAt;
        if (result?.releaseAttempt) {
          const { releaseAttempt, ...rest } = result;
          attempt = releaseAttempt;
          return rest;
        }
        return result;
      }, { waitMs: 0 })
        .then(result => {
          // The release runs outside the name lock and outside this poll's in-flight
          // entry, so a caller assigning the next task never waits on an unload.
          if (attempt) startRelease(attempt);
          return result;
        })
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
      const inbox = pendingInbox();
      const pending = records.filter(record => record.sleep?.wakePending === true || needsPoll(record, inbox.has(record.agentId)));
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
      releaseWakeAt = undefined;
      const inbox = pendingInbox();
      const scanAt = Date.now();
      const wanted = new Set(only ?? []);
      for (const [agentId, dueAt] of inbox) if (dueAt <= scanAt) wanted.add(agentId);
      // Only a real hint — a file event or work queued in this process — may skip a
      // name's own one-second floor. A name that merely owes fast work is polled again
      // as soon as the floor allows, not on every round: otherwise every completion
      // signals another round and the loop spins at ten rounds a second.
      const hints = new Set(fresh ?? []);
      // A round that was pointed at particular names does not pay for the roster
      // sweep; the last sweep is at most SWEEP_MS old, and every name it would have
      // found is polled by the sweep that follows.
      if (!sweep && !wanted.size) return inbox.size > 0 || inflight.size > 0 || monitorInflight.size > 0;
      const candidates = sweep && typeof store.listWorkerCandidates === 'function' ? store.listWorkerCandidates() : [];
      const queue = candidates.map(candidate => ({ agentId: candidate.agentId, candidate }));
      const seen = new Set(queue.map(item => item.agentId));
      for (const agentId of wanted) if (!seen.has(agentId)) queue.push({ agentId, candidate: undefined });
      let busy = inbox.size > 0 || inflight.size > 0 || monitorInflight.size > 0;
      for (const { agentId, candidate } of queue) {
        // A durable callback is work even when its name has no release schedule.
        // It cannot be held behind that schedule's five-minute retry.
        const hasSubmission = (inbox.get(agentId) ?? Infinity) <= scanAt;
        const hinted = hints.has(agentId) || hasSubmission;
        // A hint is news about that name, so it is polled even if its own last poll
        // just finished; the ordinary 1s floor still applies to the sweep.
        // A projection can only hint that a finished round still carries a retry stamp.
        // Only the whole record shows whose stamp it is, so that one name is read here
        // and every other name keeps using its projection.
        const full = mayHoldReleaseSchedule(candidate) ? store.get(agentId) : undefined;
        if (!needsPoll(full ?? candidate ?? store.get(agentId), hasSubmission)) { fastPoll.delete(agentId); continue; }
        // A finished round whose only outstanding work is its own release re-check is not
        // busy: the listener sleeps to that moment, so waiting costs no round at all.
        const recheckAt = releaseRecheckAt(full ?? candidate ?? store.get(agentId));
        if (recheckAt !== undefined && !hinted && !urgentPoll.has(agentId) && recheckAt > Date.now()) {
          releaseWakeAt = Math.min(releaseWakeAt ?? Infinity, recheckAt);
          continue;
        }
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
        if (!record || !needsPoll(record, hasSubmission)) { fastPoll.delete(agentId); continue; }
        if (owesFastPoll(record)) fastPoll.add(record.agentId); else fastPoll.delete(record.agentId);
        busy = true;
        if (monitorInflight.has(record.agentId)) { if (hints.has(agentId)) deferred.push(agentId); continue; }
        const urgent = urgentPoll.delete(record.agentId);
        if (!hinted && !urgent && !force && nextPollAt.get(record.agentId) > Date.now()) continue;
        if (!hasSubmission && firstDispatchDeferred(record)) continue;
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
      // A release that is still in the air is not a poll, but shutting down with it
      // running would close the roster under it: wait it out here instead.
      await Promise.allSettled([...releaseInflight.values()]);
      // A baseline write survives the poll that started it; a shutdown that only waited
      // for polls could close the database with half a snapshot still being written.
      while (baselineWrites.size) await Promise.allSettled([...baselineWrites.values()]);
    },
    async ensureIdleMonitor() {
      const records = typeof store.listWorkerCandidates === 'function' ? store.listWorkerCandidates() : store.list();
      const inbox = pendingInbox();
      const pending = records.some(record => record.sleep?.wakePending === true || needsPoll(record, inbox.has(record.agentId)));
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
    /** Due time of the next release re-check the last sweep found, if any. */
    releaseWakeAt() { return releaseWakeAt; },
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
        // A callback can arrive while the listener is being checked. The sleep write
        // and the inbox check must share one SQLite statement.
        return store.sleep(record, idleSignal({ ...record.observation, taskId: record.task.taskId }));
      });
    },
    close() {
      for (const controller of releaseSignals.values()) controller.abort();
      releaseSignals.clear();
      store.close();
    },
  };

  async function answerLocked(record, message, queuedAnswerId, { modelSelection, selectionExplicit = false, created } = {}) {
    if (!record.task || record.closed || record.task.cancelRequested) throw new Error('This subagent has no open task waiting for an answer.');
    // A finished round cannot be answered: its question is only information by then.
    if (terminalRound(record)) throw Object.assign(new Error('This subagent’s round has already ended, so the question is only information; the answer was not delivered.'),
      { code: 'round-finished', terminal: true });
    await negotiateTree(record);
    await checkHost(record);
    const view = await observe(record);
    const existing = (record.task.answers ?? []).find(answer => queuedAnswerId ? answer.answerId === queuedAnswerId
      : !answer.dispatched && !answer.questionIds && answer.message === message);
    if (!existing && !(view.questions ?? []).some(question => question.state === 'pending')) throw new Error('This subagent has no unanswered question.');
    record.task.answers ??= [];
    const answer = existing ?? { answerId: queuedAnswerId ?? uid('answer'), message, dispatched: false };
    // The six-hour clock belongs to the caller's original input, not to the later poll
    // that happens to dispatch the continuation. Keep the supplement's enqueue time.
    answer.created ??= created ?? now();
    // The continuation is dispatched on a later poll. Freeze the selection on the
    // answer intent now: a queued supplement carries its enqueue-time selection,
    // while a direct answer freezes the name's current pin.
    if (!Object.prototype.hasOwnProperty.call(answer, 'modelSelection')) {
      const frozen = modelSelection !== undefined ? modelSelection : record.modelPin;
      answer.modelSelection = frozen ? { ...frozen } : null;
      answer.selectionExplicit = selectionExplicit === true;
    }
    if (!existing) record.task.answers.push(answer);
    saveDispatch(record);
    try {
      if (!(await resolveAnswer(record, answer))) {
        return { name: record.name, answered: false, state: record.state, error: safeError(dispatchRefused('dispatch-expired')) };
      }
    } catch (error) {
      if (error?.notSent !== true && !NATIVE_ANSWER_REFUSALS.has(error.code)) {
        record.error = safeError(error); saveDispatch(record); await ensureWorker(record);
      }
      throw error;
    }
    // A final report seals its task: the helper has finished and reads nothing more.
    // An answer that comes after it still closes the question, which releases the held
    // report, but it is never written into the conversation, and the caller is told
    // exactly that instead of "resuming".
    if (!answer.nativeAnswered && [...(record.task.reports ?? []), ...(view.reports ?? [])].some(report => report.final === true)) {
      answer.dispatched = true; answer.undelivered = 'final-submitted';
      store.save(record);
      await ensureWorker(record, { wake: true });
      return { name: record.name, answered: false, state: record.state,
        error: { code: 'answer-not-delivered', message: `“${record.name}” had already submitted its final report, so this answer was not delivered. The final report is released to you now; if the work should continue, assign it again with futureaide_send_agent or futureaide_run_agent.` } };
    }
    record.state = 'running'; record.task.state = 'running'; store.save(record);
    await ensureWorker(record, { wake: true });
    return { name: record.name, answered: true, state: 'resuming',
      ...(answer.nativeAnswered ? { delivery: 'native-question', ...(answer.turnId ? { turnId: answer.turnId } : {}) } : answer.nativeFallback ? { delivery: 'continuation-queued' } : {}),
      actualModel: actualModelName(answer.modelSelection) ?? actualModelName(record.model) };
  }
  return service;
}
