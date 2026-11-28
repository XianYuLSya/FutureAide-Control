import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, renameSync, symlinkSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BACKEND_METHODS } from '../src/agent-backend.mjs';
import { AGY_TURN_FILES, cancelAgyTurn, readAgyTurn } from '../src/agy-cli-runner.mjs';
import { runAgyTurn } from '../src/agy-cli-worker.mjs';
import { TRUSTED_CALLER } from '../src/calling-context.mjs';
import { createCliCallbackServer, submitCliCallback } from '../src/cli-callback-bridge.mjs';
import { buildCliProxyEnv, publicRouteSummary, resolveCliRoute } from '../src/cli-proxy.mjs';
import { startReportService } from '../src/claude-report-server.mjs';
import { loadConfig } from '../src/config.mjs';
import { authorizeManagedTool, managedCliEnv, verifyManagedCaller } from '../src/managed-cli-policy.mjs';
import { scopedManagement } from '../src/mcp-server.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { boardName } from '../src/team-board.mjs';
import { classifyManagedRole, parseTeamConfigMarkdown, resolveRoleDefaults } from '../src/team-config-defaults.mjs';
import { git, plainDirectoryPath, withWorktreeLock, worktreePathKey } from '../src/worktree-guard.mjs';

const runFile = promisify(execFile);
const json = JSON.stringify;
const binding = record => ({ agentId: record.agentId, taskId: record.task.taskId,
  requestId: record.task.dispatches.at(-1).requestId, target: record.target });
const payload = result => JSON.parse(result.content[0].text);
const roleTable = rows => '| Role | Model | Target |\n|---|---|---|\n' + rows.join('\n');
const leadRow = '| shiftpilot / lead | gpt-5.4 high | codex-cli persistent |';
const model = { provider: 'openai', model: 'gpt-5.4' };

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }));
  return dir;
}

