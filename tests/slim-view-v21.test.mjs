import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { makeScopedServer } from '../src/mcp-server.mjs';
import {
  compactAnswer,
  compactBoardPost,
  compactList,
  compactRun,
  compactSend,
  compactTeamManage,
  compactWait,
} from '../src/tool-view.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function connectMcp(service) {
  const server = makeScopedServer({
    configPath: path.join(pluginRoot, 'clean', 'scoped-mcp-config-absent.json'),
    scopedFactory: () => service,
  });
  const client = new Client({ name: 'slim-v21-test', version: '1.0.0' });
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

test('compactRun slims single and batch receipts down to golden fields while preserving errors', () => {
  const rawSingle = {
    name: '后端1',
    role: '后端',
    lifetime: 'once',
    created: true,
    accepted: false,
    queued: true,
    state: 'running',
    target: 'codex-cli',
    requestId: 'req-123456',
    mode: 'queue',
    delivery: 'local-pending',
    actualModel: 'gpt-6.1-terra',
    requestedEffort: 'high',
    effortSource: 'role-default',
    selectedEffort: 'high',
    actualEffort: null,
    actualEffortSource: null,
    taskKey: 'tk-be-1',
    wakeCmd: 'futureaide-wait --conv c1 --keys tk-be-1',
    worktreePath: 'D:\\Repo\\.work\\worktrees\\后端1-abcd1234',
  };

  const single = compactRun(rawSingle);
  assert.deepEqual(single, {
    name: '后端1',
    role: '后端',
    spec: 'codex-cli · gpt-6.1-terra (high)',
    taskKey: 'tk-be-1',
    wakeCmd: 'futureaide-wait --conv c1 --keys tk-be-1',
    worktreePath: 'D:\\Repo\\.work\\worktrees\\后端1-abcd1234',
  });
  for (const dropped of [
    'accepted', 'queued', 'requestId', 'mode', 'delivery',
    'requestedEffort', 'effortSource', 'selectedEffort', 'actualEffortSource',
    'lifetime', 'created', 'state', 'actualModel', 'actualEffort', 'target',
  ]) {
    assert.equal(dropped in single, false, `${dropped} must be stripped from compactRun`);
  }

  const batch = compactRun({
    batch: true,
    items: [
      rawSingle,
      {
        ...rawSingle,
        name: '后端2',
        taskKey: 'tk-be-2',
        worktreePath: undefined,
      },
    ],
    wakeCmd: 'futureaide-wait --conv c1 --keys tk-be-1,tk-be-2 --barrier all',
    errors: [{ name: '后端3', code: 'git-worktree-failed' }],
  });
  assert.deepEqual(batch, {
    agents: [
      {
        name: '后端1',
        role: '后端',
        spec: 'codex-cli · gpt-6.1-terra (high)',
        taskKey: 'tk-be-1',
        worktreePath: 'D:\\Repo\\.work\\worktrees\\后端1-abcd1234',
      },
      {
        name: '后端2',
        role: '后端',
        spec: 'codex-cli · gpt-6.1-terra (high)',
        taskKey: 'tk-be-2',
      },
    ],
    wakeCmd: 'futureaide-wait --conv c1 --keys tk-be-1,tk-be-2 --barrier all',
    errors: [{ name: '后端3', code: 'git-worktree-failed' }],
  });
});

test('compactSend, compactAnswer, and compactBoardPost keep only core confirmation fields', () => {
  assert.deepEqual(compactSend({
    name: '后端1',
    role: '后端',
    state: 'running',
    accepted: false,
    queued: true,
    requestId: 'req-99',
    mode: 'queue',
    delivery: 'after-current',
    afterTurnId: 'turn-1',
    target: 'codex-cli',
    actualModel: 'gpt-6.1-terra',
    selectedEffort: 'high',
    requestedEffort: 'high',
    effortSource: 'pin',
    taskKey: 'tk-2',
    wakeCmd: 'futureaide-wait --keys tk-2',
  }), {
    name: '后端1',
    role: '后端',
    spec: 'codex-cli · gpt-6.1-terra (high)',
    state: 'running',
    delivery: 'after-current',
    taskKey: 'tk-2',
    wakeCmd: 'futureaide-wait --keys tk-2',
  });

  assert.deepEqual(compactAnswer({
    name: '后端1',
    answered: true,
    delivered: true,
    state: 'running',
    requestId: 'ans-1',
    mode: 'steer',
    taskKey: 'tk-ans-1',
  }), {
    name: '后端1',
    answered: true,
    delivered: true,
    state: 'running',
    taskKey: 'tk-ans-1',
  });

  assert.deepEqual(compactBoardPost({
    posted: true,
    message: { seq: 7, rootOwnerId: 'owner-1', author: 'Boss', text: '@后端1 @团队长1/后端2 核对接口' },
    mentions: ['后端1', '团队长1/后端2'],
    routed: [
      { mention: '后端1', name: '后端1', action: 'woken', taskKey: 'tk-1' },
      { mention: '团队长1/后端2', name: '后端2', agentPath: '团队长1/后端2', action: 'revived' },
      { mention: '不存在', action: 'not-found' },
    ],
  }), {
    posted: true,
    seq: 7,
    mentions: ['后端1', '团队长1/后端2'],
    woken: ['后端1', '后端2'],
  });
});

