import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { makeScopedServer } from '../src/mcp-server.mjs';
import { TRUSTED_CALLER } from '../src/calling-context.mjs';
import { compactAgent, compactCreate, compactList, compactWait } from '../src/tool-view.mjs';
import { startAntigravityCallerBridge } from '../src/antigravity-caller-bootstrap.mjs';
import { startHttpService } from '../src/claude-report-server.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withTempDir(t, prefix = 'boss-three-scopes-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });
  return dir;
}

async function connectMcp(service, { env } = {}) {
  const server = makeScopedServer({
    configPath: path.join(pluginRoot, 'clean', 'scoped-mcp-config-absent.json'),
    scopedFactory: () => service,
    ...(env ? { env } : {}),
  });
  const client = new Client({ name: 'lane-c-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// 1. MCP 工具参数升级：role 自动编号、workspace_mode、proxy、list 三档、barrier、黑板与受管 CLI 身份
// ---------------------------------------------------------------------------

test('MCP create/run/list/wait/board/cli_proxy forward new contracts and validate name-or-role', async (t) => {
  const calls = [];
  let roleSeq = 0;

  const mockService = {
    async resume() {},
    async create(args, extra) {
      calls.push({ op: 'create', args, caller: extra[TRUSTED_CALLER] });
      const resolvedName = args.name ?? `${args.role}${++roleSeq}`;
      return {
        created: true,
        name: resolvedName,
        role: args.role,
        lifetime: args.lifetime,
        state: 'idle',
        target: args.target ?? 'codex-cli',
        actualModel: 'gpt-6.2-sol',
        requestedEffort: 'high',
        selectedEffort: 'high',
        effortSource: 'explicit',
        actualEffort: 'high',
        actualEffortSource: 'turn',
        effortAdjustment: 'exact',
        modelLocked: false,
      };
    },
    async run(args, extra) {
      calls.push({ op: 'run', args, caller: extra[TRUSTED_CALLER] });
      const resolvedName = args.name ?? `${args.role}${++roleSeq}`;
      return {
        created: true,
        accepted: true,
        name: resolvedName,
        role: args.role,
        state: 'running',
        taskKey: `tk-${resolvedName}`,
      };
    },
    async list(_extra, opts) {
      calls.push({ op: 'list', opts });
      if (opts.scope === 'agent') {
        return {
          scope: 'agent',
          agent: {
            name: opts.name ?? '后端1',
            role: '后端',
            target: 'codex-cli',
            state: 'awaiting_input',
            lifetime: 'once',
            actualModel: 'gpt-6.2-sol',
            actualEffort: 'high',
            requestedEffort: 'high',
            effortSource: 'default',
            agentPath: ['团队长1', '后端1'],
            parentName: '团队长1',
            task: { text: '实现数据库迁移与索引优化' },
            questions: [{ id: 'q-1', state: 'pending', message: '迁移脚本是否需要兼容旧字段？' }],
            reports: { latest: { summary: '已完成初版建表语句', final: false, delivery: 'pull_ready' } },
            changes: { count: 1, files: [{ path: 'src/db.mjs', operation: 'update', agentPath: ['团队长1', '后端1'] }] },
          },
        };
      }
      if (opts.scope === 'all') {
        return {
          scope: 'all',
          teams: [
            {
              ownerId: 'owner-agy-1',
              source: 'antigravity',
              workspace: 'D:\\Work\\demo-workspace',
              hasHierarchy: true,
              items: [
                {
                  name: '团队长1',
                  role: '团队长',
                  target: 'codex-cli',
                  state: 'running',
                  lifetime: 'once',
                  tree: {
                    nodes: [
                      { name: '团队长1', depth: 0, status: 'running' },
                      { name: '后端1', role: '后端', agentPath: ['团队长1', '后端1'], depth: 1, status: 'running', activity: '写 SQL', changes: [{ path: 'a.mjs' }] },
                    ],
                  },
                },
              ],
            },
            {
              ownerId: 'owner-codex-2',
              source: 'codex-desktop',
              workspace: 'D:\\OtherProject',
              hasHierarchy: false,
              items: [
                { name: '调查员1', role: '调查员', target: 'claude-cli', state: 'idle', lifetime: 'once' },
              ],
            },
          ],
        };
      }
      return {
        scope: opts.scope ?? 'team',
        items: [
          {
            name: '后端1',
            role: '后端',
            target: 'codex-cli',
            state: 'running',
            lifetime: 'once',
            requestedEffort: 'max',
            selectedEffort: 'high',
            actualEffort: 'high',
          },
          {
            name: '前端1',
            role: '前端',
            target: 'claude-cli',
            state: 'running',
            lifetime: 'once',
          },
        ],
      };
    },
    async wait(opts) {
      calls.push({ op: 'wait', opts });
      return {
        reason: 'event',
        timedOut: false,
        nextCursor: 'cur-1',
        items: [{ name: '后端1', role: '后端', state: 'awaiting_input', lifetime: 'once' }],
        notListed: [],
        events: [
          {
            id: 'ev-1',
            taskKey: 'tk-后端1',
            name: '后端1',
            type: 'question',
            message: '接口超时定 5s 还是 10s？',
          },
        ],
      };
    },
    async postBoard(payload) {
      calls.push({ op: 'postBoard', payload });
      return { posted: true, seq: 1, mentions: ['团队长1/后端2'], woken: ['后端2'] };
    },
    async readBoard(payload) {
      calls.push({ op: 'readBoard', payload });
      return {
        messages: [
          { seq: 1, author: 'Boss', text: '@团队长1/后端2 请确认分页上限', mentions: ['团队长1/后端2'] },
        ],
      };
    },
    async manageCliProxy(payload) {
      calls.push({ op: 'manageCliProxy', payload });
      return { ok: true, ...payload };
    },
  };

  const mcp = await connectMcp(mockService);
  t.after(() => mcp.close());

  // 1) create/run 既不传 name 也不传 role 时报错提示至少传其一
  const badCreate = await mcp.client.callTool({
    name: 'futureaide_create_agent',
    arguments: { lifetime: 'once', target: 'codex-cli' },
  });
  assert.equal(badCreate.isError, true);
  assert.equal(JSON.parse(badCreate.content[0].text).error.code, 'invalid-arguments');

  const badRun = await mcp.client.callTool({
    name: 'futureaide_run_agent',
    arguments: { message: '干活' },
  });
  assert.equal(badRun.isError, true);
  assert.equal(JSON.parse(badRun.content[0].text).error.code, 'invalid-arguments');

  // 2) 传 role 省略 name 自动生成 后端1、后端2，透传 worktree 与 proxy，并砍掉冗余 effort 字段
  const c1 = await mcp.client.callTool({
    name: 'futureaide_create_agent',
    arguments: { role: '后端', lifetime: 'once', target: 'codex-cli', worktree: true, proxy: 7890 },
  });
  assert.notEqual(c1.isError, true);
  const c1Body = JSON.parse(c1.content[0].text);
  assert.equal(c1Body.name, '后端1');
  assert.equal(c1Body.role, '后端');
  assert.equal(c1Body.actualEffort, 'high');
  for (const noisy of ['requestedEffort', 'effortSource', 'selectedEffort', 'actualEffortSource', 'effortAdjustment', 'modelLocked']) {
    assert.equal(noisy in c1Body, false, `${noisy} must be stripped from default compact view`);
  }
  assert.deepEqual(calls[0].args, {
    role: '后端',
    lifetime: 'once',
    target: 'codex-cli',
    worktree: true,
    workspaceMode: 'worktree',
    proxy: 7890,
  });

  const r2 = await mcp.client.callTool({
    name: 'futureaide_run_agent',
    arguments: { role: '后端', message: '补齐迁移测试', worktree: false, proxy: 'faswitch' },
  });
  assert.notEqual(r2.isError, true);
  const r2Body = JSON.parse(r2.content[0].text);
  assert.equal(r2Body.name, '后端2');
  assert.equal(r2Body.taskKey, 'tk-后端2');
  assert.equal(calls[1].args.worktree, false);
  assert.equal(calls[1].args.workspaceMode, 'inherit');
  assert.equal(calls[1].args.proxy, 'faswitch');

  // 3) list 三级视角：team (带 role 过滤) / agent / all
  const teamFiltered = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_list_agents',
    arguments: { scope: 'team', role: '后端' },
  })).content[0].text);
  assert.equal(teamFiltered.scope, 'team');
  assert.equal(teamFiltered.role, '后端');
  assert.equal(teamFiltered.items.length, 1);
  assert.equal(teamFiltered.items[0].name, '后端1');
  assert.equal('requestedEffort' in teamFiltered.items[0], false);

  const agentDetail = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_list_agents',
    arguments: { scope: 'agent', name: '团队长1/后端1' },
  })).content[0].text);
  assert.equal(agentDetail.scope, 'agent');
  assert.equal(agentDetail.agent.path, '团队长1/后端1');
  assert.equal(agentDetail.agent.parent, '团队长1');
  assert.equal(agentDetail.agent.questions[0].message, '迁移脚本是否需要兼容旧字段？');
  assert.equal(agentDetail.agent.changes.files[0].path, 'src/db.mjs');

  const allOverview = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_list_agents',
    arguments: { scope: 'all' },
  })).content[0].text);
  assert.equal(allOverview.scope, 'all');
  assert.equal(allOverview.totalTeams, 2);
  assert.equal(allOverview.teams[0].source, 'antigravity');
  assert.equal(allOverview.teams[0].hasHierarchy, true);
  assert.deepEqual(allOverview.teams[0].items[0].team, [
    { path: '后端1', role: '后端', state: 'running', activity: '写 SQL', files: 1 },
  ]);
  assert.equal(allOverview.teams[1].hasHierarchy, false);

  // 4) wait barrier 透传与内联 message 正文原样保留
  const waitRes = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_wait_agents',
    arguments: { taskKeys: ['tk-后端1'], barrier: 'all' },
  })).content[0].text);
  assert.equal(calls.find(c => c.op === 'wait').opts.barrier, 'all');
  assert.equal(waitRes.events[0].message, '接口超时定 5s 还是 10s？');

  // 5) 团队会议室黑板 post / read
  const posted = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_board_post',
    arguments: { message: '@团队长1/后端2 请确认分页上限' },
  })).content[0].text);
  assert.equal(posted.posted, true);

  const boardRead = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_board_read',
    arguments: { limit: 15, after_seq: 0 },
  })).content[0].text);
  assert.equal(boardRead.messages[0].text, '@团队长1/后端2 请确认分页上限');
  assert.deepEqual(calls.find(c => c.op === 'readBoard').payload, { limit: 15, afterSeq: 0 });

  // 6) CLI 代理绑定工具 futureaide_cli_proxy
  const proxyStatus = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_cli_proxy',
    arguments: {},
  })).content[0].text);
  assert.deepEqual(proxyStatus, { ok: true, action: 'status', target: 'all' });

  const proxyBind = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_cli_proxy',
    arguments: { action: 'bind', target: 'codex-cli', proxy: 17913 },
  })).content[0].text);
  assert.deepEqual(proxyBind, { ok: true, action: 'bind', target: 'codex-cli', proxy: 17913 });
});

