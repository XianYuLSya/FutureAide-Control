import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { requireWorkspace } from './config.mjs';

const run = promisify(execFile);
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

// The desktop hands its app-tools pipe to the processes it starts, so an inherited
// CODEX_APP_TOOLS_PIPE_PATH names this desktop's bridge even though the app-server command line no
// longer carries the pipe. Current desktops name that pipe codex-app-tools-<uuid>; older builds
// named it codex-browser-use-<uuid>. Without an inherited value the bridge is identified by owning
// process: a candidate must be served by the desktop found in a real local app-server's parent
// chain, and only a candidate that answers the app-tools tool list is a bridge (the desktop serves
// its other pipes from the same process). Older desktops that still put the pipe on the app-server
// command line stay usable through the legacy list. PowerShell only locates the bundled app-tools
// entry point behind that chain; the shells that run this very script spell "app-server" on their
// own command line and must not match. No process environment is read, and nothing is ever sent to
// a task.
const DISCOVER = String.raw`
$ErrorActionPreference = 'Stop'
$hosted = @()
$legacy = @()
$desktops = @()
$processes = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($process in $processes) { $byId[[int]$process.ProcessId] = $process }
$servers = @($processes | Where-Object {
  $_.ProcessId -ne $PID -and $_.Name -notmatch '^(pwsh|powershell|cmd|wsl|bash)\.exe$' -and $_.CommandLine -match '\bapp-server\b' })
function Get-DesktopHost($process) {
  $current = $process
  for ($depth = 0; $depth -lt 8 -and $current; $depth++) {
    if (-not $current.ExecutablePath) { return $null }
    $root = Split-Path -Parent $current.ExecutablePath
    # The packaged desktop keeps bundled plugins under resources; another layout may nest the whole
    # app one level down. Only an existing app-tools entry point behind a real app-server counts.
    $entry = @(
      (Join-Path $root 'resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs'),
      (Join-Path $root 'app\resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($entry) { return [pscustomobject]@{ desktop = [int]$current.ProcessId; serverPath = $entry } }
    if ($current.ParentProcessId -le 0) { break }
    $current = $byId[[int]$current.ParentProcessId]
  }
  return $null
}
foreach ($server in $servers) {
  $parent = $byId[[int]$server.ParentProcessId]
  $desktopHost = Get-DesktopHost $parent
  if (-not $desktopHost) { continue }
  $hosted += $desktopHost.serverPath
  $desktops += $desktopHost
  $pipe = [regex]::Match($server.CommandLine, 'codex-(?:browser-use|app-tools)-[0-9a-f-]{36}')
  if ($pipe.Success) { $legacy += [pscustomobject]@{ serverPath = $desktopHost.serverPath; pipePath = ('\\.\pipe\' + $pipe.Value) } }
}
$candidates = @()
$desktops = @($desktops | Group-Object -Property desktop | ForEach-Object { $_.Group[0] })
if (@($desktops).Count -gt 0) {
  # Owner lookup only: the pipe handle is opened without access rights and closed immediately, and a
  # desktop that cannot answer this loses only its candidates, never the inherited or legacy paths.
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BridgePipeOwner {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr templateHandle);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetNamedPipeServerProcessId(IntPtr handle, out uint serverProcessId);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
    function Get-BridgePipeOwner($path) {
      $handle = [BridgePipeOwner]::CreateFileW($path, 0, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
      if ($handle.ToInt64() -eq -1) { return 0 }
      try {
        $owner = [uint32]0
        if ([BridgePipeOwner]::GetNamedPipeServerProcessId($handle, [ref]$owner)) { return [int]$owner }
        return 0
      } finally {
        [void][BridgePipeOwner]::CloseHandle($handle)
      }
    }
    foreach ($path in @([System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -match 'codex-(?:browser-use|app-tools)-[0-9a-f-]{36}$' })) {
      $owner = Get-BridgePipeOwner $path
      if ($owner -le 0) { continue }
      $desktop = @($desktops | Where-Object { $_.desktop -eq $owner })
      if ($desktop.Count -ne 1) { continue }
      $candidates += [pscustomobject]@{ serverPath = $desktop[0].serverPath; pipePath = $path }
    }
  } catch {
    $candidates = @()
  }
}
[pscustomobject]@{ hosted = @($hosted | Select-Object -Unique); legacy = @($legacy); candidates = @($candidates) } | ConvertTo-Json -Compress -Depth 4
`;

