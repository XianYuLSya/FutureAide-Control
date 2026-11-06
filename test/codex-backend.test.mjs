import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { createCodexHost, emptyProjection, projectCodexTurns } from '../src/codex-host.mjs';
import { liveThread } from './live-thread-fixture.mjs';

async function setup() {
  let saved, nativeId = 'native-1', model = 'model-a', reportData = { questions: [], reports: [] };
  const record = { name: 'helper', agentId: 'a', sessionId: 'logical', workspace: 'D:/work/project', task: { taskId: 'task-1' } };
  let projection = emptyProjection(), turnSequence = 0;
  const turns = [], counts = { create: 0, send: 0, cancel: 0, destroy: 0, resolve: 0 }, inputs = [];
  const titleCalls = [];
  let titleFailures = 0;
  const wire = { 'model-a': 'wire-a', 'model-b': 'wire-b', 'model-c': 'wire-c' };
  const selection = () => ({ provider: 'openai', model, reasoningEffort: 'high' });
  const catalog = () => ({
    default: { provider: 'openai', model: 'model-a', reasoningEffort: 'high' },
    routableProviders: ['openai'],
    groups: [{ id: 'openai', models: ['model-a', 'model-b', 'model-c'].map(id => ({
      id, model: wire[id], name: id,
      reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }], defaultEffort: 'high' },
    })) }],
  });
  function appendTurn(message, status = 'inProgress') {
    const turn = { id: `t-${++turnSequence}`, status, startedAt: turnSequence,
      items: [{ id: `u-${turnSequence}`, type: 'userMessage', content: [{ type: 'text', text: message }] }] };
    turns.push(turn);
    projection = projectCodexTurns(projection, turns, saved?.requests ?? {});
    return turn.id;
  }
  const hooks = {
    create: async input => {
      counts.create++; inputs.push(input); nativeId = 'native-1';
      const turnId = appendTurn(input.message);
      return { nativeSessionId: nativeId, created: true, turnId };
    },
    resolve: async ({ selection: wanted }) => {
      counts.resolve++;
      const entry = catalog().groups[0].models.find(item => item.id === wanted.model);
      if (!entry) throw Object.assign(new Error('model not found'), { code: 'model-not-found', terminal: true });
      return { modelId: entry.id, model: entry.model, ...(wanted.reasoningEffort ? { effort: wanted.reasoningEffort } : {}) };
    },
  };
  const host = {
    probe: async () => ({ identity: { application: 'codex-desktop' }, missing: [] }),
    // A deployment default that cannot be resolved must not block beginTask or
    // an explicitly selected first turn.
    readDefaultModel: async () => { throw Object.assign(new Error('model and effort are implicit'),
      { code: 'codex-default-model-unresolved' }); },
    models: async () => catalog(),
    resolveModelDelivery: input => hooks.resolve(input),
    readCurrentModel: async () => ({ provider: 'openai', model: wire[model] ?? model, reasoningEffort: 'high' }),
    createFirstTurn: input => hooks.create(input),
    send: async input => { counts.send++; inputs.push(input); const turnId = appendTurn(input.message); return { sent: true, turnId }; },
    send: async input => { counts.send++; inputs.push(input); const turnId = appendTurn(input.message); return { sent: true, turnId }; },
    setTitle: async input => { titleCalls.push(input); if (titleFailures > 0) { titleFailures--; throw new Error('rollout is empty'); } return { renamed: true }; },
    findCreatedSession: async () => nativeId ? { nativeSessionId: nativeId } : undefined,
    observe: async () => ({ projections: { [nativeId]: structuredClone(projection) },
      histories: { [nativeId]: { messages: projection.messages, hasMore: false } },
      tree: { running: projection.running, settled: !projection.running,
        nodes: [{ sessionId: nativeId, parentSessionId: null, status: projection.running ? 'running' : 'idle', changes: projection.changes }] } }),
    interrupt: async () => { counts.cancel++; return { interrupted: true }; },
    destroy: async () => { counts.destroy++; return { destroyed: false }; },
  };
  const deps = { load: () => record, readNativeState: () => saved && structuredClone(saved),
    writeNativeState: value => { saved = structuredClone(value); return true; },
    ensureCodexReports: async () => ({ ready: true }), readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => reportData, host };
  return { adapter: await createCodexBackend(record, deps), deps, record, host, hooks, counts, inputs, turns, titleCalls,
    state: () => saved, setModel: value => { model = value; }, setReports: value => { reportData = value; },
    failTitle: value => { titleFailures = value; },
    currentProjection: () => projection,
    complete: () => { const last = turns.at(-1); if (last) last.status = 'completed'; projection = projectCodexTurns(projection, turns, saved?.requests ?? {}); } };
}

