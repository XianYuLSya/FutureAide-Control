import { answerCliQuestions } from './cli-question-selection.mjs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { BACKEND_METHODS } from './agent-backend.mjs';
import * as cliRunner from './claude-cli-runner.mjs';

const coverage = { source: 'claude-cli', complete: false,
  note: 'File attribution uses the shared before/after workspace comparison.' };
export const CLI_STALLED_THRESHOLD_SECONDS = 180;
const fail = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });

function sumUsageList(items) {
  const valid = items.filter(item => item && typeof item === 'object');
  if (!valid.length) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let totalTokens = 0;
  let durationSec = 0;
  for (const u of valid) {
    inputTokens += Number(u.inputTokens) || 0;
    outputTokens += Number(u.outputTokens) || 0;
    cachedTokens += Number(u.cachedTokens) || 0;
    totalTokens += Number(u.totalTokens) || 0;
    durationSec += Number(u.durationSec) || 0;
  }
  return {
    inputTokens: Math.round(inputTokens),
    outputTokens: Math.round(outputTokens),
    cachedTokens: Math.round(cachedTokens),
    totalTokens: Math.round(totalTokens),
    durationSec: Math.round(durationSec * 100) / 100,
  };
}

function formatRunningActivity(native, nowMs = Date.now()) {
  const refIso = native?.lastEventAt ?? native?.updatedAt ?? native?.startedAt;
  const parsedMs = typeof refIso === 'string' && refIso ? Date.parse(refIso) : NaN;
  const hasTimestamp = Number.isFinite(parsedMs);
  const hasStep = typeof native?.lastStep === 'string' && native.lastStep.trim().length > 0;
  if (!hasTimestamp && !hasStep) return { stalled: false, activity: 'running' };
  const step = hasStep ? native.lastStep.trim() : '运行中';
  if (!hasTimestamp) return { stalled: false, activity: step };
  const silentSec = Math.max(0, Math.floor((nowMs - parsedMs) / 1000));
  if (silentSec >= CLI_STALLED_THRESHOLD_SECONDS) {
    return { stalled: true, silentSeconds: silentSec, activity: `⚠ 已静默 ${silentSec}s · ${step}` };
  }
  return { stalled: false, silentSeconds: silentSec, activity: `${silentSec}s前 · ${step}` };
}

