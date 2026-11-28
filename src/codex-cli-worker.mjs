// Detached single-turn worker for Codex CLI (`codex exec --json`).
//
// Owns one private turn directory:
//   1. Claims workerPid in turn.json and state.json.
//   2. Enforces fail-closed proxy reachability BEFORE spawning codex.exe.
//   3. Spawns codex.exe with clean FAswitch/manual proxy env, piping prompt.txt on stdin.
//   4. Folds JSONL events into state.json atomically with heartbeat, and writes terminal
//      state (or terminal.json if Windows keeps state.json locked) on exit.
import { spawn } from 'node:child_process';
import { appendFile, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { buildCliProxyEnv, checkProxyReachable } from './cli-proxy.mjs';
import { attachCurrentProcessToJobCage, killProcessCage } from './process-cage.mjs';
import {
  CANCEL_CONFIRM_MS,
  CODEX_TURN_FILES,
  CODEX_WORKER_ERROR_PREFIX,
  WORKER_HEARTBEAT_MS,
  applyCodexLine,
  buildCodexCliArgs,
  codexTurnOutcome,
  createCodexTurnState,
  isCodexStateFileBusy,
  killProcessTree,
  resolveTurnTimeoutMs,
  writeJsonFile,
} from './codex-cli-runner.mjs';

const POLL_MS = 120;
const READ_CHUNK = 1024 * 1024;
const STDERR_TAIL_BYTES = 4000;
const STATE_PUBLISH_RETRY_MS = 30000;

async function readTextOptional(filename) {
  try { return await readFile(filename, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
}

async function readJsonOptional(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

async function readInitialState(directory, turn) {
  try { return JSON.parse(await readFile(path.join(directory, CODEX_TURN_FILES.state), 'utf8')); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return createCodexTurnState({
      requestId: turn.requestId,
      agentId: turn.agentId,
      taskId: turn.taskId,
      sessionId: turn.sessionId,
      threadId: turn.threadId,
      workspace: turn.workspace,
      message: turn.rawMessage ?? turn.prompt,
      requestedModel: turn.model,
      requestedEffort: turn.effort,
      route: turn.route,
    });
  }
}

function addWarning(state, code, error) {
  state.warnings = [
    ...(state.warnings ?? []),
    { code, message: String(error?.message ?? error).slice(0, 400), time: new Date().toISOString() },
  ];
}

function formatTimeoutLabel(ms) {
  if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms >= 1000) return `${Math.round((ms / 1000) * 10) / 10}s`;
  return `${ms}ms`;
}

function createStdoutReader(directory, state) {
  let offset = 0;
  let pending = Buffer.alloc(0);
  let handle;
  const reader = async function drain({ final = false } = {}) {
    handle ??= await open(path.join(directory, CODEX_TURN_FILES.stdout), 'r');
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
        applyCodexLine(state, line);
        applied += 1;
      }
    }
    if (final && pending.length) {
      const line = pending.toString('utf8');
      pending = Buffer.alloc(0);
      if (line.trim()) {
        applyCodexLine(state, line);
        applied += 1;
      }
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

async function finalize(directory, state, { exitCode, cancelled, stderrTail = '', spawnFailure, preflightError, timeoutError, retryMs }) {
  const outcome = preflightError
    ? { state: 'failed', error: preflightError }
    : timeoutError
      ? { state: 'failed', error: timeoutError }
      : spawnFailure
        ? { state: 'failed', error: { code: 'codex-cli-spawn-failed', message: `${spawnFailure.slice(0, 700)} The turn never reached the model.` } }
        : codexTurnOutcome({ state, exitCode, cancelled, stderrTail });
  const now = new Date().toISOString();
  if (state.usage && (!Number.isFinite(state.usage.durationSec) || state.usage.durationSec <= 0) && state.startedAt) {
    const elapsed = (Date.parse(now) - Date.parse(state.startedAt)) / 1000;
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      state.usage = { ...state.usage, durationSec: Math.round(elapsed * 100) / 100 };
    }
  }
  Object.assign(state, {
    state: outcome.state,
    phase: 'exited',
    exitCode,
    updatedAt: now,
    heartbeatAt: now,
    endedAt: state.endedAt ?? now,
    error: outcome.error ?? null,
  });
  try {
    await writeJsonFile(directory, CODEX_TURN_FILES.state, state, { retryMs });
  } catch (error) {
    if (!isCodexStateFileBusy(error)) throw error;
    await writeJsonFile(directory, CODEX_TURN_FILES.terminal, state);
  }
  return { state: outcome.state, exitCode, ...(outcome.error ? { error: outcome.error } : {}) };
}

export async function runCodexTurn({
  directory,
  spawn: spawnImpl = spawn,
  checkProxy = checkProxyReachable,
  killTree = spawnImpl === spawn ? killProcessTree : async () => ({ ok: true }),
  killCage = spawnImpl === spawn ? killProcessCage : async () => ({ ok: true, killed: [] }),
  sleep = delay,
  pollMs = POLL_MS,
  heartbeatMs = WORKER_HEARTBEAT_MS,
  timeoutMs: overrideTimeoutMs,
  timeoutMinutes: overrideTimeoutMinutes,
  statePublishRetryMs = STATE_PUBLISH_RETRY_MS,
  env = process.env,
} = {}) {
  const turn = JSON.parse(await readFile(path.join(directory, CODEX_TURN_FILES.turn), 'utf8'));
  const state = await readInitialState(directory, turn);
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

  turn.workerPid = Number.isSafeInteger(process.pid) ? process.pid : (turn.workerPid ?? null);
  state.workerPid = turn.workerPid;
  state.heartbeatAt = new Date().toISOString();
  await writeJsonFile(directory, CODEX_TURN_FILES.turn, turn, { retryMs: statePublishRetryMs });
  await writeJsonFile(directory, CODEX_TURN_FILES.state, state, { retryMs: statePublishRetryMs });

  // Fail-closed proxy check right before spawning codex.exe.
  const route = turn.route ?? undefined;
  if (route?.mode === 'proxy' && route.proxyUrl) {
    const proxy = await checkProxy(route.proxyUrl);
    if (!proxy.ok) {
      return finish({
        exitCode: null,
        cancelled: false,
        preflightError: {
          code: 'proxy-unavailable',
          notSent: true,
          message: `Required proxy ${route.proxyUrl} is unreachable (${proxy.error || 'TCP probe failed'}); codex.exe was not spawned.`,
        },
      });
    }
  }

  const promptFile = path.join(directory, CODEX_TURN_FILES.prompt);
  await writeFile(promptFile, String(turn.prompt ?? ''), 'utf8');

  const args = Array.isArray(turn.args) && turn.args.length
    ? turn.args.map(String)
    : buildCodexCliArgs({
      workspace: turn.workspace,
      threadId: turn.threadId,
      resume: turn.resume === true,
      model: turn.model,
      effort: turn.effort,
      reportConfig: turn.reportConfig,
      turnDir: directory,
    });

  const stdin = await open(promptFile, 'r');
  const stdout = await open(path.join(directory, CODEX_TURN_FILES.stdout), 'a');
  const stderr = await open(path.join(directory, CODEX_TURN_FILES.stderr), 'a');
  const drain = createStdoutReader(directory, state);
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
  const cwd = turn.workspace || directory;

  let settled;
  const finished = new Promise(resolve => { settled = resolve; });
  try {
    child = spawnImpl(turn.command, [...(turn.prefixArgs ?? []), ...args], {
      cwd,
      env: childEnv,
      stdio: [stdin.fd, stdout.fd, stderr.fd],
      windowsHide: true,
    });
  } catch (error) {
    await closeAll();
    return finish({
      exitCode: null,
      cancelled: false,
      spawnFailure: `The Codex CLI could not be started: ${String(error?.message ?? error)}`,
    });
  }

  child.once('exit', code => settled({ code: code ?? null }));
  child.once('error', error => settled({ code: null, spawnError: error }));

  const turnStartedMs = Date.now();
  state.pid = Number.isSafeInteger(child.pid) ? child.pid : null;
  state.phase = 'running';
  state.heartbeatAt = new Date().toISOString();

  const saveRunningState = async () => {
    try {
      await writeJsonFile(directory, CODEX_TURN_FILES.state, state);
      return true;
    } catch (error) {
      if (!isCodexStateFileBusy(error)) throw error;
      return false;
    }
  };
  let pendingState = !(await saveRunningState());

  let lastBeat = Date.now();
  let result;
  let timedOut = false;
  for (;;) {
    try {
      if (await drain()) pendingState = true;
    } catch (error) {
      addWarning(state, 'codex-stream-read-failed', error);
    }
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
    if (pendingState) pendingState = !(await saveRunningState());
    const stepWait = Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - turnStartedMs)));
    result = await Promise.race([finished, sleep(stepWait).then(() => null)]);
    if (result) break;
  }

  if (timedOut) {
    try { child.kill?.('SIGKILL'); } catch { /* ignore */ }
    if (Number.isSafeInteger(child?.pid) && child.pid > 0) {
      await killTree(child.pid).catch(() => undefined);
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
      timeoutError: {
        code: 'turn-timeout',
        message: `Codex CLI turn exceeded timeout (${formatTimeoutLabel(timeoutMs)}); process tree was terminated.`,
      },
    });
  }

  try { await drain({ final: true }); }
  catch (error) { addWarning(state, 'codex-stream-read-failed', error); }
  await closeAll();

  if (result.spawnError) {
    return finish({
      exitCode: null,
      cancelled: false,
      spawnFailure: `The Codex CLI could not be started: ${String(result.spawnError.message ?? result.spawnError)}`,
    });
  }
  const marker = await readJsonOptional(path.join(directory, CODEX_TURN_FILES.cancel));
  const stderrTail = (await readTextOptional(path.join(directory, CODEX_TURN_FILES.stderr))).slice(-STDERR_TAIL_BYTES);
  return finish({
    exitCode: result.code ?? null,
    cancelled: marker?.stopped === true,
    stderrTail,
  });
}

function parseWorkerArgs(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index++) {
    const token = String(argv[index] ?? '');
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 2) args.set(token.slice(2, eq), token.slice(eq + 1));
    else if (argv[index + 1] !== undefined) {
      args.set(token.slice(2), argv[index + 1]);
      index += 1;
    }
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await attachCurrentProcessToJobCage().catch(() => undefined);
  const args = parseWorkerArgs(process.argv);
  const directory = args.get('turn');
  if (!directory) {
    console.error(CODEX_WORKER_ERROR_PREFIX + '--turn <directory> is required.');
    process.exit(2);
  }
  try {
    await runCodexTurn({ directory });
    process.exit(0);
  } catch (error) {
    await killProcessCage({ pids: [], turnDir: directory }).catch(() => undefined);
    const diagnostic = CODEX_WORKER_ERROR_PREFIX + (error?.message ?? error);
    await appendFile(path.join(directory, CODEX_TURN_FILES.workerStderr), diagnostic + '\n', { mode: 0o600 })
      .catch(() => undefined);
    console.error(diagnostic);
    process.exit(1);
  }
}