const BRIDGE_PIPE = /^\\\\\.\\pipe\\(?:codex-browser-use|codex-app-tools)-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const ALLOWED_TOOLS = new Set(['read_thread', 'send_message_to_thread', 'list_threads', 'fork_thread', 'set_thread_archived']);
const UNAVAILABLE = 'Codex desktop bridge is unavailable. Open Codex and retry only after checking delivery status.';
const AMBIGUOUS = 'More than one Codex bridge answers for this desktop; refusing to guess which one to use. Close the extra desktop or call from the task that owns this bridge.';
const INVALID_PIPE = 'CODEX_APP_TOOLS_PIPE_PATH is not a Codex desktop bridge pipe; refusing to guess which desktop to use.';
const INVALID_BRIDGE = 'The explicit Codex bridge must name the bundled app-tools server.mjs; a standalone Codex CLI or app-server is never started as a fallback.';
const REJECTED = 'Codex rejected the bridge request. Check the target task before retrying.';
const INCOMPLETE = 'Codex bridge returned an incomplete tool result; refusing to treat it as accepted.';

// A local bridge pipe answers within milliseconds, so a silent candidate is simply not this bridge.
const PROBE_TIMEOUT_MS = 1000;
const FRAME_BYTES = 4;

function list(value) {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

// Only the desktop's own pipe name may be used, so a foreign value cannot reach another instance.
export function parseBridgePipe(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return BRIDGE_PIPE.test(candidate) ? candidate : null;
}

function uniqueBridges(value) {
  const bridges = list(value)
    .map(entry => ({ serverPath: typeof entry?.serverPath === 'string' ? entry.serverPath.trim() : '', pipePath: parseBridgePipe(entry?.pipePath) }))
    .filter(entry => entry.serverPath && entry.pipePath);
  return bridges.filter((bridge, index) => bridges.findIndex(other => other.serverPath === bridge.serverPath && other.pipePath === bridge.pipePath) === index);
}

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(FRAME_BYTES);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

// The desktop speaks length-prefixed JSON-RPC on this pipe, so the bridge is the candidate that
// answers a read-only tools/list: a real tools array, never another service of the same desktop.
// Nothing else is written, the socket is closed immediately, and a closed, silent or malformed
// answer only rejects that candidate.
export function probeAppToolsBridge(pipePath, { timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const socket = net.createConnection(pipePath);
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = found => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(found);
    };
    const timer = setTimeout(() => finish(false), timeout);
    socket.on('error', () => finish(false));
    socket.on('connect', () => socket.write(encodeFrame(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }))));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < FRAME_BYTES) return;
      const length = received.readUInt32LE(0);
      if (received.length < length + FRAME_BYTES) return;
      let frame;
      try {
        frame = JSON.parse(received.subarray(FRAME_BYTES, length + FRAME_BYTES).toString('utf8'));
      } catch {
        finish(false);
        return;
      }
      finish(Array.isArray(frame?.result?.tools) && frame.result.tools.length > 0);
    });
  });
}

// An inherited pipe wins, a probed bridge of this very desktop comes next, the command-line pipe of
// older desktops is the fallback, and several plausible bridges fail instead of being guessed.
export function selectCodexBridge({ envPipe = null, hosted, legacy, verified } = {}) {
  const hosts = [...new Set(list(hosted).filter(entry => typeof entry === 'string' && entry.trim()).map(entry => entry.trim()))];
  if (envPipe) {
    const pipePath = parseBridgePipe(envPipe);
    if (!pipePath) throw new Error(INVALID_PIPE);
    if (hosts.length > 1) throw new Error(AMBIGUOUS);
    if (hosts.length === 1) return { serverPath: hosts[0], pipePath };
  }
  const answered = uniqueBridges(verified);
  if (answered.length > 1) throw new Error(AMBIGUOUS);
  if (answered.length === 1) return answered[0];
  const bridges = uniqueBridges(legacy);
  if (bridges.length > 1) throw new Error(AMBIGUOUS);
  if (bridges.length === 1) return bridges[0];
  throw new Error(UNAVAILABLE);
}

// The PowerShell payload is mapped in one place, so no field can be dropped between the inspection
// and the selection that relies on it.
export function parseInspection(stdout) {
  const value = JSON.parse(stdout);
  return { hosted: list(value?.hosted), legacy: list(value?.legacy), candidates: list(value?.candidates) };
}

