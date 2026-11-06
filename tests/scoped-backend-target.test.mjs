import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor, ownerIdForSource, TRUSTED_CALLER } from '../src/calling-context.mjs';
import { BACKEND_METHODS, normalizeTarget, targetOf, resolveBackend } from '../src/agent-backend.mjs';
import { liveThread, livePage } from '../test/live-thread-fixture.mjs';

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
      return { sessionId: input.sessionId, taskId: session.taskId, running: session.running,
        questions: session.questions ?? [], reports: session.reports ?? [],
        changes: [], throughSeq: session.seq, currentModel: { provider: 'fixture', model: 'dsh-model' },
        tree: { settled: !session.running, running: session.running, nodes: session.nodes ?? [] } };
    },
    async managedCancel(input) { events.push('managedCancel'); return { cancelRequested: true }; },
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
    async wait() { return session.turnResult ?? { state: 'running', afterSeq: session.seq }; },
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
      // The real unbound Codex backend reads no config at creation; its model stays
      // unknown until a live observation reports one.
      return { sessionId: backend.record.sessionId, modelRequestsStarted: 0 };
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

async function fixture({ adapters = {}, store, adapterLoader, codexProbeRegistration,
  callCodex, nativeRequest, codexInvoke } = {}) {
  const events = [];
  const stateDirectory = await stateRoot();
  const roster = store ?? new RosterStore(':memory:');
  const dsh = dshFixture(events);
  const service = createScopedAgents({ stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh' }, {
    store: roster, clientFactory: () => dsh.api, controlFactory: dsh.controlFactory,
    // A fixture that wants the real Codex-owner path omits this injection and
    // supplies only the transport seams below.
    ...(callCodex === false ? {} : { callCodex: callCodex ?? calling(events) }),
    ...(nativeRequest ? { nativeRequest } : {}),
    ...(codexInvoke ? { codexInvoke } : {}),
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

test('an unpinned Codex name reports actualModel from the live observation, never a guess', async () => {
  const events = [];
  const f = await fixture({ adapters: { 'codex-desktop': record => {
    const backend = desktopAdapter(events); backend.record = record; return backend;
  } } });
  try {
    const created = await f.service.create({ name: 'partner', lifetime: 'persistent', target: 'codex-desktop' }, extra(A));
    assert.equal(created.actualModel, null, 'creation has no observed model yet');
    const receipt = await f.service.send({ name: 'partner', message: 'work' }, extra(A));
    assert.equal(receipt.queued, true);
    assert.equal(receipt.actualModel, null);
    await f.service.poll(f.record('partner').agentId);
    const observed = f.record('partner');
    assert.ok(observed.observation?.currentModel, 'the poll recorded the real observation');
    // Model display can lag behind observation on an unpinned desktop name; list
    // must read the observation rather than presenting null.
    observed.model = undefined; f.store.save(observed);
    assert.equal((await f.service.list(extra(A))).items[0].actualModel, 'desktop-model');
    assert.equal((await f.service.wait({ names: ['partner'] }, extra(A))).items[0].actualModel, 'desktop-model');
  } finally { f.service.close(); }
});

test('Codex receives an explicit model on deliver and never selects one; a running turn refuses a pin change', async () => {
  const deliveries = [];
  const events = [];
  const catalog = { default: { ...DESKTOP_MODEL }, routableProviders: [DESKTOP_MODEL.provider],
    groups: [{ id: DESKTOP_MODEL.provider, models: [
      { id: DESKTOP_MODEL.model, reasoning: { efforts: [{ id: 'max' }], defaultEffort: 'max' } },
      { id: 'desktop-pro', reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' } },
    ] }] };
  const f = await fixture({ adapters: { 'codex-desktop': record => {
    const backend = desktopAdapter(events); backend.record = record;
    backend.models = async () => { events.push('desktop:models'); return catalog; };
    backend.deliver = async input => {
      deliveries.push(input); events.push(['desktop:deliver', input.requestId]);
      return { accepted: true, status: 'written', afterSeq: 1 };
    };
    return backend;
  } } });
  try {
    const created = await f.service.create({ name: 'partner', lifetime: 'persistent', target: 'codex-desktop', model: 'PRO' }, extra(A));
    assert.equal(created.actualModel, 'desktop-pro', 'the receipt reports the resolved pin');
    assert.equal(f.record('partner').model, undefined, 'no session-only model write exists for Codex');
    assert.equal((await f.service.list(extra(A))).items[0].actualModel, null,
      'list waits for a real observation instead of presenting the pin as actual');
    assert.deepEqual(f.record('partner').modelPin,
      { provider: 'fixture', model: 'desktop-pro', reasoningEffort: 'high' });
    await f.service.send({ name: 'partner', message: 'work' }, extra(A));
    await f.service.poll(f.record('partner').agentId);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].explicitModel, true);
    assert.deepEqual(deliveries[0].model,
      { provider: 'fixture', model: 'desktop-pro', reasoningEffort: 'high' });
    assert.equal(events.includes('desktop:selectModel'), false,
      'the shared layer never calls Codex selectModel');

    const error = await rejection(f.service.send({ name: 'partner', message: 'change', model: 'desktop-model' }, extra(A)));
    assert.equal(error.code, 'codex-model-change-while-running');
    assert.deepEqual(f.record('partner').modelPin,
      { provider: 'fixture', model: 'desktop-pro', reasoningEffort: 'high' },
      'the refused selection is not persisted');
    assert.equal(f.store.supplements(f.record('partner').agentId).length, 0);
    assert.equal(f.record('partner').task.dispatches.length, 1, 'the refused change created no dispatch');
    const unknown = await rejection(f.service.send({ name: 'partner', message: 'typo', model: 'not-in-catalog' }, extra(A)));
    assert.equal(unknown.code, 'model-not-found', 'a missing ID is reported before the running check');
    assert.match(unknown.message, /desktop-pro/);
    const same = await f.service.send({ name: 'partner', message: 'same pin', model: 'PRO', effort: 'high' }, extra(A));
    assert.equal(same.queued, true, 'the exact active pin is an ordinary supplement');
    assert.equal(same.actualModel, 'desktop-pro');
    assert.equal(f.store.supplements(f.record('partner').agentId).length, 1);
    assert.deepEqual(f.record('partner').modelPin,
      { provider: 'fixture', model: 'desktop-pro', reasoningEffort: 'high' });

    await f.service.create({ name: 'unpinned', lifetime: 'persistent', target: 'codex-desktop' }, extra(A));
    await f.service.send({ name: 'unpinned', message: 'inherit' }, extra(A));
    await f.service.poll(f.record('unpinned').agentId);
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1].explicitModel, false);
    assert.equal('model' in deliveries[1], false, 'native inheritance sends no model field');
  } finally { f.service.close(); }
});

