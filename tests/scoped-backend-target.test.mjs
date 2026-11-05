import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor, ownerIdForSource, TRUSTED_CALLER } from '../src/calling-context.mjs';
import { BACKEND_METHODS, normalizeTarget, targetOf, resolveBackend } from '../src/agent-backend.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = '11111111-1111-4111-8111-111111111111';
const extra = threadId => ({ _meta: { threadId } });
const DESKTOP_MODEL = { provider: 'fixture', model: 'desktop-model' };
// The one registration answer a Codex Desktop create needs: both ask/report tools
// listed for this project. Read-only evidence, so no session is started for it.
const REGISTERED = async () => ({ ready: true, registered: true, tools: ['ask_parent', 'report_parent'],
  sessionVerified: false });

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
// makes. Its presence proves a desktop subagent never borrows it.
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

// A stand-in for a desktop adapter: the contract only, so target plumbing is
// verifiable without the real application.
function desktopAdapter(events, { omit = [] } = {}) {
  const backend = {
    target: 'codex-desktop',
    labels: { host: 'Codex Desktop', bridge: 'The Codex Desktop adapter' },
    async probe() {
      events.push('desktop:probe');
      return { identity: { application: 'codex-desktop', dataRoot: '/fixture/desktop' },
        methods: ['create', 'observe', 'deliver'], treeProtocol: 1, reportProtocol: 1 };
    },
    async create() {
      events.push('desktop:create');
      return { sessionId: backend.record.sessionId, modelRequestsStarted: 0, model: { ...DESKTOP_MODEL } };
    },
    async beginTask() { events.push('desktop:beginTask'); return { treeProtocol: 1, reportProtocol: 1, throughSeq: 0, currentModel: { ...DESKTOP_MODEL } }; },
    async observe() {
      events.push('desktop:observe');
      return { sessionId: backend.record.sessionId, taskId: backend.record.task?.taskId, running: false,
        questions: [], reports: [], changes: [], throughSeq: 1, currentModel: { ...DESKTOP_MODEL },
        tree: { settled: true, running: false, nodes: [] } };
    },
    async history() { events.push('desktop:history'); return { messages: [], hasMore: false }; },
    async answer() { events.push('desktop:answer'); return { consumedQuestionIds: [] }; },
    async deliver(input) {
      events.push(['desktop:deliver', input.requestId]);
      return { accepted: true, status: 'written', afterSeq: 1 };
    },
    async receipt() { events.push('desktop:receipt'); return undefined; },
    async turn() { events.push('desktop:turn'); return { state: 'running', afterSeq: 1 }; },
    async models() {
      events.push('desktop:models');
      return { default: { ...DESKTOP_MODEL }, routableProviders: [DESKTOP_MODEL.provider],
        groups: [{ id: DESKTOP_MODEL.provider, models: [{ id: DESKTOP_MODEL.model, reasoningEfforts: ['max'] }] }] };
    },
    async model() { events.push('desktop:model'); return { ...DESKTOP_MODEL }; },
    async selectModel() { events.push('desktop:selectModel'); return { accepted: true }; },
    async cancel() { events.push('desktop:cancel'); return { cancelRequested: true }; },
    async destroy() { events.push('desktop:destroy'); return { destroyed: true }; },
    async cursor() { events.push('desktop:cursor'); return { throughSeq: 0 }; },
  };
  for (const name of omit) delete backend[name];
  return backend;
}

async function stateRoot() {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'target-'));
}

async function fixture({ adapters = {}, store, adapterLoader, codexProbeRegistration } = {}) {
  const events = [];
  const stateDirectory = await stateRoot();
  const roster = store ?? new RosterStore(':memory:');
  const dsh = dshFixture(events);
  const service = createScopedAgents({ stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh' }, {
    store: roster, clientFactory: () => dsh.api, controlFactory: dsh.controlFactory, callCodex: calling(events),
    startSharedMonitor: () => true,
    removeTree: async () => {},
    backendAdapters: adapters,
    codexProbeRegistration: codexProbeRegistration ?? REGISTERED,
    // These cases pin the refusal path, so the installed adapter file must not
    // decide the outcome; an injected loader says whether one exists here.
    ...(adapterLoader ? { backendAdapterLoader: adapterLoader } : {}),
  });
  return { events, service, store: roster, stateDirectory, dsh,
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
    // The entry is matched by the exact build and the shared roster, not by a
    // fixed server name, so the probe is asked about this project's workspace and
    // config file and nothing is pinned by name.
    assert.deepEqual(probes[0], { workspace, configPath: path.join(registered.stateDirectory, 'config.json') },
      'the probe is asked about this project and its own config file');
    assert.equal('serverName' in probes[0], false,
      'readiness never depends on a hard-coded MCP entry name');
    assert.equal(status.backends['codex-desktop'].ready, true);
    assert.equal(status.backends['codex-desktop'].registered, true,
      'readiness is the registration probe answer, not a session');
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

test('a codex-desktop name is created, dispatched and listed only through its own adapter', async () => {
  const events = [];
  const f = await fixture({ adapters: { 'codex-desktop': (record, deps) => { const backend = desktopAdapter(events); backend.record = record; backend.deps = deps; return backend; } } });
  try {
    const created = await f.service.create({ name: 'partner', lifetime: 'persistent', target: 'codex-desktop' }, extra(A));
    assert.equal(created.created, true);
    assert.equal(created.target, 'codex-desktop');
    assert.equal(created.modelRequestsStarted, 0);
    assert.ok(events.includes('desktop:create'));
    assert.equal(f.record('partner').target, 'codex-desktop');
    assert.deepEqual(dshCalls(f.events), [], 'no DSH call runs for a codex-desktop name');

    const receipt = await f.service.send({ name: 'partner', message: 'read the plan' }, extra(A));
    assert.equal(receipt.queued, true, 'desktop dispatch runs in the shared monitor');
    assert.equal(receipt.accepted, false);
    await f.service.poll(f.record('partner').agentId);
    const deliveries = events.filter(event => Array.isArray(event) && event[0] === 'desktop:deliver');
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0][1], /^request-[a-f0-9]{32}$/, 'the durable request id crosses the boundary');
    assert.equal(events.includes('desktop:selectModel'), false, 'a matching target default needs no selection');
    assert.deepEqual((await f.service.list(extra(A))).items.map(item => [item.name, item.target]), [['partner', 'codex-desktop']]);
    assert.deepEqual(dshCalls(f.events), [], 'the DSH bridge stayed untouched');
  } finally { f.service.close(); }
});