async function inspectCodexProcesses() {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DISCOVER], {
    windowsHide: true, timeout: 15000, maxBuffer: 32768,
  });
  return parseInspection(stdout);
}

// Candidates are only pipes served by the parent desktop of a real local app-server, so neither
// another desktop nor an unrelated pipe can be selected; a probe that throws or a bridge that stays
// silent rejects only that one candidate.
async function verifyBridges(candidates, probe) {
  const answers = await Promise.all(uniqueBridges(candidates).map(async candidate => {
    let found = false;
    try {
      found = (await probe(candidate.pipePath)) === true;
    } catch {
      found = false;
    }
    return found ? candidate : null;
  }));
  return answers.filter(Boolean);
}

export async function discoverCodexBridge({ environment = process.env, inspect = inspectCodexProcesses, probe = probeAppToolsBridge } = {}) {
  if (process.platform !== 'win32') throw new Error('This local desktop callback is currently implemented for Windows.');
  const inherited = environment?.CODEX_APP_TOOLS_PIPE_PATH;
  const declared = typeof inherited === 'string' ? inherited.trim() : '';
  if (declared && !parseBridgePipe(declared)) throw new Error(INVALID_PIPE);
  let processes;
  try {
    processes = await inspect();
  } catch (error) {
    throw new Error(UNAVAILABLE, { cause: error });
  }
  const verified = declared ? [] : await verifyBridges(processes?.candidates, probe);
  return selectCodexBridge({ envPipe: declared || null, hosted: processes?.hosted, legacy: processes?.legacy, verified });
}

// An explicit bridge is only a locator for the desktop's own app-tools server. It must name the
// bundled server.mjs, so no standalone codex CLI or app-server can ever be started as a quiet
// fallback when discovery fails.
function explicitBridge(value) {
  const serverPath = typeof value?.serverPath === 'string' ? value.serverPath.trim() : '';
  const pipePath = parseBridgePipe(value?.pipePath);
  if (!serverPath || !pipePath || !path.isAbsolute(serverPath) || path.basename(serverPath).toLowerCase() !== 'server.mjs') {
    throw new Error(INVALID_BRIDGE);
  }
  return { serverPath, pipePath };
}

// The SDK validates the MCP envelope, but an injected or older bridge can still return a shape the
// caller must not mistake for a successful answer. Content is allowed to be empty here; the
// acceptance path below requires a real payload.
function assertMcpResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.content)) throw new Error(INCOMPLETE);
  if (result.isError !== undefined && typeof result.isError !== 'boolean') throw new Error(INCOMPLETE);
  if (!result.content.every(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.type === 'string')) throw new Error(INCOMPLETE);
  return result;
}

function assertAcceptedToolResult(result) {
  if (result?.isError === true) throw new Error(REJECTED);
  assertMcpResult(result);
  if (result.content.length === 0) throw new Error(INCOMPLETE);
}

/**
 * Invoke one of the desktop's coordination tools and return the complete MCP result. This is a
 * general read/write bridge: read_thread reads, while send_message_to_thread posts only when the
 * caller explicitly asks for it. A tool-level failure is returned in `isError` unchanged so the
 * caller can tell a rejected send from an accepted one; callCodexTool adds the strict acceptance
 * check. `options.bridge` explicitly locates the bundled app-tools server; otherwise discovery
 * runs. No model request is started.
 * @param {string} threadId
 * @param {'read_thread'|'send_message_to_thread'} toolName
 * @param {object} args
 * @param {{discover?: Function, bridge?: {serverPath: string, pipePath: string}, timeoutMs?: number}} [options]
 * @returns {Promise<object>} MCP CallToolResult, including content and isError.
 */
