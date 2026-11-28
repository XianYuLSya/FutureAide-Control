
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { withCodexInstrumentation, getCodexInstrumentation, codexInstrumentationEnabled } from './codex-instrumentation.mjs';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { updateCliRoutes } from './config.mjs';
import { buildCliProxyEnv, defaultFaswitchRoot, normalizeProxySpec, redactProxyCredentials, resolveCliRoute } from './cli-proxy.mjs';
import { managedTokenFile, MANAGED_TOKEN_FILENAME, mergeRunTaskDefaults } from './managed-cli-policy.mjs';
import { killProcessCage } from './process-cage.mjs';
import { activeReportPort } from './report-endpoint.mjs';
import { createControl, endedState, modelTurnError } from './control.mjs';
import { feedbackRecordError, submitFeedback } from './feedback-client.mjs';
import { FutureAideClient } from './futureaide-api.mjs';
import { resolveModel } from './agents.mjs';
import { actualModelName, resolveDispatchSelection, sameModelSelection } from './model-selection.mjs';
import { classifyManagedRole, loadTeamConfigDefaults, normalizeRoleKey, resolveRoleDefaults } from './team-config-defaults.mjs';
import { boardPrompt, extractBoardMentions, isDescendant, resolveBoardMention } from './board-routing.mjs';
import { commitSha, createWorktree, fullSha, git, gitRoot, hasWorktreeEvidence, inspectWorktree,
  otherProfilesReference, plainDirectoryPath, referencesWorktree, removeVerifiedWorktree, withWorktreeLock, workspaceEvidence, worktreeError, worktreeIdentity } from './worktree-guard.mjs';
export { extractBoardMentions };
import { callCodexOwner, readCodexOwnerTurns, readCodexOwnerItems } from './codex-notify.mjs';
import { callingThread, ownerIdFor, ownerIdForSource, resolveCallingContext, threadFromResult, trustedCaller } from './calling-context.mjs';
import { bindClaude, claudeInboxBodyHash, currentRecord, discoverClaude, readClaudeEvents, sendClaude } from './claude-inbox.mjs';
import { resolveNativeSession } from './claude-sessions.mjs';
import { activeManagedRequestId, captureNativeQuestionHistory, isCancelledRound, RosterStore, submissionNoticeId, submissionRef } from './roster-store.mjs';
import { canReleaseThreads, canSleep, hasPendingDelivery, RELEASE_RECHECK_MS, releaseDue,
  releaseRetryDelay } from './idle-monitor-eligibility.mjs';
import { idleSignal } from './idle-monitor.mjs';
import { ensureSharedMonitor, monitorAlive } from './shared-monitor.mjs';
import { diagnoseTarget, DSH_HOST_METHODS, hostLabel, invalidTarget, isCodexTransientTimeout, isUnavailableStoredTarget, normalizeTarget, readStatusModels, REMOVED_TARGETS, removedTarget, resolveBackend,
  TARGET_LABELS, targetOf } from './agent-backend.mjs';
import { captureWorkspace, diffWorkspace } from './workspace-diff.mjs';
import { FINAL_REPORT_REMINDER, presentedNativeQuestion } from './report-contract.mjs';
import { finalReportReady, finalReportDeadline, treeReleaseDue, treeReleaseRecord, treeReleaseText,
  reportBodyPage, reportBodyReference, REPORT_BODY_PAGE_CHARS } from './report-delivery.mjs';
import { absentClaudeReportReminder, claudeCallbackReminderMs, createDesktopToastNotifier } from './claude-report-reminder.mjs';

const execFileAsync = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const uid = prefix => `${prefix}-${randomUUID().replaceAll('-', '')}`;
const now = () => new Date().toISOString();
const ACTIVE = new Set(['creating', 'running', 'awaiting_input', 'awaiting_report', 'reconnecting', 'delivery_pending', 'cleaning']);
// A name in one of these states is history, not active work. Everything else —
// including an idle persistent name and a cleaning/cleanup-claimed one — stays in
// the default list. An unknown state is kept too: hiding it would be a guess.
const INACTIVE_STATES = new Set(['completed', 'failed', 'cancelled', 'cleanup_failed']);
const STALE_IDLE_MS = 5 * 60 * 1000;
const isPullOwner = owner => owner?.source === 'antigravity' || owner?.source === 'managed-cli';

function normalizeRole(role, { teamConfigPath } = {}) {
  if (role === undefined || role === null || role === '') return undefined;
  if (typeof role !== 'string' || !role.trim() || role.length > 40 || /[\x00-\x1f\x7f]/.test(role)) {
    throw Object.assign(new Error('role must be a non-empty string of at most 40 characters without slashes or control characters.'), { code: 'invalid-role' });
  }
  if (role.includes('/')) {
    const resolved = resolveRoleDefaults(role, { teamConfigPath });
    if (!resolved.matched || !resolved.roleKey || resolved.roleKey.includes('/')) {
      throw Object.assign(new Error('role must be a non-empty string of at most 40 characters without slashes or control characters.'), { code: 'invalid-role' });
    }
    return resolved.roleKey;
  }
  return role.trim();
}

function inferRoleFromName(name) {
  if (typeof name !== 'string' || !name.trim()) return undefined;
  const match = /^(.+?)-?\d+$/u.exec(name.trim());
  const prefix = match?.[1]?.trim();
  return prefix ? prefix : undefined;
}

const METHODS = DSH_HOST_METHODS;
const TREE_PROTOCOL = 1;
const REPORT_PROTOCOL = 1;
const UNCONFIRMED_AFTER_MS = 30 * 60 * 1000;
const EXPIRE_UNSENT_AFTER_MS = 6 * 60 * 60 * 1000;
const dispatchExpired = created => Date.now() - Date.parse(created ?? '') >= EXPIRE_UNSENT_AFTER_MS;
const CONFIRM_ABSENCE_AFTER_MS = 2 * 60 * 1000;
// Leave time to assemble the answer before the Codex MCP host's 60-second limit.
const STATUS_RETRY_DEADLINE_MS = 55_000;
const CODEX_READ_REPLY_BUDGET_MS = 16_000;
const CODEX_CLEANUP_READ_RETRIES = 2;
const terminalNotice = notice => ['delivered', 'blocked'].includes(notice?.state);
const awaitingNoticeReceipt = notice => ['sending', 'unknown'].includes(notice?.state);
/** A task report actually reached the caller through the cross-session path. */
const hasDeliveredReport = record => (record?.task?.reports ?? [])
  .some(report => !report.failure && report.delivery?.state === 'delivered');
const fromSubmission = id => typeof id === 'string' && id.startsWith('submission:');
const bareReportId = id => fromSubmission(id) ? id.slice('submission:'.length) : id;
const sameReportId = (left, right) => Boolean(left && right && bareReportId(left) === bareReportId(right));
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

/** A DSH-managed report keeps its native persistent UUID as the only identity. */
function nativeReportOnly(record) {
  return targetOf(record) === 'dsh';
}

/** Local-only identity of the process that read a receipt; never a chat address. */
function receiptProcessIdentity() {
  const leaseIndex = process.argv.indexOf('--lease');
  const monitorId = leaseIndex >= 0 && typeof process.argv[leaseIndex + 1] === 'string'
    ? process.argv[leaseIndex + 1] : undefined;
  const role = process.argv[1]?.endsWith('scoped-worker.mjs') ? 'monitor' : 'mcp';
  return { pid: process.pid, role, monitorPid: process.pid, monitorRole: role,
    ...(monitorId ? { monitorId } : {}) };
}

/** A final may still settle early even when its notice's own retry is backing off. */
function hasWaitingTreeFinal(value) {
  const reports = value?.reports ?? value?.task?.reports ?? [];
  return reports.some(report => report?.final === true
    && report.delivery?.waitingForTree === true
    && !['delivered', 'blocked'].includes(report.delivery?.state));
}