test('FUTUREAIDE_MANAGED_CLI=1 injects TRUSTED_CALLER and omits duplicate ask_parent/report_parent', async (t) => {
  let capturedCaller = null;
  const mockService = {
    async resume() {},
    async run(args, extra) {
      capturedCaller = extra[TRUSTED_CALLER];
      return { created: true, accepted: true, name: args.name ?? '后端1', state: 'running' };
    },
  };

  const mcp = await connectMcp(mockService, {
    env: {
      FUTUREAIDE_MANAGED_CLI: '1',
      FUTUREAIDE_PARENT_AGENT_ID: 'agent-lead-001',
      FUTUREAIDE_CALLER_OWNER_ID: 'owner-root-boss',
      FUTUREAIDE_CALLER_WORKSPACE: 'D:\\Work\\demo-workspace',
    },
  });
  t.after(() => mcp.close());

  const { tools } = await mcp.client.listTools();
  const names = tools.map(item => item.name);
  assert.equal(names.includes('ask_parent'), false, 'ask_parent must not be registered on managed-cli server');
  assert.equal(names.includes('report_parent'), false, 'report_parent must not be registered on managed-cli server');
  assert.equal(names.includes('futureaide_run_agent'), true);
  assert.equal(names.includes('futureaide_board_post'), true);

  const ran = await mcp.client.callTool({
    name: 'futureaide_run_agent',
    arguments: { role: '后端', message: '处理子任务' },
  });
  assert.notEqual(ran.isError, true);
  assert.deepEqual(capturedCaller, {
    source: 'managed-cli',
    nativeSessionId: 'agent-lead-001',
    parentAgentId: 'agent-lead-001',
    ownerId: 'owner-root-boss',
    workspace: 'D:\\Work\\demo-workspace',
  });
});

