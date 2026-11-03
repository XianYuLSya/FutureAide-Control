// Protocol tests for the Claude managed-session report surface. They use injected
// identity and ownership so they say nothing about a live Claude session; the
// real caller identity is covered by claude-caller-identity.test.mjs and by the
// loopback probe in scripts/claude-report-probe.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createClaudeReportServer, createManagementServer, developmentOwnership, startHttpService,
  trustedContextOf, REPORT_TOOL_NAMES } from '../src/claude-report-server.mjs';

const sessionId = '6808231c-116c-4fc7-b9b0-4d790e763b0b';
const caller = { pid: 50124, sessionId, cwd: 'D:\\Work\\xiayuls_workflow', via: 'pid' };
const parse = result => JSON.parse(result.content[0].text);

function ownership({ accept = true, reportError } = {}) {
  const calls = [];
  const owned = {
    agentId: 'agent-test', agentName: '绘图副手', taskId: 7,
    async ask(input) { calls.push({ kind: 'ask', ...input }); return accept ? { accepted: true } : { accepted: false, code: 'task-busy' }; },
    async report(input) {
      calls.push({ kind: 'report', ...input });
      if (reportError) throw reportError;
      return accept ? { accepted: true } : { accepted: false, code: 'task-closed' };
    },
  };
  return { calls, owned };
}