test('zero-model reservation, first fresh thread, persistent follow-up and native inheritance', async () => {
  const f = await setup();
  assert.equal((await f.adapter.probe()).reportProtocol, 1);
  assert.equal((await f.adapter.create()).modelRequestsStarted, 0);
  assert.equal(f.counts.create, 0);
  await f.adapter.beginTask();
  assert.equal((await f.adapter.deliver({ requestId: 'r1', message: 'first' })).accepted, true);
  f.complete(); f.record.task.taskId = 'task-2';
  await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'r2', message: 'followup' });
  assert.equal(f.counts.create, 1); assert.equal(f.counts.send, 1);
  assert.equal('model' in f.state().requests.r2, false, 'a name without a pin stores no model selection');
  assert.equal(f.state().requests.r2.explicitModel, false);
  assert.equal(f.state().binding.sessionId, 'native-1');
  assert.ok(f.inputs[1].message.startsWith('followup'));
  assert.match(f.inputs[1].message, /\[FutureAide dispatch .*\]$/m, 'later messages also keep the marker last');
  assert.equal('model' in f.inputs[0], false, 'no model reaches the native create');
  assert.equal('effort' in f.inputs[0], false, 'no effort reaches the native create');
  assert.equal('model' in f.inputs[1], false, 'no model reaches the native send');
  assert.equal('effort' in f.inputs[1], false, 'no effort reaches the native send');
});

test('a direct adapter call uses the passed dispatch model without roster history', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'r', message: 'work', explicitModel: true,
    model: { provider: 'openai', model: 'model-c', reasoningEffort: 'high' } });
  assert.equal(f.inputs[0].model, 'wire-c');
  assert.equal(f.inputs[0].effort, 'high');
  assert.equal(f.state().requests.r.model.model, 'model-c');
});

test('a legacy 0.5.13 request that stored a model without the flag inherits instead of sending it', async () => {
  const f = await setup();
  f.deps.writeNativeState({ requests: { r: {
    requestId: 'r', messageHash: createHash('sha256').update('work').digest('hex'),
    marker: 'legacy-marker', status: 'retryable', attempted: false, afterSeq: 0,
    model: { provider: 'openai', model: 'model-a', reasoningEffort: 'high' },
  } }, projections: {} });
  await f.adapter.create(); await f.adapter.beginTask();
  assert.equal((await f.adapter.deliver({ requestId: 'r', message: 'work' })).accepted, true);
  assert.equal('model' in f.inputs[0], false, 'the historical display value must not select the turn');
  assert.equal(f.state().requests.r.explicitModel, false);
  assert.equal('model' in f.state().requests.r, false);
});

test('an unresolvable explicit model fails before any native thread is created', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  await assert.rejects(f.adapter.deliver({ requestId: 'r', message: 'work', explicitModel: true,
    model: { provider: 'openai', model: 'missing', reasoningEffort: 'high' } }),
  error => error.code === 'model-not-found' && error.terminal === true && error.retryableRead !== true);
  assert.equal(f.counts.create, 0);
  assert.equal(f.counts.resolve, 1);
});

test('a native turn id confirms acceptance before the transcript page catches up', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  const adapter = await createCodexBackend(f.record, { ...f.deps, host: { ...f.deps.host,
    observe: async () => ({ projections: {}, histories: {}, tree: { nodes: [], running: false, settled: true } }) } });
  const result = await adapter.deliver({ requestId: 'r', message: 'work' });
  assert.equal(result.accepted, true);
  assert.equal(f.state().requests.r.status, 'accepted');
});

