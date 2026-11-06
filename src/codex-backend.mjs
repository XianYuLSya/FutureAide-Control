import { randomUUID, createHash } from 'node:crypto';
import { createCodexHost, emptyProjection, markerLine, CODEX_FILE_COVERAGE } from './codex-host.mjs';
import { isCodexRpcUnavailable } from './codex-ipc.mjs';

const METHODS = ['probe', 'create', 'beginTask', 'observe', 'history', 'answer', 'deliver', 'receipt',
  'turn', 'models', 'model', 'selectModel', 'cancel', 'destroy', 'cursor'];
const MAX_TITLE_ATTEMPTS = 5;
const FIRST_DISPATCH_GRACE_MS = 2 * 60 * 1000;
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);

export async function createCodexBackend(record, deps = {}) {
  const load = deps.load ?? (() => record);
  const host = { ...createCodexHost(deps.hostOptions), ...deps.host };
  const state = () => ({ requests: {}, projections: {}, ...deps.readNativeState?.() });
  const save = value => {
    if (!deps.writeNativeState) throw fail('codex-state-unavailable', 'The shared native-state store is required.');
    if (deps.writeNativeState(value) === false) throw fail('agent-not-found', 'This managed Codex name was removed.');
    return value;
  };
  const locked = action => deps.withHostLock ? deps.withHostLock(action) : action();
  const defaultModel = () => host.readDefaultModel({ workspace: load().workspace });
  async function applyPendingTitle(value) {
    if (!value.pendingTitle || !value.binding) return;
    if (value.pendingTitle.attempts >= MAX_TITLE_ATTEMPTS) {
      delete value.pendingTitle; save(value); return;
    }
    const projection = value.projections[value.binding.sessionId];
    if (!projection?.messages?.length || typeof host.setTitle !== 'function') return;
    value.pendingTitle.attempts += 1;
    save(value);
    try {
      await host.setTitle({ nativeSessionId: value.binding.sessionId, name: value.pendingTitle.name });
      delete value.pendingTitle;
    } catch {
      // An empty rollout is expected on the first attempts. Keep the task state
      // untouched; the next refresh retries, up to the bounded attempt count.
      if (value.pendingTitle.attempts >= MAX_TITLE_ATTEMPTS) delete value.pendingTitle;
    }
    save(value);
  }
  async function reportsReady() {
    const result = await deps.ensureCodexReports?.(load());
    if (result?.ready !== true || !deps.readCodexReportState) {
      throw fail('codex-report-not-ready', 'The explicit Codex parent-report tools have not been connected.');
    }
  }
  async function recover(value) {
    if (value.binding) return value;
    const first = Object.values(value.requests).find(request => request.attempted);
    if (!first) return value;
    const native = await host.findCreatedSession({ workspace: load().workspace, marker: first.marker, startedAt: first.startedAt });
    if (native?.nativeSessionId) {
      value.binding = { sessionId: native.nativeSessionId, owned: true };
      value.pendingTitle ??= { name: load().name, attempts: 0 };
      save(value);
    } else if (Number.isFinite(Date.parse(first.startedAt))
        && Date.now() - Date.parse(first.startedAt) >= FIRST_DISPATCH_GRACE_MS) {
      // The first write was never observed. After the grace period, stop looking
      // and turn the ambiguous dispatch into a visible terminal failure.
      throw fail('codex-first-dispatch-unconfirmed',
        'The first Codex dispatch was not found in any thread after 2 minutes. It was not delivered; reassign the task if needed.',
        { terminal: true });
    }
    return value;
  }
  async function refresh() {
    let value = await recover(state());
    if (!value.binding) return { value, tree: { nodes: [], running: false,
      settled: !Object.values(value.requests).some(r => r.attempted) }, histories: {} };
    const observed = await host.observe({ nativeSessionId: value.binding.sessionId, workspace: load().workspace,
      projections: value.projections, requests: value.requests });
    value.projections = observed.projections;
    value.tree = observed.tree;
    for (const [id, delivery] of Object.entries(value.projections[value.binding.sessionId]?.deliveries ?? {})) {
      if (value.requests[id]) Object.assign(value.requests[id], { status: 'accepted', turnId: delivery.turnId, deliverySeq: delivery.seq });
    }
    await applyPendingTitle(value);
    save(value);
    return { value, ...observed };
  }
  function projection(value) { return value.projections[value.binding?.sessionId] ?? emptyProjection(); }
  function receiptFrom(value, id) {
    const request = value.requests[id];
    return request && { status: request.status, afterSeq: request.afterSeq,
      ...(request.status === 'accepted' ? { result: { accepted: true, requestId: id } } : {}) };
  }
  const ownedIds = value => value.tree?.nodes?.map(node => node.sessionId) ?? (value.binding ? [value.binding.sessionId] : []);
  async function reportState(value) {
    const current = load();
    const data = await deps.readCodexReportState?.(current) ?? { questions: [], reports: [] };
    return { questions: (data.questions ?? []).filter(q => q.taskId === current.task?.taskId)
      .map(q => ({ ...q, state: value.answeredQuestionIds?.includes(q.id) ? 'answered' : q.state })),
    reports: (data.reports ?? []).filter(r => r.taskId === current.task?.taskId) };
  }
  return {
    target: 'codex-desktop', labels: { host: 'Codex Desktop', bridge: 'The Codex Desktop bridge' }, requiredMethods: METHODS,
    async probe() {
      const [result, reportStatus] = await Promise.all([
        host.probe(), deps.readCodexReportStatus?.(load()),
      ]);
      if (result.missing?.length) throw fail('codex-backend-not-ready', `Missing native Codex capabilities: ${result.missing.join(', ')}.`);
      return { identity: result.identity, methods: METHODS, treeProtocol: 1,
        reportProtocol: reportStatus?.ready === true && deps.readCodexReportState ? 1 : null,
        evidence: 'native-rpc' };
    },
    async create() {
      await reportsReady();
      save({ ...state(), reserved: true });
      return { sessionId: load().sessionId, modelRequestsStarted: 0 };
    },
    async beginTask() {
      const { value } = await refresh();
      if (value.taskId !== load().task?.taskId) {
        value.taskId = load().task?.taskId;
        value.taskStartSeq = projection(value).seq;
        value.taskNodeBaselines = Object.fromEntries(Object.entries(value.projections).map(([id, p]) => [id, p.seq]));
        value.answeredQuestionIds = [];
        value.answers = {};
        save(value);
      }
      return { treeProtocol: 1, reportProtocol: 1, throughSeq: projection(value).seq,
        currentModel: value.binding ? await host.readCurrentModel(value.binding.sessionId) : await defaultModel() };
    },
    async observe() {
      const { value, tree } = await refresh();
      const p = projection(value), explicit = await reportState(value), current = load();
      const logical = id => id === value.binding?.sessionId ? current.sessionId : id;
      const nodes = tree.nodes.map(node => ({ ...node, sessionId: logical(node.sessionId),
        parentSessionId: node.parentSessionId ? logical(node.parentSessionId) : null,
        changes: node.changes.filter(change => change.seq > (value.taskNodeBaselines?.[node.sessionId] ?? 0)) }));
      if (!nodes.length) nodes.push({ sessionId: current.sessionId, parentSessionId: null,
        name: current.name, status: 'idle', activity: 'idle', changes: [], coverage: CODEX_FILE_COVERAGE });
      return { sessionId: current.sessionId, taskId: current.task?.taskId, running: tree.running,
        throughSeq: p.seq, currentModel: p.currentModel, modelSelectionObserved: false,
        changes: nodes.flatMap(n => n.changes), coverage: CODEX_FILE_COVERAGE, ...explicit,
        tree: { ...tree, nodes } };
    },
    async history({ targetSessionId, maxMessages = 20 } = {}) {
      const { value, histories } = await refresh();
      const id = !targetSessionId || targetSessionId === load().sessionId ? value.binding?.sessionId : targetSessionId;
      if (!id && !value.binding) return { messages: [], hasMore: false };
      if (!histories[id]) throw fail('unknown-owned-node', 'This thread is not in the managed Codex tree.');
      const page = histories[id];
      return { messages: page.messages.slice(-maxMessages), hasMore: page.hasMore || page.messages.length > maxMessages };
    },
    async answer({ answerId, message }) {
      const value = state();
      if (value.answers?.[answerId]) return value.answers[answerId];
      const pending = (await reportState(value)).questions.filter(q => q.state === 'pending');
      if (!pending.length) throw fail('question-not-pending', 'There is no pending question for this task.');
      const result = { consumedQuestionIds: pending.map(q => q.id), continuation: `Parent answer:\n${message}\nContinue the same task.` };
      value.answeredQuestionIds = [...(value.answeredQuestionIds ?? []), ...result.consumedQuestionIds];
      (value.answers ??= {})[answerId] = result; save(value);
      return result;
    },
    async deliver({ requestId, message, model: dispatchModel }) {
      if (!requestId || typeof message !== 'string' || !message.trim()) throw fail('invalid-dispatch', 'A request id and message are required.');
      await reportsReady();
      let value = await recover(state());
      const hash = createHash('sha256').update(message).digest('hex');
      const prior = value.requests[requestId];
      if (prior && prior.messageHash !== hash) throw fail('request-id-conflict', 'This request id already belongs to another message.');
      if (prior && prior.status !== 'retryable') return { accepted: prior.status === 'accepted', status: prior.status, afterSeq: prior.afterSeq };
      // The coordinator freezes each input's default before dispatch. Recovery of
      // that same input must retain its choice even if the user changes defaults.
      const model = prior?.model ?? dispatchModel
        ?? load().task?.dispatches?.find(item => item.requestId === requestId)?.model
        ?? value.selectedModels?.[`${requestId}-model`] ?? await defaultModel();
      value.nonce ??= randomUUID();
      const marker = markerLine(requestId, value.nonce);
      const request = { requestId, marker, messageHash: hash, taskId: load().task?.taskId,
        startedAt: new Date().toISOString(), afterSeq: projection(value).seq, status: 'retryable', attempted: false, model };
      value.requests[requestId] = request; save(value);
      await locked(async () => {
        request.attempted = true; request.status = 'unknown'; save(value);
        try {
          let turnId;
          if (!value.binding) {
            // No model, reasoning effort or permission field is passed: the new
            // Codex thread inherits every one of them from the user's defaults.
            // The caller's task stays first; the marker moves to the last line so
            // the user sees the original request at the top of the new chat.
            const first = await host.createFirstTurn({ workspace: load().workspace, title: load().name,
              requestId, message: `${message}\n\nYou are FutureAide managed helper ${JSON.stringify(load().name)}. `
                + 'If you need a parent decision, use ask_parent; deliver the final result with '
                + 'report_parent(message, final=true). Ordinary replies do not report to your parent.\n\n'
                + marker });
            turnId = first?.turnId;
            if (first?.nativeSessionId) {
              value.binding = { sessionId: first.nativeSessionId, owned: true };
              value.pendingTitle ??= { name: load().name, attempts: 0 };
              save(value);
            }
          } else {
            const sent = await host.send({ nativeSessionId: value.binding.sessionId, message: `${message}\n\n${marker}`, requestId });
            turnId = sent?.turnId;
          }
          // A returned native turn id is acceptance, not completion. Recording it
          // avoids reporting a confirmed turn as unknown while the transcript page
          // is still catching up.
          if (turnId) {
            Object.assign(request, { status: 'accepted', turnId });
            save(value);
          }
        } catch (error) {
          if (error.nativeSessionId) {
            value.binding = { sessionId: error.nativeSessionId, owned: true };
            value.pendingTitle ??= { name: load().name, attempts: 0 };
            save(value);
          }
          // No debug port means the write never reached Codex, so this is a
          // retryable transport failure rather than an unknown write outcome.
          if (isCodexRpcUnavailable(error)) {
            request.attempted = false; request.status = 'retryable'; save(value);
            throw fail(error.code, error.message, { retryableRead: true });
          }
          throw fail(error.code ?? 'codex-delivery-unconfirmed', error.message,
            { uncertain: true, ...(error.terminal ? { terminal: true } : {}) });
        }
      });
      try { ({ value } = await refresh()); }
      catch (error) {
        // The native turn id already proved acceptance. A later read failure is
        // an observation gap, not a reason to downgrade that accepted write.
        if (request.status === 'accepted') return { accepted: true, status: 'accepted', afterSeq: request.afterSeq };
        throw fail(error.code ?? 'codex-observation-pending', error.message, { uncertain: true });
      }
      const receipt = receiptFrom(value, requestId);
      return { accepted: receipt.status === 'accepted', status: receipt.status, afterSeq: receipt.afterSeq };
    },
    async receipt({ requestId }) {
      const value = state();
      if (!value.requests[requestId]) return undefined;
      try { return receiptFrom((await refresh()).value, requestId); }
      catch (error) {
        if (value.requests[requestId].status === 'accepted') return receiptFrom(value, requestId);
        throw error;
      }
    },
    async turn({ requestId }) {
      const { value, tree } = await refresh(), p = projection(value), request = value.requests[requestId];
      const native = request?.turnId && p.turns[request.turnId];
      const correlation = request?.status === 'accepted' && request.turnId ? 'request-id' : undefined;
      if (request?.status !== 'accepted' || !native || tree.running || !tree.settled) return { state: 'running', correlation, turnId: request?.turnId };
      return { ...native, correlation, turnId: request.turnId };
    },
    async models() {
      const value = state();
      // A bound thread's live selection is the honest catalog here: the shared
      // layer compares it before each dispatch, and this target never overrides
      // the user's choice. An unbound name shows the Codex default.
      const selection = value.binding ? await host.readCurrentModel(value.binding.sessionId) : await defaultModel();
      return { default: selection, routableProviders: [selection.provider], groups: [{ id: selection.provider,
        models: [{ id: selection.model, reasoningEfforts: selection.reasoningEffort ? [selection.reasoningEffort] : [] }] }] };
    },
    async model() {
      const value = state();
      return value.binding ? host.readCurrentModel(value.binding.sessionId) : defaultModel();
    },
    async selectModel() {
      // Codex Desktop inherits the user's own model picker and config. Pretending
      // to change it here would silently disagree with the next real turn.
      throw fail('model-selection-unsupported',
        'Codex Desktop subagents use the user\'s own model and reasoning selection; this plugin never overrides them.');
    },
    async cancel() {
      const { value, tree } = await refresh();
      if (!value.binding) return { cancelRequested: tree.settled };
      if (tree.settled) return { cancelRequested: true };
      const result = await locked(() => host.interrupt({ nativeSessionId: value.binding.sessionId, ownedNodeIds: ownedIds(value) }));
      return { cancelRequested: result.interrupted === true };
    },
    async destroy() {
      let value, tree;
      try { ({ value, tree } = await refresh()); }
      catch (error) {
        // The first dispatch was never found in any thread, so there is no native
        // session to clean. A retried delete of that name must finish.
        if (error.code === 'codex-first-dispatch-unconfirmed') return { destroyed: true };
        // A previous delete may have removed the thread before its verification
        // read; both app-server shapes mean there is nothing left to delete.
        if (error.code === 'codex-thread-not-found'
            || /thread not loaded|thread not found|does not exist/i.test(String(error?.rpcMessage ?? error?.message ?? ''))) {
          return { destroyed: true };
        }
        throw error;
      }
      if (!value.binding) return { destroyed: true };
      if (!tree.settled) return { destroyed: false, message: 'The managed Codex tree has not settled.' };
      return locked(() => host.destroy({ nativeSessionId: value.binding.sessionId, ownedNodeIds: ownedIds(value), workspace: load().workspace }));
    },
    async cursor() { return { throughSeq: projection((await refresh()).value).seq }; },
  };
}
