// One detached Claude CLI turn. Started by startClaudeTurn, this process owns exactly one
// request directory: it spawns the CLI, folds the CLI's stream-json stdout into the
// normalized state file, and writes one terminal state before exiting. It is deliberately
// dumb about everything else — no MCP connection, no shared state, no network of its own —
// so the turn survives the caller, and killing the caller does not orphan a model call
// without a record.
//
// Lifecycle: state.json is written 'running' by startClaudeTurn before this worker exists,
// this worker refreshes it (heartbeat + messages) while the CLI runs, and rewrites it once
// as 'ended' / 'failed' / 'cancelled'. cancel.json is only evidence of a cancel when it says
// the whole tree was confirmed stopped, so a cancel that failed cannot make a live turn
// report itself cancelled later.
//
// Ownership: this process records its own pid as soon as it starts, in turn.json and in
// state.json, before it opens anything or spawns the CLI, so a caller that dies between the
// spawn and its own bookkeeping cannot leave a turn nobody names. It also stops the CLI tree as
// soon as system/init proves the turn cannot run as asked (wrong permission mode, no mode, a
// rejected callback server): that stop is a failure with the init reason, never a cancel, and
// it is only recorded after the tree is confirmed gone.
//
// Why file descriptors instead of pipes: the CLI's stdout is appended straight to
// stdout.stream.jsonl by the CLI itself, so the raw transcript survives a worker crash and
// nothing here needs a pipe that a confined sandbox could refuse to open.
import { spawn } from 'node:child_process';
import { appendFile, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildCliProxyEnv, checkProxyReachable } from './cli-proxy.mjs';
import { attachCurrentProcessToJobCage, killProcessCage } from './process-cage.mjs';
import {
  CANCEL_CONFIRM_MS, CLAUDE_TURN_FILES, CLAUDE_WORKER_ERROR_PREFIX, WORKER_HEARTBEAT_MS,
  applyClaudeLine, claudeInitError, claudeTurnOutcome, createClaudeTurnState, isClaudeStateFileBusy,
  resolveTurnTimeoutMs, stopClaudeTree, writeJsonFile,
} from './claude-cli-runner.mjs';

const POLL_MS = 120;
const READ_CHUNK = 1024 * 1024;
const STDERR_TAIL_BYTES = 4000;
const STATE_PUBLISH_RETRY_MS = 30000;