test('a pre-send missing debug port stays retryable instead of unknown', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  const lost = await createCodexBackend(f.record, { ...f.deps,
    host: { ...f.deps.host, createFirstTurn: async () => {
      throw Object.assign(new Error('Open Codex from FAswitch, then retry.'), { code: 'codex-native-rpc-unavailable' });
    } } });
  await assert.rejects(lost.deliver({ requestId: 'r', message: 'work' }), { retryableRead: true });
  assert.equal(f.state().requests.r.status, 'retryable');
  assert.equal(f.state().requests.r.attempted, false);
});

test('a confirmed turn is not downgraded when the follow-up observation fails', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  const adapter = await createCodexBackend(f.record, { ...f.deps, host: { ...f.deps.host,
    observe: async () => { throw Object.assign(new Error('read failed'), { code: 'codex-native-rpc-closed' }); } } });
  const result = await adapter.deliver({ requestId: 'r', message: 'work' });
  assert.deepEqual([result.accepted, result.status], [true, 'accepted']);
  assert.equal((await adapter.receipt({ requestId: 'r' })).status, 'accepted');
});

test('unknown native send is not repeated after cold adapter reconstruction', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  const lost = await createCodexBackend(f.record, { ...f.deps,
    host: { ...f.deps.host, createFirstTurn: async () => { f.counts.create++; throw new Error('response lost'); } } });
  await assert.rejects(lost.deliver({ requestId: 'r', message: 'work' }), { uncertain: true });
  const recovered = await createCodexBackend(f.record, f.deps);
  assert.equal((await recovered.deliver({ requestId: 'r', message: 'work' })).status, 'unknown');
  assert.equal(f.counts.create, 1);
  assert.equal(await recovered.receipt({ requestId: 'unused' }), undefined);
  assert.equal((await recovered.destroy()).destroyed, false);
  await assert.rejects(recovered.deliver({ requestId: 'r', message: 'different' }), { code: 'request-id-conflict' });
});

test('explicit question/report is same-task scoped; ordinary final never reports', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'r', message: 'work' });
  f.complete();
  assert.deepEqual((await f.adapter.observe()).reports, []);
  f.setReports({ questions: [{ id: 'q', taskId: 'task-1', state: 'pending', message: 'why?' }],
    reports: [{ id: 'stale', taskId: 'old', message: 'old', final: true }, { id: 'yes', taskId: 'task-1', message: 'done', final: true }] });
  assert.deepEqual((await f.adapter.observe()).reports.map(r => r.id), ['yes']);
  assert.deepEqual((await f.adapter.answer({ answerId: 'a1', message: 'answer' })).consumedQuestionIds, ['q']);
  assert.equal((await f.adapter.observe()).questions[0].state, 'answered');
  assert.equal((await f.adapter.turn({ requestId: 'r' })).state, 'ended');
  assert.equal((await f.adapter.turn({ requestId: 'r' })).correlation, 'request-id');
  assert.equal((await f.adapter.turn({ requestId: 'r' })).turnId, f.turns[0].id);
  assert.equal((await f.adapter.destroy()).destroyed, false);
});

test('an explicit selection applies to its own task and never leaks into an unpinned one', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'r1', message: 'one',
    model: { provider: 'openai', model: 'model-b', reasoningEffort: 'high' }, explicitModel: true });
  assert.equal(f.state().requests.r1.model.model, 'model-b', 'the catalog selection is frozen on the request');
  assert.deepEqual(f.state().requests.r1.delivery, { model: 'wire-b', effort: 'high' });
  assert.equal(f.inputs[0].model, 'wire-b');
  assert.equal(f.inputs[0].effort, 'high');
  f.complete(); f.record.task.taskId = 'task-2';
  await f.adapter.beginTask(); await f.adapter.deliver({ requestId: 'r2', message: 'two' });
  assert.equal('model' in f.state().requests.r2, false);
  assert.equal('model' in f.inputs[1], false);
  assert.equal('effort' in f.inputs[1], false);
});

