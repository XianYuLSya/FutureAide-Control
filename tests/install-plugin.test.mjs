import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPlugin, upsertTomlTable } from '../scripts/install-plugin.mjs';
import { installDesktopHostBridge } from '../src/host-install.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture() {
  const directory = path.join(root, '.runtime', 'tests');
  await mkdir(directory, { recursive: true });
  // Retain fixtures here; this project forbids destructive test cleanup.
  return mkdtemp(path.join(directory, 'install-'));
}
async function json(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(value));
}

test('installation binds an absolute runtime and preserves unrelated Codex configuration', async () => {
  const temp = await fixture();
  const sourceRoot = path.join(temp, 'package');
  const codexHome = path.join(temp, 'codex');
  const dshHome = path.join(temp, 'dsh');
  await json(path.join(sourceRoot, '.codex-plugin', 'plugin.json'), {
    name: 'futureaide-control', version: '0.3.0', skills: './skills/', mcpServers: './.mcp.json',
  });
  await mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'src', 'mcp-server.mjs'), '// fixture');
  await mkdir(path.join(sourceRoot, 'skills', 'futureaide-control'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'skills', 'futureaide-control', 'SKILL.md'), '# fixture');
  await mkdir(codexHome, { recursive: true });
  const existing = '# keep this setting\nmodel = "existing"\n\n[mcp_servers.existing]\ncommand = "keep"\n';
  await writeFile(path.join(codexHome, 'config.toml'), existing);
  await json(path.join(sourceRoot, '.runtime', 'config.json'), { workspace: '/stale-project', codexThreadId: 'stale-chat',
    target: 'futureaide', dataRoot: path.join(temp, 'old-host'), launchUrl: 'http://127.0.0.1:12345/?token=stale', preferredInstanceFile: '/old-host-hint' });
  let hostCalls = 0;
  const options = { sourceRoot, codexHome, dshHome, verifyRuntime: async () => {},
    connectHost: async ({ configFile }) => { hostCalls++; assert.match(configFile, /config.json$/); return { ready: true }; } };
  const first = await installPlugin(options);
  const configured = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
  assert.ok(configured.startsWith(existing.trimEnd()));
  assert.match(configured, /futureaide-control@futureaide-control/);
  assert.equal(first.host.ready, true);
  assert.equal(first.codex.currentChatLoaded, false);
  const cacheMcp = JSON.parse(await readFile(path.join(first.codex.cacheRoot, '.mcp.json'), 'utf8'));
  assert.equal(cacheMcp.mcpServers.futureaide.args[0], path.join(sourceRoot, 'src', 'mcp-server.mjs'));
  assert.equal(cacheMcp.mcpServers.futureaide.env.DSH_CONTROL_CONFIG, first.configFile);
  const saved = JSON.parse(await readFile(first.configFile, 'utf8'));
  assert.equal(saved.workspace, undefined);
  assert.equal(saved.codexThreadId, undefined);
  assert.equal(saved.dataRoot, dshHome);
  assert.equal(saved.target, 'dsh');
  assert.equal(saved.launchUrl, undefined);
  assert.equal(saved.preferredInstanceFile, undefined);
  await installPlugin({ ...options, dshHome: undefined });
  assert.equal(await readFile(path.join(codexHome, 'config.toml'), 'utf8'), configured);
  assert.equal(JSON.parse(await readFile(first.configFile, 'utf8')).dshDataRoot, dshHome);
  assert.equal(hostCalls, 2);
});

test('an existing quoted/unquoted owned table is updated without duplicate tables', () => {
  const original = '[plugins."futureaide-control@futureaide-control"]\nenabled = false\n\n[other]\nenabled = false\n';
  const updated = upsertTomlTable(original, ['plugins', 'futureaide-control@futureaide-control'], { enabled: true });
  assert.match(updated, /enabled = true/);
  assert.match(updated, /\[other\]\nenabled = false/);
  assert.equal((updated.match(/\[plugins/g) ?? []).length, 1);
  assert.equal(upsertTomlTable(updated, ['plugins', 'futureaide-control@futureaide-control'], { enabled: true }), updated);
  const arrayConfig = '[marketplaces.futureaide-control]\nsource_type = "local"\n\n[[custom.items]]\nsource = "keep"\n';
  const withSource = upsertTomlTable(arrayConfig, ['marketplaces', 'futureaide-control'], { source: 'new' });
  assert.match(withSource, /source = "new"\n\[\[custom.items\]\]\nsource = "keep"/);
});

test('desktop bridge adds private discovery and preserves the original profile patch', async () => {
  const temp = await fixture();
  const profile = path.join(temp, 'desktop');
  await json(path.join(profile, 'package.json'), { dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } });
  const patch = '# user-owned content\n- modify:\n    id: keep-this\n    config:\n      enabled: true\n';
  await writeFile(path.join(profile, 'cordis.patch.yml'), patch);
  const config = { dataRoot: temp, hostBridgeFile: path.join(temp, 'state', 'host-bridge.json'),
    instanceFile: path.join(temp, 'state', 'instance.json') };
  const first = await installDesktopHostBridge(config, profile);
  const content = await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8');
  assert.ok(content.startsWith(patch.trimEnd()));
  assert.ok(content.includes('discoveryFile: ' + JSON.stringify(config.instanceFile)));
  assert.equal(await readFile(path.join(first.backupDirectory, 'cordis.patch.yml'), 'utf8'), patch);
  const second = await installDesktopHostBridge(config, profile);
  assert.equal(second.unchanged, true);
  assert.equal(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'), content);
});
