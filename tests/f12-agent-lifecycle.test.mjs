import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BACKEND_METHODS } from '../src/agent-backend.mjs';
import { TRUSTED_CALLER } from '../src/calling-context.mjs';
import { loadConfig } from '../src/config.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { classifyManagedRole, loadTeamConfigDefaults } from '../src/team-config-defaults.mjs';
import { compactBoardPost, compactTeamManage } from '../src/tool-view.mjs';
import { git, inspectWorktree, withWorktreeLock } from '../src/worktree-guard.mjs';

const targets = ['codex-cli', 'claude-cli', 'agy-cli'];
const deferred = () => Promise.withResolvers();
const model = { provider: 'openai', model: 'gpt-5.4' };
const catalog = { default: model, routableProviders: ['openai'],
  groups: [{ id: 'openai', provider: 'openai', models: [{ id: model.model, name: 'Fixture', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }] }] };

async function fixture(t, { autoCleanup = false, teamConfig = '' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'futureaide-f12-'));
  const repo = path.join(dir, 'repo');
  const cwd = path.join(repo, 'packages', 'Example');
  await mkdir(cwd, { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.name', 'Fixture']);
  await git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  await git(repo, ['config', 'core.hooksPath', path.join(dir, 'no-hooks')]);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repo, '.gitignore'), '*.ignored\n.work/\n');
  await writeFile(path.join(cwd, 'index.txt'), 'initial\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'base']);
  const base = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const cfg = path.join(dir, 'config.json');
  const team = path.join(dir, 'team.md');
  if (teamConfig) await writeFile(team, teamConfig);
  await writeFile(cfg, JSON.stringify({ dataRoot: path.join(dir, 'data'), workspace: cwd, agentAutoCleanup: autoCleanup,
    teamConfigPath: path.basename(team) }));
  const config = await loadConfig(cfg);
  const runs = new Map();
  const delivered = [];
  const stopped = [];
  const answered = [];
  const controls = {};
  const store = new RosterStore(path.join(dir, 'roster.sqlite'));
  const backendAdapters = Object.fromEntries([...targets, 'codex-desktop'].map(target => [target, (record, deps) => {
    const load = deps.load;
    const state = () => ({ answered: [], answers: {}, ...deps.readNativeState() });
    const questions = () => (deps.readParentSubmissions ?? deps.readCodexReportState)().questions
      .filter(item => item.taskId === load().task?.taskId)
      .map(item => state().answered.includes(item.id) ? { ...item, state: 'answered' } : item);
    return {
      target,
      labels: { host: 'Fixture' },
      requiredMethods: BACKEND_METHODS,
      probe: async () => ({ identity: { application: target }, methods: BACKEND_METHODS, treeProtocol: 1, reportProtocol: 1 }),
      create: async () => ({ sessionId: load().sessionId, modelRequestsStarted: 0 }),
      beginTask: async () => ({ treeProtocol: 1, reportProtocol: 1, throughSeq: 0 }),
      cursor: async () => ({ throughSeq: 0 }),
      model: async () => model,
      selectModel: async () => model,
      models: async () => catalog,
      observe: async () => {
        const current = load();
        const running = runs.get(current.agentId)?.running === true;
        const node = { sessionId: current.sessionId, status: running ? 'running' : 'idle', activity: running ? 'running' : 'idle' };
        return { sessionId: current.sessionId, taskId: current.task?.taskId, throughSeq: 0,
          currentModel: model, running, questions: questions(), reports: [], tree: { running, settled: !running, nodes: [node] } };
      },
      history: async () => ({ messages: [], hasMore: false }),
      ...(target === "codex-desktop" ? { rootTurn: async () => {
        const current = runs.get(load().agentId);
        return { known: true, running: current?.running === true, turnId: current?.turnId };
      } } : {}),
      deliver: async input => {
        const current = load();
        assert.equal(input.writeBlockReason(), undefined);
        const prior = runs.get(current.agentId);
        const steering = target === 'codex-desktop' && input.mode === 'steer' && prior?.running;
        const turnId = steering ? prior.turnId : input.requestId;
        runs.set(current.agentId, { running: true, requestId: input.requestId, turnId });
        delivered.push({ ...input, agentId: current.agentId, cwd: current.workspace, turnId });
        if (teamConfig && target !== 'codex-desktop') assert.equal(deps.callerEnv.FUTUREAIDE_ROLES_CONFIG, team);
        return { accepted: true, status: 'accepted', delivery: steering ? 'current-turn' : 'new-turn', turnId, afterSeq: 0 };
      },
      receipt: async ({ requestId }) => delivered.some(item => item.requestId === requestId)
        ? { status: 'accepted', result: { accepted: true, requestId } } : undefined,
      turn: async ({ requestId }) => load().agentId && runs.get(load().agentId)?.requestId === requestId && runs.get(load().agentId).running
        ? { state: 'running', correlation: 'request-id' }
        : { state: 'ended', correlation: 'request-id', completionReason: { kind: 'completed' } },
      answer: async ({ answerId, message, questionIds }) => {
        const value = state();
        const pending = questions().filter(item => item.state === 'pending');
        if (!questionIds.every(id => pending.some(item => item.id === id))) return { notSent: true, pendingQuestions: pending };
        answered.push({ answerId, message, questionIds });
        value.answered.push(...questionIds);
        const receipt = { consumedQuestionIds: questionIds, continuation: 'Answer: ' + message, taskId: load().task.taskId };
        value.answers[answerId] = receipt;
        deps.writeNativeState(value);
        return receipt;
      },
      async preemptTurn(binding, { expectedRequestId }) {
        const current = load();
        const run = runs.get(current.agentId);
        assert.equal(binding.task.taskId, current.task.taskId);
        assert.equal(current.task.preemption.oldRequestId, expectedRequestId);
        assert.equal(run.requestId, expectedRequestId);
        stopped.push({ agentId: current.agentId, expectedRequestId });
        await controls.onPreempt?.(current);
        if (controls.stopFailure) return { ok: false, stopped: false };
        run.running = false;
        return { ok: true, stopped: true, sessionId: 'native-session', sessionResumable: controls.sessionResumable !== false, sessionCwd: current.workspace };
      },
      cancel: async () => ({ cancelRequested: true }),
      destroy: async () => controls.destroyFailure ? { destroyed: false } : { destroyed: true },
    };
  }]));
  const service = createScopedAgents(config, { store, backendAdapters,
    codexProbeRegistration: async () => ({ registered: true, tools: ["ask_parent", "report_parent"] }),
    startSharedMonitor: async () => true });
  t.after(async () => {
    await service.drainPolls();
    service.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  });
  const boss = (id = 'f12-boss', workspace = cwd) => ({
    [TRUSTED_CALLER]: { source: 'antigravity', conversationId: id, workspace },
  });
  const get = name => store.list().find(item => item.name === name);
  const caller = (member, fields = {}) => ({ [TRUSTED_CALLER]: { source: 'managed-cli', callerAgentId: member.agentId,
    ownerId: member.ownerId, callerTaskId: member.task?.taskId, callerRequestId: member.task?.dispatches?.at(-1)?.requestId,
    workspace: cwd, ...fields } });
  const run = async (name, args = {}, extra = boss()) => {
    const result = await service.run({ name, message: 'Original work for ' + name, target: 'codex-cli',
      lifetime: 'persistent', ...args }, extra);
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    const member = get(name);
    await service.poll(member.agentId);
    return get(name);
  };
  const submit = (member, kind, message, final = false) => store.submitParentMessage(member.agentId,
    { kind, message, final }, { taskId: member.task.taskId, requestId: member.task.dispatches.at(-1).requestId, target: member.target });
  const end = member => { runs.get(member.agentId).running = false; };
  const settle = member => {
    end(member);
    const current = store.get(member.agentId);
    current.state = current.task.state = 'completed';
    current.task.finishedAt = '2020-01-01T00:00:00.000Z';
    for (const dispatch of current.task.dispatches) dispatch.state = 'completed';
    current.observation = { running: false };
    store.save(current);
    return current;
  };
  return { dir, repo, cwd, base, team, service, store, boss, caller, get, run, submit, end, settle, controls, delivered, stopped, answered };
}

