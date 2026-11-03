import { randomUUID, createHash } from 'node:crypto';
import { createCodexHost, emptyProjection, markerLine, CODEX_FILE_COVERAGE } from './codex-host.mjs';

const METHODS = ['probe', 'create', 'beginTask', 'observe', 'history', 'answer', 'deliver', 'receipt',
  'turn', 'models', 'model', 'selectModel', 'cancel', 'destroy', 'cursor'];
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
      save(value);
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
      const result = await host.probe();
      if (result.missing?.length) throw fail('codex-backend-not-ready', `Missing native Codex capabilities: ${result.missing.join(', ')}.`);
      const reportStatus = await deps.readCodexReportStatus?.(load());
      return { identity: result.identity, methods: METHODS, treeProtocol: 1,
        reportProtocol: reportStatus?.ready === true && deps.readCodexReportState ? 1 : null };
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
      return { treeProtocol: 1, reportProtocol: 1, throughSeq: projection(value).seq, currentModel: await defaultModel() };
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
    async deliver({ requestId, message }) {
      if (!requestId || typeof message !== 'string' || !message.trim()) throw fail('invalid-dispatch', 'A request id and message are required.');
      await reportsReady();
      let value = await recover(state());
      const hash = createHash('sha256').update(message).digest('hex');
      const prior = value.requests[requestId];
      if (prior && prior.messageHash !== hash) throw fail('request-id-conflict', 'This request id already belongs to another message.');
      if (prior && prior.status !== 'retryable') return { accepted: prior.status === 'accepted', status: prior.status, afterSeq: prior.afterSeq };
      const model = await defaultModel(); // every task, supplement and answer follows the live default
      value.nonce ??= randomUUID();
      const marker = markerLine(requestId, value.nonce);
      const request = { requestId, marker, messageHash: hash, taskId: load().task?.taskId,
        startedAt: new Date().toISOString(), afterSeq: projection(value).seq, status: 'retryable', attempted: false, model };
      value.requests[requestId] = request; save(value);
      await locked(async () => {
        request.attempted = true; request.status = 'unknown'; save(value);
        try {
          if (!value.binding) {
            const first = await host.createFirstTurn({ workspace: load().workspace, title: load().name, model,
              requestId, message: `${marker}\nYou are FutureAide managed helper ${JSON.stringify(load().name)}.\n`
                + 'Use ask_parent for questions and report_parent(message, final=true) for verified final delivery. '
                + 'Ordinary messages do not report to your parent.\n\n' + message });
            if (first?.nativeSessionId) {
              value.binding = { sessionId: first.nativeSessionId, owned: true };
              save(value);
            }
          } else await host.send({ nativeSessionId: value.binding.sessionId, model, message: `${marker}\n${message}`, requestId });
        } catch (error) {
          if (['codex-caller-context-required', 'codex-project-unresolved'].includes(error.code)) {
            request.attempted = false; request.status = 'retryable'; save(value);
            throw fail(error.code, error.message, { retryableRead: true });
          }
          throw fail(error.code ?? 'codex-delivery-unconfirmed', error.message, { uncertain: true });
        }
      });
      try { ({ value } = await refresh()); }
      catch (error) { throw fail(error.code ?? 'codex-observation-pending', error.message, { uncertain: true }); }
      const receipt = receiptFrom(value, requestId);
      return { accepted: receipt.status === 'accepted', status: receipt.status, afterSeq: receipt.afterSeq };
    },
    async receipt({ requestId }) {
      if (!state().requests[requestId]) return undefined;
      return receiptFrom((await refresh()).value, requestId);
    },
    async turn({ requestId }) {
      const { value, tree } = await refresh(), p = projection(value), request = value.requests[requestId];
      const native = request?.turnId && p.turns[request.turnId];
      if (request?.status !== 'accepted' || !native || tree.running || !tree.settled) return { state: 'running', correlation: request?.turnId };
      return native.state === 'ended' ? { ...native, correlation: request.turnId } : { state: 'running', correlation: request.turnId };
    },
    async models() {
      const selection = await defaultModel();
      return { default: selection, routableProviders: [selection.provider], groups: [{ id: selection.provider,
        models: [{ id: selection.model, reasoningEfforts: selection.reasoningEffort ? [selection.reasoningEffort] : [] }] }] };
    },
    async model() {
      const value = state();
      return value.binding ? host.readCurrentModel(value.binding.sessionId) : defaultModel();
    },
    async selectModel(input) {
      const expected = await defaultModel();
      if (input.model !== expected.model || input.provider !== expected.provider || input.reasoningEffort !== expected.reasoningEffort) {
        throw fail('codex-default-model-changed', 'Codex default changed before delivery; resolve the current model again.');
      }
      save({ ...state(), selectedModel: expected });
      // Selection belongs to the next native send's explicit model/thinking args.
      return { accepted: true, appliesOnDelivery: true };
    },
    async cancel() {
      const { value, tree } = await refresh();
      if (!value.binding) return { cancelRequested: tree.settled };
      if (tree.settled) return { cancelRequested: true };
      const result = await locked(() => host.interrupt({ nativeSessionId: value.binding.sessionId, ownedNodeIds: ownedIds(value) }));
      return { cancelRequested: result.interrupted === true };
    },
    async destroy() {
      const { value, tree } = await refresh();
      if (!value.binding) return { destroyed: tree.settled };
      if (!tree.settled) return { destroyed: false, message: 'The managed Codex tree has not settled.' };
      return locked(() => host.destroy({ nativeSessionId: value.binding.sessionId, ownedNodeIds: ownedIds(value), workspace: load().workspace }));
    },
    async cursor() { return { throughSeq: projection((await refresh()).value).seq }; },
  };
}
