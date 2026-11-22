// The Codex supplement/queue contract at the adapter boundary.
//
// These cases run the real Codex backend, host and native IPC selection; only the
// Desktop RPC endpoint is a local stand-in. They pin the three-way selection intent,
// queue-only new turns, a root turn that is independent of descendants, the
// write-ahead intent inside the host lock, and read-only recovery without replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { markerLine } from '../src/codex-host.mjs';
import { livePage, liveThread, liveTurn } from './live-thread-fixture.mjs';

const WORKSPACE = 'D:/work/project';
const SOL = { id: 'preset-sol', model: 'wire-sol', displayName: 'Sol', hidden: false,
  isDefault: true, defaultReasoningEffort: 'max',
  supportedReasoningEfforts: [{ reasoningEffort: 'max', description: 'Max' },
    { reasoningEffort: 'high', description: 'High' }] };
const LUNA = { id: 'preset-luna', model: 'wire-luna', displayName: 'Luna', hidden: false,
  isDefault: false, defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' },
    { reasoningEffort: 'high', description: 'High' }] };
const selection = model => ({ provider: 'openai', model: model.id,
  reasoningEffort: model === SOL ? 'max' : 'high' });

function desktop({ omitModel = false } = {}) {
  const calls = [], threads = new Map(), children = new Map(), hooks = {};
  let clock = 1793932679, created = 0;
  const find = id => {
    const thread = threads.get(id);
    if (!thread) throw Object.assign(new Error(`thread not found: ${id}`), { code: 'codex-thread-not-found' });
    return thread;
  };
  const view = thread => liveThread({ id: thread.id, cwd: thread.cwd, name: thread.name,
    updatedAt: thread.updatedAt, status: { type: thread.active ? 'active' : 'idle' },
    ...(omitModel ? { model: undefined, reasoningEffort: undefined }
      : { model: thread.model, reasoningEffort: thread.effort }) });
  const summaryItems = turn => [turn.items.find(item => item.type === 'userMessage'),
    turn.items.findLast(item => item.type === 'agentMessage')].filter(Boolean);
  async function request(method, params = {}, options) {
    if (method === 'turn/steer') hooks.beforeSteer?.(params);
    if (method === 'turn/start') hooks.beforeStart?.(params);
    calls.push({ method, params: structuredClone(params) });
    switch (method) {
      case 'thread/list':
        return livePage((children.get(params.parentThreadId) ?? []).map(id => view(find(id))));
      case 'model/list': return livePage([structuredClone(SOL), structuredClone(LUNA)]);
      case 'config/read': return { model: SOL.id, provider: 'openai', reasoningEffort: 'max', profile: null };
      case 'thread/start': {
        const id = `thread-${String(++created).padStart(4, '0')}`;
        threads.set(id, { id, cwd: params.cwd, name: null, active: false, model: SOL.model,
          effort: 'max', turns: [], updatedAt: ++clock });
        return { thread: view(find(id)) };
      }
      case 'thread/read':
      case 'thread/resume': {
        if (method === 'thread/read' && hooks.failRead?.()) {
          throw Object.assign(new Error('Native Desktop request timed out.'),
            { code: 'codex-native-rpc-response-timeout' });
        }
        return { thread: view(find(params.threadId)) };
      }
      case 'thread/name/set': { find(params.threadId).name = params.name; return {}; }
      case 'thread/turns/list': {
        hooks.beforeTurnsList?.(params);
        const thread = find(params.threadId);
        const items = params.itemsView === 'summary' ? summaryItems
          : params.itemsView === 'notLoaded' ? () => [] : turn => turn.items;
        return livePage(thread.turns.toReversed().map(turn => liveTurn({ id: turn.id, rootTurnId: turn.id,
          status: turn.status, startedAt: turn.startedAt, items: items(turn) })));
      }
      case 'thread/items/list': {
        const thread = find(params.threadId), turn = thread.turns.find(item => item.id === params.turnId);
        if (!turn) throw new Error('missing turn');
        return { data: turn.items.map(item => ({ turnId: turn.id, item })), nextCursor: null };
      }
      case 'turn/start': {
        const thread = find(params.threadId);
        if (hooks.raceStart?.()) {
          thread.turns.push({ id: 'turn-a', status: 'inProgress', startedAt: ++clock,
            items: [{ id: `item-${++clock}`, type: 'userMessage',
              content: [{ type: 'text', text: 'another turn won the race' }] }] });
          thread.active = true;
          throw Object.assign(new Error('a turn is already running on this thread'),
            { code: 'codex-native-rpc-rejected', rpcMessage: 'a turn is already running on this thread' });
        }
        if (thread.turns.some(turn => turn.status === 'inProgress')) {
          throw Object.assign(new Error('a turn is already running on this thread'),
            { code: 'codex-native-rpc-rejected', rpcMessage: 'a turn is already running on this thread' });
        }
        if (params.model !== undefined) thread.model = params.model;
        if (params.effort !== undefined) thread.effort = params.effort;
        const turn = { id: `turn-${++clock}`, status: 'inProgress', startedAt: ++clock,
          items: [{ id: `item-${++clock}`, type: 'userMessage',
            content: [{ type: 'text', text: (params.input ?? []).map(part => part.text ?? '').join('') }] }] };
        thread.turns.push(turn); thread.active = true; thread.updatedAt = ++clock;
        return { turn: liveTurn({ id: turn.id, rootTurnId: turn.id, status: 'inProgress', items: [] }) };
      }
      case 'turn/steer': {
        const thread = find(params.threadId), turn = thread.turns.find(item => item.status === 'inProgress');
        if (hooks.rejectSteer?.()) {
          if (hooks.steerEndsTurn !== false && turn) { turn.status = 'completed'; thread.active = false; }
          throw Object.assign(new Error('no active turn to steer'),
            { code: 'codex-native-rpc-rejected', rpcMessage: 'no active turn to steer' });
        }
        if (!turn || turn.id !== params.expectedTurnId) {
          throw Object.assign(new Error('no active turn to steer'),
            { code: 'codex-native-rpc-rejected', rpcMessage: 'no active turn to steer' });
        }
        turn.items.push({ id: `item-${++clock}`, type: 'userMessage',
          content: [{ type: 'text', text: (params.input ?? []).map(part => part.text ?? '').join('') }] });
        thread.updatedAt = ++clock;
        return { turnId: turn.id };
      }
      case 'futureaide/userInput/read': return { status: 'observed', requests: [] };
      case 'turn/interrupt': return {};
      default: throw new Error(`unexpected native method ${method}`);
    }
  }
  return {
    request, calls, hooks, threads, children,
    add(spec) {
      threads.set(spec.id, { id: spec.id, cwd: spec.cwd ?? WORKSPACE, name: null,
        active: spec.active === true, model: spec.model ?? SOL.model, effort: spec.effort ?? 'max',
        turns: (spec.turns ?? []).map(turn => ({ ...turn, items: [...(turn.items ?? [])] })),
        updatedAt: ++clock });
    },
    child(parent, id) { children.set(parent, [...(children.get(parent) ?? []), id]); },
    count: method => calls.filter(call => call.method === method).length,
    paramsOf: method => calls.filter(call => call.method === method).map(call => call.params),
  };
}

