// Claude CLI runner/worker: a turn is only ever reported finished when the processes it owns
// are really gone, cancel only kills a pid it can still show belongs to this request, and a CLI
// that system/init has already disqualified is stopped before it can act. Everything runs
// against a stand-in CLI, so no test reaches a real model, a real login or a proxy.
//
// Two regressions are pinned here:
//   P1 orphan  A worker that is gone while the CLI it started still runs used to make that live
//              tree read as a terminal failure, so cancel and delete reported a stop that never
//              happened. The orphan record below is written in exactly the shape the worker
//              leaves behind (turn.json worker pid, state.json CLI pid, heartbeat) because this
//              host supervises process trees: terminating an ancestor takes its descendants too,
//              so the orphan state is built from the same files instead of by killing a worker.
//   P1 early   A CLI whose init reported a permission mode other than auto, or whose callback
//              server was rejected, kept running (and could write) until it exited by itself.
//
// Scratch directories are left in clean/claude-cli-orphan-tests/ on purpose: this project moves
// work aside instead of deleting it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CLAUDE_TURN_FILES, cancelClaudeTurn, readClaudeTurn, startClaudeTurn,
} from '../src/claude-cli-runner.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratchRoot = path.join(projectRoot, 'clean', 'claude-cli-orphan-tests',
  new Date().toISOString().replace(/[:.]/g, '-'));
const SESSION = '99999999-8888-4777-8666-555555555555';
const DEAD_WORKER = 2147483000;
const MCP_CONFIG = { mcpServers: { futureaide: { command: process.execPath, args: ['src/mcp-server.mjs'] } } };
const ENV_KEYS = ['FAKE_ORPHAN_MODE', 'FAKE_ORPHAN_REJECT_MCP', 'FAKE_ORPHAN_SIDE_EFFECT', 'FAKE_ORPHAN_RECEIPT_DIR'];
const SLEEPER = ['-e', 'setInterval(() => {}, 1000)'];

// The stand-in CLI: it prints system/init, starts a child of its own, then hangs. The child
// proves a stop reaps the whole tree and not only the process the runner knows by pid.
const STAND_IN = String.raw`
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const sessionId = flag('--session-id') ?? flag('--resume') ?? '00000000-0000-4000-8000-000000000000';
const mcpFile = flag('--mcp-config');

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
  { stdio: 'ignore', windowsHide: true });
const receiptDir = process.env.FAKE_ORPHAN_RECEIPT_DIR;
if (receiptDir) {
  await mkdir(receiptDir, { recursive: true });
  await writeFile(path.join(receiptDir, 'pids.json'),
    JSON.stringify({ cli: process.pid, descendant: descendant.pid }) + '\n');
}

const init = { type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(),
  model: 'claude-stand-in', tools: ['Read'], permissionMode: process.env.FAKE_ORPHAN_MODE ?? 'auto' };
if (process.env.FAKE_ORPHAN_REJECT_MCP) {
  init.mcp_servers = [];
  init.mcp_server_errors = [{ name: 'futureaide', type: 'invalid_config', message: 'the stand-in refused it' }];
} else {
  init.mcp_servers = mcpFile ? [{ name: 'futureaide', status: 'connected' }] : [];
}
process.stdout.write(JSON.stringify(init) + '\n');

const sideEffect = process.env.FAKE_ORPHAN_SIDE_EFFECT;
if (sideEffect) {
  // What this turn would write if nobody stopped it. It must never appear.
  setTimeout(() => { writeFile(sideEffect, 'the CLI was still running\n').catch(() => {}); }, 1500);
}
setInterval(() => {}, 1000);
await new Promise(() => {});
`;

let standIn;
let standInWritten = false;
let scratchCount = 0;
const directories = [];
const strays = new Set();

async function scratch(name) {
  const directory = path.join(scratchRoot, name + '-' + (++scratchCount));
  await mkdir(directory, { recursive: true });
  directories.push(directory);
  return directory;
}

async function standInCli() {
  standIn ??= path.join(scratchRoot, 'claude-stand-in.mjs');
  if (!standInWritten) {
    await mkdir(scratchRoot, { recursive: true });
    await writeFile(standIn, STAND_IN, 'utf8');
    standInWritten = true;
  }
  return { command: process.execPath, prefixArgs: [standIn] };
}

function resetEnvironment(env = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
}

/** Dispatch one turn against the stand-in CLI through the real detached worker. */
async function start(directory, { message = 'Hang on.', env = {} } = {}) {
  resetEnvironment({ FAKE_ORPHAN_RECEIPT_DIR: path.join(directory, 'receipts'), ...env });
  return startClaudeTurn({ directory, cli: await standInCli(), workspace: directory, sessionId: SESSION,
    message, mcpConfig: MCP_CONFIG });
}

