import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { emptyProjection, projectCodexTurns } from '../src/codex-host.mjs';

async function setup() {
  let saved, nativeId = 'native-1', model = 'model-a', reportData = { questions: [], reports: [] };
  const record = { name: 'helper', agentId: 'a', sessionId: 'logical', workspace: 'D:/work/project', task: { taskId: 'task-1' } };
  let projection = emptyProjection(), turnSequence = 0;
  const turns = [], counts = { create: 0, send: 0, cancel: 0, destroy: 0 }, inputs = [];
  const titleCalls = [];
  let titleFailures = 0;
  const selection = () => ({ provider: 'openai', model, reasoningEffort: 'high' });
  function appendTurn(message, status = 'inProgress') {
    const turn = { id: `t-${++turnSequence}`, status, startedAt: turnSequence,
      items: [{ id: `u-${turnSequence}`, type: 'userMessage', content: [{ type: 'text', text: message }] }] };
    turns.push(turn);
    projection = projectCodexTurns(projection, turns, saved?.requests ?? {});
    return turn.id;
  }
  const host = {
    probe: async () => ({ identity: { application: 'codex-desktop' }, missing: [] }),
    readDefaultModel: async () => selection(), readCurrentModel: async () => selection(),
    createFirstTurn: async input => { counts.create++; inputs.push(input); nativeId = 'native-1'; const turnId = appendTurn(input.message); return { nativeSessionId: nativeId, created: true, turnId }; },
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
  return { adapter: await createCodexBackend(record, deps), deps, record, counts, inputs, turns, titleCalls,
    state: () => saved, setModel: value => { model = value; }, setReports: value => { reportData = value; },
    failTitle: value => { titleFailures = value; },
    currentProjection: () => projection,
    complete: () => { const last = turns.at(-1); if (last) last.status = 'completed'; projection = projectCodexTurns(projection, turns, saved?.requests ?? {}); } };
}

test('zero-model reservation, first fresh thread, persistent followup and live default', async () => {
  const f = await setup();
  assert.equal((await f.adapter.probe()).reportProtocol, 1);
  assert.equal((await f.adapter.create()).modelRequestsStarted, 0);
  assert.equal(f.counts.create, 0);
  await f.adapter.beginTask();
  assert.equal((await f.adapter.deliver({ requestId: 'r1', message: 'first' })).accepted, true);
  f.complete(); f.record.task.taskId = 'task-2'; f.setModel('model-b');
  await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'r2', message: 'followup' });
  assert.equal(f.counts.create, 1); assert.equal(f.counts.send, 1);
  assert.equal(f.state().requests.r2.model.model, 'model-b');
  assert.equal(f.state().binding.sessionId, 'native-1');
  assert.ok(f.inputs[1].message.startsWith('followup'));
  assert.match(f.inputs[1].message, /\[FutureAide dispatch .*\]$/m, 'later messages also keep the marker last');
  assert.equal('model' in f.inputs[0], false, 'no model reaches the native create');
  assert.equal('model' in f.inputs[1], false, 'no model reaches the native send');
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

test('a new task re-reads the default instead of pinning the previous selection', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'r1', message: 'one' });
  f.complete(); f.record.task.taskId = 'task-2'; f.setModel('model-c');
  await f.adapter.beginTask(); await f.adapter.deliver({ requestId: 'r2', message: 'two' });
  assert.equal(f.state().requests.r2.model.model, 'model-c');
  assert.equal('model' in f.inputs[1], false);
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