test('H01 explicit answers gate ordinary sends, a reused run and a durable board route', async t => {
  const f = await fixture(t);
  const member = await f.run('worker');
  f.submit(member, 'ask', 'First?');
  f.submit(member, 'ask', 'Second?');
  f.end(member);
  await f.service.poll(member.agentId);
  const [q1, q2] = f.get('worker').observation.questions;
  for (const mode of [undefined, 'queue', 'steer']) await f.service.send({ name: 'worker', message: 'ordinary', mode }, f.boss());
  await f.service.run({ name: 'worker', message: 'reused', target: 'codex-cli' }, f.boss());
  const post = await f.service.postBoard({ message: '@worker board note' }, f.boss());
  assert.equal(post.routed[0].action, 'deferred');
  assert.equal(f.store.supplements(member.agentId).length, 4);
  assert.equal(f.answered.length, 0);
  assert.deepEqual(f.store.openQuestions(f.get('worker')), { unanswered: 2, undelivered: 0 });
  const first = await f.service.answer({ name: 'worker', message: 'A1' }, f.boss());
  assert.deepEqual(first.questionIds, [q1.id]);
  await f.service.poll(member.agentId);
  assert.equal(f.delivered.at(-1).message, 'Answer: A1');
  assert.equal(f.store.openQuestions(f.get('worker')).unanswered, 1);
  assert.throws(() => f.submit(f.get('worker'), 'report', 'Cannot yet finish', true), { code: 'question-unanswered' });
  assert.equal((await f.service.answer({ name: 'worker', message: 'Stale', questionIds: [q1.id, q2.id] }, f.boss())).reason, 'question-changed');
  assert.equal(f.answered.length, 1);
  f.end(member);
  await f.service.answer({ name: 'worker', message: 'A2', questionId: q2.id }, f.boss());
  await f.service.poll(member.agentId);
  assert.equal(f.delivered.at(-1).message, 'Answer: A2');
  f.end(member);
  await f.service.monitorScan({ only: [member.agentId], force: true });
  for (let i = 0; i < 5; i += 1) {
    f.end(member);
    await f.service.poll(member.agentId);
  }
  const board = f.delivered.filter(entry => entry.kind === 'board');
  assert.equal(board.length, 1);
  assert.match(board[0].message, /futureaide_board_post/);
  assert.doesNotMatch(board[0].message, /report_parent/);
});