// ---------------------------------------------------------------------------
// 2. tool-view 独立单元测试：6 冗余字段剔除、三档格式化与内联 wait 正文兜底
// ---------------------------------------------------------------------------

test('tool-view strips 6 noisy effort fields and formats flat all-scope items by caller', () => {
  const noisyEntry = {
    name: '后端1',
    role: '后端',
    target: 'codex-cli',
    state: 'running',
    lifetime: 'once',
    actualModel: 'gpt-6.2-sol',
    requestedEffort: 'max',
    effortSource: 'explicit',
    selectedEffort: 'high',
    actualEffort: 'high',
    actualEffortSource: 'turn-confirmed',
    effortAdjustment: 'clamped',
    modelLocked: true,
    ownerId: 'owner-1',
    source: 'antigravity',
    workspace: 'D:\\RepoA',
    agentPath: ['团队长1', '后端1'],
  };

  const single = compactAgent(noisyEntry);
  assert.equal(single.role, '后端');
  assert.equal(single.path, '团队长1/后端1');
  assert.equal(single.actualEffort, 'high');
  for (const field of ['requestedEffort', 'effortSource', 'selectedEffort', 'actualEffortSource', 'effortAdjustment', 'modelLocked']) {
    assert.equal(field in single, false);
    assert.equal(field in compactCreate({ ...noisyEntry, created: true }), false);
  }

  const grouped = compactList({ items: [noisyEntry] }, { scope: 'all' });
  assert.equal(grouped.scope, 'all');
  assert.equal(grouped.teams.length, 1);
  assert.equal(grouped.teams[0].ownerId, 'owner-1');
  assert.equal(grouped.teams[0].hasHierarchy, true);

  const waited = compactWait({
    items: [],
    notListed: [],
    events: [{ id: 'e1', type: 'final', name: '后端1', body: { text: '全部接口已联调通过' } }],
  });
  assert.equal(waited.events[0].message, '全部接口已联调通过');
});