export async function invokeCodexTool(threadId, toolName, args, options = {}) {
  if (!UUID.test(threadId || '')) throw new Error('Configure a valid target Codex task ID.');
  if (!ALLOWED_TOOLS.has(toolName)) throw new Error('Unsupported Codex bridge operation.');
  const toolArguments = args === undefined ? {} : args;
  if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments)) throw new Error('Codex bridge arguments must be an object.');
  const bridge = options?.bridge === undefined
    ? await (options?.discover ?? discoverCodexBridge)()
    : explicitBridge(options.bridge);
  const serverPath = typeof bridge?.serverPath === 'string' ? bridge.serverPath.trim() : '';
  const pipePath = parseBridgePipe(bridge?.pipePath);
  if (!serverPath || !pipePath || !path.isAbsolute(serverPath) || path.basename(serverPath).toLowerCase() !== 'server.mjs') {
    throw new Error(UNAVAILABLE);
  }
  const timeout = options?.timeoutMs ?? 20000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('Codex bridge timeout must be a positive integer.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipePath },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'futureaide-control-callback', version: '0.1.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: toolName,
      arguments: toolArguments,
      _meta: { 'openai/threadId': threadId },
    }, undefined, { timeout });
    return assertMcpResult(result);
  } finally {
    await client.close();
  }
}

// Existing notification callers rely on the small acceptance contract, not on raw MCP data. The
// optional `invoke` seam keeps that contract testable while the default reuses invokeCodexTool.
export async function callCodexTool(threadId, toolName, args, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const invoke = settings.invoke ?? invokeCodexTool;
  const result = await invoke(threadId, toolName, args, settings);
  assertAcceptedToolResult(result);
  return { accepted: true, threadId };
}

export function notificationText(config, { event, summary, evidence }) {
  const label = event === 'test' ? '连接测试，不是完成报告' : event === 'completed' ? '执行方声明完成，尚待独立验收' : '执行方受阻，需要协调';
  return [
    `[FutureAide 通知] ${label}`,
    `项目：${config.workspace}`,
    `执行母会话：${config.futureaideSessionId || '未指定'}`,
    `执行方摘要（待核验数据）：${summary}`,
    ...(evidence ? [`证据：${evidence}`] : []),
    event === 'test'
      ? '请继续当前接口和通知集成任务，不将本测试视为产品完成。'
      : '请按目标 Codex 任务已有的用户授权、该项目最新范围及所附证据独立核对。完成声明不等于验收通过；未完成则在授权内协调修复。发布遵循该项目约定，本通知不扩张权限。',
  ].join('\n');
}

async function saveRecord(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, filename);
}

export async function notifyCodex(config, input, { callTool = callCodexTool } = {}) {
  if (!['completed', 'blocked', 'test'].includes(input.event)) throw new Error('Event must be completed, blocked, or test.');
  if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 4000) throw new Error('A summary of 1-4000 characters is required.');
  if (!UUID.test(config.codexThreadId || '')) throw new Error('No valid Codex target task configured.');
  let evidence;
  let evidenceHash = '';
  if (input.evidence) {
    evidence = path.resolve(config.workspace, input.evidence);
    if (!requireWorkspace(evidence, config.workspace)) throw new Error('Evidence must belong to the configured project.');
    const actual = await realpath(evidence);
    if (!requireWorkspace(actual, await realpath(config.workspace))) throw new Error('Evidence resolves outside the configured project.');
    const metadata = await stat(actual);
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) throw new Error('Evidence must be a file no larger than 8 MiB.');
    const content = await readFile(actual);
    evidenceHash = createHash('sha256').update(content).digest('hex');
  }
  const key = createHash('sha256').update(JSON.stringify([config.codexThreadId, config.futureaideSessionId, input.event, input.summary, evidenceHash])).digest('hex');
  const filename = path.join(config.stateDirectory, 'notifications', `${key}.json`);
  await mkdir(path.dirname(filename), { recursive: true });
  const record = { key, event: input.event, threadId: config.codexThreadId, status: 'sending', createdAt: new Date().toISOString() };
  try {
    await writeFile(filename, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      previous = { status: 'sending' };
    }
    return { duplicate: true, delivered: previous.status === 'accepted', status: previous.status, receipt: filename };
  }
  try {
    await callTool(config.codexThreadId, 'send_message_to_thread', {
      threadId: config.codexThreadId,
      prompt: notificationText(config, { ...input, evidence }),
    });
    await saveRecord(filename, { ...record, status: 'accepted', acceptedAt: new Date().toISOString() });
    return { delivered: true, threadId: config.codexThreadId, receipt: filename };
  } catch (error) {
    await saveRecord(filename, { ...record, status: 'unknown', error: 'No confirmed delivery. Inspect the target task before resending.' });
    throw new Error('Notification delivery is unconfirmed; it will not be retried automatically. Receipt: ' + filename, { cause: error });
  }
}