test('H03 every descendant pointer protects the tree, including a closed foreign-owner grandchild', async t => {
  const f = await fixture(t);
  const parent = await f.run('parent');
  const child = await f.run('child', {}, f.caller(parent));
  const grandchild = await f.run('grandchild', { worktree: true }, f.caller(child, { ownerId: 'owner-foreign-row' }));
  const file = path.join(grandchild.workspace, 'user.txt');
  await writeFile(file, 'keep bytes');
  grandchild.closed = true;
  f.store.save(grandchild);
  assert.equal(f.store.claimAutoCleanup(parent), false);
  assert.equal((await f.service.delete({ name: parent.name }, f.boss())).error.code, 'worktree-retained');
  assert.equal((await f.service.manageTeam({ action: 'kick', target: parent.name }, f.boss())).ok, false);
  assert.equal(f.get('grandchild').parentAgentId, child.agentId);
  assert.equal(f.get('child').parentAgentId, parent.agentId);
  assert.equal(await readFile(file, 'utf8'), 'keep bytes');
  const orphan = f.store.get(parent.agentId);
  orphan.parentAgentId = 'absent-parent';
  f.store.save(orphan);
  assert.deepEqual((await f.service.manageTeam({ action: 'sweep' }, f.boss())).sweptNames, []);
  delete orphan.parentAgentId;
  f.store.save(orphan);
  const removed = await f.service.manageTeam({ action: 'kick', target: parent.name, keepChildren: false, discardWorktree: true }, f.boss());
  assert.equal(removed.ok, true);
  await assert.rejects(lstat(grandchild.worktreePath), { code: 'ENOENT' });
});