function requestState(overrides = {}) {
  return { requestId: 'r1', marker: markerLine('r1', 'n'), messageHash: 'hash', status: 'accepted',
    turnId: 'turn-a', model: { provider: 'openai', model: SOL.id, reasoningEffort: 'max' },
    delivery: { model: SOL.model, effort: 'max' }, explicitModel: true,
    kind: 'task', route: 'new-turn', native: { method: 'turn/start', turnId: 'turn-a' },
    ...overrides };
}

async function fixture({ omitModel = false, thread = {}, saved, lock } = {}) {
  const native = desktop({ omitModel });
  native.add({ id: 'native-1', ...thread });
  const record = { name: 'helper', agentId: 'a', sessionId: 'logical', workspace: WORKSPACE,
    task: { taskId: 'task-1' } };
  let state = saved ?? { binding: { sessionId: 'native-1', owned: true }, requests: {},
    projections: {}, nonce: 'n', tree: { nodes: [{ sessionId: 'native-1', parentSessionId: null,
      status: 'idle', changes: [] }] } };
  let depth = 0;
  const backend = await createCodexBackend(record, {
    load: () => record,
    readNativeState: () => structuredClone(state),
    writeNativeState: value => { state = structuredClone(value); return true; },
    ensureCodexReports: async () => ({ ready: true }),
    readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: [], reports: [] }),
    hostOptions: { nativeRequest: native.request },
    withHostLock: lock ?? (async action => { depth++; try { return await action(); } finally { depth--; } }),
  });
  return { backend, native, record, state: () => state, lockDepth: () => depth };
}

test('an ordinary supplement with a frozen pin steers without model fields', async () => {
  const f = await fixture({ omitModel: true, thread: { active: true, turns: [{ id: 'turn-a',
    status: 'inProgress', startedAt: 1, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: 'first task' }] }] }] } });
  const result = await f.backend.deliver({ requestId: 'r2', message: 'ordinary supplement',
    kind: 'supplement', mode: 'steer', selectionExplicit: false, model: selection(SOL) });
  assert.deepEqual([result.accepted, result.delivery, result.turnId], [true, 'current-turn', 'turn-a']);
  assert.equal(f.native.count('turn/steer'), 1);
  assert.equal(f.native.count('turn/start'), 0);
  const steer = f.native.paramsOf('turn/steer')[0];
  assert.equal('model' in steer, false, 'a steer must never carry model');
  assert.equal('effort' in steer, false, 'a steer must never carry effort');
  assert.equal(steer.expectedTurnId, 'turn-a');
  const stored = f.state().requests.r2;
  assert.equal(stored.intent.method, 'turn/steer');
  assert.equal(stored.intent.expectedTurnId, 'turn-a');
  assert.equal(stored.native.method, 'turn/steer');
});

