// CLI targets are disabled; native Desktop hosts are not connected yet. This module
// retains only the per-agent MCP config, one turn's stdio plumbing and process-tree
// cancellation. It must never construct an independent Claude or Codex command line.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const STDERR_TAIL_CHARS = 8192;

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

/**
 * CLI target construction is disabled. Both native Desktop hosts are not connected;
 * every call is refused before executable or prompt validation and before any argument
 * construction. Unknown runtimes remain a programming error.
 * @param {{runtime?: string}} input Runtime selector.
 * @throws {Error & {code: string}} codex-desktop-required or claude-desktop-required.
 */
export function buildCliInvocation({ runtime } = {}) {
  if (runtime === 'codex') {
    throw Object.assign(new Error('Native Codex Desktop target dispatch is not connected. Independent Codex CLI execution and credential reuse are prohibited.'), { code: 'codex-desktop-required' });
  }
  if (runtime === 'claude') {
    throw Object.assign(new Error('Native Claude Desktop target dispatch is not connected. Independent Claude CLI execution and credential reuse are prohibited.'), { code: 'claude-desktop-required' });
  }
  throw new TypeError(`Unsupported CLI runtime: ${String(runtime)}. CLI targets are disabled.`);
}

/**
 * Write the per-agent MCP config and return its absolute path.
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
 * Start one managed turn, feed its stdin, stream complete stdout/stderr lines to callbacks,
 * and settle only after the child and its pipes have closed. The last partial line is flushed.
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
      if (!child.stdin) throw new Error('Child stdin pipe is unavailable.');
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
 * Cancel a child process tree. Windows uses taskkill /T; POSIX kills the process group.
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