test('H04 GC keeps ignored, staged, untracked, committed, missing-base and failed trees', async t => {
  const f = await fixture(t, { autoCleanup: true });
  const cases = {
    ignored: async member => writeFile(path.join(member.workspace, 'user.ignored'), 'private'),
    untracked: async member => writeFile(path.join(member.workspace, 'user.txt'), 'private'),
    unstaged: async member => writeFile(path.join(member.workspace, 'index.txt'), 'changed'),
    staged: async member => {
      await writeFile(path.join(member.workspace, 'index.txt'), 'staged');
      await git(member.workspace, ['add', 'index.txt']);
    },
    committed: async member => {
      await writeFile(path.join(member.workspace, 'index.txt'), 'committed');
      await git(member.workspace, ['commit', '-qam', 'advance']);
    },
    missingBase: member => { delete member.worktreeBaseHead; f.store.save(member); },
    failed: member => { member.state = member.task.state = 'failed'; f.store.save(member); },
    cancelled: member => { member.state = member.task.state = 'cancelled'; f.store.save(member); },
    turnTimeout: member => { member.state = member.task.state = 'failed'; member.error = { code: 'turn-timeout' }; f.store.save(member); },
  };
  for (const [name, mutate] of Object.entries(cases)) await mutate(f.settle(await f.run(name, { worktree: true })));
  const clean = f.settle(await f.run('clean', { worktree: true }));
  assert.deepEqual(f.store.gcStaleAgents({ nowMs: Date.now() }), []);
  assert.equal((await inspectWorktree(f.get('ignored'))).state, 'retained');
  assert.equal((await inspectWorktree(f.get('missingBase'))).state, 'unknown');
  assert.deepEqual((await f.service.gc({ idleRetentionMs: 0 })).removed.map(member => member.name), ['clean']);
  await assert.rejects(lstat(clean.worktreePath), { code: 'ENOENT' });
  assert.equal((await git(f.repo, ['worktree', 'list', '--porcelain'])).stdout.includes(clean.worktreePath.replaceAll('\\', '/')), false);
  for (const name of Object.keys(cases)) assert.ok((await lstat(f.get(name).worktreePath)).isDirectory());
});

test('H07 actual role rows govern dispatch and slash aliases resolve before name allocation', async t => {
  const source = '| 角色 | 模型 | 怎么派 |\n|---|---|---|\n| 协调员 / 交付领队 | gpt-5.4 high | codex-cli persistent |\n'
    + '| 审核专员 | gpt-5.4 high | codex-cli |\n| 后端工程师 | gpt-5.4 high | codex-cli |\n'
    + '| 前端工程师 | gpt-5.4 high | codex-cli |\n| 调研专员 | gpt-5.4 high | codex-cli |\n';
  const f = await fixture(t, { teamConfig: source });
  const roleOptions = { teamConfigPath: f.team };
  const { roles } = loadTeamConfigDefaults(roleOptions);
  assert.equal(Object.keys(roles).length, 5);
  assert.deepEqual(roles.协调员.declaredNames, ['协调员', '交付领队']);
  for (const [role, tier] of [['协调员', 'lead'], ['审核专员', 'review'], ['调研专员', 'scout'], ['团队长', 'base']]) {
    assert.equal(classifyManagedRole(role, roleOptions), tier);
  }
  assert.equal((await f.service.create({ role: '协调员  /交付领队' }, f.boss())).name, '协调员1');
  assert.equal(f.get('协调员1').lifetime, 'persistent');
  await f.run('协调员1');
  for (const role of ['坏/角色', '交付员', '文档员', 'Boss', '\t协调员']) {
    await assert.rejects(f.service.create({ role }, f.boss()), { code: 'invalid-role' });
  }
  await writeFile(f.team, source.replace('persistent', 'once'));
  assert.equal((await f.service.create({ role: '协调员/交付领队' }, f.boss())).lifetime, 'once');
  await writeFile(f.team, '');
  assert.throws(() => loadTeamConfigDefaults({ teamConfigPath: f.team }), { code: 'invalid-team-config' });
  assert.equal(loadTeamConfigDefaults({ teamConfigPath: path.join(f.dir, 'missing.md') }).source, 'fallback');

  const cfg = path.join(f.dir, 'config.json');
  const profiles = path.join(f.dir, 'profiles');
  const profile = path.join(profiles, 'test.json');
  await mkdir(profiles);
  await writeFile(profile, JSON.stringify({ workspace: f.cwd }));
  assert.equal((await loadConfig(cfg, 'test')).teamConfigPath, f.team);
  await writeFile(profile, JSON.stringify({ workspace: f.cwd, teamConfigPath: 'roles.md' }));
  assert.equal((await loadConfig(cfg, 'test')).teamConfigPath, path.join(profiles, 'roles.md'));
  for (const teamConfigPath of ['', '  ', null, 17]) {
    await writeFile(profile, JSON.stringify({ workspace: f.cwd, teamConfigPath }));
    await assert.rejects(loadConfig(cfg, 'test'), /teamConfigPath must be a non-empty string path/);
  }
});