/** Start the stand-in CLI the way a worker would, so the process really names this request. */
async function startStandInCli(directory) {
  const cli = await standInCli();
  const child = spawn(cli.command, [...cli.prefixArgs, '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'auto', '--permission-prompts', 'none', '--session-id', SESSION,
    '--mcp-config', path.join(directory, CLAUDE_TURN_FILES.mcp)], {
    cwd: directory, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
  });
  strays.add(child.pid);
  return child;
}

/** The record a worker leaves behind when it dies mid-turn: its own pid, the CLI's, a heartbeat. */
async function writeOrphanRecord(directory, cliPid, { workerPid = DEAD_WORKER } = {}) {
  const now = new Date().toISOString();
  await writeFile(path.join(directory, CLAUDE_TURN_FILES.turn), JSON.stringify({ version: 1,
    requestId: 'orphan-request', sessionId: SESSION, resume: false, workspace: directory,
    command: process.execPath, prefixArgs: [standIn], args: [], mcpServer: 'futureaide',
    startedAt: now, workerPid }, null, 2));
  await writeFile(path.join(directory, CLAUDE_TURN_FILES.state), JSON.stringify({ version: 1,
    requestId: 'orphan-request', sessionId: SESSION, cliSessionId: SESSION, workspace: directory,
    state: 'running', phase: 'running', startedAt: now, updatedAt: now, heartbeatAt: now, endedAt: null,
    model: 'claude-stand-in', permissionMode: 'auto', sessionStarted: true,
    messages: [{ time: now, role: 'user', kind: 'dispatch', text: 'Hang on.' }], messagesDropped: 0,
    warnings: [], mcp: { required: 'futureaide', servers: [{ name: 'futureaide', status: 'connected' }], errors: [] },
    denials: [], rawTail: [], resultSeen: false, resultSubtype: null, resultIsError: false, resultText: null,
    resultErrors: [], turns: null, durationMs: null, costUsd: null, stopReason: null,
    pid: cliPid, exitCode: null, error: null }, null, 2));
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function waitUntil(check, { timeout = 30000, interval = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await delay(interval);
  }
}

async function waitForTurn(directory, done, options = {}) {
  let last;
  await waitUntil(async () => {
    last = await readClaudeTurn(directory);
    return done(last);
  }, { what: 'turn state', ...options });
  return last;
}

async function receipt(directory, name) {
  let parsed;
  await waitUntil(async () => {
    try { return Boolean(parsed = JSON.parse(await readFile(path.join(directory, 'receipts', name), 'utf8'))); }
    catch { return false; }
  }, { what: 'receipt ' + name });
  return parsed;
}

async function readJsonOptional(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function spawnSleeper() {
  const child = spawn(process.execPath, SLEEPER, { stdio: 'ignore', windowsHide: true });
  strays.add(child.pid);
  return child;
}

after(async () => {
  for (const directory of directories) await cancelClaudeTurn(directory).catch(() => undefined);
  for (const pid of strays) { try { process.kill(pid); } catch { /* already gone */ } }
  resetEnvironment();
});

// ---------------------------------------------------------------------------
// An orphaned CLI tree is not a finished turn
// ---------------------------------------------------------------------------

test('a live CLI whose worker is gone reads as open, and cancel reaps the whole tree', { timeout: 120000 }, async () => {
  const directory = await scratch('orphan');
  resetEnvironment({ FAKE_ORPHAN_RECEIPT_DIR: path.join(directory, 'receipts') });
  const cli = await startStandInCli(directory);
  const tree = await receipt(directory, 'pids.json');
  assert.equal(tree.cli, cli.pid, 'the stand-in CLI is the process on record');
  assert.ok(alive(tree.descendant), 'the CLI started a child of its own');
  await writeOrphanRecord(directory, tree.cli);
  assert.equal(alive(DEAD_WORKER), false, 'the recorded worker is really gone');

  // The regression: a live CLI tree is not a terminal failure.
  for (let attempt = 0; attempt < 5; attempt++) {
    const orphan = await readClaudeTurn(directory);
    assert.equal(orphan.state, 'running', 'a turn whose CLI tree is alive is not settled');
    assert.equal(orphan.error, undefined, 'no terminal error is reported while the tree still runs');
    assert.equal(orphan.workerPid, DEAD_WORKER, 'the record still names the worker');
    assert.equal(orphan.claudePid, tree.cli, 'the record still names the CLI');
    assert.ok(orphan.warnings.some(warning => warning.code === 'claude-turn-worker-lost'),
      'the lost worker is reported instead of hidden');
    await delay(150);
  }

  // Cancel confirms the whole tree before it says anything happened.
  const stopped = await cancelClaudeTurn(directory);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.state, 'cancelled');
  assert.deepEqual(stopped.remaining, []);
  assert.equal(alive(tree.cli), false, 'the orphaned CLI was reaped');
  assert.equal(alive(tree.descendant), false, 'the CLI child was reaped with it');
  assert.equal((await readClaudeTurn(directory)).state, 'cancelled');
  strays.delete(cli.pid);
});

test('the worker records its own pid, so a normal cancel still stops a turn the caller never named', { timeout: 180000 }, async () => {
  const directory = await scratch('self-claim');
  const started = await start(directory);
  const running = await waitForTurn(directory,
    value => Number.isSafeInteger(value.claudePid) && value.sessionStarted === true);

  // The gap ownership has to survive: the caller died before it could record the worker.
  const turnFile = path.join(directory, CLAUDE_TURN_FILES.turn);
  const turn = JSON.parse(await readFile(turnFile, 'utf8'));
  await writeFile(turnFile, JSON.stringify({ ...turn, workerPid: null }, null, 2));
  const state = JSON.parse(await readFile(path.join(directory, CLAUDE_TURN_FILES.state), 'utf8'));
  assert.equal(state.workerPid, started.workerPid, 'the worker recorded its own pid');

  const reread = await readClaudeTurn(directory);
  assert.equal(reread.state, 'running');
  assert.equal(reread.workerPid, started.workerPid, 'ownership survives without the caller record');

  // A normal cancel: the worker still names the turn, so it is killed with its CLI.
  const stopped = await cancelClaudeTurn(directory);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.cancelled, true);
  assert.equal(alive(started.workerPid), false, 'the worker is gone');
  assert.equal(alive(running.claudePid), false, 'the CLI is gone');
  strays.delete(started.workerPid);
});