test('explicit same selection is proven from the turn start, not from a name pin', async () => {
  const f = await fixture({ omitModel: true, thread: { active: true, turns: [{ id: 'turn-a',
    status: 'inProgress', startedAt: 1, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: `first task\n\n${markerLine('r1', 'n')}` }] }] }] },
    saved: { binding: { sessionId: 'native-1', owned: true }, requests: { r1: requestState() },
      projections: {}, nonce: 'n' } });
  const root = await f.backend.rootTurn();
  assert.deepEqual([root.running, root.turnId, root.selectionSource], [true, 'turn-a', 'turn-start']);
  assert.deepEqual(root.selection, { provider: 'openai', model: SOL.id, reasoningEffort: 'max' },
    'selection is the caller catalog id, never the wire slug');
  assert.deepEqual(root.wireSelection, { model: SOL.model, reasoningEffort: 'max' },
    'wireSelection is the actual native evidence');
  const same = await f.backend.matchRootSelection({ selection: selection(SOL) });
  assert.deepEqual([same.status, same.resolved.model, same.actual.model],
    ['same', SOL.model, SOL.model], 'the catalog id is resolved to the wire slug before comparison');
  const different = await f.backend.matchRootSelection({ selection: selection(LUNA) });
  assert.equal(different.status, 'different');
  const result = await f.backend.deliver({ requestId: 'r2', message: 'same selection',
    mode: 'steer', selectionExplicit: true, model: selection(SOL) });
  assert.equal(result.accepted, true);
  assert.equal(f.native.paramsOf('turn/steer')[0].model, undefined);

  // Native metadata alone can prove only the wire side: `selection` must stay
  // absent, and the comparison API still resolves the catalog pin before comparing.
  const visible = await fixture({ thread: { active: true, model: SOL.model, effort: 'max',
    turns: [{ id: 'turn-a', status: 'inProgress', startedAt: 1,
      items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'first task' }] }] }] },
    saved: { binding: { sessionId: 'native-1', owned: true }, requests: {}, projections: {}, nonce: 'n' } });
  const threadRoot = await visible.backend.rootTurn();
  assert.equal(threadRoot.selection, undefined);
  assert.deepEqual(threadRoot.wireSelection, { model: SOL.model, reasoningEffort: 'max' });
  const threadMatch = await visible.backend.matchRootSelection({ selection: selection(SOL) });
  assert.deepEqual([threadMatch.status, threadMatch.source], ['same', 'thread-metadata']);
});

test('Codex compares only explicit fields on active A and uses the frozen effort to start B', async () => {
  const high = { ...selection(SOL), reasoningEffort: 'high' };
  const f = await fixture({ omitModel: true,
    thread: { active: true, turns: [{ id: 'turn-a', status: 'inProgress', startedAt: 1,
      items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: markerLine('r1', 'n') }] }] }] },
    saved: { binding: { sessionId: 'native-1', owned: true }, projections: {}, nonce: 'n',
      requests: { r1: requestState({ model: high, delivery: { model: SOL.model, effort: 'high' } }) } } });
  const startSelection = selection(SOL); // The default changed to max after A started.
  const modelOnly = { model: true, effort: false };
  const effortOnly = { model: false, effort: true };
  assert.equal((await f.backend.matchRootSelection({ selection: startSelection, explicitFields: modelOnly })).status, 'same');
  for (const [requestId, explicitFields, model] of [
    ['model-only', modelOnly, startSelection], ['match-effort', effortOnly, high],
    ['plain', { model: false, effort: false }, startSelection], ['answer', { model: false, effort: false }, startSelection],
  ]) {
    const receipt = await f.backend.deliver({ requestId, message: requestId, mode: 'steer',
      kind: requestId === 'answer' ? 'answer' : 'supplement',
      model, explicitFields, selectionExplicit: explicitFields.model || explicitFields.effort });
    assert.deepEqual([receipt.turnId, receipt.actualEffort], ['turn-a', 'high']);
  }
  for (const mode of ['steer', 'queue']) {
    await assert.rejects(f.backend.deliver({ requestId: 'change-' + mode, message: 'change effort',
      mode, selectionExplicit: true, explicitFields: effortOnly, model: startSelection }),
    { code: 'codex-model-change-while-running' });
  }
  const thread = f.native.threads.get('native-1');
  thread.active = false;
  thread.turns[0].status = 'completed';
  const receipt = await f.backend.deliver({ requestId: 'answer-b', message: 'answer after A',
    kind: 'answer', mode: 'steer', selectionExplicit: false, explicitFields: { model: false, effort: false },
    model: startSelection });
  assert.deepEqual([receipt.delivery, receipt.actualEffort], ['new-turn', 'max']);
  assert.equal(f.native.paramsOf('turn/start')[0].effort, 'max');
  assert.equal((await f.backend.receipt({ requestId: 'answer-b' })).actualEffort, 'max');
  assert.equal(f.native.count('turn/start'), 1);
});

