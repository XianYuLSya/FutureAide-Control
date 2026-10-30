import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  const refreshed = await installDesktopHostBridge(config, profile, { refresh: true });
  assert.equal(refreshed.refreshed, true);
  assert.notEqual(refreshed.registration, first.registration);
  assert.equal(refreshed.revision, first.revision);
  const refreshContent = await readFile(filename, 'utf8');
  assert.ok(refreshContent.startsWith(original));
  assert.equal(refreshContent.match(/BEGIN futureaide-control host bridge/g).length, 1);
  assert.equal((await installDesktopHostBridge(config, profile)).unchanged, true);
  assert.equal(await readFile(filename, 'utf8'), refreshContent);
  assert.equal(await readFile(config.hostBridgeFile, 'utf8'), credential);
  await writeFile(filename, '- insert:\n    - id: codex-control-host-bridge\n      name: someone-else\n');
  await assert.rejects(installDesktopHostBridge(config, profile), /unowned/);
});

test('identical bridge code installed from another directory gets a new Loader identity', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'desktop'); await mkdir(profile);
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }));
  await writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n');
  const config = { hostBridgeFile: path.join(root, 'private', 'host-bridge.json') };
  const first = await installDesktopHostBridge(config, profile);
  const copy = path.join(root, 'another-install'); await mkdir(copy);
  for (const file of ['host-install.mjs', 'host-plugin.mjs']) {
    await copyFile(new URL('../src/' + file, import.meta.url), path.join(copy, file));
  }
  const installedCopy = await import(pathToFileURL(path.join(copy, 'host-install.mjs')).href);
  const second = await installedCopy.installDesktopHostBridge(config, profile);
  assert.equal(second.revision, first.revision);
  assert.notEqual(second.registration, first.registration);
  assert.equal((await installedCopy.installDesktopHostBridge(config, profile)).unchanged, true);
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

test('replacement bridge owns its route after the previous fiber is disposed', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-reload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentialFile = path.join(root, 'credential.json');
  const token = 'a'.repeat(64); await writeFile(credentialFile, JSON.stringify({ token }));
  const host = {};
  let route;
  let removals = 0;
  const connection = { register(owner, channel, handler) {
    assert.equal(route, undefined);
    route = { owner, channel, handler };
    return () => { removals++; assert.equal(route.owner, owner); route = undefined; };
  } };
  const context = () => {
    const effects = [];
    return { root: host, connection, effect: setup => effects.push(setup()),
      dispose: async () => { for (const effect of effects) await effect(); } };
  };
  const old = context(), next = context();
  await apply(old, { credentialFile });
  await apply(next, { credentialFile });
  assert.equal(removals, 1);
  assert.equal(route.owner, next);
  await old.dispose();
  assert.equal((await route.handler('ping', { args: { token } })).ok, true);
  assert.equal(removals, 1);
  await next.dispose();
  assert.equal(removals, 2);
  assert.equal(route, undefined);
  assert.equal(host[Symbol.for('futureaide-control.host-handler')], undefined);
});

test('legacy Connection rpc.handle remains supported', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-legacy-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentialFile = path.join(root, 'credential.json');
  const token = 'b'.repeat(64); await writeFile(credentialFile, JSON.stringify({ token }));
  let registered;
  const ctx = { root: {}, effect: () => {}, connection: { rpc: { handle(channel, handler, options) {
    registered = { channel, handler, options };
  } } } };
  await apply(ctx, { credentialFile });
  assert.equal(registered.channel, '/futureaide-control');
  assert.equal(registered.options.authority, 'loopback');
  assert.equal((await registered.handler('ping', { args: { token } })).ok, true);
});
