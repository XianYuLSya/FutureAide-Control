import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeQueue, planMonitorRound, monitorWaitMs } from '../src/shared-monitor.mjs';

test('monitor round consumes wake hints, respects fast names and sweep cadence', () => {
  const hints = createWakeQueue();
  hints.queued('a');
  const service = { fastPollNames: () => ['b', 'a'] };
  let round = planMonitorRound(hints, service, 1000, { now: 3000, sweepMs: 5000 });
  assert.deepEqual(round.only, ['a', 'b']);
  assert.deepEqual(round.taken.names, ['a']);
  assert.equal(round.sweepDue, false);
  round = planMonitorRound(hints, service, 1000, { now: 6000, sweepMs: 5000 });
  assert.equal(round.sweepDue, true);
  assert.equal(monitorWaitMs({ busy: true, busyMs: 1000, idleMs: 5000, floorMs: 250 }), 1000);
  assert.equal(monitorWaitMs({ busy: false, sweepInMs: 3200, floorMs: 250 }), 3200);
});