// ---------------------------------------------------------------------------
// 3. antigravity-caller-bootstrap 动态刷新 tools/list 与断连缓存回退
// ---------------------------------------------------------------------------

test('antigravity-caller-bootstrap dynamically refreshes tools/list and falls back to last cached schema on error', async (t) => {
  const dir = await withTempDir(t, 'agy-dyn-schema-');
  const tokenFile = path.join(dir, 'antigravity-caller.json');
  let exposeNewTools = false;
  let forceOffline = false;

  const remoteService = await startHttpService({
    port: 0,
    antigravityCallerTokenFile: tokenFile,
    resolveCaller: async () => { throw Object.assign(new Error('not claude'), { code: 'caller-unresolved' }); },
    management: ({ server }) => {
      server.registerTool('futureaide_status', { description: 'Status v1', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: '{"ok":true}' }],
      }));
      if (exposeNewTools) {
        server.registerTool('futureaide_board_post', { description: 'Post to team board', inputSchema: {} }, async () => ({
          content: [{ type: 'text', text: '{"posted":true}' }],
        }));
      }
    },
  });
  t.after(() => remoteService.close());

  const bridge = await startAntigravityCallerBridge({
    port: remoteService.port,
    tokenFile,
    coldStartMonitor: false,
    env: { ANTIGRAVITY_CONVERSATION_ID: 'conv-schema-refresh', ANTIGRAVITY_WORKSPACE: dir },
    request: async (opts) => {
      if (forceOffline) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      const { postLoopbackJsonRpc } = await import('../src/antigravity-caller-bootstrap.mjs');
      return postLoopbackJsonRpc(opts);
    },
    log: () => {},
  });
  t.after(() => bridge.close());

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'agy-schema-client', version: '1.0.0' });
  await bridge.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());

  // 初始只有 1 个工具
  const firstList = await client.listTools();
  assert.deepEqual(firstList.tools.map(x => x.name), ['futureaide_status']);

  // 远端升级暴露新工具后，无需重启 bridge，再次 listTools 动态拿到新 schema
  exposeNewTools = true;
  const secondList = await client.listTools();
  assert.deepEqual(secondList.tools.map(x => x.name), ['futureaide_status', 'futureaide_board_post']);

  // 远端瞬时不可达时，回退上次成功缓存的 2 个工具而非空列表
  forceOffline = true;
  const fallbackList = await client.listTools();
  assert.deepEqual(fallbackList.tools.map(x => x.name), ['futureaide_status', 'futureaide_board_post']);
});