test('an unfinished protocol leaves no name instead of a reconnecting one', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': record => ({ ...desktopAdapter([]), record,
    async probe() { return { identity: { application: 'codex-desktop', dataRoot: '/fixture/desktop' },
      methods: [], treeProtocol: undefined, reportProtocol: 1 }; } }) } });
  try {
    const error = await rejection(f.service.create({ name: 'partner', lifetime: 'persistent', target: 'codex-desktop' }, extra(A)));
    assert.equal(error.code, 'tree-protocol-required');
    assert.equal(f.store.count(ownerIdFor(A)), 0, 'the name is not taken for a backend that cannot serve it');
  } finally { f.service.close(); }
});

test('an unknown target is rejected before any backend is resolved', async () => {
  const f = await fixture();
  try {
    const error = await rejection(f.service.create({ name: 'artist', lifetime: 'once', target: 'claude' }, extra(A)));
    assert.equal(error.code, 'invalid-target');
    assert.match(error.message, /dsh \/ codex-desktop/);
    assert.equal(f.store.count(ownerIdFor(A)), 0);
    assert.equal(normalizeTarget(undefined), 'dsh');
  } finally { f.service.close(); }
});

test('a target this build no longer offers is refused for creation', async () => {
  const f = await fixture();
  try {
    const error = await rejection(f.service.create({ name: 'artist', lifetime: 'once', target: 'claude-desktop' }, extra(A)));
    assert.equal(error.code, 'invalid-target');
    assert.match(error.message, /dsh \/ codex-desktop/);
    assert.equal(f.store.count(ownerIdFor(A)), 0);
    assert.deepEqual(dshCalls(f.events), [], 'nothing was created on another backend either');
  } finally { f.service.close(); }
});

test('an adapter that only covers part of the contract is refused with the missing names', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': (record, deps) => { const backend = desktopAdapter([], { omit: ['deliver', 'receipt', 'destroy'] }); backend.record = record; backend.deps = deps; return backend; } } });
  try {
    const error = await rejection(f.service.create({ name: 'partner', lifetime: 'persistent', target: 'codex-desktop' }, extra(A)));
    assert.equal(error.code, 'backend-not-ready');
    for (const name of ['deliver', 'receipt', 'destroy']) assert.match(error.message, new RegExp(name));
    assert.equal(f.store.count(ownerIdFor(A)), 0);
    assert.equal(BACKEND_METHODS.length, 15);
  } finally { f.service.close(); }
});

test('status keeps every DSH field and reports both targets', async () => {
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
    // The per-target section reports both remaining targets and nothing else.
    assert.deepEqual(Object.keys(status.backends).sort(), ['codex-desktop', 'dsh']);
    assert.equal(status.backends.dsh.ready, true);
    assert.equal(status.backends.dsh.connected, true);
    assert.equal(status.backends.dsh.treeProtocol, 1);
    assert.equal(status.backends.dsh.reportProtocol, 1);
    assert.deepEqual(status.backends.dsh.reason, undefined);
    assert.equal(status.backends['codex-desktop'].ready, false, 'no adapter is installed, so the target is not ready');
    assert.equal(status.backends['codex-desktop'].present, false);
    assert.equal(status.backends['codex-desktop'].reason.code, 'backend-not-ready');
    // Diagnostics start no model turn and no session.
    assert.ok(!f.events.includes('managedCreate'));
    assert.ok(!f.events.includes('managedBeginTask'));
    assert.ok(!f.events.some(event => Array.isArray(event) && event[0] === 'send'));
    assert.equal(f.store.count(ownerIdFor(A)), 0);
  } finally { f.service.close(); }
});