test('H08 managed callers are confined to their descendants and Git locks span processes', async t => {
  const f = await fixture(t);
  const a = await f.run('lead-a', { role: '团队长' });
  const b = await f.run('lead-b', { role: '团队长' });
  const x = await f.run('child-a', { worktree: true }, f.caller(a));
  const y = await f.run('child-b', { worktree: true }, f.caller(b));
  assert.deepEqual((await f.service.list(f.caller(a), { scope: 'all' })).items.map(item => item.name), [x.name]);
  for (const target of [y.name, y.agentId, 'lead-b/child-b']) {
    await assert.rejects(f.service.manageTeam({ action: 'merge', target }, f.caller(a)), { code: 'agent-not-found' });
  }
  for (const action of ['strays', 'sweep', 'adopt']) await assert.rejects(f.service.manageTeam({ action }, f.caller(a)), { code: 'permission-denied' });
  for (const state of ['creating', 'running', 'reconnecting', 'awaiting_input', 'awaiting_report', 'delivery_pending', 'cleaning']) {
    const seed = f.store.get(x.agentId);
    seed.state = state;
    f.store.save(seed);
    await assert.rejects(f.service.manageTeam({ action: 'merge', target: x.name }, f.caller(a)), { code: 'agent-running' });
  }
  const gate = deferred();
  const entered = deferred();
  const held = withWorktreeLock(f.repo, () => { entered.resolve(); return gate.promise; });
  await entered.promise;
  try {
    const guard = new URL('../src/worktree-guard.mjs', import.meta.url).href;
    const subprocess = spawn(process.execPath, ['--input-type=module', '-e',
      'import(process.env.F12_GUARD).then(async m => { try { await m.withWorktreeLock(process.env.F12_TREE, () => process.exit(2), { waitMs: 100 }); } catch (e) { process.exit(e.code === "worktree-busy" ? 0 : 3); } })'],
    { windowsHide: true, env: { ...process.env, F12_GUARD: guard, F12_TREE: y.worktreePath } });
    assert.deepEqual(await once(subprocess, 'exit'), [0, null]);
  } finally { gate.resolve(); await held; }
});

test('H09 merge records apply, verified removal and closure independently and resumes cleanup', async t => {
  const f = await fixture(t, { autoCleanup: true });
  const member = f.settle(await f.run('worker', { worktree: true, lifetime: 'once' }));
  await writeFile(path.join(member.workspace, 'index.txt'), 'new bytes\n');
  await writeFile(path.join(member.workspace, 'user.ignored'), 'retain');
  const action = () => f.service.manageTeam({ action: 'merge', target: member.name }, f.boss());
  const first = await action();
  assert.deepEqual([first.ok, first.applied, first.worktreeRemoved, first.recordClosed], [false, true, false, false], JSON.stringify(first));
  assert.equal(await readFile(path.join(f.cwd, 'index.txt'), 'utf8'), 'new bytes\n');
  assert.equal(f.get(member.name).worktreePath, member.worktreePath);
  assert.equal(compactTeamManage(first).worktreeRemoved, false);
  await rm(path.join(member.workspace, 'user.ignored'));
  f.controls.destroyFailure = true;
  const second = await action();
  assert.deepEqual([second.ok, second.applied, second.worktreeRemoved, second.recordClosed], [false, true, true, false], JSON.stringify(second));
  const phase = f.get(member.name).worktreeMerge;
  await writeFile(path.join(f.cwd, 'index.txt'), 'user edit after apply\n');
  f.controls.destroyFailure = false;
  const third = await action();
  assert.deepEqual([third.ok, third.applied, third.worktreeRemoved, third.recordClosed], [true, true, true, true], JSON.stringify(third));
  assert.equal(await readFile(path.join(f.cwd, 'index.txt'), 'utf8'), 'user edit after apply\n');
  assert.ok(phase.key);
  assert.equal(f.get(member.name), undefined);

  const interrupted = f.settle(await f.run('interrupted', { worktree: true }));
  await writeFile(path.join(interrupted.workspace, 'crash.txt'), 'applied before the interruption\n');
  const save = f.store.save.bind(f.store);
  let cut = true;
  f.store.save = (record, options) => {
    if (cut && record.agentId === interrupted.agentId && record.worktreeMerge?.stage === 'applied') {
      cut = false;
      throw Object.assign(new Error('Interrupted after apply'), { code: 'fixture-interruption' });
    }
    return save(record, options);
  };
  const merge = () => f.service.manageTeam({ action: 'merge', target: interrupted.name }, f.boss());
  const partial = await merge();
  assert.equal(partial.error.code, 'fixture-interruption');
  assert.equal(f.get(interrupted.name).worktreeMerge.stage, 'applying');
  assert.equal(await readFile(path.join(f.cwd, 'crash.txt'), 'utf8'), 'applied before the interruption\n');
  const recovered = await merge();
  assert.deepEqual([recovered.ok, recovered.applied, recovered.worktreeRemoved, recovered.recordCloseRequired], [true, true, true, false], JSON.stringify(recovered));
  assert.equal(f.get(interrupted.name).workspace, f.cwd);
});

