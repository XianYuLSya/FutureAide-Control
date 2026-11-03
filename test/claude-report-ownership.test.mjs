// Ownership against the real RosterStore, plus one HTTP round trip through the
// real store. No Claude session is involved: a synthetic roster row and its
// backend_state binding stand in for the adapter the Claude backend writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RosterStore } from '../src/roster-store.mjs';
import { reportReceipt } from '../src/claude-inbox.mjs';
import { createReportOwnership, receiptIdFor } from '../src/claude-report-ownership.mjs';
import { startHttpService } from '../src/claude-report-server.mjs';

const sessionId = '6808231c-116c-4fc7-b9b0-4d790e763b0b';

function fixture({ task = {}, record = {}, binding = true } = {}) {
  const store = new RosterStore(':memory:');
  const agentId = 'agent-' + randomUUID().replace(/-/g, '');
  const value = {
    agentId, ownerId: 'owner-' + randomUUID().replace(/-/g, ''), name: '绘图副手',
    target: 'claude-desktop', state: 'running', closed: false, sessionId: 'logical-' + randomUUID(),
    task: { taskId: 7, state: 'running', reports: [], ...task }, ...record,
  };
  store.insert(value);
  if (binding) store.saveBackendState(agentId, { binding: { sessionId }, cursor: { throughSeq: 12 } });
  return { store, record: value, agentId };
}

test('an owned session with an open task is accepted with agent, task and a stable id', async () => {
  const { store, agentId } = fixture();
  const owned = await createReportOwnership({ store })({ sessionId }, { tool: 'report' });
  assert.equal(owned.agentId, agentId);
  assert.equal(owned.taskId, 7);
  assert.equal(owned.agentName, '绘图副手');
  const progress = await owned.report({ message: 'half way', final: false });
  assert.deepEqual(progress, { accepted: true, agentId, taskId: 7,
    receiptId: receiptIdFor(agentId, 7, 'report', false) });
  const repeat = await owned.report({ message: 'half way again', final: false });
  assert.equal(repeat.receiptId, progress.receiptId);
  const final = await owned.report({ message: 'delivered', final: true });
  assert.notEqual(final.receiptId, progress.receiptId);
  const ask = await owned.ask({ message: 'which model?' });
  assert.equal(ask.taskId, 7);
  assert.equal(ask.accepted, true);
});

test('a session with no roster binding is not owned at all', async () => {
  // A roster row without native binding state is not visible to a native session.
  const unbound = fixture({ binding: false });
  const resolve = createReportOwnership({ store: unbound.store });
  assert.equal(await resolve({ sessionId }, { tool: 'list' }), null);
  assert.equal(await resolve({}, { tool: 'list' }), null);
  // A bound roster row belongs to its own native session, not to another one.
  const bound = fixture();
  assert.equal(await createReportOwnership({ store: bound.store })({ sessionId: '3725418e-ac07-45d6-877b-2ab22ef89017' }, { tool: 'list' }), null);
  assert.ok(await createReportOwnership({ store: bound.store })({ sessionId }, { tool: 'list' }));
});

test('a cancelled task refuses with task-cancelled', async () => {
  const { store } = fixture({ task: { cancelRequested: true } });
  await assert.rejects(createReportOwnership({ store })({ sessionId }, { tool: 'report' }),
    error => error.code === 'task-cancelled');
});

test('a closed name is not owned, and a finished task refuses with task-finished', async () => {
  const closed = fixture({ record: { closed: true } });
  assert.equal(await createReportOwnership({ store: closed.store })({ sessionId }, { tool: 'list' }), null);

  const completed = fixture({ task: { state: 'completed' } });
  await assert.rejects(createReportOwnership({ store: completed.store })({ sessionId }, { tool: 'report' }),
    error => error.code === 'task-finished');

  const withResult = fixture({ task: { result: { state: 'completed', reply: 'done' } } });
  await assert.rejects(createReportOwnership({ store: withResult.store })({ sessionId }, { tool: 'report' }),
    error => error.code === 'task-finished');
});

test('a task that already holds a final report refuses another one', async () => {
  const { store } = fixture({ task: { reports: [{ id: 'toolu_1', taskId: 7, message: 'done', final: true,
    delivery: { id: 'report-toolu_1', state: 'delivered' } }] } });
  await assert.rejects(createReportOwnership({ store })({ sessionId }, { tool: 'report' }),
    error => error.code === 'report-final-already-submitted');
});

test('a name without a current task refuses instead of inventing a task id', async () => {
  const { store } = fixture({ task: { taskId: undefined } });
  await assert.rejects(createReportOwnership({ store })({ sessionId }, { tool: 'ask' }),
    error => error.code === 'task-missing');
});

test('ownership needs the shared store, not a stand-in object', () => {
  assert.throws(() => createReportOwnership({}), /requires the shared RosterStore/);
  assert.throws(() => createReportOwnership({ store: { agentForNativeSession: () => undefined } }),
    /requires the shared RosterStore/);
});

test('the HTTP service with real ownership answers the owned session and lists nothing for others', async () => {
  const { store, agentId } = fixture();
  const caller = { pid: 50124, sessionId, cwd: 'D:\\Work\\xiayuls_workflow', via: 'pid' };
  const service = await startHttpService({ port: 0, resolveOwned: createReportOwnership({ store }),
    resolveCaller: async () => caller });
  const outsider = await startHttpService({ port: 0, resolveOwned: createReportOwnership({ store }),
    resolveCaller: async () => ({ pid: 42632, sessionId: '3725418e-ac07-45d6-877b-2ab22ef89017', via: 'pid' }) });
  const open = async url => {
    const client = new Client({ name: 'ownership-http-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  };
  try {
    const client = await open(service.url);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['ask_parent', 'report_parent']);
    const result = await client.callTool({ name: 'report_parent', arguments: { message: 'delivered', final: true } });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.accepted, true);
    assert.equal(payload.taskId, 7);
    assert.equal(payload.agentId, agentId);
    assert.equal(payload.final, true);
    assert.equal(payload.kind, 'report');
    assert.match(payload.receiptId, /^accept-[0-9a-f]{16}$/);
    // The observer reads its receipt with exactly this parser, so the surface is
    // checked against the real contract rather than a copy of it.
    assert.deepEqual(reportReceipt(result), { accepted: true, taskId: 7, agentId,
      kind: 'report', final: true, questionId: undefined, receiptId: payload.receiptId });
    await client.close();

    const stranger = await open(outsider.url);
    assert.deepEqual((await stranger.listTools()).tools, []);
    await assert.rejects(stranger.callTool({ name: 'report_parent', arguments: { message: 'hello' } }));
    await stranger.close();
  } finally {
    await service.close();
    await outsider.close();
  }
});