test('explicit different and unprovable selections never write', async () => {
  const activeTurn = { active: true, turns: [{ id: 'turn-a', status: 'inProgress', startedAt: 1,
    items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'first task' }] }] }] };
  const different = await fixture({ omitModel: true, thread: activeTurn,
    saved: { binding: { sessionId: 'native-1', owned: true }, requests: { r1: requestState() },
      projections: {}, nonce: 'n' } });
  await assert.rejects(different.backend.deliver({ requestId: 'r2', message: 'change',
    mode: 'steer', selectionExplicit: true, model: selection(LUNA) }),
  { code: 'codex-model-change-while-running', terminal: true });
  assert.equal(different.native.count('turn/steer'), 0);

  const unproven = await fixture({ omitModel: true, thread: activeTurn,
    saved: { binding: { sessionId: 'native-1', owned: true }, requests: {}, projections: {}, nonce: 'n' } });
  await assert.rejects(unproven.backend.deliver({ requestId: 'r2', message: 'unknown selection',
    mode: 'steer', selectionExplicit: true, model: selection(SOL) }),
  { code: 'codex-model-selection-unconfirmed', terminal: true });
  assert.equal(unproven.native.count('turn/steer'), 0);
});

test('legacy undefined selection verifies the old frozen selection or refuses unproven', async () => {
  const activeTurn = { active: true, turns: [{ id: 'turn-a', status: 'inProgress', startedAt: 1,
    items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'first task' }] }] }] };
  const saved = { binding: { sessionId: 'native-1', owned: true }, requests: { r1: requestState() },
    projections: {}, nonce: 'n' };
  const same = await fixture({ omitModel: true, thread: activeTurn, saved });
  const result = await same.backend.deliver({ requestId: 'r2', message: 'legacy frozen',
    mode: 'steer', model: selection(SOL) });
  assert.equal(result.accepted, true);
  assert.equal(same.native.paramsOf('turn/steer')[0].model, undefined);

  const different = await fixture({ omitModel: true, thread: activeTurn, saved });
  await assert.rejects(different.backend.deliver({ requestId: 'r2', message: 'legacy different',
    mode: 'steer', model: selection(LUNA) }), { code: 'codex-model-change-while-running' });

  const unproven = await fixture({ omitModel: true, thread: activeTurn,
    saved: { binding: { sessionId: 'native-1', owned: true }, requests: {}, projections: {}, nonce: 'n' } });
  await assert.rejects(unproven.backend.deliver({ requestId: 'r2', message: 'legacy unknown',
    mode: 'steer', model: selection(SOL) }), { code: 'codex-model-selection-unconfirmed' });

  const inherit = await fixture({ omitModel: true, thread: activeTurn,
    saved: { binding: { sessionId: 'native-1', owned: true }, requests: {}, projections: {}, nonce: 'n' } });
  assert.equal((await inherit.backend.deliver({ requestId: 'r2', message: 'inherit' })).accepted, true);
});

test('queue waits behind the active root and then opens exactly one new turn', async () => {
  const f = await fixture({ omitModel: true, thread: { active: true, turns: [{ id: 'turn-a',
    status: 'inProgress', startedAt: 1, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: 'first task' }] }] }] } });
  const waiting = await f.backend.deliver({ requestId: 'q1', message: 'queued input',
    mode: 'queue', selectionExplicit: false, model: selection(SOL) });
  assert.deepEqual([waiting.accepted, waiting.delivery, waiting.afterTurnId],
    [false, 'after-current', 'turn-a']);
  assert.equal(f.native.count('turn/steer'), 0);
  assert.equal(f.native.count('turn/start'), 0);
  assert.equal((await f.backend.deliver({ requestId: 'q1', message: 'queued input',
    mode: 'queue', selectionExplicit: false, model: selection(SOL) })).afterTurnId, 'turn-a');
  assert.equal(f.native.count('turn/start'), 0, 'a repeat while active still writes nothing');

  f.native.threads.get('native-1').turns[0].status = 'completed';
  f.native.threads.get('native-1').active = false;
  const started = await f.backend.deliver({ requestId: 'q1', message: 'queued input',
    mode: 'queue', selectionExplicit: false, model: selection(SOL) });
  assert.deepEqual([started.accepted, started.delivery], [true, 'new-turn']);
  assert.notEqual(started.turnId, 'turn-a');
  assert.equal(f.native.count('turn/start'), 1);
  assert.equal(f.native.count('turn/steer'), 0);
  const start = f.native.paramsOf('turn/start')[0];
  assert.equal(start.model, SOL.model, 'the queued frozen selection starts the new turn');
  assert.equal(start.effort, 'max');
});

test('rootTurn ignores a running child and a queue start is independent of the tree', async () => {
  const f = await fixture({ thread: { active: false, turns: [] } });
  f.native.add({ id: 'child-1', active: true, turns: [{ id: 'child-turn', status: 'inProgress',
    startedAt: 2, items: [] }] });
  f.native.child('native-1', 'child-1');
  const before = f.native.count('thread/list');
  const root = await f.backend.rootTurn();
  assert.equal(root.running, false);
  assert.equal(f.native.count('thread/list'), before, 'rootTurn never enumerates descendants');
  assert.equal((await f.backend.deliver({ requestId: 'q1', message: 'root input',
    mode: 'queue' })).delivery, 'new-turn');
  assert.equal(f.native.count('turn/start'), 1);
  assert.equal((await f.backend.observe()).tree.running, true, 'the tree itself still sees the child');
});

