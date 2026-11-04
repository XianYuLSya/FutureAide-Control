import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';
import { BACKEND_METHODS, normalizeTarget, targetOf, resolveBackend } from '../src/agent-backend.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = '11111111-1111-4111-8111-111111111111';
const extra = threadId => ({ _meta: { threadId } });
const CLAUDE_MODEL = { provider: 'anthropic', model: 'claude-opus-5-5' };

test('default loader connects the real Codex adapter without an injected factory', async () => {
  const backend = await resolveBackend({ target: 'codex-desktop', workspace }, { deps: {
    host: { probe: async () => ({ identity: { application: 'codex-desktop' }, missing: [] }) },
    readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: [], reports: [] }),
  } });
  assert.equal(backend.target, 'codex-desktop');
  const probe = await backend.probe();
  assert.deepEqual(probe.methods, BACKEND_METHODS);
  assert.equal(probe.reportProtocol, 1);
});

test('a supplement steers the model on its next step while every other delivery stays queued', async () => {
  const sends = [];
  const backend = await resolveBackend({ target: 'dsh', workspace }, {
    dsh: { client: {}, control: () => ({ async send(input) { sends.push(input); return { accepted: true, afterSeq: 1 }; } }) },
  });
  await backend.deliver({ requestId: 'request-supplement', message: 'new input', kind: 'supplement' });
  await backend.deliver({ requestId: 'request-task', message: 'work', kind: 'task' });
  await backend.deliver({ requestId: 'request-answer', message: 'Answer: yes', kind: 'answer' });
  await backend.deliver({ requestId: 'request-bare', message: 'no kind' });
  assert.deepEqual(sends.map(input => [input.requestId, input.mode]),
    [['request-supplement', 'steer'], ['request-task', 'queue'], ['request-answer', 'queue'], ['request-bare', 'queue']]);
});

async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  return assert.fail('expected a refusal');
}

// Anything only the DSH backend would call. None of it may run for a name bound
// to another target: the adapter is the only execution path.
const DSH_CALLS = new Set(['identity', 'hostStatus', 'managedCreate', 'managedBeginTask', 'managedStatus',
  'managedSession', 'historyCursor', 'models', 'selectModel', 'send', 'wait']);
const dshCalls = events => events.filter(event => (typeof event === 'string' ? DSH_CALLS.has(event)
  : Array.isArray(event) && DSH_CALLS.has(event[0])));

function calling(events) {
  return async (threadId, tool) => {
    if (tool !== 'read_thread') return { accepted: true };
    events.push('read_thread');
    return { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } };
  };
}

// The existing DSH managed bridge, reduced to the calls the shared state machine
// makes. Its presence proves a claude-desktop subagent never borrows it.
function dshFixture(events) {
  const session = { sessionId: undefined, taskId: undefined, running: false, seq: 0 };
  const api = {
    async connectionIdentity() { events.push('identity'); return { application: 'dsh', dataRoot: path.join(workspace, 'clean', 'target-fixture-native') }; },
    async hostStatus() {
      events.push('hostStatus');
      return { treeProtocol: 1, reportProtocol: 1, methods: ['managedCreate', 'managedBeginTask', 'managedStatus',
        'managedHistory', 'managedAnswer', 'managedCancel', 'managedDestroy'] };
    },
    async managedCreate(input) {
      events.push('managedCreate');
      session.sessionId = input.sessionId;
      return { sessionId: input.sessionId, modelRequestsStarted: 0, model: { provider: 'fixture', model: 'dsh-model' } };
    },
    async managedBeginTask(input) {
      events.push('managedBeginTask');
      session.taskId = input.taskId;
      return { taskId: input.taskId, treeProtocol: 1, reportProtocol: 1, throughSeq: session.seq };
    },
    async managedStatus(input) {
      events.push('managedStatus');
      return { sessionId: input.sessionId, taskId: session.taskId, running: session.running, questions: [], reports: [],
        changes: [], throughSeq: session.seq, currentModel: { provider: 'fixture', model: 'dsh-model' },
        tree: { settled: !session.running, running: session.running, nodes: [] } };
    },
    async managedSession() { events.push('managedSession'); return { projections: { values: { modelSelection: { next: { provider: 'fixture', model: 'dsh-model' } } } } }; },
    async historyCursor() { events.push('historyCursor'); return { throughSeq: session.seq }; },
  };
  const controlFactory = () => ({
    async models() {
      events.push('models');
      return { default: { provider: 'fixture', model: 'dsh-model' }, routableProviders: ['fixture'],
        groups: [{ id: 'fixture', models: [{ id: 'dsh-model', reasoningEfforts: ['off'] }] }] };
    },
    async selectModel() { events.push('selectModel'); return { accepted: true }; },
    async send(input) { events.push(['send', input.requestId]); session.running = true; session.seq += 1; return { accepted: true, afterSeq: session.seq }; },
    async wait() { return { state: 'running', afterSeq: session.seq }; },
  });
  return { api, controlFactory, session };
}

