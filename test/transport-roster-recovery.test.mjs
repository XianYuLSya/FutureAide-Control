import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RosterStore } from '../src/roster-store.mjs';
import { createScopedAgents } from '../src/scoped-agents.mjs';

test('confirmed transport recovery wakes nine names and clears only transport waits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'futureaide-recovery-'));
  const store = new RosterStore(path.join(root, 'roster.sqlite'));
  const wakes = [];
  const service = createScopedAgents({ stateDirectory: root }, { store, onWorkQueued: id => wakes.push(id) });
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  const future = Date.now() + 300000;
  for (let i = 0; i < 9; i++) store.insert({ agentId: `a${i}`, ownerId: 'owner', name: `name${i}`, target: 'codex-desktop',
    state: 'reconnecting', error: { code: 'codex-native-rpc-timeout' }, nextAttemptAt: future,
    task: { taskId: `t${i}`, state: 'running', dispatches: [
      { requestId: `d${i}`, state: 'retrying', accepted: false, error: { code: 'codex-native-rpc-timeout' }, nextAttemptAt: future },
      { requestId: `business${i}`, state: 'retrying', accepted: false, error: { code: 'agent-busy' }, nextAttemptAt: future },
      { requestId: `unknown${i}`, state: 'unknown', accepted: false, transportNextAttemptAt: future },
    ] } });
  assert.equal(store.transportCandidates({ probe: true }).length, 9);
  await service.transportRecovered({ faultSequence: 1, mode: 'same' });
  assert.equal(wakes.length, 9);
  for (let i = 0; i < 9; i++) {
    const record = store.get(`a${i}`);
    assert.equal(record.nextAttemptAt, undefined);
    assert.equal(record.task.dispatches[0].nextAttemptAt, undefined);
    assert.equal(record.task.dispatches[1].nextAttemptAt, future);
    assert.equal(record.task.dispatches[2].state, 'unknown');
    assert.equal(record.task.dispatches[2].transportNextAttemptAt, undefined);
  }
});

test('late dispatch cannot overwrite an accepted result', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'futureaide-fence-'));
  const store = new RosterStore(path.join(root, 'roster.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const record = { agentId: 'a', ownerId: 'o', name: 'n', state: 'running', task: { taskId: 't', state: 'running', dispatches: [{ requestId: 'q', state: 'sending', accepted: false }] } };
  store.insert(record);
  const stale = structuredClone(record);
  record.task.dispatches[0] = { requestId: 'q', state: 'running', accepted: true };
  assert.equal(store.save(record, { dispatch: true }), true);
  stale.task.dispatches[0].state = 'retrying';
  assert.equal(store.save(stale, { dispatch: true }), false);
  assert.equal(store.get('a').task.dispatches[0].accepted, true);
});
