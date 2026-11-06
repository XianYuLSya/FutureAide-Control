import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { BACKEND_METHODS } from './agent-backend.mjs';
import * as cliRunner from './claude-cli-runner.mjs';

export const CLAUDE_CLI_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const CLAUDE_CLI_EFFORTS = cliRunner.CLAUDE_EFFORTS;
const coverage = { source: 'claude-cli', complete: false,
  note: 'File attribution uses the shared before/after workspace comparison.' };
const fail = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });

export function createClaudeCliBackend(record, deps = {}) {
  const load = deps.load ?? (() => record);
  const runner = deps.runner ?? cliRunner;
  const state = () => ({ seq: 0, requests: {}, answers: {}, answered: [], ...deps.readNativeState?.() });
  const save = value => {
    if (!deps.writeNativeState) throw fail('claude-state-unavailable', 'The shared native-state store is required.');
    if (deps.writeNativeState(value) === false) throw fail('agent-not-found', 'The managed Claude name was removed.');
  };
  const callbacksReady = () => typeof deps.readParentSubmissions === 'function' && typeof deps.claudeReportConfig === 'function';
  // One backend instance per operation. Readiness is fresh on the next status
  // or dispatch, while a single creation does not repeatedly spawn auth probes.
  let checked;
  async function preflight() {
    checked ??= runner.probeClaudeCli();
    const result = await checked;
    if (!result?.cli) throw fail('claude-cli-not-found', 'The Claude Code CLI was not found.');
    if (result.auth?.loggedIn === false) throw fail('claude-cli-auth-required', 'Sign in using claude auth login.');
    return result.cli;
  }
  async function submissions(value) {
    const taskId = load().task?.taskId;
    const { questions = [], reports = [] } = await deps.readParentSubmissions();
    return { questions: questions.filter(q => q.taskId === taskId)
      .map(q => value.answered.includes(q.id) ? { ...q, state: 'answered' } : q),
    reports: reports.filter(r => r.taskId === taskId) };
  }
  function directory(requestId) {
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,119}$/.test(requestId)) throw fail('invalid-dispatch', 'Invalid request id.');
    return path.join(deps.requestDirectory(), 'claude-cli', 'turns', requestId);
  }

  // Persist the native result as soon as ANY observer sees it. In particular,
  // final report delivery can retire a task before the shared loop calls turn().
  async function refresh(value) {
    const id = value.active;
    if (!id) return;
    const request = value.requests[id];
    let native;
    try { native = await runner.readClaudeTurn(directory(id)); }
    catch (error) {
      if (request.status === 'unknown' && error.code === 'claude-turn-not-found') {
        // The runner uses an exclusive per-request claim, so replaying this
        // same intent is safe even if a worker was between its initial writes.
        request.status = 'retryable'; delete value.active; save(value); return;
      }
      throw error;
    }
    let changed = request.status !== 'accepted';
    request.status = 'accepted';
    if (native.model && native.model !== value.currentModel?.model) {
      value.currentModel = { provider: 'claude-cli', model: native.model };
      changed = true;
    }
    if ((native.sessionStarted || native.state === 'ended') && !value.started) {
      value.started = true;
      changed = true;
    }
    if (native.state !== 'running') {
      const failure = native.state === 'failed'
        ? { source: 'model', code: 'claude-cli-failed', message: 'The Claude CLI turn failed.', ...native.error } : undefined;
      const kind = failure ? 'error' : native.state === 'cancelled' ? 'cancelled' : 'completed';
      request.terminal = { completionReason: failure ? { kind, error: failure } : { kind },
        endSeq: ++value.seq, ...(failure ? { failure } : {}) };
      if (!value.started) delete value.sessionId;
      delete value.active;
      changed = true;
    }
    if (changed) save(value);
    return native;
  }

  async function cancel() {
    const value = state();
    const id = value.active;
    if (!id) return { cancelRequested: true };
    // Let the runner verify process-tree termination, including a cancellation
    // racing startup. An unreadable directory must not discard its ownership.
    const result = await runner.cancelClaudeTurn(directory(id));
    if (result !== true && result?.stopped !== true) {
      return { cancelRequested: false, reason: result?.note ?? 'The Claude process tree is still running.' };
    }
    await refresh(value);
    return { cancelRequested: true };
  }
  const backend = {
    target: 'claude-cli', labels: { host: 'Claude CLI', bridge: 'The Claude CLI runner' }, requiredMethods: BACKEND_METHODS,
    async probe() {
      // Monitoring and cleanup use only local receipts, even after logout.
      if (!load().created) await preflight();
      return { identity: { application: 'claude-cli' }, methods: BACKEND_METHODS,
        treeProtocol: 1, reportProtocol: callbacksReady() ? 1 : null };
    },
    async create() {
      if (!callbacksReady()) throw fail('claude-report-not-ready', 'The Claude parent-report MCP server is unavailable.');
      await preflight();
      save(state());
      return { sessionId: load().sessionId, modelRequestsStarted: 0 };
    },
    async beginTask() {
      const value = state();
      await refresh(value);
      const taskId = load().task?.taskId;
      if (taskId !== value.taskId) {
        value.taskId = taskId; value.answered = []; value.answers = {}; save(value);
      }
      return { treeProtocol: 1, reportProtocol: 1, throughSeq: value.seq,
        ...(value.currentModel ? { currentModel: value.currentModel } : {}) };
    },
    async observe() {
      const value = state();
      const native = await refresh(value);
      const running = native?.state === 'running';
      const current = load();
      const status = running ? 'running' : 'idle';
      const last = Object.values(value.requests).filter(r => r.taskId === current.task?.taskId).at(-1);
      const failed = last?.terminal?.failure;
      return { sessionId: current.sessionId, taskId: current.task?.taskId, running, throughSeq: value.seq,
        currentModel: value.currentModel, modelSelectionObserved: false, changes: [], coverage,
        ...await submissions(value), tree: { settled: !running, running,
          ...(failed ? { rootSummary: { ready: true, state: 'failed', reply: failed.message } } : {}),
          nodes: [{ sessionId: current.sessionId, parentSessionId: null, name: current.name, status,
            activity: status, changes: [], coverage }] } };
    },
    async history({ targetSessionId, maxMessages = 20, requestId } = {}) {
      const current = load();
      if (targetSessionId && targetSessionId !== current.sessionId) throw fail('unknown-owned-node', 'Unknown Claude CLI session.');
      const value = state();
      const messages = [];
      // The worker already stores each turn's history. Read only the tail that
      // fills this page and keep large conversations out of the shared roster.
      const ids = Object.keys(value.requests).filter(id => value.requests[id].taskId === current.task?.taskId
        && value.requests[id].status === 'accepted');
      let hasMore = false;
      for (let index = ids.length - 1; index >= 0; index--) {
        const native = await runner.readClaudeTurn(directory(ids[index]));
        messages.unshift(...(native.messages ?? []));
        if (native.messagesDropped > 0 || messages.length >= maxMessages) {
          hasMore = native.messagesDropped > 0 || messages.length > maxMessages || index > 0; break;
        }
      }
      const failure = value.requests[requestId ?? ids.at(-1)]?.terminal?.failure;
      return { messages: messages.slice(-maxMessages), hasMore, ...(failure ? { failure } : {}) };
    },
    async answer({ answerId, message }) {
      const value = state();
      if (value.answers[answerId]) return value.answers[answerId];
      const pending = (await submissions(value)).questions.filter(q => q.state === 'pending');
      if (!pending.length) throw fail('question-not-pending', 'There is no unanswered question for this task.');
      const ids = pending.map(q => q.id);
      value.answered.push(...ids);
      const result = { consumedQuestionIds: ids, continuation: 'Parent answer:\n' + message + '\nContinue the same task.' };
      value.answers[answerId] = result; save(value); return result;
    },
    async deliver({ requestId, message, model, explicitModel = false }) {
      if (!message?.trim() || !requestId || Boolean(model) !== explicitModel || (explicitModel && !model.model)) {
        throw fail('invalid-dispatch', 'A request id, message and consistent model selection are required.', { terminal: true });
      }
      const dir = directory(requestId);
      const value = state();
      await refresh(value);
      const hash = createHash('sha256').update(message).digest('hex');
      const prior = value.requests[requestId];
      if (prior && (prior.messageHash !== hash || prior.model?.model !== model?.model
          || prior.model?.reasoningEffort !== model?.reasoningEffort)) {
        throw fail('request-id-conflict', 'The request id already belongs to a different input.');
      }
      if (prior && prior.status !== 'retryable') {
        return { accepted: prior.status === 'accepted', status: prior.status, afterSeq: prior.afterSeq };
      }
      if (value.active) return { accepted: false, status: 'retryable' };
      const cli = await preflight();
      const mcpConfig = deps.claudeReportConfig(requestId);
      value.sessionId ??= randomUUID();
      const request = { messageHash: hash, taskId: load().task?.taskId, afterSeq: value.seq, model, status: 'unknown' };
      value.requests[requestId] = request; value.active = requestId; save(value);
      try {
        const result = await runner.startClaudeTurn({ cli, directory: dir, workspace: load().workspace, name: load().name,
          sessionId: value.sessionId, resume: value.started === true, message, model: model?.model,
          effort: model?.reasoningEffort, mcpConfig });
        if (result?.accepted !== true && !result?.duplicate) throw fail('claude-cli-start-refused', 'The CLI worker refused the turn.', { terminal: true });
      } catch (error) {
        request.status = error.terminal ? 'rejected' : error.retryable || error.retryableRead ? 'retryable' : 'unknown';
        if (request.status !== 'unknown') delete value.active;
        save(value);
        if (request.status === 'retryable') error.retryableRead = true;
        if (request.status === 'unknown') error.uncertain = true;
        throw error;
      }
      request.status = 'accepted'; save(value);
      return { accepted: true, status: 'accepted', afterSeq: request.afterSeq };
    },
    async receipt({ requestId }) {
      const value = state();
      if (value.requests[requestId]?.status === 'unknown') await refresh(value);
      const request = value.requests[requestId];
      return request && { status: request.status, afterSeq: request.afterSeq,
        ...(request.status === 'accepted' ? { result: { accepted: true, requestId } } : {}) };
    },
    async turn({ requestId }) {
      const value = state();
      if (value.active === requestId) await refresh(value);
      const request = value.requests[requestId];
      return request?.terminal ? { state: 'ended', correlation: 'request-id', ...request.terminal }
        : { state: 'running', ...(request?.status === 'accepted' ? { correlation: 'request-id' } : {}) };
    },
    async models() {
      return { groups: [{ id: 'claude-cli', models: CLAUDE_CLI_MODELS.map(id => ({
        id, name: id, reasoning: { efforts: CLAUDE_CLI_EFFORTS.map(effort => ({ id: effort })) },
      })) }], note: 'Effort values are passed verbatim. Per-model support requires verification.' };
    },
    async model() {
      const value = state(); await refresh(value); return value.currentModel;
    },
    async selectModel() {
      throw fail('model-selection-unsupported', 'Claude CLI applies an explicit model selection when a turn starts.');
    },
    cancel,
    async destroy() {
      const result = await cancel();
      if (!result.cancelRequested) return { destroyed: false, message: result.reason };
      return { destroyed: true, nativeSessionRetained: state().started === true };
    },
    async cursor() { return { throughSeq: state().seq }; },
  };
  // A parent's tree inspection can observe this child while its own worker
  // dispatches. Serialize native-state writes across those roster operations.
  if (deps.withHostLock) {
    for (const method of ['beginTask', 'observe', 'answer', 'deliver', 'receipt', 'turn', 'model', 'cancel', 'destroy']) {
      const action = backend[method];
      backend[method] = (...args) => deps.withHostLock(() => action(...args), { key: load().agentId });
    }
  }
  return backend;
}