test('the intended method and target are persisted inside the host lock before the RPC', async () => {
  let f;
  const activeTurn = { active: true, turns: [{ id: 'turn-a', status: 'inProgress', startedAt: 1,
    items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'first task' }] }] }] };
  f = await fixture({ omitModel: true, thread: activeTurn,
    saved: { binding: { sessionId: 'native-1', owned: true }, requests: {}, projections: {}, nonce: 'n' } });
  f.native.hooks.beforeSteer = () => {
    assert.ok(f.lockDepth() > 0, 'the host write lock is held');
    assert.equal(f.state().requests.r2.intent.method, 'turn/steer');
    assert.equal(f.state().requests.r2.intent.expectedTurnId, 'turn-a');
    assert.equal(f.state().requests.r2.status, 'unknown');
  };
  await f.backend.deliver({ requestId: 'r2', message: 'steer under lock', mode: 'steer' });

  const idle = await fixture({ thread: { active: false, turns: [] } });
  idle.native.hooks.beforeStart = () => {
    assert.ok(idle.lockDepth() > 0, 'the host write lock is held');
    assert.equal(idle.state().requests.r2.intent.method, 'turn/start');
    assert.equal(idle.state().requests.r2.intent.priorTurnId, null);
  };
  await idle.backend.deliver({ requestId: 'r2', message: 'start under lock', mode: 'queue' });
});

test('a lost steer reply is recovered from the exact marker without a second write', async () => {
  const f = await fixture({ omitModel: true, thread: { active: true, turns: [{ id: 'turn-a',
    status: 'inProgress', startedAt: 1, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: 'first task' }] }] }] } });
  const original = f.native.request;
  let lose = true;
  const nativeRequest = async (method, params, options) => {
    const result = await original(method, params, options);
    if (method === 'turn/steer' && lose) { lose = false; throw new Error('response lost'); }
    return result;
  };
  const record = f.record;
  let state = f.state();
  const lost = await createCodexBackend(record, {
    load: () => record, readNativeState: () => structuredClone(state),
    writeNativeState: value => { state = structuredClone(value); return true; },
    ensureCodexReports: async () => ({ ready: true }), readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: [], reports: [] }),
    hostOptions: { nativeRequest },
  });
  await assert.rejects(lost.deliver({ requestId: 'r2', message: 'lost steer', mode: 'steer' }),
    error => error.uncertain === true);
  assert.equal(f.native.count('turn/steer'), 1);
  const recovered = await createCodexBackend(record, {
    load: () => record, readNativeState: () => structuredClone(state),
    writeNativeState: value => { state = structuredClone(value); return true; },
    ensureCodexReports: async () => ({ ready: true }), readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: [], reports: [] }),
    hostOptions: { nativeRequest: f.native.request },
  });
  const receipt = await recovered.receipt({ requestId: 'r2' });
  assert.deepEqual([receipt.status, receipt.delivery, receipt.turnId], ['accepted', 'current-turn', 'turn-a']);
  assert.equal(f.native.count('turn/steer'), 1, 'recovery never replays the write');
});

test('a lost start reply recovers a new turn only when the marker is its first user input', async () => {
  const f = await fixture({ thread: { active: false, turns: [] } });
  const original = f.native.request;
  let lose = true;
  const nativeRequest = async (method, params, options) => {
    const result = await original(method, params, options);
    if (method === 'turn/start' && lose) { lose = false; throw new Error('response lost'); }
    return result;
  };
  let state = f.state();
  const lost = await createCodexBackend(f.record, {
    load: () => f.record, readNativeState: () => structuredClone(state),
    writeNativeState: value => { state = structuredClone(value); return true; },
    ensureCodexReports: async () => ({ ready: true }), readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: [], reports: [] }),
    hostOptions: { nativeRequest },
  });
  await assert.rejects(lost.deliver({ requestId: 'r2', message: 'lost start' }),
    error => error.uncertain === true);
  const started = f.native.paramsOf('turn/start').length;
  assert.equal(started, 1);
  const recovered = await createCodexBackend(f.record, {
    load: () => f.record, readNativeState: () => structuredClone(state),
    writeNativeState: value => { state = structuredClone(value); return true; },
    ensureCodexReports: async () => ({ ready: true }), readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: [], reports: [] }),
    hostOptions: { nativeRequest: f.native.request },
  });
  const receipt = await recovered.receipt({ requestId: 'r2' });
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.delivery, 'new-turn');
  assert.equal(receipt.turnId, f.native.threads.get('native-1').turns[0].id);
  assert.equal(f.native.count('turn/start'), 1, 'recovery never replays the write');
});

