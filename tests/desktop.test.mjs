import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installDesktopHostBridge } from '../src/host-install.mjs';
import { apply, inject } from '../src/host-plugin.mjs';

test('Desktop installation preserves unrelated patches and credentials and is idempotent', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'desktop'); await mkdir(profile);
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }));
  const filename = path.join(profile, 'cordis.patch.yml');
  const original = '- remove: unrelated-disabled-plugin\n'; await writeFile(filename, original);
  const config = { hostBridgeFile: path.join(root, 'private', 'host-bridge.json') };
  const first = await installDesktopHostBridge(config, profile);
  const credential = await readFile(config.hostBridgeFile, 'utf8');
  assert.equal(await readFile(path.join(first.backupDirectory, 'cordis.patch.yml'), 'utf8'), original);
  assert.ok((await readFile(filename, 'utf8')).startsWith(original));
  const second = await installDesktopHostBridge(config, profile);
  assert.equal(second.unchanged, true); assert.equal(await readFile(config.hostBridgeFile, 'utf8'), credential);
  await writeFile(filename, '- insert:\n    - id: codex-control-host-bridge\n      name: someone-else\n');
  await assert.rejects(installDesktopHostBridge(config, profile), /unowned/);
});

test('new Connection registration receives the bridge context with webServer injection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentialFile = path.join(root, 'credential.json');
  const token = 'a'.repeat(64); await writeFile(credentialFile, JSON.stringify({ token }));
  let registered;
  const ctx = { root: {}, effect: () => {}, connection: { register(owner, channel, handler) { registered = { owner, channel, handler }; } } };
  await apply(ctx, { credentialFile });
  assert.ok(inject.includes('webServer')); assert.equal(registered.owner, ctx); assert.equal(registered.channel, '/futureaide-control');
  assert.equal((await registered.handler('ping', { args: { token } })).ok, true);
  assert.equal((await registered.handler('ping', { args: { token: 'wrong' } })).ok, false);
});