test('compactWait slims streaming events and omits settled items/empty notListed while preserving snapshot waits', () => {
  const streamed = compactWait({
    reason: 'event',
    timedOut: false,
    nextCursor: 'cursor-xyz',
    notListed: [],
    items: [
      {
        name: '后端1',
        role: '后端',
        state: 'running',
        lifetime: 'once',
        task: { text: '写接口' },
        reports: { total: 1, pending: 0, latest: { final: true, delivery: 'delivered' } },
      },
    ],
    events: [
      {
        id: 'tk-be-1:submission:sub-999',
        taskKey: 'tk-be-1',
        name: '后端1',
        role: '后端',
        type: 'final',
        message: '结论：通过\n验证：全绿',
        delivery: 'delivered',
        final: true,
        createdAt: '2026-11-28T00:00:00Z',
        body: { tool: 'futureaide_read_report', taskKey: 'tk-be-1', submissionId: 'sub-999', pages: 1 },
      },
    ],
  });

  assert.deepEqual(streamed, {
    events: [
      {
        name: '后端1',
        role: '后端',
        type: 'final',
        message: '结论：通过\n验证：全绿',
      },
    ],
    timedOut: false,
    nextCursor: 'cursor-xyz',
  });

  // Timeout while still running with no final/question keeps slimmed items
  const runningTimeout = compactWait({
    timedOut: true,
    nextCursor: 'cursor-t',
    notListed: [],
    items: [
      { name: '后端1', role: '后端', state: 'running', activity: 'running', lastStep: '8s前 · shell:node --test', stalled: true },
    ],
    events: [],
  });
  assert.equal(runningTimeout.timedOut, true);
  assert.equal('notListed' in runningTimeout, false);
  assert.equal(runningTimeout.items.length, 1);
  assert.equal(runningTimeout.items[0].activity, '8s前 · shell:node --test');
  assert.equal(runningTimeout.items[0].stalled, true);

  // Snapshot wait without events preserves legacy structure
  const snapshot = compactWait({ items: [], notListed: [] });
  assert.deepEqual(snapshot, { items: [], notListed: [], timedOut: false });
});

test('compactList strips inputDelivery and meaningless "running" activity while surfacing real steps and stalled', () => {
  const list = compactList({
    scope: 'team',
    items: [
      {
        name: '团队长1',
        role: '团队长',
        target: 'codex-cli',
        state: 'running',
        inputDelivery: 'new-turn',
        activity: 'running',
        tree: {
          nodes: [
            { name: '团队长1', depth: 0, status: 'running', activity: 'running' },
            { name: '后端1', role: '后端', agentPath: ['团队长1', '后端1'], depth: 1, status: 'running', activity: 'running', stalled: true },
            { name: '后端2', role: '后端', agentPath: ['团队长1', '后端2'], depth: 1, status: 'running', activity: '12s前 · shell:npm test' },
          ],
        },
      },
      {
        name: '调查员1',
        role: '调查员',
        target: 'codex-cli',
        state: 'running',
        inputDelivery: 'current-turn',
        activity: 'running',
        lastStep: '5s前 · grep scoped-agents.mjs',
        stalled: true,
      },
    ],
  });

  const [lead, researcher] = list.items;
  assert.equal('inputDelivery' in lead, false);
  assert.equal('activity' in lead, false, 'tautological activity:"running" must be stripped');
  assert.deepEqual(lead.team, [
    { path: '后端1', role: '后端', state: 'running', stalled: true },
    { path: '后端2', role: '后端', state: 'running', activity: '12s前 · shell:npm test' },
  ]);

  assert.equal('inputDelivery' in researcher, false);
  assert.equal(researcher.activity, '5s前 · grep scoped-agents.mjs');
  assert.equal(researcher.stalled, true);
});

