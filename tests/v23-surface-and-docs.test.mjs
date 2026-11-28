import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { makeScopedServer } from '../src/mcp-server.mjs';
import {
  compactAgent,
  compactInspect,
  compactList,
  compactRun,
  compactSend,
  compactTeamManage,
  compactWait,
  formatUsage,
} from '../src/tool-view.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readPluginFile = rel => readFile(path.join(pluginRoot, rel), 'utf8');

async function connectMcp(service) {
  const server = makeScopedServer({
    configPath: path.join(pluginRoot, 'clean', 'scoped-mcp-config-absent.json'),
    scopedFactory: () => service,
  });
  const client = new Client({ name: 'surface-test', version: '2.4.0' });
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

test('MCP surface advertises 2.4.0 and supports agy-cli proxy, timeout_minutes, and team merge', async (t) => {
  const calls = [];
  const mockService = {
    async resume() {},
    async manageCliProxy(args) {
      calls.push({ op: 'cliProxy', args });
      return { ok: true, action: args.action, target: args.target, proxy: args.proxy ?? null };
    },
    async run(args) {
      calls.push({ op: 'run', args });
      if (Array.isArray(args.tasks)) {
        return {
          batch: true,
          items: args.tasks.map((task, index) => ({
            name: task.name ?? `${task.role}${index + 1}`,
            role: task.role,
            target: task.target ?? 'codex-cli',
            actualModel: 'gpt-6.1-terra',
            selectedEffort: 'high',
            taskKey: `tk-batch-${index + 1}`,
          })),
          wakeCmd: 'futureaide-wait --keys tk-batch-1,tk-batch-2 --barrier all',
        };
      }
      return {
        name: args.name ?? '后端1',
        role: args.role,
        target: args.target ?? 'codex-cli',
        actualModel: 'gpt-6.1-terra',
        selectedEffort: 'high',
        taskKey: 'tk-v23-1',
        wakeCmd: 'futureaide-wait --keys tk-v23-1',
      };
    },
    async manageTeam(args) {
      calls.push({ op: 'team', args });
      if (args.action === 'merge') {
        return {
          action: 'merge',
          ok: true,
          name: args.target,
          summary: `已合入 ${args.target} 的 2 个改动文件并移除 worktree`,
          mergedFiles: [
            { path: 'src/auth.mjs', operation: 'update' },
            'tests/auth.test.mjs',
          ],
          worktreeRemoved: true,
          internalDebug: { branch: 'detached' },
        };
      }
      return { action: args.action, ok: true };
    },
  };

  const mcp = await connectMcp(mockService);
  t.after(() => mcp.close());
  assert.equal(mcp.client.getServerVersion().version, '2.4.0');

  const { tools } = await mcp.client.listTools();
  for (const tool of tools) {
    const fields = Object.keys(tool.inputSchema.properties ?? {});
    const allowedQuestionSelector = field => tool.name === 'futureaide_answer_agent' && field === 'question_id';
    assert.ok(
      !fields.some(f => !allowedQuestionSelector(f) && /id$|workspace|profile|callback|address/.test(f)),
      `${tool.name} has forbidden schema field: ${fields}`,
    );
  }

  const cliProxyTool = tools.find(tool => tool.name === 'futureaide_cli_proxy');
  assert.deepEqual(cliProxyTool.inputSchema.properties.target.enum, ['codex-cli', 'claude-cli', 'agy-cli', 'all']);

  const proxyRes = await mcp.client.callTool({
    name: 'futureaide_cli_proxy',
    arguments: { action: 'bind', target: 'agy-cli', proxy: 17913 },
  });
  assert.notEqual(proxyRes.isError, true);
  assert.deepEqual(calls[0], {
    op: 'cliProxy',
    args: { action: 'bind', target: 'agy-cli', proxy: 17913 },
  });

  // Single run with timeout_minutes forwards as timeoutMinutes and strips snake_case key
  const singleRes = await mcp.client.callTool({
    name: 'futureaide_run_agent',
    arguments: { role: '后端', message: '执行带超时护栏的任务', timeout_minutes: 45 },
  });
  assert.notEqual(singleRes.isError, true);
  assert.equal(calls[1].args.timeoutMinutes, 45);
  assert.equal('timeout_minutes' in calls[1].args, false);

  // Batch run forwards both top-level and per-task timeout_minutes
  const batchRes = await mcp.client.callTool({
    name: 'futureaide_run_agent',
    arguments: {
      timeout_minutes: 60,
      tasks: [
        { role: '后端', message: '子任务 A', timeout_minutes: 20 },
        { role: '前端', message: '子任务 B' },
      ],
    },
  });
  assert.notEqual(batchRes.isError, true);
  assert.equal(calls[2].args.timeoutMinutes, 60);
  assert.equal(calls[2].args.tasks[0].timeoutMinutes, 20);
  assert.equal('timeout_minutes' in calls[2].args.tasks[0], false);
  assert.equal('timeoutMinutes' in calls[2].args.tasks[1], false);

  // Out-of-range timeout_minutes is rejected by schema
  for (const invalidTimeout of [0, 241]) {
    const bad = await mcp.client.callTool({
      name: 'futureaide_run_agent',
      arguments: { role: '后端', message: '非法超时', timeout_minutes: invalidTimeout },
    });
    assert.equal(bad.isError, true, `timeout_minutes=${invalidTimeout} must fail schema validation`);
  }

  // futureaide_team merge action returns slim mergedFiles + summary
  const teamTool = tools.find(tool => tool.name === 'futureaide_team');
  assert.deepEqual(
    teamTool.inputSchema.properties.action.enum,
    ['adopt', 'kick', 'reparent', 'resume', 'strays', 'sweep', 'merge'],
  );

  const mergeSlim = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_team',
    arguments: { action: 'merge', target: '后端1' },
  })).content[0].text);
  assert.deepEqual(mergeSlim, {
    action: 'merge',
    ok: true,
    summary: '已合入 后端1 的 2 个改动文件并移除 worktree',
    mergedFiles: ['src/auth.mjs', 'tests/auth.test.mjs'],
    applied: false,
    worktreeRemoved: true,
    recordClosed: false,
    recordCloseRequired: false,
    affected: '后端1',
  });

  const mergeDetail = JSON.parse((await mcp.client.callTool({
    name: 'futureaide_team',
    arguments: { action: 'merge', target: '后端1', detail: true },
  })).content[0].text);
  assert.equal(mergeDetail.worktreeRemoved, true);
  assert.deepEqual(mergeDetail.internalDebug, { branch: 'detached' });
});