test('an earlier queued selection is delivered even after a later pin change; the live turn decides compatibility', async () => {
  const catalog = { default: { provider: 'fixture', model: 'a-model' }, routableProviders: ['fixture'],
    groups: [{ id: 'fixture', models: [
      { id: 'a-model', reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } },
      { id: 'b-model', reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' } },
    ] }] };
  const deliveries = [];
  const f = await fixture({ adapters: { 'codex-desktop': record => {
    const backend = desktopAdapter([]); backend.record = record;
    backend.models = async () => catalog;
    backend.deliver = async input => {
      deliveries.push(input);
      if (input.explicitModel && input.model?.model !== 'a-model') {
        throw Object.assign(new Error('the running turn still uses a-model'), {
          code: 'codex-model-change-while-running', terminal: true,
        });
      }
      return { accepted: true, status: 'written', afterSeq: 1 };
    };
    return backend;
  } } });
  try {
    await f.service.create({ name: 'partner', lifetime: 'persistent', target: 'codex-desktop', model: 'A' }, extra(A));
    await f.service.send({ name: 'partner', message: 'first' }, extra(A));
    await f.service.poll(f.record('partner').agentId);
    const queuedA = f.record('partner');
    // Simulate the between-turns window in which inputs are accepted while the
    // running turn still uses a-model.
    queuedA.state = queuedA.task.state = 'awaiting_report';
    queuedA.observation = { ...(queuedA.observation ?? {}),
      tree: { ...(queuedA.observation?.tree ?? {}), running: false } };
    f.store.save(queuedA);

    const first = await f.service.send({ name: 'partner', message: 'old input', model: 'A' }, extra(A));
    const second = await f.service.send({ name: 'partner', message: 'new input', model: 'B' }, extra(A));
    assert.equal(first.actualModel, 'a-model');
    assert.equal(second.actualModel, 'b-model');
    assert.deepEqual(f.record('partner').modelPin,
      { provider: 'fixture', model: 'b-model', reasoningEffort: 'high' });

    const running = f.record('partner');
    running.state = running.task.state = 'running';
    running.observation = { ...(running.observation ?? {}),
      tree: { ...(running.observation?.tree ?? {}), running: true, settled: false } };
    f.store.save(running);
    await f.service.poll(running.agentId);

    assert.equal(deliveries[1].model.model, 'a-model', 'the earlier input is not discarded by the later pin');
    assert.equal(deliveries[1].explicitModel, true);
    const summary = f.store.supplementSummary(running.agentId, running.task.taskId);
    assert.equal(summary.accepted, 1);
    assert.equal(summary.blocked, 1, 'the incompatible later input is left visibly blocked');
    assert.equal(summary.latest.reason, 'codex-model-change-while-running');
  } finally { f.service.close(); }
});

