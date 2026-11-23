// An installation can lock DSH to its own default model (dshDefaultModelOnly). The
// switch lives in the plugin configuration and is carried into the DSH bridge row,
// so a caller still running an older plugin is held to it as well.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { installDesktopHostBridge } from '../src/host-install.mjs';
import { apply } from '../src/host-plugin.mjs';

test('dshDefaultModelOnly is a configuration switch that is off unless it is asked for', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-model-lock-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name, value) => {
    const file = path.join(root, `${name}.json`);
    await writeFile(file, JSON.stringify(value), 'utf8');
    return file;
  };
  assert.equal((await loadConfig(await write('off', { workspace: root }))).dshDefaultModelOnly, false, 'default off');
  assert.equal((await loadConfig(await write('on', { workspace: root, dshDefaultModelOnly: true }))).dshDefaultModelOnly, true);
  await assert.rejects(loadConfig(await write('bad', { workspace: root, dshDefaultModelOnly: 'yes' })),
    /dshDefaultModelOnly must be true or false/);
});

test('the bridge row carries the lock only while the configuration asks for it', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-model-lock-row-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'desktop'); await mkdir(profile);
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }));
  const filename = path.join(profile, 'cordis.patch.yml');
  await writeFile(filename, '[]\n');
  const config = { hostBridgeFile: path.join(root, 'private', 'host-bridge.json') };
  await installDesktopHostBridge(config, profile);
  assert.doesNotMatch(await readFile(filename, 'utf8'), /defaultModelOnly/);
  await installDesktopHostBridge({ ...config, dshDefaultModelOnly: true }, profile);
  assert.match(await readFile(filename, 'utf8'), /^ {8}defaultModelOnly: true$/m);
  await installDesktopHostBridge(config, profile);
  assert.doesNotMatch(await readFile(filename, 'utf8'), /defaultModelOnly/, 'turning the switch off removes it again');
});

test('the bridge announces its lock at ping only when its row carries it', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-model-lock-ping-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentialFile = path.join(root, 'credential.json');
  const token = 'b'.repeat(64); await writeFile(credentialFile, JSON.stringify({ token }));
  const ping = async extra => {
    let handler;
    const ctx = { root: {}, effect: () => {}, connection: { register(owner, channel, registered) { handler = registered; } } };
    await apply(ctx, { credentialFile, ...extra });
    return (await handler('ping', { args: { token } })).value;
  };
  assert.equal((await ping({})).modelPolicy, undefined);
  assert.equal((await ping({ defaultModelOnly: true })).modelPolicy, 'default-only');
});


test('effort configuration merges factory, base and profile and validates fields', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'effort-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  await mkdir(path.join(root, 'profiles'));
  await writeFile(file, JSON.stringify({ defaultEffort: 'high', modelDefaultEfforts: { Other: 'low', 'GPT-6.2-ASTRA': 'medium' } }));
  await writeFile(path.join(root, 'profiles', 'test.json'), JSON.stringify({ workspace: root, modelDefaultEfforts: { OTHER: 'max' } }));
  const config = await loadConfig(file, 'test');
  assert.equal(config.defaultEffort, 'high');
  assert.deepEqual(config.modelDefaultEfforts, { 'gpt-6.2-astra': 'medium', other: 'max' });
  await writeFile(file, JSON.stringify({ modelDefaultEfforts: { bad: 'typo' } }));
  await assert.rejects(loadConfig(file), /modelDefaultEfforts.bad/);
});
