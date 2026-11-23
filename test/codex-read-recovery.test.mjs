import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexNativeRpc } from '../src/codex-ipc.mjs';
import { runReadRecoveryFixture } from '../fixtures/read-recovery-fixture.mjs';

test('seven read-only requests recover on a replacement socket while the probe is slow', async () => {
  const result = await runReadRecoveryFixture(createCodexNativeRpc, {
    discoveryMs: 120, probeReplyMs: 150, probeTimeoutMs: 50, readCount: 7,
  });
  assert.equal(result.fatal, undefined);
  assert.deepEqual(result.beforeClose, { ok: true, thread: 'thread-1' });
  assert.deepEqual(result.reads, { ok: 7, failed: 0, codes: [], transportAdmissionFailed: 0, transportGenerations: [], transportFaultSequences: [] });
  assert.equal(result.writeSentBeforeProbeResult, false,
    'a write must not use a replacement socket before the same-generation probe succeeds');
  assert.equal(result.write.ok, false);
  assert.equal(result.write.code, 'codex-native-rpc-unavailable');
  assert.equal(result.write.notSent, true);
  assert.equal(result.write.transportAdmissionFailed, true);
});

test('a write waits for a successful probe and then uses the same replacement generation', async () => {
  const result = await runReadRecoveryFixture(createCodexNativeRpc, {
    discoveryMs: 120, probeReplyMs: 20, probeTimeoutMs: 50, readCount: 7,
  });
  assert.equal(result.fatal, undefined);
  assert.deepEqual(result.reads, { ok: 7, failed: 0, codes: [], transportAdmissionFailed: 0, transportGenerations: [], transportFaultSequences: [] });
  assert.equal(result.writeSentBeforeProbeResult, false,
    'a write is admitted only after the probe result, never from the earlier read proof');
  assert.deepEqual(result.write, { ok: true, turn: 'turn-1' });
  assert.equal(result.frames.at(-1).includes('probe'), true);
  assert.equal(result.frames.at(-1).at(-1), 'turn/start');
});