// A stand-in for the Claude Desktop adapter the controlling agent is wiring: the
// contract only, so target plumbing is verifiable before that adapter exists.
function claudeAdapter(events, { omit = [] } = {}) {
  const backend = {
    target: 'claude-desktop',
    labels: { host: 'Claude Desktop', bridge: 'The Claude Desktop adapter' },
    async probe() {
      events.push('claude:probe');
      return { identity: { application: 'claude-desktop', dataRoot: '/fixture/claude' },
        methods: ['create', 'observe', 'deliver'], treeProtocol: 1, reportProtocol: 1 };
    },
    async create() {
      events.push('claude:create');
      return { sessionId: backend.record.sessionId, modelRequestsStarted: 0, model: { ...CLAUDE_MODEL } };
    },
    async beginTask() { events.push('claude:beginTask'); return { treeProtocol: 1, reportProtocol: 1, throughSeq: 0, currentModel: { ...CLAUDE_MODEL } }; },
    async observe() {
      events.push('claude:observe');
      return { sessionId: backend.record.sessionId, taskId: backend.record.task?.taskId, running: false,
        questions: [], reports: [], changes: [], throughSeq: 1, currentModel: { ...CLAUDE_MODEL },
        tree: { settled: true, running: false, nodes: [] } };
    },
    async history() { events.push('claude:history'); return { messages: [], hasMore: false }; },
    async answer() { events.push('claude:answer'); return { consumedQuestionIds: [] }; },
    async deliver(input) {
      events.push(['claude:deliver', input.requestId]);
      return { accepted: true, status: 'written', afterSeq: 1 };
    },
    async receipt() { events.push('claude:receipt'); return undefined; },
    async turn() { events.push('claude:turn'); return { state: 'running', afterSeq: 1 }; },
    async models() {
      events.push('claude:models');
      return { default: { ...CLAUDE_MODEL }, routableProviders: [CLAUDE_MODEL.provider],
        groups: [{ id: CLAUDE_MODEL.provider, models: [{ id: CLAUDE_MODEL.model, reasoningEfforts: ['max'] }] }] };
    },
    async model() { events.push('claude:model'); return { ...CLAUDE_MODEL }; },
    async selectModel() { events.push('claude:selectModel'); return { accepted: true }; },
    async cancel() { events.push('claude:cancel'); return { cancelRequested: true }; },
    async destroy() { events.push('claude:destroy'); return { destroyed: true }; },
    async cursor() { events.push('claude:cursor'); return { throughSeq: 0 }; },
  };
  for (const name of omit) delete backend[name];
  return backend;
}

async function stateRoot() {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'target-'));
}

