// Shared fixture for the two production assembly tests.
//
// Deliberately not used here:
//   createScopedAgents(..., { store/clientFactory/backendAdapters/... }) fake seams,
//   makeScopedServer({ scopedFactory }), or a hand-built management/service pair.
// The production entry points are started as they are:
//   - src/scoped-worker.mjs for the Claude caller path (the process that installs
//     scopedManagement on the loopback report service);
//   - src/mcp-server.mjs / makeScopedServer({configPath}) for the Codex caller path.
// Test-only loaders replace only the native Claude process/TCP lookup and the
// Codex renderer transport.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../../src/config.mjs';
import { RosterStore } from '../../src/roster-store.mjs';
import { ensureSharedMonitor } from '../../src/shared-monitor.mjs';

export const devRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const execFileAsync = promisify(execFile);
export const loaderPath = path.join(devRoot, 'test', 'assembly', 'loader-register.mjs');
export const reportPath = '/mcp';
export const claudeSessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const callerThreadId = '11111111-1111-4111-8111-111111111111';

export function tempRoot() {
  return path.join(devRoot, '.runtime', 'tests', 'assembly-tmp');
}

export async function makeFixtureRoot(t, label) {
  await mkdir(tempRoot(), { recursive: true });
  const root = await mkdtemp(path.join(tempRoot(), `assembly-${label}-`));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(root, 'managed-host'), { recursive: true });
  t?.after?.(() => { /* Artifacts stay under .runtime/tests; no direct deletion. */ });
  return { root, workspace };
}

export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function writeControlConfig({ root, workspace, dsh, reportPort }) {
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    workspace,
    dshDataRoot: path.join(root, 'dsh-home'),
    ...(dsh ? { instanceFile: dsh.instanceFile, hostBridgeFile: dsh.hostBridgeFile } : {}),
    managedStateDirectory: path.join(root, 'managed-host'),
    reportPort,
    timeoutMs: 5000,
  }), 'utf8');
  return configPath;
}

export async function writeClaudeSession({ root, workspace, sessionId = claudeSessionId, pid = process.pid }) {
  const claudeHome = path.join(root, 'claude-home');
  const directory = path.join(claudeHome, 'sessions');
  await mkdir(directory, { recursive: true });
  // A live test process is used as the verified native Claude process. Its real
  // start time lets the production bindClaude path succeed instead of falling
  // back to an "unavailable" return channel.
  let procStart = '0';
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (/^\d+$/.test(stdout.trim())) procStart = stdout.trim();
  } catch { /* the fixture still provides a verified workspace; binding is optional */ }
  await writeFile(path.join(directory, `${pid}.json`), JSON.stringify({
    version: 1, pid, sessionId, entrypoint: 'claude-desktop',
    pidDomain: `win32:${hostname().toLowerCase()}`, procStart,
    cwd: workspace, status: 'active', startedAt: new Date().toISOString(),
    messagingSocketPath: '\\\\.\\pipe\\assembly-claude-inbox',
  }), 'utf8');
  // findTranscript, used by bindClaude, requires exactly one transcript file.
  const projects = path.join(claudeHome, 'projects', 'assembly-project');
  await mkdir(projects, { recursive: true });
  await writeFile(path.join(projects, `${sessionId}.jsonl`), '{}\n', 'utf8');
  return claudeHome;
}

export async function writeCodexHome({ root, configPath }) {
  const home = path.join(root, 'codex-home');
  await mkdir(home, { recursive: true });
  const serverPath = path.join(devRoot, 'src', 'mcp-server.mjs');
  const tomlString = value => JSON.stringify(value);
  const content = [
    'model = "gpt-6-astra"',
    'model_provider = "openai"',
    'model_reasoning_effort = "high"',
    '',
    '[mcp_servers.futureaide]',
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(serverPath)}]`,
    `env = { DSH_CONTROL_CONFIG = ${tomlString(configPath)}, FUTUREAIDE_CONTROL_CONFIG = ${tomlString(configPath)} }`,
    '',
  ].join('\n');
  await writeFile(path.join(home, 'config.toml'), content, 'utf8');
  return home;
}

export function pythonPath() {
  const configured = process.env.FUTUREAIDE_PYTHON;
  if (configured) return configured;
  const bundled = path.join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes',
    'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  return existsSync(bundled) ? bundled : 'py';
}

export function assemblyEnv({
  claudeHome, codexHome, rendererUrl, fakeClaude = false, extra = {},
} = {}) {
  const loader = pathToFileURL(loaderPath).href;
  const previous = process.env.NODE_OPTIONS;
  const importFlag = `--import=${loader}`;
  const nodeOptions = previous?.includes(importFlag) ? previous : [previous, importFlag].filter(Boolean).join(' ');
  const env = {
    ...process.env,
    TEMP: tempRoot(),
    TMP: tempRoot(),
    NODE_OPTIONS: nodeOptions,
    FUTUREAIDE_PYTHON: pythonPath(),
    ...extra,
  };
  if (claudeHome) env.CLAUDE_CONFIG_DIR = claudeHome;
  if (codexHome) env.CODEX_HOME = codexHome;
  if (rendererUrl) env.FUTUREAIDE_ASSEMBLY_RENDERER_URL = rendererUrl;
  if (fakeClaude) {
    env.FUTUREAIDE_ASSEMBLY_FAKE_CLAUDE = '1';
    env.FUTUREAIDE_ASSEMBLY_CLAUDE_SESSION_ID = claudeSessionId;
    env.FUTUREAIDE_ASSEMBLY_CLAUDE_PID = '4242';
  }
  return env;
}

export async function startWorker({ configPath, env, label = 'claude-dsh' }) {
  // Use the production monitor spawn contract: the caller claims the lease and
  // runs the original src/scoped-worker.mjs detached. The test only supplies the
  // isolated environment (loader + fake native identity / renderer URL).
  const config = await loadConfig(configPath);
  const store = new RosterStore(path.join(config.stateDirectory, 'roster.sqlite'));
  let child;
  const spawnProcess = (command, args, options) => {
    child = spawn(command, args, { ...options, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return child;
  };
  await ensureSharedMonitor(config, store, { spawnProcess });
  if (!child) throw new Error('The production monitor spawner did not create a worker.');
  if (!child.spawnargs?.includes(configPath)) {
    throw new Error('The production monitor spawner received a different config; refusing to run an unrelated monitor.');
  }
  let stderr = '';
  let stdout = '';
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    child, store, exited,
    output: () => ({ stdout, stderr }),
    close: async () => {
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
      }
      if (child.exitCode === null) {
        await execFileAsync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
          .catch(() => {});
      }
      try { store.close(); } catch { /* already closed */ }
    },
  };
}

export async function waitForHealth(port, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        const value = await response.json();
        if (value?.ok === true) return value;
      }
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`The assembly report service did not start on port ${port}: ${last?.message ?? 'timeout'}`);
}

export async function connectHttpMcp(port) {
  const client = new Client({ name: 'assembly-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${reportPath}`));
  await client.connect(transport);
  return {
    client,
    close: async () => { await client.close(); },
  };
}

export async function callTool(client, name, args = {}, meta) {
  const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const text = result.content?.find(part => part.type === 'text')?.text;
  let value;
  try { value = text === undefined ? undefined : JSON.parse(text); }
  catch { value = { message: text }; }
  return { isError: result.isError === true, value, result };
}

export async function until(check, { timeoutMs = 15000, intervalMs = 100, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}.`);
}


