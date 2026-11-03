// Protocol tests for the Claude managed-session report surface. They use injected
// identity and ownership so they say nothing about a live Claude session; the
// real caller identity is covered by claude-caller-identity.test.mjs and by the
// loopback probe in scripts/claude-report-probe.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createClaudeReportServer, developmentOwnership, startHttpService, REPORT_TOOL_NAMES } from '../src/claude-report-server.mjs';

const sessionId = '6808231c-116c-4fc7-b9b0-4d790e763b0b';
const caller = { pid: 50124, sessionId, cwd: 'D:\\Work\\xiayuls_workflow', via: 'pid' };
const parse = result => JSON.parse(result.content[0].text);

function ownership({ accept = true, reportError } = {}) {
  const calls = [];
  const owned = {
    agentName: '绘图副手', taskId: 7,
    async ask(input) { calls.push({ kind: 'ask', ...input }); return accept ? { accepted: true } : { accepted: false, code: 'task-busy' }; },
    async report(input) {
      calls.push({ kind: 'report', ...input });
      if (reportError) throw reportError;
      return accept ? { accepted: true } : { accepted: false, code: 'task-closed' };
    },
  };
  return { calls, owned };
}

async function inMemory(resolveOwned, resolveCaller = async () => caller) {
  const server = createClaudeReportServer({ resolveCaller, resolveOwned });
  const client = new Client({ name: 'protocol-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, server, close: async () => { await client.close(); await server.close(); } };
}

test('the surface exposes exactly ask_parent and report_parent with no identity arguments', async () => {
  const { owned } = ownership();
  const { client, close } = await inMemory(async () => owned);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...REPORT_TOOL_NAMES].sort());
    for (const tool of tools) {
      const fields = Object.keys(tool.inputSchema.properties ?? {});
      assert.deepEqual(fields.sort(), tool.name === 'ask_parent' ? ['message'] : ['final', 'message'], tool.name);
      assert.ok(!fields.some(field => /id$|session|chat|agent|name|route|header/i.test(field)), `${tool.name}: ${fields}`);
    }
    const instructions = client.getInstructions();
    assert.match(instructions, /never forwarded|not forwarded|Nothing is automatic/i);
    assert.match(instructions, /ask_parent/);
    assert.match(instructions, /report_parent/);
  } finally { await close(); }
});

test('an accepted question returns accepted and tells the model to wait', async () => {
  const { calls, owned } = ownership();
  const { client, close } = await inMemory(async () => owned);
  try {
    const result = await client.callTool({ name: 'ask_parent', arguments: { message: 'Which model should I use?' } });
    assert.notEqual(result.isError, true);
    const value = parse(result);
    assert.equal(value.accepted, true);
    assert.equal(value.kind, 'question');
    assert.match(value.note, /answer arrives as a new message/);
    assert.deepEqual(calls.map(call => [call.kind, call.message]), [['ask', 'Which model should I use?']]);
    assert.equal(calls[0].caller.sessionId, sessionId);
  } finally { await close(); }
});

test('a session that is not plugin-owned gets no working tool and nothing is submitted', async () => {
  const { calls } = ownership();
  const { client, close } = await inMemory(async () => null);
  try {
    const result = await client.callTool({ name: 'report_parent', arguments: { message: 'done' } });
    assert.equal(result.isError, true);
    assert.equal(parse(result).error.code, 'not-owned-session');
    assert.equal(calls.length, 0);
  } finally { await close(); }
});

test('a caller that cannot be identified is refused instead of defaulting to someone', async () => {
  const { calls, owned } = ownership();
  const { client, close } = await inMemory(async () => owned, async () => {
    throw Object.assign(new Error('no verified session record'), { code: 'caller-unresolved' });
  });
  try {
    const result = await client.callTool({ name: 'ask_parent', arguments: { message: 'hello' } });
    assert.equal(result.isError, true);
    assert.equal(parse(result).error.code, 'caller-unresolved');
    assert.equal(calls.length, 0);
  } finally { await close(); }
});

