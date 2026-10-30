import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.mjs';
import { createControl } from '../src/control.mjs';
import { installDesktopHostBridge } from '../src/host-install.mjs';

const PLUGIN = 'futureaide-control';
const MARKETPLACE = 'futureaide-control';
const pluginId = PLUGIN + '@' + MARKETPLACE;
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readOptional(filename, fallback = '') {
  try { return await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

// Copy regular files without unlinking/replacing links in the user's directories.
async function copyTree(source, destination) {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) throw new Error('Installation source is a link: ' + source);
  const existing = await lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error('Installation target is a link: ' + destination);
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) await copyTree(path.join(source, entry), path.join(destination, entry));
  } else if (metadata.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } else throw new Error('Unsupported installation source: ' + source);
}

/** Update only owned table keys, preserving unrelated config and comments. */
export function upsertTomlTable(contents, segments, values) {
  const lines = contents.split(/\r?\n/);
  const table = segments.map(value => JSON.stringify(value)).join('.');
  const headers = lines.flatMap((line, index) => {
    if (/^\s*\[\[.+\]\]\s*(?:#.*)?$/.test(line)) return [{ index, key: null }];
    const match = line.match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/);
    if (!match) return [];
    const parts = match[1].match(/"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+/g);
    if (!parts) return [];
    const key = parts.map(part => part.startsWith('"') ? JSON.parse(part) : part.replace(/^'|'$/g, ''));
    return [{ index, key }];
  });
  const matches = headers.filter(header => JSON.stringify(header.key) === JSON.stringify(segments));
  if (matches.length > 1) throw new Error('Duplicate configuration table: ' + table);
  const start = matches[0]?.index;
  if (start === undefined) {
    return contents.trimEnd() + '\n\n[' + table + ']\n'
      + Object.entries(values).map(([key, value]) => key + ' = ' + JSON.stringify(value)).join('\n') + '\n';
  }
  const end = headers.find(header => header.index > start)?.index ?? lines.length;
  const body = lines.slice(start + 1, end);
  for (const [key, value] of Object.entries(values)) {
    const index = body.findIndex(line => new RegExp('^\\s*' + key + '\\s*=').test(line));
    const replacement = key + ' = ' + JSON.stringify(value);
    if (index >= 0) body[index] = replacement;
    else body.push(replacement);
  }
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
}

async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export async function checkRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 14)) throw new Error('Node.js 24.14 or newer is required.');
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(':memory:');
  database.prepare('SELECT 1').get();
  database.close();
  await import('@modelcontextprotocol/sdk/server/mcp.js');
  await import('zod');
}

