import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RosterStore } from './roster-store.mjs';
import { EventCollector } from './cli-agent-events.mjs';
import { createMcpConfig, killProcessTree, spawnCliTurn } from './cli-agent-execution.mjs';
import { createRuntimeAdapter } from './cli-agent-adapters.mjs';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const uid = prefix => `${prefix}-${randomUUID().replaceAll('-', '')}`;
const now = () => new Date().toISOString();
const ACTIVE = new Set(['creating', 'running', 'awaiting_input', 'awaiting_report', 'delivery_pending', 'reconnecting']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const WAIT_STATES = new Set(['awaiting_input', 'awaiting_report', 'awaiting_descendants', 'cancelled', 'idle', 'delivery_pending', 'cleanup_failed', 'failed']);
const RUNTIMES = new Set(['claude', 'codex']);
const DELIVERY_STATES = new Set(['delivered', 'pending', 'blocked', 'unknown']);

const safeError = error => ({ code: error?.code ?? 'operation-failed',
  message: String(error?.message ?? error).replace(/((?:token|api[_-]?key|authorization|password)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]').slice(0, 1200) });
const compactText = (value, length) => typeof value === 'string' && value.length > length ? value.slice(0, length) + '…' : value;
const redactTail = value => String(value ?? '').slice(-4000)
  .replace(/((?:token|api[_-]?key|authorization|password)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]');
const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');
export const managedOwnerIdFor = agentId => 'owner-' + createHash('sha256').update(`managed:${agentId}`).digest('hex').slice(0, 32);
function tokenMatches(savedHash, token) {
  if (typeof savedHash !== 'string' || typeof token !== 'string' || !savedHash || !token) return false;
  const left = Buffer.from(savedHash, 'hex');
  const right = Buffer.from(tokenHash(token), 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function assertName(name) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name)) {
    throw new Error('Use a nonempty subagent name of at most 80 characters, without leading/trailing whitespace.');
  }
  return name;
}

function textMessage(message, label = 'message') {
  if (typeof message !== 'string' || !message.trim() || message.length > 100000) {
    throw new Error(`A ${label} of 1–100000 characters is required.`);
  }
  return message;
}

function isWindowsDriveC(value) {
  return process.platform === 'win32' && /^c:/i.test(path.resolve(value).replace(/^\\\\\?\\/, ''));
}

function assertOwnedRoot(root, label) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error(`${label} must be an absolute path.`);
  if (isWindowsDriveC(root)) throw Object.assign(new Error(`${label} must not be on drive C.`), { code: 'c-drive-write-refused' });
  return path.resolve(root);
}

function assertInside(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} is outside its owned root.`);
  return path.resolve(candidate);
}

function sameWorkspace(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function ownerSnapshot(context, record) {
  return {
    ownerId: context.ownerId,
    threadId: context.threadId,
    workspace: context.workspace,
    client: context.client,
    ...(context.profileId ? { profileId: context.profileId } : {}),
    ...(context.parentAgentId ? { parentAgentId: context.parentAgentId } : {}),
    ...(context.parentTaskId ? { parentTaskId: context.parentTaskId } : {}),
    ...(record?.owner ? { saved: record.owner } : {}),
  };
}

function reportSummary(report) {
  return { message: compactText(report.message, 240), final: report.final === true, delivery: report.delivery?.state ?? 'pending' };
}

function publicResult(record, { fullResult = false } = {}) {
  const task = record.task;
  const lastDispatch = task?.dispatches?.at(-1);
  const error = record.error ?? lastDispatch?.error;
  const changes = task?.changes ?? [];
  const reports = task?.reports ?? [];
  return {
    name: record.name,
    runtime: record.runtime,
    lifetime: record.lifetime,
    state: record.state,
    task: task ? {
      text: compactText(task.message, 240),
      state: task.state,
      startedAt: task.startedAt,
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.result ? { result: { state: task.result.state,
        ...(fullResult ? { reply: task.result.reply } : { summary: compactText(task.result.reply, 800) }),
        files: (task.result.changes ?? []).slice(0, 12) } } : {}),
    } : null,
    activity: task?.activity ?? (record.state === 'idle' ? 'Waiting for a task' : record.state),
    changes: { count: changes.length, files: changes.slice(0, 12),
      coverage: { source: 'cli-json-events', complete: false,
        limitation: 'Only file paths present in CLI tool events are attributed; shell and external writes are not inferred.' },
      observedAt: task?.finishedAt ?? task?.startedAt ?? null },
    questions: (task?.questions ?? []).filter(question => question.state === 'pending').map(question => ({ message: question.message })),
    reports: { total: reports.length, pending: reports.filter(report => report.delivery?.state !== 'delivered').length,
      ...(reports.length ? { latest: reportSummary(reports.at(-1)) } : {}) },
    delivery: reports.find(report => report.delivery?.state !== 'delivered')?.delivery?.state
      ?? reports.at(-1)?.delivery?.state ?? null,
    worker: record.workerPid ? 'running' : 'stopped',
    updatedAt: record.updatedAt,
    ...(error ? { error } : {}),
  };
}

/** Spawn the detached worker that owns one agent's active turn queue. */
export async function workerSpawn(configFile, agentId, lease, spawnProcess = spawn) {
  if (!configFile) throw new Error('The installed plugin has no private configuration path for recovery.');
  if (!/^agent-[a-f0-9]{32}$/.test(agentId ?? '')) throw new Error('Invalid internal agent identity.');
  if (!/^worker-[a-f0-9]{32}$/.test(lease ?? '')) throw new Error('Invalid internal worker lease.');
  const script = fileURLToPath(new URL('./cli-agent-worker.mjs', import.meta.url));
  const child = spawnProcess(process.execPath, [script, '--config', configFile, '--agent', agentId, '--lease', lease], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}

async function defaultResolveContext(extra) {
  try {
    const module = await import('./mutual-context.mjs');
    const resolve = module.resolveMutualContext ?? module.resolveContext ?? module.default;
    if (typeof resolve !== 'function') throw new Error('The mutual context provider is not installed.');
    return resolve(extra);
  } catch (error) {
    throw Object.assign(new Error('The mutual context provider is not installed.'), { code: 'mutual-context-unavailable', cause: error });
  }
}

async function defaultResolveEnvironment(input) {
  const module = await import('./runtime-environment.mjs');
  return module.resolveRuntimeEnvironment(input);
}

async function defaultNotify(notice, config) {
  const { notifyParent } = await import('./mutual-notify.mjs');
  return notifyParent(notice, config);
}

async function cleanupQuietly(environment) {
  if (typeof environment?.cleanup !== 'function') return;
  try { await environment.cleanup(); } catch { /* Cleanup errors are recorded by the caller when possible. */ }
}

/**
 * Name-addressed CLI agent service. It deliberately uses its own roster file and
 * leaves the verified DSH service untouched.
 */
export function createCliAgents(config, {
  store,
  resolveContext = defaultResolveContext,
  resolveEnvironment = defaultResolveEnvironment,
  notify = defaultNotify,
  startWorker = (configFile, agentId, lease) => workerSpawn(configFile, agentId, lease),
  runTurn = spawnCliTurn,
  adapterFor = createRuntimeAdapter,
  killTree = killProcessTree,
  moveDirectory = rename,
  cleanDirectory,
  mutualServerEntry,
} = {}) {
  if (!config || typeof config !== 'object') throw new Error('A loaded configuration is required.');
  const stateRoot = assertOwnedRoot(config.cliStateDirectory ?? config.stateDirectory ?? path.join(process.cwd(), '.cli-agents'), 'CLI agent state directory');
  const agentsRoot = assertOwnedRoot(path.join(stateRoot, 'cli-agents'), 'CLI agent private state root');
  const cleanRoot = assertOwnedRoot(cleanDirectory ?? config.cleanDirectory ?? path.join(stateRoot, 'clean'), 'CLI agent clean directory');
  if (config.tempDirectory) assertOwnedRoot(config.tempDirectory, 'CLI agent temp directory');
  const roster = store ?? new RosterStore(path.join(stateRoot, 'cli-roster.sqlite'));
  const childServerEntry = path.resolve(mutualServerEntry ?? config.mutualServerEntry ?? fileURLToPath(new URL('./mutual-server.mjs', import.meta.url)));
  const operationWaitMs = Number.isFinite(config.operationWaitMs) ? config.operationWaitMs : 10000;

  const agentDirectory = record => path.join(agentsRoot, record.ownerId, record.agentId);

  async function context(extra) {
    const caller = extra?._resolved === true ? extra : await resolveContext(extra);
    if (!caller || typeof caller !== 'object') throw new Error('The calling context provider returned no context.');
    for (const field of ['ownerId', 'threadId', 'workspace', 'client']) {
      if (typeof caller[field] !== 'string' || !caller[field].trim()) {
        throw Object.assign(new Error(`The calling context has no valid ${field}.`), { code: 'calling-context-unavailable' });
      }
    }
    if (typeof caller.workspace !== 'string' || !path.isAbsolute(caller.workspace)) {
      throw Object.assign(new Error('The calling context project must be an absolute path.'), { code: 'calling-context-unavailable' });
    }
    let workspace;
    try { workspace = extra?._resolved === true ? caller.workspace : await realpath(caller.workspace); }
    catch { throw Object.assign(new Error('The calling context project does not exist.'), { code: 'calling-context-unavailable' }); }
    const owner = { ...caller, workspace };
    if (extra?._resolved !== true) roster.saveOwner(owner);
    return owner;
  }

  async function managedContext(agentId, tokenOrTaskId, maybeToken) {
    const expectedTaskId = maybeToken !== undefined ? tokenOrTaskId : undefined;
    const token = maybeToken !== undefined ? maybeToken : tokenOrTaskId;
    if (typeof agentId !== 'string' || !/^agent-[a-f0-9]{32}$/.test(agentId)
        || typeof token !== 'string' || !token) {
      throw Object.assign(new Error('The managed CLI agent token is invalid.'), { code: 'managed-token-invalid' });
    }
    const record = roster.get(agentId);
    const task = record?.task;
    if (!record || record.closed || !task || task.cancelRequested || !tokenMatches(task.managedTokenHash, token)
        || (expectedTaskId !== undefined && expectedTaskId !== task.taskId)) {
      throw Object.assign(new Error('The managed CLI agent token is not valid for the current task.'), { code: 'managed-token-invalid' });
    }
    const parentOwner = record.owner?.ownerId ? record.owner : undefined;
    const chatOwnerId = parentOwner?.ownerId ?? record.ownerId;
    const subOwnerId = managedOwnerIdFor(record.agentId);
    const reportContext = {
      _resolved: true, agentId, taskId: task.taskId,
      ownerId: chatOwnerId,
      parentOwnerId: chatOwnerId,
      threadId: parentOwner?.threadId ?? record.owner.threadId,
      workspace: parentOwner?.workspace ?? record.workspace,
      client: 'managed-cli',
      ...(parentOwner?.profileId ? { profileId: parentOwner.profileId } : {}),
      parentAgentId: record.agentId, parentTaskId: task.taskId,
    };
    return { ...reportContext, ownerId: subOwnerId, threadId: record.cliSessionId, parentOwnerId: chatOwnerId, reportContext };
  }

  async function callerContext(extra) {
    if (extra?._resolved === true) return context(extra);
    if (extra && typeof extra.agentId === 'string' && typeof extra.token === 'string') {
      return managedContext(extra.agentId, extra.token);
    }
    return context(extra);
  }

  function named(owner, name) {
    const record = roster.named(owner.ownerId, assertName(name));
    if (!record) throw Object.assign(new Error(`No CLI agent named “${name}” exists in this chat.`), { code: 'agent-not-found' });
    return record;
  }

  function sameOwner(record, owner) {
    if (!record || !owner) return false;
    const ownerIds = new Set([record.ownerId, record.owner?.ownerId].filter(Boolean));
    return ownerIds.has(owner.ownerId)
      && (!record.owner?.threadId || record.owner.threadId === owner.threadId);
  }

  async function withName(extra, name, action, options = {}) {
    const owner = await context(extra);
    const record = named(owner, name);
    if (!sameOwner(record, owner) || !sameWorkspace(record.workspace, owner.workspace)) {
      throw Object.assign(new Error('This chat is bound to another project.'), { code: 'workspace-mismatch' });
    }
    return roster.locked(record.agentId, async () => {
      const fresh = roster.get(record.agentId);
      if (!fresh || !sameOwner(fresh, owner)) throw new Error('This CLI agent instance has already been removed.');
      if (!sameWorkspace(fresh.workspace, owner.workspace)) {
        throw Object.assign(new Error('This CLI agent is bound to another project.'), { code: 'workspace-mismatch' });
      }
      return action(fresh, owner);
    }, { waitMs: options.waitMs ?? operationWaitMs });
  }

  async function environmentFor(record, caller) {
    const binding = {
      ...(config.binding ?? {}),
      ...(record.binding ?? {}),
      ...(caller?.profileId ? { profileId: caller.profileId } : {}),
    };
    const observed = await resolveEnvironment({ runtime: record.runtime, binding, directory: record.directory, config });
    if (!observed || typeof observed.executable !== 'string' || !path.isAbsolute(observed.executable)) {
      throw Object.assign(new Error('The runtime environment provider did not return an absolute executable.'), { code: 'runtime-environment-unavailable' });
    }
    record.executable = observed.executable;
    record.binding = observed.binding ?? binding;
    if (observed.sessionRoot !== undefined) record.sessionRoot = observed.sessionRoot;
    if (observed.model !== undefined) record.model = observed.model;
    if (observed.effort !== undefined) record.effort = observed.effort;
    return observed;
  }

  function pendingInput(record) {
    const task = record.task;
    if (!task) return { queued: [], inFlight: [], answers: [] };
    const supplements = roster.supplements(record.agentId).filter(item => item.task === task.taskId);
    return {
      queued: supplements.filter(item => item.status === 'queued'),
      inFlight: supplements.filter(item => ['sending', 'unknown'].includes(item.status)),
      answers: (task.answers ?? []).filter(answer => !answer.dispatched),
    };
  }

  function descendants(record) {
    const found = [];
    const queue = [record.agentId];
    const seen = new Set(queue);
    while (queue.length) {
      const parentId = queue.shift();
      for (const item of roster.list(managedOwnerIdFor(parentId))) {
        if (item.owner?.parentAgentId !== parentId || seen.has(item.agentId)) continue;
        seen.add(item.agentId);
        found.push(item);
        queue.push(item.agentId);
      }
    }
    return found;
  }

  function activeDescendants(record) {
    const active = new Set(['creating', 'running', 'awaiting_input', 'awaiting_report', 'awaiting_descendants', 'reconnecting', 'delivery_pending']);
    return descendants(record).filter(item => !item.closed && active.has(item.state));
  }

  function blockPendingInput(record, reason) {
    const task = record.task;
    if (!task) return;
    roster.blockQueued(record.agentId, task.taskId, reason);
    for (const answer of task.answers ?? []) {
      if (!answer.dispatched) answer.state = 'blocked';
    }
  }

  function activeWork(record) {
    if (!record || record.closed || !record.task) return false;
    if (['creating', 'running', 'reconnecting'].includes(record.state)) return true;
    const queued = roster.supplements(record.agentId)
      .some(item => item.task === record.task?.taskId && ['queued', 'sending', 'unknown'].includes(item.status));
    const answers = (record.task?.answers ?? []).some(answer => !answer.dispatched);
    if (record.owner?.client === 'claude-code' && ['awaiting_input', 'awaiting_report', 'delivery_pending'].includes(record.state)) return queued || answers;
    const reports = (record.task?.reports ?? []).some(report => !['delivered', 'blocked'].includes(report.delivery?.state));
    const questions = (record.task?.questions ?? []).some(question => question.state === 'pending'
      && !['delivered', 'blocked'].includes(question.noticeState));
    if (record.state === 'awaiting_input') return queued || answers || reports || questions;
    if (record.state === 'awaiting_report') return queued || answers || reports || (record.task?.finalSubmitted === true && !record.task.result);
    if (record.state === 'awaiting_descendants') return true;
    if (record.state === 'delivery_pending') return reports;
    return false;
  }

  async function ensureWorker(record) {
    if (!activeWork(record)) return false;
    const holder = uid('worker');
    if (!roster.claimLease(`worker:${record.agentId}`, holder, 30000)) return true;
    try {
      record.workerPid = await startWorker(config.configFile, record.agentId, holder);
      roster.setWorker(record.agentId, record.workerPid);
      return true;
    } catch (error) {
      roster.setWorkerError(record.agentId, holder, safeError(error));
      roster.releaseLease(`worker:${record.agentId}`, holder);
      return false;
    }
  }

  function normalizeDelivery(result) {
    if (result === false) return 'blocked';
    const state = result?.state ?? result?.delivery?.state;
    return DELIVERY_STATES.has(state) ? state : 'unknown';
  }

  async function enqueueParentInput(owner, childName, { kind, message, final, id }) {
    const parentId = owner?.parentAgentId;
    if (!parentId) return false;
    return roster.locked(parentId, async () => {
      const parent = roster.get(parentId);
      if (!parent || owner.ownerId !== managedOwnerIdFor(parentId) || !sameWorkspace(parent.workspace, owner.workspace)) return false;
      if (!parent.task || owner.parentTaskId !== parent.task.taskId || parent.task.cancelRequested) return false;
      // The active model receives through wait; an idle model resumes from its queue.
      if (parent.task.dispatches?.some(item => item.state === 'running')) return false;
      const requestId = `parent-${id ?? tokenHash(`${childName}:${kind}:${message}`)}`;
      if (roster.db.prepare('SELECT 1 FROM supplements WHERE requestId=? AND agent=?').get(requestId, parentId)) return true;
      if (!['running', 'awaiting_input', 'awaiting_report', 'awaiting_descendants', 'reconnecting'].includes(parent.state)) {
        if (parent.lifetime === 'once' || !['idle', 'completed'].includes(parent.state)) return false;
        // Reopen the same parent task/session for a child report instead of creating
        // a second agent task. The prior deliverable remains available in history.
        parent.task.priorResults ??= [];
        if (parent.task.result) parent.task.priorResults.push(parent.task.result);
        parent.task.finalSubmitted = false;
        parent.task.reports = [];
        parent.task.answers = [];
        parent.task.questions = [];
        parent.task.state = 'running';
        parent.state = 'running';
        parent.error = undefined;
        roster.save(parent);
      }
      const prefix = kind === 'question'
        ? `[子代理 ${childName} 提问]\n${message}`
        : `[子代理 ${childName} 报告${final ? '（final）' : ''}]\n${message}`;
      if (parent.state === 'awaiting_descendants') { parent.state = 'awaiting_report'; roster.save(parent); }
      if (!roster.enqueueSupplement(parent, requestId, prefix)) return false;
      await ensureWorker(parent);
      return true;
    }, { waitMs: operationWaitMs });
  }

  async function queueManagedParent(record, { kind, message, final, id }) {
    return enqueueParentInput(record.owner, record.name, { kind, message, final, id });
  }

  async function deliverReports(record) {
    for (const report of record.task?.reports ?? []) {
      if (['delivered', 'blocked'].includes(report.delivery?.state)) continue;
      report.delivery ??= { state: 'pending' };
      if (await queueManagedParent(record, { kind: 'report', message: report.message, final: report.final, id: report.id })) {
        report.delivery = { state: 'delivered', via: 'managed-parent', at: now() };
        roster.save(record);
        continue;
      }
      try {
        const result = await notify({ owner: record.owner, agent: { name: record.name, runtime: record.runtime, lifetime: record.lifetime },
          kind: 'report', message: report.message, final: report.final === true, id: report.id }, config);
        const state = normalizeDelivery(result);
        Object.assign(report.delivery, { state, at: now(), ...(state === 'delivered' ? {} : { note: result?.note ?? result?.error?.message }) });
      } catch (error) {
        Object.assign(report.delivery, { state: 'unknown', at: now(), error: safeError(error) });
      }
      roster.save(record);
      if (report.delivery.state !== 'delivered') return false;
    }
    return true;
  }

  async function moveToClean(record) {
    const source = assertInside(agentsRoot, record.directory, 'CLI agent directory');
    if (isWindowsDriveC(source) || isWindowsDriveC(cleanRoot)) throw Object.assign(new Error('CLI agent state and clean directory must not be on drive C.'), { code: 'c-drive-move-refused' });
    let exists = true;
    try { await stat(source); }
    catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    if (!exists) return null;
    await mkdir(cleanRoot, { recursive: true });
    const target = path.join(cleanRoot, `${record.agentId}-${Date.now()}`);
    try { await moveDirectory(source, target); }
    catch (error) {
      if (error.code === 'EXDEV') throw Object.assign(new Error('CLI agent state and clean directory must be on the same volume; source was preserved.'), { code: 'clean-move-cross-volume' });
      throw error;
    }
    return target;
  }

  async function killChild(record) {
    if (!record?.childPid) {
      const running = record?.task?.dispatches?.some(dispatch => dispatch.state === 'running');
      return !running;
    }
    const pid = record.childPid;
    let killed = false;
    try { killed = await killTree(pid); } catch { killed = false; }
    if (killed) { record.childPid = undefined; return true; }
    let alive = false;
    try { process.kill(pid, 0); alive = true; }
    catch (error) { alive = error.code !== 'ESRCH'; }
    if (!alive) { record.childPid = undefined; return true; }
    return false;
  }

  async function retire(record) {
    record.closed = true;
    record.state = 'closing';
    roster.save(record);
    // Children own separate rosters. Retire the actual descendant records before
    // removing the parent that provides access to them.
    for (const descendant of descendants(record).reverse()) {
      const result = await roster.locked(descendant.agentId, async () => {
        const child = roster.get(descendant.agentId);
        return child ? retire(child) : { deleted: true };
      }, { waitMs: operationWaitMs });
      if (!result.deleted) {
        record.state = 'cleanup_failed'; record.error = result.error;
        roster.save(record);
        return { name: record.name, deleted: false, state: record.state, error: record.error };
      }
    }
    if (!await killChild(record)) {
      record.state = 'cleanup_failed';
      record.error = { code: 'cancel-unconfirmed', message: 'The CLI child process tree could not be confirmed stopped; the agent directory was preserved.' };
      roster.save(record);
      return { name: record.name, deleted: false, state: 'cleanup_failed', error: record.error };
    }
    let archivedTo;
    try {
      archivedTo = await moveToClean(record);
      // The owned directory has already been moved; remove only the active roster row.
      roster.remove(record);
      return { name: record.name, deleted: true, archivedTo };
    } catch (error) {
      record.state = 'cleanup_failed';
      record.error = safeError(error);
      roster.save(record);
      return { name: record.name, deleted: false, state: 'cleanup_failed', error: safeError(error) };
    }
  }

  function finishTask(record) {
    const task = record.task;
    if (!task) return publicResult(record);
    if (record.childPid || task.dispatches?.some(dispatch => dispatch.state === 'running')) return publicResult(record);
    if (!task.finalSubmitted && task.cancelRequested) {
      task.state = 'cancelled';
      task.finishedAt ??= now();
      task.result = { state: 'cancelled', reply: task.reports?.find(report => report.final)?.message ?? '', changes: task.changes ?? [] };
      record.state = 'cancelled';
      roster.save(record);
      return publicResult(record);
    }
    if (task.finalSubmitted) {
      const pending = pendingInput(record);
      if (pending.inFlight.length) {
        record.state = task.state = 'delivery_pending';
        record.error = { code: 'pending-input', message: 'A queued supplement is still in flight; final delivery is deferred.' };
        roster.save(record);
        return publicResult(record);
      }
      blockPendingInput(record, 'final-submitted');
      if (activeDescendants(record).length) {
        record.state = task.state = 'awaiting_descendants';
        roster.save(record);
        return publicResult(record);
      }
      const final = (task.reports ?? []).find(report => report.final);
      if (!final || (task.reports ?? []).some(report => report.delivery?.state !== 'delivered')) {
        record.state = task.state = 'delivery_pending';
        roster.save(record);
        return publicResult(record);
      }
      task.result = { state: 'completed', reply: final.message, changes: task.changes ?? [] };
      task.state = 'completed';
      task.finishedAt ??= now();
      if (record.lifetime === 'once') return retire(record);
      record.state = 'idle';
      roster.save(record);
      return publicResult(record);
    }
    if ((task.questions ?? []).some(question => question.state === 'pending')) {
      record.state = task.state = 'awaiting_input';
      roster.save(record);
      return publicResult(record);
    }
    if ((task.answers ?? []).some(answer => !answer.dispatched)) {
      record.state = task.state = 'running';
      roster.save(record);
      return publicResult(record);
    }
    const last = task.dispatches?.at(-1);
    if (last?.state === 'failed' || last?.state === 'cancelled') {
      task.state = last.state;
      task.finishedAt ??= now();
      record.state = last.state;
      roster.save(record);
      return publicResult(record);
    }
    record.state = task.state = 'awaiting_report';
    roster.save(record);
    return publicResult(record);
  }

  function mergeCollected(record, collected) {
    const task = record.task;
    if (!task) return;
    task.messages ??= [];
    task.changes ??= [];
    task.tools ??= [];
    task.events ??= [];
    for (const message of collected.messages ?? []) {
      task.messages.push({ role: message.role ?? 'assistant', text: String(message.text ?? '').slice(0, 8000), at: now() });
    }
    task.messages = task.messages.slice(-100);
    for (const change of collected.changes ?? []) {
      const item = { path: change.path, operation: change.operation ?? 'update', source: 'cli-json-event', attribution: 'confirmed' };
      const existing = task.changes.find(value => value.path === item.path);
      if (existing) Object.assign(existing, item);
      else task.changes.push(item);
    }
    task.changes = task.changes.slice(-200);
    task.tools = [...new Set([...(task.tools ?? []), ...(collected.tools ?? [])])].slice(-100);
    task.events = [...(task.events ?? []), ...(collected.events ?? [])].slice(-200);
    if (collected.sessionId) record.nativeSessionId = collected.sessionId;
    task.lastEventType = collected.lastEventType;
  }

  async function cancelBeforeSpawn(agentId, taskId, requestId) {
    return roster.locked(agentId, async () => {
      const current = roster.get(agentId);
      if (!current?.task || current.task.taskId !== taskId || !current.task.cancelRequested) return false;
      const dispatch = current.task.dispatches.find(item => item.requestId === requestId);
      if (dispatch && dispatch.state === 'running') dispatch.state = 'cancelled';
      current.childPid = undefined;
      current.task.cancelVerified = true;
      return finishTask(current);
    }, { waitMs: operationWaitMs });
  }

  async function acknowledgeWait(owner, snapshots) {
    for (const snapshot of snapshots) {
      const agentId = snapshot.agentId;
      await roster.locked(agentId, async () => {
        const current = roster.get(agentId);
        if (!current?.task || !sameOwner(current, owner) || current.task.taskId !== snapshot.task?.taskId) return;
        let changed = false;
        const returned = new Set((snapshot.task.reports ?? []).filter(report => !report.receivedAt).map(report => report.id));
        for (const report of current.task.reports ?? []) {
          if (returned.has(report.id)) {
            report.delivery = { ...report.delivery, state: 'delivered', deliveredAt: now() };
            report.receivedAt = now();
            changed = true;
          }
        }
        const questions = new Set((snapshot.task.questions ?? []).filter(q => q.state === 'pending').map(q => q.id));
        for (const question of current.task.questions ?? []) if (questions.has(question.id)) {
          question.noticeState = 'delivered'; changed = true;
        }
        if (changed) roster.save(current);
        if (current.task.finalSubmitted && (current.task.reports ?? []).some(report => report.final && report.delivery?.state === 'delivered')) {
          await finishTask(roster.get(agentId));
        }
      }, { waitMs: operationWaitMs });
    }
  }

  function managedPrompt(record, dispatch) {
    return [
      'You are a managed FutureAide CLI subagent working in the caller project.',
      'Use report_parent({ message, final }) for explicit progress or delivery. A normal turn ending, stdout, or a plain final answer does not notify the parent.',
      'Call report_parent with final:true only after your assigned work is complete and every descendant agent you created has settled; otherwise call it with final:false.',
      'Use ask_parent({ message }) when a decision is required and then end the turn. Do not invent the parent’s answer or create communication files.',
      'Receive owned child reports with futureaide_wait_agents while you are running. Each layer has its own roster; report only to your immediate parent.',
      'Read and follow the project AGENTS.md. Do not delete files; move retired task artifacts to the project clean directory. Never delete or move anything on drive C.',
      `Task:\n${dispatch.message}`,
    ].join('\n\n');
  }

  async function executeTurn(agentId, requestId, supplementId, managedToken) {
    let record = roster.get(agentId);
    if (!record?.task) return;
    const taskId = record.task.taskId;
    const dispatch = record.task.dispatches.find(item => item.requestId === requestId);
    if (!dispatch) return;
    const adapter = adapterFor(record.runtime);
    if (!adapter) throw Object.assign(new Error(`No runtime adapter is available for ${record.runtime}.`), { code: 'runtime-adapter-unavailable' });
    if (await cancelBeforeSpawn(agentId, taskId, requestId)) return publicResult(roster.get(agentId) ?? { name: 'removed', state: 'removed' });
    const environment = await environmentFor(record, null);
    let collector;
    let eventsFile;
    let invocation;
    let env;
    try {
      collector = new EventCollector({ workspace: record.workspace });
      eventsFile = path.join(record.directory, 'events.jsonl');
      await mkdir(record.directory, { recursive: true });
      const mcpConfigPath = record.runtime === 'claude' ? await createMcpConfig({
        directory: record.directory, serverEntry: childServerEntry,
        agentId: record.agentId, taskId, token: managedToken, controlConfig: config.configFile,
      }) : undefined;
      let codexHome;
      if (record.runtime === 'codex') {
        const configuredHome = environment.env?.CODEX_HOME;
        const relativeHome = configuredHome && path.isAbsolute(configuredHome)
          ? path.relative(path.resolve(record.directory), path.resolve(configuredHome)) : '..';
        codexHome = configuredHome && !isWindowsDriveC(configuredHome)
          && relativeHome !== '..' && !relativeHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeHome)
          ? path.resolve(configuredHome) : path.join(record.directory, 'codex');
        if (isWindowsDriveC(codexHome)) throw Object.assign(new Error('Codex private home must not be on drive C.'), { code: 'c-drive-write-refused' });
      }
      const mcpConfig = record.runtime === 'codex' ? {
        serverEntry: childServerEntry, configFile: config.configFile,
        env: {
          FUTUREAIDE_MANAGED_AGENT: record.agentId,
          FUTUREAIDE_MANAGED_TOKEN: managedToken,
          FUTUREAIDE_CLI_AGENT_ID: record.agentId,
          FUTUREAIDE_CLI_TASK_ID: record.task.taskId,
          FUTUREAIDE_CLI_TOKEN: managedToken,
          FUTUREAIDE_CONTROL_CONFIG: config.configFile,
        },
      } : undefined;
      invocation = adapter.build({
        runtime: record.runtime, executable: environment.executable, prompt: managedPrompt(record, dispatch),
        nativeSessionId: record.nativeSessionId, sessionId: record.cliSessionId, mcpConfigPath,
        workspace: record.workspace, mcpConfig, model: environment.model ?? record.model,
        effort: environment.effort ?? record.effort,
      });
      env = { ...(environment.env ?? process.env) };
      if (record.runtime === 'codex') env.CODEX_HOME = codexHome;
      env.FUTUREAIDE_MANAGED_AGENT = record.agentId;
      env.FUTUREAIDE_MANAGED_TOKEN = managedToken;
      env.FUTUREAIDE_CLI_AGENT_ID = record.agentId;
      env.FUTUREAIDE_CLI_TASK_ID = record.task.taskId;
      env.FUTUREAIDE_CLI_TOKEN = managedToken;
      env.FUTUREAIDE_CONTROL_CONFIG = config.configFile;
      if (config.tempDirectory) { env.TEMP = config.tempDirectory; env.TMP = config.tempDirectory; }
      if (await cancelBeforeSpawn(agentId, taskId, requestId)) {
        await cleanupQuietly(environment);
        return publicResult(roster.get(agentId) ?? { name: 'removed', state: 'removed' });
      }
    } catch (error) {
      await cleanupQuietly(environment);
      throw error;
    }
    let result;
    let stderrTail = '';
    let cleanupError;
    let progress = Promise.resolve();
    let progressAt = 0;
    try {
      result = await runTurn({
        ...invocation, cwd: record.workspace, env,
        onSpawn: pid => {
          void roster.locked(agentId, async () => {
            const current = roster.get(agentId);
            if (current?.task?.taskId !== taskId) return;
            const active = current.task.dispatches?.find(item => item.requestId === requestId);
            if (!active || active.state !== 'running') return;
            current.childPid = pid;
            roster.save(current);
          }, { waitMs: 5000 }).catch(() => { void killTree(pid).catch(() => {}); });
        },
        onStdoutLine: line => {
          if (typeof line !== 'string' || !line.trim()) return;
          void appendFile(eventsFile, line + '\n').catch(() => {});
          const event = collector.pushLine(line);
          if (event && (event.changes?.length || Date.now() - progressAt > 1000)) {
            progressAt = Date.now();
            const snapshot = collector.snapshot();
            progress = progress.then(() => roster.locked(agentId, async () => {
              const current = roster.get(agentId);
              if (!current?.task || current.task.taskId !== taskId) return;
              current.task.activity = event.tools?.length ? `tool: ${event.tools.at(-1)}` : event.type;
              for (const change of snapshot.changes) {
                const existing = current.task.changes.find(item => item.path === change.path);
                const value = { ...change, source: 'cli-json-event', attribution: 'confirmed' };
                if (existing) Object.assign(existing, value); else current.task.changes.push(value);
              }
              roster.save(current);
            }, { waitMs: 5000 })).catch(() => {});
          }
        },
        onStderrLine: line => {
          if (typeof line !== 'string') return;
          stderrTail = (stderrTail + line + '\n').slice(-16000);
        },
      });
    } catch (error) {
      result = { exitCode: 1, signal: null, error: safeError(error), stderrTail };
    } finally {
      if (typeof environment.cleanup === 'function') {
        try { await environment.cleanup(); }
        catch (error) { cleanupError = safeError(error); }
      }
    }
    const collected = collector.snapshot();
    await progress;
    return roster.locked(agentId, async () => {
      const current = roster.get(agentId);
      if (!current?.task || current.task.taskId !== taskId) return publicResult(current ?? { name: 'removed', state: 'removed' });
      const currentDispatch = current.task.dispatches.find(item => item.requestId === requestId);
      if (!currentDispatch) return publicResult(current);
      mergeCollected(current, collected);
      currentDispatch.endedAt = now();
      currentDispatch.exitCode = result.exitCode ?? null;
      currentDispatch.signal = result.signal ?? null;
      currentDispatch.stderrTail = redactTail(result.stderrTail ?? stderrTail);
      if (result.error) currentDispatch.error = result.error;
      if (cleanupError) currentDispatch.cleanupError = cleanupError;
      const terminal = [...(collected.events ?? [])].reverse().find(event => event.terminal)?.terminal;
      if (current.task.cancelRequested || terminal?.state === 'cancelled') currentDispatch.state = 'cancelled';
      else if (terminal?.state === 'failed') {
        currentDispatch.state = 'failed';
        currentDispatch.error ??= { code: 'cli-turn-failed', message: 'The CLI reported a failed turn.' };
      } else if (result.exitCode === 0 && !result.error) currentDispatch.state = 'completed';
      else currentDispatch.state = 'failed';
      if (current.runtime === 'claude' && !current.nativeSessionId) current.nativeSessionId = current.cliSessionId;
      current.childPid = undefined;
      if (supplementId) roster.setSupplement(supplementId, currentDispatch.state === 'completed' ? 'accepted' : 'unknown',
        currentDispatch.state === 'completed' ? null : 'dispatch-failed-or-unknown');
      if (currentDispatch.state === 'failed') current.error = currentDispatch.error ?? { code: 'cli-turn-failed', message: 'The CLI process ended without a completed turn.' };
      else if (currentDispatch.state === 'completed') current.error = undefined;
      roster.save(current);
      return finishTask(current);
    }, { waitMs: operationWaitMs });
  }

  async function pollLocked(record) {
    if (!record) return { removed: true };
    if (record.closed || record.state === 'cleanup_failed') return publicResult(record);
    if (!record.task) return publicResult(record);
    if (record.task.cancelRequested) {
      if (!await killChild(record)) {
        record.state = 'reconnecting';
        record.error = { code: 'cancel-unconfirmed', message: 'The CLI child process tree could not be confirmed stopped.' };
        roster.save(record);
        return publicResult(record);
      }
      record.task.cancelVerified = true;
      return finishTask(record);
    }
    if (record.task.finalSubmitted) {
      if (record.task.dispatches?.some(dispatch => dispatch.state === 'running')) return publicResult(record);
      await deliverReports(record);
      return finishTask(record);
    }
    if (record.task.dispatches?.some(dispatch => dispatch.state === 'running')) return publicResult(record);
    const pendingQuestion = (record.task.questions ?? []).find(question => question.state === 'pending'
      && !['delivered', 'blocked'].includes(question.noticeState));
    if (pendingQuestion) {
      try {
        const result = await notify({ owner: record.owner, agent: { name: record.name, runtime: record.runtime, lifetime: record.lifetime },
          kind: 'question', message: pendingQuestion.message, final: false, id: pendingQuestion.id }, config);
        pendingQuestion.noticeState = normalizeDelivery(result);
        pendingQuestion.notifiedAt = now();
      } catch (error) {
        pendingQuestion.noticeState = 'unknown';
        pendingQuestion.noticeError = safeError(error);
      }
      roster.save(record);
      return publicResult(record);
    }
    let message;
    let kind = 'task';
    let supplementId;
    if (record.task.dispatches?.length) {
      const answer = (record.task.answers ?? []).find(item => !item.dispatched);
      if (answer) {
        answer.dispatched = true;
        kind = 'answer';
        message = `主控回答：\n${answer.message}\n请继续完成原任务。`;
      } else {
        const queued = roster.supplements(record.agentId)
          .filter(item => item.task === record.task.taskId && item.status === 'queued');
        if (queued.length) {
          const item = queued[0];
          roster.setSupplement(item.requestId, 'sending');
          supplementId = item.requestId;
          kind = 'supplement';
          message = item.message;
        }
      }
    }
    if (!message) {
      if (['awaiting_input', 'awaiting_report'].includes(record.state)) return publicResult(record);
      if (record.task.dispatches?.length) return finishTask(record);
      message = record.task.message;
    }
    const dispatch = { requestId: uid('request'), kind, message, supplementId, state: 'running', startedAt: now(), changes: [] };
    const managedToken = randomUUID();
    record.task.managedTokenHash = tokenHash(managedToken);
    record.task.managedTokenIssuedAt = now();
    record.task.dispatches ??= [];
    record.task.dispatches.push(dispatch);
    record.state = 'running';
    record.task.state = 'running';
    record.task.activity = 'running';
    roster.save(record);
    return { run: true, agentId: record.agentId, requestId: dispatch.requestId, supplementId, managedToken };
  }

  async function recoverError(agentId, error) {
    try {
      await roster.locked(agentId, async () => {
        const record = roster.get(agentId);
        if (!record) return;
        const running = record.task?.dispatches?.find(dispatch => dispatch.state === 'running');
        if (running) {
          running.state = 'failed';
          running.endedAt = now();
          running.error = safeError(error);
          record.childPid = undefined;
          record.state = record.task?.finalSubmitted ? 'delivery_pending' : 'failed';
        } else {
          record.state = record.task?.finalSubmitted ? 'delivery_pending' : 'reconnecting';
        }
        record.error = safeError(error);
        roster.save(record);
      }, { waitMs: operationWaitMs });
    } catch { /* A deleted record has nothing left to update. */ }
  }

  const service = {
    store: roster,
    resolveManagedContext: managedContext,
    async deliverToParent(owner, notice = {}) {
      if (!owner?.parentAgentId) return { state: 'blocked', reason: 'managed-parent-missing' };
      if (typeof notice.message !== 'string' || !notice.message.trim()) return { state: 'blocked', reason: 'empty-notice' };
      const queued = await enqueueParentInput(owner, notice.agent?.name ?? 'subagent', {
        kind: notice.kind === 'question' ? 'question' : 'report',
        message: notice.message,
        final: notice.final === true,
        id: notice.id,
      });
      return queued ? { state: 'delivered', via: 'managed-parent' }
        : { state: 'pending', reason: 'parent-queue-unavailable' };
    },
    async status(extra) {
      const status = { toolsLoaded: true, contextVerified: false, client: null, workspace: null, agents: 0 };
      try {
        const owner = await context(extra);
        const agents = roster.list(owner.ownerId).filter(record => sameWorkspace(record.workspace, owner.workspace)).length;
        Object.assign(status, { contextVerified: true, client: owner.client, workspace: owner.workspace, agents });
      } catch (error) { status.contextError = safeError(error); }
      return status;
    },
    async create({ name, lifetime, runtime = 'dsh' }, extra) {
      assertName(name);
      if (!['once', 'persistent'].includes(lifetime)) throw new Error('lifetime must be once or persistent.');
      if (runtime === 'dsh') throw Object.assign(new Error('The DSH runtime belongs to the unified facade; route it to the existing DSH service.'), { code: 'dsh-runtime-facade-owned' });
      if (!RUNTIMES.has(runtime)) throw new Error('runtime must be dsh, claude or codex.');
      const owner = await context(extra);
      const agentId = uid('agent');
      const directory = path.join(agentsRoot, owner.ownerId, agentId);
      const record = {
        agentId, ownerId: owner.ownerId, owner: ownerSnapshot(owner), name, runtime, lifetime,
        workspace: owner.workspace, state: 'creating', createdAt: now(), updatedAt: now(),
        directory, sessionId: uid('session-cli'), cliSessionId: randomUUID(),
        history: [],
      };
      // Occupy the owner/name slot before creating any private directory, so a
      // duplicate or failed create cannot leave an untracked agent home.
      roster.insert(record);
      let environment;
      let adapter;
      try {
        adapter = adapterFor(runtime);
        await mkdir(directory, { recursive: true });
        environment = await environmentFor(record, owner);
        record.runtimeAdapter = adapter?.id;
        record.state = 'idle';
        roster.save(record);
        return { name: record.name, runtime: record.runtime, lifetime: record.lifetime, state: record.state, created: true, modelRequestsStarted: 0 };
      } catch (error) {
        record.state = 'create_failed';
        record.error = safeError(error);
        roster.save(record);
        return { name: record.name, runtime: record.runtime, lifetime: record.lifetime,
          state: record.state, created: false, error: record.error };
      } finally {
        if (typeof environment?.cleanup === 'function') {
          try { await environment.cleanup(); }
          catch (error) {
            record.cleanupError = safeError(error);
            roster.save(record);
          }
        }
      }
    },
    async send({ name, message }, extra) {
      textMessage(message);
      let entered = false;
      try {
        return await withName(extra, name, async (record, owner) => {
          entered = true;
          if (record.closed || ['cleaning', 'cleanup_failed', 'create_failed'].includes(record.state)) throw new Error('This CLI agent is closing, failed to create, or has blocked cleanup.');
          if (record.state === 'delivery_pending') throw new Error('The final report is waiting for delivery; wait or delete the agent before assigning another task.');
          if (record.state === 'awaiting_input' && (record.task?.questions ?? []).some(question => question.state === 'pending')) {
            return answerLocked(record, message);
          }
          if (record.task && ['running', 'awaiting_input', 'awaiting_report', 'awaiting_descendants', 'reconnecting'].includes(record.state)) {
            const requestId = uid('supplement');
            if (!roster.enqueueSupplement(record, requestId, message)) {
              throw Object.assign(new Error('This CLI agent is not accepting queued input right now.'), { code: 'supplement-unavailable' });
            }
            await ensureWorker(record);
            return { name: record.name, accepted: false, queued: true, state: record.state };
          }
          if (record.lifetime === 'once' && record.task) throw new Error('This one-shot CLI agent has already been used.');
          if (record.task) record.history.push({ ...record.task, changes: record.task.changes,
            messages: record.task.messages?.slice(-20), result: record.task.result });
          record.owner = ownerSnapshot(owner);
          record.task = { taskId: uid('task'), message, state: 'starting', startedAt: now(), dispatches: [], answers: [], questions: [], reports: [], changes: [], messages: [], finalSubmitted: false };
          record.state = 'running';
          record.error = undefined;
          record.observation = undefined;
          roster.save(record);
          await ensureWorker(record);
          return { name: record.name, accepted: true, state: record.state };
        }, { waitMs: 0 });
      } catch (error) {
        if (!entered && error.code === 'agent-busy') {
          const owner = await context(extra);
          const record = named(owner, name);
          if (!sameOwner(record, owner) || !sameWorkspace(record.workspace, owner.workspace)) {
            throw Object.assign(new Error('This CLI agent is bound to another project.'), { code: 'workspace-mismatch' });
          }
          const requestId = uid('supplement');
          if (roster.enqueueSupplement(record, requestId, message)) {
            await ensureWorker(record);
            return { name, accepted: false, queued: true, state: record.state };
          }
        }
        throw error;
      }
    },
    async answer({ name, message }, extra) {
      textMessage(message);
      return withName(extra, name, record => answerLocked(record, message));
    },
    async list(extra) {
      const owner = await context(extra);
      const records = roster.list(owner.ownerId).filter(record => sameWorkspace(record.workspace, owner.workspace));
      for (const record of records) await ensureWorker(record);
      return { items: records.map(record => publicResult(record)), total: records.length };
    },
    async wait({ names, timeoutSeconds = 0 } = {}, extra) {
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 45) throw new Error('Wait between 0 and 45 seconds.');
      const owner = await context(extra);
      if (names) names.forEach(assertName);
      const deadline = Date.now() + timeoutSeconds * 1000;
      const notListed = new Set();
      let items = [];
      let selectedAgentIds = new Set();
      let snapshots = [];
      for (const record of roster.list(owner.ownerId).filter(item => sameWorkspace(item.workspace, owner.workspace))) await ensureWorker(record);
      do {
        const available = roster.list(owner.ownerId).filter(record => sameWorkspace(record.workspace, owner.workspace));
        const selected = available.filter(record => !names || names.includes(record.name));
        selectedAgentIds = new Set(selected.map(record => record.agentId));
        for (const name of names ?? []) if (!available.some(record => record.name === name)) notListed.add(name);
        items = [];
        snapshots = [];
        for (const record of selected) {
          const current = roster.get(record.agentId) ?? record;
          snapshots.push(current);
          items.push(publicResult(current));
        }
        if (!selectedAgentIds.size || notListed.size || items.some(item => WAIT_STATES.has(item.state))) break;
        if (Date.now() >= deadline) break;
        await wait(Math.min(250, deadline - Date.now()));
      } while (true);
      const reports = snapshots.flatMap(record => (record.task?.reports ?? []).filter(report => !report.receivedAt)
        .map(report => ({ name: record.name, id: report.id, message: report.message, final: report.final, delivery: report.delivery?.state })));
      const questions = items.flatMap(item => (item.questions ?? []).map(question => ({ name: item.name, ...question })));
      await acknowledgeWait(owner, snapshots);
      for (const report of reports) { report.delivery = 'delivered'; report.received = true; }
      return { items, ...(reports.length ? { reports } : {}), ...(questions.length ? { questions } : {}), notListed: [...notListed],
        ...(notListed.size ? { note: 'These names are not in this chat’s current list. Absence alone does not prove completion.' } : {}),
        timedOut: Date.now() >= deadline && items.some(item => item.state === 'running') };
    },
    async changes({ name, task = 0 }, extra) {
      return withName(extra, name, record => {
        if (!Number.isInteger(task) || task < 0) throw new Error('task must be a non-negative integer.');
        if (task > 0) {
          const historical = record.history.at(-task);
          if (!historical) throw new Error('That earlier task is not available. Use 0 for the current or latest task.');
          return { name, task, message: historical.message, changes: historical.changes ?? [], coverage: { source: 'cli-json-events', complete: false } };
        }
        return { name, task: 0, changes: record.task?.changes ?? [], coverage: { source: 'cli-json-events', complete: false },
          observedAt: record.task?.finishedAt ?? null };
      });
    },
    async inspect({ name, maxMessages = 20 }, extra) {
      if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) throw new Error('Inspect between 1 and 100 messages.');
      return withName(extra, name, record => ({
        ...publicResult(record),
        messages: (record.task?.messages ?? []).slice(-maxMessages),
        tools: record.task?.tools ?? [],
        history: (record.history ?? []).slice(-20).reverse().map((task, index) => ({
          task: index + 1, message: compactText(task.message, 240), state: task.state,
          startedAt: task.startedAt, ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
        })),
        inspectionIncomplete: record.task?.events?.some(event => event.type === 'error') ?? false,
      }));
    },
    async cancel({ name }, extra) {
      const owner = await context(extra);
      const record = named(owner, name);
      if (!record.task || record.closed) return { name, accepted: false, state: record.state };
      if (record.task.finalSubmitted || ['delivery_pending', 'idle', 'completed'].includes(record.state)) {
        return { name, accepted: false, state: record.state, reason: 'final-submitted' };
      }
      const accepted = roster.requestCancel(record);
      if (!accepted) return { name, accepted: false, state: roster.get(record.agentId)?.state ?? 'removed' };
      for (const child of descendants(record).reverse()) {
        if (!child.task || child.closed || ['idle', 'completed'].includes(child.state)) continue;
        roster.requestCancel(child);
        const currentChild = roster.get(child.agentId);
        if (!await killChild(currentChild)) return { name, accepted: false, state: 'cancelling',
          error: { code: 'cancel-unconfirmed', message: `The child agent ${child.name} has not stopped.` } };
        await ensureWorker(currentChild);
      }
      const current = roster.get(record.agentId);
      if (current && !await killChild(current)) {
        current.error = { code: 'cancel-unconfirmed', message: 'The CLI child process tree could not be confirmed stopped.' };
        roster.save(current);
        return { name, accepted: false, state: 'cancelling', error: current.error };
      }
      if (current) await ensureWorker(current);
      return { name, accepted: true, state: 'cancelling' };
    },
    async delete({ name }, extra) {
      return withName(extra, name, record => retire(record));
    },
    async report({ message, final = false } = {}, extra) {
      textMessage(message);
      if (typeof final !== 'boolean') throw new Error('final must be a boolean.');
      const caller = await callerContext(extra);
      const owner = caller.reportContext ?? caller;
      if (!owner.parentAgentId) throw Object.assign(new Error('This tool is only available to a managed CLI subagent.'), { code: 'parent-agent-required' });
      const record = roster.get(owner.parentAgentId);
      if (!record || !sameOwner(record, owner) || !sameWorkspace(record.workspace, owner.workspace)) {
        throw Object.assign(new Error('The managed CLI subagent context does not match this agent.'), { code: 'parent-agent-mismatch' });
      }
      return roster.locked(record.agentId, async () => {
        const fresh = roster.get(record.agentId);
        if (!fresh || fresh.closed || !fresh.task) throw new Error('This CLI agent has no open task.');
        if (owner.taskId && owner.taskId !== fresh.task.taskId) throw Object.assign(new Error('The managed token belongs to an older task.'), { code: 'managed-token-stale' });
        if (fresh.task.finalSubmitted) throw new Error('This task already has a final report.');
        if (fresh.task.cancelRequested) throw new Error('This task has been cancelled.');
        if (final && (fresh.task.questions ?? []).some(question => question.state === 'pending')) {
          throw new Error('Answer the pending question before submitting a final report.');
        }
        if (final) {
          const pending = pendingInput(fresh);
          const active = fresh.task.dispatches?.find(d => d.state === 'running' && d.kind === 'supplement');
          const unconsumed = pending.inFlight.filter(item => !(item.status === 'sending' && active
            && (active.supplementId === item.requestId || (!active.supplementId && active.message === item.message))));
          if (pending.queued.length || unconsumed.length || pending.answers.length) {
            throw Object.assign(new Error('Wait for queued input and answers to be consumed before submitting a final report.'), { code: 'pending-input' });
          }
          if (activeDescendants(fresh).length) {
            throw Object.assign(new Error('Wait for descendants created by this agent to settle before submitting a final report.'), { code: 'descendants-running' });
          }
        }
        const report = { id: uid('report'), message, final, createdAt: now(), delivery: { state: 'pending' } };
        fresh.task.reports.push(report);
        if (final) fresh.task.finalSubmitted = true;
        roster.save(fresh);
        await deliverReports(fresh);
        if (fresh.task.finalSubmitted) await ensureWorker(fresh);
        return { accepted: true, final, delivery: report.delivery.state };
      });
    },
    async ask({ message } = {}, extra) {
      textMessage(message);
      const caller = await callerContext(extra);
      const owner = caller.reportContext ?? caller;
      if (!owner.parentAgentId) throw Object.assign(new Error('This tool is only available to a managed CLI subagent.'), { code: 'parent-agent-required' });
      const record = roster.get(owner.parentAgentId);
      if (!record || !sameOwner(record, owner) || !sameWorkspace(record.workspace, owner.workspace)) {
        throw Object.assign(new Error('The managed CLI subagent context does not match this agent.'), { code: 'parent-agent-mismatch' });
      }
      return roster.locked(record.agentId, async () => {
        const fresh = roster.get(record.agentId);
        if (!fresh || fresh.closed || !fresh.task) throw new Error('This CLI agent has no open task.');
        if (owner.taskId && owner.taskId !== fresh.task.taskId) throw Object.assign(new Error('The managed token belongs to an older task.'), { code: 'managed-token-stale' });
        if (fresh.task.finalSubmitted) throw new Error('This task already has a final report.');
        if (fresh.task.cancelRequested) throw new Error('This task has been cancelled.');
        if ((fresh.task.questions ?? []).some(question => question.state === 'pending')) throw new Error('This task already has an unanswered question.');
        const question = { id: uid('question'), message, state: 'pending', createdAt: now() };
        fresh.task.questions.push(question);
        fresh.state = fresh.task.state = 'awaiting_input';
        roster.save(fresh);
        try {
          if (await queueManagedParent(fresh, { kind: 'question', message, final: false, id: question.id })) {
            question.noticeState = 'delivered';
            question.noticeVia = 'managed-parent';
          } else {
            const result = await notify({ owner: fresh.owner, agent: { name: fresh.name, runtime: fresh.runtime, lifetime: fresh.lifetime },
              kind: 'question', message, final: false, id: question.id }, config);
            question.noticeState = normalizeDelivery(result);
          }
          question.notifiedAt = now();
        } catch (error) {
          question.noticeState = 'unknown';
          question.noticeError = safeError(error);
        }
        roster.save(fresh);
        await ensureWorker(fresh);
        return { waiting: true };
      });
    },
    async poll(agentId) {
      let selected;
      try {
        selected = await roster.locked(agentId, async () => {
          const record = roster.get(agentId);
          return pollLocked(record);
        }, { waitMs: operationWaitMs });
      } catch (error) {
        await recoverError(agentId, error);
        return { agentId, state: 'reconnecting', error: safeError(error) };
      }
      if (!selected || !selected.run) return selected;
      try {
        return await executeTurn(agentId, selected.requestId, selected.supplementId, selected.managedToken);
      } catch (error) {
        await recoverError(agentId, error);
        return { agentId, state: 'reconnecting', error: safeError(error) };
      }
    },
    async resume(agentId) {
      if (agentId) await ensureWorker(roster.get(agentId));
    },
    close() { roster.close(); },
  };

  async function answerLocked(record, message) {
    if (!record.task || record.closed || record.task.finalSubmitted) throw new Error('This CLI agent has no open task waiting for an answer.');
    if (record.task.cancelRequested) throw new Error('This CLI agent task has been cancelled.');
    const pending = (record.task.questions ?? []).find(question => question.state === 'pending');
    if (!pending) {
      const prior = (record.task.answers ?? []).find(answer => answer.message === message);
      if (prior) return { name: record.name, answered: true, duplicate: true, state: record.state };
      throw new Error('This CLI agent has no unanswered question.');
    }
    pending.state = 'answered';
    pending.answeredAt = now();
    record.task.answers ??= [];
    record.task.answers.push({ answerId: uid('answer'), questionId: pending.id, message, dispatched: false, createdAt: now() });
    record.state = record.task.state = 'running';
    roster.save(record);
    await ensureWorker(record);
    return { name: record.name, answered: true, state: 'resuming' };
  }

  return service;
}