async function readTextOptional(filename) {
  try { return await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function readState(directory, turn) {
  try { return JSON.parse(await readFile(path.join(directory, CLAUDE_TURN_FILES.state), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return createClaudeTurnState({ requestId: turn.requestId, sessionId: turn.sessionId,
      workspace: turn.workspace, mcpRequired: turn.mcpServer ?? null });
  }
}

/**
 * Reader for the CLI's stdout file. It drains every complete line, in as many passes as it
 * takes, and only decodes up to a newline so a multi-byte character split across two reads
 * is never mangled. On the final pass a trailing line without a newline (a result the CLI
 * flushed just before exiting) is treated as a complete line instead of being dropped.
 */
function formatTimeoutLabel(ms) {
  if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms >= 1000) return `${Math.round((ms / 1000) * 10) / 10}s`;
  return `${ms}ms`;
}

function createStdoutReader(directory, state, onLine = () => {}) {
  let offset = 0;
  let pending = Buffer.alloc(0);
  let handle;
  const reader = async function drain({ final = false } = {}) {
    handle ??= await open(path.join(directory, CLAUDE_TURN_FILES.stdout), 'r');
    let applied = 0;
    for (;;) {
      const info = await handle.stat();
      if (info.size <= offset) break;
      const chunk = Buffer.alloc(Math.min(info.size - offset, READ_CHUNK));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      for (;;) {
        const lineBreak = pending.indexOf(0x0a);
        if (lineBreak < 0) break;
        const line = pending.subarray(0, lineBreak).toString('utf8');
        pending = pending.subarray(lineBreak + 1);
        if (!line.trim()) continue;
        applyClaudeLine(state, line);
        onLine(line);
        applied += 1;
      }
    }
    if (final && pending.length) {
      const line = pending.toString('utf8');
      pending = Buffer.alloc(0);
      if (line.trim()) { applyClaudeLine(state, line); applied += 1; }
    }
    if (final && handle) {
      await handle.close().catch(() => undefined);
      handle = undefined;
    }
    return applied;
  };
  reader.close = async () => {
    if (handle) {
      await handle.close().catch(() => undefined);
      handle = undefined;
    }
  };
  return reader;
}

/**
 * Run one turn to completion.
 * @param {string} directory The request's private directory.
 * @param {object} [deps] Test seams: spawn, sleep, pollMs, heartbeatMs, killTree, statePublishRetryMs.
 * @returns {Promise<{state: string, exitCode: number|null, error?: object}>}
 */
export async function runClaudeTurn({ directory, spawn: spawnImpl = spawn, sleep = delay,
  checkProxy = checkProxyReachable,
  pollMs = POLL_MS, heartbeatMs = WORKER_HEARTBEAT_MS,
  timeoutMs: overrideTimeoutMs, timeoutMinutes: overrideTimeoutMinutes,
  killTree = stopClaudeTree,
  killCage = (spawnImpl === spawn && killTree === stopClaudeTree) ? killProcessCage : async () => ({ ok: true, killed: [] }),
  statePublishRetryMs = STATE_PUBLISH_RETRY_MS, env = process.env } = {}) {
  const turn = JSON.parse(await readFile(path.join(directory, CLAUDE_TURN_FILES.turn), 'utf8'));
  const state = await readState(directory, turn);
  const timeoutMs = resolveTurnTimeoutMs({
    timeoutMs: overrideTimeoutMs ?? turn.timeoutMs,
    timeoutMinutes: overrideTimeoutMinutes ?? turn.timeoutMinutes,
  });
  let child;
  const finish = async options => {
    const outcome = await finalize(directory, state, { ...options, retryMs: statePublishRetryMs });
    await killCage({
      pids: Number.isSafeInteger(child?.pid) && child.pid > 0 ? [child.pid] : [],
      turnDir: directory,
      runId: turn.requestId ?? turn.taskId ?? undefined,
      sessionId: turn.sessionId ?? undefined,
    }).catch(() => undefined);
    return outcome;
  };
  // This process owns the turn from here on, so it records its own pid before anything else
  // runs: the caller normally writes the same pid right after spawning, but it can die in that
  // gap, and a request nobody names is a CLI tree nobody can stop.
  turn.workerPid = Number.isSafeInteger(process.pid) ? process.pid : (turn.workerPid ?? null);
  state.workerPid = turn.workerPid;
  state.heartbeatAt = new Date().toISOString();
  await writeJsonFile(directory, CLAUDE_TURN_FILES.turn, turn, { retryMs: statePublishRetryMs });
  await writeJsonFile(directory, CLAUDE_TURN_FILES.state, state, { retryMs: statePublishRetryMs });

  const route = turn.route ?? undefined;
  if (route?.mode === 'proxy' && route.proxyUrl) {
    const proxy = await checkProxy(route.proxyUrl);
    if (!proxy.ok) {
      return finish({
        exitCode: null,
        cancelled: false,
        stopError: {
          code: 'proxy-unavailable',
          notSent: true,
          message: `Required proxy ${route.proxyUrl} is unreachable (${proxy.error || 'TCP probe failed'}); Claude CLI was not spawned.`,
        },
      });
    }
  }

  const fileName = name => path.join(directory, name);
  const stdin = await open(fileName(CLAUDE_TURN_FILES.prompt), 'r');
  const stdout = await open(fileName(CLAUDE_TURN_FILES.stdout), 'a');
  const stderr = await open(fileName(CLAUDE_TURN_FILES.stderr), 'a');
  const responses = new Map();
  const drain = createStdoutReader(directory, state, line => {
    try { const event = JSON.parse(line); if (event.type === 'control_response') responses.set(event.response?.request_id, event.response); } catch {}
  });
  const closeAll = () => Promise.allSettled([stdin.close(), stdout.close(), stderr.close(), drain.close()]);

  const childEnv = buildCliProxyEnv(env, route);
  for (const extraEnv of [turn.reportConfig?.callerEnv, turn.callerEnv, turn.reportConfig?.env]) {
    if (extraEnv && typeof extraEnv === 'object' && !Array.isArray(extraEnv)) {
      for (const [key, val] of Object.entries(extraEnv)) {
        if (val !== undefined && val !== null) childEnv[key] = String(val);
      }
    }
  }
  childEnv.FUTUREAIDE_TURN_DIR = directory;
  childEnv.FUTUREAIDE_RUN_ID = String(turn.requestId || turn.taskId || '');

  let settled;
  const finished = new Promise(resolve => { settled = resolve; });
  try {
    // The prompt arrives on stdin: `-p` with no positional prompt reads it from there.
    child = spawnImpl(turn.command, [...(turn.prefixArgs ?? []), ...(turn.args ?? []),
      ...(turn.stagedControl ? ['--input-format', 'stream-json', '--replay-user-messages'] : [])], {
      cwd: turn.workspace,
      env: childEnv,
      stdio: [turn.stagedControl ? 'pipe' : stdin.fd, stdout.fd, stderr.fd],
      windowsHide: true,
    });
  } catch (error) {
    await closeAll();
    return finish({ exitCode: null, cancelled: false,
      spawnFailure: 'The Claude CLI could not be started: ' + String(error?.message ?? error) });
  }
  // Registered immediately: a CLI that fails at once must not be missed while a file is written.
  child.once('exit', code => settled({ code: code ?? null }));
  child.once('error', error => settled({ code: null, spawnError: error }));
  if (turn.stagedControl) child.stdin.on('error', () => {});

  const turnStartedMs = Date.now();
  state.pid = Number.isSafeInteger(child.pid) ? child.pid : null;
  state.phase = 'running';
  state.heartbeatAt = new Date().toISOString();
  // A reader can hold the destination open on Windows. Keep polling the CLI, and
  // publish the latest snapshot after it releases the file, including events read meanwhile.
  const saveRunningState = async () => {
    try {
      await writeJsonFile(directory, CLAUDE_TURN_FILES.state, state);
      return true;
    } catch (error) {
      if (!isClaudeStateFileBusy(error)) throw error;
      return false;
    }
  };
  let pendingState = !await saveRunningState();

  let lastBeat = Date.now();
  let result;
  let initError;
  let timedOut = false;
  if (turn.stagedControl) {
    let seq = 0;
    const request = async subtype => {
      const id = `stage-${++seq}`;
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } }) + '\n');
      const until = Math.min(Date.now() + 30000, turnStartedMs + timeoutMs);
      while (Date.now() < until) {
        await drain();
        const response = responses.get(id);
        if (response) {
          if (response.subtype !== 'success') throw new Error(`${subtype}: ${response.error ?? 'refused'}`);
          return response.response ?? {};
        }
        const stepWait = Math.min(pollMs, Math.max(1, until - Date.now()));
        const exited = await Promise.race([finished, sleep(stepWait).then(() => null)]);
        if (exited) { result = exited; throw new Error(`${subtype}: CLI exited`); }
      }
      if (Date.now() - turnStartedMs >= timeoutMs) {
        timedOut = true;
        throw Object.assign(new Error(`${subtype}: turn timeout`), { isTurnTimeout: true });
      }
      throw new Error(`${subtype}: timed out`);
    };
    try {
      await request('initialize');
      const catalog = await request('list_models');
      const settings = await request('get_settings');
      const applied = settings.applied;
      const row = catalog.models?.find(item => !item.disabled && item.resolvedModel === applied?.model);
      if (!row || (!Array.isArray(row.supportedEffortLevels) && row.supportsEffort !== false) || !applied?.model
          || (turn.selectedModel && applied.model !== turn.selectedModel)
          || (turn.selectedEffort && !applied.effort)
          || (applied.effort && !row.supportedEffortLevels?.includes(applied.effort))) {
        throw new Error('CLI did not confirm the selected model, supported efforts and applied effort');
      }
      state.capabilities = { model: row.resolvedModel, supportedEffortLevels: row.supportedEffortLevels ?? [] };
      state.applied = applied;
      if (turn.selectedEffort && applied.effort !== turn.selectedEffort) {
        state.effortAdjustment = { requested: turn.selectedEffort, actual: applied.effort ?? null,
          reason: 'Claude reported a different applied effort after its settings and policy were applied.' };
      }
      state.model = applied.model;
      state.actualEffort = applied.effort ?? null;
      state.inputUuid = turn.inputUuid;
      await writeJsonFile(directory, CLAUDE_TURN_FILES.state, state, { retryMs: statePublishRetryMs });
      const prompt = await readFile(fileName(CLAUDE_TURN_FILES.prompt), 'utf8');
      child.stdin.end(JSON.stringify({ type: 'user', uuid: turn.inputUuid, message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: turn.sessionId }) + '\n');
      state.businessSubmitted = true;
    } catch (error) {
      if (!error?.isTurnTimeout) {
        initError = { code: 'claude-capabilities-unconfirmed', message: String(error.message ?? error), notSent: true };
      }
    }
  }
  for (;;) {
    if (timedOut || initError) break;
    try { if (await drain()) pendingState = true; }
    catch (error) { addWarning(state, 'claude-stream-read-failed', error); }
    // The first system/init already says whether this CLI may keep running: a permission mode
    // other than the auto mode that was asked for, no mode at all, or a rejected callback server
    // means the turn is wrong, and the model must not keep acting under it. The check is the
    // runner's, so the reason that stops the CLI is the same one the turn ends with.
    if (state.sessionStarted) initError = claudeInitError(state);
    if (initError) break;
    const now = Date.now();
    if (now - turnStartedMs >= timeoutMs) {
      timedOut = true;
      break;
    }
    if (now - lastBeat >= heartbeatMs) {
      lastBeat = now;
      state.heartbeatAt = new Date(now).toISOString();
      pendingState = true;
    }
    if (pendingState) pendingState = !await saveRunningState();
    const stepWait = Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - turnStartedMs)));
    result = await Promise.race([finished, sleep(stepWait).then(() => null)]);
    if (result) break;
  }

  if (timedOut) {
    try { child.kill?.('SIGKILL'); } catch { /* ignore */ }
    if (Number.isSafeInteger(child?.pid) && child.pid > 0) {
      try { await killTree(child.pid); } catch { /* ignore */ }
    }
    await killCage({
      pids: Number.isSafeInteger(child?.pid) && child.pid > 0 ? [child.pid] : [],
      turnDir: directory,
      runId: turn.requestId ?? turn.taskId ?? undefined,
      sessionId: turn.sessionId ?? undefined,
    }).catch(() => undefined);
    result = await Promise.race([finished, sleep(Math.min(2000, CANCEL_CONFIRM_MS)).then(() => ({ code: null }))]);
    try { await drain({ final: true }); } catch { /* ignore */ }
    await closeAll();
    return finish({
      exitCode: result?.code ?? null,
      cancelled: false,
      stopError: {
        code: 'turn-timeout',
        message: `Claude CLI turn exceeded timeout (${formatTimeoutLabel(timeoutMs)}); process tree was terminated.`,
      },
    });
  }

  if (initError) {
    // Stop the whole tree now and wait for it. The turn ends failed with that init error, not as
    // a user cancel. If the stop cannot be confirmed nothing terminal is written: the turn stays
    // open with its pids recorded, so a cancel can still stop the tree instead of reporting a
    // turn that never ended.
    try { await killTree(child.pid); } catch { /* the confirmation below decides */ }
    result = await Promise.race([finished, sleep(CANCEL_CONFIRM_MS).then(() => null)]);
    if (!result) {
      addWarning(state, 'claude-cli-stop-unconfirmed',
        'The Claude CLI did not stop after system/init reported ' + initError.code + '; the turn stays open so a cancel can stop this tree.');
      state.heartbeatAt = new Date().toISOString();
      await writeJsonFile(directory, CLAUDE_TURN_FILES.state, state, { retryMs: statePublishRetryMs });
      await closeAll();
      return { state: 'running', exitCode: null, error: initError };
    }
  }

  // The CLI may flush its final result line just before it dies, and that line may have no
  // trailing newline: drain everything that is left before deciding the outcome.
  try { await drain({ final: true }); }
  catch (error) { addWarning(state, 'claude-stream-read-failed', error); }
  await closeAll();

  if (result.spawnError) {
    return finish({ exitCode: null, cancelled: false,
      spawnFailure: 'The Claude CLI could not be started: ' + String(result.spawnError.message ?? result.spawnError) });
  }
  const marker = await readJsonOptional(fileName(CLAUDE_TURN_FILES.cancel));
  const stderrTail = (await readTextOptional(fileName(CLAUDE_TURN_FILES.stderr))).slice(-STDERR_TAIL_BYTES);
  return finish({ exitCode: result.code ?? null,
    cancelled: initError ? false : marker?.stopped === true, stderrTail, stopError: initError });
}