export function createClaudeCliBackend(record, deps = {}) {
  const load = deps.load ?? (() => record);
  const runner = deps.runner ?? cliRunner;
  const nowFn = deps.now ?? (() => Date.now());
  const state = () => ({ seq: 0, requests: {}, answers: {}, answered: [], ...deps.readNativeState?.() });
  const save = value => {
    if (!deps.writeNativeState) throw fail('claude-state-unavailable', 'The shared native-state store is required.');
    if (deps.writeNativeState(value) === false) throw fail('agent-not-found', 'The managed Claude name was removed.');
  };
  const callbacksReady = () => typeof deps.readParentSubmissions === 'function' && typeof deps.claudeReportConfig === 'function';
  // One backend instance per operation. Readiness is fresh on the next status
  // or dispatch, while a single creation does not repeatedly spawn auth probes.
  let checked;
  let catalog;
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
    // A refusal the runner wrote down stays a refusal: the state on disk says nothing was
    // dispatched, so a later read must never turn it into an accepted turn. This is the
    // window where the adapter process dies after the runner recorded the refusal and
    // before it could save its own rejected request.
    const refused = native?.notSent === true || native?.error?.notSent === true;
    const accepted = native.businessAccepted === true || request.status === 'accepted';
    const next = refused ? 'rejected' : accepted ? 'accepted' : native.state === 'failed' ? 'failed' : 'unknown';
    let changed = request.status !== next;
    request.status = next;
    if (native.businessAccepted === true && native.applied?.model) {
      request.modelEvidence = { requestId: id, model: native.applied.model,
        actualEffort: native.applied.effort ?? null, businessAccepted: true,
        ...(native.inputUuid ? { inputUuid: native.inputUuid } : {}),
        ...(native.effortAdjustment ? { effortAdjustment: native.effortAdjustment } : {}) };
      value.modelEvidence = request.modelEvidence;
      changed = true;
    }
    if (native.usage && JSON.stringify(native.usage) !== JSON.stringify(request.usage)) {
      request.usage = { ...native.usage };
      changed = true;
    }
    if (native.model && (native.model !== value.currentModel?.model
        || (native.actualEffort ?? undefined) !== value.currentModel?.reasoningEffort)) {
      value.currentModel = { provider: 'claude-cli', model: native.model,
        ...(native.actualEffort == null ? {} : { reasoningEffort: native.actualEffort }) };
      changed = true;
    }
    if (native.sessionStarted && !value.started) {
      value.started = true;
      changed = true;
    }
    if (native.state !== 'running') {
      const failure = native.state === 'failed'
        ? (refused
          ? { source: 'dispatch', code: native.error?.code ?? 'dispatch-refused',
            message: native.error?.message ?? 'The dispatch was refused before anything ran.' }
          : { source: 'model', code: 'claude-cli-failed', message: 'The Claude CLI turn failed.', ...native.error })
        : undefined;
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
      const liveActivity = running ? formatRunningActivity(native, nowFn()) : { stalled: false, activity: 'idle' };
      const allRequests = Object.values(value.requests);
      const taskRequests = allRequests.filter(r => r.taskId === current.task?.taskId);
      const last = taskRequests.at(-1);
      const failed = last?.terminal?.failure;
      const taskUsage = sumUsageList(taskRequests.map(r => r.usage));
      const agentUsage = sumUsageList(allRequests.map(r => r.usage));
      return { sessionId: current.sessionId, taskId: current.task?.taskId, running,
        stalled: liveActivity.stalled, activity: liveActivity.activity,
        ...(liveActivity.silentSeconds !== undefined ? { silentSeconds: liveActivity.silentSeconds } : {}),
        throughSeq: value.seq,
        currentModel: value.currentModel, modelEvidence: value.modelEvidence, modelSelectionObserved: false,
        ...(taskUsage ? { usage: taskUsage } : {}),
        ...(agentUsage ? { agentUsage } : {}),
        changes: [], coverage,
        ...await submissions(value), tree: { settled: !running, running,
          ...(failed ? { rootSummary: { ready: true, state: 'failed', reply: failed.message } } : {}),
          nodes: [{ sessionId: current.sessionId, parentSessionId: null, name: current.name, status,
            activity: liveActivity.activity, ...(liveActivity.stalled ? { stalled: true } : {}),
            changes: [], coverage }] } };
    },
    async history({ targetSessionId, maxMessages = 20, requestId } = {}) {
      const current = load();
      if (targetSessionId && targetSessionId !== current.sessionId) throw fail('unknown-owned-node', 'Unknown Claude CLI session.');
      const value = state();
      const messages = [];
      // The worker already stores each turn's history. Read only the tail that
      // fills this page and keep large conversations out of the shared roster.
      const ids = Object.keys(value.requests).filter(id => value.requests[id].taskId === current.task?.taskId
        && (value.requests[id].status === 'accepted' || value.requests[id].terminal?.failure));
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
    async answer(input) {
      return answerCliQuestions(input, { value: state(), load, submissions, save });
    },
    async deliver({ requestId, message, model, explicitModel, timeoutMs, timeoutMinutes, writeBlockReason }) {
      if (!message?.trim() || !requestId || (explicitModel === true && !model?.model) || (model && !model.model)) {
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
        return { accepted: prior.status === 'accepted', status: prior.status, afterSeq: prior.afterSeq,
          ...(prior.status === 'accepted' ? { actualEffort: prior.modelEvidence?.actualEffort ?? null } : {}) };
      }
      if (value.active) return { accepted: false, status: 'retryable' };
      const cli = await preflight();
      // The shared layer's final gate, asked after every internal await and before any
      // claim is written: a round that finished while this call was preparing is refused
      // here, with no request row, nothing active, and nothing sent.
      const blocked = typeof writeBlockReason === 'function' ? writeBlockReason() : undefined;
      if (blocked) throw fail(blocked, `Nothing was dispatched: ${blocked === 'round-finished'
        ? 'this task round already finished' : blocked === 'dispatch-expired'
          ? 'this dispatch is older than its task permits' : `the dispatch was refused (${blocked})`}.`,
      { terminal: true, notSent: true });
      const mcpConfig = deps.claudeReportConfig(requestId);
      value.sessionId ??= randomUUID();
      const request = { messageHash: hash, taskId: load().task?.taskId, afterSeq: value.seq, model, status: 'unknown' };
      value.requests[requestId] = request; value.active = requestId; save(value);
      try {
        const current = load();
        const callerEnv = { ...mcpConfig?.callerEnv, FUTUREAIDE_MANAGED_TARGET: 'claude-cli' };
        const result = await runner.startClaudeTurn({ callerEnv, cli, directory: dir, workspace: current.workspace, name: current.name,
          requestId, role: current.role, sessionId: value.sessionId, resume: value.started === true, message, model: model?.model,
          effort: model?.reasoningEffort, mcpConfig, config: deps.config, stagedControl: true,
          timeoutMs: timeoutMs ?? current.task?.turnTimeoutMs ?? current.turnTimeoutMs,
          timeoutMinutes: timeoutMinutes ?? current.task?.turnTimeoutMinutes ?? current.turnTimeoutMinutes,
          ...(typeof writeBlockReason === 'function' ? { writeBlockReason } : {}) },
          deps.resolveRoute ? { resolveRoute: deps.resolveRoute } : undefined);
        if (result?.accepted !== true && !result?.duplicate) throw fail('claude-cli-start-refused', 'The CLI worker refused the turn.', { terminal: true });
      } catch (error) {
        request.status = error.terminal ? 'rejected' : error.retryable || error.retryableRead ? 'retryable' : 'unknown';
        if (request.status !== 'unknown') delete value.active;
        save(value);
        if (request.status === 'retryable') error.retryableRead = true;
        if (request.status === 'unknown') error.uncertain = true;
        throw error;
      }
      return { accepted: false, status: 'unknown', afterSeq: request.afterSeq };
    },
    async receipt({ requestId }) {
      const value = state();
      if (value.requests[requestId]?.status === 'unknown') await refresh(value);
      const request = value.requests[requestId];
      return request && { status: request.status, afterSeq: request.afterSeq,
        ...(request.status === 'rejected' ? { notSent: true, error: request.terminal?.failure } : {}),
        ...(request.status === 'failed' ? { error: request.terminal?.failure } : {}),
        ...(request.status === 'accepted' ? { actualEffort: request.modelEvidence?.actualEffort ?? null,
          ...(request.modelEvidence?.effortAdjustment ? { effortAdjustment: request.modelEvidence.effortAdjustment } : {}),
          result: { accepted: true, requestId } } : {}) };
    },
    async turn({ requestId }) {
      const value = state();
      if (value.active === requestId) await refresh(value);
      const request = value.requests[requestId];
      return request?.terminal && request.status !== 'unknown' ? { state: 'ended', correlation: 'request-id', ...request.terminal }
        : { state: 'running', ...(request?.status === 'accepted' ? { correlation: 'request-id' } : {}) };
    },
    async models() {
      catalog ??= (async () => runner.discoverClaudeModels({ cli: await preflight(), workspace: load().workspace }))();
      try { return await catalog; } catch (error) { catalog = undefined; throw error; }
    },
    async model() {
      const value = state(); await refresh(value); return value.currentModel;
    },
    async selectModel() {
      throw fail('model-selection-unsupported', 'Claude CLI applies an explicit model selection when a turn starts.');
    },
    async preemptTurn(_record, { expectedRequestId } = {}) {
      const value = state();
      const request = value.requests[expectedRequestId];
      const refused = { ok: false, stopped: false, sessionId: null, sessionResumable: false, sessionCwd: null };
      if (!expectedRequestId || !request || request.taskId !== load().task?.taskId) return refused;
      if (value.active !== expectedRequestId && (value.active || Object.keys(value.requests).at(-1) !== expectedRequestId
          || !(request.preempted || request.terminal))) return refused;

      if (request.preempted) return request.preempted;
      const dir = directory(expectedRequestId);
      let stopped;
      try { stopped = await runner.cancelClaudeTurn(dir, { expectedRequestId }); }
      catch (error) {
        if (error.code === 'preempt-cage-still-running') return refused;
        throw error;
      }
      if (stopped?.stopped !== true || stopped.ok === false) return refused;
      let native;
      try { native = await runner.readClaudeTurn(dir); }
      catch (error) {
        if (error.code !== 'claude-turn-not-found') throw error;
      }
      // Preserve native session evidence without settling the parent task.
      const sessionId = native?.cliSessionId ?? value["sessionId"] ?? null;
      const sessionResumable = Boolean(sessionId && (value.started || native?.sessionStarted === true));
      if (sessionResumable) {
        value["sessionId"] = sessionId;
        value.started = true;
      } else {
        delete value["sessionId"];
        delete value.started;
      }
      value.sessionCwd = sessionResumable ? (native?.sessionCwd ?? value.sessionCwd ?? load().workspace) : undefined;
      request.preempted = { ok: true, stopped: true, sessionId, sessionResumable, sessionCwd: value.sessionCwd ?? null };
      delete value.active;
      save(value);
      return request.preempted;
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
    for (const method of ['beginTask', 'observe', 'answer', 'deliver', 'receipt', 'turn', 'model', 'preemptTurn', 'cancel', 'destroy']) {
      const action = backend[method];
      backend[method] = (...args) => deps.withHostLock(() => action(...args), { key: load().agentId });
    }
  }
  return backend;
}