test('a marker that is not the first user input cannot be claimed as a new turn', async () => {
  const marker = markerLine('r2', 'n');
  const f = await fixture({ thread: { active: true, turns: [{ id: 'turn-a', status: 'inProgress',
    startedAt: 1, items: [
      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'first task' }] },
      { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: `steered\n\n${marker}` }] },
    ] }] } });
  const state = f.state();
  state.requests.r2 = { requestId: 'r2', marker, messageHash: 'hash', status: 'unknown',
    attempted: true, afterSeq: 0, mode: 'steer', intent: { method: 'turn/start',
      threadId: 'native-1', priorTurnId: 'turn-a', at: new Date().toISOString() } };
  const receipt = await f.backend.receipt({ requestId: 'r2' });
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.delivery, 'accepted-route-unknown');
  assert.equal(receipt.turnId, undefined);
});

test('a steer rejection after the turn ended returns a definite reschedule receipt', async () => {
  const f = await fixture({ omitModel: true, thread: { active: true, turns: [{ id: 'turn-a',
    status: 'inProgress', startedAt: 1, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: 'first task' }] }] }] } });
  f.native.hooks.rejectSteer = () => true;
  const result = await f.backend.deliver({ requestId: 'r2', message: 'raced steer', mode: 'steer' });
  assert.deepEqual([result.accepted, result.status, result.delivery, result.reschedule.notSent],
    [false, 'retryable', 'local-pending', true]);
  assert.equal(f.native.count('turn/steer'), 1);
  assert.equal(f.native.count('turn/start'), 0, 'the scheduler, not the rejected write, decides the next turn');
  assert.equal(f.state().requests.r2.attempted, false);
});

test('a steer that carried an inherited pin is not evidence of how the turn started', async () => {
  const thread = { active: true, turns: [{ id: 'turn-a', status: 'inProgress', startedAt: 1,
    items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'first task' }] }] }] };
  const steerRow = requestState({ requestId: 's1', marker: markerLine('s1', 'n'), kind: 'supplement',
    route: 'current-turn', native: { method: 'turn/steer', turnId: 'turn-a' } });
  const f = await fixture({ omitModel: true, thread,
    saved: { binding: { sessionId: 'native-1', owned: true }, requests: { s1: steerRow }, projections: {}, nonce: 'n' } });
  assert.equal((await f.backend.rootTurn()).selection, undefined,
    'a steer row with an inherited pin cannot supply the turn start selection');
  await assert.rejects(f.backend.deliver({ requestId: 'r2', message: 'explicit same pin',
    mode: 'steer', selectionExplicit: true, model: selection(SOL) }),
  { code: 'codex-model-selection-unconfirmed', terminal: true });
  assert.equal(f.native.count('turn/steer'), 0);

  const visible = await fixture({ thread: { ...thread, model: LUNA.model, effort: 'high' },
    saved: { binding: { sessionId: 'native-1', owned: true }, requests: { s1: steerRow }, projections: {}, nonce: 'n' } });
  await assert.rejects(visible.backend.deliver({ requestId: 'r2', message: 'explicit wrong pin',
    mode: 'steer', selectionExplicit: true, model: selection(SOL) }),
  { code: 'codex-model-change-while-running', terminal: true });
  assert.equal(visible.native.count('turn/steer'), 0);
});

test('observe never turns a body reference into acceptance for an unknown write', async () => {
  const marker = markerLine('r2', 'n');
  const f = await fixture({ thread: { active: false, turns: [{ id: 'turn-a', status: 'completed',
    startedAt: 1, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: `please check ${marker}\nnot the last line` }] }] }] } });
  const state = f.state();
  state.requests.r2 = { requestId: 'r2', marker, messageHash: 'hash', status: 'unknown',
    attempted: true, afterSeq: 0, mode: 'steer', intent: { method: 'turn/start',
      threadId: 'native-1', priorTurnId: null, at: new Date().toISOString() } };
  await f.backend.observe();
  assert.equal(f.state().requests.r2.status, 'unknown', 'a body reference is not acceptance');
  const receipt = await f.backend.receipt({ requestId: 'r2' });
  assert.equal(receipt.status, 'unknown');
  assert.equal(f.native.count('turn/start'), 0);
});

test('observe can strengthen an accepted-route-unknown from a later first-user proof', async () => {
  const marker = markerLine('r2', 'n');
  const f = await fixture({ thread: { active: false, turns: [{ id: 'turn-b', status: 'completed',
    startedAt: 2, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: `new turn\n\n${marker}` }] }] }] } });
  const state = f.state();
  state.requests.r2 = { requestId: 'r2', marker, messageHash: 'hash', status: 'accepted',
    attempted: true, afterSeq: 0, mode: 'steer', route: 'accepted-route-unknown',
    native: { method: 'turn/start', priorTurnId: null, at: new Date().toISOString() } };
  await f.backend.observe();
  assert.equal(f.state().requests.r2.route, 'new-turn');
  assert.equal(f.state().requests.r2.turnId, 'turn-b');
  const receipt = await f.backend.receipt({ requestId: 'r2' });
  assert.deepEqual([receipt.status, receipt.delivery, receipt.turnId], ['accepted', 'new-turn', 'turn-b']);
});