test('MCP server supports batch tasks, worktree boolean, slim views with detail:true, and trimmed DSH-free descriptions', async (t) => {
  const recorded = [];
  const mockService = {
    async resume() {},
    async run(args) {
      recorded.push({ op: 'run', args });
      if (Array.isArray(args.tasks)) {
        return {
          batch: true,
          items: args.tasks.map((item, idx) => ({
            name: item.name ?? `${item.role}${idx + 1}`,
            role: item.role,
            target: item.target ?? 'codex-cli',
            actualModel: 'gpt-6.1-terra',
            selectedEffort: 'high',
            accepted: false,
            queued: true,
            requestId: `req-${idx + 1}`,
            taskKey: `tk-${idx + 1}`,
            ...(item.worktree ? { worktreePath: `D:\\wt\\${idx + 1}` } : {}),
          })),
          wakeCmd: 'futureaide-wait --keys tk-1,tk-2 --barrier all',
        };
      }
      return {
        name: args.name ?? '后端1',
        role: args.role,
        target: 'codex-cli',
        actualModel: 'gpt-6.1-terra',
        selectedEffort: 'high',
        accepted: false,
        queued: true,
        requestId: 'req-single',
        taskKey: 'tk-single',
        wakeCmd: 'futureaide-wait --keys tk-single',
        ...(args.worktree ? { worktreePath: 'D:\\wt\\single' } : {}),
      };
    },
    async send(args) {
      recorded.push({ op: 'send', args });
      return {
        name: args.name,
        state: 'running',
        accepted: false,
        queued: true,
        requestId: 'req-send',
        delivery: 'local-pending',
        taskKey: 'tk-send',
      };
    },
    async answer(args) {
      recorded.push({ op: 'answer', args });
      return {
        name: args.name,
        answered: true,
        delivered: true,
        state: 'running',
        requestId: 'req-ans',
        taskKey: 'tk-ans',
      };
    },
    async postBoard(args) {
      recorded.push({ op: 'postBoard', args });
      return {
        posted: true,
        message: { seq: 3, text: args.message },
        mentions: ['后端1'],
        routed: [{ mention: '后端1', name: '后端1', action: 'woken' }],
      };
    },
  };

  const mcp = await connectMcp(mockService);
  t.after(() => mcp.close());

  const { tools } = await mcp.client.listTools();
  for (const tool of tools) {
    const fields = Object.keys(tool.inputSchema.properties ?? {});
    const callerFields = fields.filter(field => tool.name !== 'futureaide_answer_agent' || field !== 'question_id');
    assert.ok(!callerFields.some(f => /id$|workspace|profile|callback|address/.test(f)), `${tool.name} has forbidden schema field: ${callerFields}`);
    if (tool.name.startsWith('futureaide_')) {
      assert.doesNotMatch(tool.description, /\bDSH\b|\bdsh\b/, `${tool.name} description must not contain obsolete DSH prose`);
      assert.ok(tool.description.length <= 500, `${tool.name} description should be concise (got ${tool.description.length} chars)`);
    }
  }

  // Batch tasks dispatch without top-level message/name/role
  const batchRes = await mcp.client.callTool({
    name: 'futureaide_run_agent',
    arguments: {
      tasks: [
        { role: '后端', message: '实现模块 A' },
        { role: '后端', message: '实现模块 B', worktree: true },
      ],
    },
  });
  assert.notEqual(batchRes.isError, true);
  assert.deepEqual(JSON.parse(batchRes.content[0].text), {
    agents: [
      { name: '后端1', role: '后端', spec: 'codex-cli · gpt-6.1-terra (high)', taskKey: 'tk-1' },
      { name: '后端2', role: '后端', spec: 'codex-cli · gpt-6.1-terra (high)', taskKey: 'tk-2', worktreePath: 'D:\\wt\\2' },
    ],
    wakeCmd: 'futureaide-wait --keys tk-1,tk-2 --barrier all',
  });
  assert.equal(recorded[0].args.tasks[1].worktree, true);
  assert.equal(recorded[0].args.tasks[1].workspaceMode, 'worktree');

  // Single run with detail: true returns raw receipt
  const detailRun = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_run_agent',
    arguments: { role: '后端', message: '查日志', worktree: true, detail: true },
  })).content[0].text);
  assert.equal(detailRun.requestId, 'req-single');

  // Slim send, answer, and board_post views
  const sent = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_send_agent',
    arguments: { name: '后端1', message: '补充边界检查' },
  })).content[0].text);
  assert.deepEqual(sent, { name: '后端1', state: 'running', taskKey: 'tk-send' });

  const answered = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_answer_agent',
    arguments: { name: '后端1', message: '采用方案 A' },
  })).content[0].text);
  assert.deepEqual(answered, { name: '后端1', answered: true, delivered: true, state: 'running', taskKey: 'tk-ans' });

  const board = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_board_post',
    arguments: { message: '@后端1 请确认重试次数' },
  })).content[0].text);
  assert.deepEqual(board, { posted: true, seq: 3, mentions: ['后端1'], woken: ['后端1'] });
});