test('results carry the task id and the acceptance id so a late result is attributable', async () => {
  const finals = [];
  const owned = {
    agentName: '绘图副手', taskId: 7,
    async ask() { return { accepted: true, submissionId: 'accept-ask' }; },
    async report({ final }) { finals.push(final); return { accepted: true, submissionId: final ? 'accept-final' : 'accept-progress' }; },
  };
  const { client, close } = await inMemory(async () => owned);
  try {
    const progress = parse(await client.callTool({ name: 'report_parent', arguments: { message: 'half way' } }));
    assert.deepEqual([progress.accepted, progress.taskId, progress.final, progress.submissionId],
      [true, 7, false, 'accept-progress']);
    const final = parse(await client.callTool({ name: 'report_parent', arguments: { message: 'delivered', final: true } }));
    assert.deepEqual([final.accepted, final.taskId, final.final, final.submissionId], [true, 7, true, 'accept-final']);
    const asked = parse(await client.callTool({ name: 'ask_parent', arguments: { message: 'which model?' } }));
    assert.deepEqual([asked.kind, asked.taskId, asked.submissionId], ['question', 7, 'accept-ask']);
    assert.deepEqual(finals, [false, true]);
  } finally { await close(); }
});

test('whether a second final report is allowed is the ownership decision, not the surface', async () => {
  const repeats = ownership({ reportError: Object.assign(new Error('A final report was already submitted for task 7; do not submit another.'), { code: 'report-final-already-submitted' }) });
  const { client, close } = await inMemory(async () => repeats.owned);
  try {
    const result = await client.callTool({ name: 'report_parent', arguments: { message: 'one more', final: true } });
    assert.equal(result.isError, true);
    assert.equal(parse(result).error.code, 'report-final-already-submitted');
  } finally { await close(); }
});

test('a closed or cancelled task surfaces the state machine refusal unchanged', async () => {
  const closed = ownership({ reportError: Object.assign(new Error('Task 7 was cancelled.'), { code: 'task-cancelled' }) });
  const { client, close } = await inMemory(async () => closed.owned);
  try {
    const result = await client.callTool({ name: 'report_parent', arguments: { message: 'still working' } });
    assert.equal(result.isError, true);
    assert.deepEqual(parse(result).error, { code: 'task-cancelled', message: 'Task 7 was cancelled.' });
  } finally { await close(); }
});

test('a submission the state machine declines is an error, never a silent accepted', async () => {
  const { owned } = ownership({ accept: false });
  const { client, close } = await inMemory(async () => owned);
  try {
    const result = await client.callTool({ name: 'ask_parent', arguments: { message: 'may I?' } });
    assert.equal(result.isError, true);
    assert.equal(parse(result).error.code, 'task-busy');
  } finally { await close(); }
});

test('the development ownership stub accepts only the pinned session and records what it got', async () => {
  const lines = [];
  const resolveOwned = developmentOwnership([sessionId], { log: line => lines.push(line) });
  const owned = await resolveOwned({ sessionId });
  assert.equal(owned.agentName, 'development-stub');
  assert.deepEqual(await owned.report({ message: 'hello', final: true }), { accepted: true });
  assert.equal(await resolveOwned({ sessionId: '3725418e-ac07-45d6-877b-2ab22ef89017' }), null);
  assert.equal(await resolveOwned(undefined), null);
  assert.match(lines.join('\n'), /final=true/);
});

test('the shared loopback HTTP service answers an owned session and lists nothing for others', async () => {
  const { calls, owned } = ownership();
  const service = await startHttpService({ port: 0, resolveOwned: async () => owned, resolveCaller: async () => caller });
  // A peer that is not an owned session: its identification fails, and it must
  // still get a connected surface with zero tools rather than an error or a tool.
  const unowned = await startHttpService({ port: 0, resolveOwned: async () => owned,
    resolveCaller: async () => { throw Object.assign(new Error('not a session'), { code: 'caller-unresolved' }); } });
  const open = async url => {
    const client = new Client({ name: 'http-protocol-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  };
  const callTool = async (client, name) => {
    try { return await client.callTool({ name, arguments: { message: 'HTTP round trip' } }); }
    catch (error) { return { isError: true, thrown: String(error?.message ?? error) }; }
  };
  try {
    assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = await open(service.url);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...REPORT_TOOL_NAMES].sort());
    const result = await client.callTool({ name: 'ask_parent', arguments: { message: 'HTTP round trip' } });
    assert.notEqual(result.isError, true);
    assert.equal(parse(result).accepted, true);
    await client.close();

    const stranger = await open(unowned.url);
    const strangerTools = await stranger.listTools();
    assert.deepEqual(strangerTools.tools, []);
    const refused = await callTool(stranger, 'report_parent');
    assert.equal(refused.isError, true, 'a call to a surface with no tools can never be accepted');
    await stranger.close();

    const health = await fetch(`${unowned.url.replace('/mcp', '/healthz')}`).then(response => response.json());
    assert.equal(health.stats.unowned >= 1, true);
    assert.equal(health.stats.served >= 1, true);
    assert.deepEqual(calls.map(call => call.message), ['HTTP round trip']);
  } finally {
    await service.close();
    await unowned.close();
  }
});
