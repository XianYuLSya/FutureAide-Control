import { answerCliQuestions } from './cli-question-selection.mjs';
// Headless Codex CLI (`codex-cli`) backend implementing all 15 `BACKEND_METHODS`.
// Mirrors `claude-cli-backend.mjs` with FAswitch active-profile/proxy routing and
// manual port-binding override via `src/cli-proxy.mjs`.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BACKEND_METHODS } from './agent-backend.mjs';
import { publicRouteSummary } from './cli-proxy.mjs';
import * as cliRunner from './codex-cli-runner.mjs';

const coverage = {
  source: 'codex-cli',
  complete: false,
  note: 'File attribution uses the shared before/after workspace comparison.',
};
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

export function createCodexCliBackend(record, deps = {}) {
  const load = deps.load ?? (() => record);
  const runner = deps.runner ?? cliRunner;
  const nowFn = deps.now ?? (() => Date.now());
  const state = () => ({ seq: 0, requests: {}, answers: {}, answered: [], ...deps.readNativeState?.() });
  const save = value => {
    if (!deps.writeNativeState) throw fail('codex-cli-state-unavailable', 'The shared native-state store is required.');
    if (deps.writeNativeState(value) === false) throw fail('agent-not-found', 'The managed Codex CLI name was removed.');
  };
  const callbacksReady = () => typeof deps.readParentSubmissions === 'function'
    && typeof deps.codexCliReportConfig === 'function';

  let checked;
  async function preflight({ fresh = false } = {}) {
    if (fresh) checked = undefined;
    checked ??= runner.probeCodexCli({
      ...(deps.config?.codexCliPath ? { cliPath: deps.config.codexCliPath } : {}),
      config: deps.config ?? {},
      ...(deps.resolveRoute ? { resolveRoute: deps.resolveRoute } : {}),
    });
    const result = await checked;
    if (!result?.ok) {
      throw fail(result?.code ?? 'codex-cli-not-ready', result?.error ?? 'Codex CLI is not ready.', {
        ...(result?.route ? { route: publicRouteSummary(result.route) } : {}),
      });
    }
    return result;
  }

  async function submissions(value) {
    const taskId = load().task?.taskId;
    const { questions = [], reports = [] } = await deps.readParentSubmissions();
    return {
      questions: questions
        .filter(q => q.taskId === taskId)
        .map(q => (value.answered.includes(q.id) ? { ...q, state: 'answered' } : q)),
      reports: reports.filter(r => r.taskId === taskId),
    };
  }

  function directory(requestId) {
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,119}$/.test(requestId)) {
      throw fail('invalid-dispatch', 'Invalid request id.', { terminal: true });
    }
    return path.join(deps.requestDirectory(), 'codex-cli', 'turns', requestId);
  }

  async function refresh(value) {
    const id = value.active;
    if (!id) return undefined;
    const request = value.requests[id];
    let native;
    try { native = await runner.readCodexTurn(directory(id)); }
    catch (error) {
      if (request?.status === 'unknown' && error?.code === 'codex-turn-not-found') {
        request.status = 'retryable';
        delete value.active;
        save(value);
        return undefined;
      }
      throw error;
    }

    const refused = native?.notSent === true || native?.error?.notSent === true;
    const next = refused ? 'rejected' : 'accepted';
    let changed = request.status !== next;
    request.status = next;

    if (typeof native.threadId === 'string' && native.threadId && native.threadId !== value.threadId) {
      value.threadId = native.threadId;
      changed = true;
    }
    if (native.usage && JSON.stringify(native.usage) !== JSON.stringify(request.usage)) {
      request.usage = { ...native.usage };
      changed = true;
    }
    const observedModel = native.model || native.requestedModel || request.model?.model || null;
    const observedEffort = native.actualEffort ?? request.model?.reasoningEffort ?? undefined;
    if (observedModel && (observedModel !== value.currentModel?.model
        || observedEffort !== value.currentModel?.reasoningEffort)) {
      value.currentModel = {
        provider: 'openai',
        model: observedModel,
        ...(observedEffort ? { reasoningEffort: observedEffort } : {}),
      };
      changed = true;
    }
    if ((native.sessionStarted || native.state === 'ended') && !value.started) {
      value.started = true;
      changed = true;
    }
    if (native.state !== 'running') {
      const failure = native.state === 'failed'
        ? (refused
          ? {
            source: 'dispatch',
            code: native.error?.code ?? 'dispatch-refused',
            message: native.error?.message ?? 'The dispatch was refused before anything ran.',
          }
          : {
            source: 'model',
            code: 'codex-cli-failed',
            message: 'The Codex CLI turn failed.',
            ...native.error,
          })
        : undefined;
      const kind = failure ? 'error' : native.state === 'cancelled' ? 'cancelled' : 'completed';
      request.terminal = {
        completionReason: failure ? { kind, error: failure } : { kind },
        endSeq: ++value.seq,
        ...(failure ? { failure } : {}),
      };
      if (!value.started) delete value.threadId;
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
    const result = await runner.cancelCodexTurn(directory(id));
    if (result !== true && result?.stopped !== true) {
      return { cancelRequested: false, reason: result?.note ?? 'The Codex CLI process tree is still running.' };
    }
    await refresh(value);
    return { cancelRequested: true };
  }

  const backend = {
    target: 'codex-cli',
    labels: { host: 'Codex CLI', bridge: 'The Codex CLI runner' },
    requiredMethods: BACKEND_METHODS,

    async probe() {
      let info;
      if (!load().created) info = await preflight();
      return {
        identity: { application: 'codex-cli' },
        methods: BACKEND_METHODS,
        treeProtocol: 1,
        reportProtocol: callbacksReady() ? 1 : null,
        ...(info?.route ? { route: publicRouteSummary(info.route) } : {}),
      };
    },

    async create() {
      if (!callbacksReady()) {
        throw fail('codex-cli-report-not-ready', 'The Codex CLI parent-report MCP server is unavailable.');
      }
      await preflight();
      save(state());
      return { sessionId: load().sessionId, modelRequestsStarted: 0 };
    },

    async beginTask({ readOnly } = {}) {
      const value = state();
      await refresh(value);
      const taskId = load().task?.taskId;
      const constrained = readOnly === true || load().readOnlyScout === true;
      if (constrained && value.readOnly !== true) { value.readOnly = true; save(value); }
      if (taskId !== value.taskId) {
        value.taskId = taskId;
        value.answered = [];
        value.answers = {};
        save(value);
      }
      return {
        treeProtocol: 1,
        reportProtocol: 1,
        throughSeq: value.seq,
        ...(value.currentModel ? { currentModel: value.currentModel } : {}),
      };
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
      return {
        sessionId: current.sessionId,
        taskId: current.task?.taskId,
        running,
        stalled: liveActivity.stalled,
        activity: liveActivity.activity,
        ...(liveActivity.silentSeconds !== undefined ? { silentSeconds: liveActivity.silentSeconds } : {}),
        throughSeq: value.seq,
        currentModel: value.currentModel,
        modelSelectionObserved: false,
        ...(taskUsage ? { usage: taskUsage } : {}),
        ...(agentUsage ? { agentUsage } : {}),
        changes: [],
        coverage,
        ...(await submissions(value)),
        tree: {
          settled: !running,
          running,
          ...(failed ? { rootSummary: { ready: true, state: 'failed', reply: failed.message } } : {}),
          nodes: [{
            sessionId: current.sessionId,
            parentSessionId: null,
            name: current.name,
            status,
            activity: liveActivity.activity,
            ...(liveActivity.stalled ? { stalled: true } : {}),
            changes: [],
            coverage,
          }],
        },
      };
    },

    async history({ targetSessionId, maxMessages = 20, requestId } = {}) {
      const current = load();
      if (targetSessionId && targetSessionId !== current.sessionId) {
        throw fail('unknown-owned-node', 'Unknown Codex CLI session.');
      }
      const value = state();
      const messages = [];
      const ids = Object.keys(value.requests).filter(
        id => value.requests[id].taskId === current.task?.taskId
          && (value.requests[id].status === 'accepted' || value.requests[id].terminal?.failure),
      );
      let hasMore = false;
      for (let index = ids.length - 1; index >= 0; index--) {
        const native = await runner.readCodexTurn(directory(ids[index]));
        messages.unshift(...(native.messages ?? []));
        if (native.messagesDropped > 0 || messages.length >= maxMessages) {
          hasMore = native.messagesDropped > 0 || messages.length > maxMessages || index > 0;
          break;
        }
      }
      const failure = value.requests[requestId ?? ids.at(-1)]?.terminal?.failure;
      return { messages: messages.slice(-maxMessages), hasMore, ...(failure ? { failure } : {}) };
    },

    async answer(input) {
      return answerCliQuestions(input, { value: state(), load, submissions, save });
    },

    async deliver({ requestId, message, model, explicitModel, timeoutMs, timeoutMinutes, writeBlockReason, readOnly } = {}) {
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
        return { accepted: prior.status === 'accepted', status: prior.status, afterSeq: prior.afterSeq };
      }
      if (value.active) return { accepted: false, status: 'retryable' };

      const preflightInfo = await preflight({ fresh: true });
      const blocked = typeof writeBlockReason === 'function' ? writeBlockReason() : undefined;
      if (blocked) {
        throw fail(blocked, `Nothing was dispatched: ${blocked === 'round-finished'
          ? 'this task round already finished'
          : blocked === 'dispatch-expired'
            ? 'this dispatch is older than its task permits'
            : `the dispatch was refused (${blocked})`}.`, { terminal: true, notSent: true });
      }

      const current = load();
      const reportConfig = deps.codexCliReportConfig(requestId);
      const request = {
        messageHash: hash,
        taskId: current.task?.taskId,
        afterSeq: value.seq,
        model,
        status: 'unknown',
      };
      value.requests[requestId] = request;
      value.active = requestId;
      save(value);

      try {
        const result = await runner.startCodexTurn({
          cli: preflightInfo.spec ?? preflightInfo.cli,
          directory: dir,
          workspace: current.workspace,
          name: current.name,
          threadId: value.threadId,
          resume: Boolean(value.threadId),
          message,
          model: model?.model,
          effort: model?.reasoningEffort,
          reportConfig: { ...reportConfig, callerEnv: { ...reportConfig?.callerEnv, FUTUREAIDE_MANAGED_TARGET: 'codex-cli' } },
          readOnly: readOnly === true || value.readOnly === true || current.readOnlyScout === true || reportConfig?.readOnly === true,
          requestId,
          agentId: current.agentId,
          taskId: current.task?.taskId,
          sessionId: current.sessionId,
          route: preflightInfo.route,
          config: deps.config,
          timeoutMs: timeoutMs ?? current.task?.turnTimeoutMs ?? current.turnTimeoutMs,
          timeoutMinutes: timeoutMinutes ?? current.task?.turnTimeoutMinutes ?? current.turnTimeoutMinutes,
          ...(typeof writeBlockReason === 'function' ? { writeBlockReason } : {}),
        });
        if (result?.accepted !== true && !result?.duplicate) {
          throw fail('codex-cli-start-refused', 'The Codex CLI worker refused the turn.', { terminal: true });
        }
      } catch (error) {
        request.status = error.terminal ? 'rejected'
          : (error.retryable || error.retryableRead) ? 'retryable' : 'unknown';
        if (request.status !== 'unknown') delete value.active;
        save(value);
        if (request.status === 'retryable') error.retryableRead = true;
        if (request.status === 'unknown') error.uncertain = true;
        throw error;
      }

      request.status = 'accepted';
      save(value);
      return {
        accepted: true,
        status: 'accepted',
        afterSeq: request.afterSeq,
        ...(model?.model ? { actualModel: model.model } : {}),
        ...(model?.reasoningEffort ? { actualEffort: model.reasoningEffort, actualEffortSource: 'host-readback' } : {}),
      };
    },

    async receipt({ requestId }) {
      const value = state();
      if (value.requests[requestId]?.status === 'unknown') await refresh(value);
      const request = value.requests[requestId];
      return request && {
        status: request.status,
        afterSeq: request.afterSeq,
        ...(request.status === 'rejected' ? { notSent: true, error: request.terminal?.failure } : {}),
        ...(request.status === 'failed' ? { error: request.terminal?.failure } : {}),
        ...(request.status === 'accepted' ? {
          ...(request.model?.model ? { actualModel: request.model.model } : {}),
          ...(request.model?.reasoningEffort ? { actualEffort: request.model.reasoningEffort, actualEffortSource: 'host-readback' } : {}),
          result: { accepted: true, requestId },
        } : {}),
      };
    },

    async turn({ requestId }) {
      const value = state();
      if (value.active === requestId) await refresh(value);
      const request = value.requests[requestId];
      return request?.terminal && request.status !== 'unknown'
        ? { state: 'ended', correlation: 'request-id', ...request.terminal }
        : { state: 'running', ...(request?.status === 'accepted' ? { correlation: 'request-id' } : {}) };
    },

    async models() {
      const info = await preflight().catch(() => null);
      const codexHome = runner.resolveCodexHome({ route: info?.route });
      return runner.readCodexCliModels({ codexHome });
    },

    async model() {
      const value = state();
      await refresh(value);
      return value.currentModel;
    },

    async selectModel() {
      throw fail('model-selection-unsupported', 'Codex CLI applies an explicit model selection when a turn starts.');
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
      try { stopped = await runner.cancelCodexTurn(dir, { expectedRequestId }); }
      catch (error) {
        if (error.code === 'preempt-cage-still-running') return refused;
        throw error;
      }
      if (stopped?.stopped !== true || stopped.ok === false) return refused;
      let native;
      try { native = await runner.readCodexTurn(dir); }
      catch (error) {
        if (error.code !== 'codex-turn-not-found') throw error;
      }
      // Preserve native session evidence without settling the parent task.
      const sessionId = native?.threadId ?? value["threadId"] ?? null;
      const sessionResumable = Boolean(sessionId && (Boolean(sessionId)));
      if (sessionResumable) {
        value["threadId"] = sessionId;
        value.started = true;
      } else {
        delete value["threadId"];
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
      return { destroyed: true, nativeSessionRetained: Boolean(state().threadId) };
    },

    async cursor() {
      return { throughSeq: state().seq };
    },
  };

  if (deps.withHostLock) {
    for (const method of ['beginTask', 'observe', 'answer', 'deliver', 'receipt', 'turn', 'model', 'preemptTurn', 'cancel', 'destroy']) {
      const action = backend[method];
      backend[method] = (...args) => deps.withHostLock(() => action(...args), { key: load().agentId });
    }
  }
  return backend;
}