async function fixture({ adapters = {}, store, adapterLoader, reportStatusProbe, codexProbeRegistration } = {}) {
  const events = [];
  const reports = [];
  const monitors = [];
  const stateDirectory = await stateRoot();
  const roster = store ?? new RosterStore(':memory:');
  const dsh = dshFixture(events);
  const service = createScopedAgents({ stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh' }, {
    store: roster, clientFactory: () => dsh.api, controlFactory: dsh.controlFactory, callCodex: calling(events),
    startSharedMonitor: () => { monitors.push('start'); return true; },
    reportReadyTimeoutMs: 0,
    removeTree: async () => {},
    backendAdapters: adapters,
    ...(codexProbeRegistration ? { codexProbeRegistration } : {}),
    // No real loopback server in unit tests: the read-only health probe is
    // injected and counted, so a test can prove when readiness was asked for.
    reportStatusProbe: reportStatusProbe ?? (async () => {
      reports.push('probe');
      return { url: 'http://127.0.0.1:17654/mcp', port: 17654, ready: true, hosting: 'monitor' };
    }),
    // These cases pin the refusal path, so the installed adapter file must not
    // decide the outcome; an injected loader says whether one exists here.
    ...(adapterLoader ? { backendAdapterLoader: adapterLoader } : {}),
  });
  return { events, reports, monitors, service, store: roster, stateDirectory, dsh,
    record: (name = 'artist', thread = A) => roster.named(ownerIdFor(thread), name) };
}

test('creation defaults to DSH and persists the target for later name-only calls', async () => {
  const stateDirectory = await stateRoot();
  const rosterPath = path.join(stateDirectory, 'roster.sqlite');
  const first = await fixture({ store: new RosterStore(rosterPath) });
  try {
    const created = await first.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    assert.equal(created.created, true);
    assert.equal(created.target, 'dsh');
    assert.equal(created.modelRequestsStarted, 0);
    assert.equal(first.record().target, 'dsh');
    assert.deepEqual((await first.service.list(extra(A))).items.map(item => item.target), ['dsh']);
  } finally { first.service.close(); }
  // A reopened plugin reads the same binding back from the roster.
  const reopened = await fixture({ store: new RosterStore(rosterPath) });
  try {
    assert.deepEqual((await reopened.service.list(extra(A))).items.map(item => [item.name, item.target]), [['artist', 'dsh']]);
  } finally { reopened.service.close(); }
});

test('a roster record written without a target keeps the DSH behavior', async () => {
  const f = await fixture();
  try {
    const ownerId = ownerIdFor(A);
    f.store.insert({ agentId: 'agent-' + 'a'.repeat(32), ownerId, sessionId: 'session-legacy', name: 'legacy',
      lifetime: 'persistent', workspace, state: 'idle', created: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [] });
    assert.equal(f.store.named(ownerId, 'legacy').target, undefined);
    assert.equal(targetOf(f.store.named(ownerId, 'legacy')), 'dsh');
    assert.deepEqual((await f.service.list(extra(A))).items.map(item => item.target), ['dsh']);
    const receipt = await f.service.send({ name: 'legacy', message: 'legacy task' }, extra(A));
    assert.equal(receipt.accepted, true);
    assert.deepEqual(f.events.filter(event => Array.isArray(event) && event[0] === 'send').map(event => event[1]).length, 1);
    assert.ok(!f.events.some(event => typeof event === 'string' && event.startsWith('claude:')), 'a legacy name never reaches another backend');
  } finally { f.service.close(); }
});

test('a claude-desktop subagent without an adapter is refused before the name exists', async () => {
  const f = await fixture({ adapterLoader: async () => undefined });
  try {
    const error = await rejection(f.service.create({ name: 'partner', lifetime: 'persistent', target: 'claude-desktop' }, extra(A)));
    assert.equal(error.code, 'backend-not-ready');
    assert.match(error.message, /claude-desktop/);
    assert.match(error.message, /no task was sent to another backend/i);
    assert.equal(f.store.count(ownerIdFor(A)), 0, 'no name was taken');
    assert.deepEqual(dshCalls(f.events), [], 'the DSH bridge was not used as a substitute');
  } finally { f.service.close(); }
});

