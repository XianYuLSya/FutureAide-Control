import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHostHandler } from '../src/host-plugin.mjs';

test('cleanup RPCs reject another physical DSH root before inspecting or mutating it', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'cleanup-rpc-root-'));
  const other = await mkdtemp(path.join(tmpdir(), 'cleanup-rpc-other-'));
  t.after(() => Promise.all([home, other].map(dir => rm(dir, { recursive: true, force: true }))));
  const token = '7'.repeat(64);
  const ctx = { get(name) { if (name === 'sessionPersistence') return { config: { root: path.join(home, 'sessions') } }; } };
  const request = createHostHandler(ctx, token);
  const describe = async name => {
    const canonical = await realpath(name);
    const info = await stat(canonical, { bigint: true });
    return { path: canonical, dev: String(info.dev), ino: String(info.ino) };
  };
  const own = await describe(home);
  for (const method of ['cleanupInventory', 'cleanupRemove', 'cleanupFinalize', 'managedCleanupStage', 'cleanupResidualRemove', 'cleanupTempUsage']) {
    for (const different of [await describe(other), { ...own, ino: own.ino + '0' }]) {
      const result = await request(method, { args: { token, cleanupRoot: different } });
      assert.equal(result.error?.code, 'cleanup-root-mismatch', method);
    }
    assert.equal((await request(method, { args: { token } })).error?.code, 'cleanup-root-unverified');
  }
  const accepted = await request('cleanupInventory', { args: { token, cleanupRoot: own } });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.complete, false);
});
