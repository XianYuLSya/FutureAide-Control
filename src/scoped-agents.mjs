import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControl, endedState, historyMessages } from './control.mjs';
import { FutureAideClient } from './futureaide-api.mjs';
import { resolveModel } from './agents.mjs';
import { invokeCodexTool } from './codex-notify.mjs';
import { callingThread, ownerIdFor, resolveCallingContext, threadFromResult } from './calling-context.mjs';
import { RosterStore } from './roster-store.mjs';
import { readDispatch } from './dispatch.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const uid = prefix => `${prefix}-${randomUUID().replaceAll('-', '')}`;
const now = () => new Date().toISOString();
const ACTIVE = new Set(['creating', 'running', 'awaiting_input', 'reconnecting', 'delivery_pending', 'cleaning']);
const METHODS = ['managedCreate', 'managedBeginTask', 'managedStatus', 'managedHistory', 'managedAnswer', 'managedCancel', 'managedDestroy'];
const TREE_PROTOCOL = 1;
const treeProtocolError = () => Object.assign(new Error('The DSH bridge and caller must support task-tree protocol 1. Update the plugin bridge and reload the plugin/MCP connection; restarting DSH is not required.'), { code: 'tree-protocol-required' });
const safeError = error => ({ code: error?.code ?? 'operation-failed', message: String(error?.message ?? error).slice(0, 1200) });

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
function stableHost(identity) {
  return { application: identity.application ?? null, dataRoot: path.resolve(identity.dataRoot ?? '') };
}
const fileSummary = change => ({ path: change.path, operation: change.operation,
  ...(change.agentPath ? { agentPath: change.agentPath } : {}) });
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
  return view.tree?.settled === true && view.tree.running === false && ownedTree(record, view).complete;
}

function rootSummary(view) {
  const summary = view.tree?.rootSummary;
  return summary?.ready === true && typeof summary.reply === 'string'
    && ['completed', 'failed', 'cancelled'].includes(summary.state) ? summary : undefined;
}

function attributedChanges(record, view) {
  const tree = ownedTree(record, view);
  if (!tree.nodes.length) return (view.changes ?? []).map(change => ({ ...change, agentPath: [record.name] }));
  return tree.nodes.flatMap(({ node, agentPath }) => (node.changes ?? []).map(change => {
    const { sessionId, parentSessionId, agentId, ...file } = change;
    return { ...file, agentPath };
  }));
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

function treeCoverage(record, view) {
  const { nodes } = ownedTree(record, view);
  return nodes.length > 1 ? { scope: 'DSH task tree',
    nodes: nodes.map(({ node, agentPath }) => ({ agentPath, coverage: node.coverage ?? 'Not observed' })) }
    : view.coverage ?? 'Not observed yet; zero known files is not a complete filesystem audit.';
}

function publicResult(record, { fullResult = false } = {}) {
  const task = record.task;
  const view = record.observation ?? {};
  const changes = attributedChanges(record, view);
  return {
    name: record.name, lifetime: record.lifetime, state: record.state,
    task: task ? { text: compactText(task.message, 240), state: task.state, startedAt: task.startedAt,
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.result ? { result: { state: task.result.state,
        ...(fullResult ? { reply: task.result.reply } : { summary: compactText(task.result.reply, 800) }),
        files: (task.result.changes ?? []).map(fileSummary), coverage: task.result.coverage } } : {}) } : null,
    activity: view.activity ?? (record.state === 'idle' ? 'Waiting for a task' : record.state),
    changes: { count: changes.length, files: changes.slice(0, 12).map(fileSummary),
      coverage: treeCoverage(record, view),
      observedAt: view.capturedAt ?? null, stale: Boolean(view.stale) },
    questions: (view.questions ?? []).filter(question => question.state === 'pending').map(question => ({ message: question.message })),
    tree: publicTree(record, view),
    delivery: task?.delivery?.state ?? null, updatedAt: record.updatedAt,
    ...(record.error ? { error: record.error } : {}),
  };
}