test('claude-desktop is created, dispatched and listed only through its own adapter', async () => {
  const events = [];
  const f = await fixture({ adapters: { 'claude-desktop': (record, deps) => { const backend = claudeAdapter(events); backend.record = record; backend.deps = deps; return backend; } } });
  try {
    const created = await f.service.create({ name: 'partner', lifetime: 'persistent', target: 'claude-desktop' }, extra(A));
    assert.equal(created.created, true);
    assert.equal(created.target, 'claude-desktop');
    assert.equal(created.modelRequestsStarted, 0);
    assert.ok(events.includes('claude:create'));
    assert.equal(f.record('partner').target, 'claude-desktop');
    assert.deepEqual(dshCalls(f.events), [], 'no DSH call runs for a claude-desktop name');
    assert.deepEqual(f.reports, ['probe'], 'a zero-model create first waits for the monitor-owned tool service');
    assert.deepEqual(f.monitors, ['start'], 'and the single monitor is what provides it');

    const receipt = await f.service.send({ name: 'partner', message: 'read the plan' }, extra(A));
    assert.equal(receipt.queued, true, 'Desktop dispatch runs in the shared monitor');
    assert.equal(receipt.accepted, false);
    await f.service.poll(f.record('partner').agentId);
    const deliveries = events.filter(event => Array.isArray(event) && event[0] === 'claude:deliver');
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0][1], /^request-[a-f0-9]{32}$/, 'the durable request id crosses the boundary');
    assert.equal(events.includes('claude:selectModel'), false, 'a matching target default needs no selection');
    assert.deepEqual((await f.service.list(extra(A))).items.map(item => [item.name, item.target]), [['partner', 'claude-desktop']]);
    assert.deepEqual(dshCalls(f.events), [], 'the DSH bridge stayed untouched');
    assert.equal(typeof f.record('partner').binding, 'undefined');
  } finally { f.service.close(); }
});

test('codex-desktop readiness comes from the registration probe, never from a session', async () => {
  // A minimal adapter that satisfies the contract, so only the registration evidence
  // decides readiness.
  const codexAdapter = () => ({ probe: async () => ({ identity: {}, methods: [], treeProtocol: 1, reportProtocol: 1 }),
    create: async () => ({ sessionId: 'session-codex-child', modelRequestsStarted: 0 }),
    beginTask: async () => ({}), observe: async () => ({}), history: async () => ({ messages: [] }),
    answer: async () => ({}), deliver: async () => ({ accepted: true }), receipt: async () => undefined,
    turn: async () => ({ state: 'ended' }), models: async () => ({ models: [] }), model: async () => ({}),
    selectModel: async () => ({ accepted: true }), cancel: async () => ({ cancelRequested: true }),
    destroy: async () => ({ destroyed: true }), cursor: async () => ({}) });
  const probes = [];
  const probeFor = answer => async request => { probes.push(request); return answer; };

  const registered = await fixture({ adapters: { 'codex-desktop': codexAdapter },
    codexProbeRegistration: probeFor({ ready: true, registered: true,
      tools: ['ask_parent', 'report_parent'], sessionVerified: false }) });
  try {
    const status = await registered.service.status(extra(A));
    assert.deepEqual(probes[0], { workspace, configPath: path.join(registered.stateDirectory, 'config.json'),
      serverName: 'futureaide-dev' }, 'the probe is asked about this project and the DEV entry');
    assert.equal(status.backends['codex-desktop'].ready, true);
    assert.equal(status.backends['codex-desktop'].sessionVerified ?? false, false,
      'a registration alone never claims a native session was verified');
  } finally { registered.service.close(); }

  const missing = await fixture({ adapters: { 'codex-desktop': codexAdapter },
    codexProbeRegistration: probeFor({ ready: true, registered: false, tools: ['ask_parent'], sessionVerified: false }) });
  try {
    const status = await missing.service.status(extra(A));
    assert.equal(status.backends['codex-desktop'].ready, false, 'both tools must be listed');
    assert.equal(status.backends['codex-desktop'].reason.code, 'codex-tools-not-registered');
  } finally { missing.service.close(); }
});

test('a create that cannot reach the tool service takes no name', async () => {
  const f = await fixture({
    adapters: { 'claude-desktop': record => { const backend = claudeAdapter([]); backend.record = record; return backend; } },
    reportStatusProbe: async () => ({ port: 17654, url: 'http://127.0.0.1:17654/mcp', ready: false }),
  });
  try {
    const error = await rejection(f.service.create({ name: 'partner', lifetime: 'persistent', target: 'claude-desktop' }, extra(A)));
    assert.equal(error.code, 'report-service-unavailable');
    assert.equal(error.detail.code, 'report-service-unavailable');
    assert.equal(f.store.count(ownerIdFor(A)), 0, 'no half-wired name is left behind');
    assert.deepEqual(dshCalls(f.events), [], 'nothing was created on another backend either');
  } finally { f.service.close(); }
});

