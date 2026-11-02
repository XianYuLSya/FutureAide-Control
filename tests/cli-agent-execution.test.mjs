import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildCliInvocation, createMcpConfig, killProcessTree, spawnCliTurn } from '../src/cli-agent-execution.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.dirname(testRoot);
const cleanRoot = path.join(workspaceRoot, 'clean');

// Tests only create fresh directories under the workspace-owned clean/ tree; nothing is removed.
async function tempDirectory() {
  await mkdir(cleanRoot, { recursive: true });
  return mkdtemp(path.join(cleanRoot, 'cli-agent-execution-'));
}

const SESSION = '11111111-1111-4111-8111-111111111111';
const NATIVE = '22222222-2222-4222-8222-222222222222';
const MCP = String.raw`D:\work\agent\mcp.json`;

test('Codex and Claude CLI construction is refused before argument validation', () => {
  const complete = {
    runtime: 'codex',
    executable: 'codex.exe',
    prompt: 'do work',
    nativeSessionId: NATIVE,
    mcpConfigPath: MCP,
    sessionId: SESSION,
    workspace: 'D:\\fixture\\workspace',
    mcpConfig: {
      serverEntry: 'D:\\fixture\\src\\mutual-server.mjs',
      configFile: 'D:\\fixture\\config.json',
      env: { FUTUREAIDE_MANAGED_AGENT: 'agent-test', FUTUREAIDE_MANAGED_TOKEN: 'secret-token' },
    },
    model: 'gpt-5',
    effort: 'high',
  };
  assert.throws(() => buildCliInvocation(complete), { code: 'codex-desktop-required' });
  assert.throws(() => buildCliInvocation({ ...complete, runtime: 'claude' }), { code: 'claude-desktop-required' });
  assert.throws(() => buildCliInvocation({ runtime: 'other', prompt: 'work' }), /Unsupported CLI runtime/);
  assert.throws(() => buildCliInvocation({ runtime: 'codex', executable: '', prompt: '' }), { code: 'codex-desktop-required' });
  assert.throws(() => buildCliInvocation({ runtime: 'claude', executable: '', prompt: '' }), { code: 'claude-desktop-required' });
});

test('the MCP config has the exact child-server shape and leaves existing files alone', async () => {
  const directory = await tempDirectory();
  await writeFile(path.join(directory, 'keep.txt'), 'keep', 'utf8');
  const serverEntry = path.join(workspaceRoot, 'src', 'mcp-server.mjs');
  const controlConfig = path.join(directory, 'config.json');
  const filename = await createMcpConfig({
    directory,
    serverEntry,
    agentId: 'agent-test',
    taskId: 'task-test',
    token: 'secret-token',
    controlConfig,
  });
  assert.equal(filename, path.join(directory, 'mcp.json'));
  assert.ok(path.isAbsolute(filename));
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), {
    mcpServers: {
      futureaide: {
        command: process.execPath,
        args: [serverEntry, '--config', controlConfig],
        env: {
          FUTUREAIDE_MANAGED_AGENT: 'agent-test',
          FUTUREAIDE_MANAGED_TOKEN: 'secret-token',
          FUTUREAIDE_CLI_AGENT_ID: 'agent-test',
          FUTUREAIDE_CLI_TASK_ID: 'task-test',
          FUTUREAIDE_CLI_TOKEN: 'secret-token',
          FUTUREAIDE_CONTROL_CONFIG: controlConfig,
        },
      },
    },
  });
  assert.equal(await readFile(path.join(directory, 'keep.txt'), 'utf8'), 'keep');
});

test('the MCP config rejects a relative directory and an empty token', async () => {
  const input = { serverEntry: path.join(workspaceRoot, 'src', 'mcp-server.mjs'), agentId: 'agent', taskId: 'task', token: 'token' };
  await assert.rejects(createMcpConfig({ ...input, directory: 'relative/path' }), /absolute path/);
  await assert.rejects(createMcpConfig({ ...input, directory: await tempDirectory(), token: '' }), /token/);
  await assert.rejects(createMcpConfig({ ...input, directory: await tempDirectory(), token: '   ' }), /token/);
});

test('spawnCliTurn feeds stdin, buffers split lines, keeps the last line and reports exit', async () => {
  const script = [
    "process.stdin.setEncoding('utf8');",
    "let input = '';",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  process.stdout.write('stdin:' + JSON.stringify(input) + '\\n');",
    "  process.stdout.write('first');",
    "  setTimeout(() => {",
    "    process.stdout.write(' line\\nsecond');",
    "    process.stderr.write('warning one\\nwarn');",
    "    setTimeout(() => {",
    "      process.stdout.write(' line\\n');",
    "      process.stdout.write(Buffer.from([0xe4]));",
    "      setTimeout(() => {",
    "        process.stdout.write(Buffer.from([0xb8, 0xad, 0x0a]));",
    "        process.stdout.write('tail');",
    "        process.stderr.write('ing two\\n');",
    "        process.exitCode = 3;",
    "      }, 10);",
    "    }, 10);",
    "  }, 10);",
    "});",
  ].join('\n');
  const stdinText = 'hello\nsecond line';
  const stdoutLines = [];
  const stderrLines = [];
  let spawnedPid;
  const result = await spawnCliTurn({
    command: process.execPath,
    args: ['-e', script],
    stdinText,
    cwd: workspaceRoot,
    onStdoutLine: line => stdoutLines.push(line),
    onStderrLine: line => stderrLines.push(line),
    onSpawn: pid => { spawnedPid = pid; },
  });
  assert.ok(Number.isInteger(spawnedPid) && spawnedPid > 0);
  assert.deepEqual(stdoutLines, [`stdin:${JSON.stringify(stdinText)}`, 'first line', 'second line', '中', 'tail']);
  assert.deepEqual(stderrLines, ['warning one', 'warning two']);
  assert.equal(result.exitCode, 3);
  assert.equal(result.signal, null);
  assert.equal(result.stderrTail, 'warning one\nwarning two\n');
});

test('spawnCliTurn rejects when the executable cannot be started', async () => {
  const missing = path.join(await tempDirectory(), `missing-${process.pid}.exe`);
  await assert.rejects(spawnCliTurn({ command: missing, args: [], stdinText: '' }), error => error?.code === 'ENOENT');
});

test('killProcessTree rejects every invalid pid without touching a process', async () => {
  for (const pid of [0, -1, 1.5, NaN, Infinity, '123', null, undefined]) {
    assert.equal(await killProcessTree(pid), false, String(pid));
  }
});

test('killProcessTree uses taskkill /PID /T /F on Windows through an injectable spawn', async () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  assert.equal(await killProcessTree(4321, { platform: 'win32', spawn }), true);
  assert.deepEqual(calls, [{ command: 'taskkill.exe', args: ['/PID', '4321', '/T', '/F'], options: { stdio: 'ignore', windowsHide: true } }]);
  const failure = new EventEmitter();
  assert.equal(await killProcessTree(4321, { platform: 'win32', spawn: () => {
    queueMicrotask(() => failure.emit('error', new Error('taskkill failed')));
    return failure;
  } }), false);
});

test('killProcessTree targets the process group on POSIX and swallows failures', async () => {
  const calls = [];
  const kill = (pid, signal) => { calls.push([pid, signal]); return true; };
  assert.equal(await killProcessTree(98, { platform: 'linux', kill }), true);
  assert.deepEqual(calls, [[-98, 'SIGTERM']]);
  assert.equal(await killProcessTree(98, { platform: 'linux', kill: () => { throw new Error('no such process'); } }), false);
});
