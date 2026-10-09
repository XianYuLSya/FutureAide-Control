import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { requireWorkspace } from './config.mjs';

const run = promisify(execFile);
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

// Discover the currently running desktop's own MCP bridge, not a second app-server.
const DISCOVER = String.raw`
$ErrorActionPreference = 'Stop'
$servers = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'app-server' -and $_.CommandLine -match 'CODEX_APP_TOOLS_PIPE_PATH' })
$found = @()
foreach ($server in $servers) {
  $pipe = [regex]::Match($server.CommandLine, 'codex-browser-use-[0-9a-f-]{36}')
  if (-not $pipe.Success) { continue }
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($server.ParentProcessId)"
  if (-not $parent.ExecutablePath) { continue }
  $entry = Join-Path (Split-Path -Parent $parent.ExecutablePath) 'resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs'
  if (Test-Path -LiteralPath $entry) { $found += [pscustomobject]@{ serverPath = $entry; pipePath = ('\\.\pipe\' + $pipe.Value) } }
}
if ($found.Count -ne 1) { throw 'Expected one running Codex desktop bridge.' }
$found[0] | ConvertTo-Json -Compress
`;

export async function discoverCodexBridge() {
  if (process.platform !== 'win32') throw new Error('This local desktop callback is currently implemented for Windows.');
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DISCOVER], {
      windowsHide: true, timeout: 15000, maxBuffer: 32768,
    });
    const value = JSON.parse(stdout);
    if (!value.serverPath || !/^\\\\\.\\pipe\\codex-browser-use-[a-f\d-]+$/i.test(value.pipePath)) {
      throw new Error('Invalid bridge discovery.');
    }
    return value;
  } catch {
    throw new Error('Codex desktop notification bridge is unavailable. Open Codex and retry only after checking delivery status.');
  }
}

export async function callCodexTool(threadId, toolName, args, { discover = discoverCodexBridge } = {}) {
  if (!UUID.test(threadId || '')) throw new Error('Configure a valid target Codex task ID.');
  if (!['read_thread', 'send_message_to_thread'].includes(toolName)) throw new Error('Unsupported Codex bridge operation.');
  const bridge = await discover();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridge.serverPath],
    env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: bridge.pipePath },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'futureaide-control-callback', version: '0.1.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: toolName,
      arguments: args,
      _meta: { 'openai/threadId': threadId },
    }, undefined, { timeout: 20000 });
    if (result.isError) throw new Error('Codex rejected the notification request. Check the target task before retrying.');
    return { accepted: true, threadId };
  } finally {
    await client.close();
  }
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