test('an unfinished protocol leaves no name instead of a reconnecting one', async () => {
  const f = await fixture({ adapters: { 'claude-desktop': record => ({ ...claudeAdapter([]), record,
    async probe() { return { identity: { application: 'claude-desktop', dataRoot: '/fixture/claude' },
      methods: [], treeProtocol: undefined, reportProtocol: 1 }; } }) } });
  try {
    const error = await rejection(f.service.create({ name: 'partner', lifetime: 'persistent', target: 'claude-desktop' }, extra(A)));
    assert.equal(error.code, 'tree-protocol-required');
    assert.equal(f.store.count(ownerIdFor(A)), 0, 'the name is not taken for a backend that cannot serve it');
    assert.deepEqual(f.reports, [], 'the tool service is not started for a name that cannot exist');
  } finally { f.service.close(); }
});

test('status reads tool-service readiness without starting it', async () => {
  const f = await fixture({ adapters: { 'claude-desktop': record => { const backend = claudeAdapter([]); backend.record = record; return backend; } } });
  try {
    const status = await f.service.status(extra(A));
    assert.equal(status.backends['claude-desktop'].ready, true);
    assert.deepEqual(f.reports, [], 'a status probe never starts the loopback service');
    assert.deepEqual(f.monitors, [], 'nor does it start the shared monitor');
    assert.equal(f.store.count(ownerIdFor(A)), 0);
  } finally { f.service.close(); }
});

test('a historical currentModel is not trusted: the real control decides the follow', async () => {
  // The observation replays the assistant transcript (historical). The user picked
  // a different model in the UI without sending a turn, so the historical value
  // still looks like the default while the real control has moved.
  const selections = [];
  const factory = (record, deps) => {
    const backend = claudeAdapter([]);
    backend.record = record;
    backend.deps = deps;
    backend.observe = async () => ({ sessionId: record.sessionId, taskId: record.task?.taskId, running: true,
      questions: [], reports: [], changes: [], throughSeq: 5, currentModel: { ...CLAUDE_MODEL },
      modelSelectionObserved: false, tree: { settled: false, running: true, nodes: [] } });
    backend.model = async () => ({ provider: 'anthropic', model: 'claude-opus-5-6' });
    const select = backend.selectModel;
    backend.selectModel = async input => { selections.push(input); return select(input); };
    return backend;
  };
  const f = await fixture({ adapters: { 'claude-desktop': factory } });
  try {
    await f.service.create({ name: 'partner', lifetime: 'persistent', target: 'claude-desktop' }, extra(A));
    await f.service.send({ name: 'partner', message: 'first' }, extra(A));
    await f.service.poll(f.record('partner').agentId);
    selections.length = 0;
    // A busy supplement goes through observe(); the stale value equals the default,
    // so only the real control can reveal the mismatch.
    await f.service.send({ name: 'partner', message: 'continue while busy' }, extra(A));
    await f.service.poll(f.record('partner').agentId);
    assert.equal(selections.length, 1, 'the default was re-selected from the real next-turn control');
    assert.deepEqual(selections[0].model, CLAUDE_MODEL.model);
  } finally { f.service.close(); }
});

test('an observed live selection is used as-is, without another control round-trip', async () => {
  const selections = [];
  const factory = record => {
    const backend = claudeAdapter([]);
    backend.record = record;
    backend.observe = async () => ({ sessionId: record.sessionId, taskId: record.task?.taskId, running: true,
      questions: [], reports: [], changes: [], throughSeq: 5, currentModel: { ...CLAUDE_MODEL },
      tree: { settled: false, running: true, nodes: [] } });
    backend.model = async () => { throw new Error('the live observation already answers this'); };
    const select = backend.selectModel;
    backend.selectModel = async input => { selections.push(input); return select(input); };
    return backend;
  };
  const f = await fixture({ adapters: { 'claude-desktop': factory } });
  try {
    await f.service.create({ name: 'partner', lifetime: 'persistent', target: 'claude-desktop' }, extra(A));
    await f.service.send({ name: 'partner', message: 'first' }, extra(A));
    await f.service.poll(f.record('partner').agentId);
    selections.length = 0;
    await f.service.send({ name: 'partner', message: 'continue while busy' }, extra(A));
    await f.service.poll(f.record('partner').agentId);
    assert.deepEqual(selections, [], 'the session already runs the default; nothing is re-selected');
  } finally { f.service.close(); }
});