/** Installation uses only copies and in-place writes; no removal or rename. */
export async function installPlugin({
  sourceRoot = packageRoot,
  codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex'),
  dshHome,
  skipHost = false,
  verifyRuntime = checkRuntime,
  connectHost = connectDesktop,
} = {}) {
  await verifyRuntime();
  sourceRoot = path.resolve(sourceRoot);
  if (process.platform === 'win32' && path.parse(sourceRoot).root.toLowerCase() === 'c:\\') {
    throw new Error('Keep the runtime package on D: or another non-C: drive. Setup does not move or delete files on C:.');
  }
  codexHome = path.resolve(codexHome);
  const runtime = path.join(sourceRoot, '.runtime');
  const configFile = path.join(runtime, 'config.json');
  const marketplaceRoot = path.join(runtime, 'marketplace');
  const descriptorRoot = path.join(marketplaceRoot, 'plugins', PLUGIN);
  const cacheRoot = path.join(codexHome, 'plugins', 'cache', MARKETPLACE, PLUGIN, 'local');
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  if (manifest.name !== PLUGIN) throw new Error('The installation package has the wrong plugin name.');
  await lstat(path.join(sourceRoot, 'src', 'mcp-server.mjs'));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const saved = JSON.parse(await readOptional(configFile, '{}'));
  dshHome = path.resolve(dshHome || process.env.DSH_HOME || saved.dshDataRoot || saved.dataRoot || path.join(homedir(), '.dsh'));
  const configuration = {
    ...saved, target: 'dsh', dataRoot: dshHome, dshDataRoot: dshHome,
    instanceFile: path.join(runtime, 'instance.json'),
    hostBridgeFile: path.join(runtime, 'host-bridge.json'),
  };
  // The current chat and project are resolved from trusted request context.
  delete configuration.workspace;
  delete configuration.codexThreadId;
  delete configuration.futureaideSessionId;
  delete configuration.baseUrl;
  await writeJson(configFile, configuration);
  const mcp = { mcpServers: { futureaide: {
    command: process.execPath,
    args: [path.join(sourceRoot, 'src', 'mcp-server.mjs')],
    env: { DSH_CONTROL_CONFIG: configFile },
    startup_timeout_sec: 20, tool_timeout_sec: 60,
  } } };
  for (const root of [descriptorRoot, cacheRoot]) {
    await copyTree(path.join(sourceRoot, 'skills'), path.join(root, 'skills'));
    await writeJson(path.join(root, '.mcp.json'), mcp);
    await writeJson(path.join(root, '.codex-plugin', 'plugin.json'), manifest);
  }
  await writeJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
    name: MARKETPLACE, interface: { displayName: 'FutureAide Control' },
    plugins: [{ name: PLUGIN, category: 'Productivity',
      source: { source: 'local', path: './plugins/' + PLUGIN },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' } }],
  });
  const codexConfig = path.join(codexHome, 'config.toml');
  const original = await readOptional(codexConfig);
  const configured = upsertTomlTable(upsertTomlTable(original, ['marketplaces', MARKETPLACE], {
    source_type: 'local', source: marketplaceRoot,
  }), ['plugins', pluginId], { enabled: true });
  if (configured !== original) {
    if (original) {
      const backup = path.join(runtime, 'rollback', Date.now() + '-codex');
      await mkdir(backup, { recursive: true });
      await copyFile(codexConfig, path.join(backup, 'config.toml'));
    }
    await mkdir(codexHome, { recursive: true });
    await writeFile(codexConfig, configured, { mode: 0o600 });
  }
  const host = skipHost ? { ready: false, skipped: true } : await connectHost({ configFile, dshHome });
  return {
    installed: true, pluginId, packageRoot: sourceRoot, configFile,
    codex: { registered: true, cacheRoot, currentChatLoaded: false }, host,
    next: 'Reload plugins or start a new Codex chat, then call the agent list tool. Current chat loading and callback delivery are verified separately.',
  };
}

async function connectDesktop({ configFile, dshHome }) {
  const config = await loadConfig(configFile);
  const profile = path.join(dshHome, 'profiles', 'desktop');
  let installed = await installDesktopHostBridge(config, profile);
  const control = createControl(config);
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const result = await control.hostStatus();
      if (result.version === 1 && result.methods?.includes('managedCreate') && result.revision === installed.revision) {
        return { ready: true, ...result };
      }
      lastError = new Error('DSH has not loaded this revision of the managed-agent capability bridge.');
    } catch (error) { lastError = error; }
    if (attempt === 9) installed = await installDesktopHostBridge(config, profile, { refresh: true });
    await delay(500);
  }
  throw new Error('Codex registration was saved, but DSH connection is not ready: '
    + (lastError?.message ?? 'Open DSH and rerun the installer.'));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--skip-host') options.skipHost = true;
    else if (['--codex-home', '--dsh-home'].includes(key) && args[index + 1]) {
      options[key === '--codex-home' ? 'codexHome' : 'dshHome'] = args[++index];
    } else throw new Error('Unknown or incomplete option: ' + key);
  }
  try { process.stdout.write(JSON.stringify(await installPlugin(options), null, 2) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
