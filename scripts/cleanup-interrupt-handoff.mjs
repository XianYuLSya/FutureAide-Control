// Exercise a real old-to-new monitor handoff against a private DSH loopback.
// Run from any directory: node scripts/cleanup-interrupt-handoff.mjs [--old-tree PATH]
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RosterStore } from '../src/roster-store.mjs';
import { startDshFixture } from '../test/assembly/dsh.mjs';
import { freePort, writeControlConfig, waitForHealth, until } from '../test/assembly/fixture.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--old-tree')) {
  throw new Error('Usage: node scripts/cleanup-interrupt-handoff.mjs [--old-tree PATH]');
}
const old = path.resolve(args[1] ?? path.join(here, '../interrupt-queue-20261122'));
const commit = '9cc875baceccf339292465e6b4dc46414aee0c11';
const git = (...argv) => execFileSync('git', ['-C', old, ...argv], { encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), commit, 'Old tree must be at the pinned commit');
assert.equal(git('diff', '--no-ext-diff', commit, '--', 'src', 'package.json', 'package-lock.json'), '',
  'Old source or dependency manifest differs from pinned commit');
assert.equal(git('ls-files', '--others', '--exclude-standard', '--', 'src'), '',
  'Untracked old source could affect the worker');

const root = path.join(here, '.runtime', 'verification', 'cleanup-interrupt-handoff', String(Date.now()));
const workspace = path.join(root, 'workspace');
await mkdir(workspace, { recursive: true });
await mkdir(path.join(root, 'managed-host'), { recursive: true });
const dsh = await startDshFixture({ root, workspace });
const port = await freePort();
const config = await writeControlConfig({ root, workspace, dsh, reportPort: port });
const loader = path.join(root, 'isolation.mjs');
await writeFile(loader, `
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (url.endsWith('/codex-ipc.mjs')) {
      const source = String(result.source);
      const anchor = '(method, params, options) => nativeRpc.request(method, params, options)';
      if (!source.includes(anchor)) throw new Error('Unknown IPC boundary');
      return { ...result, source: source.replace(anchor,
        'async () => { throw new Error("Desktop disabled in handoff fixture") }') };
    }
    if (url.endsWith('/codex-notify.mjs')) {
      const source = String(result.source);
      const anchor = 'export async function invokeCodexTool(threadId, toolName, args, options = {}) {';
      if (!source.includes(anchor)) throw new Error('Unknown desktop boundary');
      return { ...result, source: source.replace(anchor,
        anchor + 'throw new Error("Desktop disabled in handoff fixture");') };
    }
    return result;
  }
});
`);
const env = {
  ...process.env,
  NODE_OPTIONS: `--import=${pathToFileURL(loader).href}`,
  FUTUREAIDE_MONITOR_TRACE: '1',
};
for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME',
  'CLAUDE_CONFIG_DIR', 'TEMP', 'TMP', 'DSH_HOME']) {
  env[key] = path.join(root, key);
  await mkdir(env[key], { recursive: true });
}
for (const key of ['CODEX_THREAD_ID', 'FUTUREAIDE_INSTANCE_FILE',
  'FUTUREAIDE_LAUNCH_URL', 'FUTUREAIDE_DATA_ROOT']) delete env[key];

const store = new RosterStore(path.join(root, 'state', 'roster.sqlite'));
const children = [];
const evidence = { root, old, oldCommit: commit, config, started: new Date().toISOString(), workers: [] };
async function start(tree) {
  const holder = `monitor-${randomUUID()}`;
  assert.ok(store.claimLease('idle-monitor', holder, 60000));
  const child = spawn(process.execPath,
    [path.join(tree, 'src/scoped-worker.mjs'), '--config', config, '--lease', holder],
    { cwd: tree, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const row = { pid: child.pid, holder, start: new Date().toISOString(), stderr: '' };
  evidence.workers.push(row);
  children.push(child);
  child.stderr.on('data', chunk => { row.stderr += chunk; });
  child.stdout.resume();
  const done = new Promise(resolve => child.once('exit', (code, signal) => {
    row.exit = { code, signal, at: new Date().toISOString() };
    resolve();
  }));
  await waitForHealth(port, { timeoutMs: 20000 });
  return { row, done };
}
async function release(worker, label) {
  store.releaseLease('idle-monitor', worker.row.holder);
  let timer;
  try {
    await Promise.race([worker.done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} worker did not exit`)), 12000);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(worker.row.exit.code, 0);
}

try {
  const first = await start(old);
  const record = {
    agentId: 'handoff-agent', ownerId: 'handoff-owner', name: 'handoff',
    sessionId: 'handoff-session', workspace, target: 'dsh', lifetime: 'once',
    created: true, state: 'running',
    task: {
      taskId: 'handoff-task', message: 'original once task', state: 'running',
      dispatches: [{ requestId: 'original-request', kind: 'task', message: 'original once task',
        state: 'completed', accepted: true }],
      answers: [], reports: [],
    },
  };
  store.saveOwner({ ownerId: record.ownerId, workspace, createdAt: new Date().toISOString() });
  store.insert(record);
  assert.ok(store.enqueueSupplement(record, 'handoff-request', 'payload across handoff', undefined,
    { mode: 'queue', receipt: { delivery: 'local-pending', mode: 'queue' } }));
  evidence.queuedBeforeRelease = store.supplement('handoff-request');
  evidence.oldLeaseBeforeRelease = store.lease('idle-monitor');
  await release(first, 'old');
  evidence.afterOld = store.supplement('handoff-request');
  assert.equal(evidence.afterOld.status, 'queued');

  const second = await start(here);
  await until(() => store.supplement('handoff-request')?.status === 'accepted',
    { timeoutMs: 25000, message: 'new worker consumption' });
  evidence.afterNew = store.supplement('handoff-request');
  evidence.record = store.get(record.agentId);
  evidence.calls = dsh.calls().filter(call => call.method === 'session/prompt');
  assert.equal(evidence.calls.length, 1);
  assert.equal(evidence.calls[0].args.request.requestId, 'handoff-request');
  assert.equal(evidence.calls[0].args.request.content[0].text, 'payload across handoff');
  assert.equal(evidence.record.task.dispatches.filter(item => item.requestId === 'handoff-request').length, 1);
  assert.equal(evidence.record.task.dispatches.filter(item => item.requestId === 'original-request').length, 1);
  assert.equal(evidence.record.task.message, 'original once task');
  assert.equal(evidence.record.lifetime, 'once');
  assert.equal(evidence.record.task.taskId, 'handoff-task');
  assert.equal(evidence.afterNew.requestId, 'handoff-request');
  assert.equal(evidence.afterNew.message, 'payload across handoff');
  evidence.final = store.submitParentMessage(record.agentId,
    { kind: 'report', message: 'handoff final', final: true });
  assert.equal(evidence.final.taskId, 'handoff-task');
  assert.equal(evidence.final.accepted, true);
  assert.throws(() => store.submitParentMessage(record.agentId,
    { kind: 'report', message: 'duplicate final', final: true }), { code: 'final-already-submitted' });
  evidence.finalRows = store.submissions(record.agentId, 'handoff-task');
  assert.equal(evidence.finalRows.filter(item => item.final).length, 1);
  await release(second, 'new');
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack;
  process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await dsh.close();
  store.close();
  await writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ root, passed: evidence.passed, error: evidence.error,
    workers: evidence.workers.map(({ pid, exit }) => ({ pid, exit })) }));
}