test('cancel is only requested for the bound native tree and probe surfaces a missing RPC', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'r', message: 'work' });
  assert.equal((await f.adapter.cancel()).cancelRequested, true);
  assert.equal(f.counts.cancel, 1);
  const missing = await createCodexBackend(f.record, { ...f.deps,
    host: { ...f.deps.host, probe: async () => { throw Object.assign(new Error('Open Codex from FAswitch, then retry.'),
      { code: 'codex-native-rpc-unavailable' }); } } });
  await assert.rejects(missing.probe(), { code: 'codex-native-rpc-unavailable' });
});

test('the first message puts the boss task first, the reminder next and the marker last', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'r1', message: 'boss task text' });
  const message = f.inputs[0].message;
  assert.ok(message.startsWith('boss task text'), 'the original task is the first line');
  assert.ok(message.indexOf('ask_parent') > message.indexOf('boss task text'));
  assert.ok(message.indexOf('report_parent(message, final=true)') > message.indexOf('ask_parent'));
  assert.match(message, /\[FutureAide dispatch .*\]$/m, 'the dispatch marker is the final line');
  const marker = message.match(/\[FutureAide dispatch .*\]$/m)[0];
  const projected = projectCodexTurns(emptyProjection(), [{ id: 'turn-1', status: 'inProgress', items: [
    { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: message }] }] }], { r1: { marker } });
  assert.equal(projected.deliveries.r1.turnId, 'turn-1', 'marker detection does not depend on the first line');
});

test('the managed title waits for a message and retries after an empty rollout', async () => {
  const f = await setup(); f.failTitle(1);
  await f.adapter.create(); await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'r1', message: 'work' });
  assert.equal(f.titleCalls.length, 1);
  assert.equal(f.state().pendingTitle.attempts, 1);
  await f.adapter.observe();
  assert.equal(f.titleCalls.length, 2);
  assert.equal(f.state().pendingTitle, undefined);
  assert.equal(f.titleCalls[1].name, 'helper');
});

test('destroy treats a thread/read not-loaded rejection as already deleted', async () => {
  const f = await setup();
  f.deps.writeNativeState({ binding: { sessionId: 'native-1', owned: true }, requests: {}, projections: {} });
  const adapter = await createCodexBackend(f.record, { ...f.deps, host: { ...f.deps.host,
    observe: async () => { throw Object.assign(new Error('thread/read: thread not loaded: native-1'),
      { code: 'codex-native-rpc-rejected', rpcMessage: 'thread/read: thread not loaded: native-1' }); } } });
  assert.deepEqual(await adapter.destroy(), { destroyed: true });
});

test('destroy of a name with no native binding is complete', async () => {
  const f = await setup();
  f.deps.writeNativeState({ requests: { r: { attempted: true, status: 'unknown',
    startedAt: new Date().toISOString(), marker: 'marker-r' } }, projections: {} });
  const adapter = await createCodexBackend(f.record, { ...f.deps, host: { ...f.deps.host,
    findCreatedSession: async () => undefined } });
  assert.deepEqual(await adapter.destroy(), { destroyed: true });
});

test('an unconfirmed first dispatch becomes terminal after the two-minute grace', async () => {
  const f = await setup();
  f.deps.writeNativeState({ requests: { r: { attempted: true, status: 'unknown',
    startedAt: new Date(Date.now() - 121000).toISOString(), marker: 'marker-r' } }, projections: {} });
  const adapter = await createCodexBackend(f.record, { ...f.deps, host: { ...f.deps.host,
    findCreatedSession: async () => undefined } });
  await assert.rejects(adapter.observe(), { code: 'codex-first-dispatch-unconfirmed', terminal: true });
});

test('selectModel refuses instead of pretending Codex changed its own picker', async () => {
  const f = await setup();
  await assert.rejects(f.adapter.selectModel({ provider: 'openai', model: 'x', reasoningEffort: 'max', requestId: 'r' }),
    { code: 'model-selection-unsupported' });
});

