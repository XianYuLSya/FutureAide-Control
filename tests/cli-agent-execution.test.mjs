import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildCliInvocation, createCodexMcpConfig, createMcpConfig, killProcessTree, spawnCliTurn } from '../src/cli-agent-execution.mjs';

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

test('claude starts a new stream-json session with model, effort, verbose and strict MCP config', () => {
  const prompt = 'inspect "quoted" input\nsecond line';
  const invocation = buildCliInvocation({ runtime: 'claude', executable: 'claude.exe', prompt, sessionId: SESSION, mcpConfigPath: MCP, model: 'claude-test', effort: 'high' });
  assert.equal(invocation.command, 'claude.exe');
  assert.deepEqual(invocation.args, [
    '-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--model', 'claude-test', '--effort', 'high',
    '--session-id', SESSION, '--strict-mcp-config', '--mcp-config', MCP,
    '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__futureaide__*',
  ]);
  assert.equal(invocation.stdinText, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  }) + '\n');
  assert.equal(invocation.stdinText.split('\n').length, 2);
});

test('claude resumes a native session instead of assigning a new session id', () => {
  const invocation = buildCliInvocation({ runtime: 'claude', prompt: 'continue', nativeSessionId: NATIVE, sessionId: SESSION, mcpConfigPath: MCP });
  assert.deepEqual(invocation.args, [
    '-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--resume', NATIVE, '--strict-mcp-config', '--mcp-config', MCP,
    '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__futureaide__*',
  ]);
  assert.ok(!invocation.args.includes('--session-id'));
});

test('codex invokes exec from stdin, registers MCP config, and resumes with its native session', () => {
  const workspace = 'D:\\fixture\\workspace';
  const mcpConfig = {
    serverEntry: 'D:\\fixture\\src\\mutual-server.mjs',
    configFile: 'D:\\fixture\\config.json',
    env: { FUTUREAIDE_MANAGED_AGENT: 'agent-test', FUTUREAIDE_MANAGED_TOKEN: 'secret-token' },
  };
  const fresh = buildCliInvocation({ runtime: 'codex', executable: 'codex.exe', prompt: 'do work', workspace, mcpConfig });
  assert.equal(fresh.command, 'codex.exe');
  assert.deepEqual(fresh.args.slice(0, 4), ['exec', '--json', '--skip-git-repo-check', '-C']);
  assert.equal(fresh.args[4], workspace);
  assert.ok(fresh.args.includes('-c'));
  assert.ok(fresh.args.some(argument => argument.startsWith('mcp_servers.futureaide.command=')));
  assert.ok(fresh.args.some(argument => argument.startsWith('mcp_servers.futureaide.args=')));
  assert.ok(fresh.args.some(argument => argument.startsWith('mcp_servers.futureaide.env.FUTUREAIDE_MANAGED_AGENT=')));
  assert.equal(fresh.args.at(-1), '-');
  assert.equal(fresh.stdinText, 'do work\n');

  const resumed = buildCliInvocation({ runtime: 'codex', prompt: 'continue', nativeSessionId: NATIVE, workspace, mcpConfig });
  assert.deepEqual(resumed.args.slice(0, 4), ['exec', 'resume', NATIVE, '--json']);
  assert.ok(!resumed.args.includes('-C'));
  assert.equal(resumed.args.at(-1), '-');
  assert.equal(resumed.stdinText, 'continue\n');
});

test('unknown runtimes and missing required invocation values are rejected', () => {
  assert.throws(() => buildCliInvocation({ runtime: 'other', prompt: 'work', sessionId: SESSION }), /Unsupported CLI runtime/);
  assert.equal(buildCliInvocation({ runtime: 'claude', prompt: 'work', sessionId: SESSION }).command, 'claude');
  assert.throws(() => buildCliInvocation({ runtime: 'claude', executable: '', prompt: 'work', sessionId: SESSION }), /executable/);
  assert.throws(() => buildCliInvocation({ runtime: 'claude', executable: 'claude', sessionId: SESSION }), /prompt/);
  assert.throws(() => buildCliInvocation({ runtime: 'claude', executable: 'claude', prompt: 'work' }), /sessionId/);
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

test('codex private config registers the child server and preserves existing tables', async () => {
  const directory = await tempDirectory();
  const config = path.join(directory, 'config.toml');
  await writeFile(config, '[model_providers.keep]\nname = "keep"\n', 'utf8');
  const input = { directory, serverEntry: path.join(workspaceRoot, 'src', 'mutual-server.mjs'),
    agentId: 'agent-test', taskId: 'task-test', token: 'secret-token' };
  const filename = await createCodexMcpConfig(input);
  const first = await readFile(filename, 'utf8');
  assert.match(first, /\[model_providers\.keep\]/);
  assert.match(first, /\[mcp_servers\.futureaide\]/);
  assert.match(first, /FUTUREAIDE_MANAGED_AGENT/);
  assert.match(first, /FUTUREAIDE_MANAGED_TOKEN/);
  await createCodexMcpConfig({ ...input, token: 'replacement-token' });
  const second = await readFile(filename, 'utf8');
  assert.equal((second.match(/\[mcp_servers\.futureaide\]/g) ?? []).length, 1);
  assert.match(second, /replacement-token/);
  assert.match(second, /\[model_providers\.keep\]/);
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