test('a Codex record ignores its legacy dataRoot and keeps working', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': record => {
    const backend = desktopAdapter([]);
    backend.record = record;
    backend.probe = async () => ({ identity: { application: 'codex-desktop', home: 'C:/Users/x/.codex' },
      methods: ['create', 'observe', 'deliver'], treeProtocol: 1, reportProtocol: 1 });
    return backend;
  } } });
  try {
    await f.service.create({ name: 'partner', lifetime: 'persistent', target: 'codex-desktop' }, extra(A));
    const record = f.record('partner');
    record.host = { application: 'codex-desktop', dataRoot: 'D:/Work/tools/codexX' };
    f.store.save(record);
    await f.service.send({ name: 'partner', message: 'continue' }, extra(A));
    await f.service.poll(record.agentId);
    assert.equal(f.record('partner').host.dataRoot, 'D:/Work/tools/codexX', 'the legacy row is not migrated');
    assert.equal(f.record('partner').error, undefined, 'the monitor cwd is irrelevant to Codex ownership');
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
    assert.deepEqual(status.backends.dsh.models, ['dsh-model']);
    assert.equal(status.backends.dsh.defaultModel, 'dsh-model');
    assert.deepEqual(status.backends.dsh.reason, undefined);
    assert.equal(status.backends['codex-desktop'].ready, false, 'no adapter is installed, so the target is not ready');
    assert.equal(status.backends['codex-desktop'].present, false);
    assert.deepEqual(status.backends['codex-desktop'].models, []);
    assert.equal(status.backends['codex-desktop'].defaultModel, null);
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
    assert.deepEqual(status.backends['codex-desktop'].models, ['desktop-model']);
    assert.deepEqual(unfinished, ['desktop:probe', 'desktop:models'], 'a reachable catalog is visible even before the adapter is ready');
  } finally { f.service.close(); }

  const ready = [];
  const g = await fixture({ adapters: { 'codex-desktop': record => { const backend = desktopAdapter(ready); backend.record = record; return backend; } } });
  try {
    const status = await g.service.status(extra(A));
    assert.equal(status.backends['codex-desktop'].ready, true);
    assert.equal(status.backends['codex-desktop'].registered, true, 'the entry is the registration evidence');
    assert.equal(status.backends['codex-desktop'].evidence, 'native-rpc', 'readiness came from the real thread/list RPC');
    assert.deepEqual(status.backends['codex-desktop'].models, ['desktop-model']);
    assert.equal(status.backends['codex-desktop'].defaultModel, 'desktop-model');
    assert.deepEqual(ready, ['desktop:probe', 'desktop:models'], 'diagnostics only read the native probe and catalog');
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
test('a DSH child question reaches a Codex owner over the native RPC', async () => {
  const calls = [];
  const nativeRequest = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: liveThread({ id: A, cwd: workspace, model: 'fixture' }) };
    if (method === 'thread/turns/list') return livePage();
    if (method === 'turn/start' || method === 'turn/steer') return { turn: { id: `turn-${calls.length}`, items: [], status: 'inProgress' } };
    if (method === 'thread/list') return livePage();
    throw new Error('unexpected ' + method);
  };
  const f = await fixture({ callCodex: false, nativeRequest });
  try {
    await f.service.create({ name: 'helper', lifetime: 'persistent', target: 'dsh' }, extra(A));
    await f.service.send({ name: 'helper', message: 'work' }, extra(A));
    const record = f.record('helper');
    const taskId = record.task.taskId;
    f.dsh.session.running = false;
    f.dsh.session.questions = [{ id: 'q1', taskId, state: 'pending', message: 'need input' }];
    await f.service.poll(record.agentId);
    const sent = calls.filter(call => call.method === 'turn/start');
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0].params), /need input/);
  } finally { f.service.close(); }
});