test('real host+ipc+backend assembly sends the native model slug for an explicit catalog id', async () => {
  const calls = [];
  let nativeTurn;
  const nativeRequest = async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/list') return { data: [] };
    if (method === 'config/read') throw Object.assign(new Error('model and effort are implicit'),
      { code: 'codex-default-model-unresolved' });
    if (method === 'model/list') return { nextCursor: null, data: [
      { id: 'preset-a', model: 'wire-a', displayName: 'A', description: 'A', hidden: false, isDefault: true,
        defaultReasoningEffort: 'high', supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Low' }, { reasoningEffort: 'high', description: 'High' }] },
      { id: 'preset-b', model: 'wire-b', displayName: 'B', description: 'B', hidden: false, isDefault: false,
        defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }] },
    ] };
    if (method === 'thread/start') return { thread: liveThread({ id: 'native-1', cwd: 'D:/work/project',
      status: { type: 'active' }, model: 'wire-a', reasoningEffort: 'high' }) };
    if (method === 'turn/start') {
      nativeTurn = { id: 't-1', status: 'inProgress', items: [{ id: 'u1', type: 'userMessage',
        content: [{ type: 'text', text: params.input[0].text }] }] };
      return { turn: nativeTurn };
    }
    if (method === 'thread/read') return { thread: liveThread({ id: 'native-1', cwd: 'D:/work/project',
      status: { type: 'active' }, model: 'wire-a', reasoningEffort: 'high' }) };
    if (method === 'thread/turns/list') return { data: nativeTurn ? [nativeTurn] : [], nextCursor: null };
    if (method === 'thread/name/set') return {};
    throw new Error('unexpected ' + method);
  };
  const record = { name: 'helper', agentId: 'a', sessionId: 'logical', workspace: 'D:/work/project', task: { taskId: 'task-1' } };
  let saved;
  const adapter = await createCodexBackend(record, {
    load: () => record, hostOptions: { nativeRequest },
    readNativeState: () => saved && structuredClone(saved),
    writeNativeState: value => { saved = structuredClone(value); return true; },
    ensureCodexReports: async () => ({ ready: true }),
    readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: [], reports: [] }),
  });
  const catalog = await adapter.models();
  assert.deepEqual(catalog.groups[0].models.map(model => [model.id, model.model]),
    [['preset-a', 'wire-a'], ['preset-b', 'wire-b']]);
  await adapter.create(); await adapter.beginTask();
  const result = await adapter.deliver({ requestId: 'r', message: 'work', explicitModel: true,
    model: { provider: 'openai', model: 'preset-a', reasoningEffort: 'high' } });
  assert.equal(result.accepted, true);
  const turnStart = calls.find(call => call[0] === 'turn/start')[1];
  assert.equal(turnStart.model, 'wire-a');
  assert.equal(turnStart.effort, 'high');
  assert.equal('model' in calls.find(call => call[0] === 'thread/start')[1], false);
  assert.equal(saved.requests.r.delivery.model, 'wire-a');
});

test('a transient catalog read on the first explicit delivery is retryable and leaves no native write', async () => {
  let catalogReads = 0, nativeTurn;
  const calls = [];
  const nativeRequest = async (method, params) => {
    calls.push([method, params]);
    if (method === 'model/list') {
      catalogReads++;
      if (catalogReads === 1) throw Object.assign(new Error('Native Desktop response timed out.'),
        { code: 'codex-native-rpc-timeout' });
      return { nextCursor: null, data: [{ id: 'preset-a', model: 'wire-a', displayName: 'A', description: 'A',
        hidden: false, isDefault: true, defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }] }] };
    }
    if (method === 'config/read') return { model: 'preset-a', provider: 'openai', reasoningEffort: 'high' };
    if (method === 'thread/list') return { data: [] };
    if (method === 'thread/start') return { thread: liveThread({ id: 'native-1', cwd: 'D:/work/project',
      status: { type: 'active' }, model: 'wire-a', reasoningEffort: 'high' }) };
    if (method === 'turn/start') {
      nativeTurn = { id: 't-1', status: 'inProgress', items: [{ id: 'u1', type: 'userMessage',
        content: [{ type: 'text', text: params.input[0].text }] }] };
      return { turn: nativeTurn };
    }
    if (method === 'thread/read') return { thread: liveThread({ id: 'native-1', cwd: 'D:/work/project',
      status: { type: 'active' }, model: 'wire-a', reasoningEffort: 'high' }) };
    if (method === 'thread/turns/list') return { data: nativeTurn ? [nativeTurn] : [], nextCursor: null };
    if (method === 'thread/name/set') return {};
    throw new Error('unexpected ' + method);
  };
  const record = { name: 'helper', agentId: 'a', sessionId: 'logical', workspace: 'D:/work/project', task: { taskId: 'task-1' } };
  let saved;
  const adapter = await createCodexBackend(record, {
    load: () => record, hostOptions: { nativeRequest },
    readNativeState: () => saved && structuredClone(saved),
    writeNativeState: value => { saved = structuredClone(value); return true; },
    ensureCodexReports: async () => ({ ready: true }),
    readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: [], reports: [] }),
  });
  await adapter.create(); await adapter.beginTask();
  const request = { requestId: 'r', message: 'work', explicitModel: true,
    model: { provider: 'openai', model: 'preset-a', reasoningEffort: 'high' } };
  await assert.rejects(adapter.deliver(request), error => {
    assert.equal(error.code, 'codex-native-rpc-timeout');
    assert.equal(error.retryableRead, true);
    return true;
  });
  assert.equal(calls.some(([method]) => method === 'thread/start' || method === 'turn/start'), false,
    'a catalog read failure must happen before any native send');
  assert.equal(await adapter.receipt({ requestId: 'r' }), undefined,
    'no request row is written for a read that never resolved');
  const result = await adapter.deliver(request);
  assert.equal(result.accepted, true);
  assert.equal(catalogReads, 2, 'the same request retries the catalog read');
  assert.equal(calls.find(([method]) => method === 'turn/start')[1].model, 'wire-a');
});

