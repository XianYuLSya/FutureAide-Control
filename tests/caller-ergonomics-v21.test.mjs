import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { BACKEND_METHODS } from '../src/agent-backend.mjs';
import { TRUSTED_CALLER } from '../src/calling-context.mjs';
import { createClaudeCliBackend } from '../src/claude-cli-backend.mjs';
import {
  CLAUDE_TURN_FILES,
  MAX_LAST_STEP_CHARS as CLAUDE_MAX_STEP,
  applyClaudeLine,
  createClaudeTurnState,
  readClaudeTurn,
  writeJsonFile as writeClaudeJson,
} from '../src/claude-cli-runner.mjs';
import { createCodexCliBackend } from '../src/codex-cli-backend.mjs';
import {
  CODEX_TURN_FILES,
  MAX_LAST_STEP_CHARS as CODEX_MAX_STEP,
  applyCodexLine,
  createCodexTurnState,
  readCodexTurn,
  writeJsonFile as writeCodexJson,
} from '../src/codex-cli-runner.mjs';
import { loadConfig } from '../src/config.mjs';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import {
  clearTeamConfigCache,
  loadTeamConfigDefaults,
  parseTeamConfigMarkdown,
  resolveRoleDefaults,
} from '../src/team-config-defaults.mjs';
import { installCliShims, installPlugin } from '../scripts/install-plugin.mjs';

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const tmpBase = path.join(repoRoot, '.work', 'tmp', 'caller-ergonomics-v21');

