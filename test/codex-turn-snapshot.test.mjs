import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { emptyProjection } from '../src/codex-host.mjs';

async function fixture() {
  const record = { agentId: 'agent', name: 'helper', sessionId: 'logical', workspace: 'D:/synthetic', task: { taskId: 'task' } };
  const requests = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`request-${i}`, { status: 'accepted', turnId: 'turn' }]));
  let saved = { binding: { sessionId: 'native', owned: true }, requests, projections: {} };
  let reads = 0, running = false;
  const backend = await createCodexBackend(record, {
    load: () => record,
    readNativeState: () => structuredClone(saved),
    writeNativeState: state => { saved = structuredClone(state); return true; },
    readCodexReportState: async () => ({ questions: [], reports: [] }),
    host: {
      observe: async () => {
        reads++;
        const p = emptyProjection();
        p.turns.turn = { state: 'ended', completionReason: 'completed' };
        return { projections: { native: p }, histories: {},
          tree: { nodes: [], running, settled: !running, activeFlags: [], statusType: running ? 'active' : 'idle' } };
      },
      interrupt: async () => ({ interrupted: true }),
    },
  });
  return { backend, reads: () => reads, setRunning: value => { running = value; } };
}

test('one observed snapshot resolves fourteen turns; an individual turn still reads fresh', async () => {
  const f = await fixture();
  await f.backend.observe();
  const snapshot = f.backend.takeObservedTurnSnapshot();
  for (let i = 0; i < 14; i++) {
    const turn = await f.backend.turn({ requestId: `request-${i}`, observationSnapshot: snapshot });
    assert.equal(turn.state, 'ended');
    assert.equal(turn.correlation, 'request-id');
  }
  assert.equal(f.reads(), 1);
  f.setRunning(true);
  assert.equal((await f.backend.turn({ requestId: 'request-0' })).state, 'running');
  assert.equal(f.reads(), 2);
});

test('cancellation or answer attempts invalidate a previously captured snapshot', async () => {
  for (const operation of ['cancel', 'answer']) {
    const f = await fixture();
    await f.backend.observe();
    const snapshot = f.backend.takeObservedTurnSnapshot();
    f.setRunning(true);
    if (operation === 'cancel') await f.backend.cancel();
    else await assert.rejects(f.backend.answer({ answerId: 'a', message: 'synthetic' }));
    const before = f.reads();
    assert.equal((await f.backend.turn({ requestId: 'request-0', observationSnapshot: snapshot })).state, 'running');
    assert.equal(f.reads(), before + 1);
  }
});
