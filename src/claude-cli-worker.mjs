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
import {
  CANCEL_CONFIRM_MS, CLAUDE_TURN_FILES, CLAUDE_WORKER_ERROR_PREFIX, WORKER_HEARTBEAT_MS,
  applyClaudeLine, claudeInitError, claudeTurnOutcome, createClaudeTurnState, isClaudeStateFileBusy,
  stopClaudeTree, writeJsonFile,
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
function createStdoutReader(directory, state, onLine = () => {}) {
  let offset = 0;
  let pending = Buffer.alloc(0);
  let handle;
  return async function drain({ final = false } = {}) {
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
    return applied;
  };
}

/**
 * Run one turn to completion.
 * @param {string} directory The request's private directory.
 * @param {object} [deps] Test seams: spawn, sleep, pollMs, heartbeatMs, killTree, statePublishRetryMs.
 * @returns {Promise<{state: string, exitCode: number|null, error?: object}>}
 */
export async function runClaudeTurn({ directory, spawn: spawnImpl = spawn, sleep = delay,
  pollMs = POLL_MS, heartbeatMs = WORKER_HEARTBEAT_MS, killTree = stopClaudeTree,
  statePublishRetryMs = STATE_PUBLISH_RETRY_MS } = {}) {
  const turn = JSON.parse(await readFile(path.join(directory, CLAUDE_TURN_FILES.turn), 'utf8'));
  const state = await readState(directory, turn);
  const finish = options => finalize(directory, state, { ...options, retryMs: statePublishRetryMs });
  // This process owns the turn from here on, so it records its own pid before anything else
  // runs: the caller normally writes the same pid right after spawning, but it can die in that
  // gap, and a request nobody names is a CLI tree nobody can stop.
  turn.workerPid = Number.isSafeInteger(process.pid) ? process.pid : (turn.workerPid ?? null);
  state.workerPid = turn.workerPid;
  state.heartbeatAt = new Date().toISOString();
  await writeJsonFile(directory, CLAUDE_TURN_FILES.turn, turn, { retryMs: statePublishRetryMs });
  await writeJsonFile(directory, CLAUDE_TURN_FILES.state, state, { retryMs: statePublishRetryMs });
  const fileName = name => path.join(directory, name);
  const stdin = await open(fileName(CLAUDE_TURN_FILES.prompt), 'r');
  const stdout = await open(fileName(CLAUDE_TURN_FILES.stdout), 'a');
  const stderr = await open(fileName(CLAUDE_TURN_FILES.stderr), 'a');
  const closeAll = () => Promise.allSettled([stdin.close(), stdout.close(), stderr.close()]);

  let settled;
  const finished = new Promise(resolve => { settled = resolve; });
  let child;
  try {
    // The prompt arrives on stdin: `-p` with no positional prompt reads it from there.
    child = spawnImpl(turn.command, [...(turn.prefixArgs ?? []), ...(turn.args ?? []),
      ...(turn.stagedControl ? ['--input-format', 'stream-json', '--replay-user-messages'] : [])], {
      cwd: turn.workspace,
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

  const responses = new Map();
  const drain = createStdoutReader(directory, state, line => {
    try { const event = JSON.parse(line); if (event.type === 'control_response') responses.set(event.response?.request_id, event.response); } catch {}
  });
  let lastBeat = Date.now();
  let result;
  let initError;
  if (turn.stagedControl) {
    let seq = 0;
    const request = async subtype => {
      const id = `stage-${++seq}`;
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } }) + '\n');
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        await drain();
        const response = responses.get(id);
        if (response) {
          if (response.subtype !== 'success') throw new Error(`${subtype}: ${response.error ?? 'refused'}`);
          return response.response ?? {};
        }
        const exited = await Promise.race([finished, sleep(pollMs).then(() => null)]);
        if (exited) { result = exited; throw new Error(`${subtype}: CLI exited`); }
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
      initError = { code: 'claude-capabilities-unconfirmed', message: String(error.message ?? error), notSent: true };
    }
  }
  for (;;) {
    if (initError) break;
    try { if (await drain()) pendingState = true; }
    catch (error) { addWarning(state, 'claude-stream-read-failed', error); }
    // The first system/init already says whether this CLI may keep running: a permission mode
    // other than the auto mode that was asked for, no mode at all, or a rejected callback server
    // means the turn is wrong, and the model must not keep acting under it. The check is the
    // runner's, so the reason that stops the CLI is the same one the turn ends with.
    if (state.sessionStarted) initError = claudeInitError(state);
    if (initError) break;
    const now = Date.now();
    if (now - lastBeat >= heartbeatMs) {
      lastBeat = now;
      state.heartbeatAt = new Date(now).toISOString();
      pendingState = true;
    }
    if (pendingState) pendingState = !await saveRunningState();
    result = await Promise.race([finished, sleep(pollMs).then(() => null)]);
    if (result) break;
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
    // The worker may lose access to state.json and its launcher discards stderr.
    const diagnostic = CLAUDE_WORKER_ERROR_PREFIX + (error?.message ?? error);
    await appendFile(path.join(directory, CLAUDE_TURN_FILES.workerStderr), diagnostic + '\n', { mode: 0o600 })
      .catch(() => undefined);
    console.error(diagnostic);
    process.exit(1);
  }
}
