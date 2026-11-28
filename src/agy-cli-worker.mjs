// Detached single-turn worker for Google Antigravity CLI (`agy -p ... --output-format stream-json`).
//
// Owns one private turn directory:
//   1. Attaches to Win32 Job Object cage and claims workerPid in turn.json + state.json.
//   2. Enforces fail-closed proxy reachability BEFORE spawning `agy`.
//   3. Spawns `agy` with clean proxy env + `FUTUREAIDE_MANAGED_CLI=1` parent callback env.
//   4. Enforces single-turn timeout (`turn.timeoutMs`, default 25m), killing the entire
//      process tree via `killProcessCage` on timeout or any terminal state.
import { spawn } from 'node:child_process';
import { appendFile, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { buildCliProxyEnv, checkProxyReachable, redactProxyCredentials } from './cli-proxy.mjs';
import { managedCliEnv } from './managed-cli-policy.mjs';
import { attachCurrentProcessToJobCage, killProcessCage } from './process-cage.mjs';
import {
  AGY_TURN_FILES,
  AGY_WORKER_ERROR_PREFIX,
  CANCEL_CONFIRM_MS,
  WORKER_HEARTBEAT_MS,
  applyAgyLine,
  agyTurnOutcome,
  buildAgyCliArgs,
  confirmTurnCage,
  createAgyTurnState,
  isAgyStateFileBusy,
  killProcessTree,
  persistTurnCleanupPending,
  resolveTurnTimeoutMs,
  writeJsonFile,
} from './agy-cli-runner.mjs';

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
  try { return JSON.parse(await readFile(path.join(directory, AGY_TURN_FILES.state), 'utf8')); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return createAgyTurnState({
      requestId: turn.requestId,
      agentId: turn.agentId,
      taskId: turn.taskId,
      sessionId: turn.sessionId,
      conversationId: turn.conversationId,
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
    handle ??= await open(path.join(directory, AGY_TURN_FILES.stdout), 'r');
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
        applyAgyLine(state, line);
        applied += 1;
      }
    }
    if (final && pending.length) {
      const line = pending.toString('utf8');
      pending = Buffer.alloc(0);
      if (line.trim()) {
        applyAgyLine(state, line);
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

async function finalize(directory, state, {
  exitCode,
  cancelled,
  stderrTail = '',
  spawnFailure,
  preflightError,
  timeoutError,
  retryMs,
}) {
  const outcome = preflightError
    ? { state: 'failed', error: preflightError }
    : timeoutError
      ? { state: 'failed', error: timeoutError }
      : spawnFailure
        ? { state: 'failed', error: { code: 'agy-cli-spawn-failed', message: `${spawnFailure.slice(0, 700)} The turn never reached the model.` } }
        : agyTurnOutcome({ state, exitCode, cancelled, stderrTail });
  const now = new Date().toISOString();
  delete state._streamingText;
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
    await writeJsonFile(directory, AGY_TURN_FILES.state, state, { retryMs });
  } catch (error) {
    if (!isAgyStateFileBusy(error)) throw error;
    await writeJsonFile(directory, AGY_TURN_FILES.terminal, state);
  }
  return { state: outcome.state, exitCode, ...(outcome.error ? { error: outcome.error } : {}) };
}

export async function runAgyTurn({
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
  const turn = JSON.parse(await readFile(path.join(directory, AGY_TURN_FILES.turn), 'utf8'));
  const state = await readInitialState(directory, turn);
  const timeoutMs = resolveTurnTimeoutMs({
    timeoutMs: overrideTimeoutMs ?? turn.timeoutMs,
    timeoutMinutes: overrideTimeoutMinutes ?? turn.timeoutMinutes,
  });
  let child;
  const finish = async options => {
    const stopped = await confirmTurnCage(killCage, {
      pids: Number.isSafeInteger(child?.pid) && child.pid > 0 ? [child.pid] : [],
      turnDir: directory,
      runId: turn.requestId ?? turn.taskId ?? undefined,
      sessionId: turn.sessionId ?? undefined,
    });
    if (!stopped) throw await persistTurnCleanupPending(directory, state, 'agy', 'Antigravity CLI');
    return finalize(directory, state, { ...options, retryMs: statePublishRetryMs });
  };

  turn.workerPid = Number.isSafeInteger(process.pid) ? process.pid : (turn.workerPid ?? null);
  state.workerPid = turn.workerPid;
  state.heartbeatAt = new Date().toISOString();
  await writeJsonFile(directory, AGY_TURN_FILES.turn, turn, { retryMs: statePublishRetryMs });
  await writeJsonFile(directory, AGY_TURN_FILES.state, state, { retryMs: statePublishRetryMs });

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
          message: `Required proxy ${redactProxyCredentials(route.proxyUrl)} is unreachable (${redactProxyCredentials(proxy.error || 'TCP probe failed')}); agy was not spawned.`,
        },
      });
    }
  }

  const promptFile = path.join(directory, AGY_TURN_FILES.prompt);
  await writeFile(promptFile, String(turn.prompt ?? ''), 'utf8');

  const args = Array.isArray(turn.args) && turn.args.length
    ? turn.args.map(String)
    : buildAgyCliArgs({
      prompt: turn.prompt,
      conversationId: turn.conversationId,
      resume: turn.resume === true,
      model: turn.model,
      effort: turn.effort,
    });

  const stdout = await open(path.join(directory, AGY_TURN_FILES.stdout), 'a');
  const stderr = await open(path.join(directory, AGY_TURN_FILES.stderr), 'a');
  const drain = createStdoutReader(directory, state);
  const closeAll = () => Promise.allSettled([stdout.close(), stderr.close(), drain.close()]);

  const childEnv = buildCliProxyEnv(managedCliEnv(env), route);
  for (const extraEnv of [turn.reportConfig?.callerEnv, turn.callerEnv, turn.reportConfig?.env]) {
    if (extraEnv && typeof extraEnv === 'object' && !Array.isArray(extraEnv)) {
      for (const [key, val] of Object.entries(managedCliEnv(extraEnv))) {
        if (val !== undefined && val !== null) childEnv[key] = String(val);
      }
    }
  }
  childEnv.FUTUREAIDE_MANAGED_CLI = '1';
  childEnv.FUTUREAIDE_MANAGED_TARGET = 'agy-cli';
  if (turn.agentId) childEnv.FUTUREAIDE_PARENT_AGENT_ID = String(turn.agentId);
  if (turn.taskId) childEnv.FUTUREAIDE_PARENT_TASK_ID = String(turn.taskId);
  if (turn.requestId) childEnv.FUTUREAIDE_PARENT_REQUEST_ID = String(turn.requestId);
  if (turn.workspace) childEnv.ANTIGRAVITY_WORKSPACE = String(turn.workspace);
  childEnv.FUTUREAIDE_TURN_DIR = directory;
  childEnv.FUTUREAIDE_RUN_ID = String(turn.requestId || turn.taskId || '');
  const cwd = turn.workspace || directory;

  let settled;
  const finished = new Promise(resolve => { settled = resolve; });
  try {
    child = spawnImpl(turn.command, [...(turn.prefixArgs ?? []), ...args], {
      cwd,
      env: childEnv,
      stdio: ['ignore', stdout.fd, stderr.fd],
      windowsHide: true,
    });
  } catch (error) {
    await closeAll();
    return finish({
      exitCode: null,
      cancelled: false,
      spawnFailure: `The Antigravity CLI could not be started: ${String(error?.message ?? error)}`,
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
      await writeJsonFile(directory, AGY_TURN_FILES.state, state);
      return true;
    } catch (error) {
      if (!isAgyStateFileBusy(error)) throw error;
      return false;
    }
  };
  let pendingState = !(await saveRunningState());

  let lastBeat = Date.now();
  let result = null;
  let timedOut = false;
  for (;;) {
    try {
      if (await drain()) pendingState = true;
    } catch (error) {
      addWarning(state, 'agy-stream-read-failed', error);
    }
    const now = Date.now();
    const elapsedMs = now - turnStartedMs;
    if (elapsedMs >= timeoutMs) {
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
        message: `Antigravity CLI turn exceeded timeout (${formatTimeoutLabel(timeoutMs)}); process tree was terminated.`,
      },
    });
  }

  try { await drain({ final: true }); }
  catch (error) { addWarning(state, 'agy-stream-read-failed', error); }
  await closeAll();

  if (result?.spawnError) {
    return finish({
      exitCode: null,
      cancelled: false,
      spawnFailure: `The Antigravity CLI could not be started: ${String(result.spawnError.message ?? result.spawnError)}`,
    });
  }
  const marker = await readJsonOptional(path.join(directory, AGY_TURN_FILES.cancel));
  const stderrTail = (await readTextOptional(path.join(directory, AGY_TURN_FILES.stderr))).slice(-STDERR_TAIL_BYTES);
  return finish({
    exitCode: result?.code ?? null,
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
    console.error(AGY_WORKER_ERROR_PREFIX + '--turn <directory> is required.');
    process.exit(2);
  }
  try {
    await runAgyTurn({ directory });
    process.exit(0);
  } catch (error) {
    await killProcessCage({ pids: [], turnDir: directory }).catch(() => undefined);
    const diagnostic = AGY_WORKER_ERROR_PREFIX + (error?.message ?? error);
    await appendFile(path.join(directory, AGY_TURN_FILES.workerStderr), diagnostic + '\n', { mode: 0o600 })
      .catch(() => undefined);
    console.error(diagnostic);
    process.exit(1);
  }
}
