import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { emptyProjection, projectCodexEvent } from '../src/codex-host.mjs';

async function setup() {
  let saved, nativeId, model = 'model-a', reportData = { questions: [], reports: [] };
  const record = { name: 'helper', agentId: 'a', sessionId: 'logical', workspace: 'D:/work/project', task: { taskId: 'task-1' } };
  const projection = emptyProjection(), counts = { create: 0, send: 0, cancel: 0, destroy: 0 };
  const selection = () => ({ provider: 'openai', model, reasoningEffort: 'high' });
  function appendPrompt(message) {
    projectCodexEvent(projection, { type: 'event_msg', payload: { type: 'task_started', turn_id: `t-${projection.seq}` } });
    projectCodexEvent(projection, { type: 'response_item', payload: { type: 'message', id: `m-${projection.seq}`, role: 'user', content: [{ text: message }] } }, saved.requests);
  }
  const deps = { load: () => record, readNativeState: () => saved && structuredClone(saved),
    writeNativeState: value => { saved = structuredClone(value); return true; },
    ensureCodexReports: async () => ({ ready: true }), readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => reportData,
    host: { probe: async () => ({ identity: { application: 'codex-desktop' }, missing: [] }),
      readDefaultModel: async () => selection(), readCurrentModel: async () => selection(),
      createFirstTurn: async input => { counts.create++; nativeId = 'native-1'; appendPrompt(input.message); return { nativeSessionId: nativeId, created: true }; },
      send: async input => { counts.send++; appendPrompt(input.message); },
      findCreatedSession: async () => nativeId ? { nativeSessionId: nativeId } : undefined,
      observe: async () => ({ projections: { [nativeId]: structuredClone(projection) },
        histories: { [nativeId]: { messages: projection.messages, hasMore: false } },
        tree: { running: projection.running, settled: !projection.running,
          nodes: [{ sessionId: nativeId, parentSessionId: null, status: projection.running ? 'running' : 'idle', changes: projection.changes }] } }),
      interrupt: async () => { counts.cancel++; return { interrupted: true }; },
      destroy: async () => { counts.destroy++; return { destroyed: false }; },
    } };
  return { adapter: await createCodexBackend(record, deps), deps, record, counts, projection, state: () => saved,
    setModel: value => { model = value; }, setReports: value => { reportData = value; },
    complete: () => projectCodexEvent(projection, { type: 'event_msg', payload: { type: 'task_complete', turn_id: projection.turnId } }) };
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
  projectCodexEvent(f.projection, { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'final', phase: 'final', content: [{ text: 'done' }] } } });
  f.complete();
  assert.deepEqual((await f.adapter.observe()).reports, []);
  f.setReports({ questions: [{ id: 'q', taskId: 'task-1', state: 'pending', message: 'why?' }],
    reports: [{ id: 'stale', taskId: 'old', message: 'old', final: true }, { id: 'yes', taskId: 'task-1', message: 'done', final: true }] });
  assert.deepEqual((await f.adapter.observe()).reports.map(r => r.id), ['yes']);
  assert.deepEqual((await f.adapter.answer({ answerId: 'a1', message: 'answer' })).consumedQuestionIds, ['q']);
  assert.equal((await f.adapter.observe()).questions[0].state, 'answered');
  assert.equal((await f.adapter.turn({ requestId: 'r' })).state, 'ended');
  assert.equal((await f.adapter.turn({ requestId: 'r' })).correlation, 'request-id');
  assert.equal((await f.adapter.turn({ requestId: 'r' })).turnId, f.projection.turnId);
  assert.equal((await f.adapter.destroy()).destroyed, false);
});

test('retry preserves the original dispatch model while a new input resolves the new default', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  const original = { provider: 'openai', model: 'model-a', reasoningEffort: 'high' };
  f.record.task.dispatches = [{ requestId: 'r', model: original }];
  f.setModel('model-b');
  let attempts = 0;
  const adapter = await createCodexBackend(f.record, { ...f.deps, host: { ...f.deps.host,
    createFirstTurn: async input => {
      if (++attempts === 1) throw Object.assign(new Error('project pending'), { code: 'codex-project-unresolved' });
      assert.deepEqual(input.model, original);
      return f.deps.host.createFirstTurn(input);
    } } });
  await assert.rejects(adapter.deliver({ requestId: 'r', message: 'work' }), { retryableRead: true });
  f.setModel('model-c');
  await adapter.deliver({ requestId: 'r', message: 'work' });
  assert.equal(f.state().requests.r.model.model, 'model-a');
  f.complete(); await adapter.deliver({ requestId: 'next', message: 'new work' });
  assert.equal(f.state().requests.next.model.model, 'model-c');
});

test('cancel is only requested for the bound native tree and readiness exposes missing delete', async () => {
  const f = await setup(); await f.adapter.create(); await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'r', message: 'work' });
  assert.equal((await f.adapter.cancel()).cancelRequested, true);
  assert.equal(f.counts.cancel, 1);
  const missing = await createCodexBackend(f.record, { ...f.deps,
    host: { ...f.deps.host, probe: async () => ({ missing: ['native-owned-tree-delete'] }) } });
  await assert.rejects(missing.probe(), { code: 'codex-backend-not-ready' });
});