test('a DSH child final report reaches a Codex owner over the native RPC', async () => {
  const calls = [];
  const nativeRequest = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: liveThread({ id: A, cwd: workspace, model: 'fixture' }) };
    if (method === 'thread/turns/list') return livePage();
    if (method === 'turn/start' || method === 'turn/steer') return { turn: { id: `turn-${calls.length}`, items: [], status: 'inProgress' } };
    if (method === 'thread/list') return livePage();
    throw new Error('unexpected ' + method);
  };
  const f = await fixture({ callCodex: false, nativeRequest });
  try {
    await f.service.create({ name: 'helper', lifetime: 'persistent', target: 'dsh' }, extra(A));
    await f.service.send({ name: 'helper', message: 'work' }, extra(A));
    const record = f.record('helper');
    const taskId = record.task.taskId;
    f.dsh.session.running = false;
    f.dsh.session.nodes = [{ sessionId: record.sessionId, parentSessionId: null, status: 'idle', changes: [] }];
    f.dsh.session.reports = [{ id: 'r1', taskId, message: 'all done', final: true, createdAt: new Date().toISOString() }];
    await f.service.poll(record.agentId);
    const sent = calls.filter(call => call.method === 'turn/start');
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0].params), /all done/);
    assert.equal(f.record('helper').state, 'idle');
  } finally { f.service.close(); }
});

test('without a debug port the DSH report falls back to the app-tools read and send', async () => {
  const appTools = [];
  const codexInvoke = async (threadId, toolName, args) => {
    appTools.push({ threadId, toolName, args });
    if (toolName === 'read_thread') return { content: [{ type: 'text', text: JSON.stringify({
      thread: { id: A, kind: 'codex', hostId: 'local', cwd: workspace } }) }], isError: false };
    return { content: [{ type: 'text', text: 'accepted' }], isError: false };
  };
  const nativeRequest = async () => { throw Object.assign(new Error('no debug port'), { code: 'codex-native-rpc-unavailable' }); };
  const f = await fixture({ callCodex: false, nativeRequest, codexInvoke });
  try {
    await f.service.create({ name: 'helper', lifetime: 'persistent', target: 'dsh' }, extra(A));
    await f.service.send({ name: 'helper', message: 'work' }, extra(A));
    const record = f.record('helper');
    const taskId = record.task.taskId;
    f.dsh.session.running = false;
    f.dsh.session.nodes = [{ sessionId: record.sessionId, parentSessionId: null, status: 'idle', changes: [] }];
    f.dsh.session.reports = [{ id: 'r2', taskId, message: 'fallback done', final: true, createdAt: new Date().toISOString() }];
    await f.service.poll(record.agentId);
    assert.deepEqual(appTools.map(item => item.toolName), ['read_thread', 'read_thread', 'send_message_to_thread']);
    assert.match(appTools.find(item => item.toolName === 'send_message_to_thread').args.prompt, /fallback done/);
  } finally { f.service.close(); }
});
test('a final notice to a missing Codex profile becomes a visible terminal failure', async () => {
  let fail = false, reads = 0;
  const nativeRequest = async method => {
    if (method !== 'thread/read') return livePage();
    reads++;
    if (fail) throw Object.assign(new Error('thread not found'), { code: 'codex-thread-not-found', terminal: true });
    return { thread: liveThread({ id: A, cwd: workspace, model: 'fixture' }) };
  };
  const f = await fixture({ callCodex: false, nativeRequest });
  try {
    await f.service.create({ name: 'helper', lifetime: 'persistent', target: 'dsh' }, extra(A));
    await f.service.send({ name: 'helper', message: 'work' }, extra(A));
    const record = f.record('helper');
    const taskId = record.task.taskId;
    f.dsh.session.running = false;
    f.dsh.session.nodes = [{ sessionId: record.sessionId, parentSessionId: null, status: 'idle', changes: [] }];
    f.dsh.session.reports = [{ id: 'r3', taskId, message: 'kept report', final: true, createdAt: new Date().toISOString() }];
    fail = true;
    await f.service.poll(record.agentId);
    const after = f.record('helper');
    assert.equal(after.state, 'failed');
    assert.equal(after.task.reports.at(-1).delivery.state, 'blocked');
    assert.equal(after.task.reports.at(-1).delivery.error.code, 'codex-thread-not-found');
    assert.match(after.task.reports.at(-1).delivery.error.message, /当前 Codex 档案里看不到这个对话/);
    const listed = (await f.service.list(extra(A))).items.find(item => item.name === 'helper');
    assert.equal(listed.reports.latest.error.code, 'codex-thread-not-found');
    const readsAfter = reads;
    await f.service.poll(record.agentId);
    assert.equal(reads, readsAfter, 'a blocked profile notice is not retried');
  } finally { f.service.close(); }
});

