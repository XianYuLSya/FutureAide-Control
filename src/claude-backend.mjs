// Claude Desktop implementation of the same backend boundary DSH uses. The
// scoped layer owns tasks, queues, notices, cancellation and cleanup decisions.
// This adapter owns only native bindings, byte cursors and delivery evidence.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as hostModule from './claude-host.mjs';
import { bindClaude, sendClaude } from './claude-inbox.mjs';
import { emptyClaudeProjection, observeClaudeTranscript, claudeTurn, CLAUDE_FILE_COVERAGE } from './claude-observer.mjs';

const METHODS = ['probe', 'create', 'beginTask', 'observe', 'history', 'answer', 'deliver',
  'receipt', 'turn', 'models', 'model', 'selectModel', 'cancel', 'destroy', 'cursor'];
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function createClaudeBackend(record, deps = {}) {
  const env = deps.env ?? process.env;
  const dataRoot = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'));
  const host = { ...hostModule, ...deps.host };
  const driver = deps.driver ?? host.createPowerShellDriver();
  const load = deps.load ?? (() => record);
  const readState = () => deps.readNativeState?.() ?? { requests: {} };
  const save = value => {
    if (deps.writeNativeState?.(value) === false) throw failure('agent-not-found', 'This managed Claude agent was removed.');
    return value;
  };
  const lockedHost = action => deps.withHostLock ? deps.withHostLock(action) : action();
  const bind = deps.bindClaude ?? bindClaude;
  const send = deps.sendClaude ?? sendClaude;
  const observeTranscript = deps.observeTranscript ?? observeClaudeTranscript;
  let treeModule = deps.tree;
  if (!treeModule) {
    try { treeModule = await import('./claude-tree.mjs'); }
    catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('claude-tree')) throw error; }
  }

  function stateForTask() {
    const state = readState();
    state.requests ??= {};
    return state;
  }
  const hostOptions = () => ({ driver, env, workspace: load().workspace });

  async function requireReports() {
    if (deps.ensureClaudeReports) {
      const result = await deps.ensureClaudeReports();
      if (result?.ready !== true) throw failure('claude-report-not-ready', 'The shared Claude report service is not ready.');
      return result;
    }
    throw failure('claude-report-not-ready', 'This installation has not connected the shared Claude report service.');
  }

  async function rememberBinding(state, native) {
    const sessionId = native.nativeSessionId ?? native.sessionId;
    const binding = await bind({ pid: native.pid, sessionId, workspace: load().workspace }, { env });
    state.binding = { ...binding, hostSessionId: native.hostSessionId ?? state.binding?.hostSessionId,
      name: native.name ?? state.binding?.name };
    save(state); // visible to tools/list before the first model turn
    return state.binding;
  }

  // The stable identity is the native session id. PID/pipe/start-time are just
  // its current binding and can be refreshed without changing task identity.
  async function nativeSession(state, { resume = false } = {}) {
    const binding = state.binding;
    if (!binding) return undefined;
    try {
      const value = JSON.parse(await readFile(binding.recordFile, 'utf8'));
      if (value.sessionId === binding.sessionId && value.pid === binding.pid
          && value.procStart === binding.procStart && value.entrypoint === 'claude-desktop'
          && samePath(value.cwd, load().workspace) && (deps.isAlive ?? alive)(value.pid)) return value;
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    let found;
    try { found = await host.resolveNativeSession(binding.sessionId, { env, workspace: load().workspace }); }
    catch (error) { if (error.code !== 'unknown-native-session') throw error; }
    if (!found?.alive && resume) {
      const reopened = await lockedHost(() => host.resume({ nativeSessionId: binding.sessionId,
        hostSessionId: binding.hostSessionId }, hostOptions()));
      if (!reopened?.resumed) throw failure('claude-session-unavailable', 'The original Claude session could not be resumed.');
      found = await host.resolveNativeSession(binding.sessionId, { env, workspace: load().workspace });
    }
    if (!found?.alive) throw failure('claude-session-unavailable', 'The original Claude session is not running.');
    await rememberBinding(state, found);
    return { sessionId: found.nativeSessionId, pid: found.pid, status: found.status, cwd: found.workspace,
      name: found.name, hostSessionId: found.hostSessionId };
  }

  async function refresh({ resume = false } = {}) {
    const current = load();
    const state = stateForTask();
    state.projection ??= emptyClaudeProjection(current.task?.taskId);
    if (!state.binding) return { state, native: undefined, running: false };
    const native = await nativeSession(state, { resume });
    const observed = await observeTranscript(state.binding, state.projection, {
      workspace: current.workspace, agentId: current.agentId, requestIds: Object.keys(state.requests) });
    state.projection = observed.projection;
    for (const [requestId, delivery] of Object.entries(state.projection.deliveries)) {
      const request = state.requests[requestId];
      if (request) Object.assign(request, { status: 'accepted', deliveryStage: delivery.stage, deliverySeq: delivery.seq });
    }
    const running = native.status !== 'idle';
    let tree;
    if (treeModule?.observeClaudeTree) {
      const result = await treeModule.observeClaudeTree(state.binding, state.projection, {
        logicalSessionId: current.sessionId, agentId: current.agentId, name: current.name,
        workspace: current.workspace, taskId: current.task?.taskId,
        nativeStatus: native.status, state: state.treeState ?? {} });
      tree = result.tree;
      state.treeState = result.state;
      state.histories = result.histories;
    }
    save(state);
    return { state, native, running, tree, hasMore: observed.hasMore };
  }

  function receiptFrom(state, requestId) {
    const request = state.requests?.[requestId];
    if (!request) return undefined; // genuinely never attempted
    return { status: request.status ?? 'unknown', afterSeq: request.afterSeq,
      ...(request.status === 'accepted' ? { result: { accepted: true, requestId } } : {}) };
  }

  async function recoverFirstBinding(state) {
    if (state.binding || !state.bindingNonce) return state;
    const first = Object.values(state.requests ?? {}).find(request => request.attempted);
    if (!first || typeof host.findCreatedSession !== 'function') return state;
    const found = await host.findCreatedSession({ workspace: load().workspace,
      requestId: first.requestId, bindingNonce: state.bindingNonce }, { env });
    if (!found) return state;
    await rememberBinding(state, found);
    const observed = await refresh();
    state = observed.state;
    const marker = host.markerLine(first.requestId, state.bindingNonce);
    const user = state.projection.messages.find(item => item.role === 'user' && item.text.includes(marker));
    state.requests[first.requestId].status = 'accepted';
    state.projection.deliveries[first.requestId] = { requestId: first.requestId, stage: 'inserted',
      seq: user?.seq ?? first.afterSeq };
    return save(state);
  }

  async function currentModel(state) {
    if (!state.binding) return lockedHost(() => host.readDefaultModel(hostOptions()));
    if (typeof host.readCurrentModel !== 'function') {
      throw failure('model-observation-unsupported', 'The host adapter cannot read the session’s next model selection yet.');
    }
    return lockedHost(() => host.readCurrentModel({ nativeSessionId: state.binding.sessionId }, hostOptions()));
  }

  return {
    target: 'claude-desktop', labels: { host: 'Claude Desktop', bridge: 'The Claude Desktop adapter' },
    requiredMethods: METHODS,
    async probe() {
      const present = await stat(path.join(dataRoot, 'sessions')).then(value => value.isDirectory(), () => false);
      if (!present) throw failure('claude-desktop-unavailable', 'Claude Desktop has no native session registry on this host.');
      return { identity: { application: 'claude-desktop', dataRoot }, methods: METHODS,
        treeProtocol: treeModule?.TREE_PROTOCOL ?? null, reportProtocol: 1 };
    },
    async create() {
      await requireReports();
      save({ ...stateForTask(), reserved: true });
      return { sessionId: load().sessionId, modelRequestsStarted: 0 };
    },
    async beginTask() {
      const current = load();
      let state = stateForTask();
      if (state.binding) ({ state } = await refresh({ resume: true }));
      if (state.projection?.taskId !== current.task?.taskId) {
        state.projection = emptyClaudeProjection(current.task?.taskId, {
          throughSeq: state.projection?.throughSeq ?? 0, currentModel: state.projection?.currentModel });
        state.treeState = {};
        state.histories = {};
        // Old dispatch evidence remains for cold recovery/history; each shared
        // task owns fresh request ids, so it cannot be sent twice on reuse.
        save(state);
      }
      return { treeProtocol: treeModule?.TREE_PROTOCOL ?? null, reportProtocol: 1,
        throughSeq: state.projection.throughSeq, currentModel: await currentModel(state) };
    },
    async observe() {
      const current = load();
      const { state, running, tree } = await refresh();
      const p = state.projection;
      const emptyTree = { settled: true, running: false, nodes: [{ sessionId: current.sessionId,
        parentSessionId: null, name: current.name, status: 'idle', activity: 'idle', changes: [], coverage: CLAUDE_FILE_COVERAGE }] };
      if (state.binding && !tree) throw failure('tree-protocol-required', 'Claude task-tree observation is not ready.');
      return { sessionId: current.sessionId, taskId: current.task?.taskId, running: tree?.running ?? running,
        throughSeq: p.throughSeq, currentModel: p.currentModel, modelSelectionObserved: false, activity: p.activity,
        changes: p.changes, coverage: CLAUDE_FILE_COVERAGE, questions: p.questions, reports: p.reports,
        tree: tree ?? emptyTree };
    },
    async history({ targetSessionId, maxMessages = 20 } = {}) {
      const { state } = await refresh();
      const root = !targetSessionId || targetSessionId === load().sessionId;
      const history = root ? { messages: state.projection.messages, hasMore: state.projection.messagesOmitted > 0 }
        : state.histories?.[targetSessionId];
      if (!history) throw failure('unknown-owned-node', 'This node is not in the managed Claude task tree.');
      return { messages: history.messages.slice(-maxMessages), hasMore: history.hasMore || history.messages.length > maxMessages };
    },
    async answer({ answerId, message }) {
      const { state } = await refresh();
      const previous = state.answers?.[answerId];
      if (previous) return previous;
      const questions = state.projection.questions.filter(item => item.state === 'pending');
      const result = { consumedQuestionIds: questions.map(item => item.id), continuation: `主控回答：\n${message}\n请继续完成原任务。` };
      if (questions.length) {
        for (const question of questions) question.state = 'answered';
        (state.answers ??= {})[answerId] = result;
        save(state);
      }
      return result;
    },
    async deliver({ requestId, message }) {
      await requireReports();
      const current = load();
      let state = stateForTask();
      const previous = receiptFrom(state, requestId);
      if (previous && previous.status !== 'retryable') return {
        accepted: previous.status === 'accepted', status: previous.status, afterSeq: previous.afterSeq };
      state.projection ??= emptyClaudeProjection(current.task?.taskId);
      const request = { requestId, status: 'retryable', attempted: false, afterSeq: state.projection.throughSeq,
        taskId: current.task?.taskId, startedAt: new Date().toISOString() };
      state.requests[requestId] = request;
      save(state); // write intent before either native write or UI submit
      if (!state.binding) {
        const bindingNonce = state.bindingNonce ??= randomUUID();
        save(state);
        const prompt = `你是 FutureAide Control 受管子代理「${current.name}」。工作目录：${current.workspace}。\n`
          + '使用 futureaide-report 的 ask_parent 提问、report_parent 汇报；普通回复不会通知主控。'
          + '完成当前任务并验证后调用 report_parent(message, final=true)，提问后结束本轮等待回答。\n\n' + message;
        let created;
        try {
          created = await lockedHost(() => {
            request.attempted = true; request.status = 'unknown'; save(state);
            return host.createFirstTurn({ workspace: current.workspace, requestId, message: prompt, bindingNonce },
              { ...hostOptions(), onBound: native => rememberBinding(state, native) });
          });
        } catch (error) { throw failure(error.code ?? 'claude-create-unconfirmed', error.message,
          request.attempted ? { uncertain: true } : { retryableRead: true }); }
        if (!created?.nativeSessionId || (!created.created && !created.reused)) {
          return { accepted: false, status: 'unknown', afterSeq: request.afterSeq };
        }
        try {
          await rememberBinding(state, created);
          ({ state } = await refresh());
        } catch (error) {
          throw failure(error.code ?? 'claude-created-observation-pending', error.message, { uncertain: true });
        }
        // The host verified our unique request+nonce in the initial user event.
        // It is native acceptance evidence even though UI sends do not use our
        // request id as the native user UUID.
        const acceptedAt = state.projection.messages.find(item => item.role === 'user'
          && item.text.includes(host.markerLine(requestId, bindingNonce)))?.seq ?? request.afterSeq;
        state.requests[requestId].status = 'accepted';
        state.projection.deliveries[requestId] = { requestId, stage: 'inserted', seq: acceptedAt };
        try { save(state); }
        catch (error) { throw failure(error.code ?? 'claude-receipt-pending', error.message, { uncertain: true }); }
        return { accepted: true, afterSeq: request.afterSeq };
      }
      try {
        await nativeSession(state, { resume: true });
      } catch (error) {
        request.error = error.code ?? error.message;
        save(state);
        throw failure(error.code ?? 'claude-send-unavailable', error.message, { retryableRead: true });
      }
      request.attempted = true; request.status = 'unknown'; save(state);
      let result;
      try { result = await send(state.binding, message, { requestId }); }
      catch (error) {
        // sendClaude throws only during its pre-write record/key checks. Once
        // it connects, every outcome is a written/uncertain/failed receipt.
        request.attempted = false; request.status = 'retryable'; request.error = error.code ?? error.message;
        save(state);
        throw failure(error.code ?? 'claude-send-unavailable', error.message, { retryableRead: true });
      }
      request.status = result.status === 'failed' ? 'retryable' : 'unknown';
      request.attempted = result.status !== 'failed';
      request.transport = result.status;
      // A state-save failure after the write must leave the earlier unknown
      // intent intact, never turn a written message into a retryable request.
      try {
        save(state);
        ({ state } = await refresh());
      } catch (error) {
        throw failure(error.code ?? 'claude-written-observation-pending', error.message,
          result.status === 'failed' ? { retryableRead: true } : { uncertain: true });
      }
      const receipt = receiptFrom(state, requestId);
      return { accepted: receipt.status === 'accepted', status: receipt.status === 'retryable' ? 'retrying' : receipt.status,
        afterSeq: receipt.afterSeq };
    },
    async receipt({ requestId }) {
      let state = stateForTask();
      if (!state.requests[requestId]) return undefined;
      if (!state.binding) state = await recoverFirstBinding(state);
      if (!state.binding) return receiptFrom(state, requestId);
      return receiptFrom((await refresh()).state, requestId);
    },
    async turn({ requestId, afterSeq = 0 }) {
      const { state, running, tree } = await refresh();
      return claudeTurn(state.projection, requestId, { running: tree?.running ?? running, afterSeq });
    },
    async models() {
      const value = await lockedHost(() => host.readDefaultModel(hostOptions()));
      if (!value?.model || value.resolved === false || value.verified === false) {
        throw failure('claude-default-model-unresolved', 'Claude Desktop’s current default model could not be read.');
      }
      const selection = { provider: value.provider ?? 'anthropic', model: value.model,
        ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) };
      return { default: selection, routableProviders: [selection.provider], groups: [{ id: selection.provider,
        models: [{ id: selection.model, reasoningEfforts: value.reasoningEffort ? [value.reasoningEffort] : [] }] }] };
    },
    async model() { return currentModel(stateForTask()); },
    async selectModel(input) {
      const state = stateForTask();
      return lockedHost(() => host.selectModel({ ...input,
        ...(state.binding ? { nativeSessionId: state.binding.sessionId } : {}) }, hostOptions()));
    },
    async cancel() {
      const state = await recoverFirstBinding(stateForTask());
      if (!state.binding) return { cancelRequested: !Object.values(state.requests ?? {}).some(request => request.attempted) };
      const native = await nativeSession(state);
      if (native.status === 'idle') {
        const observed = await refresh();
        if (observed.tree?.settled === true) return { cancelRequested: true };
      }
      const result = await lockedHost(() => host.interrupt({ nativeSessionId: state.binding.sessionId }, hostOptions()));
      if (result.interrupted !== true) return { cancelRequested: false, ...result };
      return { cancelRequested: true }; // the shared layer still waits for the entire tree
    },
    async destroy() {
      const state = await recoverFirstBinding(stateForTask());
      const attempted = Object.values(state.requests ?? {}).some(request => request.attempted);
      if (!state.binding) return { destroyed: !attempted,
        ...(attempted ? { message: 'The first native send is still unconfirmed; retaining its ownership record.' } : {}) };
      return lockedHost(() => host.destroy({ nativeSessionId: state.binding.sessionId, binding: state.binding }, hostOptions()));
    },
    async cursor() { return { throughSeq: (await refresh()).state.projection.throughSeq }; },
  };
}