async function fixture(t, { roles, profile, inheritedRoles = false, longState = false, checkCliProxy } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-scope-'));
  const workspace = path.join(dir, 'repo');
  await mkdir(workspace);
  await git(workspace, ['init', '-q']);
  await git(workspace, ['config', 'user.name', 'Fixture']);
  await git(workspace, ['config', 'user.email', 'fixture@example.invalid']);
  await git(workspace, ['config', 'core.autocrlf', 'false']);
  await git(workspace, ['config', 'core.hooksPath', path.join(dir, 'no-hooks')]);
  await writeFile(path.join(workspace, '.gitignore'), '.work/\n');
  await writeFile(path.join(workspace, 'tracked.txt'), 'base\n');
  await git(workspace, ['add', '.']);
  await git(workspace, ['commit', '-qm', 'base']);
  const base = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  const configFile = path.join(dir, 'control.json');
  const tokenFile = path.join(dir, 'state', 'desktop-token.json');
  await writeFile(configFile, json({ workspace, antigravityCallerTokenFile: tokenFile, agentAutoCleanup: false,
    ...(roles && !profile && !inheritedRoles ? { teamConfigPath: 'roles.md' } : {}) }));
  if (profile) {
    const profileDir = path.join(dir, 'profiles');
    await mkdir(profileDir);
    await writeFile(path.join(profileDir, profile + '.json'), json({ workspace, ...(roles ? { teamConfigPath: '../roles.md' } : {}) }));
  }
  const team = path.join(dir, 'roles.md');
  if (roles) await writeFile(team, roles);
  if (inheritedRoles) {
    const previous = process.env.FUTUREAIDE_ROLES_CONFIG;
    process.env.FUTUREAIDE_ROLES_CONFIG = team;
    t.after(() => {
      if (previous === undefined) delete process.env.FUTUREAIDE_ROLES_CONFIG;
      else process.env.FUTUREAIDE_ROLES_CONFIG = previous;
    });
  }
  const config = await loadConfig(configFile, profile);
  if (longState) config.stateDirectory = path.join(config.stateDirectory, 'deep-'.repeat(23));

  const active = new Map();
  const deliveries = [];
  const stopped = [];
  const cleanups = [];
  const adapter = (_record, deps) => ({
    labels: { host: 'Fixture' },
    requiredMethods: BACKEND_METHODS,
    probe: async () => ({ identity: { application: 'fixture' }, methods: BACKEND_METHODS, treeProtocol: 1, reportProtocol: 1 }),
    create: async () => ({ sessionId: deps.load().sessionId, modelRequestsStarted: 0 }),
    beginTask: async () => ({ treeProtocol: 1, reportProtocol: 1, throughSeq: 0 }),
    cursor: async () => ({ throughSeq: 0 }),
    model: async () => model,
    selectModel: async () => model,
    models: async () => ({ default: model, routableProviders: ['openai'],
      groups: [{ id: 'openai', provider: 'openai', models: [{ id: model.model, reasoningEfforts: ['high'] }] }] }),
    observe: async () => {
      const record = deps.load();
      const running = active.has(record.agentId);
      return { sessionId: record.sessionId, taskId: record.task?.taskId, throughSeq: 0, currentModel: model,
        running, questions: [], reports: [], tree: { running, settled: !running, nodes: [] } };
    },
    history: async () => ({ messages: [], hasMore: false }),
    deliver: async input => {
      assert.equal(input.writeBlockReason(), undefined);
      const { agentId } = deps.load();
      active.set(agentId, input.requestId);
      deliveries.push({ agentId, ...input, env: deps.callerEnv, config: deps.config });
      return { accepted: true, status: 'accepted', delivery: 'new-turn', turnId: input.requestId, afterSeq: 0 };
    },
    receipt: async ({ requestId }) => deliveries.some(item => item.requestId === requestId)
      ? { status: 'accepted', result: { accepted: true, requestId } } : undefined,
    turn: async ({ requestId }) => ({ state: active.get(deps.load().agentId) === requestId ? 'running' : 'ended',
      correlation: 'request-id', completionReason: { kind: 'completed' } }),
    preemptTurn: async (record, { expectedRequestId }) => {
      assert.equal(active.get(record.agentId), expectedRequestId);
      active.delete(record.agentId);
      stopped.push(record.agentId);
      return { ok: true, stopped: true, sessionId: 'native-session', sessionResumable: true, sessionCwd: record.workspace };
    },
    answer: async () => ({ notSent: true }),
    destroy: async () => ({ destroyed: true }),
    cancel: async () => ({ cancelRequested: true }),
  });
  const service = createScopedAgents(config, {
    checkCliProxy,
    backendAdapters: { 'codex-cli': adapter, 'claude-cli': adapter },
    codexProbeRegistration: async () => ({ registered: true, tools: ['ask_parent', 'report_parent'] }),
    startSharedMonitor: async () => true });
  const store = service.store;
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await service.drainPolls();
    service.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  });
  const owner = { [TRUSTED_CALLER]: { source: 'antigravity', conversationId: 'fixture-team', workspace } };
  const get = name => store.list().find(record => record.name === name);
  const caller = record => ({ [TRUSTED_CALLER]: verifyManagedCaller(store, binding(record)) });
  const run = async (name, args = {}, extra = owner) => {
    const result = await service.run({ name, message: 'Assigned task for ' + name,
      target: 'codex-cli', lifetime: 'persistent', ...args }, extra);
    assert.equal(result.error, undefined, json(result));
    await service.poll(get(name).agentId);
    return get(name);
  };
  const settle = record => {
    active.delete(record.agentId);
    const current = get(record.name);
    current.state = current.task.state = 'completed';
    current.task.finishedAt = new Date().toISOString();
    current.observation = { running: false };
    current.task.dispatches.forEach(dispatch => { dispatch.state = 'completed'; });
    store.save(current);
    return current;
  };
  const merge = (record, opts) => service.manageTeam({ action: 'merge', target: record.name, ...opts }, owner);
  return { dir, config, configFile, tokenFile, team, workspace, base, deliveries, stopped, cleanups, owner, store, service, get, caller, run, settle, merge };
}

function interruptBeforeApply(t, store, member) {
  const save = store.save;
  t.mock.method(store, 'save', function (record, options) {
    const written = save.call(this, record, options);
    if (record.agentId === member.agentId && record.worktreeMerge?.stage === 'applying') {
      store.save.mock.restore();
      throw Object.assign(new Error('Interrupted after saving the applying stage'), { code: 'fixture-interruption' });
    }
    return written;
  });
}

test('a merge preserves conflicting staged bytes and accepts matching staged and working versions', async t => {
  const f = await fixture(t);
  const member = f.settle(await f.run('staged', { worktree: true }));
  const source = path.join(member.workspace, 'tracked.txt');
  await writeFile(source, 'staged change\n');
  await git(member.workspace, ['add', 'tracked.txt']);
  await writeFile(source, 'base\n');

  assert.equal((await f.merge(member)).error.code, 'worktree-retained');
  assert.equal((await git(member.workspace, ['show', ':tracked.txt'])).stdout, 'staged change\n');
  assert.equal(await readFile(path.join(f.workspace, 'tracked.txt'), 'utf8'), 'base\n');
  await git(member.workspace, ['restore', '--worktree', 'tracked.txt']);
  const merged = await f.merge(member);
  assert.equal(merged.ok, true, json(merged));
  assert.equal(await readFile(path.join(f.workspace, 'tracked.txt'), 'utf8'), 'staged change\n');
  await assert.rejects(lstat(member.worktreePath), { code: 'ENOENT' });
});