test('a transient Codex owner outage keeps the final notice pending and retries it', async () => {
  let fail = false;
  const nativeRequest = async (method, params) => {
    if (method === 'thread/read') {
      if (fail) throw Object.assign(new Error('no debug port'), { code: 'codex-native-rpc-unavailable' });
      return { thread: { id: A, cwd: workspace, status: { type: 'idle' }, model: 'fixture' } };
    }
    if (method === 'thread/turns/list') return { data: [] };
    if (method === 'turn/start' || method === 'turn/steer') return { turn: { id: 'turn-rpc', items: [], status: 'inProgress' } };
    if (method === 'thread/list') return { data: [] };
    throw new Error('unexpected ' + method);
  };
  const codexInvoke = async () => { throw new Error('app-tools also unavailable'); };
  const f = await fixture({ callCodex: false, nativeRequest, codexInvoke });
  try {
    await f.service.create({ name: 'helper', lifetime: 'persistent', target: 'dsh' }, extra(A));
    await f.service.send({ name: 'helper', message: 'work' }, extra(A));
    const record = f.record('helper');
    const taskId = record.task.taskId;
    f.dsh.session.running = false;
    f.dsh.session.nodes = [{ sessionId: record.sessionId, parentSessionId: null, status: 'idle', changes: [] }];
    f.dsh.session.reports = [{ id: 'r4', taskId, message: 'retry me', final: true, createdAt: new Date().toISOString() }];
    fail = true;
    await f.service.poll(record.agentId);
    assert.equal(f.record('helper').state, 'delivery_pending');
    assert.equal(f.record('helper').task.reports.at(-1).delivery.state, 'pending');
    fail = false;
    const retry = f.record('helper');
    retry.task.reports.at(-1).delivery.nextAttemptAt = 0;
    f.store.save(retry);
    await f.service.poll(record.agentId);
    assert.equal(f.record('helper').task.reports.at(-1).delivery.state, 'delivered');
    assert.equal(f.record('helper').state, 'idle');
  } finally { f.service.close(); }
});

test('a failed DSH task notifies its Codex parent once and a cancelled task does not', async () => {
  const calls = [];
  const nativeRequest = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: liveThread({ id: A, cwd: workspace, model: 'fixture' }) };
    if (method === 'thread/turns/list') return livePage();
    if (method === 'turn/start' || method === 'turn/steer') return { turn: { id: `turn-${calls.length}`, items: [], status: 'inProgress' } };
    if (method === 'thread/list') return livePage();
    throw new Error('unexpected ' + method);
  };
  const f = await fixture({ callCodex: false, nativeRequest });
  try {
    await f.service.create({ name: 'helper', lifetime: 'persistent', target: 'dsh' }, extra(A));
    await f.service.send({ name: 'helper', message: 'work' }, extra(A));
    const record = f.record('helper');
    // A running/retrying task is not a terminal failure yet: no notice.
    await f.service.poll(record.agentId);
    assert.equal(calls.filter(call => call.method === 'turn/start'
      && JSON.stringify(call.params).includes('执行失败')).length, 0);
    f.dsh.session.running = false;
    f.dsh.session.nodes = [{ sessionId: record.sessionId, parentSessionId: null, status: 'idle', changes: [] }];
    f.dsh.session.turnResult = { state: 'ended', completionReason: { kind: 'error', error: { message: 'gateway 503' } },
      endSeq: f.dsh.session.seq, correlation: 'request-id' };
    await f.service.poll(record.agentId);
    const failed = f.record('helper');
    assert.equal(failed.state, 'failed');
    const notices = calls.filter(call => call.method === 'turn/start'
      && JSON.stringify(call.params).includes('执行失败'));
    assert.equal(notices.length, 1);
    assert.match(JSON.stringify(notices[0].params), /helper/);
    await f.service.poll(record.agentId);
    assert.equal(calls.filter(call => call.method === 'turn/start'
      && JSON.stringify(call.params).includes('执行失败')).length, 1, 'one failure notice per task');

    // A task the parent itself cancelled is stopped, not failed, and sends no notice.
    const second = await fixture({ callCodex: false, nativeRequest });
    await second.service.create({ name: 'cancelled', lifetime: 'persistent', target: 'dsh' }, extra(A));
    await second.service.send({ name: 'cancelled', message: 'work' }, extra(A));
    const cancelled = second.record('cancelled');
    second.dsh.session.running = false;
    second.dsh.session.nodes = [{ sessionId: cancelled.sessionId, parentSessionId: null, status: 'idle', changes: [] }];
    const current = second.store.get(cancelled.agentId);
    current.task.cancelRequested = true;
    second.store.save(current);
    await second.service.poll(cancelled.agentId);
    assert.equal(second.record('cancelled').task.reports.find(report => report.failure), undefined);
    assert.equal(calls.filter(call => call.method === 'turn/start'
      && JSON.stringify(call.params).includes('执行失败')).length, 1);
    second.service.close();
  } finally { f.service.close(); }
});