async function makeTempDir(t, prefix = 'v21-') {
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

function createMockCliAdapters({ startDelayMs = 0 } = {}) {
  const dispatches = [];
  const liveStates = new Map();
  let activeConcurrently = 0;
  let peakConcurrency = 0;

  function makeAdapter(targetName, provider, models) {
    return (record, deps) => {
      const load = deps.load ?? (() => record);
      const state = () => ({ seq: 0, requests: {}, answers: {}, answered: [], ...(deps.readNativeState?.() ?? {}) });
      const save = val => deps.writeNativeState(val);

      async function submissions(val) {
        const taskId = load().task?.taskId;
        const { questions = [], reports = [] } = await deps.readParentSubmissions();
        return {
          questions: questions.filter(q => q.taskId === taskId).map(q => (val.answered.includes(q.id) ? { ...q, state: 'answered' } : q)),
          reports: reports.filter(r => r.taskId === taskId),
        };
      }

      return {
        target: targetName,
        labels: { host: targetName, bridge: `Mock ${targetName}` },
        requiredMethods: BACKEND_METHODS,
        async probe() {
          return { identity: { application: targetName }, methods: BACKEND_METHODS, treeProtocol: 1, reportProtocol: 1 };
        },
        async create() {
          if (startDelayMs > 0) {
            activeConcurrently += 1;
            peakConcurrency = Math.max(peakConcurrency, activeConcurrently);
            await new Promise(r => setTimeout(r, startDelayMs));
            activeConcurrently -= 1;
          }
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
          const info = liveStates.get(cur.agentId) ?? { running: false, stalled: false, activity: 'idle' };
          const running = info.running === true;
          const activity = running ? (info.activity ?? '0s前 · 运行中') : 'idle';
          const stalled = running && info.stalled === true;
          return {
            sessionId: cur.sessionId,
            taskId: cur.task?.taskId,
            running,
            stalled,
            activity,
            throughSeq: val.seq,
            currentModel: val.currentModel ?? null,
            modelSelectionObserved: false,
            changes: [],
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
                ...(stalled ? { stalled: true } : {}),
                changes: [],
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
        async deliver({ requestId, message, model }) {
          const cur = load();
          const val = state();
          val.started = true;
          val.active = requestId;
          val.currentModel = model ? { provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) } : null;
          val.requests[requestId] = { status: 'accepted', taskId: cur.task?.taskId, afterSeq: val.seq, model };
          save(val);
          liveStates.set(cur.agentId, { ...(liveStates.get(cur.agentId) ?? {}), running: true, requestId, taskId: cur.task?.taskId });
          dispatches.push({ agentId: cur.agentId, name: cur.name, target: targetName, requestId, taskId: cur.task?.taskId, message, model });
          return {
            accepted: true,
            status: 'accepted',
            afterSeq: val.seq,
            ...(model?.model ? { actualModel: model.model } : {}),
            ...(model?.reasoningEffort ? { actualEffort: model.reasoningEffort, actualEffortSource: 'host-readback' } : {}),
          };
        },
        async receipt({ requestId }) {
          const val = state();
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
          return { state: 'ended', correlation: 'request-id', completionReason: { kind: 'completed' }, endSeq: 1 };
        },
        async models() {
          return {
            default: { provider, model: models[0].id, reasoningEffort: models[0].defaultEffort },
            routableProviders: [provider],
            groups: [{ id: provider, provider, models }],
          };
        },
        async model() { return state().currentModel ?? null; },
        async selectModel() { throw Object.assign(new Error('unsupported'), { code: 'model-selection-unsupported' }); },
        async cancel() {
          liveStates.set(load().agentId, { running: false });
          return { cancelRequested: true };
        },
        async destroy() {
          liveStates.set(load().agentId, { running: false });
          return { destroyed: true, nativeSessionRetained: true };
        },
        async cursor() { return { throughSeq: state().seq }; },
      };
    };
  }

  const codexModels = [
    { id: 'gpt-6.1-terra', name: 'GPT-6.1-Terra', defaultEffort: 'high', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-6.2-sol', name: 'GPT-6.2-Sol', defaultEffort: 'high', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ];
  const claudeModels = [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', defaultEffort: 'max', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', defaultEffort: 'high', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ];

  return {
    adapters: {
      'codex-cli': makeAdapter('codex-cli', 'openai', codexModels),
      'claude-cli': makeAdapter('claude-cli', 'claude-cli', claudeModels),
    },
    dispatches,
    liveStates,
    peakConcurrency: () => peakConcurrency,
  };
}

test('1. team-config-defaults parses real and custom 团队配置.md with mtimeMs hot cache and role aliases', async t => {
  clearTeamConfigCache();
  const realPath = path.join(homedir(), '.config', 'work-workflow', '团队配置.md');
  const hasReal = await lstat(realPath).then(s => s.isFile()).catch(() => false);
  if (hasReal) {
    const loaded = loadTeamConfigDefaults({ teamConfigPath: realPath });
    assert.equal(loaded.source, 'file');
  }

  for (const role of ['后端', '后端工程师']) {
    const d = resolveRoleDefaults(role);
    assert.deepEqual(
      { target: d.target, model: d.model, effort: d.effort, lifetime: d.lifetime },
      { target: 'codex-cli', model: 'gpt-6.1-terra', effort: 'high', lifetime: 'once' },
    );
  }
  for (const role of ['团队长', '规划师', '主策']) {
    const d = resolveRoleDefaults(role);
    assert.deepEqual(
      { target: d.target, model: d.model, effort: d.effort, lifetime: d.lifetime },
      { target: 'codex-cli', model: 'gpt-6.2-sol', effort: 'high', lifetime: 'once' },
    );
  }
  for (const role of ['审查官', '审查员', '独立审查员', '严谨龙']) {
    const d = resolveRoleDefaults(role);
    assert.deepEqual(
      { target: d.target, model: d.model, effort: d.effort, lifetime: d.lifetime },
      { target: 'codex-cli', model: 'gpt-6.2-astra', effort: 'max', lifetime: 'once' },
    );
  }
  const sec = resolveRoleDefaults('秘书');
  assert.deepEqual(
    { target: sec.target, model: sec.model, effort: sec.effort, lifetime: sec.lifetime },
    { target: 'codex-cli', model: 'gpt-6.2-sol', effort: 'high', lifetime: 'persistent' },
  );
  const inv = resolveRoleDefaults('调查员');
  assert.deepEqual(
    { target: inv.target, model: inv.model, effort: inv.effort, lifetime: inv.lifetime },
    { target: 'codex-cli', model: 'gpt-6.1-terra', effort: 'high', lifetime: 'once' },
  );
  for (const role of ['前端', '前端工程师', '设计师']) {
    const d = resolveRoleDefaults(role);
    assert.deepEqual(
      { target: d.target, model: d.model, effort: d.effort, lifetime: d.lifetime },
      { target: 'claude-cli', model: 'claude-opus-5-5', effort: 'max', lifetime: 'once' },
    );
  }

  // Custom teamConfigPath injection + mtimeMs hot reload check
  const dir = await makeTempDir(t, 'team-cfg-');
  const customMd = path.join(dir, '团队配置.md');
  await writeFile(customMd, [
    '| 角色 | 模型 | 怎么派 |',
    '|---|---|---|',
    '| 后端工程师 | Codex GPT-6.2-Sol，xhigh | 无头 `codex-cli`（`once`） |',
    '| 前端工程师 | Claude Sonnet 5.5，high | 无头 `claude-cli` |',
  ].join('\n'), 'utf8');

  const first = resolveRoleDefaults('后端', { teamConfigPath: customMd });
  assert.equal(first.model, 'gpt-6.2-sol');
  assert.equal(first.effort, 'xhigh');
  const feFirst = resolveRoleDefaults('前端', { teamConfigPath: customMd });
  assert.equal(feFirst.target, 'claude-cli');
  assert.equal(feFirst.model, 'claude-sonnet-5-5');
  assert.equal(feFirst.effort, 'high');

  // Update file and advance mtimeMs -> cache refreshes automatically
  await writeFile(customMd, [
    '| 角色 | 模型 | 怎么派 |',
    '|---|---|---|',
    '| 后端工程师 | Codex GPT-6.1-Terra，high | 无头 `codex-cli`（`persistent`） |',
  ].join('\n'), 'utf8');
  const future = new Date(Date.now() + 5000);
  await utimes(customMd, future, future);

  const reloaded = resolveRoleDefaults('后端', { teamConfigPath: customMd });
  assert.equal(reloaded.model, 'gpt-6.1-terra');
  assert.equal(reloaded.effort, 'high');
  assert.equal(reloaded.lifetime, 'persistent');
  assert.ok(Object.keys(parseTeamConfigMarkdown('| 角色 | 模型 | 怎么派 |\n|---|---|---|\n')).length === 0);
});

test('2. scoped-agents minimal { role, message } auto-defaults, worktree:true, batch tasks concurrency, wakeCmd, and legacy dsh compatibility', async t => {
  const dir = await makeTempDir(t, 'scoped-v21-');
  const repoDir = path.join(dir, 'repo');
  await mkdir(repoDir, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: repoDir, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, windowsHide: true });
  await writeFile(path.join(repoDir, 'README.md'), '# repo\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: repoDir, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir, windowsHide: true });

  const configFile = path.join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify({ target: 'dsh', dataRoot: path.join(dir, 'dsh'), workspace: repoDir }), 'utf8');
  const config = await loadConfig(configFile);

  const mock = createMockCliAdapters({ startDelayMs: 80 });
  let dshCreated = 0;
  const dshApi = {
    async connectionIdentity() { return { application: 'dsh', dataRoot: path.join(dir, 'dsh') }; },
    async hostStatus() {
      return { treeProtocol: 1, reportProtocol: 1, methods: ['managedCreate', 'managedBeginTask', 'managedStatus', 'managedHistory', 'managedAnswer', 'managedCancel', 'managedDestroy'] };
    },
    async managedCreate(input) { dshCreated += 1; return { sessionId: input.sessionId, modelRequestsStarted: 0 }; },
    async managedBeginTask() { return { treeProtocol: 1, reportProtocol: 1, throughSeq: 0, currentModel: { provider: 'dsh', model: 'dsh-default' } }; },
    async managedStatus(input) {
      return { sessionId: input.sessionId, running: true, throughSeq: 0, questions: [], reports: [], changes: [],
        tree: { settled: false, running: true, nodes: [{ sessionId: input.sessionId, parentSessionId: null, name: 'root', status: 'running', activity: 'writing', changes: [] }] } };
    },
    async historyCursor() { return { throughSeq: 0 }; },
  };
  const service = createScopedAgents(config, {
    startSharedMonitor: async () => true,
    backendAdapters: mock.adapters,
    clientFactory: () => dshApi,
    controlFactory: () => ({
      async models() { return { default: { provider: 'dsh', model: 'dsh-default' }, routableProviders: ['dsh'], groups: [{ id: 'dsh', models: [{ id: 'dsh-default', reasoningEfforts: ['high', 'max'] }] }] }; },
      async selectModel() { return { accepted: true }; },
      async send() { return { accepted: true, afterSeq: 0 }; },
      async wait() { return { state: 'running', messages: [] }; },
    }),
  });
  t.after(() => service.close());

  const caller = agyExtra('conv-v21-main', repoDir);

  // 2a. Legacy no-role run() stays 100% compatible with dsh
  const legacyRun = await service.run({ message: 'legacy dsh task' }, caller);
  assert.equal('target' in legacyRun, false, 'legacy run without role keeps default dsh target');
  assert.equal(dshCreated, 1);
  assert.match(legacyRun.wakeCmd, /^futureaide-wait --conv "conv-v21-main" --keys "[^"]+"$/);

  // 2b. Minimal create({ role }) & run({ role, message }) auto-fill from 团队配置.md
  const secCreated = await service.create({ role: '秘书' }, caller);
  assert.equal(secCreated.name, '秘书1');
  assert.equal(secCreated.target, 'codex-cli');
  assert.equal(secCreated.lifetime, 'persistent');
  assert.equal(secCreated.actualModel, 'gpt-6.2-sol');
  assert.equal(secCreated.selectedEffort, 'high');

  const feRun = await service.run({ role: '前端', message: '搭建登录表单' }, caller);
  assert.equal(feRun.name, '前端1');
  assert.equal(feRun.target, 'claude-cli');
  assert.equal(feRun.lifetime, 'once');
  assert.equal(feRun.actualModel, 'claude-opus-5-5');
  assert.equal(feRun.selectedEffort, 'max');
  assert.equal(feRun.wakeCmd, `futureaide-wait --conv "conv-v21-main" --keys "${feRun.taskKey}"`);

  // Explicit overrides take precedence over role defaults
  const overrideRun = await service.run({
    role: '后端',
    model: 'gpt-6.2-sol',
    effort: 'xhigh',
    lifetime: 'persistent',
    worktree: true,
    message: '重写核心状态机',
  }, caller);
  assert.equal(overrideRun.name, '后端1');
  assert.equal(overrideRun.target, 'codex-cli');
  assert.equal(overrideRun.actualModel, 'gpt-6.2-sol');
  assert.equal(overrideRun.selectedEffort, 'xhigh');
  assert.equal(overrideRun.lifetime, 'persistent');
  assert.equal(overrideRun.workspaceMode, 'worktree');
  const w1Record = service.store.named(service.store.list()[0].ownerId, '后端1');
  assert.equal((await lstat(w1Record.worktreePath)).isDirectory(), true);

  // 2c. Batch run({ tasks: [...] }): sequential non-colliding numbering + concurrent dispatch + single wakeCmd
  const batchRes = await service.run({
    worktree: true,
    tasks: [
      { role: '后端', message: '并发子包A' },
      { role: '后端', message: '并发子包B', worktree: false },
      { role: '设计', message: '并发设计包C', worktree: false },
    ],
  }, caller);
  assert.equal(batchRes.batch, true);
  assert.equal(batchRes.items.length, 3);
  assert.deepEqual(batchRes.items.map(i => i.name), ['后端2', '后端3', '设计1']);
  assert.equal(batchRes.items[0].actualModel, 'gpt-6.1-terra');
  assert.equal(batchRes.items[0].workspaceMode, 'worktree');
  assert.equal(batchRes.items[1].workspaceMode, undefined, 'worktree: false overrides batch-level worktree: true');
  assert.equal(batchRes.items[2].target, 'claude-cli');
  assert.equal(batchRes.items[2].actualModel, 'claude-opus-5-5');
  assert.equal(batchRes.taskKeys.length, 3);
  assert.equal(
    batchRes.wakeCmd,
    `futureaide-wait --conv "conv-v21-main" --keys "${batchRes.taskKeys.join(',')}" --barrier all`,
  );
  assert.ok(mock.peakConcurrency() >= 2, `expected concurrent batch creation, got peak=${mock.peakConcurrency()}`);

  // 2d. disabledTargets: ['dsh'] routes omitted-role calls to codex-cli automatically
  const noDshSvc = createScopedAgents({ ...config, stateDirectory: path.join(dir, 'state-nodsh'), disabledTargets: ['dsh'] }, {
    startSharedMonitor: async () => true,
    backendAdapters: mock.adapters,
  });
  t.after(() => noDshSvc.close());
  const noRoleNoDsh = await noDshSvc.run({ message: 'dsh 已禁用时默认走无头 CLI' }, caller);
  assert.equal(noRoleNoDsh.target, 'codex-cli');
  assert.equal(noRoleNoDsh.actualModel, 'gpt-6.1-terra');
});

test('3. install-plugin generates zero-warning futureaide-wait.cmd & futureaide.cmd, and CLI wait outputs clean minimal JSON', async t => {
  const dir = await makeTempDir(t, 'cli-shims-');
  const workspace = path.join(dir, 'ws');
  const binDir = path.join(dir, 'bin');
  await mkdir(workspace, { recursive: true });

  // Verify installPlugin wires shims into binDir when src/cli.mjs exists
  const pkgRoot = path.join(dir, 'pkg');
  await mkdir(path.join(pkgRoot, '.codex-plugin'), { recursive: true });
  await writeFile(path.join(pkgRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'futureaide-control', version: '0.5.20', skills: './skills/', mcpServers: './.mcp.json',
  }), 'utf8');
  await mkdir(path.join(pkgRoot, 'src'), { recursive: true });
  await writeFile(path.join(pkgRoot, 'src', 'mcp-server.mjs'), '// fixture\n', 'utf8');
  await writeFile(path.join(pkgRoot, 'src', 'cli.mjs'), '// fixture\n', 'utf8');
  await mkdir(path.join(pkgRoot, 'skills', 'futureaide-control'), { recursive: true });
  await writeFile(path.join(pkgRoot, 'skills', 'futureaide-control', 'SKILL.md'), '# skill\n', 'utf8');

  const installRes = await installPlugin({
    sourceRoot: pkgRoot,
    codexHome: path.join(dir, 'codex'),
    dshHome: path.join(dir, 'dsh'),
    binDir: path.join(dir, 'pkg-bin'),
    skipClaude: true,
    skipAntigravity: true,
    skipHost: true,
    verifyRuntime: async () => {},
  });
  assert.equal(installRes.shims.registered, true);

  // Now generate shims pointing to the REAL pluginRoot + isolated test configFile and run them end-to-end!
  const configFile = path.join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify({ target: 'dsh', dataRoot: path.join(dir, 'dsh'), workspace }), 'utf8');
  const shimRes = await installCliShims({ sourceRoot: pluginRoot, configFile, binDir });
  assert.equal(shimRes.registered, true);

  const waitCmdPath = path.join(binDir, process.platform === 'win32' ? 'futureaide-wait.cmd' : 'futureaide-wait');
  const mainCmdPath = path.join(binDir, process.platform === 'win32' ? 'futureaide.cmd' : 'futureaide');
  const waitCmdContent = await readFile(waitCmdPath, 'utf8');
  const mainCmdContent = await readFile(mainCmdPath, 'utf8');
  assert.match(waitCmdContent, /--no-warnings/);
  assert.match(waitCmdContent, /FUTUREAIDE_CONFIG/);
  assert.match(mainCmdContent, /--no-warnings/);

  const config = await loadConfig(configFile);
  const mock = createMockCliAdapters();
  const service = createScopedAgents(config, {
    startSharedMonitor: async () => true,
    backendAdapters: mock.adapters,
  });
  t.after(() => service.close());

  const convId = 'conv-wait-e2e';
  const caller = agyExtra(convId, workspace);
  const batch = await service.run({
    tasks: [
      { role: '后端', message: '模块1' },
      { role: '后端', message: '模块2' },
    ],
  }, caller);
  const [a1, a2] = batch.items.map(it => service.store.list().find(r => r.name === it.name));
  await service.poll(a1.agentId);
  await service.poll(a2.agentId);
  const d1 = mock.dispatches.find(d => d.agentId === a1.agentId);
  const d2 = mock.dispatches.find(d => d.agentId === a2.agentId);

  const runWaitShim = (args, extraEnv = {}) => execFileAsync(waitCmdPath, args, {
    shell: process.platform === 'win32',
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });

  // Multi-key wait defaults to barrier='all': first finish alone does NOT wake; second finish wakes with both results!
  const waitBothProc = runWaitShim(['--conv', convId, '--keys', batch.taskKeys.join(','), '--timeout', '15']);
  await new Promise(r => setTimeout(r, 200));
  mock.liveStates.set(a1.agentId, { running: false });
  service.store.submitParentMessage(a1.agentId, { kind: 'report', message: '后端1完工', final: true }, {
    taskId: d1.taskId, requestId: d1.requestId, target: 'codex-cli',
  });
  await new Promise(r => setTimeout(r, 150));
  mock.liveStates.set(a2.agentId, { running: false });
  service.store.submitParentMessage(a2.agentId, { kind: 'report', message: '后端2完工', final: true }, {
    taskId: d2.taskId, requestId: d2.requestId, target: 'codex-cli',
  });

  const { stdout: bothOut, stderr: bothErr } = await waitBothProc;
  assert.equal(bothErr, '', 'futureaide-wait.cmd must emit zero ExperimentalWarning on stderr');
  const parsedBoth = JSON.parse(bothOut);
  assert.deepEqual(Object.keys(parsedBoth).sort(), ['done', 'results', 'timedOut']);
  assert.equal(parsedBoth.done, true);
  assert.equal(parsedBoth.timedOut, false);
  assert.equal(parsedBoth.results.length, 2);
  assert.deepEqual(parsedBoth.results.map(r => r.message).sort(), ['后端1完工', '后端2完工']);

  // Question wake via ANTIGRAVITY_CONVERSATION_ID env fallback + --names
  const qRun = await service.run({ role: '秘书', message: '核对排期' }, caller);
  const secRec = service.store.list().find(r => r.name === qRun.name);
  await service.poll(secRec.agentId);
  const secDisp = mock.dispatches.find(d => d.agentId === secRec.agentId);

  const waitEnvProc = runWaitShim(['--names', qRun.name, '--timeout', '15'], {
    ANTIGRAVITY_CONVERSATION_ID: convId,
  });
  await new Promise(r => setTimeout(r, 200));
  service.store.submitParentMessage(secRec.agentId, { kind: 'ask', message: '排期选周三还是周五？' }, {
    taskId: secDisp.taskId, requestId: secDisp.requestId, target: 'codex-cli',
  });
  const { stdout: qOut, stderr: qErr } = await waitEnvProc;
  assert.equal(qErr, '');
  const parsedQ = JSON.parse(qOut);
  assert.equal(parsedQ.done, false);
  assert.equal(parsedQ.timedOut, false);
  assert.equal(parsedQ.questions?.length, 1);
  assert.equal(parsedQ.questions[0].name, '秘书1');
  assert.equal(parsedQ.questions[0].message, '排期选周三还是周五？');
});

test('4. codex-cli & claude-cli runners fold lastStep (<=50 chars) + lastEventAt, and backends surface activity + 180s stalled warning', async t => {
  const dir = await makeTempDir(t, 'laststep-stalled-');

  // 4a. Codex CLI runner event folding + readCodexTurn
  const codexTurnDir = path.join(dir, 'codex-turn');
  const codexState = createCodexTurnState({ requestId: 'req-cx-1', sessionId: 'sess-cx-1', workspace: dir, message: 'go' });
  applyCodexLine(codexState, JSON.stringify({ type: 'thread.started', thread_id: 'th-1', model: 'gpt-6.1-terra' }));
  assert.equal(codexState.lastStep, '会话已启动');

  const longCmd = 'node --test tests/caller-ergonomics-v21.test.mjs tests/scoped-agents.test.mjs --test-reporter=spec';
  applyCodexLine(codexState, JSON.stringify({
    type: 'item.started',
    item: { id: 'c1', type: 'command_execution', command: longCmd, status: 'in_progress' },
  }));
  assert.ok(codexState.lastStep.startsWith('shell: node --test'));
  assert.ok(codexState.lastStep.length <= CODEX_MAX_STEP, `lastStep exceeded 50 chars: ${codexState.lastStep.length}`);

  applyCodexLine(codexState, JSON.stringify({
    type: 'item.started',
    item: { id: 'm1', type: 'mcp_tool_call', server: 'futureaide_report', tool: 'report_parent' },
  }));
  assert.equal(codexState.lastStep, 'mcp: report_parent');

  applyCodexLine(codexState, JSON.stringify({
    type: 'item.completed',
    item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/cli.mjs', kind: 'update' }] },
  }));
  assert.equal(codexState.lastStep, '改文件 cli.mjs');

  applyCodexLine(codexState, JSON.stringify({
    type: 'item.completed',
    item: { id: 'a1', type: 'agent_message', text: '正在汇总结果' },
  }));
  assert.equal(codexState.lastStep, '输出回复中');
  assert.ok(Date.parse(codexState.lastEventAt) > 0);

  await writeCodexJson(codexTurnDir, CODEX_TURN_FILES.turn, { requestId: 'req-cx-1', sessionId: 'sess-cx-1', workerPid: process.pid, startedAt: codexState.startedAt });
  await writeCodexJson(codexTurnDir, CODEX_TURN_FILES.state, { ...codexState, workerPid: process.pid });
  const readCx = await readCodexTurn(codexTurnDir, { isAlive: () => true });
  assert.equal(readCx.lastStep, '输出回复中');
  assert.equal(readCx.lastEventAt, codexState.lastEventAt);

  // 4b. Claude CLI runner event folding + readClaudeTurn
  const claudeTurnDir = path.join(dir, 'claude-turn');
  const sessionUuid = '11111111-2222-4333-8444-555555555555';
  const claudeState = createClaudeTurnState({ requestId: 'req-cl-1', sessionId: sessionUuid, workspace: dir, message: 'go' });
  applyClaudeLine(claudeState, JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionUuid, model: 'claude-opus-5-5', permissionMode: 'auto' }));
  assert.equal(claudeState.lastStep, '会话已启动');

  applyClaudeLine(claudeState, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: longCmd } }] },
  }));
  assert.ok(claudeState.lastStep.startsWith('shell: node --test'));
  assert.ok(claudeState.lastStep.length <= CLAUDE_MAX_STEP);

  applyClaudeLine(claudeState, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__futureaide__report_parent', input: { message: 'done', final: true } }] },
  }));
  assert.equal(claudeState.lastStep, 'mcp: report_parent');

  applyClaudeLine(claudeState, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu3', name: 'Edit', input: { file_path: 'd:/Work/src/app.tsx' } }] },
  }));
  assert.equal(claudeState.lastStep, '改文件 app.tsx');

  applyClaudeLine(claudeState, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '全部改完' }] },
  }));
  assert.equal(claudeState.lastStep, '输出回复中');

  await mkdir(claudeTurnDir, { recursive: true });
  await writeClaudeJson(claudeTurnDir, CLAUDE_TURN_FILES.turn, { requestId: 'req-cl-1', sessionId: sessionUuid, workerPid: process.pid, startedAt: claudeState.startedAt });
  await writeClaudeJson(claudeTurnDir, CLAUDE_TURN_FILES.state, { ...claudeState, workerPid: process.pid });
  const readCl = await readClaudeTurn(claudeTurnDir, { isAlive: () => true });
  assert.equal(readCl.lastStep, '输出回复中');
  assert.equal(readCl.lastEventAt, claudeState.lastEventAt);

  // 4c. Codex CLI & Claude CLI backends observe() 12s normal activity vs >=180s stalled warning
  const baseMs = Date.parse('2026-11-28T04:00:00.000Z');
  let clockMs = baseMs + 12_000;
  let turnSnapshot = {
    state: 'running',
    sessionStarted: true,
    model: 'gpt-6.1-terra',
    lastStep: 'shell: node --test',
    lastEventAt: new Date(baseMs).toISOString(),
    startedAt: new Date(baseMs).toISOString(),
    messages: [],
  };

  let savedCxState = {
    seq: 0,
    active: 'req-1',
    requests: { 'req-1': { status: 'accepted', taskId: 'task-1', afterSeq: 0 } },
    answers: {},
    answered: [],
  };
  const cxRecord = { agentId: 'agent-cx', ownerId: 'owner-1', name: '后端1', sessionId: 'sess-cx', workspace: dir, target: 'codex-cli', created: true, task: { taskId: 'task-1' } };
  const cxBackend = createCodexCliBackend(cxRecord, {
    load: () => cxRecord,
    now: () => clockMs,
    requestDirectory: () => dir,
    readNativeState: () => savedCxState,
    writeNativeState: v => { savedCxState = structuredClone(v); return true; },
    readParentSubmissions: async () => ({ questions: [], reports: [] }),
    codexCliReportConfig: () => ({ command: process.execPath, args: [] }),
    runner: {
      probeCodexCli: async () => ({ ok: true, cli: 'codex.exe' }),
      readCodexTurn: async () => turnSnapshot,
      cancelCodexTurn: async () => ({ stopped: true }),
    },
  });

  const cxActive12s = await cxBackend.observe();
  assert.equal(cxActive12s.stalled, false);
  assert.equal(cxActive12s.activity, '12s前 · shell: node --test');
  assert.equal(cxActive12s.tree.nodes[0].activity, '12s前 · shell: node --test');
  assert.equal(cxActive12s.tree.nodes[0].stalled, undefined);

  clockMs = baseMs + 185_000;
  const cxStalled185s = await cxBackend.observe();
  assert.equal(cxStalled185s.stalled, true);
  assert.equal(cxStalled185s.activity, '⚠ 已静默 185s · shell: node --test');
  assert.equal(cxStalled185s.tree.nodes[0].stalled, true);
  assert.equal(cxStalled185s.tree.nodes[0].activity, '⚠ 已静默 185s · shell: node --test');

  // Same verification for Claude CLI backend
  let savedClState = {
    seq: 0,
    active: 'req-1',
    requests: { 'req-1': { status: 'accepted', taskId: 'task-1', afterSeq: 0 } },
    answers: {},
    answered: [],
  };
  const clRecord = { agentId: 'agent-cl', ownerId: 'owner-1', name: '前端1', sessionId: 'sess-cl', workspace: dir, target: 'claude-cli', created: true, task: { taskId: 'task-1' } };
  const clBackend = createClaudeCliBackend(clRecord, {
    load: () => clRecord,
    now: () => clockMs,
    requestDirectory: () => dir,
    readNativeState: () => savedClState,
    writeNativeState: v => { savedClState = structuredClone(v); return true; },
    readParentSubmissions: async () => ({ questions: [], reports: [] }),
    claudeReportConfig: () => ({ mcpServers: { futureaide: { command: process.execPath, args: [] } } }),
    runner: {
      probeClaudeCli: async () => ({ cli: 'claude.exe', auth: { loggedIn: true } }),
      readClaudeTurn: async () => ({ ...turnSnapshot, model: 'claude-opus-5-5', businessAccepted: true }),
      cancelClaudeTurn: async () => ({ stopped: true }),
    },
  });

  clockMs = baseMs + 12_000;
  const clActive12s = await clBackend.observe();
  assert.equal(clActive12s.stalled, false);
  assert.equal(clActive12s.activity, '12s前 · shell: node --test');

  clockMs = baseMs + 180_000;
  const clStalled180s = await clBackend.observe();
  assert.equal(clStalled180s.stalled, true);
  assert.equal(clStalled180s.activity, '⚠ 已静默 180s · shell: node --test');

  // Also verify scoped-agents list() surfaces stalled: true and warning activity when running
  const cfgFile = path.join(dir, 'svc-cfg.json');
  await writeFile(cfgFile, JSON.stringify({ target: 'dsh', dataRoot: path.join(dir, 'dsh'), workspace: dir }), 'utf8');
  const mock = createMockCliAdapters();
  const svc = createScopedAgents(await loadConfig(cfgFile), {
    startSharedMonitor: async () => true,
    backendAdapters: mock.adapters,
  });
  t.after(() => svc.close());
  const caller = agyExtra('conv-stalled-list', dir);
  await svc.run({ role: '后端', message: '长耗时任务' }, caller);
  const agent = svc.store.list()[0];
  mock.liveStates.set(agent.agentId, { running: true, stalled: true, activity: '⚠ 已静默 185s · shell: node --test' });
  await svc.poll(agent.agentId);
  const listed = await svc.list(caller, { scope: 'team' });
  assert.equal(listed.items[0].stalled, true);
  assert.equal(listed.items[0].activity, '⚠ 已静默 185s · shell: node --test');
});