test('a Chinese request directory is still recognized as this turn when only the worker is recorded', { timeout: 120000 }, async () => {
  const directory = await scratch('中文目录-启动空档');
  // A test-owned worker: its command line is the one the real worker has, with the request
  // directory in --turn, and it is the only process this turn has recorded so far.
  const worker = spawn(process.execPath, [...SLEEPER, '--', '--turn', directory], { stdio: 'ignore', windowsHide: true });
  strays.add(worker.pid);
  await delay(400);
  assert.ok(alive(worker.pid), 'the startup-gap worker is running');
  const now = new Date().toISOString();
  await writeFile(path.join(directory, CLAUDE_TURN_FILES.turn), JSON.stringify({ version: 1,
    requestId: 'request-cjk', sessionId: SESSION, workspace: directory, mcpServer: 'futureaide',
    startedAt: now, workerPid: worker.pid }, null, 2));
  await writeFile(path.join(directory, CLAUDE_TURN_FILES.state), JSON.stringify({ version: 1,
    requestId: 'request-cjk', sessionId: SESSION, state: 'running', phase: 'starting', startedAt: now,
    updatedAt: now, heartbeatAt: now, pid: null, sessionStarted: false }, null, 2));

  const gap = await readClaudeTurn(directory);
  assert.equal(gap.state, 'running', 'the startup gap is open, not finished');
  assert.equal(gap.claudePid, null, 'the CLI is not running yet');

  // The path in that command line is Chinese, and it still has to be recognised as this
  // request: misreading it leaves a live worker that cancel refuses to touch.
  const stopped = await cancelClaudeTurn(directory);
  assert.equal(stopped.stopped, true, 'a Chinese request path is this turn, not a stranger');
  assert.equal(stopped.cancelled, true);
  assert.deepEqual(stopped.remaining, []);
  await waitUntil(() => !alive(worker.pid), { what: 'the startup-gap worker to be stopped' });
  assert.equal(alive(worker.pid), false, 'the startup-gap worker really is gone');
  strays.delete(worker.pid);
});

// ---------------------------------------------------------------------------
// A recorded pid that is somebody else's is never killed
// ---------------------------------------------------------------------------
test('two recorded pids that belong to other processes are never killed', { timeout: 120000 }, async () => {
  const directory = await scratch('reused-pids');
  const workers = spawnSleeper();
  const clis = spawnSleeper();
  await delay(400);
  assert.ok(alive(workers.pid) && alive(clis.pid), 'both stand-ins for reused pids are running');
  // The old pids were reused: the two processes behind them never had anything to do with this.
  await writeFile(path.join(directory, CLAUDE_TURN_FILES.turn), JSON.stringify({ version: 1,
    requestId: 'request-reused', sessionId: SESSION, workerPid: workers.pid, startedAt: new Date().toISOString() }, null, 2));
  await writeFile(path.join(directory, CLAUDE_TURN_FILES.state), JSON.stringify({ version: 1,
    requestId: 'request-reused', sessionId: SESSION, state: 'running', phase: 'running', pid: clis.pid,
    startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    heartbeatAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() }, null, 2));

  let killed = 0;
  const refused = await cancelClaudeTurn(directory, { killTree: async () => { killed += 1; return { ok: true }; } });
  assert.equal(killed, 0, 'no process that belongs to another turn is killed');
  assert.ok(alive(workers.pid) && alive(clis.pid), 'both unrelated processes are still running');
  // The original processes had already left, so the turn is genuinely stopped - without a kill.
  assert.equal(refused.stopped, true);
  assert.equal(refused.cancelled, true);
  assert.deepEqual(refused.remaining, []);
  assert.match(refused.note, /other processes/);
  assert.equal((await readJsonOptional(path.join(directory, CLAUDE_TURN_FILES.state))).state, 'cancelled');
});