test('an unknown target is rejected before any backend is resolved', async () => {
  const f = await fixture();
  try {
    const error = await rejection(f.service.create({ name: 'artist', lifetime: 'once', target: 'claude' }, extra(A)));
    assert.equal(error.code, 'invalid-target');
    assert.match(error.message, /dsh \/ claude-desktop/);
    assert.equal(f.store.count(ownerIdFor(A)), 0);
    assert.equal(normalizeTarget(undefined), 'dsh');
  } finally { f.service.close(); }
});

test('an adapter that only covers part of the contract is refused with the missing names', async () => {
  const f = await fixture({ adapters: { 'claude-desktop': (record, deps) => { const backend = claudeAdapter([], { omit: ['deliver', 'receipt', 'destroy'] }); backend.record = record; backend.deps = deps; return backend; } } });
  try {
    const error = await rejection(f.service.create({ name: 'partner', lifetime: 'persistent', target: 'claude-desktop' }, extra(A)));
    assert.equal(error.code, 'backend-not-ready');
    for (const name of ['deliver', 'receipt', 'destroy']) assert.match(error.message, new RegExp(name));
    assert.equal(f.store.count(ownerIdFor(A)), 0);
    assert.equal(BACKEND_METHODS.length, 15);
  } finally { f.service.close(); }
});

test('status keeps every DSH field and refuses to look ready without a claude adapter', async () => {
  const f = await fixture({ adapterLoader: async () => undefined });
  try {
    const status = await f.service.status(extra(A));
    // The 0.5.7 fields stay exactly as they were.
    assert.equal(status.toolsLoaded, true);
    assert.equal(status.contextVerified, true);
    assert.equal(status.dshConnected, true);
    assert.equal(status.treeProtocolReady, true);
    assert.equal(status.reportProtocolReady, true);
    assert.equal(status.returnChannel, 'chat-verified');
    assert.equal(status.ready, true);
    // The new per-target section tells the truth about the missing adapter.
    assert.equal(status.backends.dsh.ready, true);
    assert.equal(status.backends.dsh.connected, true);
    assert.equal(status.backends.dsh.treeProtocol, 1);
    assert.equal(status.backends.dsh.reportProtocol, 1);
    assert.deepEqual(status.backends.dsh.reason, undefined);
    assert.equal(status.backends['claude-desktop'].ready, false);
    assert.equal(status.backends['claude-desktop'].present, false);
    assert.equal(status.backends['claude-desktop'].reason.code, 'backend-not-ready');
    // Diagnostics start no model turn and no session.
    assert.ok(!f.events.includes('managedCreate'));
    assert.ok(!f.events.includes('managedBeginTask'));
    assert.ok(!f.events.some(event => Array.isArray(event) && event[0] === 'send'));
    assert.equal(f.store.count(ownerIdFor(A)), 0);
  } finally { f.service.close(); }
});

