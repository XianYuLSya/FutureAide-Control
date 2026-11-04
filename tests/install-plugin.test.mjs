import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaudeCli, installPlugin, runClaudeCommand, upsertTomlTable } from '../scripts/install-plugin.mjs';
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

test('installation binds an absolute runtime and preserves unrelated Codex configuration', async t => {
  // installPlugin resolves dshHome as `dshHome || DSH_HOME || saved …`, and the
  // "reuse the saved configuration" half below omits dshHome on purpose. A
  // DSH_HOME inherited from this machine would otherwise be written into the
  // fixture config, so the fixture keeps to its own explicit D: paths.
  const inheritedDshHome = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  t.after(() => { if (inheritedDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = inheritedDshHome; });
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
  // The Claude entry has its own tests below; skipping it here keeps this fixture
  // from ever reaching a real CLI on the machine running the suite.
  const options = { sourceRoot, codexHome, dshHome, skipClaude: true, verifyRuntime: async () => {},
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

// A package fixture for the Claude entry: the thin plugin only needs the manifests,
// the bootstrap and the skill, never node_modules or the runtime.
async function claudePackage() {
  const temp = await fixture();
  const sourceRoot = path.join(temp, 'package');
  const description = 'Named DSH subagents for Claude.';
  const manifest = { name: 'futureaide-control', version: '0.5.7', description, author: { name: 'FutureAide' } };
  await json(path.join(sourceRoot, '.codex-plugin', 'plugin.json'), {
    name: 'futureaide-control', version: '0.5.7', skills: './skills/', mcpServers: './.mcp.json',
  });
  await json(path.join(sourceRoot, '.claude-plugin', 'plugin.json'), manifest);
  await json(path.join(sourceRoot, 'package.json'), { name: 'futureaide-control', version: '0.5.7' });
  await mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'src', 'mcp-server.mjs'), '// fixture');
  await writeFile(path.join(sourceRoot, 'src', 'claude-report-bootstrap.mjs'), '// fixture');
  await mkdir(path.join(sourceRoot, 'skills', 'futureaide-control'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'skills', 'futureaide-control', 'SKILL.md'), '# fixture skill');
  return { temp, manifest, sourceRoot, codexHome: path.join(temp, 'codex'), dshHome: path.join(temp, 'dsh') };
}

function claudeOptions(pkg, extra) {
  return { sourceRoot: pkg.sourceRoot, codexHome: pkg.codexHome, dshHome: pkg.dshHome,
    verifyRuntime: async () => {}, skipHost: true, findCli: async () => 'C:\\Claude\\claude.exe', ...extra };
}

test('installation registers a thin Claude plugin that points at the runtime', async () => {
  const pkg = await claudePackage();
  const calls = [];
  const runClaude = async (cli, args) => { calls.push([cli, args]); return { outcome: 'ok' }; };
  const result = await installPlugin(claudeOptions(pkg, { runClaude }));
  const marketplaceRoot = path.join(pkg.sourceRoot, '.runtime', 'claude-marketplace');
  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'futureaide-control');
  assert.equal(result.installed, true);
  assert.deepEqual(result.claude, { registered: true, marketplaceRoot, pluginId: 'futureaide-control@futureaide' });
  assert.match(result.next, /start a new chat/);
  const marketplace = JSON.parse(await readFile(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(marketplace.name, 'futureaide');
  assert.deepEqual(marketplace.plugins, [{ name: 'futureaide-control', source: './plugins/futureaide-control',
    description: pkg.manifest.description, version: '0.5.7' }]);
  assert.deepEqual(JSON.parse(await readFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')), pkg.manifest);
  assert.equal(result.configFile, path.join(pkg.sourceRoot, '.runtime', 'config.json'));
  assert.deepEqual(JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8')), { mcpServers: {
    'futureaide-report': {
      command: process.execPath,
      args: [path.join(pkg.sourceRoot, 'src', 'claude-report-bootstrap.mjs')],
      env: { DSH_CONTROL_CONFIG: result.configFile },
    },
  } });
  assert.equal(await readFile(path.join(pluginRoot, 'skills', 'futureaide-control', 'SKILL.md'), 'utf8'), '# fixture skill');
  assert.deepEqual(calls, [
    ['C:\\Claude\\claude.exe', ['plugin', 'marketplace', 'add', marketplaceRoot, '--scope', 'user', '--json']],
    ['C:\\Claude\\claude.exe', ['plugin', 'install', 'futureaide-control@futureaide', '--scope', 'user', '--json']],
  ]);
});

test('re-registering the Claude plugin is how an upgrade happens and does not fail', async () => {
  const pkg = await claudePackage();
  const calls = [];
  const runClaude = async (cli, args) => { calls.push([cli, args]); return { outcome: 'ok', alreadyInstalled: true }; };
  const options = claudeOptions(pkg, { runClaude });
  const first = await installPlugin(options);
  const second = await installPlugin(options);
  assert.equal(first.claude.registered, true);
  assert.equal(second.claude.registered, true);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(2), calls.slice(0, 2));
});

test('a missing Claude CLI leaves the rest of the installation successful', async () => {
  const pkg = await claudePackage();
  let runs = 0;
  const result = await installPlugin(claudeOptions(pkg, { findCli: async () => undefined,
    runClaude: async () => { runs++; } }));
  assert.equal(result.installed, true);
  assert.equal(result.codex.registered, true);
  assert.equal(result.claude.registered, false);
  assert.match(result.claude.reason, /Claude CLI was not found/);
  assert.equal(runs, 0);
});

test('a refused Claude registration is reported without failing the installation', async () => {
  const pkg = await claudePackage();
  const exec = async (cli, args) => Promise.resolve(args[1] === 'install'
    ? { stdout: '{"outcome":"error","message":"marketplace futureaide is not trusted"}' }
    : { stdout: 'progress line\n{"outcome":"ok"}' });
  const result = await installPlugin(claudeOptions(pkg, { runClaude: (cli, args) => runClaudeCommand(cli, args, { exec }) }));
  assert.equal(result.installed, true);
  assert.equal(result.claude.registered, false);
  assert.match(result.claude.reason, /outcome "error"/);
  assert.match(result.claude.reason, /marketplace futureaide is not trusted/);
});

test('a non-zero Claude exit is reported with its output', async () => {
  const pkg = await claudePackage();
  const exec = async () => { throw Object.assign(new Error('Command failed'), { stderr: 'unknown command: plugin\n' }); };
  const result = await installPlugin(claudeOptions(pkg, { runClaude: (cli, args) => runClaudeCommand(cli, args, { exec }) }));
  assert.equal(result.claude.registered, false);
  assert.match(result.claude.reason, /Claude command failed: plugin marketplace add/);
  assert.match(result.claude.reason, /unknown command: plugin/);
});

test('the last stdout line must be a JSON result', async () => {
  const ok = await runClaudeCommand('claude', ['plugin', 'list'],
    { exec: async () => ({ stdout: 'Downloading marketplace…\n{"outcome":"ok","name":"futureaide"}\n' }) });
  assert.equal(ok.name, 'futureaide');
  await assert.rejects(runClaudeCommand('claude', ['plugin', 'list'], { exec: async () => ({ stdout: 'not json' }) }),
    /returned no JSON result/);
});

test('skipping Claude writes no plugin and runs no command', async () => {
  const pkg = await claudePackage();
  let runs = 0;
  const result = await installPlugin(claudeOptions(pkg, { skipClaude: true, runClaude: async () => { runs++; } }));
  assert.equal(runs, 0);
  assert.equal(result.installed, true);
  assert.equal(result.claude.registered, false);
  await assert.rejects(readFile(path.join(pkg.sourceRoot, '.runtime', 'claude-marketplace', '.claude-plugin', 'marketplace.json')),
    error => error.code === 'ENOENT');
});

test('findClaudeCli prefers explicit, then CLAUDE_CLI, then PATH, then the newest Claude-Data build', async () => {
  const untouched = () => { throw new Error('a lower priority lookup ran'); };
  assert.equal(await findClaudeCli({ explicit: 'D:\\tools\\claude.exe', env: { CLAUDE_CLI: 'D:\\env\\claude.exe' },
    onPath: untouched, list: untouched }), 'D:\\tools\\claude.exe');
  assert.equal(await findClaudeCli({ env: { CLAUDE_CLI: 'D:\\env\\claude.exe' }, onPath: untouched, list: untouched }),
    'D:\\env\\claude.exe');
  assert.equal(await findClaudeCli({ env: {}, onPath: async () => 'D:\\path\\claude.exe', list: untouched }),
    'D:\\path\\claude.exe');
  const localAppData = 'D:\\Local';
  // Build the Claude-Data tree from claude.exe paths so each case lists only its own versions.
  const search = versions => {
    const files = new Set(versions.map(relative => path.join(localAppData, relative)));
    const tree = new Map();
    for (const relative of versions) {
      const segments = relative.split('\\');
      for (let index = 1; index < segments.length - 1; index++) {
        const directory = path.join(localAppData, ...segments.slice(0, index));
        const entries = tree.get(directory) ?? [];
        if (!entries.includes(segments[index])) entries.push(segments[index]);
        tree.set(directory, entries);
      }
    }
    const list = async directory => {
      if (!tree.has(directory)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return tree.get(directory);
    };
    return { list, isFile: async file => files.has(file) };
  };
  const desktop = search(['Claude-Data\\Desktop\\claude-code\\2.1.309\\a1\\claude.exe',
    'Claude-Data\\Desktop\\claude-code\\2.1.317\\b2\\claude.exe']);
  assert.equal(await findClaudeCli({ env: {}, localAppData, onPath: async () => undefined, ...desktop }),
    path.join(localAppData, 'Claude-Data', 'Desktop', 'claude-code', '2.1.317', 'b2', 'claude.exe'));
  const legacy = search(['Claude-Data\\Desktop\\claude-code\\10.0.0\\c3\\claude.exe',
    'Claude-Data\\Desktop\\claude-code\\9.0.0\\d4\\claude.exe']);
  assert.equal(await findClaudeCli({ env: {}, localAppData, onPath: async () => undefined, ...legacy }),
    path.join(localAppData, 'Claude-Data', 'Desktop', 'claude-code', '10.0.0', 'c3', 'claude.exe'));
  assert.equal(await findClaudeCli({ env: {}, localAppData: 'D:\\Empty', onPath: async () => undefined, ...desktop }), undefined);
  assert.equal(await findClaudeCli({ env: {}, localAppData: undefined, onPath: async () => undefined }), undefined);
});

test('the Claude plugin manifest version matches package.json', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'futureaide-control');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.author.name, 'FutureAide');
  assert.match(manifest.description, /DSH subagents/);
});