test('an interrupted merge replays from the preimage under a long state path', async t => {
  const f = await fixture(t, { longState: true });
  const member = f.settle(await f.run('replay', { worktree: true }));
  await writeFile(path.join(member.workspace, 'tracked.txt'), 'new bytes\n');
  interruptBeforeApply(t, f.store, member);
  assert.equal((await f.merge(member)).error.code, 'fixture-interruption');
  assert.equal(await readFile(path.join(f.workspace, 'tracked.txt'), 'utf8'), 'base\n');
  const result = await f.merge(member);
  assert.deepEqual([result.ok, result.applied, result.worktreeRemoved], [true, true, true], json(result));
  assert.equal(await readFile(path.join(f.workspace, 'tracked.txt'), 'utf8'), 'new bytes\n');
});

test('a pending merge retains divergent source or target and discards only from the preimage', async t => {
  const f = await fixture(t);
  const member = f.settle(await f.run('discard', { worktree: true }));
  const source = path.join(member.workspace, 'tracked.txt');
  const target = path.join(f.workspace, 'tracked.txt');
  await writeFile(source, 'first source\n');
  interruptBeforeApply(t, f.store, member);
  assert.equal((await f.merge(member)).error.code, 'fixture-interruption');
  await writeFile(source, 'later source\n');
  assert.equal((await f.merge(member)).error.code, 'worktree-retained');
  await writeFile(target, 'other target\n');
  const discard = () => f.service.delete({ name: member.name, discard_worktree: true }, f.owner);
  assert.equal((await discard()).error.code, 'worktree-retained');
  assert.equal(await readFile(source, 'utf8'), 'later source\n');
  await writeFile(target, 'base\n');
  assert.equal((await discard()).queued, true);
  assert.equal((await f.service.poll(member.agentId)).deleted, true);
  assert.equal(await readFile(target, 'utf8'), 'base\n');
  await assert.rejects(lstat(member.worktreePath), { code: 'ENOENT' });
});

test('discarding an interrupted merge reports that no files were applied', async t => {
  const f = await fixture(t);
  const member = f.settle(await f.run('receipt', { worktree: true }));
  await writeFile(path.join(member.workspace, 'tracked.txt'), 'unapplied file\n');
  interruptBeforeApply(t, f.store, member);
  assert.equal((await f.merge(member)).error.code, 'fixture-interruption');
  const result = await f.merge(member, { discard_worktree: true });
  assert.deepEqual([result.ok, result.applied, result.discarded, result.worktreeRemoved], [true, false, true, true], json(result));
  assert.deepEqual(result.mergedFiles, []);
  assert.match(result.summary, /弃置/);
  assert.equal(await readFile(path.join(f.workspace, 'tracked.txt'), 'utf8'), 'base\n');
});

