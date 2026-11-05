import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeScopedServer } from '../src/mcp-server.mjs';
import { compactList } from '../src/tool-view.mjs';

test('MCP connection restores monitor health before any tool call', async () => {
  let restored;
  const done = new Promise(resolve => { restored = resolve; });
  const service = { async resume() {}, async ensureIdleMonitor() { restored(); } };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = makeScopedServer({ configPath: path.join(root, 'clean', 'scoped-mcp-config-absent.json'), scopedFactory: () => service });
  const client = new Client({ name: 'scoped-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try { await done; } finally { await client.close(); await server.close(); }
});

test('installed MCP exposes only name-addressed tools and forwards trusted request metadata', async () => {
  const calls = [];
  const service = { async resume() {}, async create(args, extra) { calls.push({ args, meta: extra._meta }); return { created: true, name: args.name }; } };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = makeScopedServer({ configPath: path.join(root, 'clean', 'scoped-mcp-config-absent.json'), scopedFactory: () => service });
  const client = new Client({ name: 'scoped-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 13, 'eleven name-addressed tools plus the Codex-side ask_parent/report_parent');
    assert.ok(tools.findIndex(tool => tool.name === 'futureaide_run_agent') < tools.findIndex(tool => tool.name === 'futureaide_create_agent'),
      'the one-call run tool is offered before the two-call pair');
    assert.ok(!tools.some(tool => /spawn_agent|register_peer|create_session|profile_create/.test(tool.name)));
    for (const tool of tools) {
      const fields = Object.keys(tool.inputSchema.properties ?? {});
      assert.ok(!fields.some(field => /id$|workspace|profile|callback|address/.test(field)), `${tool.name}: ${fields}`);
    }
    const threadId = '11111111-1111-4111-8111-111111111111';
    const result = await client.callTool({ name: 'futureaide_create_agent', arguments: { name: '画图助手', lifetime: 'once' }, _meta: { threadId } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls[0].args, { name: '画图助手', lifetime: 'once' });
    assert.equal(calls[0].meta.threadId, threadId);
  } finally { await client.close(); await server.close(); }
});

test('creation advertises one optional target and never repeats it on later calls', async () => {
  const calls = [];
  const service = { async resume() {}, async create(args, extra) { calls.push({ args, meta: extra._meta });
    return { created: true, name: args.name, target: args.target ?? 'dsh' }; } };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = makeScopedServer({ configPath: path.join(root, 'clean', 'scoped-mcp-config-absent.json'), scopedFactory: () => service });
  const client = new Client({ name: 'scoped-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const threadId = '11111111-1111-4111-8111-111111111111';
  try {
    const { tools } = await client.listTools();
    const create = tools.find(tool => tool.name === 'futureaide_create_agent');
    assert.deepEqual(Object.keys(create.inputSchema.properties).sort(), ['lifetime', 'name', 'target']);
    assert.deepEqual(create.inputSchema.properties.target.enum, ['dsh', 'codex-desktop'],
      'every supported application is reachable from the public schema, not just internally');
    assert.ok(!create.inputSchema.required?.includes('target'), 'the target stays optional');
    // run is the second entry point that may bind a new name to an application; it
    // advertises target for that one creation, exactly like create.
    for (const tool of tools.filter(tool => !['futureaide_create_agent', 'futureaide_run_agent'].includes(tool.name))) {
      assert.ok(!('target' in (tool.inputSchema.properties ?? {})), `${tool.name} must stay name-addressed`);
    }

    await client.callTool({ name: 'futureaide_create_agent', arguments: { name: '搭档', lifetime: 'persistent' }, _meta: { threadId } });
    assert.deepEqual(calls[0].args, { name: '搭档', lifetime: 'persistent' }, 'an omitted target adds no argument');
    const selected = await client.callTool({ name: 'futureaide_create_agent',
      arguments: { name: 'Opus搭档', lifetime: 'persistent', target: 'codex-desktop' }, _meta: { threadId } });
    assert.notEqual(selected.isError, true);
    assert.deepEqual(calls[1].args, { name: 'Opus搭档', lifetime: 'persistent', target: 'codex-desktop' });
    const refused = await client.callTool({ name: 'futureaide_create_agent',
      arguments: { name: 'other', lifetime: 'once', target: 'claude' }, _meta: { threadId } });
    assert.equal(refused.isError, true, 'the schema owns the enum');
    assert.equal(calls.length, 2);
  } finally { await client.close(); await server.close(); }
});

test('queued desktop deletion is accepted while a cleanup error stays visible', async () => {
  let response = { name: 'cleanup', deleted: false, queued: true, state: 'cleaning' };
  const service = { async resume() {}, async delete() { return response; } };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = makeScopedServer({ configPath: path.join(root, 'clean', 'scoped-mcp-config-absent.json'), scopedFactory: () => service });
  const client = new Client({ name: 'scoped-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const queued = await client.callTool({ name: 'futureaide_delete_agent', arguments: { name: 'cleanup' } });
    assert.notEqual(queued.isError, true, 'durable cleanup acceptance must not invite a retry');
    assert.deepEqual(JSON.parse(queued.content[0].text), response);
    response = { ...response, error: { code: 'child-cleanup-failed', message: 'A child still needs cleanup.' } };
    const failed = await client.callTool({ name: 'futureaide_delete_agent', arguments: { name: 'cleanup' } });
    assert.equal(failed.isError, true, 'queued intent must not hide a real cleanup failure');
    assert.equal(JSON.parse(failed.content[0].text).error.code, 'child-cleanup-failed');
  } finally { await client.close(); await server.close(); }
});

async function connected(service) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = makeScopedServer({ configPath: path.join(root, 'clean', 'scoped-mcp-config-absent.json'), scopedFactory: () => service });
  const client = new Client({ name: 'scoped-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

// One entry shaped exactly like the service's publicResult plus list's own fields, so
// the compact view is tested against the real structure rather than a small stub.
const fullEntry = () => ({
  name: '助手', lifetime: 'once', target: 'dsh', state: 'idle',
  task: { text: 'x'.repeat(120), state: 'completed', startedAt: '2026-11-04T01:00:00.000Z',
    result: { state: 'completed', summary: 'y'.repeat(300), files: [], coverage: { workspace: { complete: false, reason: 'not-a-repository' } } } },
  activity: 'Waiting for a task',
  changes: { count: 1, unconfirmed: 0, files: [{ path: 'a.mjs', operation: 'update', agentPath: ['助手'] }],
    coverage: { workspace: { complete: false, reason: 'not-a-repository' } }, observedAt: null, stale: false },
  questions: [], tree: { settled: true, running: false, nodes: [
    { name: '助手', agentPath: ['助手'], depth: 0, status: 'idle', changes: [] },
    { name: 'helper', agentPath: ['助手', 'helper'], depth: 1, status: 'running', activity: 'writing', changes: [{ path: 'b.mjs' }] }] },
  reports: { total: 1, pending: 0, latest: { summary: 'z'.repeat(300), final: true, delivery: 'delivered' } },
  delivery: 'delivered', updatedAt: '2026-11-04T01:00:00.000Z', monitor: 'running',
  supplements: { queued: 0, unknown: 0, blocked: 0, accepted: 0 },
});

test('list and wait answer compactly and return the full structure only for detail', async () => {
  const entry = fullEntry();
  const { client, close } = await connected({
    async resume() {},
    async list() { return { items: [entry], total: 1 }; },
    async wait() { return { items: [entry], notListed: ['gone'], note: 'Absence alone does not prove completion.', timedOut: false }; },
  });
  try {
    const listed = await client.callTool({ name: 'futureaide_list_agents', arguments: {} });
    assert.notEqual(listed.isError, true);
    assert.equal(listed.content[0].text.includes('\n'), false, 'the compact view carries no indentation');
    const compact = JSON.parse(listed.content[0].text);
    assert.deepEqual(compact.items[0], { name: '助手', state: 'idle', lifetime: 'once', task: 'x'.repeat(80) + '…',
      report: { summary: 'z'.repeat(200) + '…', final: true, delivery: 'delivered' },
      files: { count: 1 }, team: [{ path: 'helper', state: 'running', activity: 'writing', files: 1 }] });
    assert.equal(compact.total, 1);
    const detail = await client.callTool({ name: 'futureaide_list_agents', arguments: { detail: true } });
    assert.deepEqual(JSON.parse(detail.content[0].text), { items: [entry], total: 1 }, 'detail is the unchanged structure');

    const waited = JSON.parse((await client.callTool({ name: 'futureaide_wait_agents', arguments: { timeout_seconds: 0 } })).content[0].text);
    assert.equal(waited.items[0].task, 'x'.repeat(80) + '…');
    assert.deepEqual(waited.notListed, ['gone']);
    assert.equal(waited.note, 'Absence alone does not prove completion.');
    assert.deepEqual(waited.items[0].files, { count: 1 });
    const fullWait = JSON.parse((await client.callTool({ name: 'futureaide_wait_agents', arguments: { timeout_seconds: 0, detail: true } })).content[0].text);
    assert.deepEqual(fullWait.items, [entry], 'detail keeps the full reply and coverage');
    assert.deepEqual(fullWait.notListed, ['gone']);
  } finally { await close(); }
});

test('a compact view still reports a failed status as an error', async () => {
  let response = { ready: true, contextVerified: true, dshConnected: true,
    backends: { dsh: { ready: true, connected: true }, 'codex-desktop': { ready: true, present: true, methods: ['probe', 'create'], treeProtocol: 1 } } };
  const { client, close } = await connected({ async resume() {}, async status() { return response; } });
  try {
    const shown = await client.callTool({ name: 'futureaide_status', arguments: {} });
    assert.notEqual(shown.isError, true);
    const status = JSON.parse(shown.content[0].text);
    assert.deepEqual(status.backends.dsh, { ready: true, connected: true });
    assert.equal('methods' in status.backends['codex-desktop'], false, 'advertised method lists stay out of the text');
    assert.equal(status.backends['codex-desktop'].treeProtocol, 1, 'readiness evidence is kept');
    const full = JSON.parse((await client.callTool({ name: 'futureaide_status', arguments: { detail: true } })).content[0].text);
    assert.deepEqual(full.backends['codex-desktop'].methods, ['probe', 'create'], 'detail keeps the advertised methods');
    response = { ...response, ready: false, backends: { ...response.backends, dsh: { ready: false, connected: false, reason: { code: 'managed-host-required' } } } };
    const refused = await client.callTool({ name: 'futureaide_status', arguments: {} });
    assert.equal(refused.isError, true, 'isError is decided on the full result, not the view');
  } finally { await close(); }
});

test('inspect keeps each message list once and clips only long text', async () => {
  const rootMessage = 'the root reply that must appear once';
  const { client, close } = await connected({ async resume() {}, async inspect() { return {
    name: '助手', lifetime: 'once', target: 'dsh', state: 'idle',
    task: { text: 'draw the diagram', state: 'completed', startedAt: '2026-11-04T01:00:00.000Z',
      result: { state: 'completed', summary: 'duplicate body', files: [], coverage: { workspace: {} } } },
    changes: { count: 1, files: [{ path: 'a.mjs', operation: 'update', agentPath: ['助手'], attribution: 'unconfirmed' }],
      coverage: { workspace: { complete: false, reason: 'not-a-repository' } }, observedAt: null, stale: false },
    questions: [], messages: [{ seq: 1, role: 'assistant', text: rootMessage }], hasMore: false,
    reports: { total: 1, pending: 0, latest: { summary: 'duplicate body', final: true, delivery: 'delivered' },
      items: [{ message: 'duplicate body', final: true, delivery: 'delivered' }] },
    tree: { settled: true, running: false, nodes: [
      { name: '助手', parentName: null, agentPath: ['助手'], depth: 0, status: 'idle', activity: 'idle', changes: [], coverage: 'root writes',
        messages: [{ seq: 1, role: 'assistant', text: rootMessage }], hasMore: false },
      { name: 'helper', parentName: '助手', agentPath: ['助手', 'helper'], depth: 1, status: 'running', activity: 'writing', changes: [],
        coverage: 'child writes', messages: [{ seq: 2, role: 'assistant', text: 'w'.repeat(5000) }], hasMore: true },
    ] },
    inspectionIncomplete: false, historyCount: 1,
    history: [{ task: 1, message: 'draw the diagram', state: 'completed', startedAt: '2026-11-04T01:00:00.000Z' }],
  }; } });
  try {
    const text = (await client.callTool({ name: 'futureaide_inspect_agent', arguments: { name: '助手' } })).content[0].text;
    const inspected = JSON.parse(text);
    assert.equal(text.split(rootMessage).length - 1, 1, 'the root page is not repeated at the top level');
    assert.equal('messages' in inspected, false);
    assert.equal(inspected.tree.nodes.length, 2);
    assert.equal('coverage' in inspected.tree.nodes[0], false, 'per-node coverage stays out of the text');
    assert.equal(inspected.tree.nodes[1].messages[0].text.length, 4001);
    assert.equal(inspected.tree.nodes[1].messages[0].truncated, true);
    assert.equal(inspected.tree.nodes[1].hasMore, true);
    assert.deepEqual(inspected.reports.items, [{ message: 'duplicate body', final: true, delivery: 'delivered' }]);
    assert.equal(text.split('duplicate body').length - 1, 1, 'the report body appears once');
    assert.equal(inspected.history.length, 1);
    assert.match(inspected.changes.note, /unconfirmed/);
    const full = JSON.parse((await client.callTool({ name: 'futureaide_inspect_agent', arguments: { name: '助手', detail: true } })).content[0].text);
    assert.equal(full.messages.length, 1, 'detail keeps the top-level page');
    assert.equal(full.tree.nodes[0].coverage, 'root writes');
    assert.equal(full.tree.nodes[1].messages[0].text.length, 5000, 'detail is not clipped by this tool');
    // The node filter lives in the view, so the registrar has to hand it the arguments.
    const oneNode = JSON.parse((await client.callTool({ name: 'futureaide_inspect_agent', arguments: { name: '助手', node: 'helper' } })).content[0].text);
    assert.equal(oneNode.node, 'helper');
    assert.deepEqual(oneNode.tree.nodes[0], { name: '助手', status: 'idle' }, 'the other node keeps only its name and status');
    assert.equal(oneNode.tree.nodes[1].messages.length, 1);
    const oneNodeDetail = JSON.parse((await client.callTool({ name: 'futureaide_inspect_agent',
      arguments: { name: '助手', node: 'helper', detail: true } })).content[0].text);
    assert.equal(oneNodeDetail.tree.nodes[1].messages[0].text.length, 5000, 'detail filters by node as well');
    const missing = await client.callTool({ name: 'futureaide_inspect_agent', arguments: { name: '助手', node: 'nobody' } });
    assert.equal(missing.isError, true);
    assert.match(JSON.parse(missing.content[0].text).error.message, /助手|helper/, 'the refusal lists the nodes that exist');
  } finally { await close(); }
});

test('changes keeps one line per path and states coverage as one sentence', async () => {
  let response = { name: '助手', task: 0, stale: false,
    changes: [{ path: 'a.mjs', operation: 'update', agentPath: ['助手'], source: 'workspace-diff', attribution: 'unconfirmed',
      before: 'x'.repeat(500), after: 'y'.repeat(500) }],
    tree: { settled: true, running: false, nodes: [{ name: '助手' }, { name: 'helper' }] },
    coverage: { workspace: { complete: false, reason: 'not-a-repository' } } };
  const { client, close } = await connected({ async resume() {}, async changes() { return response; } });
  try {
    const result = await client.callTool({ name: 'futureaide_agent_changes', arguments: { name: '助手' } });
    const shown = JSON.parse(result.content[0].text);
    assert.deepEqual(shown.changes, [{ path: 'a.mjs', operation: 'update', attribution: 'unconfirmed' }],
      'file bodies and source labels never enter the text');
    assert.equal('tree' in shown, false);
    assert.equal(typeof shown.note, 'string');
    assert.match(shown.note, /unconfirmed/, 'unconfirmed paths are called out');
    const full = JSON.parse((await client.callTool({ name: 'futureaide_agent_changes', arguments: { name: '助手', detail: true } })).content[0].text);
    assert.equal(full.tree.nodes.length, 2, 'detail keeps the tree this view drops');
    assert.deepEqual(full.changes, response.changes, 'detail keeps the bodies');
    assert.equal(full.changes[0].before.length, 500);
    response = { name: '助手', task: 0, changes: [],
      coverage: { workspace: { complete: false, reason: 'not-a-repository' } } };
    const unavailable = JSON.parse((await client.callTool({ name: 'futureaide_agent_changes', arguments: { name: '助手' } })).content[0].text);
    assert.match(unavailable.note, /not-a-repository/, 'an unavailable comparison names its reason');
  } finally { await close(); }
});

test('create answers with a compact receipt while a failed creation stays an error', async () => {
  let response = { name: 'artist', lifetime: 'once', target: 'dsh', state: 'idle', created: true, modelRequestsStarted: 0,
    changes: { count: 3, unconfirmed: 0, files: [], coverage: { workspace: { limitation: 'long text' } } },
    tree: { settled: true, running: false, nodes: [] }, updatedAt: '2026-11-04T02:00:00.000Z' };
  const { client, close } = await connected({ async resume() {}, async create() { return response; } });
  try {
    const created = await client.callTool({ name: 'futureaide_create_agent', arguments: { name: 'artist', lifetime: 'once' } });
    assert.notEqual(created.isError, true);
    assert.equal(created.content[0].text.includes('\n'), false, 'the compact receipt carries no indentation');
    assert.deepEqual(JSON.parse(created.content[0].text),
      { name: 'artist', lifetime: 'once', state: 'idle', created: true, modelRequestsStarted: 0 });
    response = { ...response, created: false, state: 'reconnecting',
      error: { code: 'managed-host-required', message: 'Install the current managed DSH bridge.' } };
    const failed = await client.callTool({ name: 'futureaide_create_agent', arguments: { name: 'artist', lifetime: 'once' } });
    assert.equal(failed.isError, true, 'isError still reads created:false from the full result');
    assert.equal(JSON.parse(failed.content[0].text).error.code, 'managed-host-required');
  } finally { await close(); }
});

test('every tool keeps its own annotations: a write is never advertised as a read', async () => {
  const { client, close } = await connected({ async resume() {} });
  try {
    const tools = (await client.listTools()).tools;
    const expected = { futureaide_status: true, futureaide_run_agent: false, futureaide_create_agent: false,
      futureaide_send_agent: false, futureaide_answer_agent: false, futureaide_list_agents: true,
      futureaide_wait_agents: true, futureaide_agent_changes: true, futureaide_inspect_agent: true,
      futureaide_cancel_agent: false, futureaide_delete_agent: false, ask_parent: false, report_parent: false };
    assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(expected).sort());
    for (const [tool, readOnly] of Object.entries(expected)) {
      const annotations = tools.find(entry => entry.name === tool).annotations;
      assert.equal(annotations.readOnlyHint, readOnly, `${tool} readOnlyHint`);
      assert.equal(annotations.idempotentHint, readOnly, `${tool} idempotentHint follows read-only`);
      assert.equal(annotations.destructiveHint, ['futureaide_cancel_agent', 'futureaide_delete_agent'].includes(tool), `${tool} destructiveHint`);
      assert.equal(annotations.openWorldHint, !readOnly, `${tool} openWorldHint`);
    }
  } finally { await close(); }
});

test('an oversized list is reduced to team sizes instead of a preview', async () => {
  const sprawl = Array.from({ length: 13 }, (unused, index) => ({ name: `team-${index}`, lifetime: 'persistent', target: 'dsh', state: 'idle',
    changes: { count: 0, unconfirmed: 0, files: [] }, questions: [], reports: { total: 0, pending: 0 },
    tree: { settled: false, running: true, nodes: [
      { name: `team-${index}`, agentPath: [`team-${index}`], depth: 0, status: 'idle', changes: [] },
      ...Array.from({ length: 30 }, (unusedMember, member) => ({ name: `member-${member}`,
        agentPath: [`team-${index}`, `member-${member}-${'x'.repeat(80)}`], depth: 1, status: 'idle', changes: [] })),
    ] } }));
  const result = { items: sprawl, total: sprawl.length };
  assert.ok(Buffer.byteLength(JSON.stringify(compactList(result)), 'utf8') > 40000, 'the compact answer alone is too large');
  const { client, close } = await connected({ async resume() {}, async list() { return result; } });
  try {
    const listed = await client.callTool({ name: 'futureaide_list_agents', arguments: {} });
    assert.notEqual(listed.isError, true);
    const shown = JSON.parse(listed.content[0].text);
    assert.notEqual(shown.truncated, true, 'a preview would lose every name');
    assert.equal(shown.items.length, 13);
    assert.equal(shown.items[0].teamSize, 30);
    assert.equal('team' in shown.items[0], false);
    assert.match(shown.note, /replaced by their size/);
  } finally { await close(); }
});

test('run answers an existing name normally and a creation failure as an error', async () => {
  let response = { name: 'helper', lifetime: 'persistent', state: 'running', accepted: true, reused: true };
  const { client, close } = await connected({ async resume() {}, async run() { return response; } });
  try {
    const reused = await client.callTool({ name: 'futureaide_run_agent', arguments: { name: 'helper', message: 'go' } });
    assert.notEqual(reused.isError, true, 'reusing a name is success, never created: false');
    assert.deepEqual(JSON.parse(reused.content[0].text), response);
    response = { name: 'helper', lifetime: 'persistent', state: 'reconnecting', created: false,
      error: { code: 'managed-host-required', message: 'Install the current managed DSH bridge.' } };
    const failed = await client.callTool({ name: 'futureaide_run_agent', arguments: { message: 'go' } });
    assert.equal(failed.isError, true);
    assert.equal(JSON.parse(failed.content[0].text).error.code, 'managed-host-required');
  } finally { await close(); }
});
