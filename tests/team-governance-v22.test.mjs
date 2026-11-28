import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { BACKEND_METHODS } from '../src/agent-backend.mjs';
import { TRUSTED_CALLER, ownerIdForSource } from '../src/calling-context.mjs';
import { createScopedAgents } from '../src/scoped-agents.mjs';

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const cliScript = path.join(pluginRoot, 'src', 'cli.mjs');
const tmpBase = path.join(repoRoot, '.work', 'tmp', 'team-governance-v22');

async function makeTempDir(t, prefix = 'v22-') {
  await mkdir(tmpBase, { recursive: true });
  const dir = await mkdtemp(path.join(tmpBase, prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

function agyExtra(conversationId, workspace) {
  return {
    [TRUSTED_CALLER]: {
      source: 'antigravity',
      conversationId,
      workspace,
    },
  };
}

function leadExtra(parentAgentId, workspace, { isolatedOwner = false } = {}) {
  return {
    [TRUSTED_CALLER]: {
      source: 'managed-cli',
      parentAgentId,
      ...(isolatedOwner ? { ownerId: ownerIdForSource('managed-cli', parentAgentId) } : {}),
      workspace,
    },
  };
}

function createGovernanceMockAdapters({ getActiveProfile = () => 'prof-acc-A' } = {}) {
  const dispatches = [];
  const liveStates = new Map();
  const changedFilesByAgent = new Map();

  function makeAdapter(targetName, provider, models) {
    return (record, deps) => {
      const load = deps.load ?? (() => record);
      const readState = () => ({ seq: 0, requests: {}, answers: {}, answered: [], ...(deps.readNativeState?.() ?? {}) });
      const saveState = val => deps.writeNativeState(val);

      async function submissions(val) {
        const taskId = load().task?.taskId;
        const { questions = [], reports = [] } = await deps.readParentSubmissions();
        return {
          questions: questions
            .filter(q => q.taskId === taskId)
            .map(q => (val.answered.includes(q.id) ? { ...q, state: 'answered' } : q)),
          reports: reports.filter(r => r.taskId === taskId),
        };
      }

      return {
        target: targetName,
        labels: { host: targetName, bridge: `Mock ${targetName}` },
        requiredMethods: BACKEND_METHODS,
        async probe() {
          const profileId = getActiveProfile(targetName, load());
          return {
            identity: {
              application: targetName,
              ...(profileId ? { profileId } : {}),
            },
            methods: BACKEND_METHODS,
            treeProtocol: 1,
            reportProtocol: 1,
          };
        },
        async create() {
          const cur = load();
          const val = readState();
          const profileId = getActiveProfile(targetName, cur);
          if (targetName === 'codex-cli' && !val.threadId) {
            val.threadId = `thread-${cur.name}-${Math.random().toString(36).slice(2, 8)}`;
          }
          if (targetName === 'claude-cli' && !val.sessionId) {
            val.sessionId = `claude-${cur.name}-${Math.random().toString(36).slice(2, 8)}`;
          }
          if (profileId) val.profileId = profileId;
          saveState(val);
          return { sessionId: cur.sessionId, modelRequestsStarted: 0 };
        },
        async beginTask() {
          const val = readState();
          const taskId = load().task?.taskId;
          if (val.taskId !== taskId) {
            val.taskId = taskId;
            val.answered = [];
            val.answers = {};
            saveState(val);
          }
          return { treeProtocol: 1, reportProtocol: 1, throughSeq: val.seq };
        },
        async observe() {
          const cur = load();
          const val = readState();
          const info = liveStates.get(cur.agentId) ?? { running: false, stalled: false, activity: 'idle' };
          const running = info.running === true;
          const activity = running ? (info.activity ?? '2s前 · 运行中') : 'idle';
          const changes = changedFilesByAgent.get(cur.agentId) ?? [];
          return {
            sessionId: cur.sessionId,
            taskId: cur.task?.taskId,
            running,
            stalled: Boolean(running && info.stalled),
            activity,
            throughSeq: val.seq,
            currentModel: val.currentModel ?? null,
            modelSelectionObserved: false,
            changes,
            coverage: { source: targetName, complete: false, note: 'mock' },
            ...(await submissions(val)),
            tree: {
              settled: !running,
              running,
              nodes: [{
                sessionId: cur.sessionId,
                parentSessionId: null,
                name: cur.name,
                status: running ? 'running' : 'idle',
                activity,
                changes,
                coverage: 'mock',
              }],
            },
          };
        },
        async history() {
          const cur = load();
          return {
            messages: [{ role: 'assistant', text: `History of ${cur.name}` }],
            hasMore: false,
          };
        },
        async answer({ answerId, message }) {
          const val = readState();
          const pending = (await submissions(val)).questions.filter(q => q.state === 'pending');
          if (!pending.length) {
            throw Object.assign(new Error('No pending question'), { code: 'question-not-pending' });
          }
          const ids = pending.map(q => q.id);
          val.answered.push(...ids);
          const res = { consumedQuestionIds: ids, continuation: `Parent answer:\n${message}` };
          val.answers[answerId] = res;
          saveState(val);
          return res;
        },
        async deliver({ requestId, message, model }) {
          const cur = load();
          const val = readState();
          const activeProfile = getActiveProfile(targetName, cur);
          if (val.profileId && activeProfile && val.profileId !== activeProfile) {
            throw Object.assign(new Error('Session belongs to previous account profile'), {
              code: targetName === 'claude-cli' ? 'claude-session-not-found' : 'codex-thread-not-found',
              terminal: true,
            });
          }
          val.started = true;
          val.active = requestId;
          if (activeProfile) val.profileId = activeProfile;
          val.currentModel = model
            ? { provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) }
            : null;
          val.requests[requestId] = { status: 'accepted', taskId: cur.task?.taskId, afterSeq: val.seq, model };
          saveState(val);
          liveStates.set(cur.agentId, { running: true, requestId, taskId: cur.task?.taskId });
          dispatches.push({
            agentId: cur.agentId,
            name: cur.name,
            target: targetName,
            requestId,
            taskId: cur.task?.taskId,
            message,
            threadId: val.threadId ?? val.sessionId ?? null,
            profileId: val.profileId ?? null,
          });
          return {
            accepted: true,
            status: 'accepted',
            afterSeq: val.seq,
            ...(model?.model ? { actualModel: model.model } : {}),
            ...(model?.reasoningEffort ? { actualEffort: model.reasoningEffort, actualEffortSource: 'host-readback' } : {}),
          };
        },
        async receipt({ requestId }) {
          const val = readState();
          const req = val.requests[requestId];
          return req ? {
            status: req.status,
            afterSeq: req.afterSeq,
            ...(req.model?.model ? { actualModel: req.model.model } : {}),
            ...(req.model?.reasoningEffort ? { actualEffort: req.model.reasoningEffort, actualEffortSource: 'host-readback' } : {}),
            result: { accepted: true, requestId },
          } : undefined;
        },
        async turn() {
          const cur = load();
          const info = liveStates.get(cur.agentId);
          if (info?.running) return { state: 'running', correlation: 'request-id' };
          if (info?.failed) {
            return {
              state: 'ended',
              correlation: 'request-id',
              completionReason: { kind: 'failed', message: info.errorMessage ?? 'CLI process interrupted' },
              failure: { code: info.errorCode ?? 'cli-process-crashed', message: info.errorMessage ?? 'CLI process interrupted' },
              endSeq: 1,
            };
          }
          return { state: 'ended', correlation: 'request-id', completionReason: { kind: 'completed' }, endSeq: 1 };
        },
        async models() {
          return {
            default: { provider, model: models[0].id, reasoningEffort: models[0].defaultEffort },
            routableProviders: [provider],
            groups: [{ id: provider, provider, models }],
          };
        },
        async model() { return readState().currentModel ?? null; },
        async selectModel() { throw Object.assign(new Error('unsupported'), { code: 'model-selection-unsupported' }); },
        async cancel() {
          liveStates.set(load().agentId, { running: false });
          return { cancelRequested: true };
        },
        async destroy() {
          liveStates.set(load().agentId, { running: false });
          return { destroyed: true, nativeSessionRetained: true };
        },
        async cursor() { return { throughSeq: readState().seq }; },
      };
    };
  }

  const codexModels = [
    { id: 'gpt-6.1-terra', name: 'GPT-6.1-Terra', defaultEffort: 'high', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-6.2-sol', name: 'GPT-6.2-Sol', defaultEffort: 'high', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ];
  const claudeModels = [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', defaultEffort: 'max', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ];

  return {
    adapters: {
      'codex-cli': makeAdapter('codex-cli', 'openai', codexModels),
      'claude-cli': makeAdapter('claude-cli', 'claude-cli', claudeModels),
    },
    dispatches,
    liveStates,
    changedFilesByAgent,
  };
}

function makeScopedForTest(stateDir, workspace, mock, extraConfig = {}) {
  return createScopedAgents(
    {
      workspace,
      stateDirectory: stateDir,
      disabledTargets: ['dsh'],
      idleSessionCleanup: false,
      ...extraConfig,
    },
    {
      backendAdapters: mock.adapters,
      ensureSharedMonitor: async () => true,
      monitorAlive: async () => true,
      captureFiles: async () => ({ available: false, reason: 'disabled-in-unit-test' }),
    },
  );
}

test('1. cross-session whole-team adopt + veteran stub revival + strays & sweep', async t => {
  const dir = await makeTempDir(t, 'adopt-stub-');
  const ws = path.join(dir, 'workspace');
  await mkdir(ws, { recursive: true });
  const mock = createGovernanceMockAdapters();
  const scoped = makeScopedForTest(path.join(dir, 'state'), ws, mock);
  t.after(async () => {
    await scoped.drainPolls();
    scoped.close();
  });

  const oldBoss = agyExtra('conv-old-session', ws);
  const newBoss = agyExtra('conv-new-session', ws);

  // Old Boss creates 团队长1 (persistent) and child 后端1 (paused on ask_parent), plus a finished 前端1 stub
  const tlRun = await scoped.run({ role: '团队长', lifetime: 'persistent', message: '拆解后端模块' }, oldBoss);
  await scoped.poll(scoped.store.named(ownerIdForSource('antigravity', 'conv-old-session'), tlRun.name).agentId);
  const tlRec = scoped.store.named(ownerIdForSource('antigravity', 'conv-old-session'), '团队长1');
  mock.liveStates.set(tlRec.agentId, { running: false });
  scoped.store.submitParentMessage(tlRec.agentId, { kind: 'report', message: '已完成拆解并派出后端1', final: false });
  await scoped.poll(tlRec.agentId);

  const beRun = await scoped.run({ role: '后端', message: '实现订单仓储层' }, leadExtra(tlRec.agentId, ws));
  const beRec = scoped.store.list().find(r => r.name === beRun.name);
  await scoped.poll(beRec.agentId);
  mock.liveStates.set(beRec.agentId, { running: false });
  scoped.store.submitParentMessage(beRec.agentId, { kind: 'ask', message: '订单号前缀用 ORD 还是 PAY？', final: false });
  await scoped.poll(beRec.agentId);

  // Post a message on the old session's team board
  await scoped.postBoard({ message: '老会话黑板纪要：接口冻结在 v2' }, oldBoss);

  // Save a finished veteran stub (前端1) under old Boss with a resumable sessionId
  const oldOwnerId = ownerIdForSource('antigravity', 'conv-old-session');
  scoped.store.saveAgentStub({
    agentId: 'agent-fe-veteran-1',
    rootOwnerId: oldOwnerId,
    ownerId: oldOwnerId,
    name: '前端1',
    role: '前端',
    agentPath: '前端1',
    target: 'claude-cli',
    workspace: ws,
    resumeSessionId: 'claude-sess-veteran-99',
    model: 'claude-opus-5-5',
    lastTaskSummary: '已完成登录页 UI',
  });

  // Backdate old session timestamps by 40 minutes so strays scanner marks them as stale-session strays
  const staleIso = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const oldOwnerDoc = scoped.store.owner(oldOwnerId);
  scoped.store.db.prepare('UPDATE owners SET body=? WHERE id=?').run(
    JSON.stringify({ ...oldOwnerDoc, createdAt: staleIso }),
    oldOwnerId,
  );
  for (const id of [tlRec.agentId, beRec.agentId]) {
    const r = scoped.store.get(id);
    scoped.store.db.prepare('UPDATE agents SET body=? WHERE id=?').run(
      JSON.stringify({ ...r, createdAt: staleIso, updatedAt: staleIso }),
      id,
    );
    scoped.store.touched(id);
  }

  const strayCheck = await scoped.manageTeam({ action: 'strays' }, newBoss);
  assert.equal(strayCheck.ok, true);
  assert.equal(strayCheck.total, 2);
  assert.deepEqual(strayCheck.strays.map(s => s.name).sort(), ['后端1', '团队长1'].sort());
  assert.equal(strayCheck.strays.every(s => s.strayReason === 'stale-session'), true);

  // New Boss runs whole-project adopt -> transfers team, task_keys, board messages, and stubs!
  const adopted = await scoped.manageTeam({ action: 'adopt', target: 'auto' }, newBoss);
  assert.equal(adopted.ok, true);
  assert.equal(adopted.mode, 'project');
  assert.equal(adopted.adoptedCount, 2);
  assert.equal(adopted.boardMessagesTransferred, 1);
  assert.equal(adopted.stubsTransferred, 1);

  // Verify new Boss sees the transferred board, team hierarchy, and can wait on old taskKey
  const boardAfter = await scoped.readBoard({}, newBoss);
  assert.equal(boardAfter.messages.length, 1);
  assert.match(boardAfter.messages[0].text, /老会话黑板纪要/);

  const waitQuestion = await scoped.wait({ taskKeys: [beRun.taskKey], timeoutSeconds: 1 }, newBoss);
  assert.equal(waitQuestion.events.some(e => e.type === 'question' && e.message.includes('ORD 还是 PAY')), true);

  // Revive finished veteran stub 前端1 with a continuation task -> preserves claude-sess-veteran-99!
  const revived = await scoped.manageTeam({
    action: 'adopt',
    target: '前端1',
    message: '把按钮圆角统一改成 8px',
  }, newBoss);
  assert.equal(revived.ok, true);
  assert.equal(revived.mode, 'revived-stub');
  assert.equal(revived.revived, true);
  assert.equal(revived.resumedSession, true);
  assert.ok(revived.taskKey);

  const revivedRec = scoped.store.named(ownerIdForSource('antigravity', 'conv-new-session'), '前端1');
  await scoped.poll(revivedRec.agentId);
  const feNative = scoped.store.backendState(revivedRec.agentId);
  assert.equal(feNative.sessionId, 'claude-sess-veteran-99');
  assert.equal(mock.dispatches.at(-1).message, '把按钮圆角统一改成 8px');

  // Create an orphan broken-parent stray and verify sweep cleans it without touching active team
  scoped.store.insert({
    agentId: 'agent-broken-stray',
    ownerId: oldOwnerId,
    sessionId: 'sess-broken',
    name: '孤儿调查员1',
    role: '调查员',
    lifetime: 'once',
    target: 'codex-cli',
    workspace: ws,
    parentAgentId: 'agent-deleted-ghost-parent',
    state: 'failed',
    createdAt: staleIso,
    updatedAt: staleIso,
    history: [],
  });
  const brokenStrays = await scoped.manageTeam({ action: 'strays' }, newBoss);
  assert.equal(brokenStrays.strays.some(s => s.name === '孤儿调查员1' && s.strayReason === 'broken-parent'), true);

  const swept = await scoped.manageTeam({ action: 'sweep' }, newBoss);
  assert.equal(swept.ok, true);
  assert.deepEqual(swept.sweptNames, ['孤儿调查员1']);
  assert.equal(scoped.store.get('agent-broken-stray'), undefined);
  assert.ok(scoped.store.get(beRec.agentId), 'Adopted active team member must survive sweep');
});

test('2. kick(keepChildren:true 撤将留兵 vs keepChildren:false 斩立决) and reparent with cycle guard', async t => {
  const dir = await makeTempDir(t, 'kick-reparent-');
  const ws = path.join(dir, 'workspace');
  await mkdir(ws, { recursive: true });
  const mock = createGovernanceMockAdapters();
  const scoped = makeScopedForTest(path.join(dir, 'state'), ws, mock);
  t.after(async () => {
    await scoped.drainPolls();
    scoped.close();
  });

  const boss = agyExtra('conv-kick-boss', ws);
  const bossOwnerId = ownerIdForSource('antigravity', 'conv-kick-boss');

  await scoped.run({ name: '团队长1', role: '团队长', message: '带一队' }, boss);
  await scoped.run({ name: '团队长2', role: '团队长', message: '带二队' }, boss);
  const tl1 = scoped.store.named(bossOwnerId, '团队长1');
  const tl2 = scoped.store.named(bossOwnerId, '团队长2');
  await scoped.poll(tl1.agentId);
  await scoped.poll(tl2.agentId);

  await scoped.run({ name: '后端1', role: '后端', message: '做接口 A' }, leadExtra(tl1.agentId, ws));
  await scoped.run({ name: '后端2', role: '后端', message: '做接口 B' }, leadExtra(tl1.agentId, ws));
  const be1 = scoped.store.named(bossOwnerId, '后端1');
  const be2 = scoped.store.named(bossOwnerId, '后端2');
  await scoped.poll(be1.agentId);
  await scoped.poll(be2.agentId);

  // Default kick (keepChildren: true) promotes 后端1 & 后端2 to Boss direct and only purges 团队长1
  const kickedKeep = await scoped.manageTeam({ action: 'kick', target: '团队长1', keepChildren: true }, boss);
  assert.equal(kickedKeep.ok, true);
  assert.equal(kickedKeep.keepChildren, true);
  assert.deepEqual(kickedKeep.removedNames, ['团队长1']);
  assert.deepEqual(kickedKeep.promotedChildren.sort(), ['后端1', '后端2'].sort());
  assert.equal(scoped.store.get(tl1.agentId), undefined);

  const be1After = scoped.store.get(be1.agentId);
  const be2After = scoped.store.get(be2.agentId);
  assert.equal(be1After.parentAgentId ?? null, null);
  assert.equal(be2After.parentAgentId ?? null, null);
  assert.equal(be1After.state, 'running');
  assert.equal(be2After.state, 'running');

  // Reparent 后端2 under 团队长2
  const reparented = await scoped.manageTeam({ action: 'reparent', target: '后端2', parent: '团队长2' }, boss);
  assert.equal(reparented.ok, true);
  assert.equal(reparented.parentName, '团队长2');
  assert.equal(reparented.agentPath, '团队长2/后端2');

  // Cycle check: cannot reparent 团队长2 under its own child 团队长2/后端2 or under itself
  await assert.rejects(
    () => scoped.manageTeam({ action: 'reparent', target: '团队长2', parent: '团队长2/后端2' }, boss),
    err => err?.code === 'reparent-cycle',
  );
  await assert.rejects(
    () => scoped.manageTeam({ action: 'reparent', target: '团队长2', parent: '团队长2' }, boss),
    err => err?.code === 'reparent-cycle',
  );

  // kick with keepChildren: false (斩立决) purges 团队长2 AND its descendant 后端2, leaving 后端1 untouched
  const kickedTree = await scoped.manageTeam({ action: 'kick', target: '团队长2', keepChildren: false }, boss);
  assert.equal(kickedTree.ok, true);
  assert.equal(kickedTree.keepChildren, false);
  assert.deepEqual(kickedTree.removedNames.sort(), ['后端2', '团队长2'].sort());
  assert.equal(scoped.store.get(tl2.agentId), undefined);
  assert.equal(scoped.store.get(be2.agentId), undefined);
  assert.equal(scoped.store.get(be1.agentId)?.state, 'running');
});

test('3. cross-level grandchild path addressing ("团队长1/后端1") across answer/send/inspect/changes/cancel with disambiguation', async t => {
  const dir = await makeTempDir(t, 'grandchild-ctrl-');
  const ws = path.join(dir, 'workspace');
  await mkdir(ws, { recursive: true });
  const mock = createGovernanceMockAdapters();
  const scoped = makeScopedForTest(path.join(dir, 'state'), ws, mock);
  t.after(async () => {
    await scoped.drainPolls();
    scoped.close();
  });

  const boss = agyExtra('conv-grand-boss', ws);
  const bossOwnerId = ownerIdForSource('antigravity', 'conv-grand-boss');

  await scoped.run({ name: '团队长1', role: '团队长', message: '一队推进' }, boss);
  await scoped.run({ name: '团队长2', role: '团队长', message: '二队推进' }, boss);
  const tl1 = scoped.store.named(bossOwnerId, '团队长1');
  const tl2 = scoped.store.named(bossOwnerId, '团队长2');
  await scoped.poll(tl1.agentId);
  await scoped.poll(tl2.agentId);

  // Isolated team lead owners allow both 团队长1 and 团队长2 to each own a child named 后端1!
  const tl1ChildExtra = leadExtra(tl1.agentId, ws, { isolatedOwner: true });
  const tl2ChildExtra = leadExtra(tl2.agentId, ws, { isolatedOwner: true });

  await scoped.run({ name: '后端1', role: '后端', message: '一队缓存实现' }, tl1ChildExtra);
  await scoped.run({ name: '后端特遣', role: '后端', message: '一队专项压测' }, tl1ChildExtra);
  await scoped.run({ name: '后端1', role: '后端', message: '二队网关实现' }, tl2ChildExtra);

  const tl1Be1 = scoped.store.childrenOf(tl1.agentId).find(c => c.name === '后端1');
  const tl1Unique = scoped.store.childrenOf(tl1.agentId).find(c => c.name === '后端特遣');
  const tl2Be1 = scoped.store.childrenOf(tl2.agentId).find(c => c.name === '后端1');
  await scoped.poll(tl1Be1.agentId);
  await scoped.poll(tl1Unique.agentId);
  await scoped.poll(tl2Be1.agentId);

  // 团队长1/后端1 asks a question and records a changed file
  mock.changedFilesByAgent.set(tl1Be1.agentId, [{ path: 'src/cache.mjs', operation: 'modified' }]);
  mock.liveStates.set(tl1Be1.agentId, { running: false });
  scoped.store.submitParentMessage(tl1Be1.agentId, { kind: 'ask', message: 'Redis 缓存 TTL 用 60s 还是 300s？', final: false });
  await scoped.poll(tl1Be1.agentId);

  // Ambiguous short name "后端1" from Boss must throw node-ambiguous suggesting team paths
  await assert.rejects(
    () => scoped.answer({ name: '后端1', message: '300s' }, boss),
    err => err?.code === 'node-ambiguous'
      && Array.isArray(err.paths)
      && err.paths.includes('团队长1/后端1')
      && err.paths.includes('团队长2/后端1'),
  );

  // Cross-level inspect & changes via "团队长1/后端1"
  const inspected = await scoped.inspect({ name: '团队长1/后端1' }, boss);
  assert.equal(inspected.name, '后端1');
  const changed = await scoped.changes({ name: '团队长1/后端1' }, boss);
  assert.equal(changed.changes.some(f => f.path === 'src/cache.mjs'), true);

  // Cross-level answer via "团队长1/后端1" directly from Boss!
  const ans = await scoped.answer({ name: '团队长1/后端1', message: '统一设为 300s' }, boss);
  assert.equal(ans.answered, true);
  await scoped.poll(tl1Be1.agentId);
  assert.match(mock.dispatches.at(-1).message, /统一设为 300s/);

  // Unique grandchild short-name "后端特遣" works directly from Boss without path prefix!
  const sentUnique = await scoped.send({ name: '后端特遣', message: '顺带压测并发 500 QPS' }, boss);
  assert.ok(sentUnique.taskKey);

  // Cross-level cancel on "团队长2/后端1" stops only 二队's 后端1
  const cancelled = await scoped.cancel({ name: '团队长2/后端1' }, boss);
  assert.equal(cancelled.state, 'cancelling');
  mock.liveStates.set(tl2Be1.agentId, { running: false });
  await scoped.poll(tl2Be1.agentId);
  assert.equal(scoped.store.get(tl2Be1.agentId).state, 'cancelled');
  assert.equal(scoped.store.get(tl1Be1.agentId).state, 'running');
});

test('4. resume supports native-resume and FAswitch account-switch automatic handoff-new-account without error', async t => {
  const dir = await makeTempDir(t, 'resume-faswitch-');
  const ws = path.join(dir, 'workspace');
  const faswitchHome = path.join(dir, 'FAswitch');
  await mkdir(path.join(faswitchHome, 'state'), { recursive: true });
  await mkdir(ws, { recursive: true });

  let activeProfile = 'prof-acc-A';
  await writeFile(path.join(faswitchHome, 'state', 'current-profile.json'), JSON.stringify({
    active: { profile_id: activeProfile, name: '账号A' },
  }), 'utf8');

  const mock = createGovernanceMockAdapters({ getActiveProfile: () => activeProfile });
  const scoped = makeScopedForTest(path.join(dir, 'state'), ws, mock, { faswitchHome });
  t.after(async () => {
    await scoped.drainPolls();
    scoped.close();
  });

  const boss = agyExtra('conv-resume-boss', ws);
  const bossOwnerId = ownerIdForSource('antigravity', 'conv-resume-boss');

  // Case A: Same account native-resume on a failed once agent
  await scoped.run({ name: '后端1', role: '后端', message: '实现结算流水与幂等锁' }, boss);
  const be1 = scoped.store.named(bossOwnerId, '后端1');
  await scoped.poll(be1.agentId);
  const origThreadId = scoped.store.backendState(be1.agentId).threadId;
  assert.ok(origThreadId);

  // Simulate mid-task progress + crash on same account
  scoped.store.submitParentMessage(be1.agentId, { kind: 'report', message: '已完成建表', final: false });
  mock.changedFilesByAgent.set(be1.agentId, [{ path: 'src/settlement.mjs', operation: 'modified' }]);
  mock.liveStates.set(be1.agentId, { running: false, failed: true, errorCode: 'cli-process-crashed', errorMessage: 'Network reset' });
  await scoped.poll(be1.agentId);
  assert.equal(scoped.store.get(be1.agentId).state, 'failed');

  mock.liveStates.set(be1.agentId, { running: false });
  const nativeResumed = await scoped.manageTeam({ action: 'resume', target: '后端1' }, boss);
  assert.equal(nativeResumed.ok, true);
  assert.equal(nativeResumed.mode, 'native-resume');
  assert.ok(nativeResumed.taskKey);
  assert.match(nativeResumed.wakeCmd, /futureaide-wait --conv "conv-resume-boss"/);
  await scoped.poll(be1.agentId);
  assert.equal(mock.dispatches.at(-1).threadId, origThreadId, 'native-resume must reuse original threadId');

  // Case B: FAswitch switches to a brand-new account (prof-acc-B) -> automatic handoff-new-account!
  scoped.store.submitParentMessage(be1.agentId, { kind: 'ask', message: '锁超时定 15s 可以吗？', final: false });
  mock.liveStates.set(be1.agentId, { running: false });
  await scoped.poll(be1.agentId);
  await scoped.answer({ name: '后端1', message: '可以，用 15s' }, boss);
  await scoped.poll(be1.agentId);
  scoped.store.submitParentMessage(be1.agentId, { kind: 'report', message: '幂等锁核心代码已落盘', final: false });
  mock.liveStates.set(be1.agentId, { running: false, failed: true, errorCode: 'quota-exhausted', errorMessage: '429 quota exceeded' });
  await scoped.poll(be1.agentId);

  // Switch FAswitch active profile to prof-acc-B!
  activeProfile = 'prof-acc-B';
  await writeFile(path.join(faswitchHome, 'state', 'current-profile.json'), JSON.stringify({
    active: { profile_id: activeProfile, name: '账号B' },
  }), 'utf8');

  const handoffResumed = await scoped.manageTeam({
    action: 'resume',
    target: '后端1',
    message: '在新账号下补完单测并提交最终汇报',
  }, boss);
  assert.equal(handoffResumed.ok, true);
  assert.equal(handoffResumed.mode, 'handoff-new-account');
  assert.equal(handoffResumed.name, '后端1');
  assert.ok(handoffResumed.taskKey);

  await scoped.poll(be1.agentId);
  const handoffDispatch = mock.dispatches.at(-1);
  assert.notEqual(handoffDispatch.threadId, origThreadId, 'handoff-new-account must start a fresh native thread on new account');
  assert.equal(handoffDispatch.profileId, 'prof-acc-B');
  assert.match(handoffDispatch.message, /\[跨账号无缝交接续跑\]/);
  assert.match(handoffDispatch.message, /src\/settlement\.mjs/);
  assert.match(handoffDispatch.message, /可以，用 15s/);
  assert.match(handoffDispatch.message, /幂等锁核心代码已落盘/);
  assert.match(handoffDispatch.message, /在新账号下补完单测并提交最终汇报/);
  assert.equal(scoped.store.get(be1.agentId).host?.profileId, 'prof-acc-B');
});

test('5. cli.mjs team and board subcommands work out-of-the-box for Canvas UI without --conv/--owner', async t => {
  const dir = await makeTempDir(t, 'cli-team-board-');
  const ws = path.join(dir, 'workspace');
  const emptyWs = path.join(dir, 'empty-workspace');
  const stateDir = path.join(dir, 'state');
  const cfgPath = path.join(dir, 'config.json');
  await mkdir(ws, { recursive: true });
  await mkdir(emptyWs, { recursive: true });

  await writeFile(cfgPath, JSON.stringify({
    workspace: ws,
    stateDirectory: stateDir,
    disabledTargets: ['dsh'],
    idleSessionCleanup: false,
  }), 'utf8');

  // Seed a live team in the roster under Boss conversation "conv-canvas-seed"
  const mock = createGovernanceMockAdapters();
  const scoped = makeScopedForTest(stateDir, ws, mock, { configFile: cfgPath });
  const boss = agyExtra('conv-canvas-seed', ws);
  const bossOwnerId = ownerIdForSource('antigravity', 'conv-canvas-seed');
  await scoped.run({ name: '团队长1', role: '团队长', message: '统筹任务' }, boss);
  const tl1 = scoped.store.named(bossOwnerId, '团队长1');
  await scoped.poll(tl1.agentId);
  await scoped.run({ name: '后端1', role: '后端', message: '开发 API' }, leadExtra(tl1.agentId, ws));
  const be1 = scoped.store.named(bossOwnerId, '后端1');
  await scoped.poll(be1.agentId);

  // Also insert a broken-parent stray to test cli team strays & sweep
  scoped.store.insert({
    agentId: 'agent-cli-stray',
    ownerId: 'owner-lost-old',
    sessionId: 'sess-cli-stray',
    name: '散人前端1',
    role: '前端',
    lifetime: 'once',
    target: 'claude-cli',
    workspace: ws,
    parentAgentId: 'agent-missing-parent',
    state: 'failed',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3600_000).toISOString(),
    history: [],
  });
  await scoped.drainPolls();
  scoped.close();

  const runCli = async (args, cwd = ws) => {
    const env = { ...process.env };
    delete env.ANTIGRAVITY_CONVERSATION_ID;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--no-warnings', cliScript, '--config', cfgPath, ...args],
      { cwd, env, windowsHide: true },
    );
    assert.equal(stderr.trim(), '', `Expected clean stderr without warnings, got: ${stderr}`);
    return JSON.parse(stdout);
  };

  // 1) Zero-arg owner auto-resolution on board post & read
  const postOut = await runCli(['--workspace', ws, 'board', 'post', '画布广播：全员准备联调', '--author', 'CanvasBoss']);
  assert.equal(postOut.posted, true);
  assert.equal(postOut.message.author, 'CanvasBoss');
  assert.equal(postOut.message.rootOwnerId, bossOwnerId);

  const readOut = await runCli(['--workspace', ws, 'board', 'read', '--limit', '10']);
  assert.equal(readOut.rootOwnerId, bossOwnerId);
  assert.equal(readOut.messages.length, 1);
  assert.equal(readOut.messages[0].text, '画布广播：全员准备联调');

  // 2) cli team strays / reparent / kick / sweep
  const straysOut = await runCli(['--workspace', ws, 'team', 'strays']);
  assert.equal(straysOut.ok, true);
  assert.equal(straysOut.strays.some(s => s.name === '散人前端1'), true);

  const reparentOut = await runCli(['--workspace', ws, 'team', 'reparent', '团队长1/后端1', '--parent', 'root']);
  assert.equal(reparentOut.ok, true);
  assert.equal(reparentOut.parentAgentId, null);
  assert.equal(reparentOut.agentPath, '后端1');

  const kickOut = await runCli(['--workspace', ws, 'team', 'kick', '团队长1', '--kill-tree']);
  assert.equal(kickOut.ok, true);
  assert.equal(kickOut.keepChildren, false);
  assert.deepEqual(kickOut.removedNames, ['团队长1']);

  const sweepOut = await runCli(['--workspace', ws, 'team', 'sweep']);
  assert.equal(sweepOut.ok, true);
  assert.deepEqual(sweepOut.sweptNames, ['散人前端1']);

  // 3) Empty workspace with zero existing owners still works out-of-the-box via deterministic canvas owner!
  const emptyPost = await runCli(['--workspace', emptyWs, 'board', 'post', '全新空工作区首条留言']);
  assert.equal(emptyPost.posted, true);
  const emptyRead = await runCli(['--workspace', emptyWs, 'board', 'read']);
  assert.equal(emptyRead.messages.length, 1);
  assert.equal(emptyRead.messages[0].text, '全新空工作区首条留言');
});