export async function workerSpawn(configFile, agentId, lease, spawnProcess = spawn) {
  if (!configFile) throw new Error('The installed plugin has no private configuration path for recovery.');
  const script = fileURLToPath(new URL('./scoped-worker.mjs', import.meta.url));
  const child = spawnProcess(process.execPath, [script, '--config', configFile, '--agent', agentId, '--lease', lease], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    // Spawn failures arrive asynchronously; a surrounding try/catch cannot catch
    // an unhandled ChildProcess error event. Confirm spawn before saving its PID.
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}

/** Name-addressed operations; owner and native identifiers never come from tool arguments. */
export function createScopedAgents(config, {
  store = new RosterStore(path.join(config.stateDirectory, 'roster.sqlite')),
  callCodex = invokeCodexTool,
  clientFactory = settings => new FutureAideClient({ dataHome: settings.dataRoot, dshDataHome: settings.dshDataRoot,
    target: settings.target, instanceFile: settings.instanceFile, preferredInstanceFile: settings.preferredInstanceFile,
    baseUrl: settings.baseUrl, timeoutMs: settings.timeoutMs, hostBridgeFile: settings.hostBridgeFile }),
  controlFactory = createControl,
  startWorker = workerSpawn,
  removeTree = rm,
} = {}) {
  const clients = new Map();
  const agentDirectory = record => path.join(config.stateDirectory, 'scoped', record.ownerId, record.agentId);
  const settings = record => ({ ...config, workspace: record.workspace, stateDirectory: agentDirectory(record),
    codexThreadId: undefined, futureaideSessionId: undefined });
  const apiFor = record => {
    if (!clients.has(record.agentId)) clients.set(record.agentId, clientFactory(settings(record)));
    return clients.get(record.agentId);
  };
  const controlFor = record => controlFactory(settings(record), { client: apiFor(record) });
  const hostArgs = record => ({ ownerId: record.ownerId, agentId: record.agentId,
    sessionId: record.sessionId, workspace: record.workspace, treeProtocol: TREE_PROTOCOL,
    ...(record.task ? { taskId: record.task.taskId } : {}) });

  async function context(extra) {
    const threadId = callingThread(extra);
    const ownerId = ownerIdFor(threadId);
    return store.saveOwner(await resolveCallingContext(extra, { knownOwner: store.owner(ownerId), callCodex }));
  }
  function named(owner, name) {
    const record = store.named(owner.ownerId, assertName(name));
    if (!record) throw Object.assign(new Error(`No subagent named “${name}” exists in this chat.`), { code: 'agent-not-found' });
    return record;
  }
  async function withName(extra, name, action) {
    const owner = await context(extra);
    const record = named(owner, name);
    return store.locked(record.agentId, async () => {
      const fresh = store.get(record.agentId);
      if (!fresh || fresh.ownerId !== owner.ownerId) throw new Error('This subagent instance has already been removed.');
      return action(fresh, owner);
    });
  }

  async function checkHost(record, { creation = false, taskTree = false } = {}) {
    const api = apiFor(record);
    const identity = await api.connectionIdentity();
    const stable = stableHost(identity);
    if (record.host && JSON.stringify(record.host) !== JSON.stringify(stable)) {
      throw Object.assign(new Error('The original DSH data store is not connected. The task was not sent to another host.'), { code: 'host-ownership-mismatch' });
    }
    if (creation || taskTree) {
      const status = await api.hostStatus();
      if (!METHODS.every(method => status.methods?.includes(method))) {
        throw Object.assign(new Error('The DSH bridge needs this plugin version installed before subagents can be created.'), { code: 'managed-host-required' });
      }
      if (status.treeProtocol !== TREE_PROTOCOL) throw treeProtocolError();
    }
    record.host ??= stable;
    return api;
  }

  async function ensureWorker(record) {
    if (!ACTIVE.has(record.state)) return;
    const holder = uid('worker');
    if (!store.claimLease(`worker:${record.agentId}`, holder, 30000)) return;
    try { record.workerPid = await startWorker(config.configFile, record.agentId, holder); store.setWorker(record.agentId, record.workerPid); }
    catch (error) {
      try { store.setWorkerError(record.agentId, holder, safeError(error)); }
      finally { store.releaseLease(`worker:${record.agentId}`, holder); }
    }
  }

  async function observe(record) {
    const api = await checkHost(record);
    const observed = await api.managedStatus(hostArgs(record));
    if (observed.sessionId !== record.sessionId || (record.task && observed.taskId !== record.task.taskId)) {
      throw new Error('The host returned a different subagent task.');
    }
    if (record.task?.treeProtocol === TREE_PROTOCOL && !observed.tree) throw treeProtocolError();
    record.observation = { ...observed, capturedAt: now() };
    record.error = undefined;
    return observed;
  }

  async function sendDispatch(record, message, kind = 'task', answerIds = []) {
    const task = record.task;
    const baseline = await apiFor(record).historyCursor(record.sessionId, record.workspace);
    const dispatch = { requestId: uid('request'), message, kind, answerIds, state: 'sending', afterSeq: baseline.throughSeq, startedAt: now() };
    task.dispatches.push(dispatch);
    record.state = 'running'; task.state = 'running';
    store.save(record); // The intent survives a caller or worker exiting during the write.
    await dispatchOnce(record, dispatch);
    return dispatch;
  }

  async function dispatchOnce(record, dispatch) {
    try {
      const sent = await controlFor(record).send({ sessionId: record.sessionId, message: dispatch.message, requestId: dispatch.requestId,
        background: false, suppressCallback: true, mode: 'queue' });
      Object.assign(dispatch, { state: sent.accepted ? 'running' : sent.status ?? 'unknown', accepted: sent.accepted === true,
        afterSeq: sent.afterSeq ?? dispatch.afterSeq });
    } catch (error) {
      Object.assign(dispatch, { state: error.uncertain ? 'unknown' : 'failed', afterSeq: error.afterSeq ?? dispatch.afterSeq, error: safeError(error) });
    }
    store.save(record);
  }

  async function verifyOwner(owner) {
    const thread = threadFromResult(await callCodex(owner.threadId, 'read_thread', {
      threadId: owner.threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100,
    }));
    if (thread?.id?.toLowerCase() !== owner.threadId || thread.kind !== 'codex' || thread.hostId !== 'local'
        || typeof thread.cwd !== 'string' || await realpath(thread.cwd) !== owner.workspace) {
      throw new Error('The original Codex chat project could not be re-verified.');
    }
  }

  async function deliver(record, notice, text) {
    if (notice.state === 'delivered') return;
    if (notice.nextAttemptAt && notice.nextAttemptAt > Date.now()) return;
    const owner = store.owner(record.ownerId);
    notice.id ??= uid('notice');
    notice.attempts = (notice.attempts ?? 0) + 1;
    notice.nextAttemptAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(notice.attempts, 5));
    const marker = `<!-- futureaide-control:${notice.id} -->`;
    if (notice.state === 'unknown' || notice.state === 'sending') {
      try {
        const history = await callCodex(owner.threadId, 'read_thread', {
          threadId: owner.threadId, turnLimit: 30, includeOutputs: true, maxOutputCharsPerItem: 100000,
        });
        if (!history?.isError && JSON.stringify(history).includes(marker)) {
          Object.assign(notice, { state: 'delivered', deliveredAt: now(), recovered: true, error: undefined });
        } else notice.state = 'unknown';
      } catch { notice.state = 'unknown'; }
      store.save(record);
      return;
    }
    try { await verifyOwner(owner); }
    catch (error) { Object.assign(notice, { state: 'pending', error: safeError(error) }); store.save(record); return; }
    // A previous attempt may have reached the desktop. Never send a second copy blindly.
    Object.assign(notice, { state: 'sending', attemptedAt: now() });
    store.save(record);
    try {
      const result = await callCodex(owner.threadId, 'send_message_to_thread', { threadId: owner.threadId, prompt: `${text}\n\n${marker}` });
      Object.assign(notice, result?.isError ? { state: 'pending', error: { message: 'The desktop rejected this notice before acceptance.' } }
        : { state: 'delivered', deliveredAt: now(), error: undefined });
    } catch (error) { Object.assign(notice, { state: 'unknown', error: safeError(error) }); }
    store.save(record);
  }

  async function completeReply(record, dispatch, result) {
    // The ordinary read view intentionally truncates individual messages. Delivery
    // must use raw, request-correlated events before one-shot data can be removed.
    const raw = await readDispatch(apiFor(record), record.sessionId, { workspace: record.workspace,
      requestId: dispatch.requestId, afterSeq: dispatch.afterSeq, maxMessages: 100 });
    if (!raw.ended || raw.boundary.endSeq !== result.endSeq) throw new Error('The complete native reply could not be verified.');
    return raw.page.records.filter(item => item.type === 'event' && item.event?.type === 'assistant/message')
      .map(item => item.event.data?.message ?? item.event.data)
      .map(message => (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'))
      .filter(Boolean).join('\n\n');
  }

  async function prepare(record) {
    const api = await checkHost(record, { creation: true });
    store.save(record);
    const created = await api.managedCreate(hostArgs(record));
    if (created.sessionId !== record.sessionId || created.modelRequestsStarted !== 0) throw new Error('DSH did not confirm the requested empty subagent.');
    record.model = created.model ?? resolveModel(await controlFor(record).models(), {});
    record.created = true; record.state = 'idle'; record.error = undefined; store.save(record);
  }

  async function negotiateTree(record, force = false) {
    if (!force && record.task.treeProtocol === TREE_PROTOCOL) return;
    const api = await checkHost(record, { taskTree: true });
    const after = record.task.dispatches[0]?.afterSeq;
    const started = await api.managedBeginTask({ ...hostArgs(record),
      ...(Number.isSafeInteger(after) && after >= -1 ? { taskStartSeq: after } : {}) });
    if (started.treeProtocol !== TREE_PROTOCOL) throw treeProtocolError();
    record.task.treeProtocol = TREE_PROTOCOL;
    store.save(record);
  }

  async function beginTask(record) {
    await negotiateTree(record, true);
    const selected = await controlFor(record).selectModel({ sessionId: record.sessionId, ...record.model, requestId: `${record.task.taskId}-model` });
    if (selected.accepted === false) throw new Error('DSH did not confirm the default model.');
    await sendDispatch(record, record.task.message);
  }

  async function resolveAnswer(record, answer) {
    if (answer.questionIds) return;
    const result = await apiFor(record).managedAnswer({ ...hostArgs(record), answerId: answer.answerId, message: answer.message });
    if (!result.consumedQuestionIds?.length) throw new Error('This subagent has no unanswered question.');
    answer.questionIds = result.consumedQuestionIds;
    answer.continuation = result.continuation ?? `主控回答：\n${answer.message}\n请继续完成原任务。`;
    store.save(record);
  }

  async function clearRecord(record) {
    record.state = 'cleaning'; record.closed = true; store.save(record);
    try {
      if (!record.nativeDestroyed) {
        const result = await (await checkHost(record)).managedDestroy(hostArgs(record));
        if (result.destroyed !== true) throw new Error(result.message ?? 'DSH has not confirmed complete session cleanup.');
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
      clients.delete(record.agentId);
      return { name: record.name, deleted: true, sessionDataRemoved: true };
    } catch (error) {
      const current = store.get(record.agentId);
      if (current) { current.state = 'cleanup_failed'; current.closed = true; current.error = safeError(error); store.save(current); }
      return { name: record.name, deleted: false, state: 'cleanup_failed', error: safeError(error) };
    }
  }

  async function finishDelivery(record) {
    const task = record.task;
    // Historical completed leaf results predate tree support and may be delivered
    // offline. New protocol tasks and anything already observed as a tree must
    // never use that compatibility path.
    const historicalLeaf = task.treeProtocol === undefined && !task.result.tree && !record.observation?.tree;
    if (!task.result.treeSettledConfirmed && !historicalLeaf) {
      // A result persisted by an older worker is not proof that its descendants
      // and native result notifications have completed.
      const view = await observe(record);
      const needsSummary = ownedTree(record, view).nodes.length > 1 && !task.cancelRequested;
      const summary = rootSummary(view);
      if (!treeSettled(record, view) || (needsSummary && !summary)) {
        return waitForTree(record, view, needsSummary && treeSettled(record, view));
      }
      if (needsSummary) Object.assign(task.result, { reply: summary.reply, state: summary.state });
      Object.assign(task.result, { changes: attributedChanges(record, view), coverage: treeCoverage(record, view),
        tree: publicTree(record, view), treeSettledConfirmed: true });
      task.state = task.result.state;
    }
    record.state = 'delivery_pending'; store.save(record);
    const resultText = `DSH 子代理「${record.name}」任务${task.state === 'completed' ? '完成' : task.state === 'cancelled' ? '已取消' : '失败'}。\n\n${task.result.reply}\n\n文件变更：\n${JSON.stringify(task.result.changes.map(fileSummary), null, 2)}\n观测范围：${typeof task.result.coverage === 'string' ? task.result.coverage : JSON.stringify(task.result.coverage)}\n\n这是任务结果，无需回复“收到”。`;
    await deliver(record, task.delivery, resultText);
    if (task.delivery.state === 'delivered') {
      if (record.lifetime === 'once') return clearRecord(record);
      record.state = 'idle';
    }
    store.save(record);
    return publicResult(record);
  }

  function waitForTree(record, view, summaryOnly = false) {
    record.state = record.task.state = 'running';
    record.observation = { ...view, activity: summaryOnly ? 'Waiting for the top-level DSH summary' : 'Waiting for the DSH task tree and notifications to settle' };
    store.save(record);
    return publicResult(record);
  }

  async function recoverDispatch(record, dispatch) {
    if (dispatch.accepted || !['sending', 'unknown'].includes(dispatch.state)) return;
    const key = createHash('sha256').update(JSON.stringify(['send', record.sessionId, dispatch.requestId])).digest('hex');
    try {
      const receipt = JSON.parse(await readFile(path.join(agentDirectory(record), 'requests', `${key}.json`), 'utf8'));
      dispatch.afterSeq = receipt.result?.afterSeq ?? receipt.afterSeq ?? dispatch.afterSeq;
      if (receipt.status === 'accepted') { dispatch.accepted = true; dispatch.state = 'running'; }
      if (receipt.status === 'rejected') dispatch.state = 'failed';
    } catch (error) {
      if (error.code === 'ENOENT' && dispatch.state === 'sending') {
        // writeOnce creates its receipt before entering the native send. No receipt
        // means this saved intent never reached that send; keep the exact request ID.
        await dispatchOnce(record, dispatch);
      } else if (error.code !== 'ENOENT') throw error;
    }
  }

  async function pollLocked(record) {
    if (record.state === 'cleaning') return clearRecord(record);
    if (record.closed || record.state === 'cleanup_failed' || record.state === 'idle') return publicResult(record);
    const task = record.task;
    try {
      if (task?.result) return await finishDelivery(record);
      if (!record.created) { await prepare(record); return publicResult(record); }
      if (!task) return publicResult(record);
      if (!task.dispatches.length && !task.cancelRequested) await beginTask(record);
      else await negotiateTree(record);
      for (const answer of task.answers ?? []) if (!answer.questionIds && !task.cancelRequested) await resolveAnswer(record, answer);
      const view = await observe(record);
      const unanswered = (view.questions ?? []).filter(question => question.state === 'pending');
      for (const question of unanswered) {
        task.questionNotices ??= {};
        const notice = task.questionNotices[question.id] ??= { state: 'pending' };
        await deliver(record, notice,
          `DSH 子代理「${record.name}」等待回答：\n${question.message}\n\n请调用 futureaide_answer_agent，name=${JSON.stringify(record.name)}，message 为回答正文。任务保持等待；无需文件、命令或内部编号。`);
      }
      for (const dispatch of task.dispatches) {
        if (['completed', 'cancelled', 'failed'].includes(dispatch.state)) continue;
        await recoverDispatch(record, dispatch);
        if (['completed', 'cancelled', 'failed'].includes(dispatch.state)) continue;
        const result = await controlFor(record).wait({ sessionId: record.sessionId, requestId: dispatch.requestId,
          ...(Number.isSafeInteger(dispatch.afterSeq) ? { afterSeq: dispatch.afterSeq } : {}), timeoutSeconds: 0, maxMessages: 100 });
        dispatch.afterSeq ??= result.afterSeq;
        if (result.state === 'ended' && (dispatch.accepted || result.correlation === 'request-id')) {
          Object.assign(dispatch, { state: endedState(result.completionReason), accepted: true,
            reply: await completeReply(record, dispatch, result), endSeq: result.endSeq });
        }
      }
      const outstanding = task.dispatches.some(dispatch => !['completed', 'cancelled', 'failed'].includes(dispatch.state));
      if (task.cancelRequested && !view.running && treeSettled(record, view)) {
        for (const dispatch of task.dispatches) if (!['completed', 'cancelled', 'failed'].includes(dispatch.state)) dispatch.state = 'cancelled';
      } else if (outstanding || view.running || task.cancelRequested) {
        record.state = unanswered.length ? 'awaiting_input' : 'running';
        task.state = record.state;
        store.save(record);
        return publicResult(record);
      }
      if (unanswered.length && !task.cancelRequested) {
        record.state = task.state = 'awaiting_input'; store.save(record); return publicResult(record);
      }
      const pendingAnswers = (task.answers ?? []).filter(answer => !answer.dispatched);
      if (pendingAnswers.length && !task.cancelRequested) {
        const ids = pendingAnswers.flatMap(answer => answer.questionIds);
        for (const answer of pendingAnswers) answer.dispatched = true;
        await sendDispatch(record, pendingAnswers.map(answer => answer.continuation).join('\n\n'), 'answer', ids);
        return publicResult(record);
      }
      if (!treeSettled(record, view)) return waitForTree(record, view);
      if (!task.result) {
        const final = task.dispatches.at(-1);
        let finalState = task.cancelRequested ? 'cancelled'
          : task.dispatches.some(dispatch => dispatch.state === 'failed') ? 'failed'
            : final?.state === 'cancelled' ? 'cancelled' : 'completed';
        const needsSummary = ownedTree(record, view).nodes.length > 1 && !task.cancelRequested;
        const summary = rootSummary(view);
        if (needsSummary && !summary) {
          return waitForTree(record, view, true);
        }
        if (needsSummary) finalState = summary.state;
        task.state = finalState;
        task.finishedAt = now();
        task.result = { state: task.state, reply: needsSummary ? summary.reply : final?.reply ?? final?.error?.message ?? '',
          changes: attributedChanges(record, view), coverage: treeCoverage(record, view),
          tree: publicTree(record, view), treeSettledConfirmed: true };
        task.delivery = { state: 'pending' };
      }
      return await finishDelivery(record);
    } catch (error) {
      record.state = record.task?.result ? 'delivery_pending' : 'reconnecting';
      record.error = safeError(error); record.observation = { ...record.observation, stale: true };
      clients.delete(record.agentId);
      store.save(record);
      return publicResult(record);
    }
  }

  const service = {
    store,
    async status(extra) {
      const status = { toolsLoaded: true, contextVerified: false, dshConnected: false, returnChannel: 'not-checked' };
      try {
        const owner = await context(extra);
        Object.assign(status, { contextVerified: true, workspace: owner.workspace, returnChannel: 'chat-verified', agents: store.list(owner.ownerId).length });
      } catch (error) { status.contextError = safeError(error); }
      try {
        const host = await clientFactory(config).hostStatus();
        status.dshConnected = METHODS.every(method => host.methods?.includes(method));
        status.treeProtocolReady = host.treeProtocol === TREE_PROTOCOL;
        if (!status.dshConnected) status.hostError = { message: 'Install the current managed DSH bridge.' };
        else if (!status.treeProtocolReady) status.hostError = safeError(treeProtocolError());
      } catch (error) { status.hostError = safeError(error); }
      status.ready = status.contextVerified && status.dshConnected && status.treeProtocolReady === true;
      return status;
    },
    async create({ name, lifetime }, extra) {
      assertName(name);
      if (!['once', 'persistent'].includes(lifetime)) throw new Error('lifetime must be once or persistent.');
      const owner = await context(extra);
      const record = { agentId: uid('agent'), ownerId: owner.ownerId, sessionId: uid('session-codex'), name, lifetime,
        workspace: owner.workspace, state: 'creating', createdAt: now(), updatedAt: now(), history: [] };
      store.insert(record); // The database's (owner,name) constraint arbitrates parallel creation.
      return store.locked(record.agentId, async () => {
        if (!store.get(record.agentId)) throw new Error('This subagent was removed while it was being created.');
        try {
          await prepare(record);
          return { ...publicResult(record), created: true, modelRequestsStarted: 0 };
        } catch (error) {
          record.state = 'reconnecting'; record.error = safeError(error); store.save(record); await ensureWorker(record);
          return { ...publicResult(record), created: false };
        }
      });
    },
    async send({ name, message }, extra) {
      textMessage(message);
      return withName(extra, name, async record => {
        if (record.closed || ['cleaning', 'cleanup_failed', 'creating'].includes(record.state)) throw new Error('This subagent is closing or not yet ready.');
        if (record.state === 'delivery_pending') throw new Error('The previous result is waiting for delivery. Read it before assigning another task.');
        if (!record.created) throw new Error('This subagent is still connecting; check its list status before sending a task.');
        await checkHost(record);
        if (record.task && ACTIVE.has(record.state)) {
          await negotiateTree(record);
          const view = await observe(record);
          if ((view.questions ?? []).some(question => question.state === 'pending')) return answerLocked(record, message);
          await sendDispatch(record, message, 'supplement');
        } else {
          if (record.task) record.history.push({ ...record.task, changes: attributedChanges(record, record.observation ?? {}),
            coverage: treeCoverage(record, record.observation ?? {}), tree: publicTree(record, record.observation ?? {}) });
          record.task = { taskId: uid('task'), message, state: 'starting', startedAt: now(), dispatches: [], answers: [] };
          record.state = 'running'; record.observation = undefined; store.save(record);
          try { await beginTask(record); }
          catch (error) { record.state = 'reconnecting'; record.error = safeError(error); store.save(record); }
        }
        await ensureWorker(record);
        return { ...publicResult(store.get(record.agentId) ?? record), accepted: record.task.dispatches.at(-1)?.accepted === true };
      });
    },
    async answer({ name, message }, extra) {
      textMessage(message);
      return withName(extra, name, record => answerLocked(record, message));
    },
    async list(extra) {
      const owner = await context(extra);
      for (const record of store.list(owner.ownerId)) await ensureWorker(record);
      const records = store.list(owner.ownerId);
      return { items: records.map(publicResult), total: records.length };
    },
    async changes({ name, task = 0 }, extra) {
      return withName(extra, name, async record => {
        if (task !== 0) {
          const historical = record.history.at(-task);
          if (!historical) throw new Error('That earlier task is not available. Use 0 for the current or latest task.');
          return { name, task, message: historical.message, changes: historical.changes ?? historical.result?.changes ?? [],
            coverage: historical.coverage, tree: historical.tree ?? historical.result?.tree };
        }
        try { await observe(record); store.save(record); } catch (error) { record.error = safeError(error); }
        return { name, task: 0, changes: attributedChanges(record, record.observation ?? {}),
          tree: publicTree(record, record.observation ?? {}), coverage: treeCoverage(record, record.observation ?? {}),
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
        for (let index = 0; index < nodes.length; index++) {
          const { node } = nodes[index];
          try {
            const raw = await apiFor(record).managedHistory({ ...hostArgs(record), targetSessionId: node.sessionId });
            if (!Array.isArray(raw?.events)) throw Object.assign(new Error('The DSH bridge returned invalid session history.'), { code: 'invalid-response' });
            const page = { records: raw.events.map(event => ({ type: 'event', event })), hasMore: false };
            const history = historyMessages(page, { sessionId: node.sessionId, running: node.status === 'running' });
            const selected = { messages: history.messages.slice(-maxMessages), hasMore: history.hasMore || history.messages.length > maxMessages,
              ...(history.note ? { note: history.note } : {}) };
            Object.assign(tree.nodes[index], selected);
            if (node.sessionId === record.sessionId) rootHistory = selected;
          } catch (error) {
            tree.nodes[index].error = safeError(error);
            if (node.sessionId === record.sessionId) rootError = safeError(error);
          }
        }
        return { ...publicResult(record), ...(rootHistory ?? {}), ...(rootError ? { error: rootError } : {}),
          tree, inspectionIncomplete: tree.nodes.some(node => node.error !== undefined),
          historyCount: record.history.length,
          history: record.history.slice(-20).reverse().map((task, index) => ({ task: index + 1, message: compactText(task.message, 240),
            state: task.state, startedAt: task.startedAt, finishedAt: task.finishedAt })) };
      });
    },
    async cancel({ name }, extra) {
      return withName(extra, name, async record => {
        if (!record.task || !ACTIVE.has(record.state)) return { name, cancelled: false, state: record.state };
        await negotiateTree(record);
        record.task.cancelRequested = true; store.save(record);
        const result = await (await checkHost(record)).managedCancel(hostArgs(record));
        record.state = 'running'; store.save(record); await ensureWorker(record);
        return { name, cancelled: result.cancelled !== false, state: 'cancelling' };
      });
    },
    async delete({ name }, extra) { return withName(extra, name, record => clearRecord(record)); },
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
        if (!selectedIds.length || notListed.size || items.some(item => ['awaiting_input', 'idle', 'delivery_pending', 'cleanup_failed', 'failed'].includes(item.state))) break;
        if (Date.now() >= deadline) break;
        await wait(Math.min(250, deadline - Date.now()));
      } while (true);
      return { items, notListed: [...notListed],
        ...(notListed.size ? { note: 'These names are not in this chat’s current list. Absence alone does not prove task completion; use the delivered result.' } : {}),
        timedOut: Date.now() >= deadline && items.some(item => item.state === 'running') };
    },
    async poll(agentId) {
      return store.locked(agentId, async () => { const record = store.get(agentId); return record ? pollLocked(record) : { removed: true }; });
    },
    async resume() { for (const record of store.list()) await ensureWorker(record); },
    close() { store.close(); },
  };

  async function answerLocked(record, message) {
    if (!record.task || record.closed || record.task.cancelRequested) throw new Error('This subagent has no open task waiting for an answer.');
    await negotiateTree(record);
    await checkHost(record);
    const view = await observe(record);
    const existing = (record.task.answers ?? []).find(answer => !answer.questionIds && answer.message === message);
    if (!existing && !(view.questions ?? []).some(question => question.state === 'pending')) throw new Error('This subagent has no unanswered question.');
    record.task.answers ??= [];
    const answer = existing ?? { answerId: uid('answer'), message, dispatched: false };
    if (!existing) record.task.answers.push(answer);
    store.save(record);
    try { await resolveAnswer(record, answer); }
    catch (error) { record.error = safeError(error); store.save(record); await ensureWorker(record); throw error; }
    record.state = 'running'; record.task.state = 'running'; store.save(record);
    await ensureWorker(record);
    return { name: record.name, answered: true, state: 'resuming' };
  }
  return service;
}