async function readJsonOptional(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function addWarning(state, code, error) {
  state.warnings = [...(state.warnings ?? []), { code, message: String(error?.message ?? error).slice(0, 400) }];
}

async function finalize(directory, state, { exitCode, cancelled, stderrTail = '', spawnFailure, stopError, retryMs }) {
  const outcome = spawnFailure
    ? { state: 'failed', error: { code: 'claude-cli-spawn-failed',
      message: spawnFailure.slice(0, 700) + ' The turn never reached the model.' } }
    // The worker stopped this CLI itself because system/init had already proved the turn could
    // not run as asked, so the turn keeps that reason instead of the exit code of the stop.
    : stopError ? { state: 'failed', error: stopError }
      : claudeTurnOutcome({ state, exitCode, cancelled, stderrTail });
  const now = new Date().toISOString();
  if (state.usage && (!Number.isFinite(state.usage.durationSec) || state.usage.durationSec <= 0) && state.startedAt) {
    const elapsed = (Date.parse(now) - Date.parse(state.startedAt)) / 1000;
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      state.usage = { ...state.usage, durationSec: Math.round(elapsed * 100) / 100 };
    }
  }
  Object.assign(state, {
    state: outcome.state, phase: 'exited', exitCode, updatedAt: now, heartbeatAt: now,
    endedAt: state.endedAt ?? now, error: outcome.error ?? null,
  });
  try {
    await writeJsonFile(directory, CLAUDE_TURN_FILES.state, state, { retryMs });
  } catch (error) {
    if (!isClaudeStateFileBusy(error)) throw error;
    // The CLI has exited, so the outcome can live in a separate file while the
    // running snapshot is still locked.
    await writeJsonFile(directory, CLAUDE_TURN_FILES.terminal, state);
  }
  return { state: outcome.state, exitCode, ...(outcome.error ? { error: outcome.error } : {}) };
}

function workerArguments(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    const key = String(argv[index]).replace(/^--/, '');
    if (argv[index + 1] === undefined) continue;
    args.set(key, argv[index + 1]);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await attachCurrentProcessToJobCage().catch(() => undefined);
  const args = workerArguments(process.argv);
  const directory = args.get('turn');
  if (!directory) {
    console.error(CLAUDE_WORKER_ERROR_PREFIX + '--turn <directory> is required.');
    process.exit(2);
  }
  try {
    await runClaudeTurn({ directory });
    process.exit(0);
  } catch (error) {
    await killProcessCage({ pids: [], turnDir: directory }).catch(() => undefined);
    // The worker may lose access to state.json and its launcher discards stderr.
    const diagnostic = CLAUDE_WORKER_ERROR_PREFIX + (error?.message ?? error);
    await appendFile(path.join(directory, CLAUDE_TURN_FILES.workerStderr), diagnostic + '\n', { mode: 0o600 })
      .catch(() => undefined);
    console.error(diagnostic);
    process.exit(1);
  }
}