test('a bound path-empty rollout still begins and delivers the first turn, with and without a pin', async () => {
  const message = String.raw`rollout at C:\Users\test\.codex\sessions\2026\11\06\rollout-2026-11-06T23-10-00-xxx.jsonl is empty`;
  const calls = [];
  let turnSequence = 0;
  const nativeRequest = async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/read') throw Object.assign(new Error(`failed to read session metadata for thread: ${message}`),
      { code: 'codex-native-rpc-rejected', rpcMessage: message });
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'turn/start') return { turn: { id: `t-${++turnSequence}`, status: 'inProgress', items: [] } };
    if (method === 'config/read') return { model: 'preset-a', provider: 'openai', reasoningEffort: 'high' };
    if (method === 'model/list') return { nextCursor: null, data: [{ id: 'preset-a', model: 'wire-a', displayName: 'A',
      description: 'A', hidden: false, isDefault: true, defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }] }] };
    if (method === 'thread/list') return { data: [] };
    if (method === 'thread/start') throw new Error('an existing binding must not create a second thread');
    if (method === 'thread/name/set') return {};
    throw new Error('unexpected ' + method);
  };
  const record = { name: 'helper', agentId: 'a', sessionId: 'logical', workspace: 'D:/work/project', task: { taskId: 'task-1' } };
  let saved = { binding: { sessionId: 'native-1', owned: true }, requests: {}, projections: {}, nonce: 'nonce' };
  const adapter = await createCodexBackend(record, {
    load: () => record, hostOptions: { nativeRequest },
    readNativeState: () => structuredClone(saved),
    writeNativeState: value => { saved = structuredClone(value); return true; },
    ensureCodexReports: async () => ({ ready: true }),
    readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: [], reports: [] }),
  });
  await adapter.create();
  const started = await adapter.beginTask();
  assert.equal('currentModel' in started, false, 'an empty rollout yields no invented model');
  const explicit = await adapter.deliver({ requestId: 'r1', message: 'first', explicitModel: true,
    model: { provider: 'openai', model: 'preset-a', reasoningEffort: 'high' } });
  assert.equal(explicit.accepted, true);
  const firstStart = calls.find(call => call[0] === 'turn/start')[1];
  assert.equal(firstStart.model, 'wire-a');
  assert.equal(firstStart.effort, 'high');
  assert.equal(calls.some(call => call[0] === 'thread/start'), false);
  const plain = await adapter.deliver({ requestId: 'r2', message: 'second' });
  assert.equal(plain.accepted, true);
  const starts = calls.filter(call => call[0] === 'turn/start');
  assert.equal('model' in starts[1][1], false);
  assert.equal('effort' in starts[1][1], false);
});