test('worktree merge ignores inherited Git bindings and protects the real destination index', async t => {
  const f = await fixture(t);
  const member = f.settle(await f.run('indexer', { worktree: true }));
  const destination = path.join(f.workspace, 'tracked.txt');
  const alternate = path.join(f.dir, 'alternate.index');
  const index = await readFile(path.join(f.workspace, '.git', 'index'));
  await writeFile(alternate, index);
  await writeFile(path.join(member.workspace, 'tracked.txt'), 'incoming\n');
  await writeFile(destination, 'staged by owner\n');
  await git(f.workspace, ['add', 'tracked.txt']);
  await writeFile(destination, 'base\n');
  const overrides = { GIT_INDEX_FILE: alternate, GIT_DIR: path.join(f.dir, 'external-git'), GIT_WORK_TREE: f.dir };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    await assert.rejects(f.merge(member), { code: 'worktree-merge-conflict' });
    assert.equal((await git(f.workspace, ['show', ':tracked.txt'])).stdout, 'staged by owner\n');
    assert.equal(await readFile(destination, 'utf8'), 'base\n');
    assert.equal(await readFile(path.join(member.workspace, 'tracked.txt'), 'utf8'), 'incoming\n');
    await git(f.workspace, ['reset', 'HEAD', '--', 'tracked.txt']);
    const result = await f.merge(member);
    assert.equal(result.applied, true, json(result));
    assert.equal(await readFile(destination, 'utf8'), 'incoming\n');
    assert.deepEqual(await readFile(alternate), index);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('merge cleanup retains a scratch directory replaced by a link', async t => {
  const f = await fixture(t);
  const member = f.settle(await f.run('scratch', { worktree: true }));
  const outside = path.join(f.dir, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep'), 'untouched');
  await writeFile(path.join(member.workspace, 'tracked.txt'), 'incoming\n');
  const save = f.store.save;
  let scratchPath;
  t.mock.method(f.store, 'save', function (record, options) {
    const written = save.call(this, record, options);
    if (record.agentId === member.agentId && record.worktreeMerge?.stage === 'applied' && !scratchPath) {
      const scratchName = readdirSync(f.config.stateDirectory).find(name => name.startsWith('m-'));
      assert.ok(scratchName);
      scratchPath = path.join(f.config.stateDirectory, scratchName);
      renameSync(scratchPath, path.join(f.dir, 'original-scratch'));
      symlinkSync(outside, scratchPath, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return written;
  });
  assert.equal((await f.merge(member)).error.code, 'worktree-unverified');
  assert.equal((await lstat(scratchPath)).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'untouched');
  await rm(scratchPath);
  assert.equal((await f.merge(member)).worktreeRemoved, true);
});

test('expired incomplete locks recover and new owners appear atomically', async t => {
  const dir = await scratch(t);
  await git(dir, ['init', '-q']);
  const lock = path.join(dir, '.git', 'futureaide-worktree.lock');
  const old = new Date(Date.now() - 5000);
  for (const contents of ['', '{ broken']) {
    await writeFile(lock, contents);
    await utimes(lock, old, old);
    await withWorktreeLock(dir, async () => {
      const record = JSON.parse(await readFile(lock, 'utf8'));
      assert.equal(record.pid, process.pid);
      assert.match(record.nonce, /^[\da-f-]{36}$/i);
      if (process.platform === 'win32' || process.platform === 'linux') {
        assert.ok(record.startedAt);
        assert.match(record.commandFingerprint, /^[\da-f]{64}$/i);
      }
      await assert.rejects(withWorktreeLock(dir, () => assert.fail('live lock was stolen'), { waitMs: 0 }), { code: 'worktree-busy' });
    });
    await assert.rejects(lstat(lock), { code: 'ENOENT' });
  }
});

test('a worktree lock from an earlier process with the same PID can be recovered', async t => {
  const dir = await scratch(t);
  await git(dir, ['init', '-q']);
  const lock = path.join(dir, '.git', 'futureaide-worktree.lock');
  const current = await withWorktreeLock(dir, async () => JSON.parse(await readFile(lock, 'utf8')));
  assert.ok(current.startedAt || current.commandFingerprint);
  await writeFile(lock, json({ ...current, startedAt: 'earlier-process', commandFingerprint: '0'.repeat(64) }));
  await withWorktreeLock(dir, async () => {
    const owner = JSON.parse(await readFile(lock, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.nonce, current.nonce);
  }, { waitMs: 0 });
  await assert.rejects(lstat(lock), { code: 'ENOENT' });
});

test('recursive state cleanup leaves files outside a linked parent alone', async t => {
  const dir = await scratch(t);
  const root = path.join(dir, 'owned');
  const outside = path.join(dir, 'outside');
  await mkdir(path.join(root, 'local'), { recursive: true });
  await mkdir(path.join(outside, 'agent'), { recursive: true });
  await writeFile(path.join(outside, 'agent', 'keep.txt'), 'keep\n');
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await plainDirectoryPath(root, path.join(root, 'local')), true);
  assert.equal(await plainDirectoryPath(root, path.join(root, 'missing')), false);
  await assert.rejects(plainDirectoryPath(root, path.join(root, 'linked', 'agent')), { code: 'worktree-unverified' });
  assert.equal(await readFile(path.join(outside, 'agent', 'keep.txt'), 'utf8'), 'keep\n');
});

test('offline urgent posts persist the current lead binding and preempt on monitor recovery', async t => {
  const f = await fixture(t);
  const lead = await f.run('lead', { role: 'lead' });
  const worker = await f.run('worker', {}, f.caller(lead));
  const round = binding(lead);
  const bridge = createCliCallbackServer({ ...round, roster: f.store.location, port: 1, env: { FUTUREAIDE_MANAGED_CLI: '1' } });
  f.cleanups.push(() => bridge.close());

  const rejected = await bridge.callTool('futureaide_board_post', { message: '@lead invalid self mention', urgent: true });
  assert.equal(payload(rejected).error.code, 'permission-denied');
  const output = await bridge.callTool('futureaide_board_post', { message: '@worker priority change', urgent: true });
  assert.equal(output.isError, undefined);
  const receipt = payload(output);
  assert.equal(receipt.deferred.length, 1);
  const saved = f.store.listBoardMessages(lead.ownerId).messages.find(item => item.seq === receipt.seq);
  assert.deepEqual([saved.authorTaskId, saved.authorRequestId], [round.taskId, round.requestId]);
  await f.service.poll(worker.agentId);
  const routed = f.store.listBoardMessages(lead.ownerId).messages.find(item => item.seq === receipt.seq);
  assert.equal(routed.routed[0].action, 'preempted');
  assert.deepEqual(f.stopped, [worker.agentId]);
});

test('report and management authorization switch together when a preemption is saved', async t => {
  const f = await fixture(t);
  const member = await f.run('changing');
  const old = binding(member);
  const current = { ...old, requestId: 'next-round' };
  const note = { kind: 'ask', message: 'Which revision should I use?' };
  assert.equal(verifyManagedCaller(f.store, old).callerRequestId, old.requestId);
  member.task.preemption = { requestId: current.requestId, oldRequestId: old.requestId };
  assert.equal(f.store.save(member), true);
  assert.throws(() => verifyManagedCaller(f.store, old), { code: 'permission-denied' });
  assert.throws(() => f.store.submitParentMessage(member.agentId, note, old), { code: 'submission-not-owned' });
  assert.equal(verifyManagedCaller(f.store, current).callerRequestId, current.requestId);
  assert.equal(f.store.submitParentMessage(member.agentId, note, current).accepted, true);
});

test('a question saved before the HTTP response drops is returned once from the roster fallback', async t => {
  const f = await fixture(t);
  const member = await f.run('questioner');
  let saved;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { agentId, kind, message, ...dispatch } = JSON.parse(Buffer.concat(chunks));
    saved = f.store.submitParentMessage(agentId, { kind, message }, dispatch);
    res.writeHead(200).flushHeaders();
    res.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  f.cleanups.push(() => new Promise(resolve => server.close(resolve)));
  const request = { ...binding(member), roster: f.store.location, env: {}, kind: 'ask' };
  const fallback = await submitCliCallback({ ...request, port: server.address().port, message: 'Which color?' });
  assert.equal(fallback.submissionId, saved.submissionId);
  assert.equal(f.store.submissions(member.agentId, member.task.taskId).length, 1);
  const distinct = await submitCliCallback({ ...request, port: 1, message: 'Which size?' });
  assert.notEqual(distinct.submissionId, saved.submissionId);
  assert.equal(f.store.openQuestions(member).unanswered, 2);
});

test('managed CLI board reads select the named roster from the authenticated launch', async t => {
  const f = await fixture(t, { profile: 'named' });
  const member = await f.run('profile-member');
  await f.service.postBoard({ message: 'named team entry' }, f.owner);
  const args = [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'board', 'read'];
  const env = { ...process.env, FUTUREAIDE_MANAGED_CLI: '1', FUTUREAIDE_CONFIG: f.configFile,
    FUTUREAIDE_ROSTER_PATH: f.store.location, FUTUREAIDE_MANAGED_TARGET: member.target,
    FUTUREAIDE_PARENT_AGENT_ID: member.agentId, FUTUREAIDE_PARENT_TASK_ID: member.task.taskId,
    FUTUREAIDE_PARENT_REQUEST_ID: binding(member).requestId };
  const result = await runFile(process.execPath, args, { env, windowsHide: true });
  assert.match(result.stdout, /named team entry/);
  await assert.rejects(runFile(process.execPath, args, { env: { ...env, FUTUREAIDE_PARENT_REQUEST_ID: 'older-request' }, windowsHide: true }),
    error => /permission-denied/.test(error.stdout + error.stderr));
  const deniedRoster = roster => assert.rejects(runFile(process.execPath, args,
    { env: { ...env, FUTUREAIDE_ROSTER_PATH: roster }, windowsHide: true }),
  error => /permission-denied/.test(error.stdout + error.stderr));
  const unconfigured = path.join(f.dir, 'other', 'roster.sqlite');
  const defaultRoster = path.join(f.dir, 'state', 'roster.sqlite');
  for (const filename of [unconfigured, defaultRoster]) {
    await deniedRoster(filename);
    await assert.rejects(lstat(filename), { code: 'ENOENT' });
    await mkdir(path.dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
    db.close();
    const before = await readFile(filename);
    await deniedRoster(filename);
    assert.deepEqual(await readFile(filename), before);
    await assert.rejects(lstat(filename + '-wal'), { code: 'ENOENT' });
  }
});

test('batch inheritance drives both reservations and the authorization of each effective item', async t => {
  const f = await fixture(t);
  const result = await f.service.run({ role: 'builder', target: 'claude-cli', lifetime: 'persistent',
    timeoutMinutes: 2, worktree: true, baseSha: f.base, tasks: [
      { message: 'First' }, { name: 'overridden', role: 'scout', target: 'codex-cli', timeoutMinutes: 3, message: 'Second' },
    ] }, f.owner);
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every(item => item.created && !item.error), json(result));
  const a = f.get('builder1');
  const b = f.get('overridden');
  assert.deepEqual([a.role, a.target, a.lifetime, a.worktreeBaseHead, a.turnTimeoutMinutes], ['builder', 'claude-cli', 'persistent', f.base, 2]);
  assert.deepEqual([b.role, b.target, b.lifetime, b.worktreeBaseHead, b.turnTimeoutMinutes], ['scout', 'codex-cli', 'persistent', f.base, 3]);

  const reviewer = await f.run('reviewer', { role: 'reviewer' });
  const act = tasks => authorizeManagedTool(f.store, verifyManagedCaller(f.store, binding(reviewer)), 'futureaide_run_agent',
    { role: 'scout', target: 'codex-cli', lifetime: 'once', workspaceMode: 'worktree', tasks });
  assert.equal(act([{ worktree: false, message: 'Read only' }]).readOnlyScout, true);
  assert.throws(() => act([{ message: 'Inherits worktree' }]), { code: 'permission-denied' });
  assert.throws(() => act([{ worktree: false, target: 'claude-cli', message: 'Wrong target' }]), { code: 'permission-denied' });
});

test('reviving a stored scout by mention preserves the read-only execution flag', async t => {
  const f = await fixture(t);
  const lead = await f.run('lead', { role: 'lead' });
  for (const [name, readOnlyScout] of [['readonly', true], ['ordinary', false]]) {
    f.store.saveAgentStub({ agentId: 'stub-' + name, rootOwnerId: lead.ownerId, ownerId: lead.ownerId, name, role: 'scout',
      parentAgentId: lead.agentId, workspace: f.workspace, target: 'codex-cli', readOnlyScout });
    assert.equal(f.store.getAgentStub(lead.ownerId, name).readOnlyScout === true, readOnlyScout);
    const post = await f.service.postBoard({ message: '@' + name + ' review the fixture' }, f.owner);
    assert.equal(post.routed[0].action, 'revived', json(post));
    const revived = f.get(name);
    assert.equal(revived.readOnlyScout === true, readOnlyScout);
    assert.equal(f.deliveries.findLast(item => item.agentId === revived.agentId).readOnly === true, readOnlyScout);
  }
});

test('older roster stubs recover read-only restrictions on migration and revival', async t => {
  const f = await fixture(t);
  const parent = await f.run('parent', { role: 'reviewer' });
  const lead = await f.run('captain', { role: 'lead' });
  const save = (name, parentAgentId) => f.store.saveAgentStub({ agentId: 'archived-' + name, rootOwnerId: parent.ownerId,
    ownerId: parent.ownerId, name, role: 'scout', parentAgentId, workspace: f.workspace, target: 'codex-cli' });
  save('known', parent.agentId);
  save('missing', 'unavailable-parent');
  save('known-lead', lead.agentId);
  const file = f.store.location;
  f.store.db.exec('ALTER TABLE team_agent_stubs DROP COLUMN readOnlyScout');
  await writeFile(f.team, roleTable([leadRow]));
  const migrated = new RosterStore(file, { teamConfigPath: f.team });
  try {
    assert.equal(migrated.getAgentStub(parent.ownerId, 'known').readOnlyScout, true);
    assert.equal(migrated.getAgentStub(parent.ownerId, 'known-lead').readOnlyScout, undefined);
    assert.equal(migrated.findAgentStubGlobal('archived-missing').readOnlyScout, true);
    assert.equal(migrated.listAgentStubs(parent.ownerId).find(stub => stub.name === 'missing').readOnlyScout, true);
    assert.equal(migrated.db.prepare('SELECT readOnlyScout FROM team_agent_stubs WHERE agentId=?').get('archived-known').readOnlyScout, null);
  } finally { migrated.close(); }
  const post = await f.service.postBoard({ message: '@missing inspect the fixture' }, f.owner);
  assert.equal(post.routed[0].action, 'revived', json(post));
  const revived = f.get('missing');
  assert.equal(revived.readOnlyScout, true);
  assert.equal(f.deliveries.findLast(item => item.agentId === revived.agentId).readOnly, true);
});

test('updating an existing proxy binding preserves user configuration and stored targets', async t => {
  const f = await fixture(t, { roles: roleTable([leadRow]), checkCliProxy: async () => ({ ok: true }) });
  const legacyTarget = 'retired-cli';
  const roles = parseTeamConfigMarkdown(roleTable([
    `| retired | old-model | ${legacyTarget} persistent |`,
    '| pilot | gemini-4-neon-high | agy-cli once |',
  ]));
  assert.equal(roles.retired, undefined);
  assert.deepEqual(roles.pilot, { target: 'agy-cli', model: 'gemini-4-neon-high', lifetime: 'once' });
  const record = await f.run('legacy');
  f.store.save({ ...record, target: legacyTarget });
  const oldConfig = JSON.parse(await readFile(f.configFile, 'utf8'));
  oldConfig.cliRoutes = { [legacyTarget]: 7901, 'codex-cli': 17913 };
  await writeFile(f.configFile, json(oldConfig));
  const route = await f.service.manageCliProxy({ action: 'bind', target: 'agy-cli', proxy: 7901 });
  assert.equal(route.ok, true);
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')),
    { ...oldConfig, cliRoutes: { ...oldConfig.cliRoutes, 'agy-cli': 7901 } });
  const listed = await f.service.list(f.owner);
  assert.equal(listed.items.find(agent => agent.name === record.name).target, legacyTarget);
  assert.equal((await f.service.poll(record.agentId)).target, legacyTarget);
  await assert.rejects(f.service.create({ name: 'unsupported', target: legacyTarget, lifetime: 'once' }, f.owner),
    { code: 'invalid-target' });
});

test('worktree paths resolve the same state root despite mixed Windows casing', async t => {
  if (process.platform !== 'win32') return;
  const state = await scratch(t);
  const child = path.join(state, 'worktree-state');
  await mkdir(child);
  assert.equal(worktreePathKey(state), worktreePathKey(state.toUpperCase()));
  assert.equal(await plainDirectoryPath(state, child.toUpperCase()), true);
});

test('managed bridge forwards the external role table and callbacks can resolve it from config', async t => {
  const f = await fixture(t, { roles: roleTable([leadRow]), profile: 'named' });
  const lead = await f.run('pilot', { role: 'shiftpilot' });
  const b = binding(lead);
  const launch = f.deliveries.find(item => item.agentId === lead.agentId);
  assert.equal(launch.env.FUTUREAIDE_ROLES_CONFIG, f.team);
  assert.equal(classifyManagedRole('shiftpilot', { env: launch.env }), 'lead');

  const report = await startReportService({ store: f.store, port: 0, teamConfigPath: f.team,
    antigravityCallerTokenFile: f.tokenFile, management: scopedManagement({ service: f.service }) });
  f.cleanups.push(() => {
    report.server.closeAllConnections();
    return report.close();
  });
  const bridge = createCliCallbackServer({ ...b, roster: f.store.location, configFile: f.configFile,
    port: report.port, env: { FUTUREAIDE_MANAGED_CLI: '1' } });
  f.cleanups.push(() => bridge.close());
  assert.ok((await bridge.listTools()).some(tool => tool.name === 'futureaide_run_agent'));
  assert.equal((await bridge.callTool('futureaide_list_agents')).isError, undefined);
});

test('a role table selected through the parent environment is sent to the managed launch', async t => {
  const f = await fixture(t, { roles: roleTable([leadRow]), inheritedRoles: true });
  const member = await f.run('pilot', { role: 'shiftpilot', target: 'claude-cli' });
  const launch = f.deliveries.find(item => item.agentId === member.agentId);
  assert.equal(f.config.teamConfigPath, undefined);
  assert.equal(launch.env.FUTUREAIDE_ROLES_CONFIG, f.team);
  assert.equal(launch.config.antigravityCallerTokenFile, undefined);
  const child = buildCliProxyEnv(managedCliEnv({ ...launch.env, futureaide_antigravity_caller_token_file: f.tokenFile }),
    { mode: 'proxy', proxyUrl: 'http://localhost:7901' });
  assert.equal(child.FUTUREAIDE_ROLES_CONFIG, f.team);
  assert.equal(classifyManagedRole('shiftpilot', { env: child }), 'lead');
  assert.equal(child.FUTUREAIDE_MANAGED_CLI_TOKEN_FILE, launch.env.FUTUREAIDE_MANAGED_CLI_TOKEN_FILE);
  assert.equal(child.FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE, undefined);
  assert.equal(child.futureaide_antigravity_caller_token_file, undefined);
});

test('role abbreviations are resolved only for a unique external match and the board uses the same table', async t => {
  const dir = await scratch(t);
  const file = path.join(dir, 'roles.md');
  const row = '| release coordinator / lead | gpt-5.4 high | codex-cli persistent |';
  const opts = { teamConfigPath: file };
  assert.equal(resolveRoleDefaults('release', opts).roleKey, 'release');
  assert.equal(resolveRoleDefaults('release', opts).matched, false);
  await writeFile(file, roleTable([row]));
  assert.equal(resolveRoleDefaults('release', opts).roleKey, 'release coordinator');
  assert.equal(classifyManagedRole('release', opts), 'lead');
  assert.equal(boardName({ name: 'seat', role: 'release' }, opts).role, 'release coordinator');
  await writeFile(file, roleTable([row, '| release engineer | gpt-5.4 high | codex-cli once |']));
  assert.equal(resolveRoleDefaults('release', opts).matched, false);
  assert.equal(classifyManagedRole('release', opts), 'base');
  assert.equal(resolveRoleDefaults('release coordinator', opts).matched, true);
});

test('Antigravity CLI keeps a turn open until its process cage stop is verified', async t => {
  const dir = await scratch(t);
  const { turn, state, terminal } = AGY_TURN_FILES;
  await writeFile(path.join(dir, turn), json({ requestId: 'fixture-request', workspace: dir,
    route: { mode: 'proxy', proxyUrl: 'http://localhost:1000' } }));
  let attempts = 0;
  await assert.rejects(runAgyTurn({ directory: dir, checkProxy: async () => ({ ok: false, error: 'fixture offline' }),
    killCage: async () => { attempts++; return { ok: false }; },
  }), { code: 'agy-cage-unverified' });
  assert.equal(attempts, 3);
  assert.equal(JSON.parse(await readFile(path.join(dir, state))).cleanupPending, true);
  await assert.rejects(lstat(path.join(dir, terminal)), { code: 'ENOENT' });
  const pending = await readAgyTurn(dir, { isAlive: () => false });
  assert.deepEqual([pending.state, pending.cleanupPending, pending.error.code], ['running', true, 'agy-cage-unverified']);
  await assert.rejects(cancelAgyTurn(dir, { expectedRequestId: 'fixture-request', isAlive: () => false,
    killCage: async () => ({ ok: false }) }), { code: 'preempt-cage-still-running' });
  assert.equal((await readAgyTurn(dir, { isAlive: () => false })).cleanupPending, true);
  const stopped = await cancelAgyTurn(dir, { isAlive: () => false, killCage: async () => ({ ok: true }) });
  assert.equal(stopped.stopped, true);
  assert.equal((await readAgyTurn(dir, { isAlive: () => false })).state, 'cancelled');
});

test('token values and proxy userinfo are scrubbed from diagnostics and child bindings', async t => {
  const f = await fixture(t, { checkCliProxy: async () => ({ ok: true }) });
  const member = await f.run('isolated');
  const env = f.deliveries.find(item => item.agentId === member.agentId).env;
  assert.equal(env.FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE, undefined);
  assert.equal(env.FUTUREAIDE_MANAGED_CLI_TOKEN_FILE, path.join(path.dirname(f.tokenFile), 'managed-cli-caller.json'));

  const proxyUrl = "http://proxyuser:'proxy pass'@localhost:9443";
  assert.equal(publicRouteSummary({ proxyUrl }).proxy, 'http://localhost:9443');
  assert.equal(publicRouteSummary({ proxyUrl: 'http://proxyuser:proxy pass@localhost:9443' }).proxy, 'http://localhost:9443');
  const bound = await f.service.manageCliProxy({ action: 'bind', target: 'codex-cli', proxy: proxyUrl });
  const status = await f.service.manageCliProxy({ action: 'status', target: 'codex-cli' });
  for (const result of [bound, status]) {
    assert.equal(result.routes[0].proxyUrl, 'http://localhost:9443');
    assert.doesNotMatch(json(result), /proxyuser|proxy pass/);
  }
  const bad = await resolveCliRoute({ target: 'codex-cli', config: { cliRoutes: { 'codex-cli': proxyUrl } },
    env: {}, checkProxy: async () => ({ ok: false, error: 'could not open ' + proxyUrl }) });
  assert.doesNotMatch(bad.error, /proxyuser|proxy pass/);
  assert.match(bad.error, /localhost:9443/);
});

test('merge applies tracked changes when .work is gitignored and completes cleanup on discardWorktree retry', async t => {
  const f = await fixture(t);
  const member = f.settle(await f.run('ignored-work', { worktree: true }));
  await mkdir(path.join(member.workspace, '.work'), { recursive: true });
  await writeFile(path.join(member.workspace, '.work', 'scratch.log'), 'temp log\n');
  await writeFile(path.join(member.workspace, 'tracked.txt'), 'merged with ignored .work\n');
  const retained = await f.merge(member);
  assert.equal(retained.applied, true, json(retained));
  assert.equal(retained.error?.code, 'worktree-retained');
  assert.equal(await readFile(path.join(f.workspace, 'tracked.txt'), 'utf8'), 'merged with ignored .work\n');
  const completed = await f.merge(member, { discardWorktree: true });
  assert.equal(completed.ok, true, json(completed));
  assert.equal(completed.worktreeRemoved, true);
});