test('a read timeout before any write is local-pending and the same request retries', async () => {
  const f = await fixture({ thread: { active: false, turns: [] } });
  let first = true;
  f.native.hooks.failRead = () => {
    if (!first) return false;
    first = false;
    return true;
  };
  await assert.rejects(f.backend.deliver({ requestId: 'r2', message: 'read gap' }),
    { code: 'codex-native-rpc-response-timeout', retryableRead: true });
  const pending = await f.backend.receipt({ requestId: 'r2' });
  assert.deepEqual([pending.status, f.state().requests.r2.attempted], ['retryable', false]);
  assert.equal(f.native.count('turn/start'), 0);
  const result = await f.backend.deliver({ requestId: 'r2', message: 'read gap' });
  assert.equal(result.accepted, true);
  assert.equal(f.native.count('turn/start'), 1);
});

test('A ending between the root thread read and its turn page is retryable, then Q opens B and S joins once', async () => {
  const f = await fixture({ omitModel: true, thread: { active: true, turns: [{ id: 'turn-a',
    status: 'inProgress', startedAt: 1, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: 'first task' }] }] }] } });
  const q = await f.backend.deliver({ requestId: 'q1', message: 'older Q', mode: 'queue',
    selectionExplicit: false, model: selection(SOL) });
  assert.deepEqual([q.accepted, q.delivery, q.afterTurnId], [false, 'after-current', 'turn-a']);

  // The race: thread/read returns `active` while A is still running, then A ends
  // before turns/list is read. The turn page is already idle while the thread
  // metadata the adapter holds is stale.
  let ended = false;
  f.native.hooks.beforeTurnsList = () => {
    if (ended) return;
    ended = true;
    const thread = f.native.threads.get('native-1');
    thread.active = false;
    thread.turns[0].status = 'completed';
  };
  await assert.rejects(f.backend.deliver({ requestId: 's1', message: 'later S', allowStart: false }),
    { code: 'codex-root-turn-unconfirmed', retryableRead: true });
  const pending = f.state().requests.s1;
  assert.deepEqual([pending.status, pending.attempted, pending.intent], ['retryable', false, undefined]);
  assert.equal(f.native.count('turn/steer'), 0);
  assert.equal(f.native.count('turn/start'), 0, 'the read gap never wrote');
  assert.equal((await f.backend.receipt({ requestId: 's1' })).status, 'retryable');

  // The same request id retries once the root is readable. Q is still the FIFO head,
  // so S must not open the next turn itself.
  const held = await f.backend.deliver({ requestId: 's1', message: 'later S', allowStart: false });
  assert.deepEqual([held.accepted, held.status, held.delivery], [false, 'retryable', 'local-pending']);
  assert.equal(f.native.count('turn/start'), 0);

  const started = await f.backend.deliver({ requestId: 'q1', message: 'older Q', mode: 'queue',
    selectionExplicit: false, model: selection(SOL) });
  assert.deepEqual([started.accepted, started.delivery], [true, 'new-turn']);
  assert.notEqual(started.turnId, 'turn-a');

  const sent = await f.backend.deliver({ requestId: 's1', message: 'later S', allowStart: false });
  assert.deepEqual([sent.accepted, sent.delivery, sent.turnId],
    [true, 'current-turn', started.turnId]);
  const texts = f.native.threads.get('native-1').turns.flatMap(turn => turn.items)
    .map(item => item.content[0].text);
  assert.equal(texts.filter(text => text.startsWith('later S')).length, 1, 'S arrives exactly once');
  assert.ok(texts.findIndex(text => text.startsWith('older Q'))
    < texts.findIndex(text => text.startsWith('later S')), 'Q opens B before S joins it');
  assert.equal(f.native.count('turn/start'), 1);
  assert.equal(f.native.count('turn/steer'), 1);
});

test('observe never upgrades a planned start whose marker is the prior turn first input', async () => {
  const marker = markerLine('r2', 'n');
  const f = await fixture({ omitModel: true, thread: { active: true, turns: [{ id: 'turn-a',
    status: 'inProgress', startedAt: 1, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: `prior task\n\n${marker}` }] }] }] } });
  const state = f.state();
  state.requests.r2 = { requestId: 'r2', marker, messageHash: 'hash', status: 'accepted',
    attempted: true, afterSeq: 0, mode: 'steer', route: 'accepted-route-unknown',
    model: { provider: 'openai', model: SOL.id, reasoningEffort: 'max' },
    delivery: { model: SOL.model, effort: 'max' },
    intent: { method: 'turn/start', threadId: 'native-1', priorTurnId: 'turn-a' } };
  await f.backend.observe();
  await f.backend.observe();
  assert.equal(f.state().requests.r2.route, 'accepted-route-unknown');
  assert.equal((await f.backend.rootTurn()).selection, undefined,
    'a planned start is not evidence that this turn was started');
});