test('an unreadable identity is never counted as stopped', { timeout: 60000 }, async () => {
  const directory = await scratch('unknown-identity');
  const cli = spawnSleeper();
  await delay(400);
  await writeFile(path.join(directory, CLAUDE_TURN_FILES.turn), JSON.stringify({ version: 1,
    requestId: 'request-unknown', sessionId: SESSION, workerPid: DEAD_WORKER, startedAt: new Date().toISOString() }, null, 2));
  await writeFile(path.join(directory, CLAUDE_TURN_FILES.state), JSON.stringify({ version: 1,
    requestId: 'request-unknown', sessionId: SESSION, state: 'running', phase: 'running', pid: cli.pid,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }, null, 2));

  let killed = 0;
  const unknown = await cancelClaudeTurn(directory, {
    commandLines: async pids => new Map(pids.map(pid => [pid, { text: null, ok: false }])),
    killTree: async () => { killed += 1; return { ok: true }; },
  });
  assert.equal(killed, 0, 'nothing is killed on an identity that could not be read');
  assert.equal(unknown.stopped, false, 'an unreadable identity is not a stopped tree');
  assert.equal(unknown.cancelled, false);
  assert.equal(unknown.state, 'running');
  assert.deepEqual(unknown.remaining, [cli.pid]);
  assert.match(unknown.note, /could not be read/);
  assert.ok(alive(cli.pid), 'the process is left alone');
  assert.equal((await readJsonOptional(path.join(directory, CLAUDE_TURN_FILES.state))).state, 'running',
    'a refusal records no stop');
  assert.equal((await readClaudeTurn(directory)).state, 'running', 'the turn is not settled by a refusal');
});

// ---------------------------------------------------------------------------
// system/init disqualifies the turn before the CLI may act
// ---------------------------------------------------------------------------

test('a CLI that starts in another permission mode is stopped before it can write', { timeout: 180000 }, async () => {
  const directory = await scratch('early-permission');
  const sideEffect = path.join(directory, 'side-effect.txt');
  await start(directory, { env: { FAKE_ORPHAN_MODE: 'acceptEdits', FAKE_ORPHAN_SIDE_EFFECT: sideEffect } });
  const settled = await waitForTurn(directory, value => value.state !== 'running');
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error.code, 'claude-permission-mode-downgraded');
  assert.equal(settled.permissionMode, 'acceptEdits');
  const tree = await receipt(directory, 'pids.json');
  assert.equal(alive(tree.cli), false, 'the CLI was stopped instead of being left to finish');
  assert.equal(alive(tree.descendant), false, 'the CLI child was stopped with it');
  assert.equal(await readJsonOptional(path.join(directory, CLAUDE_TURN_FILES.cancel)), undefined,
    'the worker stopped the CLI itself: this is not a user cancel');
  // The write the turn would have made later never happens.
  await delay(2500);
  await assert.rejects(readFile(sideEffect, 'utf8'), error => error.code === 'ENOENT');
});

test('a CLI whose init rejects the callback server is stopped before it can write', { timeout: 180000 }, async () => {
  const directory = await scratch('early-mcp');
  const sideEffect = path.join(directory, 'side-effect.txt');
  await start(directory, { env: { FAKE_ORPHAN_REJECT_MCP: '1', FAKE_ORPHAN_SIDE_EFFECT: sideEffect } });
  const settled = await waitForTurn(directory, value => value.state !== 'running');
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error.code, 'claude-mcp-server-missing');
  assert.deepEqual(settled.mcp.servers, []);
  const tree = await receipt(directory, 'pids.json');
  assert.equal(alive(tree.cli), false, 'the CLI was stopped instead of being left to finish');
  assert.equal(alive(tree.descendant), false, 'the CLI child was stopped with it');
  await delay(2500);
  await assert.rejects(readFile(sideEffect, 'utf8'), error => error.code === 'ENOENT');
});