test('status separates an unfinished adapter from a ready one without using it', async () => {
  const unfinished = [];
  const f = await fixture({ adapters: { 'codex-desktop': record => ({ ...desktopAdapter(unfinished),
    async probe() { unfinished.push('desktop:probe'); return { identity: { application: 'codex-desktop', dataRoot: '/fixture/desktop' },
      methods: [], treeProtocol: undefined, reportProtocol: 1 }; } }) } });
  try {
    const status = await f.service.status(extra(A));
    assert.equal(status.backends['codex-desktop'].ready, false);
    assert.equal(status.backends['codex-desktop'].present, true);
    assert.equal(status.backends['codex-desktop'].reason.code, 'tree-protocol-required');
    assert.equal(status.backends['codex-desktop'].treeProtocol, null);
    assert.equal(status.ready, true, 'the DSH path stays the default and unchanged');
    assert.deepEqual(unfinished, ['desktop:probe'], 'diagnostics only probed; no create, deliver or session');
  } finally { f.service.close(); }

  const ready = [];
  const g = await fixture({ adapters: { 'codex-desktop': record => { const backend = desktopAdapter(ready); backend.record = record; return backend; } } });
  try {
    const status = await g.service.status(extra(A));
    assert.equal(status.backends['codex-desktop'].ready, true);
    assert.equal(status.backends['codex-desktop'].registered, true, 'the entry is the registration evidence');
    assert.deepEqual(ready, ['desktop:probe'], 'a ready adapter is still not created, dispatched or answered');
    assert.equal(g.store.count(ownerIdFor(A)), 0);
  } finally { g.service.close(); }
});

test('an adapter keeps its own state row and one host lock without touching the record', async () => {
  let inside = 0, overlaps = 0;
  const factory = (record, deps) => {
    const backend = desktopAdapter([]);
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
      return { sessionId: record.sessionId, modelRequestsStarted: 0, model: { ...DESKTOP_MODEL } };
    };
    backend.deliver = async input => {
      const state = deps.readNativeState() ?? {};
      deps.writeNativeState({ ...state, cursor: (state.cursor ?? 0) + 1,
        requests: { ...(state.requests ?? {}), [input.requestId]: { attempted: true, stage: 'written' } } });
      return { accepted: true, status: 'written', afterSeq: 1 };
    };
    return backend;
  };
  const f = await fixture({ adapters: { 'codex-desktop': factory } });
  try {
    await Promise.all([
      f.service.create({ name: 'a1', lifetime: 'persistent', target: 'codex-desktop' }, extra(A)),
      f.service.create({ name: 'a2', lifetime: 'persistent', target: 'codex-desktop' }, extra(A)),
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

    await f.service.delete({ name: 'a1' }, extra(A));
    await f.service.poll(first.agentId);
    assert.equal(f.store.backendState(first.agentId), undefined);
  } finally { f.service.close(); }
});
// A verified Claude caller has a TRUSTED_CALLER and no Codex thread metadata at all.
const claudeExtra = (nativeSessionId = 'native-caller') =>
  ({ [TRUSTED_CALLER]: { source: 'claude-desktop', nativeSessionId, workspace } });

function seedClaudeOwner(store, nativeSessionId = 'native-caller') {
  const ownerId = ownerIdForSource('claude-desktop', nativeSessionId);
  store.saveOwner({ ownerId, source: 'claude-desktop', nativeSessionId, workspace,
    createdAt: new Date().toISOString() });
  return ownerId;
}

test('a Claude caller with no Codex thread creates and runs names without a parent', async () => {
  const f = await fixture();
  try {
    const ownerId = seedClaudeOwner(f.store);
    const created = await f.service.create({ name: 'partner', lifetime: 'persistent', target: 'dsh' }, claudeExtra());
    assert.equal(created.created, true);
    assert.equal(f.store.named(ownerId, 'partner').parentAgentId, undefined,
      'a Claude caller has no managed Codex parent to hang a new name under');

    const ran = await f.service.run({ name: 'artist', message: 'draw it' }, claudeExtra());
    assert.equal(ran.created, true);
    assert.equal(ran.name, 'artist');
    assert.equal(f.store.named(ownerId, 'artist').parentAgentId, undefined);
    assert.deepEqual((await f.service.list(claudeExtra())).items.map(item => item.name).sort(), ['artist', 'partner'],
      'both names belong to the Claude caller and are addressable by name');
  } finally { f.service.close(); }
});
test('a managed Codex child still records its parent when it creates a name', async () => {
  const f = await fixture();
  try {
    const rootId = 'agent-' + 'b'.repeat(32);
    f.store.insert({ agentId: rootId, ownerId: ownerIdFor(A), sessionId: 'session-root', name: 'root',
      lifetime: 'persistent', target: 'codex-desktop', workspace, state: 'idle', created: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [] });
    f.store.saveBackendState(rootId, { binding: { threadId: A } });
    const created = await f.service.create({ name: 'child', lifetime: 'once' }, extra(A));
    assert.equal(created.created, true);
    assert.equal(f.store.named(ownerIdFor(A), 'child').parentAgentId, rootId,
      'a Codex child owns its new name under its own tree');
  } finally { f.service.close(); }
});