test('V2.3 compact usage formatting outputs concise cost string only when positive and keeps zero-usage items clean', () => {
  assert.equal(formatUsage(undefined), undefined);
  assert.equal(formatUsage(null), undefined);
  assert.equal(formatUsage({ totalTokens: 0, durationSec: 0 }), undefined);
  assert.equal(formatUsage({ totalTokens: 14200, durationSec: 18 }), '18s · 14.2k tok');
  assert.equal(formatUsage({ inputTokens: 10000, outputTokens: 4000, durationMs: 18400 }), '18s · 14k tok');
  assert.equal(formatUsage({ totalTokens: 850 }), '850 tok');
  assert.equal(formatUsage({ durationSec: 25 }), '25s');
  assert.equal(formatUsage({ totalTokens: 1250000, durationSec: 92 }), '92s · 1.25M tok');

  // Zero or missing usage adds no field at all
  const plainAgent = compactAgent({ name: '后端1', state: 'idle', lifetime: 'once', usage: { totalTokens: 0, durationSec: 0 } });
  assert.deepEqual(plainAgent, { name: '后端1', state: 'idle', lifetime: 'once' });
  assert.equal('usage' in plainAgent, false);

  // Positive usage surfaces cleanly across list, wait, run, send, inspect, and team merge
  const billedItem = {
    name: '后端1',
    role: '后端',
    target: 'codex-cli',
    state: 'idle',
    lifetime: 'once',
    usage: { totalTokens: 14200, durationSec: 18 },
  };
  assert.equal(compactAgent(billedItem).usage, '18s · 14.2k tok');
  assert.equal(compactList({ scope: 'team', items: [billedItem] }).items[0].usage, '18s · 14.2k tok');
  assert.equal(compactList({ scope: 'agent', agent: billedItem }).agent.usage, '18s · 14.2k tok');
  assert.equal(compactRun({ name: '后端1', role: '后端', target: 'codex-cli', actualModel: 'gpt-6.1-terra', usage: { totalTokens: 14200, durationSec: 18 } }).usage, '18s · 14.2k tok');
  assert.equal(compactSend({ name: '后端1', state: 'running', usage: { totalTokens: 3100, durationSec: 6 } }).usage, '6s · 3.1k tok');
  assert.equal(compactInspect({ ...billedItem, tree: { nodes: [] }, changes: {}, reports: {} }).usage, '18s · 14.2k tok');

  const waited = compactWait({
    timedOut: false,
    nextCursor: 'cur-2',
    items: [billedItem],
    events: [
      {
        name: '后端1',
        role: '后端',
        type: 'final',
        message: '结论：通过',
        usage: { totalTokens: 14200, durationSec: 18 },
      },
    ],
  });
  assert.equal(waited.events[0].usage, '18s · 14.2k tok');

  assert.deepEqual(compactTeamManage({
    action: 'merge',
    ok: true,
    summary: '合入完成',
    files: ['a.mjs'],
    applied: true,
    worktreeRemoved: true,
    recordClosed: false,
    recordCloseRequired: false,
    stage: 'complete',
  }), {
    action: 'merge',
    ok: true,
    summary: '合入完成',
    mergedFiles: ['a.mjs'],
    applied: true,
    worktreeRemoved: true,
    recordClosed: false,
    recordCloseRequired: false,
    stage: 'complete',
  });
});