test('status separates an unfinished adapter from a ready one without using it', async () => {
  const unfinished = [];
  const f = await fixture({ adapters: { 'claude-desktop': record => ({ ...claudeAdapter(unfinished),
    async probe() { unfinished.push('claude:probe'); return { identity: { application: 'claude-desktop', dataRoot: '/fixture/claude' },
      methods: [], treeProtocol: undefined, reportProtocol: 1 }; } }) } });
  try {
    const status = await f.service.status(extra(A));
    assert.equal(status.backends['claude-desktop'].ready, false);
    assert.equal(status.backends['claude-desktop'].present, true);
    assert.equal(status.backends['claude-desktop'].reason.code, 'tree-protocol-required');
    assert.equal(status.backends['claude-desktop'].treeProtocol, null);
    assert.equal(status.ready, true, 'the DSH path stays the default and unchanged');
    assert.deepEqual(unfinished, ['claude:probe'], 'diagnostics only probed; no create, deliver or session');
  } finally { f.service.close(); }

  const ready = [];
  const g = await fixture({ adapters: { 'claude-desktop': record => { const backend = claudeAdapter(ready); backend.record = record; return backend; } } });
  try {
    const status = await g.service.status(extra(A));
    assert.equal(status.backends['claude-desktop'].ready, true);
    assert.equal(status.backends['claude-desktop'].treeProtocol, 1);
    assert.equal(status.backends['claude-desktop'].reportProtocol, 1);
    assert.deepEqual(ready, ['claude:probe'], 'a ready adapter is still not created, dispatched or answered');
    assert.equal(g.store.count(ownerIdFor(A)), 0);
  } finally { g.service.close(); }
});

test('an adapter keeps its own state row and one host lock without touching the record', async () => {
  let inside = 0, overlaps = 0;
  const factory = (record, deps) => {
    const backend = claudeAdapter([]);
    backend.record = record;
    backend.deps = deps;
    backend.create = async () => {
      await deps.withHostLock(async () => {
        inside += 1; if (inside > 1) overlaps += 1;
        await new Promise(resolve => setTimeout(resolve, 25));
        deps.writeNativeState({ ...(deps.readNativeState() ?? {}),
          binding: { sessionId: `native-${record.name}`, pid: 4321 }, cursor: 0, requests: {}, projection: {} });
        inside -= 1;
      });
      return { sessionId: record.sessionId, modelRequestsStarted: 0, model: { ...CLAUDE_MODEL } };
    };
    backend.deliver = async input => {
      const state = deps.readNativeState() ?? {};
      deps.writeNativeState({ ...state, cursor: (state.cursor ?? 0) + 1,
        requests: { ...(state.requests ?? {}), [input.requestId]: { attempted: true, stage: 'written' } } });
      return { accepted: true, status: 'written', afterSeq: 1 };
    };
    return backend;
  };
  const f = await fixture({ adapters: { 'claude-desktop': factory } });
  try {
    await Promise.all([
      f.service.create({ name: 'a1', lifetime: 'persistent', target: 'claude-desktop' }, extra(A)),
      f.service.create({ name: 'a2', lifetime: 'persistent', target: 'claude-desktop' }, extra(A)),
    ]);
    assert.equal(overlaps, 0, 'withHostLock serialized host work across both names');
    const first = f.record('a1');
    assert.deepEqual(f.store.backendState(first.agentId).binding, { sessionId: 'native-a1', pid: 4321 });
    assert.deepEqual(f.store.backendState(f.record('a2').agentId).binding.sessionId, 'native-a2');

    // The hazard this row exists for: a stale record save must not erase it.
    const stale = f.store.get(first.agentId);
    f.store.save({ ...stale, state: 'running' });
    assert.deepEqual(f.store.backendState(first.agentId).binding, { sessionId: 'native-a1', pid: 4321 });

    const receipt = await f.service.send({ name: 'a1', message: 'read the plan' }, extra(A));
    assert.equal(receipt.queued, true);
    await f.service.poll(first.agentId);
    const state = f.store.backendState(first.agentId);
    assert.equal(state.cursor, 1, 'the adapter read back its own cursor');
    assert.equal(Object.keys(state.requests).length, 1, 'native write attempts stay beside the roster');
    assert.equal(state.requests[Object.keys(state.requests)[0]].stage, 'written');
    assert.equal(f.store.get(first.agentId).binding, undefined, 'the shared record carries no native field');
    assert.equal(f.store.agentForNativeSession('native-a1').name, 'a1', 'the reply surface finds the caller');

    await f.service.delete({ name: 'a1' }, extra(A));
    await f.service.poll(first.agentId);
    assert.equal(f.store.backendState(first.agentId), undefined);
    assert.equal(f.store.agentForNativeSession('native-a1'), undefined);
  } finally { f.service.close(); }
});

