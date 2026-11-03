import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';
import { BACKEND_METHODS, normalizeTarget, targetOf } from '../src/agent-backend.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = '11111111-1111-4111-8111-111111111111';
const extra = threadId => ({ _meta: { threadId } });
const CLAUDE_MODEL = { provider: 'anthropic', model: 'claude-opus-5-5' };

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

async function fixture({ adapters = {}, store } = {}) {
  const events = [];
  const stateDirectory = await stateRoot();
  const roster = store ?? new RosterStore(':memory:');
  const dsh = dshFixture(events);
  const service = createScopedAgents({ stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh' }, {
    store: roster, clientFactory: () => dsh.api, controlFactory: dsh.controlFactory, callCodex: calling(events),
    startWorker: (...args) => { events.push(['worker', args[1]]); return 99999; },
    removeTree: async () => {},
    backendAdapters: adapters,
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
    assert.ok(!f.events.some(event => typeof event === 'string' && event.startsWith('claude:')), 'a legacy name never reaches another backend');
  } finally { f.service.close(); }
});

test('a claude-desktop subagent without an adapter is refused before the name exists', async () => {
  const f = await fixture();
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

    const receipt = await f.service.send({ name: 'partner', message: 'read the plan' }, extra(A));
    assert.equal(receipt.accepted, true, 'written is accepted, not completion');
    const deliveries = events.filter(event => Array.isArray(event) && event[0] === 'claude:deliver');
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0][1], /^request-[a-f0-9]{32}$/, 'the durable request id crosses the boundary');
    assert.equal(events.includes('claude:selectModel'), false, 'a matching target default needs no selection');
    assert.deepEqual((await f.service.list(extra(A))).items.map(item => [item.name, item.target]), [['partner', 'claude-desktop']]);
    assert.deepEqual(dshCalls(f.events), [], 'the DSH bridge stayed untouched');
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