async function inMemory(resolveOwned, resolveCaller = async () => caller, management) {
  const server = createClaudeReportServer({ resolveCaller, resolveOwned, management });
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
    agentId: 'agent-test', agentName: '绘图副手', taskId: 7,
    async ask() { return { accepted: true, receiptId: 'accept-ask' }; },
    async report({ final }) { finals.push(final); return { accepted: true, receiptId: final ? 'accept-final' : 'accept-progress' }; },
  };
  const { client, close } = await inMemory(async () => owned);
  try {
    const progress = parse(await client.callTool({ name: 'report_parent', arguments: { message: 'half way' } }));
    assert.deepEqual([progress.accepted, progress.taskId, progress.agentId, progress.final, progress.receiptId],
      [true, 7, 'agent-test', false, 'accept-progress']);
    const final = parse(await client.callTool({ name: 'report_parent', arguments: { message: 'delivered', final: true } }));
    assert.deepEqual([final.accepted, final.taskId, final.final, final.receiptId], [true, 7, true, 'accept-final']);
    const asked = parse(await client.callTool({ name: 'ask_parent', arguments: { message: 'which model?' } }));
    assert.deepEqual([asked.kind, asked.taskId, asked.agentId, asked.receiptId], ['question', 7, 'agent-test', 'accept-ask']);
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

test('a submission hands the tool, its arguments and any native tool-use id to ownership', async () => {
  const contexts = [];
  const owned = { agentId: 'agent-test', agentName: '绘图副手', taskId: 7,
    async ask() { return { accepted: true }; }, async report() { return { accepted: true }; } };
  const { client, close } = await inMemory(async (caller, context) => { contexts.push(context); return owned; });
  try {
    await client.listTools();
    await client.callTool({ name: 'report_parent', arguments: { message: 'delivered', final: true },
      _meta: { toolUseId: 'toolu_9' } });
    assert.equal(contexts.length, 1, 'only the submission asks ownership');
    const submission = contexts[0];
    assert.equal(submission.tool, 'report');
    assert.deepEqual(submission.input, { message: 'delivered', final: true });
    assert.equal(submission.toolUseId, 'toolu_9');
  } finally { await close(); }
});

test('an unbound session is adopted on its first list and gets the tools', async () => {
  let adopted = 0;
  let bound = false;
  const owned = { agentId: 'agent-x', agentName: '首列表副手', taskId: 3,
    async ask() { return { accepted: true }; }, async report() { return { accepted: true }; } };
  const service = await startHttpService({ port: 0,
    resolveCaller: async () => caller,
    resolveOwned: async () => (bound ? owned : null),
    adopt: async () => { adopted += 1; bound = true;
      return { adopted: true, agentId: 'agent-x', name: '首列表副手', waitedMs: 24 }; } });
  const client = new Client({ name: 'adopt-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...REPORT_TOOL_NAMES].sort());
    assert.equal(adopted, 1, 'adoption runs once, then ownership answers');
    assert.equal(service.stats.adopted, 1);
  } finally { await client.close(); await service.close(); }
});

// Stands in for the shared scoped registrar: one name-addressed tool, plus the
// caller/trusted thunks the real registrar uses as its owner key.
const managementRegistrar = seen => ({ server, caller, trusted }) => {
  seen.push({ caller, trusted });
  server.registerTool('futureaide_list_agents', { description: 'List this chat\'s subagents.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: '[]' }] }));
};

test('an owned session carries the management tools next to its own two', async () => {
  const seen = [];
  const owned = { agentId: 'agent-test', agentName: '绘图副手', taskId: 7,
    async ask() { return { accepted: true }; }, async report() { return { accepted: true }; } };
  const { client, close } = await inMemory(async () => owned, async () => caller, managementRegistrar(seen));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['ask_parent', 'futureaide_list_agents', 'report_parent']);
    assert.equal(seen.length, 1);
    assert.deepEqual(await seen[0].caller(), caller);
    assert.deepEqual(await seen[0].trusted(), { nativeSessionId: sessionId,
      workspace: 'D:\\Work\\xiayuls_workflow', pid: 50124, via: 'pid' });
    const result = await client.callTool({ name: 'futureaide_list_agents', arguments: {} });
    assert.equal(result.content[0].text, '[]');
  } finally { await close(); }
});

test('a verified session that is not owned gets the management tools and no report surface', async () => {
  const seen = [];
  const server = createManagementServer({ management: managementRegistrar(seen), caller });
  const client = new Client({ name: 'management-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['futureaide_list_agents']);
    const refused = await client.callTool({ name: 'report_parent', arguments: { message: 'x' } })
      .catch(error => ({ isError: true, thrown: String(error?.message ?? error) }));
    assert.equal(refused.isError, true, 'a parent session has no report surface');
    assert.deepEqual(await seen[0].trusted(), { nativeSessionId: sessionId,
      workspace: 'D:\\Work\\xiayuls_workflow', pid: 50124, via: 'pid' });
    assert.equal(client.getInstructions(), undefined, 'no reporting instructions for a parent session');
  } finally { await client.close(); await server.close(); }
});

test('the HTTP service gives a verified parent the management tools and an unknown peer none', async () => {
  const seen = [];
  const service = await startHttpService({ port: 0, resolveOwned: async () => null,
    resolveCaller: async () => caller, management: managementRegistrar(seen) });
  const stranger = await startHttpService({ port: 0, resolveOwned: async () => null,
    resolveCaller: async () => { throw Object.assign(new Error('nope'), { code: 'caller-unresolved' }); },
    management: managementRegistrar([]) });
  const open = async url => {
    const client = new Client({ name: 'management-http-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  };
  try {
    const parent = await open(service.url);
    assert.deepEqual((await parent.listTools()).tools.map(tool => tool.name), ['futureaide_list_agents']);
    await parent.close();

    const unknown = await open(stranger.url);
    assert.deepEqual((await unknown.listTools()).tools, []);
    await unknown.close();
    assert.equal(service.stats.unowned >= 1, true);
  } finally { await service.close(); await stranger.close(); }
});

test('the trusted context carries only what the connection proved', () => {
  assert.deepEqual(trustedContextOf(caller), { nativeSessionId: sessionId,
    workspace: 'D:\\Work\\xiayuls_workflow', pid: 50124, via: 'pid' });
  assert.equal(trustedContextOf({}), undefined);
  assert.equal(trustedContextOf({ sessionId }), undefined, 'a workspace is required');
  assert.ok(!('image' in trustedContextOf(caller)) && !('recordFile' in trustedContextOf(caller)));
});

test('a second binder on the same port is refused while the first keeps serving', async () => {
  const first = await startHttpService({ port: 0, resolveOwned: async () => null, resolveCaller: async () => caller });
  try {
    await assert.rejects(startHttpService({ port: first.port, resolveOwned: async () => null,
      resolveCaller: async () => caller }), error => {
      assert.equal(error.code, 'report-port-in-use');
      assert.match(error.message, /Only one report service may own this port/);
      return true;
    });
    const health = await fetch(`${first.url.replace('/mcp', '/healthz')}`).then(response => response.json());
    assert.equal(health.ok, true);
  } finally { await first.close(); }
});

test('identity is cached per TCP connection while ownership is re-read per request', async () => {
  let resolutions = 0;
  let ownershipChecks = 0;
  const lines = [];
  const service = await startHttpService({ port: 0,
    resolveOwned: async () => { ownershipChecks += 1; return { agentId: 'agent-x', taskId: 3,
      async ask() { return { accepted: true }; }, async report() { return { accepted: true }; } }; },
    resolveCaller: async () => { resolutions += 1; return { ...caller, image: 'claude.exe' }; },
    log: line => lines.push(line) });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const post = (agent, options = {}) => new Promise((resolve, reject) => {
    const request = http.request({ port: service.port, method: 'POST', path: '/mcp', agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        accept: 'application/json, text/event-stream' } }, response => {
      response.on('data', () => {});
      response.on('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end(body);
  });
  const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const oneShot = new http.Agent({ keepAlive: false });
  try {
    for (let index = 0; index < 3; index += 1) assert.equal(await post(keepAlive), 200);
    assert.equal(resolutions, 1, 'three requests on one socket cost one identity lookup');
    assert.equal(ownershipChecks, 3, 'the running task is re-read every request');
    assert.equal(lines.filter(line => line.startsWith('connection from')).length, 1);
    assert.match(lines.join('\n'), /claude\.exe pid=50124/);

    // A fresh connection is a fresh peer and is resolved again.
    await post(oneShot);
    assert.equal(resolutions, 2);
  } finally {
    keepAlive.destroy();
    oneShot.destroy();
    await service.close();
  }
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