test('H10 explicit commit and canonical monorepo cwd survive a moving caller HEAD', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, 'index.txt'), 'second revision\n');
  await git(f.repo, ['commit', '-qam', 'second']);
  const moved = (await git(f.repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const rootCaller = f.boss('f12-boss', process.platform === 'win32' ? f.cwd.toUpperCase() : f.cwd);
  const member = await f.run('worker', { worktree: true, baseSha: f.base }, rootCaller);
  assert.equal(member.worktreeBaseHead, f.base);
  assert.equal((await git(member.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim(), f.base);
  assert.equal(path.relative(member.worktreePath, member.workspace), path.join('packages', 'Example'));
  assert.equal(f.delivered.at(-1).cwd, member.workspace);
  assert.equal(await readFile(path.join(member.workspace, 'index.txt'), 'utf8'), 'initial\n');
  await assert.rejects(f.service.run({ name: member.name, message: 'replacement', worktree: true, baseSha: moved }, rootCaller), { code: 'worktree-base-conflict' });
  await assert.rejects(f.service.create({ name: 'invalid', baseSha: f.base }, rootCaller), { code: 'invalid-base-sha' });
  await assert.rejects(f.service.create({ name: 'missing', lifetime: 'once', worktree: true, baseSha: '0'.repeat(40) }, rootCaller), { code: 'invalid-base-sha' });
  assert.equal(f.get('missing'), undefined);
  const batch = await f.service.run({ worktree: true, baseSha: f.base, tasks: [
    { name: 'batch-default', message: 'use parent base', target: 'codex-cli' },
    { name: 'batch-override', message: 'use item base', target: 'codex-cli', baseSha: moved },
  ] }, rootCaller);
  assert.equal(batch.items.every(item => item.created), true);
  assert.equal(f.get('batch-default').worktreeBaseHead, f.base);
  assert.equal(f.get('batch-override').worktreeBaseHead, moved);
});

test('H11 urgent dispatch fences the old request, preserves questions and preflights every mention', async t => {
  const f = await fixture(t);
  const lead = await f.run('lead', { role: '团队长' });
  const sibling = await f.run('sibling', { role: '团队长' });
  const foreign = await f.run('foreign', {}, f.caller(sibling));
  for (const [index, target] of targets.entries()) {
    const name = 'worker-' + index;
    const old = await f.run(name, { target, worktree: true }, f.caller(lead, { readOnlyScout: true }));
    assert.equal(f.delivered.at(-1).readOnly, true);
    f.submit(old, 'ask', 'Question one');
    f.submit(old, 'ask', 'Question two');
    await f.service.poll(old.agentId);
    await f.service.send({ name, message: 'ordinary queue', mode: 'queue' }, f.boss());
    const count = (await f.service.readBoard({}, f.boss())).messages.length;
    const stopped = f.stopped.length;
    await assert.rejects(f.service.postBoard({ message: '@' + name + ' @' + foreign.name, urgent: true }, f.caller(lead)), { code: 'permission-denied' });
    await assert.rejects(f.service.postBoard({ message: '@lead', urgent: true }, f.caller(old)), { code: 'permission-denied' });
    assert.equal((await f.service.readBoard({}, f.boss())).messages.length, count);
    assert.equal(f.stopped.length, stopped);
    const gate = deferred();
    const ready = deferred();
    f.controls.sessionResumable = index % 2 === 0;
    f.controls.onPreempt = async () => { ready.resolve(); await gate.promise; };
    const posting = f.service.postBoard({ message: '@' + name + ' urgent now', urgent: true }, f.boss());
    await ready.promise;
    try {
      const migrating = f.store.get(old.agentId);
      assert.equal(migrating.task.preemption.oldRequestId, old.task.dispatches.at(-1).requestId);
      assert.throws(() => f.submit(old, 'report', 'late R0', true), { code: 'submission-not-owned' });
      old.state = old.task.state = 'failed';
      assert.equal(f.store.save(old), false);
      assert.equal(f.delivered.at(-1).requestId, old.task.dispatches.at(-1).requestId);
    } finally { gate.resolve(); }
    const receipt = await posting;
    f.controls.onPreempt = undefined;
    assert.equal(receipt.routed[0].action, 'preempted', JSON.stringify(receipt.routed));
    assert.deepEqual(compactBoardPost(receipt).preempted, ['lead/' + name]);
    const current = f.get(name);
    assert.equal(current.task.taskId, old.task.taskId);
    assert.equal(current.worktreePath, old.worktreePath);
    assert.equal(f.store.openQuestions(current).unanswered, 2);
    assert.equal(f.delivered.at(-1).message.includes('Original work for '), index % 2 === 1);
    assert.throws(() => f.submit(current, 'report', 'questions still pending', true), { code: 'question-unanswered' });
    f.end(current);
    await f.service.poll(current.agentId);
    const second = await f.service.postBoard({ message: '@' + name + ' second urgent', urgent: true }, f.caller(lead));
    assert.equal(second.routed[0].action, 'woken-urgent');
    assert.equal(f.stopped.length, stopped + 1);
    assert.equal(f.store.openQuestions(f.get(name)).unanswered, 2);
  }
  const desktop = await f.run('desktop', { target: 'codex-desktop' });
  const turnId = f.delivered.at(-1).turnId;
  const desktopStopCount = f.stopped.length;
  const steered = await f.service.postBoard({ message: '@desktop steer prompt', urgent: true }, f.boss());
  assert.equal(steered.routed[0].action, 'woken-urgent', JSON.stringify({ route: steered.routed[0], error: f.get(desktop.name).error }));
  assert.equal(f.stopped.length, desktopStopCount);
  assert.equal(f.delivered.at(-1).turnId, turnId);
  assert.equal(f.delivered.at(-1).mode, 'steer');

  const failure = await f.run('stop-failure');
  f.controls.stopFailure = true;
  const failed = await f.service.postBoard({ message: '@stop-failure retry later', urgent: true }, f.boss());
  assert.equal(failed.routed[0].error.code, 'preemption-unconfirmed');
  assert.equal(f.get('stop-failure').task.dispatches.at(-1).requestId, failure.task.dispatches.at(-1).requestId);
  assert.equal(f.get('stop-failure').task.preemption, undefined);

  f.controls.stopFailure = false;
  const interrupted = await f.run('recovery');
  f.controls.onPreempt = async () => { throw new Error('Monitor interrupted'); };
  const recovery = await f.service.postBoard({ message: '@recovery durable urgent', urgent: true }, f.boss());
  assert.equal(recovery.routed[0].action, 'deferred');
  const migrating = f.get(interrupted.name);
  migrating.task.preemption.retryAt = 0;
  f.store.save(migrating);
  f.controls.onPreempt = undefined;
  await f.service.poll(interrupted.agentId);
  await f.service.poll(interrupted.agentId);
  assert.equal(f.delivered.filter(item => item.message.includes('durable urgent')).length, 1);

  const sealed = await f.run('sealed');
  f.submit(sealed, 'report', 'Final already accepted', true);
  const cancelled = await f.run('cancelled');
  assert.equal(f.store.requestCancel(cancelled), true);
  const stopCount = f.stopped.length;
  const protectedPost = await f.service.postBoard({ message: '@sealed @cancelled avoid stopping either', urgent: true }, f.boss());
  assert.ok(protectedPost.routed.every(item => item.action === 'deferred'));
  assert.equal(f.stopped.length, stopCount);
});