/** Adopt evidence from old task bodies before any attempt with the canonical ID. */
function submissionNotice(item, projection) {
  const id = submissionNoticeId(item.id);
  // The task's own report projection is the authoritative mirror while it exists;
  // the submission row is the durable copy. Prefer the projection so a repair or a
  // test that changes the task delivery state is not masked by a stale mirror.
  const sources = [projection, item.delivery].filter(Boolean);
  const terminal = sources.find(notice => notice.state === 'delivered')
    ?? sources.find(notice => notice.state === 'blocked');
  const ambiguous = sources.filter(entry => awaitingNoticeReceipt(entry)
    && !(entry.state === 'unknown' && entry.error?.message === 'claude-request-id-invalid'
      && claudeNoticeRequestId(entry.id) !== entry.id));
  const saved = terminal ?? ambiguous[0] ?? sources.find(entry => !awaitingNoticeReceipt(entry));
  const notice = { state: 'pending', ...saved, id, createdAt: projection?.createdAt ?? item.created };
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
const safeError = error => ({ code: error?.code ?? 'operation-failed', message: String(error?.message ?? error).slice(0, 1200),
  ...(error?.discoveryReason ? { discoveryReason: error.discoveryReason } : {}),
  ...(error?.notSent === true && /^(?:proxy-unavailable|proxy-required)$/.test(error.code ?? '') ? { notSent: true } : {}) });
const readOnlyTarget = record => isUnavailableStoredTarget(record?.target);
const HEADLESS_CLI_TARGETS = ['codex-cli', 'claude-cli', 'agy-cli'];
const isHeadlessCli = target => HEADLESS_CLI_TARGETS.includes(target);
const modelProviderFor = target => ({ 'claude-cli': 'claude-cli', 'agy-cli': 'antigravity' })[target] ?? 'openai';

function sumTwoUsages(a, b) {
  const valid = [a, b].filter(item => item && typeof item === 'object');
  if (!valid.length) return undefined;
  return {
    inputTokens: Math.round(valid.reduce((s, u) => s + (Number(u.inputTokens) || 0), 0)),
    outputTokens: Math.round(valid.reduce((s, u) => s + (Number(u.outputTokens) || 0), 0)),
    cachedTokens: Math.round(valid.reduce((s, u) => s + (Number(u.cachedTokens) || 0), 0)),
    totalTokens: Math.round(valid.reduce((s, u) => s + (Number(u.totalTokens) || 0), 0)),
    durationSec: Math.round(valid.reduce((s, u) => s + (Number(u.durationSec) || 0), 0) * 100) / 100,
  };
}

function normalizeTurnTimeoutOptions({ timeoutMs, timeoutMinutes } = {}) {
  let resolvedMs;
  let resolvedMinutes;
  if (timeoutMs !== undefined && timeoutMs !== null) {
    const n = Number(timeoutMs);
    if (!Number.isFinite(n) || n <= 0) {
      throw Object.assign(new Error('timeoutMs must be a positive number.'), { code: 'invalid-timeout' });
    }
    resolvedMs = Math.max(1, Math.round(n));
  }
  if (timeoutMinutes !== undefined && timeoutMinutes !== null) {
    const m = Number(timeoutMinutes);
    if (!Number.isFinite(m) || m <= 0) {
      throw Object.assign(new Error('timeoutMinutes must be a positive number.'), { code: 'invalid-timeout' });
    }
    resolvedMinutes = m;
  }
  return { timeoutMs: resolvedMs, timeoutMinutes: resolvedMinutes };
}

function effectiveTrustedCaller(extra) {
  const caller = trustedCaller(extra);
  if (caller?.source === 'antigravity'
      && typeof caller.conversationId === 'string'
      && caller.conversationId.startsWith('managed-cli:')) {
    const rest = caller.conversationId.slice('managed-cli:'.length);
    const colonIdx = rest.indexOf(':');
    const parentAgentId = (colonIdx >= 0 ? rest.slice(0, colonIdx) : rest).trim();
    const ownerId = (colonIdx >= 0 ? rest.slice(colonIdx + 1) : '').trim() || undefined;
    if (parentAgentId) {
      return {
        source: 'managed-cli',
        parentAgentId,
        callerAgentId: parentAgentId,
        ...(ownerId ? { ownerId } : {}),
        nativeSessionId: parentAgentId,
        workspace: caller.workspace,
      };
    }
  }
  if (caller?.source === "managed-cli") {
    const binding = extra?.[Symbol.for("futureaide.trustedCaller")];
    return { ...caller, callerTaskId: binding?.callerTaskId, callerRequestId: binding?.callerRequestId,
      readOnlyScout: binding?.readOnlyScout === true };
  }
  return caller;
}

function requireWritableTarget(record) {
  if (readOnlyTarget(record)) {
    throw REMOVED_TARGETS.includes(record.target) ? removedTarget(record.target) : invalidTarget(record.target);
  }
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
  if (identity?.profileId) {
    return { application: identity.application ?? null, profileId: String(identity.profileId) };
  }
  // Codex home changes wholesale when FAswitch switches profiles, and the thread
  // read is the real ownership test. Compare only the application there.
  if (target === 'codex-desktop' || isHeadlessCli(target)) return { application: identity.application ?? null };
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

/**
 * Record the bounded release exactly once. It deliberately does not set
 * treeSettledConfirmed: the real tree proof and the delivery release are two
 * different facts, and cleanup still reads only the real one.
 */
function markTreeReleased(record, report, view, reason) {
  if (!report || report.treeSettledConfirmed || report.treeReleased) return report?.treeRelease;
  const tree = ownedTree(record, view ?? {});
  // A stale or read-failed observation may supply the last node names, but the
  // release itself is marked unreadable; it never claims a current tree proof.
  const readable = Boolean(view?.tree) && view?.stale !== true && !view?.observationError && !view?.tree?.observationError;
  const release = treeReleaseRecord({
    nodes: tree.nodes,
    settled: view?.tree?.settled === true,
    running: view?.tree?.running === true,
    complete: tree.complete,
    readable,
    reason: reason ?? view?.tree?.observationError ?? view?.observationError,
    deadlineAt: finalReportDeadline(report, record.task),
  });
  report.treeReleased = true;
  report.treeRelease = release;
  if (report.delivery) Object.assign(report.delivery, { treeRelease: release,
    treeReleaseAt: release.deadlineAt });
  if (report.delivery) {
    // The release is the delivery moment; the earlier tree wait must not leave a
    // future retry stamp that makes deliver() skip this released final.
    delete report.delivery.waitingForTree;
    delete report.delivery.nextAttemptAt;
  }
  return release;
}

/** Release every final that has reached its own persisted deadline. */
function releaseDueFinals(record, view, reason) {
  let changed = false;
  for (const report of record.task?.reports ?? []) {
    if (!report.final || report.treeSettledConfirmed || report.treeReleased) continue;
    if (!treeReleaseDue(report, record.task)) continue;
    markTreeReleased(record, report, view, reason);
    changed = true;
  }
  return changed;
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
      activity: node.activity, ...(node.stalled === true ? { stalled: true } : {}),
      changes: (node.changes ?? []).slice(0, 12).map(change => fileSummary({ ...change, agentPath })),
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
  const activeDispatch = [...(task?.dispatches ?? [])].reverse().find(item => item.accepted === true);
  const visibleSelection = activeDispatch?.deliverySelection ?? activeDispatch?.model ?? (!task ? record.creationSelection : task.modelSelection);
  const error = record.error ?? task?.cancelError ?? (lastDispatch?.state === 'failed' ? lastDispatch.failure : undefined)
    ?? (!['completed', 'cancelled'].includes(lastDispatch?.state) ? lastDispatch?.error : undefined);
  const view = record.observation ?? {};
  const changes = attributedChanges(record, view);
  const explicitReports = (task?.reports ?? []).filter(report => !report.failure);
  // `codex-report-not-ready` comes from a read-only registration preflight on a
  // dispatch, not from report delivery. Once this task has a delivered report, the
  // cross-session report path is demonstrably working; a leftover preflight code is
  // noise only when no real task/supplement input is still blocked by it. A blocked
  // input keeps its own error: its body was never written.
  const blockedInputPreflight = (task?.dispatches ?? []).some(dispatch =>
    dispatch && dispatch.accepted !== true
    && (dispatch.kind === 'supplement' || dispatch.kind === 'task')
    && dispatch.error?.code === 'codex-report-not-ready');
  const publicError = error?.code === 'codex-report-not-ready'
    && hasDeliveredReport(record) && !blockedInputPreflight ? undefined : error;
  return {
    name: record.name, ...(record.role ? { role: record.role } : {}),
    ...(record.workspaceMode && record.workspaceMode !== 'inherit' ? { workspaceMode: record.workspaceMode } : {}),
    lifetime: record.lifetime, target: targetOf(record), state: record.state,
    requestedEffort: visibleSelection?.requestedEffort ?? null,
    effortSource: visibleSelection?.effortSource ?? null,
    selectedEffort: visibleSelection?.selectedEffort ?? null,
    actualEffort: activeDispatch?.actualEffort ?? null,
    actualEffortSource: activeDispatch?.actualEffort != null ? activeDispatch.actualEffortSource ?? null : null,
    ...(['current-turn', 'new-turn'].includes(activeDispatch?.delivery) ? { inputDelivery: activeDispatch.delivery } : {}),
    ...((activeDispatch?.effortAdjustment ?? visibleSelection?.effortAdjustment) ? { effortAdjustment: activeDispatch?.effortAdjustment ?? visibleSelection.effortAdjustment } : {}),
    // The full ID the target actually uses, never the caller's substring. The
    // explicit pin is a separate value and is only reported by a dispatch receipt;
    // list/wait must not present an intended selection as an observed model. An
    // unpinned Codex name starts null and becomes known from the live observation
    // before record.model catches up.
    actualModel: activeDispatch && Object.hasOwn(activeDispatch, 'actualModel') ? actualModelName(activeDispatch.actualModel)
      : record.modelPin && !isHeadlessCli(targetOf(record))
        ? actualModelName(record.model) ?? actualModelName(record.observation?.currentModel)
        : actualModelName(record.observation?.currentModel) ?? actualModelName(record.model),
    task: task ? { text: compactText(task.message, 240), state: task.state, startedAt: task.startedAt,
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.usage ? { usage: task.usage } : {}),
      ...(fullResult && task.usageDetails ? { usageDetails: task.usageDetails } : {}),
      ...(task.result ? { result: { state: task.result.state,
        ...(fullResult ? { reply: task.result.reply } : { summary: compactText(task.result.reply, 800) }),
        files: (task.result.changes ?? []).slice(0, 12).map(fileSummary), coverage: task.result.coverage } } : {}) } : null,
    ...(record.usage || task?.usage ? { usage: record.usage ?? task.usage } : {}),
    activity: view.activity ?? (record.state === 'idle' ? 'Waiting for a task' : record.state),
    ...(view.lastStep ? { lastStep: view.lastStep } : {}),
    ...(record.state === 'running' && view.stalled === true ? { stalled: true } : {}),
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
    ...(publicError ? { error: publicError } : {}),
  };
}

/**
 * A wait/list snapshot that never repeats a report body. The body is reachable
 * through the explicit futureaide_read_report page entry named here; delivery
 * status and the same submission identity remain visible.
 */
function waitItem(record, taskKey, bodyText) {
  const item = publicResult(record);
  if (item.task?.result) {
    delete item.task.result.reply;
    delete item.task.result.summary;
  }
  const reports = (record.task?.reports ?? []).filter(report => !report.failure);
  const latest = reports.at(-1);
  if (item.reports?.latest) delete item.reports.latest.summary;
  if (!latest) return item;
  const submissionId = typeof latest.id === 'string'
    ? (latest.id.startsWith('submission:') ? latest.id.slice('submission:'.length) : latest.id) : undefined;
  // An old receipt with no recoverable body gets no invented read entry. A stored
  // body (current or historical) gets the exact-page reference.
  const body = submissionId && taskKey && typeof bodyText === 'string'
    ? reportBodyReference({ taskKey, submissionId, body: bodyText }) : undefined;
  item.reports = {
    ...(item.reports ?? {}),
    latest: { ...(item.reports?.latest ?? {}), final: latest.final === true,
      delivery: latest.delivery?.state ?? 'pending',
      ...(latest.delivery?.error ? { error: latest.delivery.error } : {}),
      ...(latest.delivery?.treeRelease ? { tree: latest.delivery.treeRelease } : {}),
      ...(body ? { body } : {}) },
  };
  return item;
}

function storedBodyText(store, record, taskKey) {
  const latest = [...(record.task?.reports ?? [])].filter(report => !report.failure).at(-1);
  const id = typeof latest?.id === 'string'
    ? (latest.id.startsWith('submission:') ? latest.id.slice('submission:'.length) : latest.id) : undefined;
  if (!taskKey || !id) return undefined;
  const stored = store.storedReportBody(record.ownerId, taskKey, id);
  return stored && !stored.error && typeof stored.body === 'string' ? stored.body : undefined;
}

/**
 * Every input of the current task, including ones whose native receipt is already
 * accepted. `inspect` returns these rows so one requestId can be followed from the
 * local queue to its actual route. Fields absent from historical rows stay absent.
 */
function inputEffort(selection, actualEffort = null, adjustment, source) {
  return { requestedEffort: selection?.requestedEffort ?? null, effortSource: selection?.effortSource ?? null,
    selectedEffort: selection?.selectedEffort ?? null, actualEffort, actualEffortSource: actualEffort == null ? null : source ?? null,
    ...((adjustment ?? selection?.effortAdjustment) ? { effortAdjustment: adjustment ?? selection.effortAdjustment } : {}) };
}

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
    const delivery = dispatch.accepted === true && Object.hasOwn(dispatch, 'delivery') && dispatch.delivery === null
      ? null : dispatch.delivery ?? (dispatch.state === 'blocked' || (dispatch.state === 'failed' && dispatch.error) ? 'blocked'
        : ['sending', 'queued', 'retrying'].includes(dispatch.state) ? 'local-pending' : undefined);
    const status = lifecycle(delivery) ?? (dispatch.accepted ? 'accepted' : dispatch.state);
    put(dispatch.requestId, {
      requestId: dispatch.requestId,
      ...inputEffort(dispatch.accepted ? dispatch.deliverySelection ?? dispatch.model : dispatch.model, dispatch.accepted ? dispatch.actualEffort ?? null : null, dispatch.effortAdjustment, dispatch.actualEffortSource),
      actualModel: dispatch.accepted && Object.hasOwn(dispatch, 'actualModel') ? actualModelName(dispatch.actualModel) : null,
      ...(dispatch.mode ? { mode: dispatch.mode } : {}),
      ...(delivery === null ? { delivery: null } : delivery ? { delivery } : {}),
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
    if (answer.nativeAnswered === true) {
      // The adapter answered the native question card itself; that is the delivery,
      // not a text turn, so no turn id is invented for it.
      delivery = 'answered'; accepted = true;
    } else if (dispatch) {
      if (dispatch.accepted === true && acceptedRoute(route)) {
        delivery = 'answered'; accepted = true;
      } else if (dispatch.accepted !== true && route === 'blocked') {
        // A proven no-write (expired, refused or cancelled) is the public end of this
        // answer even when its internal state is unknown so a final report can settle.
        delivery = 'blocked'; reason = dispatch.error?.code ?? 'send-failed';
      } else if (dispatch.accepted !== true && route === 'unknown') {
        // A cancelled or failed answer whose native write was never proven is neither
        // a proven no-write nor a local wait: keep the unknown evidence.
        delivery = 'unknown'; reason = dispatch.error?.code ?? 'answer-outcome-unknown';
      } else if (dispatch.accepted !== true && answer.undelivered) {
        // A legacy row with no dispatch proof keeps the terminal reason its sender wrote.
        delivery = 'blocked'; reason = answer.undelivered;
      } else if (dispatch.accepted !== true && dispatch.state === 'unknown') {
        // An answer write whose native outcome was never proven is never replayed;
        // keep that evidence as unknown even if an older row still names a wait route.
        delivery = 'unknown'; reason = dispatch.error?.code ?? 'answer-outcome-unknown';
      } else if (dispatch.accepted !== true
          && ['cancelled', 'failed', 'blocked'].includes(dispatch.state)) {
        // A cancelled or refused answer dispatch is an execution end, not a queued
        // input. Only this answer path turns it into a public blocked row with a reason.
        delivery = 'blocked'; reason = dispatch.error?.code ?? dispatch.state;
      } else if (dispatch.accepted !== true
          && (waitingRoute(route) || ['sending', 'queued', 'retrying'].includes(dispatch.state))) {
        delivery = 'answer-pending'; queued = true;
      } else if (dispatch.accepted === true) {
        delivery = dispatch.delivery === null ? null : 'accepted-route-unknown'; accepted = true;
      } else if (route === 'blocked' || dispatch.state === 'blocked'
          || (dispatch.state === 'failed' && dispatch.error)) {
        delivery = 'blocked'; reason = dispatch.error?.code ?? 'send-failed';
      } else {
        delivery = 'unknown'; reason = dispatch.error?.code ?? 'answer-outcome-unknown';
      }
    } else if (answer.undelivered) {
      delivery = 'blocked'; reason = answer.undelivered;
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
      ...inputEffort((dispatch?.accepted ? dispatch.deliverySelection : undefined) ?? dispatch?.model ?? answer.modelSelection, dispatch?.accepted ? dispatch.actualEffort ?? null : answer.actualEffort ?? null, dispatch?.effortAdjustment, dispatch?.actualEffortSource ?? answer.actualEffortSource),
      actualModel: dispatch?.accepted && Object.hasOwn(dispatch, 'actualModel') ? actualModelName(dispatch.actualModel) : null,
      mode: 'steer',
      delivery,
      accepted,
      queued,
      ...(dispatch?.turnId ?? answer.turnId ? { turnId: dispatch?.turnId ?? answer.turnId } : {}),
      ...(dispatch?.afterTurnId ?? answer.afterTurnId ? { afterTurnId: dispatch?.afterTurnId ?? answer.afterTurnId } : {}),
      ...(reason ? { reason } : {}),
      status: lifecycle(delivery) ?? (accepted ? 'accepted' : 'unknown'),
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
        : route === 'blocked' ? 'blocked'
          : route === 'unknown' ? 'unknown'
            : dispatch.state === 'unknown' ? 'unknown'
            : ['cancelled', 'failed', 'blocked'].includes(dispatch.state) ? 'blocked'
              : waitingRoute(route) ? route
                : ['sending', 'queued', 'retrying'].includes(dispatch.state) ? 'answer-pending'
                  : route ?? 'unknown';
    put(dispatch.requestId, {
      requestId: dispatch.requestId,
      ...(dispatch.mode ? { mode: dispatch.mode } : {}),
      delivery,
      accepted: dispatch.accepted === true,
      queued: dispatch.accepted !== true && (waitingRoute(delivery) || ['sending', 'queued', 'retrying'].includes(dispatch.state)),
      ...(dispatch.turnId ? { turnId: dispatch.turnId } : {}),
      ...(dispatch.afterTurnId ? { afterTurnId: dispatch.afterTurnId } : {}),
      ...(dispatch.error?.code ? { reason: dispatch.error.code }
        : delivery === 'blocked' ? { reason: dispatch.state } : {}),
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
export function claudeNoticeReceipt(deliveries, requestId, expectedBodyHash) {
  if (!Array.isArray(deliveries) || typeof requestId !== 'string') return undefined;
  return deliveries.find(item => item?.requestId === requestId && ['accepted', 'inserted'].includes(item.stage)
    && (item.bodyHash === undefined || item.bodyHash === expectedBodyHash));
}

const CLAUDE_STALE_BINDING = ['claude-session-changed', 'claude-process-replaced', 'claude-inbox-key-mismatch',
  'claude-binding-mismatch', 'claude-transcript-unresolved', 'claude-binding-invalid', 'claude-transcript-replaced'];

/** A cached Claude transport binding the session has outgrown: refresh it once. */
export const claudeBindingStale = error =>
  CLAUDE_STALE_BINDING.some(code => String(error?.message ?? error ?? '').includes(code));

const CLAUDE_PAGE_BYTES = 1 << 20;
const CLAUDE_MAX_PAGE_BYTES = 16 << 20;
const CLAUDE_PAGES_PER_POLL = 8;
// The native peer user insertion can carry a new UUID. Older cursors have
// already walked past those receipts, so they are discarded once.
export const CLAUDE_RECEIPT_PARSER = 3;

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

export async function findClaudeReceipt(binding, notice, readEvents = readClaudeEvents, expectedBodyHash) {
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
    const matched = requestIds.map(id => claudeNoticeReceipt(read.deliveries, id, expectedBodyHash)).find(Boolean);
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
  const dueSoon = notice => Boolean(notice) && !['delivered', 'blocked', 'pull_ready'].includes(notice.state ?? 'pending')
    && (!notice.nextAttemptAt || notice.nextAttemptAt <= at + FAST_POLL_DUE_MS);
  if ((record.task?.reports ?? []).some(report => dueSoon(report.delivery))) return true;
  if (Object.values(record.task?.questionNotices ?? {}).some(dueSoon)) return true;
  if ((record.task?.dispatches ?? []).some(dispatch => dispatch.state === 'retrying' && dueSoon(dispatch))) return true;
  return typeof record.nextAttemptAt === 'number' && record.nextAttemptAt <= at + FAST_POLL_DUE_MS;
}

/** Name-addressed operations; owner and native identifiers never come from tool arguments. */
export function createScopedAgents(config, {
  teamConfigPath = config?.teamConfigPath || process.env.FUTUREAIDE_ROLES_CONFIG,
  store = new RosterStore(path.join(config.stateDirectory, 'roster.sqlite'), { teamConfigPath }),
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
  checkCliProxy = undefined,
  spawnFaswitch = undefined,
  findFaswitchExe = undefined,
  faswitchWakeTimeoutMs = 5000,
} = {}) {
  const notify = notifyDesktop ?? createDesktopToastNotifier();
  const settlementInflight = new Map();
  let lastFaswitchWakeAt = 0;

  function applyCallerDefaults({ role, target, model, effort, lifetime } = {}) {
    const requestedRole = normalizeRole(role, { teamConfigPath });
    const explicitRole = requestedRole;
    const dshDisabled = Array.isArray(config?.disabledTargets) && config.disabledTargets.includes('dsh');
    if (!explicitRole && !dshDisabled) {
      return {
        explicitRole,
        target,
        model,
        effort,
        lifetime,
        autoFilledModel: false,
        autoFilledEffort: false,
      };
    }
    const defaults = resolveRoleDefaults(explicitRole, { teamConfigPath });
    if (explicitRole && (explicitRole.toLowerCase() === 'boss' || (defaults.source === 'file' && !defaults.matched))) {
      throw Object.assign(new Error('This role is not dispatchable in the current team configuration.'), { code: 'invalid-role' });
    }
    const effectiveTarget = target !== undefined ? target : defaults.target;
    const normalizedTarget = normalizeTarget(effectiveTarget);
    const sameDefaultTarget = normalizedTarget === defaults.target;
    const autoFilledModel = model === undefined && sameDefaultTarget && Boolean(defaults.model);
    const autoFilledEffort = effort === undefined && sameDefaultTarget && Boolean(defaults.effort);
    return {
      explicitRole,
      target: effectiveTarget,
      model: autoFilledModel ? defaults.model : model,
      effort: autoFilledEffort ? defaults.effort : effort,
      lifetime: lifetime !== undefined ? lifetime : defaults.lifetime,
      autoFilledModel,
      autoFilledEffort,
    };
  }

  function buildWakeCmd(owner, taskKeys, { batch = false } = {}) {
    const validKeys = (Array.isArray(taskKeys) ? taskKeys : [taskKeys])
      .filter(key => typeof key === 'string' && key.trim());
    if (!validKeys.length) return undefined;
    const conv = owner?.source === 'antigravity'
      ? owner.conversationId
      : (owner?.source === 'codex-desktop' ? owner.threadId : (owner?.ownerId ?? owner?.nativeSessionId));
    const convArg = conv ? ` --conv "${conv}"` : '';
    const barrierArg = batch || validKeys.length > 1 ? ' --barrier all' : '';
    return `futureaide-wait${convArg} --keys "${validKeys.join(',')}"${barrierArg}`;
  }

  async function defaultFindFaswitchExe(effectiveConfig) {
    const candidates = [
      effectiveConfig?.faswitchExecutable,
      'C:\\Program Files\\FAswitch\\FAswitch.exe',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'FAswitch', 'FAswitch.exe') : undefined,
      (() => { const root = defaultFaswitchRoot(); return root ? path.join(root, 'FAswitch.exe') : undefined; })(),
      effectiveConfig?.faswitchHome ? path.join(effectiveConfig.faswitchHome, 'FAswitch.exe') : undefined,
    ].filter(item => typeof item === 'string' && item.trim());
    for (const candidate of candidates) {
      try {
        const meta = await lstat(candidate);
        if (meta.isFile()) return candidate;
      } catch {}
    }
    return null;
  }

  async function tryAutoWakeFaswitch(effectiveConfig) {
    if (effectiveConfig?.autoWakeFaswitch !== true) return false;
    const nowMs = Date.now();
    if (nowMs - lastFaswitchWakeAt < 3000) return true;
    const finder = findFaswitchExe ?? defaultFindFaswitchExe;
    const exe = await finder(effectiveConfig);
    if (!exe) return false;
    lastFaswitchWakeAt = nowMs;
    if (typeof spawnFaswitch === 'function') {
      await spawnFaswitch(exe, ['--autostart']);
      return true;
    }
    try {
      const child = spawn(exe, ['--autostart'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  async function resolveManagedCliRoute(target, effectiveConfig = config, extraOpts = {}) {
    const check = extraOpts.checkProxy ?? checkCliProxy;
    const probeOnce = () => resolveCliRoute({
      ...extraOpts,
      target,
      config: effectiveConfig,
      requireProxy: effectiveConfig?.requireProxy === true || extraOpts.requireProxy === true,
      ...(check ? { checkProxy: check } : {}),
    });
    let route = await probeOnce();
    if (!route.ok && effectiveConfig?.autoWakeFaswitch === true
        && ['proxy-unavailable', 'faswitch-proxy-inactive'].includes(route.code)) {
      const woken = await tryAutoWakeFaswitch(effectiveConfig);
      if (woken) {
        const deadline = Date.now() + faswitchWakeTimeoutMs;
        while (Date.now() < deadline) {
          await wait(200);
          route = await probeOnce();
          if (route.ok) break;
        }
      }
    }
    return route;
  }

  function cliConfigForRecord(current) {
    const { antigravityCallerTokenFile: _desktopToken, ...childConfig } = config;
    if (!current || current.proxyOverride === undefined) return childConfig;
    return {
      ...childConfig,
      cliRoutes: {
        ...(config.cliRoutes ?? {}),
        [targetOf(current)]: current.proxyOverride,
      },
    };
  }

  function hasExplicitClaudeProxyPolicy(current) {
    return Boolean(
      current?.proxyOverride !== undefined
      || config?.requireProxy === true
      || config?.cliRoutes?.['claude-cli'] !== undefined
      || config?.claudeCliProxy !== undefined
      || config?.claudeCliProxyPort !== undefined
      || process.env.FUTUREAIDE_CLAUDE_CLI_PROXY
      || process.env.FUTUREAIDE_CLAUDE_CLI_PROXY_PORT
      || process.env.FUTUREAIDE_CLI_PROXY,
    );
  }

  async function verifyClaudeCliProxyIfConfigured(current) {
    if (targetOf(current) !== 'claude-cli' || !hasExplicitClaudeProxyPolicy(current)) return undefined;
    const route = await resolveManagedCliRoute('claude-cli', cliConfigForRecord(current));
    if (!route.ok) {
      throw Object.assign(new Error(route.error ?? 'Claude CLI proxy is unreachable; refusing direct fallback.'), {
        code: route.code ?? 'proxy-unavailable',
        terminal: true,
        notSent: true,
      });
    }
    return route;
  }
  const waitListeners = new Set();
  let waitWatcher, waitTimer, waitVersion, waitChanges, waitsClosed = false;
  const wakeWaiters = () => { for (const wake of [...waitListeners]) wake(); };
  function subscribeWait(wake) {
    waitListeners.add(wake);
    if (waitListeners.size === 1) {
      waitVersion = store.dataVersion();
      waitChanges = store.changed();
      if (store.location !== ':memory:') {
        try {
          const base = path.basename(store.location);
          waitWatcher = watch(path.dirname(store.location), { persistent: false }, (_, filename) => {
            if (!filename || String(filename).startsWith(base)) wakeWaiters();
          });
          waitWatcher.on('error', () => {});
        } catch {}
      }
      waitTimer = setInterval(() => {
        try {
          const version = store.dataVersion(), changes = store.changed();
          if (version !== waitVersion || changes !== waitChanges) {
            waitVersion = version; waitChanges = changes; wakeWaiters();
          }
        } catch { wakeWaiters(); }
      }, 1000);
      waitTimer.unref?.();
    }
    return () => { waitListeners.delete(wake); if (!waitListeners.size) { waitWatcher?.close(); waitWatcher = undefined; clearInterval(waitTimer); waitTimer = undefined; } };
  }

  // One reminder is due once this notice has found its session gone for this long.
  const callbackReminderWait = claudeCallbackReminderMs(config.claudeCallbackReminderMs);
  const claudeSend = claudeInbox.send ?? sendClaude;
  const claudeDiscover = claudeInbox.discover ?? discoverClaude;
  const claudeReadEvents = claudeInbox.readEvents ?? readClaudeEvents;
  const claudeBind = claudeInbox.bind ?? bindClaude;
  const clients = new Map();
  const operationBackends = new WeakMap();
  const inflight = new Map(), monitorInflight = new Map();
  let recoveredFaultSequence = 0;
  const transportWaitOwner = randomUUID();
  function supersededRead(error) {
    return error?.transportStale === true ||
      (error?.transportFaultSequence > 0 && error.transportFaultSequence <= recoveredFaultSequence);
  }
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
  // Distinguishes one poll pass from the next for receipt read-back. It starts at
  // the wall clock so a persisted marker from a previous process can never match.
  let pollGeneration = Date.now();
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
  const scopedRoot = path.resolve(config.stateDirectory, 'scoped');
  const agentDirectory = record => path.join(scopedRoot, record.ownerId, record.agentId);
  const removeScopedDirectory = async directory => {
    if (!path.relative(scopedRoot, directory)) throw worktreeError('worktree-unverified', 'Cannot remove the whole state root.');
    if (await plainDirectoryPath(scopedRoot, directory)) await removeTree(directory, { recursive: true, force: true });
  };
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
      if (waitsClosed) return;
      const live = store.get(record.agentId);
      if (!live || live.closed) return;
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
    sessionId: record.sessionId, workspace: record.workspace, feedbackAgentName: record.name ?? null, feedbackCallerHost: store.owner(record.ownerId)?.source ?? null, treeProtocol: TREE_PROTOCOL, reportProtocol: REPORT_PROTOCOL,
    ...(record.task ? { taskId: record.task.taskId } : {}) });
  // Handles an adapter needs on the shared side: the target's own state in its own
  // row (never inside the record the shared layer will save again) and one host
  // lock per target application, reusing the existing lease table.
  const adapterDeps = record => {
    const load = () => store.get(record.agentId) ?? record;
    const target = targetOf(record);
    const buildCallerEnv = (current = load(), requestId = undefined) => {
      const base = {
        FUTUREAIDE_MANAGED_CLI: '1',
        FUTUREAIDE_PARENT_AGENT_ID: current.agentId ?? record.agentId,
        ...((current.role ?? record.role) ? { FUTUREAIDE_CALLER_ROLE: String(current.role ?? record.role) } : {}),
        ...(current.task?.taskId ? { FUTUREAIDE_PARENT_TASK_ID: current.task.taskId } : {}),
        ...(requestId ? { FUTUREAIDE_PARENT_REQUEST_ID: requestId } : {}),
        FUTUREAIDE_CALLER_OWNER_ID: current.ownerId ?? record.ownerId,
        FUTUREAIDE_CALLER_WORKSPACE: current.rootWorkspace ?? current.workspace ?? record.workspace ?? '',
        FUTUREAIDE_ROSTER_PATH: store.location,
        FUTUREAIDE_REPORT_PORT: String(activeReportPort(config)),
        ...(config.configFile ? { FUTUREAIDE_CONFIG: config.configFile } : {}),
        ...(teamConfigPath ? { FUTUREAIDE_ROLES_CONFIG: path.resolve(teamConfigPath) } : {}),
        FUTUREAIDE_MANAGED_CLI_TOKEN_FILE: process.env.FUTUREAIDE_MANAGED_CLI_TOKEN_FILE
          || managedTokenFile(config.antigravityCallerTokenFile) || path.join(config.stateDirectory, MANAGED_TOKEN_FILENAME),
      };
      if (current._resolvedProxyRoute && (current._resolvedProxyRoute.mode === 'proxy' || current._resolvedProxyRoute.mode === 'direct')) {
        return buildCliProxyEnv(base, current._resolvedProxyRoute);
      }
      return base;
    };
    const bridgeScript = fileURLToPath(new URL('./cli-callback-bridge.mjs', import.meta.url));
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
      ...(isHeadlessCli(target) ? {
        get callerEnv() { return buildCallerEnv(load()); },
      } : {}),
      ...(target === 'claude-cli' ? {
        get config() { return cliConfigForRecord(load()); },
        resolveRoute: opts => resolveManagedCliRoute('claude-cli', cliConfigForRecord(load()), opts),
        readParentSubmissions: () => readParentSubmissions(load()),
        claudeReportConfig: requestId => {
          const current = load();
          const envVars = buildCallerEnv(current, requestId);
          return {
            mcpServers: {
              futureaide: {
                type: 'stdio',
                command: process.execPath,
                args: [bridgeScript, '--claude-cli-reports',
                  store.location, record.agentId, current.task.taskId, requestId, config.configFile ?? '',
                  ...(config.idleSessionCleanup === false ? ['--no-idle-session-cleanup'] : [])],
                env: envVars,
              },
            },
            callerEnv: envVars,
          };
        },
      } : {}),
      ...(target === 'codex-cli' ? {
        get config() { return cliConfigForRecord(load()); },
        resolveRoute: opts => resolveManagedCliRoute('codex-cli', cliConfigForRecord(load()), opts),
        readParentSubmissions: () => readParentSubmissions(load()),
        codexCliReportConfig: requestId => {
          const current = load();
          const envVars = buildCallerEnv(current, requestId);
          return {
            serverName: 'futureaide_report',
            command: process.execPath,
            args: [bridgeScript, '--codex-cli-reports',
              store.location, record.agentId, current.task.taskId, requestId, config.configFile ?? '',
              ...(config.idleSessionCleanup === false ? ['--no-idle-session-cleanup'] : [])],
            env: envVars,
            callerEnv: envVars,
          };
        },
      } : {}),
      ...(target === 'agy-cli' ? {
        get config() { return cliConfigForRecord(load()); },
        resolveRoute: opts => resolveManagedCliRoute('agy-cli', cliConfigForRecord(load()), opts),
        readParentSubmissions: () => readParentSubmissions(load()),
        agyCliReportConfig: requestId => {
          const current = load();
          const envVars = buildCallerEnv(current, requestId);
          return {
            serverName: 'futureaide_report',
            command: process.execPath,
            args: [bridgeScript, '--agy-cli-reports',
              store.location, record.agentId, current.task.taskId, requestId, config.configFile ?? '',
              ...(config.idleSessionCleanup === false ? ['--no-idle-session-cleanup'] : [])],
            env: envVars,
            callerEnv: envVars,
          };
        },
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
      return resolveBackend(record, { target, load, deps, config, dsh: { client, requestDirectory: deps.requestDirectory,
        control: () => controlFactory(settings(load()), { client, managed: hostArgs(load()) }),
        hostArgs: () => hostArgs(load()) } });
    }
    return resolveBackend(record, { target, load, deps, config: isHeadlessCli(target) ? deps.config : config,
      adapters: backendAdapters, ...(backendAdapterLoader ? { adapterLoader: backendAdapterLoader } : {}) });
  }
  const forgetBackend = record => { clients.delete(record.agentId); operationBackends.delete(record); };
  // A target without a usable adapter is refused before the name is taken, and is
  // never answered by the DSH path instead. Pre-conditions that would only fail
  // later (unfinished protocols, a tool service that never came up) are settled
  // here too, so a broken name is never left in the roster.
  async function ensureTargetBackend(record) {
    const target = targetOf(record);
    if (target === 'dsh') {
      if (Array.isArray(config?.disabledTargets) && config.disabledTargets.includes('dsh')) {
        await resolveBackend(record, { target, load: () => record, config });
      }
      return target;
    }
    const deps = adapterDeps(record);
    if (target === 'claude-cli') {
      const route = await verifyClaudeCliProxyIfConfigured(record);
      if (route) record._resolvedProxyRoute = route;
    }
    const backend = await resolveBackend(record, { target, load: () => record, deps,
      config: isHeadlessCli(target) ? deps.config : config, adapters: backendAdapters,
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

  function rootRecordOf(record) {
    const seen = new Set();
    let current = record;
    while (current?.parentAgentId && !seen.has(current.agentId)) {
      seen.add(current.agentId);
      const parent = store.get(current.parentAgentId);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  function rootOwnerIdForRecord(record) {
    const root = rootRecordOf(record);
    return root?.ownerId ?? record?.ownerId;
  }

  async function context(extra) {
    // The owner comes from a verified caller (Codex chat metadata, a verified
    // Claude native session, an authenticated Antigravity caller, or a managed-cli
    // team lead); owner ids are namespaced by source, so the same name in two
    // applications never collides.
    const caller = effectiveTrustedCaller(extra);
    if (caller?.source === 'managed-cli') {
      const parentRecord = caller.parentAgentId ? store.get(caller.parentAgentId) : undefined;
      const effectiveCliOwnerId = caller.ownerId
        || (parentRecord ? rootOwnerIdForRecord(parentRecord) : undefined)
        || ownerIdForSource('managed-cli', caller.parentAgentId);
      const known = store.owner(effectiveCliOwnerId);
      const resolved = await resolveCallingContext({
        ...extra,
        [Symbol.for('futureaide.trustedCaller')]: { ...caller, ownerId: effectiveCliOwnerId },
      }, {
        knownOwner: known,
        defaultWorkspace: parentRecord?.rootWorkspace ?? parentRecord?.workspace ?? config.workspace,
      });
      const { callerAgentId, parentAgentId: _parent, ...persistable } = resolved;
      const saved = store.saveOwner(persistable);
      return {
        ...saved,
        ...(callerAgentId ? { callerAgentId, parentAgentId: callerAgentId } : {}),
      };
    }
    const callerKey = caller?.source === 'antigravity'
      ? (caller.conversationId ?? caller.nativeSessionId)
      : caller?.nativeSessionId;
    const ownerId = caller ? ownerIdForSource(caller.source, callerKey) : ownerIdFor(callingThread(extra));
    return store.saveOwner(await resolveCallingContext(extra,
      { knownOwner: store.owner(ownerId), callCodex: codexOwnerCall, nativeRequest, verifyClaude, bindOwner: bindClaude,
        defaultWorkspace: config.workspace }));
  }

  function resolveTeamRootOwnerId(owner, extra) {
    if (owner?.callerAgentId) {
      const parent = store.get(owner.callerAgentId);
      if (parent) return rootOwnerIdForRecord(parent);
    }
    if (!effectiveTrustedCaller(extra)) {
      try {
        const bound = store.agentForCodexThread(callingThread(extra), { includeAutoClosed: true });
        if (bound) {
          const rec = store.get(bound.agentId);
          if (rec) return rootOwnerIdForRecord(rec);
          return bound.ownerId;
        }
      } catch {}
    }
    return owner.ownerId;
  }
  /**
   * Records this owner can see: its own, plus every managed descendant that a
   * session beneath it created — including descendants on another application,
   * which have their own owner id. One tree, one state machine.
   */
  function visibleRecords(ownerId) {
    const own = store.list(ownerId);
    const descendants = store.descendantsOf(own.map(record => record.agentId));
    const seen = new Set();
    const all = [];
    for (const rec of [...own, ...descendants]) {
      if (rec && !seen.has(rec.agentId)) {
        seen.add(rec.agentId);
        all.push(rec);
      }
    }
    return { own, all };
  }
  function permittedRecords(owner, extra) {
    if (effectiveTrustedCaller(extra)?.source === "managed-cli") {
      return owner.callerAgentId ? store.descendantsOf([owner.callerAgentId]) : [];
    }
    return visibleRecords(resolveTeamRootOwnerId(owner, extra)).all;
  }

  function canAccessMember(owner, extra, member) {
    return Boolean(member && (effectiveTrustedCaller(extra)?.source === "managed-cli"
      ? owner.callerAgentId && isDescendant(store, member, owner.callerAgentId)
      : rootOwnerIdForRecord(member) === resolveTeamRootOwnerId(owner, extra)));
  }

  function named(owner, name, extra) {
    const wanted = assertName(name);
    const teamAll = permittedRecords(owner, extra);
    if (wanted.startsWith('agent-')) {
      const byId = teamAll.find(r => r.agentId === wanted);
      if (byId) return byId;
    }
    const byPath = wanted.includes("/") ? teamAll.filter(r => managedPath(r) === wanted) : [];
    if (byPath.length === 1) return byPath[0];
    if (byPath.length > 1) {
      const paths = byPath.map(r => managedPath(r));
      throw Object.assign(
        new Error(`“${wanted}” matches multiple team members: ${paths.join(', ')}. Pass the full team path to disambiguate.`),
        { code: 'node-ambiguous', paths },
      );
    }
    const byShort = teamAll.filter(r => r.name === wanted);
    if (byShort.length === 1) return byShort[0];
    if (byShort.length > 1) {
      const paths = byShort.map(r => managedPath(r));
      throw Object.assign(
        new Error(`“${wanted}” matches multiple team members: ${paths.join(', ')}. Pass a team path such as “${paths[0]}” to disambiguate.`),
        { code: 'node-ambiguous', paths },
      );
    }
    throw Object.assign(new Error(`No subagent named “${name}” exists in this chat.`), { code: 'agent-not-found' });
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
        // A DSH native report already has a persistent report UUID. It is absorbed
        // under that same identity, not duplicated as a second submission report.
        const existing = record.task.reports.find(report => sameReportId(report.id, submissionRef(item.id))
          || sameReportId(report.id, item.id) || report.sharedSubmission === item.id)
          ?? record.task.reports.find(report => !fromSubmission(report.id) && (report.message === item.message
            || (typeof report.message === 'string' && report.message.startsWith(item.message)))
            && report.final === item.final && report.createdAt === item.created);
        if (existing) {
          existing.sharedSubmission = item.id;
          if (existing.final !== item.final || (existing.message !== item.message
              && !(typeof existing.message === 'string' && existing.message.startsWith(item.message)))) {
            throw Object.assign(new Error('A persisted report identity changed.'), { code: 'report-identity-changed' });
          }
        } else {
          record.task.reports.push({ id: submissionRef(item.id), taskId: record.task.taskId,
            message: item.message, final: item.final, createdAt: item.created, delivery: submissionNotice(item),
            sharedSubmission: item.id });
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
      if (!fromSubmission(report.id)) {
        // A terminal failure notice is an internal prompt, not a parent report.
        if (report.failure) continue;
        // Native DSH reports carry a persistent report UUID. Persist its body and,
        // while it still owes delivery, fold it into the same submission state so
        // the wait exit and the native notification share one identity.
        store.saveReportBody({ ownerId: record.ownerId, agentId: record.agentId, taskId: task.taskId,
          submissionId: report.id, body: report.message, created: report.createdAt ?? task.startedAt ?? '' });
        if (!nativeReportOnly(record) && !terminalNotice(report.delivery) && !report.delivery?.attemptedAt
            && (report.delivery?.state ?? 'pending') === 'pending') {
          store.enqueueSubmission({ id: report.id, ownerId: record.ownerId, agentId: record.agentId,
            taskId: task.taskId, kind: 'report', message: report.message, final: report.final,
            created: report.createdAt ?? task.startedAt ?? '' });
          report.sharedSubmission = report.id;
        }
        continue;
      }
      const id = report.id.slice('submission:'.length);
      if (report.delivery?.id !== submissionNoticeId(id)) {
        store.enqueueSubmission({ id, ownerId: record.ownerId, agentId: record.agentId, taskId: task.taskId,
          kind: 'report', message: report.message, final: report.final, created: report.createdAt ?? task.startedAt ?? '' });
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
      let report = item.kind === 'report' ? round?.reports?.find(entry => entry.id === ref
        || entry.id === item.id || entry.sharedSubmission === item.id) : undefined;
      const notice = submissionNotice(item, report?.delivery ?? round?.questionNotices?.[ref]);
      let message;
      if (report?.treeRelease) Object.assign(notice, { treeRelease: report.treeRelease, treeReleaseAt: report.treeRelease.deadlineAt, treeReleased: true });
      const persist = () => {
        const previousReport = report, previousReports = task?.reports;
        const previousDelivery = report?.delivery, previousQuestions = task?.questionNotices;
        if (current) {
          if (item.kind === 'report') {
            if (!report) {
              report = { id: ref, taskId: item.taskId, message: message ?? item.message, final: item.final, createdAt: item.created };
              task.reports = [...(previousReports ?? []), report];
            }
            report.message = message ?? item.message;
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
      message = item.kind === 'report'
        ? exactReportText(record, round, report ?? { id: item.id }, item.message) : item.message;
      const missingTree = round?.treeUnavailable === 'codex-thread-not-found' && !report?.treeSettledConfirmed;
      let ready = item.kind !== 'report' || !item.final || !current || finalReportReady(report) || missingTree;
      if (item.kind === 'ask') {
        const answered = round?.answers?.some(answer => answer.questionIds?.includes(ref));
        const active = current && !answered && !round.treeUnavailable && !terminalRound(store.get(record.agentId) ?? record)
          && !isCancelledRound(store.get(record.agentId) ?? record);
        if (active && presentedNativeQuestion(record)) ready = false;
        text = active ? questionPrompt(record, item.message) : `${name}旧轮次提问：\n${item.message}`;
      } else {
        const label = current ? (item.final ? '交付' : '汇报') : (item.final ? '旧轮次最终汇报' : '旧轮次汇报');
        text = `${name}${label}：\n${message}${item.final && missingTree ? '\n\n' + MISSING_CODEX_TREE : ''}`;
        if (report?.treeRelease) text += '\n\n' + treeReleaseText(report.treeRelease);
      }
      if ((notice.waitingForTree && ready) || (readOnDemand && awaitingNoticeReceipt(notice))) {
        delete notice.waitingForTree;
        delete notice.nextAttemptAt;
      }
      await deliver(record, notice, text, { persist, allowSend: ready, submission: true,
        treeDeadline: item.kind === 'report' ? finalReportDeadline(report ?? { createdAt: item.created }, task) : undefined,
        // Only a real report is reminded to the user; an ask is answered, not read later.
        ...(item.kind === 'report' ? { reportSummary: message } : {}) });
    }
  }
  async function withName(extra, name, action, options) {
    const owner = await context(extra);
    const rootOwnerId = resolveTeamRootOwnerId(owner, extra);
    const record = named(owner, name, extra);
    return store.locked(record.agentId, async () => {
      const fresh = store.get(record.agentId);
      if (!fresh || (fresh.ownerId !== owner.ownerId && rootOwnerIdForRecord(fresh) !== rootOwnerId)) {
        throw new Error('This subagent instance has already been removed.');
      }
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
    if (record.autoCleanupPending === true || record.task?.autoCleanupPending === true) return true;
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
  function announceWork(agentId) { wakeWaiters(); try { if (agentId) onWorkQueued(agentId); } catch { /* a hint is never worth failing a call for */ } }

  async function ensureWorker(record, { wake = false, hasSubmission = false, ensure = ensureMonitor } = {}) {
    if (!record || readOnlyTarget(record)) return false;
    if (wake && record.sleep) {
      if (!await ensure()) {
        // Nothing can watch this installation right now. Keep the sleeping
        // baseline so a later call resumes the same task instead of losing it.
        store.setError(record.agentId, monitorError ?? { code: 'monitor-unavailable', message: 'The shared monitor could not start.' }, record);
        return false;
      }
      store.wake(record.agentId, record.sleep.taskId);
      record = store.get(record.agentId) ?? record;
    }
    if (record.sleep) return true;
    if (!needsPoll(record, hasSubmission)) return false;
    const ready = await ensure();
    if (!ready) store.setError(record.agentId, monitorError ?? { code: 'monitor-unavailable', message: 'The shared monitor could not start.' }, record);
    // Only an explicit wake — new work arriving from outside — is news for the loop. A
    // poll also calls this, and announcing from there would make every poll re-hint its
    // own name and turn the loop into a self-feeding burst.
    else if (wake) announceWork(record.agentId);
    return ready;
  }

  /** The record's own backend observation, exactly as its host reported it. */
  async function observeOwn(record) {
    const observed = await withCodexInstrumentation({ agentId: record.agentId }, async () => {
      const backend = await checkHost(record);
      return backend.observe();
    });
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
    if (own.usage && record.task) {
      record.task.usage = { ...own.usage };
    }
    if (own.usage || record.historicalUsage || own.agentUsage) {
      record.usage = record.task?.usage
        ? sumTwoUsages(record.historicalUsage, record.task.usage)
        : (record.historicalUsage ?? (own.agentUsage ? { ...own.agentUsage } : undefined));
    }
    const evidence = own.modelEvidence;
    if (evidence?.businessAccepted === true && evidence.requestId && evidence.actualEffort != null) {
      const dispatch = record.task?.dispatches?.find(item => item.requestId === evidence.requestId && item.accepted === true);
      if (dispatch && (!evidence.turnId || !dispatch.turnId || evidence.turnId === dispatch.turnId)) {
        dispatch.actualEffort = evidence.actualEffort;
        dispatch.actualEffortSource = evidence.actualEffortSource ?? 'host-readback';
        if (evidence.effortAdjustment) dispatch.effortAdjustment = evidence.effortAdjustment;
        if (evidence.model) dispatch.actualModel = evidence.model;
      }
    }
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
  function sameTurnSelection(left, right, fields = { model: true, effort: true }) {
    if (!left || !right) return false;
    const text = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
    const model = text(left.model);
    if (fields.model && (!model || model !== text(right.model))) return false;
    if (fields.effort && (!text(right.reasoningEffort) || text(left.reasoningEffort) !== text(right.reasoningEffort))) return false;
    return !fields.model || !text(left.provider) || !text(right.provider) || text(left.provider) === text(right.provider);
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
    // A saved task dispatch is evidence only for the exact turn the root reports. A
    // later turn B in the same task must not borrow the first dispatch's selection.
    const turnId = root?.turnId;
    if (!turnId) return root?.selection;
    const started = (record.task?.dispatches ?? []).find(dispatch => dispatch.accepted === true
      && dispatch.delivery === 'new-turn' && dispatch.model && dispatch.turnId === turnId);
    const evidence = started?.model ? { ...started.model,
      ...(started.actualEffort !== undefined ? { reasoningEffort: started.actualEffort, actualEffortSource: started.actualEffortSource } : {}) } : undefined;
    return root?.selection ? { ...evidence, ...root.selection,
      reasoningEffort: root.selection.reasoningEffort ?? evidence?.reasoningEffort,
      actualEffortSource: root.selection.reasoningEffort != null ? 'host-readback' : evidence?.actualEffortSource } : evidence;
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
      const match = await backend.matchRootSelection({ selection, explicitFields: selection?.explicitFields ?? { model: true, effort: true },
        ...(root?.turnId ? { turnId: root.turnId } : {}) });
      return match?.status;
    }
    const active = activeTurnSelection(record, root);
    if (!active || (selection?.explicitFields?.effort && !active.reasoningEffort)) return 'unknown';
    return sameTurnSelection(selection, active, selection?.explicitFields) ? 'same' : 'different';
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

  function effortReceipt(selection, actualEffort = null, adjustment, source) {
    if (!selection) return { actualEffort, actualEffortSource: actualEffort == null ? null : source ?? null };
    return { requestedEffort: selection.requestedEffort ?? null,
      effortSource: selection.effortSource ?? null, selectedEffort: selection.selectedEffort ?? null,
      actualEffort, actualEffortSource: actualEffort == null ? null : source ?? null, ...((adjustment ?? selection.effortAdjustment) ? { effortAdjustment: adjustment ?? selection.effortAdjustment } : {}) };
  }

  function dispatchReceipt(dispatch) {
    if (!dispatch) return {};
    return {
      ...(dispatch.delivery === null && dispatch.accepted ? { delivery: null } : dispatch.delivery ? { delivery: dispatch.delivery } : {}),
      ...(dispatch.accepted === true ? { accepted: true, queued: false } : {}),
      ...(dispatch.turnId ? { turnId: dispatch.turnId } : {}),
      ...(dispatch.delivery !== 'current-turn' && dispatch.afterTurnId ? { afterTurnId: dispatch.afterTurnId } : {}),
      ...(dispatch.deliveryIntent?.method ? { method: dispatch.deliveryIntent.method } : {}),
      ...(dispatch.deliveryIntent?.expectedTurnId ? { expectedTurnId: dispatch.deliveryIntent.expectedTurnId } : {}),
      ...(dispatch.mode ? { mode: dispatch.mode } : {}),
      selectionExplicit: dispatch.selectionExplicit === true,
      ...effortReceipt(dispatch.accepted ? dispatch.deliverySelection ?? dispatch.model : dispatch.model, dispatch.actualEffort, dispatch.effortAdjustment, dispatch.actualEffortSource),
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
    const delivery = dispatch?.accepted === true && Object.hasOwn(dispatch, 'delivery') && dispatch.delivery === null
      ? null : terminalDelivery ?? stored.delivery ?? dispatch?.delivery ?? fallback.delivery ?? 'local-pending';
    const accepted = item?.status === 'blocked' ? false
      : item?.status === 'accepted' || dispatch?.accepted === true || deliveryAccepted(delivery);
    const queued = !accepted && item?.status !== 'blocked' && (deliveryQueued(delivery)
      || ['queued', 'sending'].includes(item?.status ?? 'queued'));
    const turnId = stored.turnId ?? dispatch?.turnId ?? fallback.turnId;
    // A current-turn write has only that turnId. Every other delivery keeps any
    // known queued-turn history, including a queue row that has since opened B.
    const afterTurnId = delivery === 'current-turn' ? undefined
      : stored.afterTurnId ?? dispatch?.afterTurnId ?? fallback.afterTurnId;
    // The reason on a supplement row describes this input's own delivery, so it is
    // never suppressed as report-preflight noise: a blocked input must stay visible
    // even on a task whose report path already worked.
    const reason = item?.reason ?? dispatch?.error?.code ?? fallback.reason;
    return {
      name: current.name, state: current.state, accepted, queued,
      requestId, taskKey: store.taskKeyForRequest(record.ownerId, requestId),
      mode: item?.mode ?? stored.mode ?? fallback.mode ?? 'steer',
      delivery,
      ...(turnId ? { turnId } : {}),
      ...(afterTurnId ? { afterTurnId } : {}),
      ...(reason ? { error: { code: reason, message: reason === 'dispatch-expired'
        ? 'This input passed its six hours before it could be sent.'
        : 'This input could not be delivered; its body is kept.' } } : {}),
      ...effortReceipt((dispatch?.accepted ? dispatch.deliverySelection ?? dispatch.model : undefined) ?? item?.selection ?? fallback.pin, dispatch?.actualEffort ?? stored.actualEffort ?? null, dispatch?.effortAdjustment ?? stored.effortAdjustment, dispatch?.actualEffortSource ?? stored.actualEffortSource),
      actualModel: dispatch && Object.hasOwn(dispatch, 'actualModel') ? actualModelName(dispatch.actualModel)
        : actualModelName(item?.selection) ?? actualModelName(fallback.pin)
          ?? actualModelName(current.model) ?? actualModelName(current.modelPin),
      ...(current.callbackBlocked ? { callbackError: { code: 'native-callback-unavailable',
        message: 'The desktop does not permit background reports to this native multi-agent v2 sub-agent.' } } : {}),
      ...(fallback.previousReport ? { previousReport: fallback.previousReport } : {}),
    };
  }

  function nameModelPin(record, selection) {
    return { provider: selection.provider, model: selection.model,
      ...(targetOf(record) === 'codex-desktop' ? { requestedEffort: selection.explicitInput?.effort ?? null } : {}) };
  }

  function lastCodexPinSelection(task) {
    return task?.dispatches?.findLast(dispatch => dispatch.accepted === true && dispatch.selectionExplicit === true)?.model
      ?? (task?.modelSelection?.explicitFields?.model ? task.modelSelection : undefined);
  }

  function pinnedCodexEffort(record) {
    const pin = record.modelPin;
    if (!pin || targetOf(record) !== 'codex-desktop') return undefined;
    if (Object.hasOwn(pin, 'requestedEffort')) return pin.requestedEffort ?? undefined;
    // Before the pin carried effort, only explicit inputs prove what the caller chose.
    const previous = lastCodexPinSelection(record.task)
      ?? store.historyFor(record.agentId).map(lastCodexPinSelection).findLast(Boolean)
      ?? record.creationSelection;
    if (previous?.model === pin.model && previous.provider === pin.provider) return previous.explicitInput?.effort;
  }

  function rememberAcceptedCodexPin(record, dispatch) {
    if (targetOf(record) !== 'codex-desktop' || dispatch.selectionExplicit !== true || !dispatch.model
        || lastCodexPinSelection(record.task) !== dispatch.model) return;
    const fields = dispatch.model.explicitFields;
    if (fields?.model || (fields?.effort && record.modelPin)) record.modelPin = nameModelPin(record, dispatch.model);
  }

  async function resolveRequestedPin(record, input = {}, frozenConfig) {
    const backend = await backendFor(record);
    const catalog = await backend.models(input.model !== undefined ? { requestedModel: input.model } : undefined);
    const current = input.model !== undefined && !dshDefaultOnly(record) ? undefined :
      targetOf(record) === 'dsh' && !record.modelPin ? catalog?.default :
      dshDefaultOnly(record) ? catalog?.default : (record.modelPin ? undefined : await backend.model());
    const request = selectionRequest(input);
    if (dshDefaultOnly(record)) delete request.model;
    if (targetOf(record) === 'agy-cli' && typeof request.model === 'string' && typeof request.effort === 'string') {
      const rawQuery = request.model.trim().toLowerCase();
      const rawEff = request.effort.trim().toLowerCase();
      if (rawQuery && rawEff && !/-(low|medium|high|xhigh|max)$/i.test(rawQuery)) {
        const modelsList = (catalog?.groups ?? []).flatMap(group => group.models ?? []);
        const exactTiered = modelsList.find(entry => {
          const idLower = String(entry?.id ?? '').toLowerCase();
          return idLower.includes(rawQuery) && idLower.endsWith(`-${rawEff}`);
        });
        if (exactTiered?.id) request.model = exactTiered.id;
      }
    }
    if (!hasModelRequest(request)) request.effort = pinnedCodexEffort(record);
    let selection;
    try {
      selection = resolveDispatchSelection(catalog, request, {
        pinned: dshDefaultOnly(record) ? undefined : record.modelPin, current, config: frozenConfig ?? config.behavior ?? config,
      });
    } catch (error) {
      if (error?.code === 'model-catalog-unavailable' && !dshDefaultOnly(record) && input.model === undefined && record.modelPin?.model) {
        const eff = request.effort ?? record.creationSelection?.selectedEffort ?? null;
        return {
          provider: record.modelPin.provider ?? modelProviderFor(targetOf(record)),
          model: record.modelPin.model,
          ...(eff ? { reasoningEffort: eff } : {}),
          requestedEffort: eff,
          effortSource: eff ? 'role-default' : null,
          selectedEffort: eff,
          explicitFields: { model: false, effort: input.effort !== undefined },
          explicitInput: selectionRequest(input),
          effortConfig: frozenConfig ?? { defaultEffort: (config.behavior ?? config).defaultEffort, modelDefaultEfforts: { ...((config.behavior ?? config).modelDefaultEfforts ?? {}) } },
        };
      }
      throw error;
    }
    return selection && { ...selection, explicitFields: {
      model: !dshDefaultOnly(record) && input.model !== undefined,
      effort: input.effort !== undefined,
    }, explicitInput: selectionRequest(input), effortConfig: frozenConfig ?? { defaultEffort: (config.behavior ?? config).defaultEffort, modelDefaultEfforts: { ...((config.behavior ?? config).modelDefaultEfforts ?? {}) } } };
  }

  /**
   * Confirm one DSH selection before its dispatch. Only a live host observation proves
   * what the session will use; a roster snapshot may have been migrated while asleep.
   * An observation that reports modelSelectionObserved:false carries a historical
   * value, stale exactly when the user changed the model in the UI without sending a
   * turn — then the real next-turn control is read instead. `sessionOnly` is set for
   * explicit pins and omitted for default-follow, which keeps the old DSH behavior.
   */
  async function confirmDshSelection(record, backend, target, dispatch, selection, observed, { sessionOnly = false } = {}) {
    const current = observed && observed.modelSelectionObserved !== false
      ? observed.currentModel
      : await backend.model();
    if (sameModelSelection(current, selection)) return;
    dispatch.modelSelectionAttempt = (dispatch.modelSelectionAttempt ?? 0) + 1;
    saveDispatch(record);
    const selected = await backend.selectModel({ ...selection, requestId: `${dispatch.requestId}-model-${dispatch.modelSelectionAttempt}`,
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
    !latest || latest.closed || latest.task?.taskId !== record.task?.taskId
    || latest.task?.preemptionEpoch !== record.task?.preemptionEpoch || Boolean(terminalRound(latest));

  function dispatchRefused(code = 'round-finished') {
    return Object.assign(new Error(code === 'dispatch-expired'
      ? 'This input passed its six hours before it could be sent.'
      : 'This round already ended. Nothing was sent for it.'), { code, terminal: true, notSent: true });
  }

  function saveDispatch(record) {
    if (!store.save(record, { dispatch: true })) throw dispatchRefused();
  }

  async function followHostModel(record, dispatch, observed) {
    if (dispatch.modelReady && !(dshDefaultOnly(record) && !dispatch.deliveryIntent)) return;
    // Every save below happens after an await, so each one is fenced on the round this
    // dispatch belongs to: a stale copy must never overwrite a round that has moved on.
    const backend = await backendFor(record);
    const target = targetOf(record);
    if (!dispatch.model && dispatch.pendingSelection) {
      dispatch.model = await resolveRequestedPin(record, dispatch.pendingSelection.input, dispatch.pendingSelection.config);
      delete dispatch.pendingSelection;
      saveDispatch(record);
    }
    const explicit = dispatch.selectionExplicit === true && dispatch.model !== undefined;
    if (target === 'dsh') {
      let lockedDefault;
      if (dshDefaultOnly(record) && !dispatch.deliveryIntent && dispatch.model) {
        const catalog = await backend.models();
        lockedDefault = catalog?.default;
        if (catalog?.default?.model && (catalog.default.model !== dispatch.model.model
            || (catalog.default.provider ?? '') !== (dispatch.model.provider ?? ''))) {
          const before = dispatch.model;
          delete dispatch.deliveryModel;
          delete dispatch.deliverySelection;
          const input = { ...(before.explicitInput?.effort !== undefined ? { effort: before.explicitInput.effort } : {}) };
          const frozenConfig = before.effortConfig ?? config.behavior ?? config;
          dispatch.model = { ...resolveDispatchSelection(catalog, input, { current: catalog.default, config: frozenConfig }),
            explicitFields: { model: false, effort: before.explicitFields?.effort === true },
            explicitInput: before.explicitInput, effortConfig: before.effortConfig };
          dispatch.modelReselection = { before: { provider: before.provider, model: before.model },
            after: { provider: dispatch.model.provider, model: dispatch.model.model }, reason: 'locked-default-changed-before-write' };
          saveDispatch(record);
        }
      }
      if (dispatch.kind !== 'task' && observed?.running === true && !dispatch.deliveryIntent) {
        const current = observed.modelSelectionObserved !== false && observed.currentModel
          ? observed.currentModel : await backend.model();
        const fields = dispatch.model?.explicitFields;
        if (!current?.model || (fields?.effort && !current.reasoningEffort)) {
          throw Object.assign(new Error('The running DSH turn selection could not be confirmed.'), { code: 'model-selection-unconfirmed', terminal: true, notSent: true });
        }
        let stepSelection;
        if (!dshDefaultOnly(record) && !fields?.model && fields?.effort) {
          // An effort-only steer belongs to the active provider even when the host
          // default now names a different provider with the same model ID. Resolve
          // against that provider's own capabilities; preserve model as start(B).
          const catalog = await backend.models();
          const groups = (catalog?.groups ?? []).filter(group => (group.id ?? group.provider) === current.provider);
          const activeCatalog = { ...catalog, groups, routableProviders: [current.provider] };
          stepSelection = resolveDispatchSelection(activeCatalog,
            { model: current.model, effort: dispatch.model.explicitInput?.effort },
            { current, config: dispatch.model.effortConfig ?? config.behavior ?? config });
          dispatch.deliverySelection = stepSelection;
        }
        const changesModel = fields?.model && (current.model !== dispatch.model.model || (current.provider ?? '') !== (dispatch.model.provider ?? ''));
        const changesEffort = fields?.effort && current.reasoningEffort !== (stepSelection ?? dispatch.model).reasoningEffort;
        const currentMatchesLock = !dshDefaultOnly(record) || !lockedDefault?.model
          || (current.model === lockedDefault.model && (current.provider ?? '') === (lockedDefault.provider ?? ''));
        if (!changesModel && !changesEffort && currentMatchesLock) {
          dispatch.deliveryModel = { ...current };
          dispatch.modelReady = true;
          saveDispatch(record);
          return;
        }
        delete dispatch.deliveryModel;
        if (stepSelection) {
          await confirmDshSelection(record, backend, target, dispatch, stepSelection, observed, { sessionOnly: true });
          dispatch.deliveryModel = { ...stepSelection };
          record.model = { ...stepSelection };
          dispatch.modelReady = true;
          saveDispatch(record);
          return;
        }
        delete dispatch.deliverySelection;
        // DSH supports a session-local selection for the next model step of an
        // active turn. Apply an explicit change through its normal host check.
      }
      if (!dispatch.model) {
        // DSH default-follow keeps the old resolveModel and its catalog validation.
        dispatch.model = resolveModel(await backend.models(), {});
        saveDispatch(record);
      }
      await confirmDshSelection(record, backend, target, dispatch, dispatch.model, observed, { sessionOnly: true });
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
    if (targetOf(record) === 'claude-cli') {
      const route = await verifyClaudeCliProxyIfConfigured(record);
      if (route) record._resolvedProxyRoute = route;
    }
    const baseline = Number.isSafeInteger(observed?.throughSeq)
      ? observed : await (await backendFor(record)).cursor();
    // Waiting for the cursor is asynchronous: the round is read again before the intent is
    // written, so a round that ended, closed or moved on in the meantime gets no dispatch.
    const fresh = store.get(record.agentId);
    if (!fresh || fresh.task?.taskId !== task.taskId || fresh.closed
        || fresh.task?.cancelRequested || fresh.task?.preemptionEpoch !== task.preemptionEpoch || terminalRound(fresh)) {
      throw dispatchRefused();
    }
    // `extra` is written with the dispatch, before the first save, so a reminder is
    // recognisable as one even if the process dies on the way to the native send.
    // The selection is frozen here: later pin changes must not rewrite an input that
    // is already queued or being recovered. `freezeModel` on a queued supplement
    // records that it had no pin when it was accepted, so a later pin cannot leak in.
    const { model: frozenModel, freezeModel, mode, selectionExplicit, ...dispatchExtra } = extra;
    let selected = frozenModel !== undefined ? frozenModel
      : freezeModel === true ? undefined : record.modelPin;
    if (dispatchExtra.reminder === true) selected = await resolveRequestedPin(record, {});
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
    if (task.preemption?.requestId === requestId) delete task.preemption;
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
    if (intent?.preemptedBy || (record.task.preemption && record.task.preemption.requestId !== requestId)) return 'round-finished';
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

  async function dispatchOnce(record, dispatch, observed,
    { pendingFirstTurn = false, recoveryNotSent = false, startOnly = false } = {}) {
    const current = store.get(record.agentId);
    if (roundMovedOn(record, current)) throw dispatchRefused();
    if (current.task.cancelRequested) return;
    if (Math.max(dispatch.nextAttemptAt ?? 0, dispatch.transportNextAttemptAt ?? 0) > Date.now()) return;
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
        if (root?.known === false && !(pendingFirstTurn && root.reason === 'empty-rollout')) {
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
        ...(target === 'dsh' && method === 'steer' ? { expectedThroughSeq: Number.isSafeInteger(observed?.throughSeq) ? observed.throughSeq : null } : {}),
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
      const effectiveTimeoutMs = dispatch.timeoutMs ?? record.task?.turnTimeoutMs ?? record.turnTimeoutMs;
      const effectiveTimeoutMinutes = dispatch.timeoutMinutes ?? record.task?.turnTimeoutMinutes ?? record.turnTimeoutMinutes;
      const sent = await backend.deliver({ requestId: dispatch.requestId,
        message: dispatch.message, kind: dispatch.kind,
        ...(record.readOnlyScout === true ? { readOnly: true } : {}),
        ...(dispatch.restartFresh === true ? { restartFresh: true } : {}),
        writeBlockReason: reasonFor,
        allowStart,
        ...(startOnly ? { startOnly: true } : {}),
        ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}),
        ...(effectiveTimeoutMinutes !== undefined ? { timeoutMinutes: effectiveTimeoutMinutes } : {}),
        mode: dispatch.mode === 'queue' ? 'queue' : 'steer',
        ...(dispatch.selectionExplicit === undefined ? {}
          : { selectionExplicit: dispatch.selectionExplicit === true }),
        ...(dispatch.model?.explicitFields ? { explicitFields: dispatch.model.explicitFields } : {}),
        ...(target === 'dsh' && dispatch.model ? { startModel: dispatch.model } : {}),
        ...(target === 'dsh' && method === 'steer' ? { expectedTurn: { throughSeq: dispatch.deliveryIntent.expectedThroughSeq } } : {}),
        ...(modern || isHeadlessCli(target) || target === 'dsh'
          ? (dispatch.model ? { model: target === 'dsh' ? dispatch.deliveryModel ?? dispatch.model : dispatch.model } : {})
          : (explicit ? { model: dispatch.model, explicitModel: true } : { explicitModel: false })) });
      // A native receipt names the actual route. When it does not, a Codex write is
      const nativeUnknown = target === 'codex-desktop' && dispatch.kind === 'answer'
        && sent.accepted !== true && ['unknown', 'sending'].includes(sent.status);
      const delivery = nativeUnknown ? 'unknown'
        : target === 'dsh' && sent.accepted === true && Object.hasOwn(sent, 'delivery') && sent.delivery === null
          ? null : typeof sent.delivery === 'string' ? sent.delivery
        : (sent.reschedule === true || sent.waiting === true || sent.status === 'waiting') ? 'local-pending'
          : ['codex-desktop', 'dsh'].includes(target) ? (sent.accepted === true ? 'accepted-route-unknown' : sent.status ?? 'unknown')
            : sent.accepted !== true ? (['retryable', 'retrying'].includes(sent.status) ? 'local-pending' : sent.status ?? 'unknown')
              : dispatch.kind === 'answer' ? 'answered'
                : method === 'steer' ? 'current-turn' : 'new-turn';
      const accepted = sent.accepted === true || deliveryAccepted(delivery);
      const state = accepted ? 'running'
        : ['after-current', 'local-pending', 'answer-pending'].includes(delivery) ? 'queued'
          : delivery === 'blocked' ? 'blocked' : ['unknown', 'accepted-route-unknown'].includes(delivery) ? 'unknown'
            : ['rejected', 'failed'].includes(sent.status) ? 'failed' : sent.status ?? 'failed';
      Object.assign(dispatch, { delivery, state, accepted,
        ...(sent.turnId ? { turnId: sent.turnId } : {}),
        ...(accepted ? { actualEffort: sent.actualEffort ?? null } : {}),
        ...(accepted && Object.hasOwn(sent, 'actualModel') ? { actualModel: sent.actualModel }
          : accepted && dispatch.deliveryModel?.model ? { actualModel: dispatch.deliveryModel.model } : {}),
        ...(accepted && sent.effortAdjustment ? { effortAdjustment: sent.effortAdjustment } : {}),
        ...(accepted && sent.actualEffort != null ? { actualEffortSource: sent.actualEffortSource ?? (target === 'dsh' || isHeadlessCli(target) ? 'host-readback' : 'native-turn-start') } : {}),
        ...(sent.afterTurnId ?? (delivery === 'after-current' ? sent.turnId ?? root?.turnId : undefined)
          ? { afterTurnId: sent.afterTurnId ?? sent.turnId ?? root?.turnId } : {}),
        ...(sent.afterSeq !== undefined ? { afterSeq: sent.afterSeq } : {}),
        ...(accepted ? { error: undefined, nextAttemptAt: undefined } : {}) });
      // A steer into the current turn has only that turnId; an afterTurnId here is
      // the queued-wait route it never took. A queue row that opened B keeps its
      // known A as history.
      if (delivery === 'current-turn') delete dispatch.afterTurnId;
      if (target === 'dsh' && accepted && delivery === 'new-turn') { delete dispatch.deliverySelection; delete dispatch.deliveryModel; }
      if (accepted && explicit && target === 'codex-desktop') {
        // The native turn now runs with the pinned model; record the real display value
        // and only now make it the name's intended selection. A refused or still
        // waiting input never changes the pin.
        record.model = { ...dispatch.model };
        rememberAcceptedCodexPin(record, dispatch);
      }
      if (dispatch.kind === 'supplement') {
        saveSupplementReceipt(dispatch.requestId, accepted ? 'accepted'
          : delivery === 'blocked' ? 'blocked' : delivery === 'unknown' ? 'unknown' : 'queued',
        accepted ? null : dispatch.error?.code ?? sent.reason ?? null, dispatchReceipt(dispatch));
      }
      if (!accepted && (['retryable', 'retrying'].includes(dispatch.state)
          || (sent.status === 'retryable' && dispatch.state !== 'queued'))) {
        if (target === 'dsh' && sent.notSent === true && (['managed-turn-ended', 'managed-turn-changed', 'managed-turn-unknown'].includes(sent.code) || dshDefaultOnly(record))) {
          delete dispatch.deliveryIntent; delete dispatch.deliveryModel; delete dispatch.deliverySelection; dispatch.modelReady = false;
        }
        dispatch.state = 'retrying'; deferRetry(dispatch);
      }
    } catch (error) {
      // This attempt began before a confirmed recovery; it cannot overwrite newer state.
      if (supersededRead(error)) { announceWork(record.agentId); return; }
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
      const registrationUnavailable = error.code === 'codex-report-not-ready'
        && targetOf(record) === 'codex-desktop' && dispatch.kind === 'answer'
        && recoveryNotSent === true;
      if (targetOf(record) === 'dsh' && error?.notSent === true && error?.terminal !== true
          && (['managed-turn-ended', 'managed-turn-changed', 'managed-turn-unknown'].includes(error.code) || dshDefaultOnly(record))) {
        delete dispatch.deliveryIntent; delete dispatch.deliveryModel; delete dispatch.deliverySelection;
        dispatch.modelReady = false;
      }
      const retryable = !modelError && (error.notSent === true || error.retryableRead === true || registrationUnavailable
        || (targetOf(record) !== 'dsh' && (!delivering || error.code === 'agent-busy')));
      const state = error.terminal === true || modelError ? 'failed'
        : targetOf(record) !== 'dsh' && !delivering ? 'retrying'
          : error.uncertain ? 'unknown' : retryable ? 'retrying' : 'failed';
      Object.assign(dispatch, { state, ...(state === 'unknown' ? { delivery: 'unknown' } : {}),
        afterSeq: error.afterSeq ?? dispatch.afterSeq, error: safeError(error) });
      if (registrationUnavailable && state === 'retrying') dispatch.delivery = 'local-pending';
      if (dispatch.state === 'retrying' && targetOf(record) !== 'dsh') {
        if (targetOf(record) === 'codex-desktop' && /^codex-native-rpc-(unavailable|timeout|response-timeout|closed)$/.test(error.code ?? '')) {
          deferTransportRetry(dispatch, error);
        }
        else deferRetry(dispatch);
      }
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

  function deferTransportRetry(value, error) {
    value.transportRetryAttempts = (value.transportRetryAttempts ?? 0) + 1;
    value.transportNextAttemptAt = Date.now() + Math.min(2000, 500 * 2 ** Math.min(value.transportRetryAttempts - 1, 2));
    value.transportWaitFault = error.transportFaultSequence ? { owner: transportWaitOwner, sequence: error.transportFaultSequence } : undefined;
  }

  function clearRecoveredWait(value, legacyStates, sequence) {
    // Sequences only compare inside the service that recorded them. A restarted
    // monitor can release prior-process waits on its own first confirmed read.
    if (value.transportWaitFault?.owner === transportWaitOwner && value.transportWaitFault.sequence > sequence) return false;
    if (value.transportNextAttemptAt !== undefined) {
      delete value.transportNextAttemptAt;
      delete value.transportRetryAttempts;
      delete value.transportWaitFault;
      if (value.nextAttemptAt !== undefined) value.transportLegacyCleared = true;
      return true;
    }
    if (value.transportLegacyCleared || !legacyStates.includes(value.state) || value.nextAttemptAt === undefined ||
        !/^codex-native-rpc-(unavailable|timeout|response-timeout|closed)$/.test(value.error?.code ?? '')) return false;
    delete value.nextAttemptAt;
    delete value.retryAttempts;
    return true;
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
      && !first.accepted && first.state === 'retrying' && Math.max(first.nextAttemptAt ?? 0, first.transportNextAttemptAt ?? 0) > Date.now();
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
   * A Codex receipt is one exact userMessage on the original thread. Tool output,
   * model prose, summaries and a successful RPC response are not receipts: they can
   * repeat our marker without proving the chat received it. The scan therefore
   * inspects only userMessage items and never stringifies a whole page.
   */
  function userMessageText(item) {
    if (!item || typeof item !== 'object') return undefined;
    if (item.type !== 'userMessage' && item.type !== 'user_message') return undefined;
    const content = item.content ?? item.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part =>
      typeof part === 'string' ? part : part?.type === 'text' && typeof part.text === 'string' ? part.text : '').join('');
    if (typeof item.text === 'string') return item.text;
    return undefined;
  }
  function exactCodexMessage(item, marker, expectedText, notice) {
    const content = userMessageText(item);
    if (content === undefined) return undefined;
    const id = item.id ?? item.clientId ?? item.clientUserMessageId
      ?? item.message?.id ?? item.message?.clientUserMessageId;
    if (notice?.clientUserMessageId && id === notice.clientUserMessageId) return { itemId: id, exact: 'id' };
    if (expectedText === undefined) return content.includes(marker) ? { itemId: id, exact: 'marker' } : undefined;
    const envelope = `${expectedText}\n\n${marker}`;
    // The written prompt is the only full-envelope authority. A marker quoted in a
    // user message (for example a reviewer pasting the error) is not a receipt.
    return content === envelope || content === `${envelope}\n`
      ? { itemId: id, exact: 'envelope' } : undefined;
  }
  function codexReadViews(value) {
    const views = [];
    const visit = current => {
      if (typeof current === 'string') {
        if (!/^[\s]*[\[{]/.test(current)) return;
        try { visit(JSON.parse(current)); } catch { /* ordinary text */ }
        return;
      }
      if (!current || typeof current !== 'object' || views.includes(current)) return;
      views.push(current);
      if (current.structuredContent && typeof current.structuredContent === 'object') visit(current.structuredContent);
      // app-tools wraps its thread page as content[0].text JSON. Only that direct
      // wrapper is unwrapped; a tool/model item's own text is never inspected.
      if (Array.isArray(current.content)) {
        for (const part of current.content) if (typeof part?.text === 'string') visit(part.text);
      }
    };
    visit(value);
    return views;
  }
  function findUserMessageMarker(value, marker, expectedText, notice, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findUserMessageMarker(entry, marker, expectedText, notice, seen);
        if (found) return found;
      }
      return undefined;
    }
    const direct = exactCodexMessage(value.item ?? value, marker, expectedText, notice);
    if (direct) return { itemId: value.item?.id ?? direct.itemId,
      clientUserMessageId: notice?.clientUserMessageId, ...(value.turnId ?? value.turn?.id ? { turnId: value.turnId ?? value.turn?.id } : {}) };
    // Only containers that can hold thread items are walked. Content, text and tool
    // payloads are deliberately not searched.
    for (const key of ['data', 'items', 'turns', 'turn', 'item', 'message', 'thread',
      'structuredContent']) {
      if (!(key in value)) continue;
      const found = findUserMessageMarker(value[key], marker, expectedText, notice, seen);
      if (found) return found;
    }
    return undefined;
  }
  function findCodexPayload(value, marker, expectedText, notice) {
    for (const view of codexReadViews(value)) {
      const found = findUserMessageMarker(view, marker, expectedText, notice);
      if (found) return found;
    }
    return undefined;
  }
  function codexThreadId(value) {
    if (!value || typeof value !== 'object') return undefined;
    const id = value.thread?.id ?? value.threadId ?? value.thread?.threadId
      ?? value.structuredContent?.thread?.id ?? value.structuredContent?.threadId;
    if (typeof id === 'string' && id) return id;
    const text = Array.isArray(value.content)
      ? value.content.find(part => typeof part?.text === 'string')?.text : undefined;
    if (typeof text === 'string' && /^[\s]*[\[{]/.test(text)) {
      try { return codexThreadId(JSON.parse(text)); } catch { /* not a JSON envelope */ }
    }
    return undefined;
  }
  async function findCodexNotice(owner, notice, marker, expectedText) {
    const markers = [marker, ...(notice.readbackIds ?? []).map(id => `<!-- futureaide-control:${id} -->`)];
    const findAny = value => {
      for (const view of codexReadViews(value)) {
        const claimed = codexThreadId(view);
        if (claimed && claimed.toLowerCase() !== owner.threadId.toLowerCase()) return { wrongThread: true };
        for (const entry of markers) {
          const found = findUserMessageMarker(view, entry, expectedText, notice);
          if (found) return found;
        }
      }
      return undefined;
    };
    let summary;
    const reportReceipt = expectedText !== undefined;
    const monitor = receiptProcessIdentity();
    const fallbackAppTools = async () => {
      if (typeof codexOwnerCall !== 'function') return undefined;
      const history = await codexOwnerCall(owner.threadId, 'read_thread', {
        threadId: owner.threadId, turnLimit: 30, includeOutputs: true, maxOutputCharsPerItem: 100000,
      });
      const found = history?.isError ? undefined : findAny(history);
      if (found?.wrongThread) return { wrongThread: true };
      return found ? { delivered: true, complete: true, receipt: { via: 'app-tools', threadId: owner.threadId,
        threadPageCount: 1, itemPageCount: 0, hitPage: 0, ...monitor, ...found } } : undefined;
    };
    // A summary or an immediate send response is not enough to prove a page receipt.
    // Verify the exact original thread first when a native/app-tools metadata read exists.
    try {
      const metadata = await codexOwnerCall(owner.threadId, 'read_thread', {
        threadId: owner.threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100,
      });
      const claimed = codexThreadId(metadata);
      if (claimed && claimed.toLowerCase() !== owner.threadId.toLowerCase()) return { delivered: false, complete: false, wrongThread: true };
    } catch { /* an unavailable metadata read is not proof of absence */ }
    try {
      summary = await readCodexOwnerTurns(owner.threadId, { limit: 30, itemsView: 'summary' }, { nativeRequest });
    } catch (error) {
      // A desktop without the native debug port still has its own thread read.
      // It is scanned through the same userMessage-only matcher.
      if (typeof codexOwnerCall !== 'function') throw error;
      return await fallbackAppTools() ?? { delivered: false, complete: false };
    }
    const found = reportReceipt ? undefined : findAny(summary);
    if (found?.wrongThread) return { delivered: false, complete: false, wrongThread: true };
    if (found) return { delivered: true, complete: true, receipt: { via: 'native-summary', threadId: owner.threadId, ...monitor, ...found } };
    // A native thread summary can be empty on a desktop that only exposes the
    // app-tools read. Try that same-thread read before declaring a miss.
    if (!(Array.isArray(summary?.data) && summary.data.length) && typeof codexOwnerCall === 'function') {
      try {
        const fallback = await fallbackAppTools();
        if (fallback?.wrongThread) return { delivered: false, complete: false, wrongThread: true };
        if (fallback) return fallback;
      } catch { /* the native summary miss is still not proof of absence */ }
    }
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
    let itemPagesRead = 0;
    for (const turn of candidates.slice(0, 5)) {
      if (typeof turn.id !== 'string') continue;
      let cursor;
      let pages = 0;
      while (true) {
        let page;
        try {
          page = await readCodexOwnerItems(owner.threadId, turn.id, { limit: 100,
            ...(cursor ? { cursor } : {}) }, { nativeRequest });
        } catch {
          // The native item page is unavailable on this desktop; the same-thread
          // app-tools read is the only permitted fallback.
          const fallback = await fallbackAppTools();
          if (fallback?.wrongThread) return { delivered: false, complete: false, wrongThread: true };
          if (fallback) return fallback;
          allItemsRead = false;
          break;
        }
        pages += 1;
        itemPagesRead += 1;
        const hit = findAny(page);
        if (hit?.wrongThread) return { delivered: false, complete: false, wrongThread: true };
        if (hit) return { delivered: true, complete: true, receipt: { via: 'native-item-page',
          threadId: owner.threadId, turnId: turn.id, threadPageCount: summary.pageCount ?? 1,
          turnPageCount: summary.pageCount ?? 1, itemPageCount: pages, hitPage: pages, ...monitor, ...hit } };
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
        if (!cursor) break;
        if (pages >= 5) { allItemsRead = false; break; }
      }
    }
    // Older Desktop builds expose the persistent userMessage only in a native
    // summary (items/list is empty even though the exact envelope is present).
    // Only accept that already-read summary after every native item page was
    // attempted, and only with the same exact-envelope matcher used above.
    if (reportReceipt && allItemsRead && candidates.length <= 5 && !summary.truncated) {
      const summaryHit = findAny(summary);
      if (summaryHit?.wrongThread) return { delivered: false, complete: false, wrongThread: true };
      if (summaryHit) return { delivered: true, complete: true, receipt: { via: 'native-summary',
        source: 'native-summary', threadId: owner.threadId, threadPageCount: summary.pageCount ?? 1,
        turnPageCount: summary.pageCount ?? 1, itemPageCount: itemPagesRead, hitPage: 0, ...monitor, ...summaryHit } };
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
    if (!task || terminal !== 'failed' || task.cancelRequested || !store.stillCurrentTurn(record)) return;
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
    treeDeadline = undefined,
  } = {}) {
    if (!store.stillCurrentTurn(record) || notice.state === 'delivered' || notice.state === 'blocked') return;
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
    // Receipt tightening is a report rule. Questions and failure notices keep their
    // established accepted-write behavior; only a report must prove its exact envelope.
    const exactCodexReceipt = reportSummary !== undefined;
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
      try { settled = await findClaudeNoticeReceipt(owner, notice, text); }
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
    // Waiting on a final's tree cannot disable the expiry rule. The bounded release
    // moment comes from the report's own persisted creation time, so a restarted
    // monitor resumes the same deadline instead of starting a new countdown.
    if (!allowSend && !awaitingNoticeReceipt(notice)) {
      const created = Date.parse(notice.createdAt ?? '');
      const deadline = Number.isFinite(treeDeadline) ? treeDeadline
        : Number.isFinite(created) ? created + TREE_RELEASE_MS : undefined;
      if (!notice.waitingForTree) {
        notice.waitingForTree = true;
        if (deadline !== undefined) {
          notice.treeReleaseAt = new Date(deadline).toISOString();
          notice.nextAttemptAt = deadline;
        } else notice.nextAttemptAt = undefined;
        persist();
      } else {
        // A row written by the six-hour build moves to the bounded deadline exactly
        // once, from its original creation time. It is due at once in the roster
        // projection, so this migration never waits six hours to happen.
        let changed = false;
        if (deadline !== undefined && notice.treeReleaseAt !== new Date(deadline).toISOString()) {
          notice.treeReleaseAt = new Date(deadline).toISOString();
          notice.nextAttemptAt = deadline;
          changed = true;
        }
        if (Number.isFinite(deadline) && Date.now() >= deadline
            && notice.nextAttemptAt !== deadline) {
          // The caller is expected to release with a fresh observation before this
          // point. Reaching here means it could not, so leave the row due for the
          // next poll rather than hiding it behind an old backoff.
          notice.nextAttemptAt = deadline;
          changed = true;
        }
        if (changed) persist();
      }
      return;
    }
    notice.id ??= uid('notice');
    if (isPullOwner(owner)) {
      if (notice.state !== 'delivered') {
        notice.state = 'pull_ready';
        notice.readyAt ??= now();
        delete notice.error;
        delete notice.blockedAt;
        delete notice.waitingForTree;
        delete notice.nextAttemptAt;
        persist();
      }
      return;
    }
    const marker = `<!-- futureaide-control:${notice.id} -->`;
    // These exact legacy failures happened before sendClaude opened a socket. They
    // can resume; other unknown outcomes stay read-only.
    if (claude && notice.state === 'unknown' && claudeNeverWritten(notice)) notice.state = 'pending';
    if (awaitingNoticeReceipt(notice)) {
      // One read-back per poll. The same notice can be visited by several delivery
      // passes in one poll; a fresh generation is what allows the next poll to look
      // again, without starting a second scan budget in the same pass.
      if (notice.readbackGeneration === pollGeneration) return;
      notice.readbackGeneration = pollGeneration;
      try {
        if (claude) {
          // The native receipt is the request id itself: our envelope uuid survives
          // as the queue/attachment/user uuid. Transcript text is truncated at 8k,
          // so a long report's trailing marker is never reliable — deliveries are.
          // The scan starts at this notice's own cursor, so a long parent chat is
          // never rescanned and a page boundary simply continues on the next poll.
          const settled = await findClaudeNoticeReceipt(owner, notice, text);
          Object.assign(notice, settled
            ? { state: 'delivered', deliveredAt: now(), recovered: true, receipt: settled, error: undefined }
            : { state: 'unknown' });
        } else if (typeof nativeRequest === 'function') {
          const found = await findCodexNotice(owner, notice, marker, exactCodexReceipt ? text : undefined);
          if (found.delivered) {
            Object.assign(notice, { state: 'delivered', deliveredAt: now(), recovered: true, receipt: found.receipt, error: undefined });
          } else if (!submission && found.complete && Date.now() - (Date.parse(notice.attemptedAt ?? notice.createdAt ?? '') || Date.now()) >= CONFIRM_ABSENCE_AFTER_MS && !notice.resendAttempted) {
            // The whole relevant turn window was read and the marker is absent.
            // Re-send exactly once; this is no longer a blind write.
            Object.assign(notice, { state: 'pending', resendAttempted: true, nextAttemptAt: undefined, error: undefined });
          } else notice.state = 'unknown';
        } else {
          // No debug port: the ordinary app-tools read remains the fallback, and it
          // must still name an exact userMessage rather than any echoed text.
          const history = await codexOwnerCall(owner.threadId, 'read_thread', {
            threadId: owner.threadId, turnLimit: 30, includeOutputs: true, maxOutputCharsPerItem: 100000,
          });
          const found = history?.isError ? undefined
            : findCodexPayload(history, marker, exactCodexReceipt ? text : undefined, notice);
          if (found) {
            Object.assign(notice, { state: 'delivered', deliveredAt: now(), recovered: true,
              receipt: { via: 'app-tools', threadId: owner.threadId, threadPageCount: 1, itemPageCount: 0, hitPage: 0,
                ...receiptProcessIdentity(), ...found }, error: undefined });
          } else notice.state = 'unknown';
        }
      } catch (error) {
        if (terminalCodexOwnerError(error)) blockCodexNotice(record, notice, error);
        else notice.state = 'unknown';
      }
      persist();
      return;
    }
    if (notice.nextAttemptAt && notice.nextAttemptAt > Date.now()) return;
    notice.attempts = (notice.attempts ?? 0) + 1;
    notice.nextAttemptAt = Date.now() + retryDelayMs(notice.attempts);
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
          Object.assign(notice, { state: 'unknown', error: undefined, readbackGeneration: pollGeneration });
          delete notice.callbackMissingSince;
        }
      } else {
        const result = await codexOwnerCall(owner.threadId, 'send_message_to_thread', { threadId: owner.threadId, prompt: `${text}\n\n${marker}` });
        // A native/client identity is the strongest receipt. Keep it on the notice
        // before any readback so a truncated page can still be matched safely.
        if (typeof result?.clientUserMessageId === 'string') notice.clientUserMessageId = result.clientUserMessageId;
        if (result?.notSent === true || result?.reschedule === true) {
          Object.assign(notice, { state: 'pending', error: undefined, rescheduleReason: result.reason ?? 'not-sent' });
          delete notice.clientUserMessageId;
          delete notice.nextAttemptAt;
          persist();
          return;
        }
        const unavailable = result?.isError && JSON.stringify(result).includes('direct app-server input is not allowed for multi-agent v2 sub-agents');
        if (unavailable) record.callbackBlocked = true;
        if (unavailable) Object.assign(notice, { state: 'blocked', error: { code: 'native-callback-unavailable' } });
        else if (result?.isError) Object.assign(notice, { state: 'pending', error: { message: 'The desktop rejected this notice before acceptance.' } });
        else {
          // A successful RPC is not a receipt. A report must be read back from the
          // persisted original-thread turn/item pages; an immediate send response or
          // a summary that happens to contain the marker is not that page receipt.
          let receipt;
          if (exactCodexReceipt && typeof nativeRequest === 'function' && result?.via === 'native-rpc') {
            const found = await findCodexNotice(owner, notice, marker, text);
            if (found?.wrongThread) {
              Object.assign(notice, { state: 'unknown', error: undefined, readbackGeneration: pollGeneration });
            } else if (found?.delivered) {
              receipt = found.receipt;
            } else {
              receipt = undefined;
            }
          } else {
            receipt = findCodexPayload(result, marker, exactCodexReceipt ? text : undefined, notice);
            if (!receipt) {
              try {
                const history = await codexOwnerCall(owner.threadId, 'read_thread', {
                  threadId: owner.threadId, turnLimit: 30, includeOutputs: true, maxOutputCharsPerItem: 100000,
                });
                receipt = history?.isError ? undefined
                  : findUserMessageMarker(history, marker, exactCodexReceipt ? text : undefined, notice);
              } catch { /* an unreadable thread is not proof of absence */ }
            }
          }
          if (receipt) Object.assign(notice, { state: 'delivered', deliveredAt: now(), receipt, error: undefined });
          else Object.assign(notice, { state: 'unknown', error: undefined, readbackGeneration: pollGeneration });
        }
      }
    } catch (error) {
      // sendClaude throws only before its write, and a session that cannot be found was
      // never written to, so a Claude notice that lands here can be sent again. A
      // Codex owner that disappeared with the profile is a terminal notice instead.
      if (!claude && terminalCodexOwnerError(error)) blockCodexNotice(record, notice, error);
      else if (!claude && (error?.notSent === true || error?.reschedule === true)) {
        Object.assign(notice, { state: 'pending', error: undefined,
          rescheduleReason: error.reason ?? error.code ?? 'not-sent' });
        delete notice.clientUserMessageId;
        delete notice.nextAttemptAt;
      } else {
        Object.assign(notice, { state: claude ? 'pending' : 'unknown', error: safeError(error),
          ...(!claude ? { readbackGeneration: pollGeneration } : {}) });
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
  async function findClaudeNoticeReceipt(owner, notice, text) {
    const expectedBodyHash = claudeInboxBodyHash(`${text}\n\n<!-- futureaide-control:${notice.id} -->`);
    let binding;
    try {
      binding = await claudeNoticeBinding(owner);
      return await findClaudeReceipt(binding, notice, claudeReadEvents, expectedBodyHash);
    } catch (error) {
      if (!claudeBindingStale(error)) throw error;
      binding = await refreshClaudeBinding(owner);
      return findClaudeReceipt(binding, notice, claudeReadEvents, expectedBodyHash);
    }
  }

  /**
   * What status may claim about the way back to this caller. A Claude session keeps
   * its id across a restart but not its process or pipe, so a saved binding proves
   * nothing until it matches the live record. The caller is verified here, which makes
   * this the moment to replace a binding it has outgrown.
   */
  async function returnChannel(owner) {
    if (isPullOwner(owner)) return { returnChannel: 'chat-verified' };
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
        const creationSelection = record.creationSelection ?? record.modelPin;
        if (!sameModelSelection(created.model, creationSelection)) {
          const selected = await backend.selectModel({ ...creationSelection,
            requestId: `${record.agentId}-model`, sessionOnly: true });
          if (selected.accepted !== true) {
            throw Object.assign(new Error(`${backend.labels?.host ?? targetOf(record)} did not confirm the selected model.`),
              { code: 'model-selection-unconfirmed', uncertain: selected.status === 'unknown' });
          }
        }
        record.model = { ...creationSelection };
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
      ...(record.readOnlyScout === true ? { readOnly: true } : {}),
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
          selectionExplicit: record.task.selectionExplicit === true,
          ...(record.task.pendingSelection ? { pendingSelection: record.task.pendingSelection } : {}) } : {};
      await sendDispatch(record, record.task.message, 'task', [], record.task.requestId, observed, frozen);
    } finally { trackWorkspaceBaseline(record, baseline); }
  }

  function confirmedAnswer(record, answer) {
    const receipt = store.backendState(record.agentId)?.answers?.[answer.answerId];
    const ids = receipt?.consumedQuestionIds;
    const expected = answer.questionIdsSeen;
    return Array.isArray(ids) && ids.length && (!receipt.taskId || receipt.taskId === record.task.taskId)
      && Array.isArray(expected) && ids.length === expected.length && expected.every(id => ids.includes(id)) ? receipt : undefined;
  }

  function recoverLegacyAnswer(record, answer) {
    const confirmed = confirmedAnswer(record, answer);
    if (confirmed) Object.assign(answer, { questionIds: confirmed.consumedQuestionIds,
      continuation: confirmed.continuation ?? `Parent answer:\n${answer.message}\nContinue the same task.`,
      ...(confirmed.nativeAnswered ? { dispatched: true, nativeAnswered: true, accepted: true } : {}) });
    else Object.assign(answer, { dispatched: true, undelivered: "explicit-answer-required" });
    store.save(record);
  }

  async function resolveAnswer(record, answer, { questionIds } = {}) {
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
      result = confirmedAnswer(record, answer) ?? await backend.answer({ answerId: answer.answerId, message: answer.message,
        ...(Array.isArray(questionIds) && questionIds.length ? { questionIds } : {}),
        ...(targetOf(record) === 'codex-desktop' ? { canAnswer } : {}) });
    } catch (error) {
      if (targetOf(record) === 'codex-desktop' && NATIVE_ANSWER_REFUSALS.has(error.code)) {
        Object.assign(answer, { dispatched: true, undelivered: error.code });
        if (item) store.setSupplement(item.requestId, 'blocked', error.code);
        saveDispatch(record);
      }
      throw error;
    }
    if (result?.notSent === true || !result?.consumedQuestionIds?.length) {
      // A backend that found the named question gone (or found nothing pending at all)
      // is a settled no-send. A different question that appeared meanwhile is reported
      // as `question-changed` with its actual text; it was never given this answer.
      // Mark the intent so the scheduler never retries it, and let answerLocked
      // return the public receipt.
      const reported = Array.isArray(result?.pendingQuestions) ? result.pendingQuestions : undefined;
      const code = result?.notSent === true && reported?.length ? 'question-changed' : 'question-not-pending';
      Object.assign(answer, { dispatched: true, undelivered: code });
      if (item) store.setSupplement(item.requestId, 'blocked', code);
      saveDispatch(record);
      throw Object.assign(new Error(code === 'question-changed'
        ? 'The question this answer belonged to is no longer pending; a different question is pending now, so nothing was sent.'
        : 'This subagent has no unanswered question; nothing was sent.'),
      { code, notSent: true, ...(reported ? { pendingQuestions: reported } : {}) });
    }
    if (questionIds && (result.consumedQuestionIds.length !== questionIds.length
        || questionIds.some(id => !result.consumedQuestionIds.includes(id)))) {
      throw Object.assign(new Error("The backend did not confirm the selected question IDs."), { code: "question-changed" });
    }
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
          if (root.known && root.turnId) {
            answer.turnId = root.turnId;
            const active = activeTurnSelection(record, root);
            answer.actualEffort = active?.actualEffort ?? active?.reasoningEffort ?? null;
            answer.actualEffortSource = answer.actualEffort != null ? (active?.actualEffortSource ?? null) : null;
          }
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
  const worktreeOptions = record => ({ workspace: config.workspace, shared: tree =>
    store.list().some(other => other.agentId !== record.agentId && referencesWorktree(other, tree))
    || otherProfilesReference(tree, { stateDirectory: config.stateDirectory, rosterPath: store.location }) });

  function mergeTarget(owner, extra, initial) {
    const current = store.get(initial.agentId);
    if (!canAccessMember(owner, extra, current) || current.ownerId !== initial.ownerId
        || current.parentAgentId !== initial.parentAgentId || current.sessionId !== initial.sessionId
        || current.worktreePath !== initial.worktreePath || current.task?.taskId !== initial.task?.taskId) {
      throw worktreeError("worktree-binding-changed", "The roster or worktree binding changed while waiting.");
    }
    const task = current.task;
    const taskSettled = !task || ["completed", "failed", "cancelled"].includes(task.state);
    if (current.cleanupRosterTicket || (current.closed && !current.worktreeMerge?.worktreeRemoved)
        || (!current.worktreeMerge?.worktreeRemoved && !["idle", "completed", "failed", "cancelled"].includes(current.state))
        || !taskSettled || task?.preemption || current.observation?.running || (task?.cancelRequested && !task.cancelTreeSettled)
        || (task?.dispatches ?? []).some(item => item.accepted !== true && !["completed", "failed", "cancelled", "blocked"].includes(item.state))
        || owesWork(current) || store.submissionDebt(current.agentId, task?.taskId) > 0
        || store.openQuestions(current).unanswered || store.openQuestions(current).undelivered) {
      throw worktreeError("agent-running", "The subagent still has an active turn or unresolved work.");
    }
    if (!current.worktreePath) throw worktreeError("worktree-not-found", "This subagent has no isolated worktree to merge.");
    return current;
  }

  async function snapshotMergeSource(source, head, indexFile) {
    const indexTree = (await git(source, ["write-tree"])).stdout.trim();
    await git(source, ["read-tree", head], { indexFile });
    await git(source, ["add", "-A", "--", "."], { indexFile });
    await git(source, ["reset", "-q", head, "--", ".work"], { indexFile }).catch(() => {});
    const sourceTree = (await git(source, ["write-tree"], { indexFile })).stdout.trim();
    if (indexTree !== sourceTree) {
      const pathsBetween = async (from, to) => (await git(source,
        ["diff", "--name-only", "--no-renames", "-z", from, to])).stdout.split("\0").filter(Boolean);
      const staged = new Set(await pathsBetween(head, indexTree));
      if ((await pathsBetween(indexTree, sourceTree)).some(file => staged.has(file))) {
        throw worktreeError("worktree-retained", "The staged and working versions differ. The source worktree was retained.");
      }
    }
    return { sourceTree, indexTree, indexFile };
  }

  async function removeMergeScratch(directory) {
    if (await plainDirectoryPath(config.stateDirectory, directory)) await rm(directory, { recursive: true, force: true });
  }

  async function confirmDiscardableMerge(record, root) {
    const pending = record.worktreeMerge;
    if (!pending || pending.worktreeRemoved) return;
    if (!['applying', 'discarded'].includes(pending.stage) || pending.applied || !pending.before
        || await workspaceEvidence(root, pending.files) !== pending.before) {
      throw worktreeError("worktree-retained", "The pending merge may have changed its destination. The worktree was retained.");
    }
  }

  async function mergeWorktree(initial, recheck, { discardWorktree } = {}) {
    const summary = (record, phase, error) => ({ action: "merge", name: record.name, ok: !error,
      summary: error
        ? (error.message ?? `合入 ${record.name} 未完成（阶段：${phase?.stage ?? "applying"}）`)
        : phase?.discarded ? `已弃置 ${record.name} 的改动并移除 worktree`
          : `已合入 ${record.name} 的 ${phase?.files?.length ?? 0} 个改动文件并移除 worktree`,
      applied: phase?.applied === true, worktreeRemoved: phase?.worktreeRemoved === true,
      recordClosed: phase?.recordClosed === true, recordCloseRequired: phase?.closeRequired === true,
      mergedFiles: phase?.discarded ? [] : phase?.files ?? [], stage: phase?.stage ?? "applying",
      ...(phase?.discarded ? { discarded: true } : {}),
      ...(error ? { error: safeError(error) } : {}) });
    let record = initial;
    let phase = record.worktreeMerge;
    let stage = phase?.worktreeRemoved ? "recordClosed" : phase?.applied ? "worktreeRemoved" : "applying";
    try {
      const root = await gitRoot(record.repoRoot ?? record.rootWorkspace ?? config.workspace);
      await withWorktreeLock(root, async () => {
        record = recheck();
        if (['failed', 'cancelled'].includes(record.state) && !record.worktreeMerge) {
          const stopped = await observeOwn(record);
          if (stopped.running !== false || stopped.tree?.settled !== true) {
            throw worktreeError('agent-running', 'The stopped state could not be confirmed.');
          }
          record = recheck();
        }
        phase = record.worktreeMerge;
        const options = worktreeOptions(record);
        const identity = await worktreeIdentity(record, options);
        const journal = async next => {
          const current = store.get(record.agentId);
          if (JSON.stringify(current) !== JSON.stringify(record)) throw worktreeError("worktree-binding-changed", "The roster changed during merge.");
          const previous = { ...record };
          record.worktreeMerge = next;
          if (!store.save(record, { expectedTurn: previous })) throw worktreeError("worktree-binding-changed", "The roster rejected the merge stage.");
          phase = next;
        };
        const applyPatch = async (apply, patchFile) => {
          if (await workspaceEvidence(root, phase.files) !== phase.before) {
            throw worktreeError("worktree-apply-unknown", "The destination changed before application.");
          }
          await git(root, [...apply, "--check", patchFile]);
          await git(root, [...apply, patchFile]);
          if (await workspaceEvidence(root, phase.files) !== phase.after) {
            throw worktreeError("worktree-apply-unknown", "The patch outcome could not be verified.");
          }
          await journal({ ...phase, stage: "applied", applied: true });
        };
        const needsThreeWay = patchFile => git(root, ["apply", "--check", "--whitespace=nowarn", patchFile]).then(() => false, () => true);
        const patchArgs = threeWay => ["apply", ...(threeWay ? ["--3way"] : []), "--whitespace=nowarn"];
        if (!phase?.applied && !phase?.discarded && !phase?.worktreeRemoved) {
          const evidence = phase && await workspaceEvidence(root, phase.files);
          if (phase && evidence === phase.after && (!discardWorktree || evidence !== phase.before)) {
            await journal({ ...phase, stage: "applied", applied: true });
          } else {
            if (phase && evidence !== phase.before) {
              throw worktreeError("worktree-apply-unknown", "The previous application cannot be confirmed. The worktree was retained.");
            }
            if (phase && discardWorktree) {
              await confirmDiscardableMerge(record, root);
              await journal({ ...phase, stage: "discarded", discarded: true });
            } else {
              if (identity.missing) throw worktreeError("worktree-not-found", "The worktree is unavailable.");
              const sourceHead = await commitSha(identity.worktreePath, "HEAD");
              const base = phase?.base ?? (fullSha(record.worktreeBaseHead)
                ? await commitSha(identity.worktreePath, record.worktreeBaseHead)
                : (await git(identity.worktreePath, ["merge-base", await commitSha(root, "HEAD"), sourceHead])).stdout.trim());
              if (!fullSha(base)) throw worktreeError("invalid-base-sha", "The worktree and its destination have no verified base.");
              await mkdir(config.stateDirectory, { recursive: true });
              const key = uid("merge");
              const tmp = await mkdtemp(path.join(config.stateDirectory, "m-"));
              try {
                 const { sourceTree, indexTree, indexFile } = await snapshotMergeSource(identity.worktreePath, sourceHead, path.join(tmp, "s"));
                const diffArgs = ["--cached", "--no-renames", base, "--", ".", ":(exclude).work"];
                const files = (await git(identity.worktreePath, ["diff", "--name-only", "-z", ...diffArgs],
                   { indexFile })).stdout.split("\0").filter(Boolean).sort();
                const closeRequired = record.lifetime === "once" && config.agentAutoCleanup !== false;
                if (!phase && !files.length) {
                  await journal({ key, path: identity.worktreePath, stage: "applied", applied: true, closeRequired, files,
                    sourceTree, sourceHead, indexTree, base });
                } else {
                  const { stdout: patch } = await git(identity.worktreePath,
                     ["diff", "--binary", "--full-index", "--no-ext-diff", ...diffArgs], { indexFile, encoding: "buffer" });
                  const patchSha = createHash("sha256").update(patch).digest("hex");
                  if (phase && (sourceHead !== phase.sourceHead || sourceTree !== phase.sourceTree || patchSha !== phase.patchSha
                      || (phase.indexTree && indexTree !== phase.indexTree) || JSON.stringify(files) !== JSON.stringify(phase.files))) {
                    throw worktreeError("worktree-retained", "The source changed before the pending application. The worktree was retained.");
                  }
                  const patchFile = path.join(tmp, "p");
                  await writeFile(patchFile, patch);
                  if (!phase) {
                    const dirty = new Set((await git(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored=matching"])).stdout
                      .split("\0").filter(Boolean).map(line => line.slice(3).replace(/\/$/, "")));
                    const conflictingFiles = files.filter(file => [...dirty].some(name => file === name || file.startsWith(name + "/") || name.startsWith(file + "/")));
                    if (conflictingFiles.length) throw worktreeError("worktree-merge-conflict", "The destination has local changes on the patch paths.", { conflictingFiles });
                    const before = await workspaceEvidence(root, files);
                    const scratch = path.join(tmp, "w");
                    await mkdir(scratch);
                    const gitDirectory = (await git(root, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
                    const originalIndex = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
                    const shadowIndex = path.join(tmp, "i");
                    await copyFile(originalIndex, shadowIndex);
                    for (const file of files) {
                      const destination = path.join(scratch, file);
                      await mkdir(path.dirname(destination), { recursive: true });
                      try { await copyFile(path.join(root, file), destination); }
                      catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
                    }
                    const threeWay = await needsThreeWay(patchFile);
                    await git(scratch, ["--git-dir", gitDirectory, "--work-tree", scratch, ...patchArgs(threeWay), patchFile],
                       { indexFile: shadowIndex }).catch(() => {
                        throw worktreeError("worktree-merge-conflict", "The patch conflicts with the destination history.", { conflictingFiles: files });
                      });
                    const after = await workspaceEvidence(scratch, files, { gitRoot: root, indexFile: shadowIndex });
                    await journal({ key, path: identity.worktreePath, stage: "applying", closeRequired, files, before, after,
                      threeWay, patchSha, sourceTree, sourceHead, indexTree, base });
                  }
                  await applyPatch(patchArgs(phase.threeWay ?? await needsThreeWay(patchFile)), patchFile);
                }
               } finally { await removeMergeScratch(tmp); }
            }
          }
        }
        stage = "worktreeRemoved";
        if (!phase.worktreeRemoved) {
          if (!identity.missing && !discardWorktree && !phase.discarded) {
            const status = (await git(identity.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"])).stdout;
            if (status.split("\0").some(line => line.startsWith("!! ") || /^.{3}\.work(?:\/|$)/.test(line))) {
              throw worktreeError("worktree-retained", "The source contains user files excluded from the patch.");
            }
            if (await commitSha(identity.worktreePath, "HEAD") !== phase.sourceHead) {
              throw worktreeError("worktree-retained", "The source HEAD changed after the patch was prepared.");
            }
            const temp = await mkdtemp(path.join(config.stateDirectory, "m-"));
            try {
              const { sourceTree, indexTree } = await snapshotMergeSource(identity.worktreePath, phase.sourceHead, path.join(temp, "s"));
              if (sourceTree !== phase.sourceTree || (phase.indexTree && indexTree !== phase.indexTree)) {
                throw worktreeError("worktree-retained", "The source files or index changed after the patch was prepared.");
              }
            } finally { await removeMergeScratch(temp); }
          }
          if (phase.discarded && await workspaceEvidence(root, phase.files) !== phase.before) {
            throw worktreeError("worktree-apply-unknown", "The destination changed before the discard.");
          }
          await removeVerifiedWorktree(record, options, { force: true });
          await journal({ ...phase, stage: "worktreeRemoved", worktreeRemoved: true });
        }
      });
      stage = "recordClosed";
      if (phase.closeRequired) {
        const result = await clearRecord(record, { autoClaimed: true });
        if (!result.deleted) throw worktreeError(result.error?.code ?? "worktree-record-close-failed",
          result.error?.message ?? "The worktree is removed, but the roster record could not be closed.");
        phase = { ...phase, stage: "recordClosed", recordClosed: true };
      } else {
        const update = { ...record, workspace: record.callerWorkspace ?? record.rootWorkspace, workspaceMode: "inherit" };
        delete update.worktreePath;
        delete update.worktreeBaseHead;
        delete update.unmergedWorktree;
        delete update.worktreeMerge;
        if (!store.save(update, { expectedTurn: record })) throw worktreeError("worktree-record-close-failed", "The roster workspace could not be restored.");
        phase = { ...phase, stage: "complete" };
      }
      forgetBackend(record);
      wakeWaiters();
      return summary(record, phase);
    } catch (error) {
      if (!phase && (error?.code === "worktree-merge-conflict" || error?.code === "worktree-busy")) throw error;
      return summary(record, { ...phase, stage }, error);
    }
  }

  async function cleanupProof(record, { discardWorktree = false } = {}) {
    const current = store.get(record.agentId);
    if (!current) return { verified: [], error: { code: "agent-not-found" } };
    const verified = [current, ...store.descendantsOf([record.agentId])];
    for (const member of verified) {
      if (!hasWorktreeEvidence(member)) continue;
      const options = worktreeOptions(member);
      try {
        if (discardWorktree) {
          const identity = await worktreeIdentity(member, options);
          await confirmDiscardableMerge(member, identity.root);
          continue;
        }
        if ((await inspectWorktree(member, options)).state === "clean") continue;
      } catch { /* keep the roster and its worktree pointer */ }
      return { verified, error: { code: "worktree-retained", message: `Resolve the worktree for “${member.name}” before removing this roster tree.` } };
    }
    if (!store.cleanupTreeMatches(record, verified)) return { verified, error: { code: "cleanup-tree-changed" } };
    return { verified };
  }

  async function removeOwnedWorktree(record, { force = false, recheck } = {}) {
    const options = worktreeOptions(record);
    const anchor = record.repoRoot ?? record.rootWorkspace ?? config.workspace;
    return withWorktreeLock(anchor, async () => {
      if (force) await confirmDiscardableMerge(record, await gitRoot(anchor));
      return removeVerifiedWorktree(record, options, { force, recheck });
    });
  }

  async function clearRecord(record, { autoClaimed = false, autoRetry = false, discardWorktree = record.discardWorktree === true } = {}) {
    requireWritableTarget(record);
    const automatic = autoClaimed || autoRetry;
    const proof = await cleanupProof(record, { discardWorktree });
    if (proof.error) return { name: record.name, deleted: false, state: record.state, error: proof.error };
    record.state = 'cleaning'; record.closed = true;
    if (automatic) record.autoCleanupClosed = true;
    if (!autoClaimed) store.save(record);
    let checkingHost = false;
    try {
      for (const child of store.childrenOf(record.agentId)) {
        const current = store.get(child.agentId);
        if (!current || current.agentId === record.agentId) continue;
        const verdict = await store.locked(current.agentId, async () => {
          const fresh = store.get(current.agentId);
          return fresh ? clearRecord(fresh, { autoRetry: autoClaimed || autoRetry, discardWorktree }) : { deleted: true };
        }, { waitMs: 0 });
        if (verdict?.deleted !== true) {
          throw Object.assign(new Error(`The managed subagent “${current.name}” could not be cleaned; this name stays listed so cleanup can be retried.`),
            { code: verdict?.queued ? 'agent-busy' : 'child-cleanup-failed', child: current.name, childError: verdict?.error });
        }
      }
      if (record.lifetime === 'once' && record.parentAgentId) await keepChildSnapshot(record);
      const agentPathBeforeRemove = managedPath(record);
      const rootOwnerBeforeRemove = rootOwnerIdForRecord(record);
      if (!record.nativeDestroyed) {
        checkingHost = true;
        const backend = await checkHost(record);
        checkingHost = false;
        const result = await backend.destroy();
        if (result.destroyed !== true) throw new Error(result.message ?? `${backend.labels?.host ?? targetOf(record)} has not confirmed complete session cleanup.`);
        if (result.nativeSessionRetained !== undefined) record.nativeSessionRetained = result.nativeSessionRetained;
        record.nativeDestroyed = true; store.save(record);
      }
      if (record.worktreePath) await removeOwnedWorktree(record, { force: discardWorktree });
      const pendingBaseline = record.task?.taskId ? baselineWrites.get(record.task.taskId) : undefined;
      if (pendingBaseline) await pendingBaseline;
      await removeScopedDirectory(agentDirectory(record));
      if (record.lifetime === 'once' && (autoClaimed || autoRetry)) {
        const target = targetOf(record);
        const native = isHeadlessCli(target) ? store.backendState(record.agentId) : undefined;
        const resumeSessionId = target === 'codex-cli' ? native?.threadId ?? null
          : native?.started ? (target === 'agy-cli' ? native.conversationId : native.sessionId) ?? null : null;
        store.saveAgentStub({
          agentId: record.agentId,
          rootOwnerId: rootOwnerBeforeRemove,
          ownerId: record.ownerId,
          name: record.name,
          role: record.role ?? inferRoleFromName(record.name) ?? null,
          agentPath: agentPathBeforeRemove,
          parentAgentId: record.parentAgentId ?? null,
          target: targetOf(record),
          workspace: record.callerWorkspace ?? record.rootWorkspace ?? record.workspace ?? null,
          resumeSessionId,
          model: actualModelName(record.model) ?? actualModelName(record.modelPin) ?? null,
          readOnlyScout: record.readOnlyScout === true,
          lastTaskSummary: record.task?.message ? compactText(record.task.message, 120) : null,
        });
      } else {
        store.deleteAgentStub?.(record.agentId);
      }
      store.remove(record, { deliveredReceipt: autoClaimed || autoRetry });
      forgetBackend(record);
      return { name: record.name, deleted: true, sessionDataRemoved: !record.nativeSessionRetained,
        ...(record.nativeSessionRetained !== undefined ? { nativeSessionRetained: record.nativeSessionRetained } : {}) };
    } catch (error) {
      const current = store.get(record.agentId);
      const retries = current?.cleanupReadRetries ?? 0;
      const retryBeforeDelete = automatic && targetOf(record) === 'codex-desktop'
        && error.uncertain !== true && error.terminal !== true && isCodexTransientTimeout(error)
        && (checkingHost || error.cleanupNotSent === true) && retries < CODEX_CLEANUP_READ_RETRIES;
      // An uncertain destroy is a write whose outcome is unknown, not a failed cleanup:
      // the host may already be finishing it. A busy or queued child makes the parent
      // wait the same way. Neither is reported as an error, or a queued cleanup would
      // be listed as failed.
      if (current && (retryBeforeDelete || error.uncertain === true || error.code === 'agent-busy')) {
        if (retryBeforeDelete) current.cleanupReadRetries = retries + 1;
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

  const exactReportText = (record, task, report, fallback) => {
    const raw = typeof report?.id === 'string' ? report.id : undefined;
    const id = raw?.startsWith('submission:') ? raw.slice('submission:'.length) : raw;
    const key = task?.requestId ? store.taskKeyForRequest(record.ownerId, task.requestId) : undefined;
    if (!key || !id) return fallback ?? report?.message;
    const stored = store.storedReportBody(record.ownerId, key, id);
    return stored && !stored.error && typeof stored.body === 'string' ? stored.body : fallback ?? report?.message;
  };

  // Only persisted report_parent calls may wake the parent chat.
  async function deliverReports(record, { readOnDemand = false } = {}) {
    await drainSubmissions(record, { currentOnly: true, readOnDemand });
    let finalTerminal = true;
    let changed = false;
    for (const report of record.task?.reports ?? []) {
      if (fromSubmission(report.id)) {
        if (report.final && !terminalNotice(report.delivery)) finalTerminal = false;
        continue;
      }
      if (report.sharedSubmission && !nativeReportOnly(record)) {
        const exists = store.submissions(record.agentId, record.task?.taskId)
          .some(item => item.id === report.sharedSubmission);
        if (exists) {
          if (report.final && !terminalNotice(report.delivery)) finalTerminal = false;
          continue;
        }
        // A legacy report whose shared row was removed has no other sender; drop
        // the stale alias and let its native notice settle (or expire) normally.
        delete report.sharedSubmission;
      }
      // Prefer the report's own time. An old fixture/report without one may use the
      // task's start time (still a real time); a truly timeless old notice expires.
      const reportCreated = report.createdAt ?? record.task?.startedAt;
      if (reportCreated) report.delivery.createdAt = reportCreated;
      if (report.failure) {
        await deliver(record, report.delivery, report.message);
        continue;
      }
      if (report.final && !finalReportReady(report)) {
        // A native report has no submission row to carry the wait. Its own notice
        // gets the same bounded release moment, so the monitor wakes at the
        // deadline instead of polling a settling tree every few hundred milliseconds.
        const notice = report.delivery;
        const deadline = finalReportDeadline(report, record.task);
        if (!notice.waitingForTree) { notice.waitingForTree = true; changed = true; }
        if (deadline !== undefined && notice.treeReleaseAt !== new Date(deadline).toISOString()) {
          notice.treeReleaseAt = new Date(deadline).toISOString();
          notice.nextAttemptAt = deadline;
          changed = true;
        }
        finalTerminal = false;
        continue;
      }
      const message = exactReportText(record, record.task, report, report.message);
      if (report.message !== message) report.message = message;
      await deliver(record, report.delivery, `${hostLabel(record)}「${record.name}」${report.final ? '交付' : '汇报'}：\n${message}${report.treeRelease ? '\n\n' + treeReleaseText(report.treeRelease) : ''}`,
        { reportSummary: message });
      // An older non-final notice must never hold back the final report that
      // follows it. The final report itself still has to reach a terminal state.
      if (report.final && !terminalNotice(report.delivery)) finalTerminal = false;
    }
    if (changed) store.save(record);
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
    // A shared submission row is the durable owner of a delivery attempt. Bring its
    // current attempt clock into the task mirror before deciding whether the thirty-
    // minute gate or a fresh read-back applies. A terminal projection is never
    // rewritten by an older row.
    for (const item of store.submissionWork(record.agentId, record.task?.taskId)) {
      if (!item.delivery) continue;
      const report = (record.task?.reports ?? []).find(entry => sameReportId(entry.id, item.id)
        || entry.sharedSubmission === item.id);
      if (report?.delivery && !['delivered', 'blocked'].includes(report.delivery.state)) {
        for (const field of ['state', 'attemptedAt', 'nextAttemptAt', 'error', 'readbackIds',
          'attempts', 'readbackGeneration']) {
          if (field in item.delivery) report.delivery[field] = item.delivery[field];
        }
      }
    }
    for (const report of record.task?.reports ?? []) {
      const notice = report.delivery;
      if (!fromSubmission(report.id) && awaitingNoticeReceipt(notice)) notice.nextAttemptAt = undefined;
    }
    store.save(record);
    await deliverReports(record, { readOnDemand: true });
    const task = record.task;
    const final = (task?.reports ?? []).find(report => report.final);
    // The same finish gate a poll uses, so a settled report closes its task once.
    if (final && finalReportReady(final) && task.result
        && task.reports.filter(report => report.final).every(report => terminalNotice(report.delivery))) await finishDeliveredReport(record);
  }

  async function requireSettledSubmissions(record) {
    const taskId = record.task?.taskId;
    // The shared submission gate is the original one: an unconfirmed write keeps
    // its unknown occupation until its own thirty-minute limit or a terminal state.
    // The tree-release path is separate and must not turn that into a generic debt
    // shortcut that blocks a real in-flight report early.
    const blocking = taskId ? store.submissionWork(record.agentId, taskId) : [];
    if (!blocking.length) return;
    await ensureWorker(record, { wake: true, hasSubmission: true });
    throw Object.assign(new Error(`上一轮还有 ${blocking.length} 条请示或回报未送达。请等投递确认或进入终态后重试。`),
      { code: 'previous-delivery-pending', retryable: true, count: blocking.length });
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
    if (targetOf(record) === 'agy-cli' && record.observation?.running === true) {
      const latest = await observe(record).catch(() => undefined);
      if (latest?.running !== false) {
        record.state = task.state = 'running';
        store.save(record);
        return publicResult(record);
      }
    }
    task.state = task.cancelRequested ? 'cancelled' : task.result.state;
    task.finishedAt ??= now();
    const finalDelivered = task.reports.filter(report => report.final)
      .every(report => report.delivery.state === 'delivered');
    // The release is not a tree proof. Only a real observation that still shows
    // this owned tree settled may authorize automatic once cleanup, and that proof
    // is persisted here before any cleanup claim.
    let observedSettled = record.observation?.stale !== true && record.observation?.observationError === undefined
      && treeSettled(record, record.observation ?? {});
    if (!observedSettled && record.lifetime === 'once' && task.state === 'completed' && finalDelivered) {
      try {
        record.observation = await observe(record);
        observedSettled = treeSettled(record, record.observation);
      } catch (error) {
        record.observation = { ...record.observation, stale: true, observationError: error.message };
        observedSettled = false;
      }
    }
    if (observedSettled && !task.treeSettledConfirmed) task.treeSettledConfirmed = true;
    const realTreeSettled = task.treeSettledConfirmed === true && observedSettled;
    // A blocked final is a terminal delivery outcome, not a delivered report.
    // Keep the name, task body and notification for the parent; a persistent name
    // returns to idle so it can accept work, and a one-shot stays listed for delete.
    if (!finalDelivered) {
      record.state = 'idle';
      store.save(record);
      return afterTerminal(record);
    }
    if (record.lifetime === 'once' && task.state === 'completed' && finalDelivered) {
      const hold = store.autoCleanupHold(record.agentId);
      if (hold.pending || hold.blocked) {
        record.state = hold.pending ? 'delivery_pending'
          : store.supplementSummary(record.agentId, task.taskId).blocked ? 'supplement_blocked' : 'idle';
        if (hold.blocked) task.autoCleanupHeld = true;
        store.save(record);
        return hold.pending ? publicResult(record) : afterTerminal(record);
      }
      if (store.supplementSummary(record.agentId, task.taskId).blocked) {
        record.state = 'supplement_blocked';
        store.save(record);
        return publicResult(record);
      }
      if (realTreeSettled) {
        const proof = await cleanupProof(record);
        if (proof.error) {
          if (record.worktreePath) record.unmergedWorktree = true;
          record.state = "idle";
          delete task.autoCleanupPending;
          store.save(record);
          return publicResult(record);
        }
        if (store.claimAutoCleanup(record, proof.verified)) return clearRecord(record, { autoClaimed: true });
        const latest = store.get(record.agentId);
        if (latest?.task?.taskId === task.taskId && latest.task.cancelRequested) {
          task.cancelRequested = true;
          record.state = task.state = 'running';
          store.save(record);
          return publicResult(record);
        }
        return publicResult(latest ?? record);
      }
      // A once name whose final is delivered but whose owned tree still has a running
      // child must keep its record and keep watching. The ordinary monitor sweep will
      // call settleFinishedRound again; it must not claim cleanup or close the tree yet.
      task.autoCleanupPending = true;
      record.state = 'idle';
      store.save(record);
      return afterTerminal(record);
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
      const previous = task.reports.find(report => sameReportId(report.id, incoming.id));
      if (previous) {
        if (previous.final !== incoming.final || (previous.message !== incoming.message
            && !(typeof previous.message === 'string' && previous.message.startsWith(incoming.message)))) {
          throw new Error('A persisted report identity changed.');
        }
        if (previous.message !== incoming.message) previous.message = incoming.message;
        // A crash can leave the shared submission row without the task projection.
        // Adopt the native raw id only before any delivery attempt; delivered and
        // in-flight rows keep their exact existing identity.
        if (previous.id !== incoming.id && fromSubmission(previous.id)
            && !previous.delivery?.attemptedAt && previous.delivery?.state === 'pending') previous.id = incoming.id;
      } else {
        task.reports.push({ id: incoming.id, taskId: incoming.taskId, message: incoming.message,
          final: incoming.final, createdAt: incoming.createdAt, delivery: { id: 'report-' + incoming.id, state: 'pending',
            createdAt: incoming.createdAt } });
        // The native DSH report UUID becomes the shared submission identity. Its body
        // and delivery state are then the same facts the wait exit reads.
        const added = task.reports.at(-1);
        added.message = exactReportText(record, task, added, incoming.message);
      }
      const projected = task.reports.find(report => sameReportId(report.id, incoming.id));
      // Never manufacture a second pending row for an already delivered/blocked
      // report from a rollback-era roster. A fresh report or a pending projection
      // gets exactly one shared row (INSERT OR IGNORE keeps it idempotent). A report
      // with no original time keeps that absence instead of being stamped now.
      const createdForRow = projected?.createdAt ?? (previous ? undefined : incoming.createdAt ?? task.startedAt);
      if (!nativeReportOnly(record) && projected && createdForRow && !['delivered', 'blocked'].includes(projected.delivery?.state)
          && (projected.delivery?.state === 'pending' || !projected.delivery?.attemptedAt)) {
        store.enqueueSubmission({ id: bareReportId(incoming.id), ownerId: record.ownerId, agentId: record.agentId,
          taskId: task.taskId, kind: 'report', message: projected.message, final: projected.final,
          created: createdForRow });
      }
    }
    const final = task.reports.find(report => report.final);
    if (final && !final.treeSettledConfirmed) releaseDueFinals(record, view);
    if (final && view?.stale !== true && !view?.observationError && !view?.tree?.observationError
        && treeSettled(record, view) && !(view.questions ?? []).some(question => question.state === 'pending')) final.treeSettledConfirmed = true;
    if (final?.treeSettledConfirmed && final.delivery?.waitingForTree) {
      // A tree that settled before its deadline releases the same queued notice.
      delete final.delivery.waitingForTree;
      delete final.delivery.nextAttemptAt;
    }
    if (final && finalReportReady(final)) {
      const outcome = task.cancelRequested || task.state === 'cancelled' || rootSummary(view)?.state === 'cancelled' ? 'cancelled'
        : task.state === 'failed' || rootSummary(view)?.state === 'failed' ? 'failed' : 'completed';
      task.result = { state: outcome,
        reply: final.message, changes: attributedChanges(record, view), coverage: treeCoverage(record, view),
        tree: publicTree(record, view), ...(final.treeRelease ? { treeRelease: final.treeRelease } : {}) };
      task.state = task.result.state;
    }
    // Persist the terminal outcome before delivery can succeed or become ambiguous.
    store.save(record);
    const delivered = await deliverReports(record);
    if (final && finalReportReady(final)) {
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
    if (dispatch.accepted || dispatch.expired) return;
    // Only a Codex answer may be recovered from a failed row left by an older
    // SQLite build; every other dispatch keeps the original recoverable states.
    const answer = dispatch.kind === 'answer' && targetOf(record) === 'codex-desktop';
    const recoverable = answer ? ['sending', 'retrying', 'unknown', 'queued', 'failed']
      : ['sending', 'retrying', 'unknown', 'queued'];
    if (!recoverable.includes(dispatch.state)) return;
    if (Math.max(dispatch.nextAttemptAt ?? 0, dispatch.transportNextAttemptAt ?? 0) > Date.now()) return;
    // The backend owns its own receipt format; undefined means this saved intent
    // never reached a native write.
    const receipt = await (await backendFor(record)).receipt({ requestId: dispatch.requestId });
    if (!receipt) {
      if (!['sending', 'retrying', 'queued'].includes(dispatch.state)) return;
      // The receipt is written before entering the native send. No receipt means
      // this intent never reached that send; keep the exact request ID. A direct
      // answer or a first task dispatch has no supplement row, so this loop is the
      // only place that can retry it after a transient root read.
      if (dshDefaultOnly(record)) { delete dispatch.deliveryIntent; dispatch.modelReady = false; }
      if (!allowResend) return 'not-sent';
      await dispatchOnce(record, dispatch);
      return;
    }
    dispatch.afterSeq = receipt.afterSeq ?? dispatch.afterSeq;
    if (answer && (['unknown', 'sending'].includes(receipt.status)
        || (['waiting', 'retryable'].includes(receipt.status) && receipt.verifiedNotSent !== true))) {
      // The answer write may have landed; read-only recovery must never replay it.
      Object.assign(dispatch, { state: 'unknown', accepted: false, delivery: 'unknown',
        nextAttemptAt: undefined,
        ...(dispatch.error ? {} : { error: { code: 'answer-outcome-unknown',
          message: 'The native answer write was not proven; it will not be sent again.' } }) });
      return 'unknown';
    }
    // A start that lost a race to another turn returns waiting/after-current with
    // notSent. Wait until that root is idle, then write under the same request id;
    // never steer into a turn this answer does not own and never duplicate it.
    if (answer && receipt.status === 'waiting') {
      let root;
      try { root = await rootTurnFor(record); } catch { root = { known: false }; }
      if (root.known === false || root.running) {
        Object.assign(dispatch, { state: 'queued', accepted: false, delivery: 'after-current',
          ...(receipt.afterTurnId ? { afterTurnId: receipt.afterTurnId } : {}) });
        return 'waiting';
      }
      delete dispatch.afterTurnId;
      if (!allowResend) return 'not-sent';
      await dispatchOnce(record, dispatch, undefined, { recoveryNotSent: true, startOnly: true });
      return;
    }
    // A proven pre-write answer retry has its own recovery path below.
    const answerRetryable = answer && receipt.status === 'retryable';
    if (!answerRetryable && (receipt.delivery === 'after-current' || receipt.delivery === 'local-pending')) {
      Object.assign(dispatch, { state: 'queued', accepted: false, delivery: receipt.delivery,
        ...(receipt.afterTurnId ? { afterTurnId: receipt.afterTurnId } : {}) });
      return;
    }
    if (receipt.status === 'accepted') Object.assign(dispatch, { accepted: true, state: 'running', error: undefined, failure: undefined, nextAttemptAt: undefined, retryAttempts: undefined,
      delivery: Object.hasOwn(receipt, 'delivery') ? receipt.delivery : 'accepted-route-unknown',
      ...(receipt.turnId ? { turnId: receipt.turnId } : {}),
      ...(Object.hasOwn(receipt, 'actualEffort') ? { actualEffort: receipt.actualEffort } : {}),
      ...(receipt.actualEffort != null && receipt.actualEffortSource ? { actualEffortSource: receipt.actualEffortSource } : {}),
      ...(receipt.effortAdjustment ? { effortAdjustment: receipt.effortAdjustment } : {}),
      ...(Object.hasOwn(receipt, 'actualModel') ? { actualModel: receipt.actualModel } : {}),
      ...(receipt.afterTurnId ? { afterTurnId: receipt.afterTurnId } : {}) });
    if (receipt.status === 'accepted' && receipt.delivery === 'current-turn') delete dispatch.afterTurnId;
    if (receipt.status === 'accepted') rememberAcceptedCodexPin(record, dispatch);
    if (receipt.status === 'accepted' && receipt.delivery === 'new-turn' && targetOf(record) === 'dsh') {
      delete dispatch.deliverySelection; delete dispatch.deliveryModel;
    }
    if (receipt.status === 'rejected') {
      dispatch.state = 'failed'; dispatch.accepted = false; dispatch.delivery = 'blocked';
      if (answer) dispatch.error ??= { code: 'codex-delivery-refused',
        message: 'The native side rejected this answer; it was not written.' };
      else dispatch.error = receipt.error ?? { code: receipt.code ?? 'send-rejected', message: receipt.message ?? 'The input was not accepted.' };
    }
    if (receipt.status === 'failed') {
      dispatch.state = 'failed'; dispatch.accepted = false; dispatch.delivery = 'blocked';
      dispatch.error = receipt.error ?? { code: receipt.code ?? 'send-rejected', message: receipt.message ?? 'The input was not accepted.' };
    }
    if (receipt.status === 'retryable') {
      if (targetOf(record) === 'dsh' && (['managed-turn-ended', 'managed-turn-changed', 'managed-turn-unknown'].includes(receipt.code) || dshDefaultOnly(record))) {
        delete dispatch.deliveryIntent; delete dispatch.deliveryModel; delete dispatch.deliverySelection; dispatch.modelReady = false;
      }
      // Other unknown inputs stay read-only unless the native receipt itself proves
      // the write never started.
      if (!answer && dispatch.state === 'unknown' && receipt.notSent !== true) return;
      if (!allowResend) return 'not-sent';
      // The acknowledged thread may have an empty rollout until its first turn starts.
      // The adapter retries that exact start only after a receipt proves it was not sent.
      const pendingFirstTurn = receipt.verifiedNotSent === true && receipt.pendingFirstTurn === true;
      // Only a steer the native side proved it rejected turns this recovery into
      // "wait for a new turn". An ordinary read-only retry keeps the original steer
      // behaviour: the answer may still need to join its own live turn A.
      const rejectedSteer = answer && receipt.reschedule?.notSent === true
        && receipt.reschedule.reason === 'steer-turn-ended';
      if (rejectedSteer) {
        let root;
        try { root = await rootTurnFor(record); } catch { root = { known: false }; }
        const expected = receipt.intent?.expectedTurnId;
        if (root.known === false || (root.running && expected !== root.turnId)) {
          Object.assign(dispatch, { state: 'queued', accepted: false, delivery: 'after-current',
            ...(root.turnId ? { afterTurnId: root.turnId } : {}) });
          return 'waiting';
        }
        delete dispatch.afterTurnId;
      }
      await dispatchOnce(record, dispatch, undefined,
        { pendingFirstTurn, recoveryNotSent: answer, startOnly: rejectedSteer });
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
          delivery: Object.hasOwn(receipt, 'delivery') ? receipt.delivery : 'accepted-route-unknown',
          ...(receipt.turnId ? { turnId: receipt.turnId } : {}),
          ...(Object.hasOwn(receipt, 'actualEffort') ? { actualEffort: receipt.actualEffort } : {}),
          ...(receipt.actualEffort != null && receipt.actualEffortSource ? { actualEffortSource: receipt.actualEffortSource } : {}),
          ...(receipt.effortAdjustment ? { effortAdjustment: receipt.effortAdjustment } : {}),
          ...(Object.hasOwn(receipt, 'actualModel') ? { actualModel: receipt.actualModel } : {}),
          ...(receipt.afterTurnId ? { afterTurnId: receipt.afterTurnId } : {}),
          nextAttemptAt: undefined, retryAttempts: undefined });
        if (receipt.delivery === 'current-turn') delete dispatch.afterTurnId;
        rememberAcceptedCodexPin(record, dispatch);
        if (receipt.delivery === 'new-turn' && targetOf(record) === 'dsh') { delete dispatch.deliverySelection; delete dispatch.deliveryModel; }
        return 'accepted';
      }
      // Only a Codex answer waiting receipt that carries its own no-write evidence is
      // proof of no write. A bare waiting status from another backend or an older
      // adapter may mean a different thing and is never promoted to proof here.
      if (dispatch.kind === 'answer' && targetOf(record) === 'codex-desktop'
          && ['waiting', 'retryable'].includes(receipt?.status)) {
        return receipt.verifiedNotSent === true ? 'not-sent' : 'unknown';
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
    // A direct answer's dispatch shares its answerId; an internal dispatch is linked
    // through the question ids it consumed, never through the answerId itself.
    const answerDispatchPending = dispatch => dispatch.kind === 'answer'
      && dispatch.accepted !== true
      && !['blocked', 'failed', 'cancelled', 'unknown'].includes(dispatch.state);
    const readyAnswers = (task.answers ?? []).some(answer => !answer.dispatched
      || (task.dispatches ?? []).some(dispatch => answerDispatchPending(dispatch)
        && (dispatch.requestId === answer.answerId
          || (answer.questionIds ?? []).some(id => (dispatch.answerIds ?? []).includes(id)))));
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
      if ((target === 'dsh' && mode === 'queue') || (isHeadlessCli(target) && mode === 'steer')) {
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
      store.saveTaskKey(record.ownerId, record.agentId, item.requestId, task.taskId);
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
        recoverLegacyAnswer(record, priorAnswer);
        if (!priorAnswer.questionIds) {
          store.setSupplement(item.requestId, 'blocked', 'explicit-answer-required');
          continue;
        }
        saveSupplementReceipt(item.requestId, 'accepted', null,
          { delivery: priorAnswer.nativeAnswered ? 'answered' : 'answer-pending', mode: 'steer' });
        if (!priorAnswer.dispatched) return;
        continue;
      }
      const scheduled = await loadView();
      if ((scheduled.reports ?? []).some(report => report.final)) {
        store.blockQueued(record.agentId, record.task.taskId, 'final-submitted');
        store.setSupplement(item.requestId, 'blocked', 'final-submitted'); return;
      }
      const mode = item.mode === 'queue' ? 'queue' : 'steer';
      const pendingQuestion = pendingIn(scheduled).length > 0 || store.openQuestions(record).unanswered > 0;
      if (pendingQuestion) {
        if (root?.running) saveSupplementReceipt(item.requestId, 'queued', null,
          { delivery: 'after-current', afterTurnId: root.turnId, mode: 'queue' });
        else saveSupplementReceipt(item.requestId, 'queued', null, { delivery: 'local-pending', mode: 'queue' });
        continue;
      }
      if (isHeadlessCli(target)) {
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
    if (final && !finalReportReady(final) && !task.treeUnavailable) {
      let view;
      try {
        view = await observe(record);
      } catch (error) {
        record.observation = { ...record.observation, stale: true, observationError: error.message };
        if (targetOf(record) === 'codex-desktop' && error.code === MISSING_THREAD_CODE) {
          record.error = safeError(error);
          task.treeUnavailable = MISSING_THREAD_CODE;
          record.state = task.state = 'failed';
        }
        if (releaseDueFinals(record, record.observation, error.message)) {
          store.save(record);
          // The last readable tree may still be shown, but it is explicitly stale
          // and unreadable; the release record carries that fact.
          return finishReports(record, record.observation);
        }
        store.save(record);
      }
      if (view) return finishReports(record, view);
    }
    if (hasPendingDelivery(record)) await deliverReports(record);
    if (finalReportReady(final) && task.result && task.reports.filter(report => report.final).every(report => terminalNotice(report.delivery))) {
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
      // The answer's public row says blocked only when the native receipt proved
      // nothing was written; an unproven write keeps the unknown label. Its state
      // stays unknown either way, which is what lets a final report settle.
      ...(dispatch.kind === 'answer' ? { delivery: unconfirmed ? 'unknown' : 'blocked' } : {}),
      nextAttemptAt: undefined, error: { code: reason, message: unconfirmed
        ? 'This input expired after six hours with no confirmed receipt. Its body is kept.'
        : 'This input expired after six hours without being sent. Its body is kept.' } });
    if (dispatch?.kind === 'answer') {
      for (const answer of record.task.answers ?? []) {
        // A direct answer's dispatch shares its answerId; an internal dispatch is
        // linked through the question ids it consumed. The old answerId/answerIds
        // comparison could never match and let an expired answer be sent again.
        const linked = answer.answerId === dispatch.requestId
          || (dispatch.answerIds ?? []).some(id => (answer.questionIds ?? []).includes(id));
        if (linked) Object.assign(answer, { dispatched: true, undelivered: reason, delivery: 'unknown' });
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
      const answer = dispatch.kind === 'answer';
      if ((!answer && dispatch.kind !== 'supplement') || dispatch.accepted === true || dispatch.expired) continue;
      if (store.supplement(dispatch.requestId)) continue;
      // A direct answer has no supplement row: its own dispatch is aged from the
      // caller's original requestedAt, never from the later poll that registered it.
      const answerRow = answer ? (task.answers ?? []).find(entry => entry.answerId === dispatch.requestId
        || (dispatch.answerIds ?? []).some(id => (entry.questionIds ?? []).includes(id))) : undefined;
      const requestedAt = answer
        ? (dispatch.requestedAt ?? answerRow?.created ?? dispatch.startedAt)
        : dispatch.startedAt;
      if (!dispatchExpired(requestedAt)) continue;
      const outcome = await expiredReceipt(record, dispatch);
      if (roundMovedOn(record)) throw dispatchRefused();
      if (outcome === 'accepted') { changed = true; continue; }
      if (answer && outcome === 'unknown') {
        // A write that may have landed is kept as unknown and never replayed.
        if (dispatch.state !== 'unknown' || dispatch.delivery !== 'unknown') {
          Object.assign(dispatch, { state: 'unknown', accepted: false, delivery: 'unknown',
            nextAttemptAt: undefined,
            ...(dispatch.error ? {} : { error: { code: 'answer-outcome-unknown',
              message: 'The native answer write was not proven; it will not be sent again.' } }) });
          changed = true;
        }
        continue;
      }
      expireInput(record, dispatch, undefined, outcome);
      changed = true;
    }
    if (changed) saveDispatch(record);
    return Boolean(task.expired);
  }

  async function pollLocked(record) {
    pollGeneration += 1;
    if (readOnlyTarget(record)) return publicResult(record);
    if (record.state === 'cleaning') {
      const nextAttempt = Math.max(record.nextAttemptAt ?? 0, record.transportNextAttemptAt ?? 0);
      if (nextAttempt > Date.now()) return publicResult(record);
      return clearRecord(record, { autoRetry: record.autoCleanupClosed === true });
    }
    if (record.closed || record.worktreeMerge || record.state === "cleanup_failed") return publicResult(record);
    const route = store.boardRoutes(record.agentId)[0];
    if (route && (route.urgent || record.state === "idle")) {
      try {
        if (await routeBoardLocked(record, route)) return publicResult(record);
      } catch (error) {
        if (record.task?.preemption || !store.stillCurrentTurn(record)) return publicResult(store.get(record.agentId) ?? record);
        throw error;
      }
    }
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
      // The final's own persisted creation+120s is a delivery moment, independent of
      // a business retry stamp. Check it before that stamp can defer the whole name.
      const dueFinal = (task?.reports ?? []).find(report => report.final && !finalReportReady(report)
        && treeReleaseDue(report, task));
      if (dueFinal) {
        releaseDueFinals(record, record.observation ?? {}, record.error?.message);
        store.save(record);
        return await finishReports(record, record.observation ?? {});
      }
      if (!hasWaitingTreeFinal(task)
          && (Math.max(record.nextAttemptAt ?? 0, record.transportNextAttemptAt ?? 0) > Date.now() || firstDispatchDeferred(record))) return publicResult(record);
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
      // Reclassify an old registration failure, or an unknown answer competing with Q,
      // before Q can take the next turn. Only current proof of no write restores priority.
      const hasSupplements = task && store.supplements(record.agentId).length > 0;
      if (task && targetOf(record) === 'codex-desktop' && !task.cancelRequested
          && !(task.reports ?? []).some(report => report.final)) {
        let restored = false;
        for (const dispatch of task.dispatches ?? []) {
          if (dispatch.kind !== 'answer' || dispatch.expired || dispatch.accepted) continue;
          const registrationFailed = dispatch.state === 'failed' && dispatch.error?.code === 'codex-report-not-ready';
          if (!registrationFailed && !(hasSupplements && dispatch.state === 'unknown')) continue;
          const receipt = await (await backendFor(record)).receipt({ requestId: dispatch.requestId, reconcile: false });
          if (receipt?.verifiedNotSent !== true) continue;
          Object.assign(dispatch, { state: 'queued', delivery: 'local-pending' });
          if (registrationFailed) delete dispatch.nextAttemptAt;
          restored = true;
        }
        if (restored) saveDispatch(record);
      }
      if (task?.preemption) return publicResult(record);
      if (route?.urgent && await routeBoardLocked(record, route)) return publicResult(record);
      if (hasSupplements) await drainSupplements(record);
      if (task?.reports?.length) {
        await deliverReports(record);
        const final = task.reports.find(report => report.final && finalReportReady(report));
        if (final && task.result && task.reports.filter(report => report.final).every(report => terminalNotice(report.delivery))
            && (!task.cancelRequested || (task.cancelVerified && task.cancelTreeSettled))) {
          if (isHeadlessCli(targetOf(record))) {
            await observe(record).catch(() => {});
            store.save(record);
          }
          return finishDeliveredReport(record);
        }
      }
      if (!record.created) { await prepare(record); return publicResult(record); }
      if (!task) return publicResult(record);
      if (!task.dispatches.length && !task.cancelRequested && !task.legacyAutomaticResult) {
        await beginTask(record);
        record.nextAttemptAt = undefined; record.retryAttempts = 0;
        if (task.dispatches[0]?.state === 'retrying' && Math.max(task.dispatches[0].nextAttemptAt ?? 0, task.dispatches[0].transportNextAttemptAt ?? 0) > Date.now()) return publicResult(record);
      }
      else await negotiateTree(record);
      for (const answer of task.answers ?? []) {
        if (answer.questionIds || answer.dispatched || task.cancelRequested) continue;
        if (!answer.explicit) recoverLegacyAnswer(record, answer);
        else {
          try { await resolveAnswer(record, answer, { questionIds: answer.questionIdsSeen }); }
          catch (error) { if (!NATIVE_ANSWER_REFUSALS.has(error.code) && !['question-changed', 'question-not-pending'].includes(error.code)) throw error; }
        }
      }
      const view = await observe(record);
      if (!store.stillCurrentTurn(record)) return publicResult(store.get(record.agentId) ?? record);
      const turnBackend = await backendFor(record);
      let turnSnapshot = turnBackend.takeObservedTurnSnapshot?.();
      if (task.cancelRequested && task.cancelVerified && !view.running && treeSettled(record, view)) {
        task.cancelTreeSettled = true;
        task.cancelError = undefined;
        store.save(record);
      }
      // Persist and deliver explicit reports before inspecting older dispatches:
      // an ordinary history/read failure must not suppress an accepted report.
      // A callback, an answer or a cancellation can write after observation. Do not
      // use the earlier native view when any of those paths may have been entered.
      if (task.cancelRequested || task.reports?.length || view.reports?.length
          || (view.questions ?? []).some(question => question.state === 'pending')) turnSnapshot = undefined;
      const reported = await finishReports(record, view);
      if ((task.reports ?? []).some(report => report.final && finalReportReady(report))) return reported;
      // The helper that asked is still working: its answer must not wait for that turn
      // to end, or for a later question, before it is written into the conversation.
      let answerDispatchedThisPoll;
      if (answersMidTurn(record) && !(task.reports ?? []).some(report => report.final)) {
        if ((task.answers ?? []).some(answer => !answer.dispatched && answer.questionIds)) turnSnapshot = undefined;
        answerDispatchedThisPoll = await dispatchAnswers(record, view);
      }
      const unanswered = (view.questions ?? []).filter(question => question.state === 'pending');
      await deliverQuestions(record, unanswered);
      for (const dispatch of task.dispatches) {
        // An answer registered by this poll is recovered by the next poll: its own
        // proven rejection must not be retried before inspect, cancel or expiry can
        // see the queued state. Only this dispatch is skipped for this loop.
        if (dispatch === answerDispatchedThisPoll) continue;
        if (['completed', 'cancelled', 'failed', 'blocked'].includes(dispatch.state)) continue;
        await recoverDispatch(record, dispatch);
        if (['completed', 'cancelled', 'failed', 'blocked'].includes(dispatch.state)) continue;
        if (dispatch.state === 'retrying' && Math.max(dispatch.nextAttemptAt ?? 0, dispatch.transportNextAttemptAt ?? 0) > Date.now()) continue;
        // Every unconfirmed receipt still gets reconciled. A read-only miss leaves
        // the snapshot usable; a state change or attempted native write invalidates it.
        if (turnSnapshot && turnBackend.turnSnapshotValid && !turnBackend.turnSnapshotValid(turnSnapshot)) turnSnapshot = undefined;
        if (!turnSnapshot && turnBackend.captureTurnSnapshot) turnSnapshot = await turnBackend.captureTurnSnapshot();
        const result = await withCodexInstrumentation({ currentStage: 'dispatch-turn', agentId: record.agentId,
          dispatchId: dispatch.requestId }, async () => turnBackend.turn({ requestId: dispatch.requestId,
          ...(turnSnapshot ? { observationSnapshot: turnSnapshot } : {}),
          ...(Number.isSafeInteger(dispatch.afterSeq) ? { afterSeq: dispatch.afterSeq } : {}), timeoutSeconds: 0, maxMessages: 100 }));
        dispatch.afterSeq ??= result.afterSeq;
        if (result.state === 'ended' && (dispatch.accepted || result.correlation === 'request-id')) {
          Object.assign(dispatch, { state: endedState(result.completionReason), accepted: true, error: undefined, nextAttemptAt: undefined, retryAttempts: undefined,
            endSeq: result.endSeq, failure: result.failure ?? modelTurnError(result.completionReason) });
        }
      }
      // A reminder is best-effort: its own dispatch never decides how the task ended,
      // and an undecided outcome for it is not work the task is still waiting on. A
      // reminder that did arrive starts a turn, which view.running already reports.
      if (!store.stillCurrentTurn(record)) return publicResult(store.get(record.agentId) ?? record);
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
      if (await dispatchAnswers(record, view)) return publicResult(record);
      if (route && await routeBoardLocked(record, route)) return publicResult(record);
      if (task.boardOnly && !unanswered.length && !task.cancelRequested && !task.reports?.some(report => report.final)) {
        record.state = "idle";
        task.state = "completed";
        task.finishedAt ??= now();
        store.save(record);
        return publicResult(record);
      }
      if (unanswered.length && !task.cancelRequested) {
        record.state = task.state = 'awaiting_input'; store.save(record); return await finishReports(record, view);
      }
      const finalReport = task.reports.find(report => report.final);
      if (!treeSettled(record, view) && !finalReportReady(finalReport)) {
        waitForTree(record, view);
        return await finishReports(record, view);
      }
      // How the task ended is decided by its own dispatches; the reminder rides along.
      const finalDispatch = task.dispatches.filter(dispatch => !dispatch.reminder).at(-1);
      const terminal = task.cancelRequested || rootSummary(view)?.state === 'cancelled' ? 'cancelled'
        : rootSummary(view)?.state === 'failed' || finalDispatch?.state === 'failed' ? 'failed'
          : finalDispatch?.state === 'cancelled' ? 'cancelled'
            : finalReportReady(finalReport) ? (task.result?.state ?? 'completed') : undefined;
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
      if (!store.stillCurrentTurn(record) || supersededRead(error)) { announceWork(record.agentId); return publicResult(store.get(record.agentId) ?? record); }
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
      else if (targetOf(record) !== 'dsh') {
        if (targetOf(record) === 'codex-desktop' && /^codex-native-rpc-(unavailable|timeout|response-timeout|closed)$/.test(error.code ?? '')) {
          deferTransportRetry(record, error);
        } else deferRetry(record);
      }
      // A final whose bounded release is already due is not held hostage by an
      // unreadable tree. Release it from the last persisted observation, say that
      // the read failed, and let the ordinary delivery path carry the report.
      const released = record.task ? releaseDueFinals(record, record.observation ?? {}, error) : false;
      if (released && record.task) {
        const final = record.task.reports.find(report => report.final);
        if (final && finalReportReady(final)) {
          const outcome = record.task.cancelRequested || record.task.state === 'cancelled' ? 'cancelled'
            : record.error?.terminal === true ? 'failed' : 'completed';
          record.task.result ??= { state: outcome, reply: final.message,
            changes: attributedChanges(record, record.observation), coverage: treeCoverage(record, record.observation),
            tree: publicTree(record, record.observation), ...(final.treeRelease ? { treeRelease: final.treeRelease } : {}) };
          record.task.state = record.task.result.state;
          record.state = 'delivery_pending';
        }
      }
      forgetBackend(record);
      store.save(record);
      if (terminal && record.task && !store.get(record.agentId)?.task?.cancelRequested) {
        try { await notifyFailure(record, 'failed', record.observation ?? {}, undefined); }
        catch { /* the pending failure report is retried by the next scan */ }
      }
      if (missingThread) await drainSubmissions(record, { currentOnly: true });
      if (released) {
        try { await deliverReports(record); } catch { /* the next poll retries the same notice */ }
        const final = record.task?.reports?.find(report => report.final);
        if (final && finalReportReady(final)
            && record.task.reports.filter(report => report.final).every(report => terminalNotice(report.delivery))) {
          return finishDeliveredReport(record);
        }
      }
      return terminal ? afterTerminal(record) : publicResult(record);
    }
  }

  const service = {
    store,
    async transportRecovered(event = {}, pendingIds) {
      if (event.faultSequence < recoveredFaultSequence) return;
      recoveredFaultSequence = Math.max(recoveredFaultSequence, event.faultSequence ?? 0);
      const ids = pendingIds ?? store.transportCandidates();
      const outcomes = await Promise.allSettled(ids.map(id => store.locked(id, async () => {
          const record = store.get(id);
          if (!record || record.closed || record.cleanupRosterTicket) return;
          let changed = clearRecoveredWait(record, ['reconnecting', 'delivery_pending'], event.faultSequence);
          for (const dispatch of record.task?.dispatches ?? []) {
            if (dispatch.accepted || !['retrying', 'unknown', 'sending', 'queued'].includes(dispatch.state)) continue;
            if (clearRecoveredWait(dispatch, ['retrying'], event.faultSequence)) changed = true;
          }
          if (changed) store.save(record);
          announceWork(id);
        }, { waitMs: 0 })));
      const busy = ids.filter((_, index) => outcomes[index].status === 'rejected' && outcomes[index].reason?.code === 'agent-busy');
      if (busy.length) {
        const retry = setTimeout(() => { service.transportRecovered(event, busy).catch(error => process.stderr.write(`[futureaide-monitor] recovery retry: ${error?.stack ?? error}\n`)); }, 500);
        retry.unref?.();
      }
      const unexpected = outcomes.find(result => result.status === 'rejected' &&
        !['agent-busy', 'cleanup-claimed'].includes(result.reason?.code));
      if (unexpected) throw unexpected.reason;
    },
    async status(extra) {
      const retryDeadline = Date.now() + STATUS_RETRY_DEADLINE_MS;
      const status = { toolsLoaded: true, contextVerified: false, dshConnected: false, returnChannel: 'not-checked' };
      let owner;
      try {
        owner = await context(extra);
        Object.assign(status, { contextVerified: true, workspace: owner.workspace, ...await returnChannel(owner),
          agents: typeof store.count === 'function' ? store.count(owner.ownerId) : store.list(owner.ownerId).length });
      } catch (error) { status.contextError = safeError(error); }
      const dshDisabled = Array.isArray(config.disabledTargets) && config.disabledTargets.includes('dsh');
      let client, host;
      if (!dshDisabled) {
        try {
          client = clientFactory(config);
          host = await client.hostStatus();
          status.dshConnected = METHODS.every(method => host.methods?.includes(method));
          status.treeProtocolReady = host.treeProtocol === TREE_PROTOCOL;
          status.reportProtocolReady = host.reportProtocol === REPORT_PROTOCOL;
          if (!status.dshConnected) status.hostError = { message: 'Install the current managed DSH bridge.' };
          else if (!status.treeProtocolReady) status.hostError = safeError(treeProtocolError());
        } catch (error) { status.hostError = safeError(error); }
      }
      status.ready = status.contextVerified && status.returnChannel === 'chat-verified' && status.dshConnected
        && status.treeProtocolReady === true && status.reportProtocolReady === true;
      // Catalog probes do not reserve a name or start a model turn.
      const codexProbe = { agentId: 'agent-status-probe', ownerId: owner?.ownerId ?? 'status', name: 'status-probe',
        lifetime: 'once', target: 'codex-desktop', workspace: owner?.workspace ?? config.workspace,
        state: 'probing', createdAt: now(), updatedAt: now(), history: [] };
      const emptyCatalog = { models: [], defaultModel: null };
      const probeAdapter = (record, probeOptions) => diagnoseTarget(record.target, { adapters: backendAdapters,
        ...(backendAdapterLoader ? { adapterLoader: backendAdapterLoader } : {}), record, deps: adapterDeps(record), config, probeOptions });
      const readCodexStatus = async () => {
        const first = await probeAdapter(codexProbe);
        const remaining = retryDeadline - Date.now();
        if (!isCodexTransientTimeout(first.reason ?? first.modelError) || remaining < CODEX_READ_REPLY_BUDGET_MS) return first;
        let timer;
        try {
          return await Promise.race([probeAdapter(codexProbe, { refreshTimeout: true }), new Promise(resolve => {
            timer = setTimeout(() => resolve(first), remaining);
          })]);
        } finally { clearTimeout(timer); }
      };
      // Locked to the host default, DSH offers callers that one model and nothing else.
      const dshChoices = summary => config.dshDefaultModelOnly !== true ? summary
        : { ...summary, models: summary.defaultModel ? [summary.defaultModel] : [], modelLocked: true };
      const [dshModels, codexEntry, codexCliEntry, claudeEntry, agyEntry] = await Promise.all([
        !dshDisabled && host ? readStatusModels(() => controlFactory(config, { client }).models()).then(dshChoices) : emptyCatalog,
        readCodexStatus(),
        probeAdapter({ ...codexProbe, target: 'codex-cli' }),
        probeAdapter({ ...codexProbe, target: 'claude-cli' }),
        probeAdapter({ ...codexProbe, target: 'agy-cli' }),
      ]);
      status.backends = {
        ...(dshDisabled ? {} : { dsh: { ...dshDiagnostics(host, status), ...dshModels } }),
        'codex-desktop': { ...emptyCatalog, ...codexEntry, ...(codexEntry.ready
          ? { ...codexToolsDiagnostics(await readCodexToolsStatus(codexProbe)), evidence: 'native-rpc' } : {}) },
        'codex-cli': { ...emptyCatalog, ...codexCliEntry },
        'claude-cli': { ...emptyCatalog, ...claudeEntry },
        'agy-cli': { ...emptyCatalog, ...agyEntry },
      };
      if (dshDisabled) {
        delete status.dshConnected;
        status.ready = status.contextVerified && status.returnChannel === 'chat-verified'
          && Boolean(codexCliEntry.ready || claudeEntry.ready || agyEntry.ready || codexEntry.ready);
      }
      return status;
    },
    async create({ name, role, lifetime: rawLifetime, target: rawTarget, model: rawModel, effort: rawEffort, worktree, baseSha, workspaceMode, workspace_mode, proxy, timeoutMinutes, timeoutMs, _revivedSessionId, _revivedFrom, _revivedReadOnlyScout } = {}, extra) {
      const normalizedTimeout = normalizeTurnTimeoutOptions({ timeoutMs, timeoutMinutes });
      const callerHasModelRequest = hasModelRequest({ model: rawModel, effort: rawEffort });
      const {
        explicitRole,
        target,
        model,
        effort,
        lifetime,
        autoFilledModel,
      } = applyCallerDefaults({ role, target: rawTarget, model: rawModel, effort: rawEffort, lifetime: rawLifetime });
      const resolvedWorkspaceMode = workspaceMode ?? workspace_mode ?? (worktree === true ? 'worktree' : worktree === false ? 'inherit' : 'inherit');
      if (!['inherit', 'worktree'].includes(resolvedWorkspaceMode)) {
        throw Object.assign(new Error('workspaceMode must be "inherit" or "worktree".'), { code: 'invalid-workspace-mode' });
      }
      if (baseSha !== undefined && (resolvedWorkspaceMode !== 'worktree' || !fullSha(baseSha))) {
        throw worktreeError('invalid-base-sha', 'baseSha requires a worktree and a full hexadecimal commit SHA.');
      }
      if (!['once', 'persistent'].includes(lifetime)) throw new Error('lifetime must be once or persistent.');
      let normalizedProxyOverride;
      if (proxy !== undefined && proxy !== null && proxy !== '') {
        const proxyStr = typeof proxy === 'string' ? proxy.trim().toLowerCase() : '';
        if (proxyStr !== 'faswitch' && proxyStr !== 'auto') {
          normalizeProxySpec(proxy);
          normalizedProxyOverride = typeof proxy === 'string' && /^\d{1,5}$/.test(proxy.trim())
            ? Number.parseInt(proxy.trim(), 10)
            : proxy;
        }
      }
      const backendTarget = normalizeTarget(target);
      const owner = await context(extra);
      const rootOwnerId = resolveTeamRootOwnerId(owner, extra);
      const caller = effectiveTrustedCaller(extra);
      const parentIdFromCaller = owner.callerAgentId ?? caller?.parentAgentId;
      const parent = parentIdFromCaller
        ? (store.get(parentIdFromCaller) ?? { agentId: parentIdFromCaller })
        : (caller ? undefined : store.agentForCodexThread(callingThread(extra), { includeAutoClosed: true }));

      let chosenName;
      if ((name === undefined || (typeof name === 'string' && !name.trim())) && explicitRole) {
        const teamMembers = visibleRecords(rootOwnerId).all;
        const ownMembers = store.list(owner.ownerId);
        const stubs = store.listAgentStubs(rootOwnerId);
        const usedNames = new Set([
          ...teamMembers.map(r => r.name),
          ...ownMembers.map(r => r.name),
          ...stubs.map(s => s.name),
        ]);
        let seq = 1;
        while (usedNames.has(`${explicitRole}${seq}`)) seq += 1;
        chosenName = assertName(`${explicitRole}${seq}`);
      } else {
        chosenName = assertName(name);
      }
      const resolvedRole = explicitRole ?? inferRoleFromName(chosenName);
      const agentId = uid('agent');
      const baseWorkspace = owner.workspace ?? config.workspace;
      const isolated = resolvedWorkspaceMode === "worktree"
        ? await createWorktree(baseWorkspace, chosenName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, "-")
          + "-" + agentId.slice(6, 14), baseSha) : undefined;
      const rollbackWorktree = () => isolated && withWorktreeLock(isolated.repoRoot,
        () => removeVerifiedWorktree({ ...isolated, rootWorkspace: isolated.repoRoot }));

      const record = {
        agentId,
        ownerId: owner.ownerId,
        sessionId: uid('session-codex'),
        name: chosenName,
        ...(resolvedRole ? { role: resolvedRole } : {}),
        lifetime,
        target: backendTarget,
        workspace: isolated?.workspace ?? baseWorkspace,
        ...(isolated ? { ...isolated, workspaceMode: "worktree", rootWorkspace: isolated.repoRoot } : {}),
        ...(caller?.readOnlyScout === true || _revivedReadOnlyScout === true ? { readOnlyScout: true } : {}),
        ...(_revivedFrom ? { revivedFrom: _revivedFrom } : {}),
        ...(normalizedProxyOverride !== undefined ? { proxyOverride: normalizedProxyOverride } : {}),
        ...(normalizedTimeout.timeoutMs !== undefined ? { turnTimeoutMs: normalizedTimeout.timeoutMs } : {}),
        ...(normalizedTimeout.timeoutMinutes !== undefined ? { turnTimeoutMinutes: normalizedTimeout.timeoutMinutes } : {}),
        state: 'creating',
        createdAt: now(),
        updatedAt: now(),
        history: [],
        ...(parent ? { parentAgentId: parent.agentId } : {}),
      };
      const requireOpenParent = Boolean(parent && store.get(parent.agentId));
      try {
        await ensureTargetBackend(record);
        {
          // Resolve against the live target catalog before the name exists, so a typo
          // creates nothing and a valid pin is part of the first durable record.
          let preview;
          let pinModel = model;
          try {
            preview = await resolveRequestedPin(record, { model, effort });
          } catch (error) {
            if (callerHasModelRequest) throw error;
            if (autoFilledModel && error?.code === 'model-not-found') {
              pinModel = undefined;
              preview = await resolveRequestedPin(record, effort !== undefined ? { effort } : {}).catch(() => undefined);
            } else if (autoFilledModel && error?.code === 'model-catalog-unavailable' && model) {
              preview = {
                provider: modelProviderFor(backendTarget),
                model,
                ...(effort ? { reasoningEffort: effort } : {}),
                requestedEffort: effort ?? null,
                effortSource: effort ? 'role-default' : null,
                selectedEffort: effort ?? null,
              };
            }
          }
          if (preview) record.creationSelection = preview;
          if (preview && pinModel !== undefined && !dshDefaultOnly(record)) record.modelPin = nameModelPin(record, preview);
          if (effort !== undefined) record.pendingEffort = effort;
        }
        store.insert(record, { requireOpenParent });
      } catch (error) {
        await rollbackWorktree();
        throw error;
      }
      if (extra) extra[Symbol.for('futureaide.feedbackDispatchScope')] = { agentId: record.agentId, taskId: null };
      return store.locked(record.agentId, async () => {
        if (!store.get(record.agentId)) throw new Error('This subagent was removed while it was being created.');
        try {
          await prepare(record);
          if (_revivedSessionId && isHeadlessCli(backendTarget)) {
            const currentNative = store.backendState(record.agentId) ?? { seq: 0, requests: {}, answers: {}, answered: [] };
            if (backendTarget === 'codex-cli') {
              store.saveBackendState(record.agentId, { ...currentNative, threadId: _revivedSessionId, started: true });
            } else if (backendTarget === 'claude-cli') {
              store.saveBackendState(record.agentId, { ...currentNative, sessionId: _revivedSessionId, started: true });
            } else if (backendTarget === 'agy-cli') {
              store.saveBackendState(record.agentId, { ...currentNative, conversationId: _revivedSessionId, started: true });
            }
          }
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
    async sendUnkeyed({ name, message, model, effort, mode, timeoutMinutes, timeoutMs }, extra) {
      textMessage(message);
      const normalizedTimeout = normalizeTurnTimeoutOptions({ timeoutMs, timeoutMinutes });
      const requestedMode = normalizeRequestedMode(mode);
      let request = { model, effort };
      let wantsSelection = hasModelRequest(request);
      // A DSH name of an installation locked to the host default takes no selection:
      // the input is sent as if the caller had named no model and no effort.
      const ignoreSelectionFor = record => {
        if (dshDefaultOnly(record) && request.model !== undefined) { request = { ...request, model: undefined }; wantsSelection = hasModelRequest(request); }
      };
      const supplementStates = new Set(['running', 'awaiting_input', 'awaiting_report', 'reconnecting']);
      let enteredOperation = false;
      // What this call means on this target when the caller did not name a mode.
      // A headless CLI supplement is read between turns (= queue); Codex and DSH
      // add an ordinary supplement to the live turn when one is running (= steer).
      const effectiveMode = (record, { answer = false, start = false } = {}) => {
        if (requestedMode) return requestedMode;
        if (answer || start) return 'steer';
        return isHeadlessCli(targetOf(record)) ? 'queue' : 'steer';
      };
      const queued = (record, pin, extraReceipt = {}) => ({
        name: record.name, accepted: false, queued: true, state: record.state,
        requestId: extraReceipt.requestId,
        ...(extraReceipt.taskKey ? { taskKey: extraReceipt.taskKey } : {}),
        mode: extraReceipt.mode ?? 'steer',
        delivery: extraReceipt.delivery ?? 'local-pending',
        ...(extraReceipt.afterTurnId ? { afterTurnId: extraReceipt.afterTurnId } : {}),
        ...(extraReceipt.turnId ? { turnId: extraReceipt.turnId } : {}),
        // The receipt reports the full ID resolved for this input, not a stale
        // display value from before the pin changed.
        ...effortReceipt(pin),
        ...(dshDefaultOnly(record) ? { modelLocked: true } : {}),
        actualModel: actualModelName(pin) ?? actualModelName(record.model),
        ...(record.callbackBlocked ? { callbackError: { code: 'native-callback-unavailable', message: 'The desktop does not permit background reports to this native multi-agent v2 sub-agent.' } } : {}),
      });
      const persistPin = (record, pin) => {
        if (request.model === undefined || dshDefaultOnly(record)) return;
        record.modelPin = { provider: pin.provider, model: pin.model };
        store.save(record);
      };
      const queue = async (record, pin, { usePinnedModel = false, savePin = false,
        requestId = uid('request'), mode, selectionExplicit = false, afterTurnId } = {}) => {
        if (!pin) pin = await resolveRequestedPin(record, request);
        usePinnedModel = false;
        const previous = record.modelPin;
        if (savePin && request.model !== undefined && !dshDefaultOnly(record)) record.modelPin = { provider: pin.provider, model: pin.model };
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
        const taskKey = store.saveTaskKey(record.ownerId, record.agentId, requestId, mode === 'queue' ? null : record.task?.taskId);
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
          { requestId, taskKey, mode: queuedMode, delivery: waitTurnId ? 'after-current' : 'local-pending',
            ...(waitTurnId ? { afterTurnId: waitTurnId } : {}) });
      };
      // The no-wait path is only for a supplement that changes no selection: the
      // INSERT SELECT itself freezes the current pin. An explicit model/effort must
      // take the ordinary 10s lock so a poll cannot save an older body over modelPin.
      const enqueueWithoutWait = async (record, { mode, afterTurnId } = {}) => {
        const fresh = store.get(record.agentId) ?? record;
        return queue(fresh, undefined, { usePinnedModel: true, mode, afterTurnId });
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
          // A final that is still waiting for its tree is still a sealed final. Its
          // own pending submission must not mask the more specific final-report rule.
          throw new Error('The agent has submitted its final report; wait for delivery or explicitly delete the agent.');
        }
        const target = targetOf(record);
        if (record.worktreeMerge) throw worktreeError("worktree-busy", "Finish the worktree merge before assigning another turn.");
        const activeTask = record.task && !stoppedTask && ACTIVE.has(record.state);
        // An input that arrives behind an existing queue takes its place at the tail
        // and never jumps a queued start, even when this caller could write at once.
        const queuedAhead = () => activeTask
          && (store.supplements(record.agentId) ?? []).some(item => item.task === record.task?.taskId && item.status !== 'blocked');
        // Everything that must refuse before touching the name is past. A requested
        // substring is resolved to its real ID before any busy/model decision, so an
        // unknown model still reports the catalog.
        const resolvePin = async (root, view) => {
          const pin = await resolveRequestedPin(record, request);
          if (wantsSelection && target === 'codex-desktop' && activeTask) {
            if (!root || root.known === false) {
              throw Object.assign(new Error('The running turn’s model and reasoning effort could not be confirmed, so this selection was not sent.'),
                { code: 'model-selection-unconfirmed', uncertain: true, terminal: true });
            }
            if (root.running) await assertExplicitSelectionForRunning(record, pin, root);
          }
          return pin;
        };
        if (activeTask) {
          if (normalizedTimeout.timeoutMs !== undefined || normalizedTimeout.timeoutMinutes !== undefined) {
            if (normalizedTimeout.timeoutMs !== undefined) record.task.turnTimeoutMs = normalizedTimeout.timeoutMs;
            if (normalizedTimeout.timeoutMinutes !== undefined) record.task.turnTimeoutMinutes = normalizedTimeout.timeoutMinutes;
            store.save(record);
          }
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
            if (wantsSelection) throw Object.assign(new Error('The running turn selection could not be confirmed; this input was not sent.'),
              { code: 'model-selection-unconfirmed', terminal: true, notSent: true });
            // A root observation failure is not permission to drop the input. An
            // ordinary queue is stored first and reported local-pending; the worker
            // will read the root when it is readable again.
            const pin = await resolveRequestedPin(record, request);
            const mode = effectiveMode(record);
            const receipt = await queue(record, pin, { ...(wantsSelection ? {} : { usePinnedModel: true }),
              mode, selectionExplicit: wantsSelection });
            return supplementReceipt(record, receipt.requestId, { pin, mode, delivery: 'local-pending' });
          }
          if ((view.reports ?? []).some(report => report.final)) throw new Error('The agent has already submitted its final report.');
          const pendingQuestion = pendingIn(view).length > 0 || store.openQuestions(record).unanswered > 0;
          // DSH supports steering only. A native turn that ended in ask_parent still
          // leaves a pending question: that is busy too, and explicit queue must never
          // turn the problem into an answer or a supplement. awaiting_report without a
          // question is idle, so both modes start a new turn there.
          if (target === 'dsh' && requestedMode === 'queue' && (view.running === true || pendingQuestion)) {
            return modeUnsupported(record, 'queue', ['steer']);
          }
          if (isHeadlessCli(target)) {
            if (pendingQuestion) {
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
          if (pendingQuestion) {
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
        if (request.effort === undefined && record.pendingEffort !== undefined && request.model === undefined) {
          request = { ...request, effort: record.pendingEffort };
          wantsSelection = true;
        }
        let pin, pendingSelection;
        try { pin = await resolvePin(undefined, undefined); }
        catch (error) {
          if (!(error?.retryableRead || error?.code === 'agent-busy') || wantsSelection) throw error;
          const behavior = config.behavior ?? config;
          pendingSelection = { input: selectionRequest(request), config: { defaultEffort: behavior.defaultEffort,
            modelDefaultEfforts: { ...(behavior.modelDefaultEfforts ?? {}) } } };
        }
        const snapshot = record.task ? { ...record.task, ...(publicResult(record).error ? { error: publicResult(record).error } : {}),
          changes: attributedChanges(record, record.observation ?? {}),
          coverage: treeCoverage(record, record.observation ?? {}), tree: publicTree(record, record.observation ?? {}) } : undefined;
        // finalReminder marks this task as one that may be reminded once when a turn
        // ends without a final report. Tasks created before this rule carry no marker,
        // so a sleeping awaiting_report from an older version stays quiet.
        // The selected model is frozen with the task: a desktop first dispatch is
        // delayed through the worker queue and must not read a later pin change.
        const requestId = uid('request');
        const archivedUsage = sumTwoUsages(record.historicalUsage, record.task?.usage);
        const next = { ...record, state: 'running', observation: undefined, error: undefined,
          nextAttemptAt: undefined, retryAttempts: 0, sleep: undefined,
          ...(archivedUsage ? { historicalUsage: archivedUsage, usage: archivedUsage } : {}),
          ...(request.model !== undefined && !dshDefaultOnly(record) ? { modelPin: nameModelPin(record, pin) } : {}),
          pendingEffort: undefined,
          // A pin saved before the lock was turned on goes with the next task.
          ...(dshDefaultOnly(record) ? { modelPin: undefined } : {}),
          task: { taskId: uid('task'), requestId, message, mode: requestedMode ?? 'steer',
            state: 'starting', startedAt: now(), dispatches: [], answers: [],
            ...(normalizedTimeout.timeoutMs !== undefined ? { turnTimeoutMs: normalizedTimeout.timeoutMs } : {}),
            ...(normalizedTimeout.timeoutMinutes !== undefined ? { turnTimeoutMinutes: normalizedTimeout.timeoutMinutes } : {}),
            modelSelection: pin ? { ...pin } : null, ...(pendingSelection ? { pendingSelection } : {}), selectionExplicit: wantsSelection, finalReminder: 'armed' } };
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
        if (extra) extra[Symbol.for('futureaide.feedbackDispatchScope')] = { agentId: record.agentId, taskId: record.task.taskId };
        const taskKey = store.saveTaskKey(record.ownerId, record.agentId, requestId, record.task.taskId);
        if (targetOf(record) !== 'dsh') {
          await ensureWorker(record, { wake: true });
          return { ...queued(record, pin, { requestId, taskKey, mode: effectiveMode(record, { start: true }),
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
          requestId, taskKey, mode: effectiveMode(record, { start: true }), delivery: dispatch?.delivery,
          ...(dispatch?.turnId ? { turnId: dispatch.turnId } : {}),
          ...(dispatch?.afterTurnId ? { afterTurnId: dispatch.afterTurnId } : {}),
          ...effortReceipt(dispatch?.model, dispatch?.actualEffort, dispatch?.effortAdjustment, dispatch?.actualEffortSource),
          ...(dshDefaultOnly(record) ? { modelLocked: true } : {}),
          actualModel: dispatch && Object.hasOwn(dispatch, 'actualModel') ? actualModelName(dispatch.actualModel)
            : actualModelName(current.model) ?? actualModelName(current.modelPin),
          ...(dispatch?.state === 'retrying' ? { retrying: true } : {}),
          ...(previousReport ? { previousReport } : {}),
          ...(error ? { error } : {}),
          ...(current.callbackBlocked ? { callbackError: { code: 'native-callback-unavailable', message: 'The desktop does not permit background reports to this native multi-agent v2 sub-agent.' } } : {}) };
      };
      try { return await withName(extra, name, operation, { waitMs: 0 }); } catch (error) {
        if (enteredOperation || error.code !== 'agent-busy') throw error;
        const owner = await context(extra);
        const record = requireWritableTarget(named(owner, name, extra));
        ignoreSelectionFor(record);
        const target = targetOf(record);
        const activeTask = record.task && !terminalRound(record) && ACTIVE.has(record.state);
        // Capability refusals do not wait for the name lock: they never write.
        if (activeTask && target === 'dsh' && effectiveMode(record) === 'queue') {
          return modeUnsupported(record, 'queue', ['steer']);
        }
        if (activeTask && isHeadlessCli(target) && effectiveMode(record) === 'steer') {
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
    async send(args, extra) {
      const result = await service.sendUnkeyed(args, extra);
      if (result.requestId && !result.taskKey) throw Object.assign(new Error('The original dispatch receipt is unavailable.'), { code: 'task-receipt-unavailable' });
      return result;
    },

    /**
     * Create the name if it is new and send the task, in one call. An existing name
     * keeps its own application and lifetime, so a conflicting explicit value is
     * refused instead of quietly running the task on the wrong backend.
     */
    async run({ tasks, name, role, message, lifetime: rawLifetime, target: rawTarget, model: rawModel, effort: rawEffort, mode, worktree, baseSha, workspaceMode, workspace_mode, proxy, timeoutMinutes, timeoutMs } = {}, extra) {
      if (tasks !== undefined) {
        if (!Array.isArray(tasks) || tasks.length === 0) {
          throw Object.assign(new Error('tasks must be a non-empty array of task items.'), { code: 'invalid-arguments' });
        }
        const owner = await context(extra);
        const rootOwnerId = resolveTeamRootOwnerId(owner, extra);
        const teamMembers = visibleRecords(rootOwnerId).all;
        const ownMembers = store.list(owner.ownerId);
        const stubs = store.listAgentStubs(rootOwnerId);
        const usedNames = new Set([
          ...teamMembers.map(r => r.name),
          ...ownMembers.map(r => r.name),
          ...stubs.map(s => s.name),
        ]);
        const shared = { role, lifetime: rawLifetime, target: rawTarget, model: rawModel, effort: rawEffort,
          mode, worktree, baseSha, workspaceMode, workspace_mode, proxy, timeoutMinutes, timeoutMs };
        const prepared = tasks.map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw Object.assign(new Error('Each entry in tasks must be an object.'), { code: 'invalid-arguments' });
          }
          const spec = mergeRunTaskDefaults(shared, item);
          textMessage(spec.message);
          const itemRole = normalizeRole(spec.role, { teamConfigPath });
          let assignedName;
          if (typeof item.name === 'string' && item.name.trim()) {
            assignedName = assertName(item.name);
            usedNames.add(assignedName);
          } else if (item.name !== undefined && item.name !== '') {
            assignedName = assertName(item.name);
            usedNames.add(assignedName);
          } else if (itemRole) {
            let seq = 1;
            while (usedNames.has(`${itemRole}${seq}`)) seq += 1;
            assignedName = assertName(`${itemRole}${seq}`);
            usedNames.add(assignedName);
          } else {
            for (let attempt = 0; attempt < 20 && assignedName === undefined; attempt++) {
              const candidate = `助手-${randomUUID().replaceAll('-', '').slice(0, 4)}`;
              if (!usedNames.has(candidate)) assignedName = candidate;
            }
            if (!assignedName) throw new Error('Could not generate an unused subagent name; pass one explicitly.');
            usedNames.add(assignedName);
          }
          if (spec.baseSha !== undefined && (spec.workspaceMode !== "worktree" || !fullSha(spec.baseSha))) {
            throw worktreeError("invalid-base-sha", "baseSha requires a worktree and a full hexadecimal commit SHA.");
          }
          return { ...spec, name: assignedName, role: itemRole };
        });
        const items = await Promise.all(prepared.map(spec => service.run(spec, extra)));
        const taskKeys = items.map(entry => entry?.taskKey).filter(Boolean);
        const wakeCmd = buildWakeCmd(owner, taskKeys, { batch: true });
        return {
          batch: true,
          items,
          taskKeys,
          ...(wakeCmd ? { wakeCmd } : {}),
        };
      }

      textMessage(message);
      const requestedMode = normalizeRequestedMode(mode);
      const {
        explicitRole,
        target,
        lifetime: effectiveLifetime,
      } = applyCallerDefaults({ role, target: rawTarget, model: rawModel, effort: rawEffort, lifetime: rawLifetime });
      const owner = await context(extra);
      const wanted = normalizeTarget(target);
      const createdLifetime = effectiveLifetime ?? 'once';
      if (!['once', 'persistent'].includes(createdLifetime)) throw new Error('lifetime must be once or persistent.');
      const effectiveWorkspaceMode = workspaceMode ?? workspace_mode ?? (worktree === true ? 'worktree' : worktree === false ? 'inherit' : undefined);
      if (baseSha !== undefined && (effectiveWorkspaceMode !== "worktree" || !fullSha(baseSha))) {
        throw worktreeError("invalid-base-sha", "baseSha requires a worktree and a full hexadecimal commit SHA.");
      }
      const sent = result => ({ state: result.state, accepted: result.accepted === true,
        ...(result.requestId ? { requestId: result.requestId } : {}),
        ...(result.taskKey ? { taskKey: result.taskKey } : {}),
        ...(result.mode ? { mode: result.mode } : {}),
        ...(Object.hasOwn(result, 'delivery') ? { delivery: result.delivery } : {}),
        ...(result.turnId ? { turnId: result.turnId } : {}),
        ...(result.afterTurnId ? { afterTurnId: result.afterTurnId } : {}),
        actualModel: result.actualModel ?? null,
        ...effortReceipt(result, result.actualEffort ?? null, result.effortAdjustment, result.actualEffortSource),
        ...(result.modelLocked ? { modelLocked: true } : {}),
        ...(result.queued !== undefined ? { queued: result.queued === true } : {}), ...(result.retrying ? { retrying: true } : {}),
        ...(result.callbackError ? { callbackError: result.callbackError } : {}), ...(result.error ? { error: result.error } : {}) });
      const trimmedName = typeof name === 'string' && name.trim() ? assertName(name) : (name !== undefined && name !== '' ? assertName(name) : undefined);
      let existing;
      if (trimmedName !== undefined) {
        try { existing = named(owner, trimmedName, extra); }
        catch (error) { if (error.code !== "agent-not-found") throw error; }
      }
      if (existing?.worktreeMerge) throw worktreeError("worktree-busy", "Finish the worktree merge before assigning another turn.");
      if (existing) {
        // send only says "closing, blocked or not ready"; a caller that picked this
        // name needs to know the name is on its way out rather than misbound.
        if (existing.closed || ['cleaning', 'cleanup_failed'].includes(existing.state)) {
          throw Object.assign(new Error(`The name “${existing.name}” is still being cleaned up. Wait until it leaves list, or use another name.`),
            { code: 'name-closing' });
        }
        const boundTarget = targetOf(existing);
        const rawWanted = rawTarget !== undefined ? normalizeTarget(rawTarget) : undefined;
        if (rawWanted !== undefined && rawWanted !== boundTarget) throw Object.assign(new Error(`The name “${existing.name}” is already bound to ${hostLabel(existing)}; it cannot run on ${TARGET_LABELS[rawWanted]}. Omit target to continue this name, or use another name.`), { code: 'target-conflict' });
        if (baseSha !== undefined && existing.worktreeBaseHead?.toLowerCase() !== baseSha.toLowerCase()) {
          throw worktreeError("worktree-base-conflict", "An existing name cannot change its worktree base.");
        }
        if (rawLifetime !== undefined && rawLifetime !== existing.lifetime) throw Object.assign(new Error(`The name “${existing.name}” is already a ${existing.lifetime} subagent; omit lifetime, pass ${existing.lifetime}, or use another name.`), { code: 'lifetime-conflict' });
        if (explicitRole && !existing.role) { existing.role = explicitRole; store.save(existing); }
        const result = await service.send({ name: trimmedName, message, model: rawModel, effort: rawEffort, mode: requestedMode, timeoutMinutes, timeoutMs }, extra);
        const wakeCmd = buildWakeCmd(owner, result.taskKey);
        return {
          name: existing.name,
          ...(existing.role ? { role: existing.role } : {}),
          lifetime: existing.lifetime,
          ...(boundTarget !== 'dsh' ? { target: boundTarget } : {}),
          ...sent(result),
          ...(wakeCmd ? { wakeCmd } : {}),
          reused: true,
        };
      }
      let chosen = trimmedName;
      if (chosen === undefined && !explicitRole) {
        for (let attempt = 0; attempt < 5 && chosen === undefined; attempt++) {
          const candidate = `助手-${randomUUID().replaceAll('-', '').slice(0, 4)}`;
          if (!store.named(owner.ownerId, candidate)) chosen = candidate;
        }
        if (chosen === undefined) throw new Error('Could not generate an unused subagent name; pass one explicitly.');
      }
      const created = await service.create({
        ...(chosen !== undefined ? { name: chosen } : {}),
        ...(explicitRole ? { role: explicitRole } : {}),
        ...(rawLifetime !== undefined ? { lifetime: rawLifetime } : (!explicitRole ? { lifetime: createdLifetime } : {})),
        ...(rawTarget !== undefined ? { target: rawTarget } : (!explicitRole ? { target: wanted } : {})),
        model: rawModel,
        effort: rawEffort,
        workspaceMode: effectiveWorkspaceMode,
        baseSha,
        proxy,
        timeoutMinutes,
        timeoutMs,
      }, extra);
      // A failed creation keeps its own receipt: sending into a name that never
      // connected would report a delivery nobody is waiting for.
      if (created.created !== true || created.error) return created;
      const finalName = created.name;
      try {
        const result = await service.send({ name: finalName, message, model: rawModel, effort: rawEffort, mode: requestedMode, timeoutMinutes, timeoutMs }, extra);
        const wakeCmd = buildWakeCmd(owner, result.taskKey);
        return {
          name: finalName,
          ...(created.role ? { role: created.role } : {}),
          ...(created.workspaceMode ? { workspaceMode: created.workspaceMode } : {}),
          lifetime: created.lifetime ?? createdLifetime,
          ...(wanted !== 'dsh' ? { target: wanted } : {}),
          ...sent(result),
          ...(wakeCmd ? { wakeCmd } : {}),
          created: true,
        };
      } catch (error) {
        // The name exists now, so a thrown send would hide the name the caller must
        // use to continue; report the created name with the failure instead.
        const current = store.named(owner.ownerId, finalName);
        return {
          name: finalName,
          ...(current?.role ?? created.role ? { role: current?.role ?? created.role } : {}),
          lifetime: created.lifetime ?? createdLifetime,
          ...(wanted !== 'dsh' ? { target: wanted } : {}),
          created: true, state: current?.state ?? 'reconnecting', accepted: false,
          actualModel: actualModelName(current?.model) ?? actualModelName(current?.modelPin), error: safeError(error),
        };
      }
    },
    async answer({ name, message, questionId, question_id: wireQuestionId, questionIds, answerId } = {}, extra) {
      textMessage(message);
      const single = questionId !== undefined ? questionId : wireQuestionId;
      const ids = single !== undefined ? [single] : questionIds;
      if ((questionId !== undefined && wireQuestionId !== undefined) || (single !== undefined && questionIds !== undefined)
          || (ids !== undefined && (!Array.isArray(ids) || !ids.length
            || ids.some(id => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length))
          || (answerId !== undefined && (typeof answerId !== "string" || !answerId.trim()))) {
        throw Object.assign(new Error("Choose one question ID or a nonempty array of unique question IDs."), { code: "invalid-question-selection" });
      }
      return withName(extra, name, async record => {
        requireWritableTarget(record);
        const selection = await resolveRequestedPin(record, {});
        return answerLocked(record, message, answerId, { questionIds: ids, modelSelection: selection });
      });
    },
    async list(extra, { scope = 'team', name: filterName, role: filterRole, state: filterState } = {}) {
      if (!['team', 'agent', 'all'].includes(scope)) {
        throw Object.assign(new Error('scope must be "team", "agent", or "all".'), { code: 'invalid-scope' });
      }
      const owner = await context(extra);
      const rootOwnerId = resolveTeamRootOwnerId(owner, extra);
      if (scope === 'all' && effectiveTrustedCaller(extra)?.source === 'managed-cli') scope = 'team';
      const wantedName = filterName === undefined ? undefined : assertName(filterName);
      const wantedRole = normalizeRole(filterRole);
      if (filterState !== undefined && (typeof filterState !== 'string' || !filterState
          || filterState !== filterState.trim() || filterState.length > 64)) {
        throw new Error('Use a nonempty lifecycle state of at most 64 characters, without leading/trailing whitespace.');
      }
      const wantedState = filterState;

      const isStaleIdle = (record, nowMs = Date.now()) => {
        if (!record || record.state !== 'idle') return false;
        if ((record.observation?.questions ?? []).some(q => q.state === 'pending')) return false;
        if ((record.task?.reports ?? []).some(r => !terminalNotice(r.delivery) && r.delivery?.state !== 'delivered')) return false;
        if (store.submissionDebt(record.agentId) > 0) return false;
        if (store.childrenOf(record.agentId).some(c => !c.closed && !INACTIVE_STATES.has(c.state))) return false;
        const refTime = Date.parse(record.task?.finishedAt ?? record.updatedAt ?? record.createdAt ?? '');
        return Number.isFinite(refTime) && nowMs - refTime > STALE_IDLE_MS;
      };

      const decorateRecord = (record, runningMonitor) => {
        const base = publicResult(record);
        const pathStr = managedPath(record);
        const segments = pathStr.split('/');
        const parentRec = record.parentAgentId ? store.get(record.parentAgentId) : undefined;
        const resolvedRole = record.role ?? inferRoleFromName(record.name) ?? null;
        const unabsorbed = readParentSubmissions(record);
        const mergedQuestions = [...base.questions];
        for (const q of unabsorbed.questions) {
          if (!mergedQuestions.some(existing => existing.message === q.message)) {
            mergedQuestions.push({ message: q.message });
          }
        }
        return {
          ...base,
          role: resolvedRole,
          agentPath: pathStr,
          parentName: parentRec?.name ?? (segments.length > 1 ? segments.at(-2) : null),
          parentAgentId: record.parentAgentId ?? null,
          depth: segments.length - 1,
          questions: mergedQuestions,
          monitor: record.sleep ? (record.sleep.wakePending ? 'waking' : 'sleeping')
            : (runningMonitor ? 'running' : 'stopped'),
          supplements: store.supplementSummary(record.agentId, record.task?.taskId ?? ''),
        };
      };

      if (scope === 'agent') {
        if (wantedName === undefined) {
          throw Object.assign(new Error('scope="agent" requires name.'), { code: 'name-required' });
        }
        const teamAll = permittedRecords(owner, extra);
        const byPath = teamAll.filter(r => managedPath(r) === wantedName);
        let chosenRecord = byPath[0];
        if (!chosenRecord) {
          const byShort = teamAll.filter(r => r.name === wantedName);
          if (byShort.length === 1) chosenRecord = byShort[0];
          else if (byShort.length > 1) {
            const activeMatches = byShort.filter(r => !r.closed && !INACTIVE_STATES.has(r.state));
            if (activeMatches.length === 1) chosenRecord = activeMatches[0];
            else {
              const paths = (activeMatches.length > 1 ? activeMatches : byShort).map(r => managedPath(r));
              throw Object.assign(new Error(`“${wantedName}” matches multiple members: ${paths.join(', ')}. Specify the full path.`), { code: 'node-ambiguous', paths });
            }
          }
        }
        if (!chosenRecord) {
          const candidate = store.getAgentStub(rootOwnerId, wantedName);
          const stub = canAccessMember(owner, extra, candidate) ? candidate : undefined;
          if (stub) {
            const stubDetail = {
              name: stub.name,
              role: stub.role ?? inferRoleFromName(stub.name) ?? null,
              agentPath: stub.agentPath,
              parentName: stub.agentPath.includes('/') ? stub.agentPath.split('/').at(-2) : null,
              parentAgentId: stub.parentAgentId,
              depth: stub.agentPath.split('/').length - 1,
              target: stub.target,
              lifetime: 'once',
              state: 'archived_stub',
              resumable: Boolean(stub.resumeSessionId),
              actualModel: stub.model,
              task: stub.lastTaskSummary ? { text: stub.lastTaskSummary, state: 'completed', finishedAt: stub.closedAt } : null,
              questions: [],
              changes: { count: 0, unconfirmed: 0, files: [] },
              reports: { total: 0, pending: 0, latest: null, items: [] },
              children: [],
            };
            return { scope: 'agent', ownerId: rootOwnerId, agent: stubDetail, items: [stubDetail], total: 1 };
          }
          throw Object.assign(new Error(`No subagent named “${wantedName}” exists in this team.`), { code: 'agent-not-found' });
        }

        const full = publicResult(chosenRecord, { fullResult: true });
        const unabsorbed = readParentSubmissions(chosenRecord);
        const openQuestions = [
          ...(chosenRecord.observation?.questions ?? []).filter(q => q.state === 'pending').map(q => ({
            id: q.id, message: q.message, state: 'pending', ...(q.createdAt ? { createdAt: q.createdAt } : {}),
          })),
        ];
        for (const q of unabsorbed.questions) {
          if (!openQuestions.some(existing => existing.id === q.id)) openQuestions.push(q);
        }
        const explicitReports = [...(chosenRecord.task?.reports ?? []).filter(r => !r.failure)];
        for (const r of unabsorbed.reports) {
          if (!explicitReports.some(existing => sameReportId(existing.id, r.id))) {
            explicitReports.push({ id: r.id, message: r.message, final: r.final, createdAt: r.createdAt, delivery: { state: 'pull_ready' } });
          }
        }
        const latestRep = explicitReports.at(-1);
        const allChangedFiles = attributedChanges(chosenRecord, chosenRecord.observation ?? {});
        const directChildren = store.childrenOf(chosenRecord.agentId).map(c => ({
          name: c.name,
          role: c.role ?? inferRoleFromName(c.name) ?? null,
          agentPath: managedPath(c),
          target: targetOf(c),
          state: c.state,
        }));
        const running = !chosenRecord.sleep
          && await monitorAlive(store, Date.now(), { idleSessionCleanup: config.idleSessionCleanup !== false });
        const decorated = decorateRecord(chosenRecord, running);
        const agentDetail = {
          ...decorated,
          task: chosenRecord.task ? {
            text: chosenRecord.task.message,
            message: chosenRecord.task.message,
            state: chosenRecord.task.state,
            startedAt: chosenRecord.task.startedAt,
            ...(chosenRecord.task.finishedAt ? { finishedAt: chosenRecord.task.finishedAt } : {}),
            ...(chosenRecord.task.usage ? { usage: chosenRecord.task.usage } : {}),
          } : null,
          questions: openQuestions,
          changes: {
            count: allChangedFiles.length,
            unconfirmed: allChangedFiles.filter(f => f.attribution === 'unconfirmed').length,
            files: allChangedFiles.map(fileSummary),
            coverage: full.changes.coverage,
          },
          reports: {
            total: explicitReports.length,
            pending: explicitReports.filter(r => !terminalNotice(r.delivery)).length,
            latest: latestRep ? {
              id: latestRep.id,
              message: latestRep.message,
              summary: compactText(latestRep.message, 240),
              final: latestRep.final === true,
              delivery: latestRep.delivery?.state ?? 'pending',
              ...(latestRep.createdAt ? { createdAt: latestRep.createdAt } : {}),
            } : null,
            items: explicitReports.map(r => ({
              id: r.id,
              message: r.message,
              final: r.final === true,
              delivery: r.delivery?.state ?? 'pending',
              ...(r.createdAt ? { createdAt: r.createdAt } : {}),
            })),
          },
          children: directChildren,
        };
        return { scope: 'agent', ownerId: rootOwnerId, agent: agentDetail, items: [agentDetail], total: 1 };
      }

      if (scope === 'all') {
        const nowMs = Date.now();
        let allRecords = store.list();
        if (wantedName !== undefined) {
          allRecords = allRecords.filter(r => r.name === wantedName || managedPath(r) === wantedName);
        }
        if (wantedRole !== undefined) {
          allRecords = allRecords.filter(r => (r.role ?? inferRoleFromName(r.name)) === wantedRole);
        }
        if (wantedState !== undefined) {
          allRecords = allRecords.filter(r => wantedState === 'active'
            ? !INACTIVE_STATES.has(r.state) : r.state === wantedState);
        } else if (wantedName === undefined) {
          allRecords = allRecords.filter(r => !r.closed && !INACTIVE_STATES.has(r.state) && !isStaleIdle(r, nowMs));
        }
        const running = allRecords.some(record => !record.sleep)
          && await monitorAlive(store, nowMs, { idleSessionCleanup: config.idleSessionCleanup !== false });
        const byRoot = new Map();
        const allItems = [];
        for (const record of allRecords) {
          const teamOwnerId = rootOwnerIdForRecord(record);
          const item = decorateRecord(record, running);
          allItems.push(item);
          let bucket = byRoot.get(teamOwnerId);
          if (!bucket) {
            bucket = [];
            byRoot.set(teamOwnerId, bucket);
          }
          bucket.push(item);
        }
        const teams = [];
        for (const [teamOwnerId, members] of byRoot.entries()) {
          const teamOwner = store.owner(teamOwnerId);
          const hasHierarchy = members.some(m => Boolean(m.parentAgentId) || m.depth > 0 || (m.tree?.nodes?.length ?? 0) > 1);
          const pendingQuestions = members.reduce((sum, m) => sum + (m.questions?.length ?? 0), 0);
          teams.push({
            ownerId: teamOwnerId,
            source: teamOwner?.source ?? 'unknown',
            workspace: teamOwner?.workspace ?? store.get(members[0]?.agentId)?.workspace ?? null,
            hasHierarchy,
            memberCount: members.length,
            pendingQuestions,
            members,
          });
        }
        return { scope: 'all', teams, groups: teams, items: allItems, total: allItems.length };
      }

      // Default: scope === 'team' — whole team tree under this root owner.
      const teamAll = permittedRecords(owner, extra);
      const nowMs = Date.now();
      let selected = teamAll;
      if (wantedName !== undefined) {
        selected = selected.filter(r => r.name === wantedName || managedPath(r) === wantedName);
      }
      if (wantedRole !== undefined) {
        selected = selected.filter(r => (r.role ?? inferRoleFromName(r.name)) === wantedRole);
      }
      if (wantedState !== undefined) {
        selected = selected.filter(r => wantedState === 'active'
          ? !INACTIVE_STATES.has(r.state) : r.state === wantedState);
      } else if (wantedName === undefined) {
        selected = selected.filter(r => !INACTIVE_STATES.has(r.state) && !isStaleIdle(r, nowMs));
      }
      const selectedIds = selected.map(r => r.agentId);
      let ensured;
      const ensure = () => ensured ??= ensureMonitor();
      for (const record of selected) await ensureWorker(record, { ensure });
      const current = selectedIds.map(id => store.get(id)).filter(Boolean);
      const running = current.some(record => !record.sleep)
        && await monitorAlive(store, Date.now(), { idleSessionCleanup: config.idleSessionCleanup !== false });
      const items = current.map(record => decorateRecord(record, running));
      const hasHierarchy = teamAll.some(r => Boolean(r.parentAgentId) || (r.observation?.tree?.nodes?.length ?? 0) > 1);
      return { scope: 'team', ownerId: rootOwnerId, hasHierarchy, items, total: items.length };
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
      const record = requireWritableTarget(named(owner, name, extra));
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
    async delete({ name, discardWorktree, discard_worktree } = {}, extra) {
      const owner = await context(extra);
      const record = requireWritableTarget(named(owner, name, extra));
      const discard = discardWorktree === true || discard_worktree === true;
      const proof = await cleanupProof(record, { discardWorktree: discard });
      if (proof.error) return { name, deleted: false, state: record.state, error: proof.error };
      if (targetOf(record) === 'dsh') {
        const result = await withName(extra, name, current => clearRecord(current, { discardWorktree: discard }));
        if (result.queued) await ensureWorker(store.get(record.agentId), { wake: true });
        return result;
      }
      const queued = store.requestCleanup(record, proof.verified, { discardWorktree: discard });
      if (queued) await ensureWorker(store.get(record.agentId), { wake: true });
      const current = queued ? undefined : store.get(record.agentId);
      return { name, deleted: false, queued, state: queued ? 'cleaning' : current?.cleanupRosterTicket ? 'cleanup-claimed' : 'removed',
        ...(isHeadlessCli(targetOf(record)) ? { nativeHistoryPolicy: 'retain' } : {}) };
    },
    /**
     * Explicit ask/report from a managed Codex Desktop child, called from that
     * child's own chat. The caller is found from its chat metadata (never a tool
     * argument) through the binding its backend recorded, and the submission joins
     * the same task so the one state machine delivers it to the parent.
     */
    feedbackScope(tool, args, extra) {
      const caller = effectiveTrustedCaller(extra);
      if (tool === 'feedback' || tool === 'report_parent' || tool === 'ask_parent') {
        if (caller) return '';
        const bound = store.agentForCodexThread(callingThread(extra));
        const record = bound && store.get(bound.agentId);
        return record ? [record.agentId, record.task?.taskId ?? ''].join(':') : '';
      }
      if (!args?.name) return '';
      const callerKey = caller?.source === 'antigravity' ? (caller.conversationId ?? caller.nativeSessionId) : caller?.nativeSessionId;
      const ownerId = caller ? ownerIdForSource(caller.source, callerKey) : ownerIdFor(callingThread(extra));
      const record = store.named(ownerId, args.name);
      return record ? [record.agentId, record.task?.taskId ?? ''].join(':') : 'unbound';
    },
    async submitCallerFeedback({ name, ...input }, extra, error, deadline) {
      const caller = effectiveTrustedCaller(extra);
      const callerKey = caller?.source === 'antigravity' ? (caller.conversationId ?? caller.nativeSessionId) : caller?.nativeSessionId;
      const ownerId = caller ? ownerIdForSource(caller.source, callerKey) : ownerIdFor(callingThread(extra));
      const record = name ? store.named(ownerId, name) : null;
      return submitFeedback(input, {
        source: caller?.source ?? 'codex-desktop',
        caller: caller?.source ?? 'codex-desktop',
        target: name ? (record ? targetOf(record) : null) : 'plugin',
        name: record?.name ?? null,
        error: feedbackRecordError(record, error),
      }, { configFile: config.configFile, deadline });
    },
    async submitManagedFeedback(input, extra, error, deadline) {
      const bound = store.agentForCodexThread(callingThread(extra));
      const record = bound && store.get(bound.agentId);
      if (!record || record.closed || !record.task || ['idle', 'failed'].includes(record.state)
          || isCancelledRound(record) || record.task.reports?.some(report => report.final)
          || store.submissions(record.agentId, record.task.taskId).some(report => report.final)) {
        throw Object.assign(new Error('This caller has no active managed task.'), { code: 'submission-not-owned' });
      }
      const currentError = error && record.task.startedAt && Date.parse(error.at) >= Date.parse(record.task.startedAt)
        ? error : null;
      return submitFeedback(input, {
        source: 'codex-desktop',
        caller: store.owner(record.ownerId)?.source ?? null,
        target: 'codex-desktop',
        name: record.name ?? null,
        error: feedbackRecordError(record, currentError),
      }, { configFile: config.configFile, deadline });
    },
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
    async wait({ names, taskKeys, after, timeoutSeconds, barrier = 'any', allowExtendedTimeout = false } = {}, extra) {
      const maxTimeout = allowExtendedTimeout === true ? 86400 : 45;
      if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > maxTimeout)) {
        throw new Error(allowExtendedTimeout === true ? `Wait between 0 and ${maxTimeout} seconds.` : 'Wait between 0 and 45 seconds.');
      }
      if (!['any', 'all'].includes(barrier)) {
        throw Object.assign(new Error('barrier must be "any" or "all".'), { code: 'invalid-barrier' });
      }
      if (names && taskKeys) throw new Error('Use names or taskKeys, not both.');
      const owner = await context(extra);
      const rootOwnerId = resolveTeamRootOwnerId(owner, extra);
      if (names) names.forEach(assertName);
      if (taskKeys && (!Array.isArray(taskKeys) || taskKeys.some(key => typeof key !== 'string'))) throw new Error('taskKeys must be an array of task keys.');
      const available = taskKeys ? [] : permittedRecords(owner, extra);
      const matchesWaitName = (record, wanted) => record.name === wanted || managedPath(record) === wanted;
      const selected = available.filter(record => !names || names.some(wanted => matchesWaitName(record, wanted)));
      const notListed = new Set((names ?? []).filter(name => !available.some(record => matchesWaitName(record, name))));
      // Legacy name snapshots retain their old bounded state-query behaviour.
      if (timeoutSeconds !== undefined && taskKeys === undefined && after === undefined && barrier === 'any' && !allowExtendedTimeout) {
        const selectedIds = selected.map(record => record.agentId);
        const deadline = Date.now() + timeoutSeconds * 1000;
        let items;
        do {
          items = [];
          for (const id of selectedIds) {
            const record = store.get(id);
            if (!record) { notListed.add(selected.find(item => item.agentId === id).name); continue; }
            const taskKey = record.task?.requestId
              ? store.taskKeyForRequest(record.ownerId, record.task.requestId)
                ?? store.saveTaskKey(record.ownerId, record.agentId, record.task.requestId, record.task.taskId)
              : undefined;
            items.push(waitItem(record, taskKey, storedBodyText(store, record, taskKey)));
          }
          if (!selectedIds.length || notListed.size || items.some(item => item.error ||
              ['awaiting_input', 'awaiting_report', 'cancelled', 'idle', 'delivery_pending', 'cleanup_failed', 'failed'].includes(item.state))) break;
          if (Date.now() >= deadline) break;
          if (extra?.signal?.aborted) throw extra.signal.reason ?? new DOMException('Aborted', 'AbortError');
          await new Promise((resolve, reject) => {
            const signal = extra?.signal;
            const timer = setTimeout(done, Math.min(250, deadline - Date.now()));
            function done() { signal?.removeEventListener('abort', aborted); resolve(); }
            function aborted() { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); }
            signal?.addEventListener('abort', aborted, { once: true });
          });
        } while (true);
        return { items, notListed: [...notListed],
          ...(notListed.size ? { note: 'These names are not in this chat’s current list. Absence alone does not prove task completion; use the delivered result.' } : {}),
          timedOut: Date.now() >= deadline && items.some(item => item.state === 'running') };
      }
      const keys = taskKeys ?? selected.filter(record => record.task?.requestId).map(record =>
        store.taskKeyForRequest(record.ownerId, record.task.requestId)
        ?? store.saveTaskKey(record.ownerId, record.agentId, record.task.requestId, record.task.taskId));
      const selection = [...new Set(keys)].sort();
      const selectionHash = createHash('sha256').update(JSON.stringify([owner.ownerId, selection])).digest('base64url');
      const keyIndexes = new Map(selection.map((key, index) => [key, String(index)]));
      let positions = {};
      if (after !== undefined) {
        try {
          const parsed = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
          if (parsed.selection !== selectionHash || !parsed.positions || typeof parsed.positions !== 'object'
              || Array.isArray(parsed.positions)) throw new Error();
          positions = parsed.positions;
        } catch {
          throw Object.assign(new Error('The wait cursor does not match this owner and task selection.'), { code: 'invalid-cursor' });
        }
      }
      const cursor = value => Buffer.from(JSON.stringify({ selection: selectionHash, positions: value ?? positions })).toString('base64url');
      const deadline = timeoutSeconds === undefined ? Infinity : Date.now() + timeoutSeconds * 1000;
      const signal = extra?.signal;
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      let timer, wake;
      let pending = new Promise(resolve => { wake = resolve; });
      const notify = () => { const resolve = wake; pending = new Promise(next => { wake = next; }); resolve(); };
      const unsubscribe = subscribeWait(notify);
      signal?.addEventListener('abort', notify, { once: true });
      try {
        while (true) {
          if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
          if (waitsClosed) throw Object.assign(new Error('The service closed while waiting.'), { code: 'transport-lost' });
          const events = [], items = [], initialPositions = new Map(), keySettled = new Map(), pullDeliveries = [];
          for (const key of selection) {
            const cursorIndex = keyIndexes.get(key);
            let mapping = store.resolveTaskKey(owner.ownerId, key);
            if (!mapping) {
              const cross = store.resolveTaskKeyAnyOwner(key);
              const crossRec = cross ? store.get(cross.agentId) : undefined;
              if (cross && crossRec && rootOwnerIdForRecord(crossRec) === rootOwnerId) {
                mapping = cross;
              }
            }
            if (mapping && effectiveTrustedCaller(extra)?.source === "managed-cli"
                && !canAccessMember(owner, extra, store.get(mapping.agentId)
                  ?? store.listAgentStubs(rootOwnerId).find(stub => stub.agentId === mapping.agentId))) mapping = null;
            if (!mapping) throw Object.assign(new Error('Task receipt is unavailable for this owner.'), { code: 'task-receipt-unavailable' });
            const effectiveKeyOwner = mapping.ownerId ?? owner.ownerId;
            if (mapping.receipt?.expired) throw Object.assign(new Error('Task receipt has expired.'), { code: 'task-receipt-expired' });
            if (mapping.failureReason) throw Object.assign(new Error('The dispatched input failed.'), { code: mapping.failureReason, requestId: mapping.requestId });
            const record = store.get(mapping.agentId);
            const supplement = store.supplement(mapping.requestId);
            if (supplement?.status === 'blocked') throw Object.assign(new Error('The dispatched input failed.'), { code: supplement.reason ?? 'dispatch-failed', requestId: mapping.requestId });
            if (!mapping.taskId) {
              if (supplement?.status === 'accepted' && supplement.task) {
                store.saveTaskKey(effectiveKeyOwner, mapping.agentId, mapping.requestId, supplement.task);
                mapping = store.resolveTaskKey(effectiveKeyOwner, key);
              }
            }
            if (record && record.ownerId !== owner.ownerId && rootOwnerIdForRecord(record) !== rootOwnerId) {
              throw Object.assign(new Error('Task receipt is unavailable.'), { code: 'task-receipt-unavailable' });
            }
            if (!record && !mapping.receipt) mapping = store.resolveTaskKey(effectiveKeyOwner, key);
            if (!mapping) throw Object.assign(new Error('Task receipt is unavailable.'), { code: 'task-receipt-unavailable' });
            if (mapping.failureReason) throw Object.assign(new Error('The dispatched input failed.'), { code: mapping.failureReason, requestId: mapping.requestId });
            if (mapping.receipt) {
              keySettled.set(key, true);
              if (!positions[cursorIndex]?.delivered) {
                const receiptBody = store.storedReportBody(effectiveKeyOwner, key, mapping.receipt.finalSubmissionId);
                const receiptMsg = receiptBody && !receiptBody.error ? receiptBody.body : undefined;
                events.push({ id: key + ':delivered:' + mapping.receipt.finalSubmissionId, taskKey: key, type: 'delivered', final: true, createdAt: mapping.receipt.deliveredAt,
                  submissionId: mapping.receipt.finalSubmissionId,
                  ...(receiptMsg !== undefined ? { message: compactText(receiptMsg, 4000), ...(receiptMsg.length > 4000 ? { truncated: true } : {}) } : {}),
                  ...(mapping.receipt.release ? { tree: mapping.receipt.release } : {}),
                  body: receiptBody && !receiptBody.error
                    ? reportBodyReference({ taskKey: key, submissionId: mapping.receipt.finalSubmissionId, body: receiptBody.body })
                    : undefined });
              }
              continue;
            }
            if (!record) throw Object.assign(new Error('Task receipt is unavailable.'), { code: 'task-receipt-unavailable' });
            if (!mapping.taskId) { keySettled.set(key, false); items.push({ name: record.name, state: 'queued', task: null }); continue; }
            const task = record.task?.taskId === mapping.taskId ? record.task : store.historyTask(mapping.agentId, mapping.taskId);
            if (!task) throw Object.assign(new Error('The original task is unavailable.'), { code: 'task-receipt-unavailable' });
            const answer = (task.answers ?? []).find(item => item.answerId === mapping.requestId);
            if (answer?.undelivered) throw Object.assign(new Error('The answer was not delivered.'), { code: answer.undelivered, requestId: mapping.requestId });
            const dispatch = (task.dispatches ?? []).find(item => item.requestId === mapping.requestId);
            if (dispatch?.state === 'failed' && dispatch.accepted !== true) {
              throw Object.assign(new Error('The dispatched task failed to send.'), { code: dispatch.failure?.code ?? dispatch.error?.code ?? 'dispatch-failed', requestId: mapping.requestId, detail: dispatch.failure ?? dispatch.error });
            }
            const taskRecord = task === record.task ? record : { ...record, task, state: task.state, observation: undefined, error: undefined };
            items.push(waitItem(taskRecord, key, storedBodyText(store, taskRecord, key)));
            const baseline = mapping.baseline ?? { count: 0, reportCount: 0, nativeCount: 0 };
            const position = positions[cursorIndex] ?? { count: baseline.count ?? 0, reportCount: baseline.reportCount ?? 0, nativeCount: baseline.nativeCount ?? 0 };
            initialPositions.set(cursorIndex, position);
            const allTaskSubmissions = store.submissionsInOrder(mapping.agentId, mapping.taskId, 0);
            const submissions = allTaskSubmissions.slice(position.count ?? 0);
            const exactBody = id => {
              const stored = store.storedReportBody(effectiveKeyOwner, key, id);
              return stored && !stored.error ? stored.body : undefined;
            };
            const headlessReady = isHeadlessCli(targetOf(record))
              && !store.childrenOf(record.agentId).some(child => !child.closed && ACTIVE.has(child.state));
            for (let index = 0; index < submissions.length; index++) {
              const submission = submissions[index];
              const bodyText = submission.kind === 'report' ? exactBody(submission.id) : undefined;
              const message = bodyText ?? submission.message;
              const reportForSubmission = (task.reports ?? []).find(report =>
                sameReportId(report.id, submission.id) || report.sharedSubmission === submission.id);
              const waitingForRelease = submission.final === true
                && !['delivered', 'blocked', 'pull_ready'].includes(submission.delivery?.state)
                && !headlessReady
                && (!reportForSubmission || !finalReportReady(reportForSubmission));
              const eventId = key + ':submission:' + submission.id;
              const evt = { id: eventId, taskKey: key, name: record.name,
                ...(record.role ? { role: record.role } : {}),
                type: submission.kind === 'ask' ? 'question' : submission.final ? 'final' : 'report',
                message: compactText(message, 4000),
                ...(typeof message === 'string' && message.length > 4000 ? { truncated: true } : {}),
                ...(submission.kind === 'ask'
                  ? {}
                  : { delivery: submission.delivery?.state ?? 'pending',
                    ...(submission.delivery?.error ? { error: submission.delivery.error } : {}),
                    ...((submission.delivery?.treeRelease ?? reportForSubmission?.delivery?.treeRelease)
                      ? { tree: submission.delivery?.treeRelease ?? reportForSubmission.delivery.treeRelease } : {}),
                    ...(bodyText !== undefined ? { body: reportBodyReference({ taskKey: key, submissionId: submission.id, body: bodyText }) } : {}),
                    ...(waitingForRelease ? { pendingRelease: true, advance: false } : {}) }),
                final: submission.final === true, createdAt: submission.created };
              events.push(evt);
              if (!waitingForRelease) {
                pullDeliveries.push({ eventId, mapping, submissionId: submission.id, kind: submission.kind, final: submission.final === true });
              }
            }
            const reports = (task.reports ?? []).filter(report => !report.failure
              && !report.id?.startsWith('submission:')
              && (!report.sharedSubmission || nativeReportOnly(record)));
            for (let index = position.reportCount ?? 0; index < reports.length; index++) {
              const report = reports[index];
              const submissionId = typeof report.id === 'string' ? report.id : undefined;
              const bodyText = submissionId ? exactBody(submissionId) : undefined;
              const message = bodyText ?? report.message;
              const waitingForRelease = report.final === true && !headlessReady && !finalReportReady(report);
              const eventId = key + ':report:' + (report.id ?? index);
              events.push({ id: eventId, taskKey: key, name: record.name,
                ...(record.role ? { role: record.role } : {}),
                type: report.final ? 'final' : 'report', source: 'task-report',
                message: compactText(message, 4000),
                ...(typeof message === 'string' && message.length > 4000 ? { truncated: true } : {}),
                delivery: report.delivery?.state ?? 'pending',
                ...(report.delivery?.error ? { error: report.delivery.error } : {}),
                ...(report.delivery?.treeRelease ? { tree: report.delivery.treeRelease } : {}),
                ...(submissionId && bodyText !== undefined ? { body: reportBodyReference({ taskKey: key, submissionId, body: bodyText }) } : {}),
                ...(waitingForRelease ? { pendingRelease: true, advance: false } : {}),
                final: report.final === true, createdAt: report.createdAt });
              if (!waitingForRelease && submissionId) {
                pullDeliveries.push({ eventId, mapping, submissionId, kind: 'report', final: report.final === true, taskReport: true });
              }
            }
            // Old rosters may have only the last observation; read it without a write.
            const nativeQuestions = task === record.task ? captureNativeQuestionHistory(taskRecord) : (task.nativeQuestions ?? []);
            for (let index = position.nativeCount ?? 0; index < nativeQuestions.length; index++) {
              const question = nativeQuestions[index];
              events.push({ id: key + ':native:' + question.id, taskKey: key, name: record.name,
                ...(record.role ? { role: record.role } : {}),
                type: 'question', source: 'native', message: compactText(question.message, 4000), createdAt: question.createdAt });
            }
            const state = task === record.task ? terminalRound(record) : (['completed', 'failed', 'cancelled'].includes(task?.state) ? task.state : undefined);
            if (state && !positions[cursorIndex]?.terminal) events.push({ id: key + ':terminal:' + state, taskKey: key, name: record.name, type: state, source: 'task', ...((task === record.task ? record.error ?? task.cancelError : task.error ?? task.cancelError) ? { reason: task === record.task ? record.error ?? task.cancelError : task.error ?? task.cancelError } : {}), createdAt: task?.finishedAt });

            const hasFinalSubmission = allTaskSubmissions.some(s => s.kind === 'report' && s.final === true
              && (headlessReady || ['delivered', 'blocked', 'pull_ready'].includes(s.delivery?.state)
                || finalReportReady((task.reports ?? []).find(r => sameReportId(r.id, s.id) || r.sharedSubmission === s.id))));
            const hasFinalTaskReport = reports.some(r => r.final === true && (headlessReady || finalReportReady(r)));
            keySettled.set(key, Boolean(state || hasFinalSubmission || hasFinalTaskReport));
          }
          let candidatePositions = { ...positions };
          const batch = []; let size = 0;
          for (const event of events) {
            const length = JSON.stringify(event).length;
            if (batch.length && size + length > 20000) break;
            const index = keyIndexes.get(event.taskKey);
            const position = { ...(candidatePositions[index] ?? initialPositions.get(index) ?? { count: 0, reportCount: 0, nativeCount: 0 }) };
            if (event.advance !== false) {
              if (event.type === 'delivered') position.delivered = true;
              else if (['completed', 'failed', 'cancelled'].includes(event.type)) position.terminal = true;
              else if (event.source === 'native') position.nativeCount = (position.nativeCount ?? 0) + 1;
              else if (event.source === 'task-report') position.reportCount = (position.reportCount ?? 0) + 1;
              else position.count++;
            }
            const nextPositions = { ...candidatePositions, [index]: position };
            if (cursor(nextPositions).length > 20000 && batch.length) break;
            if (cursor(nextPositions).length > 20000) throw Object.assign(new Error('Wait cursor exceeds its size limit; select fewer tasks.'), { code: 'wait-cursor-limit' });
            candidatePositions = nextPositions;
            batch.push(event); size += length;
          }
          const timedOut = Date.now() >= deadline;
          const hasBarrierBreaker = events.some(e => e.type === 'question' || e.type === 'failed' || e.type === 'cancelled');
          const allTasksSettled = selection.length > 0 && selection.every(k => keySettled.get(k) === true);
          const barrierSatisfied = barrier === 'all'
            ? (hasBarrierBreaker || allTasksSettled)
            : batch.length > 0;
          if (barrierSatisfied || timedOut || notListed.size || !selection.length) {
            positions = candidatePositions;
            if (batch.length && isPullOwner(owner)) {
              const returnedIds = new Set(batch.filter(e => e.advance !== false).map(e => e.id));
              acknowledgePulledDeliveries(owner, pullDeliveries.filter(d => returnedIds.has(d.eventId)), batch);
            }
            return {
              items,
              notListed: [...notListed],
              events: batch,
              nextCursor: cursor(),
              reason: batch.length && (barrierSatisfied || barrier === 'any') ? 'event' : notListed.size ? 'not-listed' : timedOut ? 'timeout' : 'empty',
              timedOut: timedOut && !barrierSatisfied,
            };
          }
          const current = pending;
          if (Number.isFinite(deadline)) timer = setTimeout(notify, Math.max(0, deadline - Date.now()));
          await current;
          clearTimeout(timer); timer = undefined;
        }
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', notify); unsubscribe(); }
    },
    /**
     * Explicit retrieval of one report body by owner + taskKey + submission ID.
     * It is intentionally not folded into wait: a caller that wants the text asks
     * for a page, and only this path can return the exact original characters.
     */
    async readReport({ taskKey, submissionId, offset = 0, limit = REPORT_BODY_PAGE_CHARS } = {}, extra) {
      if (typeof taskKey !== 'string' || !taskKey) throw Object.assign(new Error('A task key is required.'), { code: 'invalid-task-key' });
      if (typeof submissionId !== 'string' || !submissionId) throw Object.assign(new Error('A submission ID is required.'), { code: 'invalid-submission-id' });
      const owner = await context(extra);
      const rootOwnerId = resolveTeamRootOwnerId(owner, extra);
      if (effectiveTrustedCaller(extra)?.source === "managed-cli") {
        const mapping = store.resolveTaskKeyAnyOwner(taskKey);
        const member = mapping && (store.get(mapping.agentId)
          ?? store.listAgentStubs(rootOwnerId).find(stub => stub.agentId === mapping.agentId));
        if (!canAccessMember(owner, extra, member)) throw permissionDenied();
      }
      let effectiveOwnerId = owner.ownerId;
      let stored = store.storedReportBody(effectiveOwnerId, taskKey, submissionId);
      if (stored.error === 'task-receipt-unavailable') {
        const cross = store.resolveTaskKeyAnyOwner(taskKey);
        const crossRec = cross ? store.get(cross.agentId) : undefined;
        if (cross && crossRec && rootOwnerIdForRecord(crossRec) === rootOwnerId) {
          effectiveOwnerId = cross.ownerId;
          stored = store.storedReportBody(effectiveOwnerId, taskKey, submissionId);
        }
      }
      if (stored.error) throw Object.assign(new Error(stored.error === 'task-receipt-expired' || stored.error === 'report-body-expired'
        ? 'The task receipt or its report body has expired.' : stored.error === 'task-receipt-unavailable'
          ? 'Task receipt is unavailable for this owner.' : 'The report body is unavailable for this owner and task.'), { code: stored.error });
      if (isPullOwner(owner)) {
        const mapping = store.resolveTaskKey(effectiveOwnerId, taskKey);
        if (mapping) {
          acknowledgePulledDeliveries(owner, [{ mapping, submissionId: bareReportId(submissionId), kind: 'report' }], []);
        }
      }
      const page = reportBodyPage(stored.body, { offset, limit });
      return { taskKey, submissionId, ...page, created: stored.created, expires: stored.expires };
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
        store.setError(record.agentId, monitorError ?? { code: 'monitor-unavailable', message: 'The shared monitor could not start.' }, record);
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
      const boardAgents = new Set(store.boardRouteAgents());
      if (sweep) for (const agentId of boardAgents) if (!store.get(agentId)) await routeBoardTarget(agentId);
      const wanted = new Set(only ?? []);
      for (const [agentId, dueAt] of inbox) if (dueAt <= scanAt) wanted.add(agentId);
      for (const agentId of boardAgents) wanted.add(agentId);
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
        if (!boardAgents.has(agentId) && !needsPoll(full ?? candidate ?? store.get(agentId), hasSubmission)) { fastPoll.delete(agentId); continue; }
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
        if (!hinted && !urgentPoll.has(agentId) && !force && !hasWaitingTreeFinal(candidate)
            && candidateNextAt > Date.now()) continue;
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
        if (!hinted && !urgent && !force && !hasWaitingTreeFinal(record)
            && Math.max(record.nextAttemptAt ?? 0, record.transportNextAttemptAt ?? 0) > Date.now()) continue;
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
      await Promise.allSettled([...releaseInflight.values(), ...settlementInflight.values()]);
      // A baseline write survives the poll that started it; a shutdown that only waited
      // for polls could close the database with half a snapshot still being written.
      while (baselineWrites.size) await Promise.allSettled([...baselineWrites.values()]);
    },
    async flushSettlements() {
      const keepAlive = setInterval(() => {}, 5000);
      try {
        while (settlementInflight.size) await Promise.allSettled([...settlementInflight.values()]);
        while (baselineWrites.size) await Promise.allSettled([...baselineWrites.values()]);
      } finally {
        clearInterval(keepAlive);
      }
    },
    notifyWait() {
      wakeWaiters();
    },
    async handleCliSubmission({ agentId } = {}) {
      if (agentId && !draining && !waitsClosed) {
        try {
          await store.locked(agentId, async () => {
            const record = store.get(agentId);
            if (record && !record.closed && record.task) {
              await drainSubmissions(record, { currentOnly: true });
            }
          }, { waitMs: 40 });
        } catch {
          // Even when the agent lock is held by a running poll, the submission row is
          // already durable in SQLite and wait() reads submissionsInOrder directly.
        }
      }
      wakeWaiters();
      if (agentId) announceWork(agentId);
    },
    async postBoard({ message, mentions, urgent = false, author: explicitAuthor } = {}, extra) {
      textMessage(message);
      if (typeof urgent !== "boolean") throw Object.assign(new Error("urgent must be a boolean."), { code: "invalid-arguments" });
      const caller = effectiveTrustedCaller(extra);
      const owner = await context(extra);
      const rootOwnerId = resolveTeamRootOwnerId(owner, extra);
      const callerAgent = owner.callerAgentId ? store.get(owner.callerAgentId)
        : !caller ? store.agentForCodexThread(callingThread(extra), { includeAutoClosed: true }) : undefined;
      const author = callerAgent ? managedPath(callerAgent)
        : (typeof explicitAuthor === "string" && explicitAuthor.trim() ? explicitAuthor.trim() : "Boss");
      const authorRole = callerAgent ? (callerAgent.role ?? inferRoleFromName(callerAgent.name) ?? null) : "Boss";
      const parsedMentions = extractBoardMentions(message, mentions);
      const active = visibleRecords(rootOwnerId).all.filter(member => !member.closed);
      const stubs = store.listAgentStubs(rootOwnerId);
      const actor = { authorAgentId: callerAgent?.agentId ?? null,
        authorTaskId: caller ? caller.callerTaskId : callerAgent?.task?.taskId,
        authorRequestId: caller ? caller.callerRequestId : activeManagedRequestId(callerAgent?.task) };
      if (caller?.source === "managed-cli" && !boardActor(actor, rootOwnerId)) throw permissionDenied();
      if (urgent && callerAgent && !isBoardAuthority(actor, rootOwnerId)) throw permissionDenied();
      const routed = [];
      const seen = new Set();
      for (const mention of parsedMentions) {
        if (!urgent && (!mention || mention === author || mention === "Boss" || mention === "all")) continue;
        const member = resolveBoardMention(mention, active, managedPath)
          ?? resolveBoardMention(mention, stubs, stub => stub.agentPath);
        if (urgent && (!member || (callerAgent && !isDescendant(store, member, callerAgent.agentId)))) {
          throw permissionDenied();
        }
        if (!member) { routed.push({ mention, action: "not-found" }); continue; }
        if (seen.has(member.agentId)) continue;
        seen.add(member.agentId);
        routed.push({ mention, name: member.name, agentPath: member.agentPath ?? managedPath(member),
          targetAgentId: member.agentId, taskId: member.task?.taskId ?? null, action: "deferred" });
      }
      const saved = store.postBoardMessage({ rootOwnerId, author, authorRole, ...actor, text: message,
        mentions: parsedMentions, routed, urgent });
      for (const id of seen) {
        await routeBoardTarget(id);
        announceWork(id);
      }
      const result = store.listBoardMessages(rootOwnerId, { afterSeq: saved.seq - 1, limit: 500 })
        .messages.find(item => item.seq === saved.seq) ?? saved;
      wakeWaiters();
      if (result.routed.some(item => item.action === "deferred")) await ensureMonitor();
      return { posted: true, seq: result.seq, message: result, mentions: parsedMentions, routed: result.routed };
    },
    async readBoard({ limit = 50, afterSeq = 0 } = {}, extra) {
      const owner = await context(extra);
      const rootOwnerId = resolveTeamRootOwnerId(owner, extra);
      const { messages, latestSeq } = store.listBoardMessages(rootOwnerId, { limit, afterSeq });
      return { rootOwnerId, messages, latestSeq };
    },
    async manageTeam({
      action,
      target,
      parent,
      reparentTo,
      reparent_to,
      keepChildren,
      keep_children,
      killTree,
      kill_tree,
      discardWorktree,
      discard_worktree,
      message,
    } = {}, extra) {
      const normalizedAction = typeof action === 'string' ? action.trim().toLowerCase() : '';
      if (!['strays', 'adopt', 'kick', 'merge', 'reparent', 'resume', 'sweep'].includes(normalizedAction)) {
        throw Object.assign(
          new Error('action must be one of "adopt", "kick", "merge", "reparent", "resume", "strays", or "sweep".'),
          { code: 'invalid-team-action' },
        );
      }
      const owner = await context(extra);
      const rootOwnerId = resolveTeamRootOwnerId(owner, extra);
      if (effectiveTrustedCaller(extra)?.source === "managed-cli" && ["strays", "sweep", "adopt"].includes(normalizedAction)) {
        throw permissionDenied();
      }
      const callerWorkspace = owner.workspace ?? config.workspace;
      const normCallerWs = callerWorkspace ? pathKey(callerWorkspace) : null;
      const STRAY_IDLE_MS = 30 * 60 * 1000;

      const effectiveParent = parent !== undefined ? parent : (reparentTo !== undefined ? reparentTo : reparent_to);
      const managedCallerId = effectiveTrustedCaller(extra)?.source === "managed-cli" ? owner.callerAgentId : undefined;
      const effectiveKeepChildren = (killTree === true || kill_tree === true)
        ? false
        : (keepChildren !== undefined
          ? keepChildren !== false
          : (keep_children !== undefined ? keep_children !== false : true));

      const relocateMovedDirs = async movedList => {
        const scopedRoot = path.resolve(config.stateDirectory, 'scoped');
        for (const item of movedList ?? []) {
          if (!item?.oldOwnerId || !item?.newOwnerId || item.oldOwnerId === item.newOwnerId) continue;
          forgetBackend({ agentId: item.agentId });
          const srcDir = path.join(scopedRoot, item.oldOwnerId, item.agentId);
          const dstDir = path.join(scopedRoot, item.newOwnerId, item.agentId);
          try {
            if (!await plainDirectoryPath(scopedRoot, srcDir)) continue;
            await plainDirectoryPath(scopedRoot, dstDir);
            await mkdir(path.dirname(dstDir), { recursive: true });
            await plainDirectoryPath(scopedRoot, dstDir);
            try { await rename(srcDir, dstDir); }
            catch {
              await cp(srcDir, dstDir, { recursive: true, force: true });
              await removeScopedDirectory(srcDir);
            }
          } catch { /* A moved roster entry must never remove an unverified state tree. */ }
        }
      };

      const scanStrays = (nowMs = Date.now()) => {
        const allOpen = store.list().filter(r => r && !r.cleanupRosterTicket && !r.closed);
        const byTeamRoot = new Map();
        for (const rec of allOpen) {
          const tRoot = rootOwnerIdForRecord(rec);
          let arr = byTeamRoot.get(tRoot);
          if (!arr) { arr = []; byTeamRoot.set(tRoot, arr); }
          arr.push(rec);
        }
        const lostErrorCodes = new Set([
          'calling-context-unavailable',
          'codex-thread-not-found',
          'claude-session-not-found',
          'agy-conversation-not-found',
          'host-ownership-mismatch',
        ]);
        const strays = [];
        for (const rec of allOpen) {
          const recRoot = rootOwnerIdForRecord(rec);
          const parentRec = rec.parentAgentId ? store.get(rec.parentAgentId) : undefined;
          const brokenParent = Boolean(
            rec.parentAgentId
            && (!parentRec || parentRec.closed || ['cleaning', 'cleanup_failed'].includes(parentRec.state)),
          );
          let staleForeignSession = false;
          if (!brokenParent && recRoot !== rootOwnerId) {
            const peers = byTeamRoot.get(recRoot) ?? [rec];
            const anyRunning = peers.some(p => p.state === 'running' || p.state === 'creating');
            if (!anyRunning) {
              const ownerDoc = store.owner(recRoot);
              const latestStamp = Math.max(
                ...peers.map(p => Date.parse(p.updatedAt ?? p.createdAt ?? '') || 0),
                Date.parse(ownerDoc?.createdAt ?? '') || 0,
              );
              const hasLostError = peers.some(p => lostErrorCodes.has(p.error?.code));
              if (!ownerDoc || hasLostError || (latestStamp > 0 && nowMs - latestStamp >= STRAY_IDLE_MS)) {
                staleForeignSession = true;
              }
            }
          }
          if (brokenParent || staleForeignSession) {
            strays.push({
              agentId: rec.agentId,
              name: rec.name,
              role: rec.role ?? inferRoleFromName(rec.name) ?? null,
              agentPath: managedPath(rec),
              ownerId: rec.ownerId,
              rootOwnerId: recRoot,
              parentAgentId: rec.parentAgentId ?? null,
              target: targetOf(rec),
              lifetime: rec.lifetime,
              state: rec.state,
              workspace: rec.rootWorkspace ?? rec.workspace ?? null,
              strayReason: brokenParent ? 'broken-parent' : 'stale-session',
              updatedAt: rec.updatedAt ?? rec.createdAt ?? null,
            });
          }
        }
        return strays;
      };

      const discard = discardWorktree === true || discard_worktree === true;
      const forcePurgeSingleRecord = async (rec, explicitDiscard = false) => {
        if (!rec) return;
        const fresh = store.get(rec.agentId) ?? rec;
        try {
          if (!readOnlyTarget(fresh) && !fresh.nativeDestroyed) {
            const backend = await backendFor(fresh);
            if (typeof backend.destroy === 'function') await backend.destroy().catch(() => {});
            else if (typeof backend.cancel === 'function') await backend.cancel().catch(() => {});
          }
        } catch {}
        const dir = agentDirectory(fresh);
        await killProcessCage({ pids: [], turnDir: dir, sessionId: fresh.sessionId }).catch(() => {});
        if (fresh.worktreePath) await removeOwnedWorktree(fresh, { force: explicitDiscard });
        await removeScopedDirectory(dir).catch(() => {});
        store.deleteAgentStub?.(fresh.agentId);
        try {
          store.remove(fresh, { deliveredReceipt: false });
        } catch {
          store.db.prepare('DELETE FROM agents WHERE id=?').run(fresh.agentId);
          store.touched(fresh.agentId);
        }
        forgetBackend(fresh);
      };

      const resolveOptionalParentRecord = parentSpec => {
        if (parentSpec === undefined || parentSpec === null || parentSpec === '' || parentSpec === 'root' || parentSpec === 'Boss') {
          return managedCallerId ? store.get(managedCallerId) : null;
        }
        return named(owner, String(parentSpec), extra);
      };

      if (normalizedAction === 'strays') {
        const strays = scanStrays();
        return { action: 'strays', ok: true, strays, total: strays.length };
      }

      if (normalizedAction === 'sweep') {
        const strays = scanStrays().filter(item => item.state !== 'running' && item.state !== 'creating');
        const strayIds = new Set(strays.map(s => s.agentId));
        const depthOf = id => {
          let depth = 0;
          let cur = store.get(id);
          const seen = new Set();
          while (cur?.parentAgentId && !seen.has(cur.agentId)) {
            seen.add(cur.agentId);
            depth += 1;
            cur = store.get(cur.parentAgentId);
          }
          return depth;
        };
          const protectedIds = new Set();
        for (const id of strayIds) {
          const member = store.get(id);
          if (!member || !(await cleanupProof(member)).error) continue;
          protectedIds.add(id);
          for (const child of store.descendantsOf([id])) protectedIds.add(child.agentId);
        }
        const orderedIds = [...strayIds].filter(id => !protectedIds.has(id)).sort((a, b) => depthOf(b) - depthOf(a));
        const sweptNames = [];
        for (const id of orderedIds) {
          const rec = store.get(id);
          if (!rec || rec.state === 'running' || rec.state === 'creating') continue;
          if (store.childrenOf(id).some(c => !strayIds.has(c.agentId))) {
            for (const c of store.childrenOf(id)) {
              if (!strayIds.has(c.agentId)) store.reparentAgent(c.agentId, rec.parentAgentId ?? null);
            }
          }
          sweptNames.push(rec.name);
          await forcePurgeSingleRecord(rec);
        }
        store.pruneExpiredTaskKeys();
        wakeWaiters();
        return { action: 'sweep', ok: true, sweptCount: sweptNames.length, sweptNames };
      }

      if (normalizedAction === 'adopt') {
        const trimmedTarget = typeof target === 'string' ? target.trim() : '';
        const resolvedParent = resolveOptionalParentRecord(effectiveParent);
        if (!trimmedTarget || trimmedTarget === 'auto' || trimmedTarget === 'project') {
          const allOpen = store.list().filter(r => r && !r.cleanupRosterTicket && !r.closed);
          const byRoot = new Map();
          for (const rec of allOpen) {
            const tRoot = rootOwnerIdForRecord(rec);
            if (tRoot === rootOwnerId) continue;
            let arr = byRoot.get(tRoot);
            if (!arr) { arr = []; byRoot.set(tRoot, arr); }
            arr.push(rec);
          }
          const oldOwnersToAdopt = new Set();
          const agentIdsToAdopt = [];
          const allAdoptedTeamMembers = [];
          const topRootAgents = [];
          for (const [foreignRoot, members] of byRoot.entries()) {
            const anyActivelyRunning = members.some(m => m.state === 'running' || m.state === 'creating');
            if (anyActivelyRunning) continue;
            const ownerDoc = store.owner(foreignRoot);
            const wsCandidate = ownerDoc?.workspace ?? members[0]?.rootWorkspace ?? members[0]?.workspace;
            if (normCallerWs && wsCandidate && pathKey(wsCandidate) !== normCallerWs) continue;
            oldOwnersToAdopt.add(foreignRoot);
            for (const m of members) {
              allAdoptedTeamMembers.push(m);
              const isRootMember = !m.parentAgentId || !members.some(p => p.agentId === m.parentAgentId);
              if (isRootMember) {
                topRootAgents.push(m.agentId);
              }
              if (isRootMember || m.ownerId === foreignRoot) {
                oldOwnersToAdopt.add(m.ownerId);
                agentIdsToAdopt.push(m.agentId);
              }
            }
          }
          for (const ownerDoc of store.listOwners()) {
            if (!ownerDoc?.ownerId || ownerDoc.ownerId === rootOwnerId) continue;
            if (normCallerWs && ownerDoc.workspace && pathKey(ownerDoc.workspace) !== normCallerWs) continue;
            const liveInOwner = allOpen.filter(r => rootOwnerIdForRecord(r) === ownerDoc.ownerId);
            if (liveInOwner.some(m => m.state === 'running' || m.state === 'creating')) continue;
            oldOwnersToAdopt.add(ownerDoc.ownerId);
          }
          if (resolvedParent) {
            for (const topId of topRootAgents) store.reparentAgent(topId, resolvedParent.agentId);
          }
          const { moved } = store.transferAgentsToOwner(agentIdsToAdopt, rootOwnerId);
          await relocateMovedDirs(moved);
          const assets = store.transferOwnerTeamAssets([...oldOwnersToAdopt], rootOwnerId);
          const movedById = new Map(moved.map(item => [item.agentId, item.name]));
          const adoptedNames = allAdoptedTeamMembers.map(m => movedById.get(m.agentId) ?? m.name);
          wakeWaiters();
          return {
            action: 'adopt',
            mode: 'project',
            ok: true,
            ownerId: rootOwnerId,
            adoptedCount: adoptedNames.length,
            adoptedNames,
            transferredOwners: [...oldOwnersToAdopt],
            boardMessagesTransferred: assets.boardMoved,
            stubsTransferred: assets.stubsMoved,
          };
        }

        // Adopt by explicit old ownerId
        if (trimmedTarget.startsWith('owner-') && trimmedTarget !== rootOwnerId) {
          const foreignMembers = store.list().filter(r => !r.closed && (r.ownerId === trimmedTarget || rootOwnerIdForRecord(r) === trimmedTarget));
          if (foreignMembers.length > 0 || store.owner(trimmedTarget)) {
            if (resolvedParent) {
              for (const m of foreignMembers) {
                if (!m.parentAgentId || !foreignMembers.some(p => p.agentId === m.parentAgentId)) {
                  store.reparentAgent(m.agentId, resolvedParent.agentId);
                }
              }
            }
            const { moved } = store.transferAgentsToOwner(foreignMembers.map(m => m.agentId), rootOwnerId);
            await relocateMovedDirs(moved);
            const assets = store.transferOwnerTeamAssets([trimmedTarget], rootOwnerId);
            wakeWaiters();
            return {
              action: 'adopt',
              mode: 'owner',
              ok: true,
              ownerId: rootOwnerId,
              adoptedCount: moved.length,
              adoptedNames: moved.map(m => m.name),
              boardMessagesTransferred: assets.boardMoved,
              stubsTransferred: assets.stubsMoved,
            };
          }
        }

        // Adopt a specific live stray/foreign agent by agentId, path, or name
        const allOpen = store.list().filter(r => r && !r.cleanupRosterTicket && !r.closed);
        const candidateRecord = allOpen.find(r => r.agentId === trimmedTarget)
          ?? allOpen.find(r => rootOwnerIdForRecord(r) !== rootOwnerId && (managedPath(r) === trimmedTarget || r.name === trimmedTarget))
          ?? allOpen.find(r => (managedPath(r) === trimmedTarget || r.name === trimmedTarget) && Boolean(r.parentAgentId && !store.get(r.parentAgentId)));
        if (candidateRecord) {
          const subtree = [candidateRecord, ...store.descendantsOf([candidateRecord.agentId])];
          const oldOwnerSet = new Set(subtree.map(r => r.ownerId));
          store.reparentAgent(candidateRecord.agentId, resolvedParent ? resolvedParent.agentId : null);
          const { moved } = store.transferAgentsToOwner(subtree.map(r => r.agentId), rootOwnerId);
          await relocateMovedDirs(moved);
          for (const oldOw of oldOwnerSet) {
            if (oldOw !== rootOwnerId && store.list(oldOw).length === 0) {
              store.transferOwnerTeamAssets([oldOw], rootOwnerId);
            }
          }
          const adoptedRootName = moved.find(m => m.agentId === candidateRecord.agentId)?.name ?? candidateRecord.name;
          let sent;
          if (typeof message === 'string' && message.trim()) {
            sent = await service.send({ name: managedPath(store.get(candidateRecord.agentId)), message: message.trim() }, extra);
          }
          wakeWaiters();
          return {
            action: 'adopt',
            mode: 'agent',
            ok: true,
            name: adoptedRootName,
            agentId: candidateRecord.agentId,
            parentAgentId: resolvedParent?.agentId ?? null,
            adoptedCount: moved.length,
            adoptedNames: moved.map(m => m.name),
            ...(sent?.taskKey ? { taskKey: sent.taskKey, wakeCmd: buildWakeCmd(owner, sent.taskKey) } : {}),
          };
        }

        // Revive a finished veteran stub from team_agent_stubs
        const stub = store.findAgentStubGlobal(trimmedTarget, rootOwnerId);
        if (stub) {
          store.deleteAgentStub(stub.agentId);
          const createExtra = resolvedParent
            ? {
              [Symbol.for('futureaide.trustedCaller')]: {
                source: 'managed-cli',
                parentAgentId: resolvedParent.agentId,
                ownerId: rootOwnerId,
                workspace: callerWorkspace,
              },
            }
            : extra;
          const created = await service.create({
            name: stub.name,
            ...(stub.role ? { role: stub.role } : {}),
            lifetime: 'persistent',
            target: stub.target,
            ...(stub.model ? { model: stub.model } : {}),
            _revivedSessionId: stub.resumeSessionId ?? undefined,
            _revivedReadOnlyScout: stub.readOnlyScout,
          }, createExtra);
          let sent;
          if (created.created === true && !created.error && typeof message === 'string' && message.trim()) {
            sent = await service.send({ name: resolvedParent ? `${managedPath(resolvedParent)}/${created.name}` : created.name, message: message.trim() }, extra);
          }
          wakeWaiters();
          return {
            action: 'adopt',
            mode: 'revived-stub',
            ok: created.created === true && !created.error,
            name: created.name,
            revived: true,
            resumedSession: Boolean(stub.resumeSessionId),
            parentAgentId: resolvedParent?.agentId ?? null,
            ...(sent?.taskKey ? { taskKey: sent.taskKey, wakeCmd: buildWakeCmd(owner, sent.taskKey) } : {}),
            ...(created.error ? { error: created.error } : {}),
          };
        }

        throw Object.assign(
          new Error(`No adoptable team, stray subagent, or stub matched “${trimmedTarget}”.`),
          { code: 'agent-not-found' },
        );
      }

      if (normalizedAction === 'reparent') {
        if (typeof target !== 'string' || !target.trim()) {
          throw Object.assign(new Error('reparent requires target.'), { code: 'invalid-arguments' });
        }
        const record = named(owner, target.trim(), extra);
        const resolvedParent = resolveOptionalParentRecord(effectiveParent);
        const updated = store.reparentAgent(record.agentId, resolvedParent ? resolvedParent.agentId : null);
        if (updated.ownerId !== rootOwnerId) {
          const { moved } = store.transferAgentsToOwner([updated.agentId], rootOwnerId);
          await relocateMovedDirs(moved);
        }
        const refreshed = store.get(record.agentId);
        wakeWaiters();
        return {
          action: 'reparent',
          ok: true,
          name: refreshed.name,
          agentId: refreshed.agentId,
          parentAgentId: refreshed.parentAgentId ?? null,
          parentName: refreshed.parentAgentId ? (store.get(refreshed.parentAgentId)?.name ?? null) : null,
          agentPath: managedPath(refreshed),
        };
      }

      if (normalizedAction === 'kick') {
        if (typeof target !== 'string' || !target.trim()) {
          throw Object.assign(new Error('kick requires target.'), { code: 'invalid-arguments' });
        }
        const trimmedTarget = target.trim();
        const record = named(owner, trimmedTarget, extra);
        const proof = await cleanupProof(record, { discardWorktree: discard });
        if (proof.error) return { action: "kick", name: record.name, ok: false, error: proof.error };

        if (effectiveKeepChildren) {
          const explicitNewParent = effectiveParent !== undefined ? resolveOptionalParentRecord(effectiveParent) : undefined;
          const promotedParentId = explicitNewParent !== undefined
            ? (explicitNewParent ? explicitNewParent.agentId : null)
            : (record.parentAgentId ?? null);
          if (promotedParentId) {
            const descendantsSet = new Set(store.descendantsOf([record.agentId]).map(d => d.agentId));
            if (promotedParentId === record.agentId || descendantsSet.has(promotedParentId)) {
              throw Object.assign(new Error('Cannot reparent surviving children under the kicked subagent or its own subtree.'), { code: 'reparent-cycle' });
            }
          }
          const directChildren = store.childrenOf(record.agentId);
          const survivingSubtree = [...directChildren, ...store.descendantsOf(directChildren.map(c => c.agentId))];
          for (const child of directChildren) {
            store.reparentAgent(child.agentId, promotedParentId);
          }
          if (survivingSubtree.length > 0) {
            const { moved } = store.transferAgentsToOwner(survivingSubtree.map(s => s.agentId), rootOwnerId);
            await relocateMovedDirs(moved);
          }
          const promotedChildren = directChildren.map(c => store.get(c.agentId)?.name ?? c.name);
          await forcePurgeSingleRecord(record, discard);
          wakeWaiters();
          return {
            action: 'kick',
            ok: true,
            name: record.name,
            agentId: record.agentId,
            keepChildren: true,
            newParentAgentId: promotedParentId,
            promotedChildren,
            removedNames: [record.name],
          };
        }

        const descendants = store.descendantsOf([record.agentId]);
        const removedNames = [...descendants.map(d => d.name), record.name];
        for (const child of [...descendants].reverse()) {
          await forcePurgeSingleRecord(child, discard);
        }
        await forcePurgeSingleRecord(record, discard);
        wakeWaiters();
        return {
          action: 'kick',
          ok: true,
          name: record.name,
          agentId: record.agentId,
          keepChildren: false,
          promotedChildren: [],
          removedNames,
        };
      }

      if (normalizedAction === 'merge') {
        if (typeof target !== 'string' || !target.trim()) {
          throw Object.assign(new Error('merge requires target.'), { code: 'invalid-arguments' });
        }
        const initial = named(owner, target.trim(), extra);
        return store.locked(initial.agentId, async () => {
          const cur = store.get(initial.agentId);
          if (cur && !cur.closed && ["idle", "completed", "failed", "cancelled"].includes(cur.state)
              && (!cur.task || ["completed", "failed", "cancelled"].includes(cur.task.state))
              && cur.observation?.running === true) {
            const refreshed = await observeOwn(cur).catch(() => null);
            if (refreshed && refreshed.running === false && refreshed.tree?.settled === true) {
              cur.observation = refreshed;
              store.save(cur);
            }
          }
          const record = mergeTarget(owner, extra, initial);
          return mergeWorktree(record, () => mergeTarget(owner, extra, initial), { discardWorktree: discard });
        });
      }

      // action === 'resume'
      if (typeof target !== 'string' || !target.trim()) {
        throw Object.assign(new Error('resume requires target.'), { code: 'invalid-arguments' });
      }
      const trimmedTarget = target.trim();
      let record;
      try {
        record = named(owner, trimmedTarget, extra);
      } catch (err) {
        if (err?.code === 'agent-not-found' && !managedCallerId) {
          const stub = store.findAgentStubGlobal(trimmedTarget, rootOwnerId);
          if (stub) {
            const adopted = await service.manageTeam({
              action: 'adopt',
              target: trimmedTarget,
              ...(effectiveParent !== undefined ? { parent: effectiveParent } : {}),
            }, extra);
            record = named(owner, adopted.name, extra);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
      requireWritableTarget(record);
      const continuationMessage = typeof message === 'string' && message.trim()
        ? message.trim()
        : '请从中断处继续完成原定任务并调用 report_parent 汇报。';

      const buildHandoffPrompt = async rec => {
        const archived = store.historyFor(rec.agentId);
        const latestTask = rec.task ?? archived.at(-1);
        const originalTaskText = latestTask?.message ? compactText(latestTask.message, 1500) : '（未找到原任务描述）';
        let changedList = attributedChanges(rec, rec.observation ?? {});
        if (!changedList.length) {
          const liveDiff = await workspaceDiff(rec).catch(() => null);
          if (liveDiff?.changes?.length) changedList = liveDiff.changes;
        }
        const filesSummary = changedList.length
          ? changedList.slice(0, 20).map(f => `- ${f.operation ?? 'modified'}: ${f.path}`).join('\n')
          : '（未检测到已改文件）';

        const timeline = [];
        if (latestTask?.taskId) {
          for (const sub of store.submissionsInOrder(rec.agentId, latestTask.taskId, 0)) {
            timeline.push({
              at: sub.created ?? '',
              line: `- [${sub.kind === 'ask' ? '提问' : (sub.final ? '终报' : '进展')}] ${compactText(sub.message, 300)}`,
            });
          }
        }
        for (const rep of latestTask?.reports ?? []) {
          if (!rep.failure && rep.message && !String(rep.id ?? '').startsWith('submission:')) {
            timeline.push({
              at: rep.createdAt ?? '',
              line: `- [${rep.final ? '终报' : '进展'}] ${compactText(rep.message, 300)}`,
            });
          }
        }
        for (const ans of latestTask?.answers ?? []) {
          if (ans.message) {
            timeline.push({
              at: ans.created ?? '',
              line: `- [上级答复] ${compactText(ans.message, 300)}`,
            });
          }
        }
        timeline.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        const recentThree = timeline.slice(-3).map(t => t.line);
        const progressSummary = recentThree.length ? recentThree.join('\n') : '（暂无历史汇报或问答）';

        return [
          '[跨账号无缝交接续跑]',
          '1. 原定任务：',
          originalTaskText,
          '',
          '2. 工作区已改文件摘要：',
          filesSummary,
          '',
          '3. 最近进展与问答（最近 3 条）：',
          progressSummary,
          '',
          '4. 本轮续跑要求：',
          continuationMessage,
        ].join('\n');
      };

      const resetStoppedRecordForNextTurn = rec => {
        const fresh = store.get(rec.agentId) ?? rec;
        if (fresh.task) {
          const snap = {
            ...fresh.task,
            ...(publicResult(fresh).error ? { error: publicResult(fresh).error } : {}),
            changes: attributedChanges(fresh, fresh.observation ?? {}),
            coverage: treeCoverage(fresh, fresh.observation ?? {}),
            tree: publicTree(fresh, fresh.observation ?? {}),
          };
          store.appendHistory(fresh.agentId, snap);
          if (fresh.task.taskId) {
            store.blockQueued(fresh.agentId, fresh.task.taskId, 'resumed-in-new-round');
            for (const sub of store.submissionWork(fresh.agentId, fresh.task.taskId)) {
              store.saveSubmissionDelivery(sub.id, { state: 'delivered', deliveredAt: now() }, { expected: sub.deliveryVersion });
            }
          }
        }
        const archivedUsage = sumTwoUsages(fresh.historicalUsage, fresh.task?.usage);
        const cleaned = {
          ...fresh,
          state: 'idle',
          closed: false,
          error: undefined,
          sleep: undefined,
          nextAttemptAt: undefined,
          retryAttempts: 0,
          task: undefined,
          ...(archivedUsage ? { historicalUsage: archivedUsage, usage: archivedUsage } : {}),
          updatedAt: now(),
        };
        delete cleaned.autoCleanupClosed;
        store.db.prepare('UPDATE agents SET body=? WHERE id=?').run(JSON.stringify(cleaned), cleaned.agentId);
        store.touched(cleaned.agentId);
        return store.get(cleaned.agentId);
      };

      const mismatchCodes = new Set([
        'host-ownership-mismatch',
        'codex-thread-not-found',
        'claude-session-not-found',
        'agy-conversation-not-found',
        'session-not-found',
        'thread-not-found',
        'account-switched',
      ]);

      // Stop stuck active process if currently running before resuming
      if (record.state === 'running' || record.state === 'creating') {
        try {
          const b = await backendFor(record);
          await b.cancel?.();
        } catch {}
        record = store.get(record.agentId) ?? record;
      }

      let needsHandoff = mismatchCodes.has(record.error?.code) || mismatchCodes.has(record.task?.treeUnavailable);
      const targetBackend = targetOf(record);
      let currentRoute = null;
      if (isHeadlessCli(targetBackend)) {
        currentRoute = await resolveManagedCliRoute(targetBackend, cliConfigForRecord(record)).catch(() => null);
        const nativeState = store.backendState(record.agentId);
        const priorProfile = record.profileId ?? record.host?.profileId ?? nativeState?.profileId ?? null;
        if (priorProfile && currentRoute?.profileId && priorProfile !== currentRoute.profileId) {
          needsHandoff = true;
        }
        if (!needsHandoff && targetBackend === 'codex-cli' && nativeState?.codexHome && currentRoute?.codexHome
            && pathKey(nativeState.codexHome) !== pathKey(currentRoute.codexHome)) {
          needsHandoff = true;
        }
      }
      if (!needsHandoff) {
        try {
          await checkHost(record);
        } catch (err) {
          if (mismatchCodes.has(err?.code)) needsHandoff = true;
          else throw err;
        }
      }

      const executeAccountHandoff = async recBeforeReset => {
        const handoffPrompt = await buildHandoffPrompt(recBeforeReset);
        let cleaned = resetStoppedRecordForNextTurn(recBeforeReset);
        store.deleteBackendState(cleaned.agentId);
        forgetBackend(cleaned);
        cleaned = {
          ...cleaned,
          sessionId: uid('session-codex'),
          created: false,
          host: undefined,
          ...(currentRoute?.profileId ? { profileId: currentRoute.profileId } : { profileId: undefined }),
          updatedAt: now(),
        };
        store.db.prepare('UPDATE agents SET body=? WHERE id=?').run(JSON.stringify(cleaned), cleaned.agentId);
        store.touched(cleaned.agentId);
        const freshRec = store.get(cleaned.agentId);
        await prepare(freshRec);
        if (currentRoute?.profileId || currentRoute?.codexHome) {
          const ns = store.backendState(freshRec.agentId) ?? { seq: 0, requests: {}, answers: {}, answered: [] };
          store.saveBackendState(freshRec.agentId, {
            ...ns,
            ...(currentRoute.profileId ? { profileId: currentRoute.profileId } : {}),
            ...(currentRoute.codexHome ? { codexHome: currentRoute.codexHome } : {}),
          });
        }
        const addr = managedPath(store.get(freshRec.agentId));
        const sent = await service.send({ name: addr, message: handoffPrompt }, extra);
        const wakeCmd = buildWakeCmd(owner, sent.taskKey);
        return {
          action: 'resume',
          ok: true,
          name: freshRec.name,
          agentPath: addr,
          mode: 'handoff-new-account',
          taskKey: sent.taskKey,
          ...(wakeCmd ? { wakeCmd } : {}),
        };
      };

      if (needsHandoff) {
        return executeAccountHandoff(record);
      }

      // Attempt native session resume first; if native session is unreachable on the active account, fall back to handoff!
      const snapshotBeforeNative = structuredClone(record);
      if (terminalRound(record) || record.state === 'running' || record.state === 'reconnecting' || record.error) {
        record = resetStoppedRecordForNextTurn(record);
      }
      if (!record.created) {
        await prepare(record);
      }
      try {
        const addr = managedPath(record);
        const sent = await service.send({ name: addr, message: continuationMessage }, extra);
        if (sent?.error && mismatchCodes.has(sent.error.code)) {
          return executeAccountHandoff(snapshotBeforeNative);
        }
        // Trigger one immediate poll on headless CLI so synchronous session/account errors surface immediately if mocked
        if (isHeadlessCli(targetBackend)) {
          await service.poll(record.agentId).catch(() => {});
          const postPoll = store.get(record.agentId);
          const lastDisp = postPoll?.task?.dispatches?.at(-1);
          const errCode = postPoll?.error?.code ?? lastDisp?.failure?.code ?? lastDisp?.error?.code;
          if (errCode && mismatchCodes.has(errCode)) {
            return executeAccountHandoff(snapshotBeforeNative);
          }
        }
        const wakeCmd = buildWakeCmd(owner, sent.taskKey);
        return {
          action: 'resume',
          ok: true,
          name: record.name,
          agentPath: addr,
          mode: 'native-resume',
          taskKey: sent.taskKey,
          ...(wakeCmd ? { wakeCmd } : {}),
        };
      } catch (err) {
        if (mismatchCodes.has(err?.code)) {
          return executeAccountHandoff(snapshotBeforeNative);
        }
        throw err;
      }
    },
    async manageCliProxy({ action = 'status', target = 'all', proxy } = {}) {
      if (!['status', 'bind'].includes(action)) {
        throw Object.assign(new Error('action must be "status" or "bind".'), { code: 'invalid-proxy-action' });
      }
      if (!isHeadlessCli(target) && target !== 'all') {
        throw Object.assign(new Error('target must be "codex-cli", "claude-cli", "agy-cli", or "all".'), { code: 'invalid-proxy-target' });
      }
      const targets = target === 'all' ? HEADLESS_CLI_TARGETS : [target];
      if (action === 'bind') {
        if (proxy === undefined || proxy === null || String(proxy).trim() === '') {
          throw Object.assign(new Error('proxy value is required for action="bind".'), { code: 'invalid-proxy-config' });
        }
        const trimmed = typeof proxy === 'string' ? proxy.trim() : '';
        const resetToFaswitch = typeof proxy === 'string' && ['faswitch', 'auto'].includes(trimmed.toLowerCase());
        const normalizedValue = resetToFaswitch
          ? undefined
          : (typeof proxy === 'string' && /^\d{1,5}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : proxy);
        if (!resetToFaswitch) normalizeProxySpec(normalizedValue);
        await updateCliRoutes(config, { targets, value: normalizedValue, resetToFaswitch });
      }
      const routes = await Promise.all(targets.map(async t => {
        const route = await resolveManagedCliRoute(t, config);
        const effectiveMode = route.source === 'manual'
          ? (route.mode === 'direct' ? 'direct' : 'manual')
          : (route.source === 'faswitch' ? 'faswitch' : route.mode === 'direct' ? 'direct' : 'inherit');
        return {
          target: t,
          ok: route.ok === true,
          effectiveMode,
          source: route.source ?? 'inherit',
          mode: route.mode ?? null,
          port: route.port ?? null,
          proxyUrl: route.proxyUrl ? redactProxyCredentials(route.proxyUrl) : null,
          profileName: route.profileName ?? null,
          profileId: route.profileId ?? null,
          proxyReachable: route.proxyReachable ?? null,
          ...(route.configuredVia ? { configuredVia: route.configuredVia } : {}),
          ...(!route.ok && route.code ? { code: route.code } : {}),
          ...(route.error ? { error: redactProxyCredentials(route.error) } : {}),
        };
      }));
      const failed = routes.find(r => !r.ok);
      return {
        ok: !failed,
        action,
        target,
        routes,
        ...(failed ? {
          error: {
            code: failed.code ?? 'proxy-unavailable',
            message: failed.error ?? `Proxy check failed for ${failed.target}.`,
          },
        } : {}),
      };
    },
    async gc({ onceRetentionMs = config.onceTerminalRetentionMs, idleRetentionMs = config.agentIdleRetentionMs, nowMs = Date.now() } = {}) {
      if (config.agentAutoCleanup === false) return { enabled: false, removed: [] };
      const removedTrees = [];
      for (const candidate of store.list()) {
        if (!candidate.worktreePath || !["idle", "completed"].includes(candidate.state)) continue;
        const stamp = Date.parse(candidate.task?.finishedAt ?? candidate.updatedAt ?? candidate.createdAt ?? "");
        const threshold = candidate.lifetime === "once" ? onceRetentionMs : idleRetentionMs;
        if (!Number.isFinite(stamp) || nowMs - stamp < (threshold ?? (candidate.lifetime === "once" ? 86400000 : 43200000))) continue;
        try {
          await store.locked(candidate.agentId, async () => {
            const fresh = store.get(candidate.agentId);
            if (JSON.stringify(fresh) !== JSON.stringify(candidate) || store.childrenOf(fresh.agentId).length
                || fresh.cleanupRosterTicket || owesWork(fresh)) return;
            const hold = store.autoCleanupHold(fresh.agentId);
            if (hold.pending || hold.blocked) return;
            const unchanged = () => JSON.stringify(store.get(fresh.agentId)) === JSON.stringify(fresh);
            await removeOwnedWorktree(fresh, { recheck: unchanged });
            if (!unchanged()) return;
            store.remove(fresh, { deliveredReceipt: true });
            removedTrees.push({ agentId: fresh.agentId, ownerId: fresh.ownerId, name: fresh.name, target: targetOf(fresh) });
          }, { waitMs: 0 });
        } catch { /* retain the record and retry after the next scan */ }
      }
      const removed = [...removedTrees, ...store.gcStaleAgents({ onceRetentionMs, idleRetentionMs, nowMs })];
      for (const entry of removed) await removeScopedDirectory(agentDirectory(entry)).catch(() => {});
      return { enabled: true, removed };
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
      waitsClosed = true;
      wakeWaiters();
      for (const controller of releaseSignals.values()) controller.abort();
      releaseSignals.clear();
      store.close();
    },
  };

  function permissionDenied() {
    return Object.assign(new Error("This operation is outside the caller’s managed authority."), { code: "permission-denied" });
  }

  function boardActor(route, rootOwnerId) {
    const actor = store.get(route.authorAgentId);
    if (!actor || actor.closed || rootOwnerIdForRecord(actor) !== rootOwnerId
        || !route.authorTaskId || !route.authorRequestId || actor.task?.taskId !== route.authorTaskId
        || activeManagedRequestId(actor.task) !== route.authorRequestId
        || actor.task?.cancelRequested || terminalRound(actor) || !["running", "awaiting_input", "awaiting_report"].includes(actor.state)) return undefined;
    return actor;
  }

  function isBoardAuthority(route, rootOwnerId) {
    if (!route.authorAgentId) return true;
    const actor = boardActor(route, rootOwnerId);
    if (!actor) return false;
    const tier = classifyManagedRole(actor.role ?? inferRoleFromName(actor.name), { teamConfigPath });
    return tier === 'lead' || tier === 'review';
  }

  function finalizeBoardDispatch(record, route, dispatch, action) {
    if (dispatch.accepted) {
      const taskKey = store.saveTaskKey(record.ownerId, record.agentId, route.requestId, record.task.taskId);
      store.finishBoardRoute(route, { action: route.revived ? "revived" : action, taskKey,
        ...(route.revived ? { resumedSession: route.resumedSession === true } : {}) });
    } else if (["failed", "blocked", "cancelled", "unknown"].includes(dispatch.state)) {
      store.finishBoardRoute(route, { action: "failed", error: dispatch.error ?? { code: "board-delivery-unconfirmed" } });
    }
  }

  async function routeBoardLocked(record, route) {
    const task = record.task;
    const prior = task?.dispatches?.find(dispatch => dispatch.requestId === route.requestId);
    if (prior) {
      finalizeBoardDispatch(record, route, prior, prior.boardAction ?? "woken");
      return false;
    }
    const migration = task?.preemption;
    if (migration && migration.requestId !== route.requestId) return false;
    if (!migration && ((route.taskId && task?.taskId !== route.taskId)
        || rootOwnerIdForRecord(record) !== route.rootOwner || record.closed || record.worktreeMerge
        || (route.urgent && (!isBoardAuthority(route, route.rootOwner)
          || (route.authorAgentId && !isDescendant(store, record, route.authorAgentId)))))) {
      store.finishBoardRoute(route, { action: "failed", error: { code: "board-route-stale" } });
      return false;
    }
    if (!record.created) return false;
    const message = boardPrompt(route.author, route.text);
    if (!task || record.state === "idle" || terminalRound(record)) {
      if (owesWork(record) || (task?.autoCleanupPending && record.lifetime === "once")) return false;
      const next = { ...record, state: "running", observation: undefined, error: undefined, sleep: undefined,
        task: { taskId: uid("task"), requestId: route.requestId, message, mode: "steer", state: "starting",
          startedAt: now(), dispatches: [], answers: [], modelSelection: record.modelPin ?? null, boardOnly: true,
          boardAction: route.urgent ? "woken-urgent" : "woken" } };
      invalidateRelease(next);
      if (!store.replaceTask(next, record, task ? { ...task } : undefined)) return false;
      Object.assign(record, next);
      await beginTask(record);
      const dispatch = record.task.dispatches.find(item => item.requestId === route.requestId);
      if (dispatch) finalizeBoardDispatch(record, route, dispatch, record.task.boardAction);
      return true;
    }
    if (task.cancelRequested || task.result || task.reports?.some(report => report.final)
        || store.hasFinalNotice(record.agentId, task.taskId)) return false;
    if (migration?.retryAt > Date.now()) return true;
    const view = migration ? record.observation ?? {} : await observeOwn(record);
    if (!route.urgent && (view.running || pendingIn(view).length || store.openQuestions(record).unanswered
        || store.openQuestions(record).undelivered || (task.answers ?? []).some(answer => !answer.dispatched))) return false;
    const cli = isHeadlessCli(targetOf(record));
    const old = task.dispatches.at(-1);
    const stop = cli && Boolean(migration?.stop ?? (view.running === true && old?.requestId));
    let active = record;
    let proof = migration?.proof;
    if (route.urgent && cli) {
      if (!old && !migration) await negotiateTree(record);
      const backend = await backendFor(record);
      if (stop && !backend.preemptTurn) {
        store.finishBoardRoute(route, { action: "failed", error: { code: "preemption-unavailable" } });
        return false;
      }
      active = migration ? record : store.beginPreemption(record, route, { stop, oldRequestId: old?.requestId });
      if (!active) return false;
      if (stop && !proof) {
        try {
          proof = await backend.preemptTurn(active, { expectedRequestId: old.requestId });
        } catch (error) {
          active.task.preemption.retryAt = Date.now() + 1000;
          store.save(active);
          return true;
        }
        if (proof?.ok !== true || proof.stopped !== true) {
          store.abortPreemption(active);
          store.finishBoardRoute(route, { action: "failed", error: { code: "preemption-unconfirmed" } });
          return true;
        }
        active.task.preemption.proof = { sessionId: proof.sessionId, sessionResumable: proof.sessionResumable, sessionCwd: proof.sessionCwd };
        store.save(active);
        proof = active.task.preemption.proof;
      }
    }
    if (stop && proof) {
      const native = store.backendState(active.agentId);
      if (native) {
        if (native.active === old.requestId) delete native.active;
        const target = targetOf(active);
        const sessionKey = target === "codex-cli" ? "threadId" : target === "agy-cli" ? "conversationId" : "sessionId";
        if (proof.sessionResumable === false) {
          native.started = false;
          delete native[sessionKey];
          delete native.sessionCwd;
        } else if (proof.sessionId) {
          native.started = true;
          native[sessionKey] = proof.sessionId;
          if (proof.sessionCwd) native.sessionCwd = proof.sessionCwd;
        }
        store.saveBackendState(active.agentId, native);
      }
    }
    const restartFresh = cli && route.urgent && (proof?.sessionResumable === false || !old);
    const action = stop ? "preempted" : route.urgent ? "woken-urgent" : "woken";
    const previous = active.task.dispatches.at(-1);
    if (stop && previous) Object.assign(previous, { state: "completed", preemptedBy: route.requestId });
    const prompt = restartFresh ? (active.task.dispatches[0]?.message ?? active.task.message) + "\n\n" + message : message;
    const dispatch = await sendDispatch(active, prompt, "board", [], route.requestId,
      stop ? { ...view, running: false } : view, { mode: "steer", boardAction: action, ...(restartFresh ? { restartFresh: true } : {}) });
    Object.assign(record, active);
    finalizeBoardDispatch(record, route, dispatch, action);
    return true;
  }

  async function routeBoardTarget(agentId) {
    try {
      return await store.locked(agentId, async () => {
        const route = store.boardRoutes(agentId)[0];
        if (!route) return;
        const record = store.get(agentId);
        if (record && !record.closed) return routeBoardLocked(record, route);
        if (record) return;
        const stub = store.listAgentStubs(route.rootOwner).find(item => item.agentId === agentId);
        if (!stub || (route.urgent && (!isBoardAuthority(route, route.rootOwner)
            || (route.authorAgentId && !isDescendant(store, stub, route.authorAgentId))))) {
          return store.finishBoardRoute(route, { action: "failed", error: { code: "board-route-stale" } });
        }
        const findRevived = () => store.list(stub.ownerId).find(member => !member.closed && member.revivedFrom === agentId);
        let revived = findRevived();
        if (!revived) {
          const stubExtra = targetCallerExtraForOwner(stub.ownerId, stub);
          const created = await service.create({ name: stub.name, role: stub.role ?? undefined, lifetime: "once",
            target: stub.target, model: stub.model ?? undefined, _revivedSessionId: stub.resumeSessionId,
            _revivedFrom: agentId, _revivedReadOnlyScout: stub.readOnlyScout }, stubExtra);
          if (created.created !== true || created.error) return;
          revived = findRevived();
        }
        if (!revived?.created) return;
        store.retargetBoardRoutes(agentId, revived.agentId, { resumedSession: Boolean(stub.resumeSessionId) });
        store.deleteAgentStub(agentId);
        const replacement = store.boardRoutes(revived.agentId)[0];
        await store.locked(revived.agentId, async () => {
          if (replacement) await routeBoardLocked(revived, replacement);
        }, { waitMs: 40 });
      }, { waitMs: 40 });
    } catch (error) {
      if (!["agent-busy", "round-finished"].includes(error.code)) {
        // A durable intent will be reconciled on the next monitor pass.
        const record = store.get(agentId);
        if (record) announceWork(record.agentId);
      }
    }
  }

  const pendingIn = view => (view?.questions ?? []).filter(question => question.state === 'pending');

  function targetCallerExtraForOwner(targetOwnerId, targetRecordOrStub) {
    const trustedSym = Symbol.for('futureaide.trustedCaller');
    const targetOwner = store.owner(targetOwnerId);
    if (targetRecordOrStub?.parentAgentId) {
      return {
        [trustedSym]: {
          source: 'managed-cli',
          parentAgentId: targetRecordOrStub.parentAgentId,
          ownerId: targetOwnerId,
          workspace: targetRecordOrStub.workspace ?? targetOwner?.workspace ?? config.workspace,
        },
      };
    }
    if (targetOwner?.source === 'antigravity') {
      return {
        [trustedSym]: {
          source: 'antigravity',
          conversationId: targetOwner.conversationId,
          workspace: targetOwner.workspace,
        },
      };
    }
    if (targetOwner?.source === 'claude-desktop') {
      return {
        [trustedSym]: {
          source: 'claude-desktop',
          nativeSessionId: targetOwner.nativeSessionId,
          workspace: targetOwner.workspace,
        },
      };
    }
    if (targetOwner?.source === 'codex-desktop' && targetOwner.threadId) {
      return { _meta: { threadId: targetOwner.threadId } };
    }
    return {
      [trustedSym]: {
        source: 'managed-cli',
        ownerId: targetOwnerId,
        workspace: targetRecordOrStub?.workspace ?? targetOwner?.workspace ?? config.workspace,
      },
    };
  }

  function schedulePullSettlement(agentId) {
    if (!agentId || draining || waitsClosed) return;
    const prior = settlementInflight.get(agentId);
    const work = (prior ? prior.catch(() => {}) : Promise.resolve()).then(async () => {
      const delays = [0, 40, 120, 300, 800];
      for (const ms of delays) {
        if (waitsClosed || (ms > 0 && draining)) return;
        if (ms > 0) {
          await new Promise(resolve => {
            const t = setTimeout(resolve, ms);
            t.unref?.();
          });
        }
        if (waitsClosed || (ms > 0 && draining)) return;
        let current;
        try { current = store.get(agentId); } catch { return; }
        if (!current || current.closed) return;
        try {
          await store.locked(agentId, async () => {
            if (waitsClosed) return;
            const fresh = store.get(agentId);
            if (!fresh || fresh.closed || !fresh.task) return;
            if (isHeadlessCli(targetOf(fresh))) {
              await observe(fresh).catch(() => {});
              store.save(fresh);
            }
            await settleDelivery(fresh);
          }, { waitMs: 60 });
        } catch {}
        if (waitsClosed) return;
        let after;
        try { after = store.get(agentId); } catch { return; }
        if (!after) return;
        const hasDeliveredFinal = (after.task?.reports ?? []).some(r => r.final && r.delivery?.state === 'delivered');
        if (!(after.lifetime === 'once' && hasDeliveredFinal)) return;
      }
    }).finally(() => {
      if (settlementInflight.get(agentId) === work) settlementInflight.delete(agentId);
    });
    settlementInflight.set(agentId, work);
  }

  function acknowledgePulledDeliveries(_owner, deliveries, batch) {
    if (!deliveries.length) return;
    const deliveredAt = now();
    const agentsToSettle = new Set();
    for (const item of deliveries) {
      const { mapping, submissionId, kind, final, eventId } = item;
      if (!mapping?.agentId || !submissionId) continue;
      if (eventId && Array.isArray(batch)) {
        const matchedEvt = batch.find(e => e.id === eventId);
        if (matchedEvt && 'delivery' in matchedEvt) {
          matchedEvt.delivery = 'delivered';
          delete matchedEvt.error;
        }
      }
      const workRows = store.submissionWork(mapping.agentId, mapping.taskId);
      const subRow = workRows.find(r => r.id === submissionId);
      if (subRow && subRow.delivery?.state !== 'delivered') {
        store.saveSubmissionDelivery(submissionId, {
          ...subRow.delivery,
          id: subRow.delivery?.id ?? submissionNoticeId(submissionId),
          state: 'delivered',
          deliveredAt,
          error: undefined,
        }, { expected: subRow.deliveryVersion });
      }
      const record = store.get(mapping.agentId);
      if (record && !record.closed && record.task?.taskId === mapping.taskId) {
        const pendingSubs = store.submissions(mapping.agentId, mapping.taskId, true);
        if (pendingSubs.length) absorbSubmissions(record, pendingSubs);
        let mutated = false;
        if (kind === 'ask') {
          const ref = submissionRef(submissionId);
          record.task.questionNotices ??= {};
          const qNotice = record.task.questionNotices[ref] ?? { id: submissionNoticeId(submissionId), createdAt: deliveredAt };
          if (qNotice.state !== 'delivered') {
            record.task.questionNotices[ref] = { ...qNotice, state: 'delivered', deliveredAt, error: undefined };
            mutated = true;
          }
        } else {
          record.task.reports ??= [];
          let rep = record.task.reports.find(r => sameReportId(r.id, submissionId) || r.sharedSubmission === submissionId);
          if (!rep && subRow) {
            rep = {
              id: submissionRef(submissionId),
              taskId: mapping.taskId,
              message: subRow.message,
              final: subRow.final === true,
              createdAt: subRow.created,
              sharedSubmission: submissionId,
              delivery: { id: submissionNoticeId(submissionId), state: 'delivered', createdAt: subRow.created, deliveredAt },
            };
            record.task.reports.push(rep);
            mutated = true;
          } else if (rep && rep.delivery?.state !== 'delivered') {
            rep.delivery = { ...(rep.delivery ?? {}), state: 'delivered', deliveredAt, error: undefined };
            mutated = true;
          }
          if ((final || rep?.final) && rep) {
            const noActiveChildren = !store.childrenOf(record.agentId).some(c => !c.closed && ACTIVE.has(c.state));
            if (isHeadlessCli(targetOf(record)) && noActiveChildren) {
              rep.treeSettledConfirmed = true;
              record.task.result ??= {
                state: 'completed',
                reply: rep.message,
                changes: attributedChanges(record, record.observation ?? {}),
                coverage: treeCoverage(record, record.observation ?? {}),
                tree: publicTree(record, record.observation ?? {}),
              };
              record.task.state = 'completed';
              mutated = true;
            }
          }
        }
        if (mutated) {
          try { store.save(record); } catch {}
        }
        agentsToSettle.add(mapping.agentId);
      }
    }
    for (const agentId of agentsToSettle) {
      schedulePullSettlement(agentId);
    }
  }

  /**
   * The receipt for an answer whose question was consumed before it could be sent.
   * It is deliberately not an error: nothing was written, and the caller is told
   * which questions are pending now. A different pending question is never answered
   * with this text, which would otherwise cross from the old question to the new one.
   */
  function consumedAnswer(record, view, reason = 'question-not-pending') {
    return { name: record.name, answered: false, delivered: false, queued: false,
      state: record.state, reason, pendingQuestions: pendingIn(view).map(question => question.message),
      note: reason === 'question-changed'
        ? 'The question this answer belonged to is no longer pending; a different question is pending now, so nothing was sent.'
        : 'The question was already consumed or is no longer pending, so this answer was not sent.' };
  }

  async function answerLocked(record, message, answerId, { questionIds, modelSelection } = {}) {
    if (!record.task || record.closed || record.task.cancelRequested) throw new Error('This subagent has no open task waiting for an answer.');
    // A finished round cannot be answered: its question is only information by then.
    if (terminalRound(record)) throw Object.assign(new Error('This subagent’s round has already ended, so the question is only information; the answer was not delivered.'),
      { code: 'round-finished', terminal: true });
    // Keep the pending state the caller could have seen before this call observes the
    // target. If that question is gone but another one is pending, the answer belongs
    // to the old question and must not consume the new one.
    const seenPending = pendingIn(record.observation);
    await negotiateTree(record);
    await checkHost(record);
    const view = await observe(record);
    const pending = pendingIn(view);
    const existing = answerId && (record.task.answers ?? []).find(answer => answer.answerId === answerId);
    if (existing && (!existing.explicit || existing.message !== message
        || (questionIds && (questionIds.length !== existing.questionIdsSeen?.length
          || !questionIds.every(id => existing.questionIdsSeen.includes(id)))))) {
      return consumedAnswer(record, view, "question-changed");
    }
    if (existing?.questionIds) return { name: record.name, answered: true, state: record.state, questionIds: existing.questionIds,
      answerId: existing.answerId, ...(existing.nativeAnswered ? { delivery: "native-question" } : {}) };
    const ordered = store.submissionsInOrder(record.agentId, record.task.taskId)
      .filter(item => item.kind === "ask").map(item => submissionRef(item.id));
    const selected = existing?.questionIdsSeen ?? questionIds ?? [ordered.find(id => pending.some(question => question.id === id))
      ?? (seenPending[0]?.id ?? pending[0]?.id)].filter(Boolean);
    const noSend = (reason, actual) => consumedAnswer(record, actual, reason);
    if (!pending.length && !(existing && confirmedAnswer(record, existing))) return noSend("question-not-pending", view);
    if ((!selected.length || !selected.every(id => pending.some(question => question.id === id)))
        && !(existing && confirmedAnswer(record, existing))) return noSend("question-changed", view);
    record.task.answers ??= [];
    const answer = existing ?? { answerId: answerId ?? uid("answer"), message, dispatched: false, explicit: true,
      questionIdsSeen: selected, created: now(), modelSelection: modelSelection ? { ...modelSelection } : null };
    if (!existing) record.task.answers.push(answer);
    if (!store.saveAnswerWithTaskKey(record, answer.answerId)) throw dispatchRefused();
    try {
      if (!(await resolveAnswer(record, answer, { questionIds: answer.questionIdsSeen }))) {
        return { name: record.name, answered: false, state: record.state, error: safeError(dispatchRefused('dispatch-expired')) };
      }
    } catch (error) {
      // The backend may lose the same race after the preflight: its question was
      // consumed between observe() and the native write. That is a settled no-send,
      // not a failed answer, so keep its intent from being retried and report it.
      if (error?.code === 'question-not-pending' || error?.code === 'question-changed'
          || error?.code === 'native-question-not-pending') {
        if (!answer.questionIds && !answer.dispatched) {
          Object.assign(answer, { dispatched: true, undelivered: error.code });
          saveDispatch(record);
        }
        // The preflight page still showed the question the backend just refused.
        // Prefer the bridge's own actual pending list; otherwise read once more so
        // pendingQuestions describes the actual state, not that stale page. A failed
        // read means no pending question is provable.
        let actual;
        if (Array.isArray(error.pendingQuestions)) {
          actual = { questions: error.pendingQuestions.map((message, index) => ({
            id: `pending-${index}`, message, state: 'pending' })) };
        } else {
          actual = { questions: [] };
          try { actual = await observe(record); } catch { /* keep the empty state */ }
        }
        return consumedAnswer(record, actual,
          error.code === 'question-changed' ? 'question-changed' : 'question-not-pending');
      }
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
    return { name: record.name, answered: true, state: 'resuming', answerId: answer.answerId, questionIds: answer.questionIds,
      ...(answer.nativeAnswered ? { delivery: 'native-question', ...(answer.turnId ? { turnId: answer.turnId } : {}) } : answer.nativeFallback ? { delivery: 'continuation-queued' } : {}),
      ...effortReceipt(answer.modelSelection, answer.actualEffort ?? null, undefined, answer.actualEffortSource),
      actualModel: actualModelName(answer.modelSelection) ?? actualModelName(record.model) };
  }
  // Keep the public entry that caused native reads attached across asynchronous work.
  // The context carries identifiers only, never task or conversation content.
  for (const [name, action] of Object.entries(service)) {
    if (typeof action !== 'function') continue;
    service[name] = function (...args) {
      if (!codexInstrumentationEnabled()) return action.apply(this, args);
      const parent = getCodexInstrumentation();
      const fields = { source: parent.source ?? name, currentStage: name,
        initiatorRole: parent.initiatorRole ?? (process.argv[1]?.endsWith('scoped-worker.mjs') ? 'monitor' : 'mcp'),
        initiatorPid: process.pid, operationId: parent.operationId ?? randomUUID(),
        ...(name === 'poll' && typeof args[0] === 'string' ? { agentId: args[0] } : {}) };
      return withCodexInstrumentation(fields, () => action.apply(this, args));
    };
  }
  return service;
}