test('a failed notification is retried by the real candidate scan after its first send is unavailable', async () => {
  const calls = [];
  let fail = false;
  const nativeRequest = async (method, params) => {
    calls.push({ method, params });
    if (fail) throw Object.assign(new Error('no debug port'), { code: 'codex-native-rpc-unavailable' });
    if (method === 'thread/read') return { thread: liveThread({ id: A, cwd: workspace, model: 'fixture' }) };
    if (method === 'thread/turns/list') return livePage();
    if (method === 'turn/start' || method === 'turn/steer') return { turn: { id: `turn-${calls.length}`, items: [], status: 'inProgress' } };
    if (method === 'thread/list') return livePage();
    throw new Error('unexpected ' + method);
  };
  const f = await fixture({ callCodex: false, nativeRequest });
  try {
    await f.service.create({ name: 'helper', lifetime: 'persistent', target: 'dsh' }, extra(A));
    await f.service.send({ name: 'helper', message: 'work' }, extra(A));
    const record = f.record('helper');
    f.dsh.session.running = false;
    f.dsh.session.nodes = [{ sessionId: record.sessionId, parentSessionId: null, status: 'idle', changes: [] }];
    f.dsh.session.turnResult = { state: 'ended', completionReason: { kind: 'error', error: { message: 'gateway 503' } },
      endSeq: f.dsh.session.seq, correlation: 'request-id' };
    fail = true;
    await f.service.poll(record.agentId);
    const failed = f.record('helper');
    const failure = failed.task.reports.find(report => report.failure);
    assert.equal(failed.state, 'failed');
    assert.equal(failure.delivery.state, 'pending');
    failure.delivery.nextAttemptAt = 0;
    f.store.save(failed);
    const candidate = f.store.listWorkerCandidates().find(item => item.agentId === failed.agentId);
    assert.equal(candidate.pendingReports, 1, JSON.stringify(candidate));
    fail = false;
    await f.service.monitorScan({ force: true });
    await f.service.drainPolls();
    const retried = f.record('helper');
    assert.equal(retried.task.reports.find(report => report.failure).delivery.state, 'delivered');
    assert.equal(calls.filter(call => call.method === 'turn/start'
      && JSON.stringify(call.params).includes('执行失败')).length, 1);
  } finally { f.service.close(); }
});

test('a terminal backend error notifies the Codex parent once', async () => {
  const calls = [];
  const nativeRequest = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: liveThread({ id: A, cwd: workspace, model: 'fixture' }) };
    if (method === 'thread/turns/list') return livePage();
    if (method === 'turn/start' || method === 'turn/steer') return { turn: { id: `turn-${calls.length}`, items: [], status: 'inProgress' } };
    if (method === 'thread/list') return livePage();
    throw new Error('unexpected ' + method);
  };
  const f = await fixture({ callCodex: false, nativeRequest,
    adapters: { 'codex-desktop': record => {
      const backend = desktopAdapter([]);
      backend.record = record;
      backend.observe = async () => { throw Object.assign(new Error('thread not found'), { code: 'codex-thread-not-found', terminal: true }); };
      return backend;
    } } });
  try {
    await f.service.create({ name: 'helper', lifetime: 'persistent', target: 'codex-desktop' }, extra(A));
    await f.service.send({ name: 'helper', message: 'work' }, extra(A));
    await f.service.poll(f.record('helper').agentId);
    const record = f.record('helper');
    assert.equal(record.state, 'failed');
    const notices = calls.filter(call => call.method === 'turn/start'
      && JSON.stringify(call.params).includes('执行失败'));
    assert.equal(notices.length, 1);
    await f.service.poll(record.agentId);
    assert.equal(calls.filter(call => call.method === 'turn/start'
      && JSON.stringify(call.params).includes('执行失败')).length, 1);
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
