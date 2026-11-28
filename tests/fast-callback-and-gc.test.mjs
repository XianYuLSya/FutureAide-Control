import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BACKEND_METHODS } from '../src/agent-backend.mjs';
import { TRUSTED_CALLER } from '../src/calling-context.mjs';
import { createCleanupService } from '../src/cleanup-service.mjs';
import { submitCliCallback } from '../src/cli-callback-bridge.mjs';
import { loadConfig } from '../src/config.mjs';
import { closeReportService, ensureReportService } from '../src/report-endpoint.mjs';
import { createScopedAgents, extractBoardMentions } from '../src/scoped-agents.mjs';

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliScript = path.join(pluginRoot, 'src', 'cli.mjs');
const bridgeScript = path.join(pluginRoot, 'src', 'cli-callback-bridge.mjs');

async function withTempDir(t, prefix = 'lane-b-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    await closeReportService().catch(() => {});
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

function managedCliExtra(parentAgentId, ownerId, workspace) {
  return {
    [TRUSTED_CALLER]: {
      source: 'managed-cli',
      parentAgentId,
      ownerId,
      workspace,
    },
  };
}

/**
 * Lightweight mock headless `codex-cli` backend that exercises the exact `adapterDeps`
 * contract (`codexCliReportConfig`, `callerEnv`, `readParentSubmissions`, `writeNativeState`)
 * without launching external paid model calls.
 */
function createFakeCodexCliHarness() {
  const runs = new Map();
  const capturedConfigs = new Map();
  const adapter = (record, deps) => {
    const load = deps.load ?? (() => record);
    const state = () => ({ seq: 0, requests: {}, answers: {}, answered: [], ...(deps.readNativeState?.() ?? {}) });
    const save = v => deps.writeNativeState(v);

    async function submissions(val) {
      const taskId = load().task?.taskId;
      const { questions = [], reports = [] } = await deps.readParentSubmissions();
      return {
        questions: questions.filter(q => q.taskId === taskId).map(q => (val.answered.includes(q.id) ? { ...q, state: 'answered' } : q)),
        reports: reports.filter(r => r.taskId === taskId),
      };
    }

    return {
      target: 'codex-cli',
      labels: { host: 'Codex CLI', bridge: 'Mock Codex CLI' },
      requiredMethods: BACKEND_METHODS,
      async probe() {
        if (typeof deps.resolveRoute === 'function' && deps.config?.requireProxy === true) {
          const route = await deps.resolveRoute({});
          if (!route.ok) {
            throw Object.assign(new Error(route.error || 'Proxy unavailable'), { code: route.code || 'proxy-unavailable' });
          }
        }
        return { identity: { application: 'codex-cli' }, methods: BACKEND_METHODS, treeProtocol: 1, reportProtocol: 1 };
      },
      async create() {
        save(state());
        return { sessionId: load().sessionId, modelRequestsStarted: 0 };
      },
      async beginTask() {
        const val = state();
        const taskId = load().task?.taskId;
        if (val.taskId !== taskId) {
          val.taskId = taskId;
          val.answered = [];
          val.answers = {};
          save(val);
        }
        return { treeProtocol: 1, reportProtocol: 1, throughSeq: val.seq };
      },
      async observe() {
        const cur = load();
        const val = state();
        const runState = runs.get(cur.agentId) ?? { running: false };
        const running = runState.running === true;
        return {
          sessionId: cur.sessionId,
          taskId: cur.task?.taskId,
          running,
          throughSeq: val.seq,
          currentModel: { provider: 'openai', model: 'gpt-5.4' },
          modelSelectionObserved: false,
          changes: runState.changes ?? [],
          coverage: { source: 'codex-cli', complete: false, note: 'mock' },
          ...(await submissions(val)),
          tree: {
            settled: !running,
            running,
            nodes: [{
              sessionId: cur.sessionId,
              parentSessionId: null,
              name: cur.name,
              status: running ? 'running' : 'idle',
              activity: running ? 'running' : 'idle',
              changes: runState.changes ?? [],
              coverage: 'mock',
            }],
          },
        };
      },
      async history() { return { messages: [], hasMore: false }; },
      async answer({ answerId, message }) {
        const val = state();
        const pending = (await submissions(val)).questions.filter(q => q.state === 'pending');
        if (!pending.length) throw Object.assign(new Error('No pending question'), { code: 'question-not-pending' });
        const ids = pending.map(q => q.id);
        val.answered.push(...ids);
        const res = { consumedQuestionIds: ids, continuation: `Parent answer:\n${message}` };
        val.answers[answerId] = res;
        save(val);
        return res;
      },
      async deliver({ requestId, message }) {
        const cur = load();
        if (typeof deps.resolveRoute === 'function' && (deps.config?.requireProxy === true || deps.config?.cliRoutes?.['codex-cli'] !== undefined)) {
          const route = await deps.resolveRoute({});
          if (!route.ok) {
            throw Object.assign(new Error(route.error || 'Proxy unavailable'), {
              code: route.code || 'proxy-unavailable',
              terminal: true,
              notSent: true,
            });
          }
        }
        const reportCfg = deps.codexCliReportConfig(requestId);
        capturedConfigs.set(cur.agentId, { reportCfg, callerEnv: deps.callerEnv, requestId, taskId: cur.task?.taskId, message });
        const val = state();
        const resumedFromThread = val.threadId ?? null;
        val.threadId ??= `thread-${cur.agentId.slice(-8)}`;
        val.started = true;
        val.active = requestId;
        val.requests[requestId] = { status: 'accepted', taskId: cur.task?.taskId, afterSeq: val.seq, resumedFromThread, message };
        save(val);
        runs.set(cur.agentId, { ...(runs.get(cur.agentId) ?? {}), running: true, requestId, taskId: cur.task?.taskId, resumedFromThread });
        return { accepted: true, status: 'accepted', afterSeq: val.seq, actualModel: 'gpt-5.4' };
      },
      async receipt({ requestId }) {
        const val = state();
        const req = val.requests[requestId];
        return req ? { status: req.status, afterSeq: req.afterSeq, result: { accepted: true, requestId } } : undefined;
      },
      async turn({ requestId }) {
        const cur = load();
        const runState = runs.get(cur.agentId);
        if (runState?.running) return { state: 'running', correlation: 'request-id' };
        return { state: 'ended', correlation: 'request-id', completionReason: { kind: 'completed' }, endSeq: 1 };
      },
      async models() {
        return {
          default: { provider: 'openai', model: 'gpt-5.4' },
          routableProviders: ['openai'],
          groups: [{
            id: 'openai',
            provider: 'openai',
            models: [{ id: 'gpt-5.4', name: 'GPT 5.4', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
          }],
        };
      },
      async model() { return { provider: 'openai', model: 'gpt-5.4' }; },
      async selectModel() { throw Object.assign(new Error('unsupported'), { code: 'model-selection-unsupported' }); },
      async cancel() {
        const cur = load();
        runs.set(cur.agentId, { ...(runs.get(cur.agentId) ?? {}), running: false });
        return { cancelRequested: true };
      },
      async destroy() {
        const cur = load();
        runs.set(cur.agentId, { ...(runs.get(cur.agentId) ?? {}), running: false });
        const val = state();
        return { destroyed: true, nativeSessionRetained: Boolean(val.threadId) };
      },
      async cursor() { return { throughSeq: state().seq }; },
    };
  };
  return { adapter, runs, capturedConfigs };
}

test('1. thin cli-callback-bridge stays zero-heavy-import, pushes HTTP <50ms to inline wait, falls back offline, and exits on EOF', async t => {
  const bridgeSource = await readFile(bridgeScript, 'utf8');
  const importSpecifiers = [
    ...[...bridgeSource.matchAll(/^\s*import\b[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]),
    ...[...bridgeSource.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
  ];
  assert.ok(importSpecifiers.length > 0, 'must parse bridge imports');
  for (const spec of importSpecifiers) {
    assert.doesNotMatch(spec, /scoped-agents|peers|codex-ipc|dsh|futureaide-api|mcp-server/,
      `cli-callback-bridge must never import heavy orchestration module: ${spec}`);
  }

  const dir = await withTempDir(t, 'fast-cb-');
  const workspace = path.join(dir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify({ target: 'dsh', dataRoot: path.join(dir, 'dsh'), reportPort: 0 }), 'utf8');
  const config = await loadConfig(configFile);

  const harness = createFakeCodexCliHarness();
  const service = createScopedAgents(config, {
    startSharedMonitor: async () => true,
    backendAdapters: { 'codex-cli': harness.adapter },
  });
  t.after(() => service.close());

  const httpStatus = await ensureReportService({
    store: service.store,
    port: 0,
    runtimeDir: config.stateDirectory,
    onCliSubmission: payload => service.handleCliSubmission(payload),
  });
  assert.equal(httpStatus.ready, true);

  const caller = agyExtra('conv-fast-1', workspace);
  const dispatched = await service.run({
    name: '后端1',
    target: 'codex-cli',
    lifetime: 'once',
    message: '实现极薄回调桥',
  }, caller);
  assert.equal(dispatched.created, true);
  assert.equal(dispatched.role, '后端');

  const agentRecord = service.store.list()[0];
  await service.poll(agentRecord.agentId);
  const captured = harness.capturedConfigs.get(agentRecord.agentId);
  assert.ok(captured, 'dispatch must capture codex-cli reportConfig');
  assert.equal(captured.reportCfg.args[0], bridgeScript);
  assert.equal(captured.callerEnv.FUTUREAIDE_MANAGED_CLI, '1');
  assert.equal(captured.callerEnv.FUTUREAIDE_PARENT_AGENT_ID, agentRecord.agentId);
  assert.equal(Number(captured.callerEnv.FUTUREAIDE_REPORT_PORT), httpStatus.port);

  // Start wait BEFORE ask_parent arrives; measure wakeup latency (<50ms).
  const waitQuestionPromise = service.wait({ taskKeys: [dispatched.taskKey], timeoutSeconds: 10 }, caller);
  await new Promise(r => setTimeout(r, 15));
  const askStart = performance.now();
  const askReceipt = await submitCliCallback({
    roster: service.store.location,
    agentId: agentRecord.agentId,
    taskId: captured.taskId,
    requestId: captured.requestId,
    target: 'codex-cli',
    kind: 'ask',
    message: '接口超时选 3s 还是 10s？',
    port: httpStatus.port,
  });
  assert.equal(askReceipt.accepted, true);
  const askWaitResult = await waitQuestionPromise;
  const askElapsedMs = performance.now() - askStart;
  assert.ok(askElapsedMs < 50, `expected <50ms HTTP callback wakeup, got ${askElapsedMs.toFixed(2)}ms`);
  assert.equal(askWaitResult.reason, 'event');
  const qEvent = askWaitResult.events.find(e => e.type === 'question');
  assert.ok(qEvent);
  assert.equal(qEvent.message, '接口超时选 3s 还是 10s？');
  assert.equal(qEvent.error, undefined, 'antigravity caller must not get antigravity-pull-only error');

  // Authoritative rejection check: final report while question is unanswered must reject.
  await assert.rejects(
    submitCliCallback({
      roster: service.store.location,
      agentId: agentRecord.agentId,
      taskId: captured.taskId,
      requestId: captured.requestId,
      target: 'codex-cli',
      kind: 'report',
      message: '抢跑交卷',
      final: true,
      port: httpStatus.port,
    }),
    err => err.code === 'question-unanswered',
  );

  // Answer the question and resume the turn.
  harness.runs.set(agentRecord.agentId, { running: false });
  const answered = await service.answer({ name: '后端1', message: '选 3s' }, caller);
  assert.equal(answered.answered, true);
  await service.poll(agentRecord.agentId);
  const resumedCapture = harness.capturedConfigs.get(agentRecord.agentId);

  // Push final report over HTTP; verify <50ms inline message + preserved body ref + automatic once cleanup + stub!
  const waitFinalPromise = service.wait({
    taskKeys: [dispatched.taskKey],
    after: askWaitResult.nextCursor,
    timeoutSeconds: 10,
  }, caller);
  await new Promise(r => setTimeout(r, 15));
  harness.runs.set(agentRecord.agentId, { running: false });
  const reportStart = performance.now();
  await submitCliCallback({
    roster: service.store.location,
    agentId: agentRecord.agentId,
    taskId: resumedCapture.taskId,
    requestId: resumedCapture.requestId,
    target: 'codex-cli',
    kind: 'report',
    message: '已按 3s 超时完成实现并通过自测。',
    final: true,
    port: httpStatus.port,
  });
  const finalWaitResult = await waitFinalPromise;
  const reportElapsedMs = performance.now() - reportStart;
  assert.ok(reportElapsedMs < 50, `expected <50ms final report wakeup, got ${reportElapsedMs.toFixed(2)}ms`);
  const finalEvent = finalWaitResult.events.find(e => e.type === 'final');
  assert.ok(finalEvent);
  assert.equal(finalEvent.message, '已按 3s 超时完成实现并通过自测。');
  assert.equal(finalEvent.delivery, 'delivered');
  assert.ok(finalEvent.body?.submissionId, 'legacy body reference must remain intact');

  // Wait briefly for asynchronous once auto-cleanup settlement to finish.
  await service.flushSettlements();
  assert.equal(service.store.get(agentRecord.agentId), undefined, 'once agent must be auto-removed from agents table after wait delivery');
  const agentScopedDir = path.join(config.stateDirectory, 'scoped', agentRecord.ownerId, agentRecord.agentId);
  await assert.rejects(lstat(agentScopedDir), { code: 'ENOENT' });
  const stub = service.store.getAgentStub(agentRecord.ownerId, '后端1');
  assert.ok(stub, 'compact resume stub must survive once cleanup for follow-up');
  assert.ok(stub.resumeSessionId?.startsWith('thread-'));

  // Close HTTP listener and verify seamless fallback to local RosterStore + stdio EOF exit.
  await closeReportService();
  const offlineRun = await service.run({ name: '后端离线', target: 'codex-cli', lifetime: 'persistent', message: '离线降级测试' }, caller);
  const offlineAgent = service.store.named(agentRecord.ownerId, '后端离线');
  await service.poll(offlineAgent.agentId);
  const offlineCap = harness.capturedConfigs.get(offlineAgent.agentId);

  const fallbackReceipt = await submitCliCallback({
    roster: service.store.location,
    agentId: offlineAgent.agentId,
    taskId: offlineCap.taskId,
    requestId: offlineCap.requestId,
    target: 'codex-cli',
    kind: 'report',
    message: 'HTTP 未监听时本地直写成功',
    final: false,
    port: httpStatus.port, // closed port -> automatic local fallback
  });
  assert.equal(fallbackReceipt.accepted, true);
  const offlineWait = await service.wait({ taskKeys: [offlineRun.taskKey], timeoutSeconds: 2 }, caller);
  assert.equal(offlineWait.events[0].message, 'HTTP 未监听时本地直写成功');

  // Verify stdio process exits immediately when stdin closes (EOF).
  const child = spawn(process.execPath, [
    bridgeScript, '--codex-cli-reports',
    service.store.location, offlineAgent.agentId, offlineCap.taskId, offlineCap.requestId,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exitPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge process did not exit on stdin EOF')), 3000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.end();
  const exitCode = await exitPromise;
  assert.equal(exitCode, 0);
});

test('2. barrier="all" aggregates parallel tasks and breaks immediately on question or failure', async t => {
  const dir = await withTempDir(t, 'barrier-');
  const workspace = path.join(dir, 'ws');
  await mkdir(workspace, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify({ target: 'dsh', dataRoot: path.join(dir, 'dsh'), reportPort: 0 }), 'utf8');
  const config = await loadConfig(configFile);
  const harness = createFakeCodexCliHarness();
  const service = createScopedAgents(config, {
    startSharedMonitor: async () => true,
    backendAdapters: { 'codex-cli': harness.adapter },
  });
  t.after(() => service.close());

  const caller = agyExtra('conv-barrier', workspace);
  const r1 = await service.run({ role: '后端', target: 'codex-cli', lifetime: 'persistent', message: '任务A' }, caller);
  const r2 = await service.run({ role: '后端', target: 'codex-cli', lifetime: 'persistent', message: '任务B' }, caller);
  assert.equal(r1.name, '后端1');
  assert.equal(r2.name, '后端2');

  const a1 = service.store.list().find(a => a.name === '后端1');
  const a2 = service.store.list().find(a => a.name === '后端2');
  await service.poll(a1.agentId);
  await service.poll(a2.agentId);
  const cap1 = harness.capturedConfigs.get(a1.agentId);
  const cap2 = harness.capturedConfigs.get(a2.agentId);

  let barrierResolved = false;
  const barrierWait = service.wait({
    taskKeys: [r1.taskKey, r2.taskKey],
    barrier: 'all',
    timeoutSeconds: 10,
  }, caller).then(res => { barrierResolved = true; return res; });

  // Worker 1 finishes first; barrier='all' must keep waiting for Worker 2!
  harness.runs.set(a1.agentId, { running: false });
  service.store.submitParentMessage(a1.agentId, { kind: 'report', message: 'A已完成', final: true }, {
    taskId: cap1.taskId, requestId: cap1.requestId, target: 'codex-cli',
  });
  service.notifyWait();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(barrierResolved, false, 'barrier="all" must not wake when only 1 of 2 tasks finished without questions');

  // Worker 2 asks a question -> immediate 0s barrier break carrying BOTH A's final and B's question!
  service.store.submitParentMessage(a2.agentId, { kind: 'ask', message: 'B求定夺：选方案1还是方案2？', final: false }, {
    taskId: cap2.taskId, requestId: cap2.requestId, target: 'codex-cli',
  });
  service.notifyWait();
  const broken = await barrierWait;
  assert.equal(broken.reason, 'event');
  assert.ok(broken.events.some(e => e.name === '后端1' && e.type === 'final' && e.message === 'A已完成'));
  assert.ok(broken.events.some(e => e.name === '后端2' && e.type === 'question' && e.message.includes('B求定夺')));

  // Answer B, then wait with barrier='all' until B finishes too.
  harness.runs.set(a2.agentId, { running: false });
  await service.answer({ name: '后端2', message: '选方案1' }, caller);
  await service.poll(a2.agentId);
  const cap2Next = harness.capturedConfigs.get(a2.agentId);

  const secondWait = service.wait({
    taskKeys: [r1.taskKey, r2.taskKey],
    after: broken.nextCursor,
    barrier: 'all',
    timeoutSeconds: 10,
  }, caller);
  harness.runs.set(a2.agentId, { running: false });
  service.store.submitParentMessage(a2.agentId, { kind: 'report', message: 'B也完成了', final: true }, {
    taskId: cap2Next.taskId, requestId: cap2Next.requestId, target: 'codex-cli',
  });
  service.notifyWait();
  const allDone = await secondWait;
  assert.ok(allDone.events.some(e => e.name === '后端2' && e.type === 'final' && e.message === 'B也完成了'));
});

test('3. headless CLI parent-child chain, three-scope list (team/agent/all), board @mentions (Chinese + path + stub revival), and worktree isolation', async t => {
  const dir = await withTempDir(t, 'hierarchy-board-');
  const repoDir = path.join(dir, 'repo');
  await mkdir(repoDir, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: repoDir, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, windowsHide: true });
  await writeFile(path.join(repoDir, 'README.md'), '# test\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: repoDir, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir, windowsHide: true });

  const configFile = path.join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify({ target: 'dsh', dataRoot: path.join(dir, 'dsh'), workspace: repoDir }), 'utf8');
  const config = await loadConfig(configFile);
  const harness = createFakeCodexCliHarness();
  const service = createScopedAgents(config, {
    startSharedMonitor: async () => true,
    backendAdapters: { 'codex-cli': harness.adapter },
  });
  t.after(() => service.close());

  // Verify Unicode @mention parser handles Chinese names and slash paths.
  assert.deepEqual(
    extractBoardMentions('请 @后端1 和 @团队长1/前端2 核对接口，抄送 @worker-3'),
    ['后端1', '团队长1/前端2', 'worker-3'],
  );

  // Root Team A (Antigravity) spawns team lead `团队长1`
  const bossA = agyExtra('conv-team-a', repoDir);
  const leadRun = await service.run({ role: '团队长', target: 'codex-cli', lifetime: 'persistent', message: '统筹模块改造' }, bossA);
  assert.equal(leadRun.name, '团队长1');
  const leadRec = service.store.list().find(r => r.name === '团队长1');
  await service.poll(leadRec.agentId);

  // Headless CLI `团队长1` spawns two children using `FUTUREAIDE_PARENT_AGENT_ID` + auto role numbering + worktree!
  const leadCaller = managedCliExtra(leadRec.agentId, leadRec.ownerId, repoDir);
  const worker1 = await service.run({
    role: '后端',
    target: 'codex-cli',
    lifetime: 'once',
    workspaceMode: 'worktree',
    message: '负责存储层',
  }, leadCaller);
  const worker2 = await service.run({
    role: '后端',
    target: 'codex-cli',
    lifetime: 'persistent',
    message: '负责接口层',
  }, leadCaller);
  assert.equal(worker1.name, '后端1');
  assert.equal(worker2.name, '后端2');

  const w1Rec = service.store.list().find(r => r.name === '后端1');
  const w2Rec = service.store.list().find(r => r.name === '后端2');
  assert.equal(w1Rec.parentAgentId, leadRec.agentId, 'child must link parentAgentId to headless CLI lead');
  assert.equal(w2Rec.parentAgentId, leadRec.agentId);
  assert.equal(w1Rec.workspaceMode, 'worktree');
  assert.ok(w1Rec.worktreePath.includes(path.join('.work', 'worktrees')));
  assert.equal((await lstat(w1Rec.worktreePath)).isDirectory(), true);

  // Separate Root Team B (another conversation) for `scope: 'all'` grouping check.
  const bossB = agyExtra('conv-team-b', repoDir);
  await service.run({ role: '前端', target: 'codex-cli', lifetime: 'persistent', message: '独立页面微调' }, bossB);

  // Scope 1: 'team' (whole hierarchy of Team A + role filter + stale idle filtering)
  const teamList = await service.list(bossA, { scope: 'team' });
  assert.equal(teamList.scope, 'team');
  assert.equal(teamList.hasHierarchy, true);
  assert.deepEqual(teamList.items.map(i => i.agentPath).sort(), ['团队长1', '团队长1/后端1', '团队长1/后端2'].sort());

  const roleFiltered = await service.list(bossA, { scope: 'team', role: '后端' });
  assert.deepEqual(roleFiltered.items.map(i => i.name).sort(), ['后端1', '后端2']);

  // Scope 2: 'agent' (locate grandchild/child by path `团队长1/后端2`)
  await service.poll(w2Rec.agentId);
  const w2Cap = harness.capturedConfigs.get(w2Rec.agentId);
  service.store.submitParentMessage(w2Rec.agentId, { kind: 'ask', message: '分页默认 20 还是 50？' }, {
    taskId: w2Cap.taskId, requestId: w2Cap.requestId, target: 'codex-cli',
  });
  const agentDetailRes = await service.list(bossA, { scope: 'agent', name: '团队长1/后端2' });
  assert.equal(agentDetailRes.agent.name, '后端2');
  assert.equal(agentDetailRes.agent.role, '后端');
  assert.equal(agentDetailRes.agent.agentPath, '团队长1/后端2');
  assert.equal(agentDetailRes.agent.questions[0].message, '分页默认 20 还是 50？');

  // Scope 3: 'all' (grouped by distinct root owners)
  const allRes = await service.list(bossA, { scope: 'all' });
  assert.equal(allRes.teams.length, 2);
  const teamAGroup = allRes.teams.find(g => g.ownerId === leadRec.ownerId);
  const teamBGroup = allRes.teams.find(g => g.ownerId !== leadRec.ownerId);
  assert.equal(teamAGroup.hasHierarchy, true);
  assert.equal(teamAGroup.memberCount, 3);
  assert.equal(teamAGroup.pendingQuestions, 1);
  assert.equal(teamBGroup.hasHierarchy, false);
  assert.equal(teamBGroup.memberCount, 1);

  // Finish `后端1` (once + worktree) so it auto-cleans its worktree & leaves a stub, then revive it via @后端1 on team board!
  await service.poll(w1Rec.agentId);
  const w1Cap = harness.capturedConfigs.get(w1Rec.agentId);
  const w1Worktree = w1Rec.worktreePath;
  harness.runs.set(w1Rec.agentId, { running: false });
  service.store.submitParentMessage(w1Rec.agentId, { kind: 'report', message: '存储层完毕', final: true }, {
    taskId: w1Cap.taskId, requestId: w1Cap.requestId, target: 'codex-cli',
  });
  const w1Wait = await service.wait({ taskKeys: [worker1.taskKey], timeoutSeconds: 5 }, leadCaller);
  assert.equal(w1Wait.events[0].message, '存储层完毕');
  await service.flushSettlements();
  await assert.rejects(lstat(w1Worktree), { code: 'ENOENT' }, 'worktree directory must be removed on once cleanup');
  assert.equal(service.store.get(w1Rec.agentId), undefined);

  // Boss posts on team board mentioning `@后端1` (revive from stub!) and `@团队长1/后端2` (wake active member!)
  harness.runs.set(w2Rec.agentId, { running: false });
  await service.answer({ name: '后端2', message: '默认 50' }, leadCaller);
  await service.poll(w2Rec.agentId);
  harness.runs.set(w2Rec.agentId, { running: false });

  const posted = await service.postBoard({
    message: '@后端1 补充确认一下索引字段；@团队长1/后端2 请同步对齐该字段。',
  }, bossA);
  assert.equal(posted.posted, true);
  const revivedRoute = posted.routed.find(r => r.mention === '后端1');
  const wokenRoute = posted.routed.find(r => r.mention === '团队长1/后端2');
  assert.equal(revivedRoute?.action, 'revived');
  assert.equal(revivedRoute?.resumedSession, true);
  assert.equal(wokenRoute?.action, 'woken');

  const revivedAgent = service.store.list().find(r => r.name === '后端1');
  assert.ok(revivedAgent, 'revived agent must exist again under same team');
  assert.equal(revivedAgent.parentAgentId, leadRec.agentId, 'revived child preserves parentAgentId');
  await service.poll(revivedAgent.agentId);
  assert.ok(harness.runs.get(revivedAgent.agentId)?.resumedFromThread?.startsWith('thread-'),
    'revived once agent must resume its original CLI threadId');

  const boardRead = await service.readBoard({ limit: 10 }, bossA);
  assert.equal(boardRead.messages.length, 1);
  assert.match(boardRead.messages[0].text, /@后端1/);
});

test('4. default agentAutoCleanup=true (respecting explicit false), auto GC, CLI wait wakeup, and fail-closed CLI proxy management', async t => {
  const dir = await withTempDir(t, 'gc-proxy-cli-');
  const workspace = path.join(dir, 'ws');
  await mkdir(workspace, { recursive: true });

  // 4a. Config default is true, while explicit false is strictly respected.
  const defaultCfgFile = path.join(dir, 'default-config.json');
  await writeFile(defaultCfgFile, JSON.stringify({ target: 'dsh', dataRoot: path.join(dir, 'dsh') }), 'utf8');
  const loadedDefault = await loadConfig(defaultCfgFile);
  assert.equal(loadedDefault.agentAutoCleanup, true);

  const disabledCfgFile = path.join(dir, 'disabled-config.json');
  await writeFile(disabledCfgFile, JSON.stringify({ target: 'dsh', dataRoot: path.join(dir, 'dsh'), agentAutoCleanup: false }), 'utf8');
  const loadedDisabled = await loadConfig(disabledCfgFile);
  assert.equal(loadedDisabled.agentAutoCleanup, false);

  // 4b. CleanupService runs in zero-approval auto mode when cleanup-binding.json is absent.
  const autoCleanupSvc = createCleanupService(loadedDefault, {
    roster: {
      inventory: async () => ({
        complete: true,
        items: [{
          id: 'stale-1', kind: 'agent-tree', root: loadedDefault.stateDirectory,
          name: 'zombie', target: 'codex-cli', running: false, eligible: true,
          activityVersion: 'v1', reason: 'expired-once', bytes: 128,
        }],
      }),
      inspect: async item => ({ ...item, running: false, eligible: true, activityVersion: 'v1' }),
      remove: async () => ({ removed: true, bytes: 128 }),
      archives: async () => [],
    },
    files: {
      inventory: async () => ({ complete: true, items: [] }),
      inspect: async item => item,
      remove: async () => ({ removed: true, bytes: 0 }),
    },
    dsh: { inventory: async () => ({ complete: true, items: [] }) },
  });
  const monState = await autoCleanupSvc.monitorState();
  assert.equal(monState.auto, true);
  const swept = await autoCleanupSvc.execute('rules');
  assert.equal(swept.autoMode, true);
  assert.equal(swept.items.length, 1);
  assert.equal(swept.items[0].removed, true);

  // 4c. Proxy binding + fail-closed probe + autoWakeFaswitch recovery + CLI `proxy` and `wait` subcommands.
  const proxyServer = net.createServer(socket => socket.destroy());
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => proxyServer.close());
  const liveProxyPort = proxyServer.address().port;

  let wokenCalls = 0;
  let simulatedWakeServer = null;
  t.after(() => simulatedWakeServer?.close());

  // Reserve a dead port first.
  const tempSrv = net.createServer();
  await new Promise(resolve => tempSrv.listen(0, '127.0.0.1', resolve));
  const wakePort = tempSrv.address().port;
  await new Promise(resolve => tempSrv.close(resolve));

  const fakeFaswitchExe = path.join(dir, 'FAswitch.exe');
  await writeFile(fakeFaswitchExe, 'stub', 'utf8');
  const strictCfgFile = path.join(dir, 'strict-config.json');
  await writeFile(strictCfgFile, JSON.stringify({
    target: 'dsh',
    dataRoot: path.join(dir, 'dsh'),
    requireProxy: true,
    autoWakeFaswitch: true,
  }), 'utf8');
  const strictConfig = await loadConfig(strictCfgFile);
  strictConfig.faswitchExecutable = fakeFaswitchExe;

  const harness = createFakeCodexCliHarness();
  const service = createScopedAgents(strictConfig, {
    startSharedMonitor: async () => true,
    backendAdapters: { 'codex-cli': harness.adapter },
    faswitchWakeTimeoutMs: 1500,
    spawnFaswitch: async (_exe, args) => {
      wokenCalls += 1;
      assert.deepEqual(args, ['--autostart']);
      // Simulate FAswitch bringing up the bound port within 150ms!
      simulatedWakeServer = net.createServer(s => s.destroy());
      await new Promise(resolve => simulatedWakeServer.listen(wakePort, '127.0.0.1', resolve));
    },
  });
  t.after(() => service.close());

  // Bind to `wakePort` (initially closed -> triggers autoWakeFaswitch -> becomes reachable!).
  const boundWake = await service.manageCliProxy({ action: 'bind', target: 'codex-cli', proxy: wakePort });
  assert.equal(wokenCalls, 1, 'autoWakeFaswitch must launch FAswitch --autostart when port is down');
  assert.equal(boundWake.ok, true);
  assert.equal(boundWake.routes[0].effectiveMode, 'manual');
  assert.equal(boundWake.routes[0].port, wakePort);
  assert.equal(boundWake.routes[0].proxyReachable, true);

  // Close `simulatedWakeServer` and disable autoWake to verify strict fail-closed `proxy-unavailable`.
  await new Promise(resolve => simulatedWakeServer.close(resolve));
  simulatedWakeServer = null;
  strictConfig.autoWakeFaswitch = false;
  const deadCheck = await service.manageCliProxy({ action: 'status', target: 'codex-cli' });
  assert.equal(deadCheck.ok, false);
  assert.equal(deadCheck.error.code, 'proxy-unavailable');

  // Bind to live port via CLI `proxy bind` command.
  const { stdout: bindStdout } = await execFileAsync(process.execPath, [
    cliScript, '--config', defaultCfgFile, 'proxy', 'bind', 'all', String(liveProxyPort),
  ], { windowsHide: true });
  const cliBindRes = JSON.parse(bindStdout);
  assert.equal(cliBindRes.ok, true);
  assert.equal(cliBindRes.routes.every(r => r.port === liveProxyPort && r.proxyReachable === true), true);

  // Test `node src/cli.mjs wait --conversation ...` waking up immediately on submission.
  const cliSvc = createScopedAgents(await loadConfig(defaultCfgFile), {
    startSharedMonitor: async () => true,
    backendAdapters: { 'codex-cli': harness.adapter },
  });
  t.after(() => cliSvc.close());
  const convId = 'conv-cli-wait-1';
  const runReceipt = await cliSvc.run({ name: '观察员1', target: 'codex-cli', lifetime: 'persistent', message: '后台等待唤醒' }, agyExtra(convId, workspace));
  const obsRec = cliSvc.store.list().find(r => r.name === '观察员1');
  await cliSvc.poll(obsRec.agentId);
  const obsCap = harness.capturedConfigs.get(obsRec.agentId);

  const waiterProc = execFileAsync(process.execPath, [
    cliScript, '--config', defaultCfgFile,
    'wait', '--conversation', convId, '--workspace', workspace, '--names', '观察员1', '--timeout', '10',
  ], { windowsHide: true });

  await new Promise(r => setTimeout(r, 250));
  cliSvc.store.submitParentMessage(obsRec.agentId, { kind: 'report', message: 'CLI wait 秒醒验证通过', final: true }, {
    taskId: obsCap.taskId, requestId: obsCap.requestId, target: 'codex-cli',
  });
  const { stdout: waitStdout } = await waiterProc;
  const parsedWait = JSON.parse(waitStdout);
  assert.equal(parsedWait.reason, 'event');
  assert.equal(parsedWait.events[0].message, 'CLI wait 秒醒验证通过');
});