test('observe never upgrades a steer whose marker is in another turn second input', async () => {
  const marker = markerLine('r2', 'n');
  const f = await fixture({ omitModel: true, thread: { active: true, turns: [{ id: 'turn-b',
    status: 'inProgress', startedAt: 2, items: [
      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'turn b first' }] },
      { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: `steered\n\n${marker}` }] },
    ] }] } });
  const state = f.state();
  state.requests.r2 = { requestId: 'r2', marker, messageHash: 'hash', status: 'accepted',
    attempted: true, afterSeq: 0, mode: 'steer', route: 'accepted-route-unknown',
    intent: { method: 'turn/steer', threadId: 'native-1', expectedTurnId: 'turn-a' } };
  await f.backend.observe();
  await f.backend.observe();
  assert.equal(f.state().requests.r2.route, 'accepted-route-unknown');
});

test('allowStart:false may steer an active root but never starts a new turn', async () => {
  const active = await fixture({ omitModel: true, thread: { active: true, turns: [{ id: 'turn-a',
    status: 'inProgress', startedAt: 1, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: 'first task' }] }] }] } });
  const steered = await active.backend.deliver({ requestId: 's1', message: 'join active',
    mode: 'steer', selectionExplicit: false, model: selection(SOL), allowStart: false });
  assert.deepEqual([steered.accepted, steered.delivery, steered.turnId],
    [true, 'current-turn', 'turn-a']);
  assert.equal(active.native.count('turn/steer'), 1);

  const idle = await fixture({ thread: { active: false, turns: [] } });
  const held = await idle.backend.deliver({ requestId: 's2', message: 'behind old queue',
    mode: 'steer', allowStart: false });
  assert.deepEqual([held.accepted, held.status, held.delivery], [false, 'retryable', 'local-pending']);
  assert.deepEqual([held.reschedule.notSent, held.reschedule.reason], [true, 'queue-head-pending']);
  assert.equal(idle.native.count('turn/start'), 0, 'the FIFO head keeps the right to start');
  assert.equal(idle.native.count('turn/steer'), 0);

  const queued = await idle.backend.deliver({ requestId: 'q1', message: 'queued but not head',
    mode: 'queue', allowStart: false });
  assert.deepEqual([queued.accepted, queued.delivery], [false, 'local-pending']);
  assert.equal(idle.native.count('turn/start'), 0);
});

test('a legacy unknown without intent accepts only the exact marker as route-unknown', async () => {
  const marker = markerLine('old', 'n');
  const f = await fixture({ thread: { active: false, turns: [{ id: 'turn-a', status: 'completed',
    startedAt: 1, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: `old task\n\n${marker}` }] }] }] } });
  const state = f.state();
  state.requests.old = { requestId: 'old', marker,
    messageHash: createHash('sha256').update('old task').digest('hex'), status: 'unknown',
    attempted: true, afterSeq: 0 };
  const receipt = await f.backend.receipt({ requestId: 'old' });
  assert.deepEqual([receipt.status, receipt.delivery, receipt.turnId],
    ['accepted', 'accepted-route-unknown', 'turn-a']);
  assert.equal(receipt.native.method, null, 'a legacy receipt never reverse-infers the method');
  assert.equal(f.native.count('turn/start'), 0);
  assert.equal(f.native.count('turn/steer'), 0);
  assert.equal((await f.backend.deliver({ requestId: 'old', message: 'old task' })).accepted, true);
  assert.equal(f.native.count('turn/start'), 0, 'the accepted legacy item is not replayed');
});

test('a turn/start race rejection waits behind the turn that won, then starts once', async () => {
  const f = await fixture({ thread: { active: false, turns: [] } });
  f.native.hooks.raceStart = () => true;
  const raced = await f.backend.deliver({ requestId: 'q1', message: 'queue race', mode: 'queue' });
  assert.deepEqual([raced.accepted, raced.status, raced.delivery, raced.afterTurnId],
    [false, 'waiting', 'after-current', 'turn-a']);
  assert.equal(raced.reschedule.notSent, true);
  assert.equal(f.native.count('turn/steer'), 0);

  f.native.hooks.raceStart = () => false;
  const thread = f.native.threads.get('native-1');
  thread.turns[0].status = 'completed'; thread.active = false;
  const started = await f.backend.deliver({ requestId: 'q1', message: 'queue race', mode: 'queue' });
  assert.deepEqual([started.accepted, started.delivery], [true, 'new-turn']);
  assert.notEqual(started.turnId, 'turn-a');
  assert.equal(thread.turns.filter(turn => turn.status === 'inProgress').length, 1);
});

test('a historical task row without a recorded method still proves the turn start', async () => {
  const marker = markerLine('r1', 'n');
  const f = await fixture({ omitModel: true, thread: { active: true, turns: [{ id: 'turn-a',
    status: 'inProgress', startedAt: 1, items: [{ id: 'u1', type: 'userMessage',
      content: [{ type: 'text', text: `first task\n\n${marker}` }] }] }] },
    saved: { binding: { sessionId: 'native-1', owned: true },
      requests: { r1: requestState({ route: undefined, native: undefined }) }, projections: {}, nonce: 'n' } });
  const root = await f.backend.rootTurn();
  assert.deepEqual(root.selection, { provider: 'openai', model: SOL.id, reasoningEffort: 'max' });
  assert.deepEqual(root.wireSelection, { model: SOL.model, reasoningEffort: 'max' });
});