test('release metadata is aligned at 2.4.0 and public files respect standalone open-source boundaries', async () => {
  const [pkgRaw, lockRaw, codexPluginRaw, claudePluginRaw, readme, changelog, reference, skill] = await Promise.all([
    readPluginFile('package.json'),
    readPluginFile('package-lock.json'),
    readPluginFile('.codex-plugin/plugin.json'),
    readPluginFile('.claude-plugin/plugin.json'),
    readPluginFile('README.md'),
    readPluginFile('CHANGELOG.md'),
    readPluginFile('REFERENCE.md'),
    readPluginFile('skills/futureaide-control/SKILL.md'),
  ]);

  const pkg = JSON.parse(pkgRaw);
  const lock = JSON.parse(lockRaw);
  const codexPlugin = JSON.parse(codexPluginRaw);
  const claudePlugin = JSON.parse(claudePluginRaw);

  assert.equal(pkg.version, '2.4.0');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(codexPlugin.version, pkg.version);
  assert.equal(claudePlugin.version, pkg.version);

  for (const manifest of [pkg, codexPlugin, claudePlugin]) {
    assert.match(manifest.description, /Antigravity/i);
    assert.match(manifest.description, /codex-cli/);
    assert.match(manifest.description, /claude-cli/);
    assert.match(manifest.description, /agy-cli/);
  }

  assert.match(readme, /v2\.4\.0/);
  assert.match(readme, /!\[FutureAide Control\]\(assets\/banner\.svg\)/);
  assert.match(readme, /QQ 交流群：259109974/);
  for (const feature of [
    'codex-cli',
    'claude-cli',
    'agy-cli',
    '角色预设',
    'worktree',
    'timeout_minutes',
    'futureaide-wait',
    'Job Object',
    'futureaide_board_post',
    'futureaide_team',
    'merge',
    'futureaide_cli_proxy',
    '18s · 14.2k tok',
  ]) {
    assert.ok(readme.includes(feature), `README.md is missing a highlight: ${feature}`);
  }

  assert.equal(changelog.match(/^## .+$/m)?.[0], '## 2.4.0');
  assert.match(reference, /v2\.4\.0/);
  assert.match(reference, /agy-cli/);
  assert.match(reference, /timeout_minutes/);
  assert.match(reference, /"merge"/);

  assert.match(skill, /Do not override the user's existing workflow/i);

  // Standalone open-source hygiene: public docs & manifests must not leak external private canvas or workflow names
  const privateCanvasPattern = /\u0070\u0072\u006f\u006a\u0065\u0063\u0074-\u006d\u0061\u0070|\u81ea\u7531\u753b\u5e03|\u753b\u5e03\s*Team|\u0034\u0037\u0033\u0033\u0030|\u0077\u006f\u0072\u006b-\u0077\u006f\u0072\u006b\u0066\u006c\u006f\u0077|\u56e2\u961f\u914d\u7f6e\.md/i;
  for (const [docName, content] of [
    ['package.json', pkgRaw],
    ['.codex-plugin/plugin.json', codexPluginRaw],
    ['.claude-plugin/plugin.json', claudePluginRaw],
    ['README.md', readme],
    ['CHANGELOG.md', changelog],
    ['REFERENCE.md', reference],
    ['SKILL.md', skill],
  ]) {
    assert.doesNotMatch(content, privateCanvasPattern, `${docName} must remain standalone without private canvas references`);
  }
});