test('futureaide_team MCP tool, compactTeamManage view, and 160-char cross-level path controls work end-to-end', async (t) => {
  assert.deepEqual(compactTeamManage({
    action: 'adopt',
    ok: true,
    summary: '已接管同项目旧会话 2 名成员',
    adopted: [{ name: '后端1', agentPath: '团队长1/后端1', internalId: 'ag-1' }, '前端1'],
    noisyInternal: { rawOwner: 'owner-old' },
  }), {
    action: 'adopt',
    ok: true,
    summary: '已接管同项目旧会话 2 名成员',
    affected: ['团队长1/后端1', '前端1'],
  });

  assert.deepEqual(compactTeamManage({
    action: 'strays',
    ok: true,
    strays: [
      { name: '后端9', role: '后端', state: 'awaiting_input', strayReason: 'parent-closed', task: { text: '迁移索引' }, extra: 123 },
    ],
  }), {
    action: 'strays',
    ok: true,
    strays: [
      { name: '后端9', role: '后端', state: 'awaiting_input', reason: 'parent-closed', task: '迁移索引' },
    ],
  });

  const calls = [];
  const mockService = {
    async resume() {},
    async manageTeam(args) {
      calls.push({ op: 'manageTeam', args });
      if (args.action === 'kick') {
        return {
          action: 'kick',
          ok: true,
          summary: args.keepChildren !== false ? '已撤职团队长1并保留 2 名下属' : '已连根停止团队长1子树',
          promotedChildren: args.keepChildren !== false ? ['后端1', '后端2'] : [],
          debugRaw: { pid: 9999 },
        };
      }
      if (args.action === 'reparent') {
        return { action: 'reparent', ok: true, name: args.target, parent: args.parent, summary: '调岗完成' };
      }
      if (args.action === 'resume') {
        return { action: 'resume', ok: true, affected: [args.target], taskKey: 'tk-resume-1', wakeCmd: 'futureaide-wait --keys tk-resume-1' };
      }
      return { action: args.action, ok: true, affected: [args.target ?? 'auto'] };
    },
    async answer(args) { calls.push({ op: 'answer', args }); return { name: args.name, answered: true, delivered: true, state: 'running' }; },
    async send(args) { calls.push({ op: 'send', args }); return { name: args.name, state: 'running', taskKey: 'tk-path' }; },
    async cancel(args) { calls.push({ op: 'cancel', args }); return { name: args.name, cancelled: true }; },
    async delete(args) { calls.push({ op: 'delete', args }); return { name: args.name, deleted: true }; },
  };

  const mcp = await connectMcp(mockService);
  t.after(() => mcp.close());

  const kickRes = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_team',
    arguments: { action: 'kick', target: '团队长1', keep_children: true },
  })).content[0].text);
  assert.deepEqual(kickRes, {
    action: 'kick',
    ok: true,
    summary: '已撤职团队长1并保留 2 名下属',
    affected: ['后端1', '后端2'],
  });
  assert.equal(calls[0].args.keepChildren, true);

  const kickDetail = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_team',
    arguments: { action: 'kick', target: '团队长1', keep_children: true, detail: true },
  })).content[0].text);
  assert.deepEqual(kickDetail.debugRaw, { pid: 9999 });

  const reparentRes = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_team',
    arguments: { action: 'reparent', target: '团队长1/后端1', parent: null },
  })).content[0].text);
  assert.deepEqual(reparentRes, {
    action: 'reparent',
    ok: true,
    summary: '调岗完成',
    affected: { name: '团队长1/后端1', parent: null },
  });
  assert.equal(calls[2].args.parent, null);

  const resumeRes = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_team',
    arguments: { action: 'resume', target: '后端2', message: '继续补完剩余单测' },
  })).content[0].text);
  assert.equal(resumeRes.taskKey, 'tk-resume-1');
  assert.equal(calls[3].args.message, '继续补完剩余单测');

  // 110-char cross-level path (> old 80-char cap, <= 160-char cap) succeeds across answer/send/cancel/delete
  const deepPath = `${'长路径部门节点A/'.repeat(10)}后端工程师终极节点1`;
  assert.ok(deepPath.length > 90 && deepPath.length <= 160);
  for (const toolName of ['futureaide_answer_agent', 'futureaide_send_agent', 'futureaide_cancel_agent', 'futureaide_delete_agent']) {
    const args = toolName.includes('answer') || toolName.includes('send')
      ? { name: deepPath, message: '跨级直控指令' }
      : { name: deepPath };
    const r = await mcp.client.callTool({ name: toolName, arguments: args });
    assert.notEqual(r.isError, true, `${toolName} should accept ${deepPath.length}-char team path`);
  }
});

