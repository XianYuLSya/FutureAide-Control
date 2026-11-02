// CLI subprocess primitives for the external CLI agent runtimes. This module owns
// command construction, the per-agent MCP config, one turn's stdio, and process-tree
// cancellation. It deliberately does not parse runtime output; the worker does that.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const RUNTIMES = new Set(['claude', 'codex']);
const STDERR_TAIL_CHARS = 8192;

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  return nonEmptyString(value, name);
}

/**
 * Build one CLI turn without starting it. Claude gets the stream-json duplex protocol and
 * carries its MCP server in a config file; Codex reads its task from stdin and uses its
 * `exec`/`resume` subcommands. Unknown runtime flags are never invented for either side.
 * @param {object} input Runtime, executable, prompt, native session and MCP config inputs.
 * @returns {{command: string, args: string[], stdinText: string}}
 */
export function buildCliInvocation({ runtime, executable, prompt, nativeSessionId, mcpConfigPath, sessionId, workspace, mcpConfig, model, effort } = {}) {
  if (!RUNTIMES.has(runtime)) throw new TypeError(`Unsupported CLI runtime: ${String(runtime)}. Expected 'claude' or 'codex'.`);
  const command = nonEmptyString(executable ?? runtime, 'executable');
  nonEmptyString(prompt, 'prompt');
  const resumeId = optionalString(nativeSessionId, 'nativeSessionId');
  const configPath = optionalString(mcpConfigPath, 'mcpConfigPath');
  if (runtime === 'claude') {
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json'];
    if (model) args.push('--model', String(model));
    if (effort) args.push('--effort', String(effort));
    if (resumeId) args.push('--resume', resumeId);
    else args.push('--session-id', nonEmptyString(sessionId, 'sessionId'));
    if (configPath) args.push('--strict-mcp-config', '--mcp-config', configPath);
    args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__futureaide__*');
    const stdinText = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }) + '\n';
    return { command, args, stdinText };
  }
  const args = ['exec'];
  if (resumeId) args.push('resume', resumeId, '--json');
  else args.push('--json', '--skip-git-repo-check', '-C', nonEmptyString(workspace, 'workspace'));
  if (model) args.push('--model', String(model));
  if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(String(effort))}`);
  args.push('-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"');
  args.push(...codexMcpArgs(mcpConfig));
  args.push('-');
  return { command, args, stdinText: prompt + '\n' };
}

function codexMcpArgs(mcpConfig) {
  if (!mcpConfig) return [];
  const entry = nonEmptyString(mcpConfig.serverEntry, 'mcpConfig.serverEntry');
  const configFile = nonEmptyString(mcpConfig.configFile, 'mcpConfig.configFile');
  const env = mcpConfig.env ?? {};
  const values = [
    ['mcp_servers.futureaide.command', JSON.stringify(process.execPath)],
    ['mcp_servers.futureaide.args', JSON.stringify([entry, '--config', configFile])],
    ['mcp_servers.futureaide.default_tools_approval_mode', '"approve"'],
    ...Object.entries(env).map(([key, value]) => [`mcp_servers.futureaide.env.${key}`, JSON.stringify(String(value))]),
  ];
  return values.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}

/**
 * Write the token-bearing MCP config for one CLI agent task and return its absolute path.
 * The file is an ordinary write (no temporary rename or cleanup), so an existing directory
 * is only ever added to.
 * @param {object} input Absolute directory, server entry, agent/task identifiers and token.
 * @returns {Promise<string>} Absolute path of the written mcp.json.
 */
export async function createMcpConfig({ directory, serverEntry, agentId, taskId, token, controlConfig } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new TypeError('directory must be an absolute path.');
  }
  const entry = nonEmptyString(serverEntry, 'serverEntry');
  const agent = nonEmptyString(agentId, 'agentId');
  const task = nonEmptyString(taskId, 'taskId');
  const secret = nonEmptyString(token, 'token');
  const absoluteDirectory = path.resolve(directory);
  await mkdir(absoluteDirectory, { recursive: true });
  const filename = path.join(absoluteDirectory, 'mcp.json');
  const config = {
    mcpServers: {
      futureaide: {
        command: process.execPath,
        args: controlConfig ? [entry, '--config', controlConfig] : [entry],
        env: {
          FUTUREAIDE_MANAGED_AGENT: agent,
          FUTUREAIDE_MANAGED_TOKEN: secret,
          FUTUREAIDE_CLI_AGENT_ID: agent,
          FUTUREAIDE_CLI_TASK_ID: task,
          FUTUREAIDE_CLI_TOKEN: secret,
          ...(controlConfig ? { FUTUREAIDE_CONTROL_CONFIG: controlConfig } : {}),
        },
      },
    },
  };
  await writeFile(filename, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return filename;
}

/**
 * Register the same child MCP server in a Codex private home's config.toml.
 * Existing user tables are preserved; only the marked managed block is replaced.
 * @param {object} input Absolute Codex home, server entry, agent/task identifiers and token.
 * @returns {Promise<string>} Absolute path of the written config.toml.
 */
export async function createCodexMcpConfig({ directory, serverEntry, agentId, taskId, token, controlConfig } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new TypeError('directory must be an absolute path.');
  }
  const entry = nonEmptyString(serverEntry, 'serverEntry');
  const agent = nonEmptyString(agentId, 'agentId');
  const task = nonEmptyString(taskId, 'taskId');
  const secret = nonEmptyString(token, 'token');
  const absoluteDirectory = path.resolve(directory);
  await mkdir(absoluteDirectory, { recursive: true });
  const filename = path.join(absoluteDirectory, 'config.toml');
  let existing = '';
  try { existing = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const begin = '# futureaide-cli-agent:begin';
  const end = '# futureaide-cli-agent:end';
  const toml = value => JSON.stringify(String(value));
  const block = [
    begin,
    '[mcp_servers.futureaide]',
    `command = ${toml(process.execPath)}`,
    `args = [${controlConfig ? `${toml(entry)}, "--config", ${toml(controlConfig)}` : toml(entry)}]`,
    `env = { FUTUREAIDE_MANAGED_AGENT = ${toml(agent)}, FUTUREAIDE_MANAGED_TOKEN = ${toml(secret)}, FUTUREAIDE_CLI_AGENT_ID = ${toml(agent)}, FUTUREAIDE_CLI_TASK_ID = ${toml(task)}, FUTUREAIDE_CLI_TOKEN = ${toml(secret)}${controlConfig ? `, FUTUREAIDE_CONTROL_CONFIG = ${toml(controlConfig)}` : ''} }`,
    end,
    '',
  ].join('\n');
  const managed = new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
  const next = managed.test(existing) ? existing.replace(managed, block) : `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}`;
  await writeFile(filename, next, { encoding: 'utf8', mode: 0o600 });
  return filename;
}

/** Split UTF-8 chunks into complete lines while retaining the final unterminated line. */
function createLineReader(onLine) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let finished = false;
  const emit = line => onLine(line);
  return {
    write(chunk) {
      if (finished) return;
      pending += decoder.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        let line = pending.slice(0, newline);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        pending = pending.slice(newline + 1);
        emit(line);
      }
    },
    end() {
      if (finished) return;
      finished = true;
      pending += decoder.end();
      if (pending.length > 0) {
        let line = pending;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        pending = '';
        emit(line);
      }
    },
  };
}

/**
 * Start one CLI turn, feed its stdin, stream complete stdout/stderr lines to callbacks, and
 * settle only after the child and its pipes have closed. The last partial line is flushed.
 * Output is passed through untouched; JSON parsing belongs to the caller.
 * @param {object} input Command line, stdin, working directory, environment and callbacks.
 * @returns {Promise<{exitCode: number|null, signal: string|null, stderrTail: string}>}
 */
export function spawnCliTurn({
  command,
  args,
  stdinText = '',
  cwd,
  env,
  onStdoutLine,
  onStderrLine,
  onSpawn,
  spawn = nodeSpawn,
} = {}) {
  return new Promise((resolve, reject) => {
    if (typeof command !== 'string' || !command.trim()) throw new TypeError('command must be a non-empty string.');
    if (!Array.isArray(args)) throw new TypeError('args must be an array.');
    if (typeof stdinText !== 'string') throw new TypeError('stdinText must be a string.');
    for (const [name, callback] of [['onStdoutLine', onStdoutLine], ['onStderrLine', onStderrLine], ['onSpawn', onSpawn]]) {
      if (callback !== undefined && typeof callback !== 'function') throw new TypeError(`${name} must be a function.`);
    }
    let child;
    let settled = false;
    let stderrTail = '';
    const stderrDecoder = new StringDecoder('utf8');
    const fail = error => {
      if (settled) return;
      settled = true;
      try { child?.kill(); } catch { /* The process may already have exited. */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const stdout = createLineReader(line => {
      if (settled) return;
      try { onStdoutLine?.(line); } catch (error) { fail(error); }
    });
    const stderr = createLineReader(line => {
      if (settled) return;
      try { onStderrLine?.(line); } catch (error) { fail(error); }
    });
    try {
      const spawnOptions = { stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' };
      if (cwd !== undefined) spawnOptions.cwd = cwd;
      if (env !== undefined) spawnOptions.env = env;
      child = spawn(command, args, spawnOptions);
    } catch (error) {
      fail(error);
      return;
    }
    child.on('error', fail);
    child.stdout?.on('data', chunk => stdout.write(chunk));
    child.stderr?.on('data', chunk => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      stderrTail = (stderrTail + stderrDecoder.write(bytes)).slice(-STDERR_TAIL_CHARS);
      stderr.write(chunk);
    });
    child.stdout?.on('end', () => stdout.end());
    child.stderr?.on('end', () => stderr.end());
    child.stdout?.on('error', fail);
    child.stderr?.on('error', fail);
    child.stdin?.on('error', error => {
      // A closed pipe after an early exit is reported by exitCode, not as a helper failure.
      if (error?.code !== 'EPIPE') fail(error);
    });
    if (typeof onSpawn === 'function' && child.pid !== undefined) {
      try { onSpawn(child.pid); } catch (error) { fail(error); return; }
    }
    try {
      if (!child.stdin) throw new Error('CLI stdin pipe is unavailable.');
      child.stdin.end(stdinText);
    } catch (error) {
      fail(error);
    }
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      stdout.end();
      stderr.end();
      stderrTail = (stderrTail + stderrDecoder.end()).slice(-STDERR_TAIL_CHARS);
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, stderrTail });
    });
  });
}

/**
 * Cancel a CLI process tree. Windows uses taskkill /T; POSIX kills the process group.
 * Invalid identifiers and any kill failure return false without throwing.
 * @param {number} pid Positive process id.
 * @param {object} [options] Test seams for the platform, spawn and kill primitives.
 * @returns {Promise<boolean>}
 */
export async function killProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const { platform = process.platform, spawn = nodeSpawn, kill = process.kill } = options ?? {};
  try {
    if (platform === 'win32') {
      return await new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        child.once('error', () => finish(false));
        child.once('exit', code => finish(code === 0));
        child.once('close', code => finish(code === 0));
      });
    }
    return kill(-pid, 'SIGTERM') !== false;
  } catch {
    return false;
  }
}
