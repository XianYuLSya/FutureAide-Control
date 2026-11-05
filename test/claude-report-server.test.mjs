// Protocol tests for the loopback management tool surface. They use an injected
// caller so they say nothing about a live Claude session; the real caller identity
// is covered by claude-caller-identity.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createClaudeReportServer, INSTRUCTIONS, startHttpService,
  trustedContextOf } from '../src/claude-report-server.mjs';

const sessionId = '6808231c-116c-4fc7-b9b0-4d790e763b0b';
const trustedShape = { source: 'claude-desktop', nativeSessionId: sessionId,
  workspace: 'D:\\Work\\xiayuls_workflow', pid: 50124, via: 'pid' };
const caller = { pid: 50124, sessionId, cwd: 'D:\\Work\\xiayuls_workflow', via: 'pid' };

async function inMemory(resolveCaller = async () => caller, management) {
  const server = createClaudeReportServer({ resolveCaller, management });
  const client = new Client({ name: 'protocol-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, server, close: async () => { await client.close(); await server.close(); } };
}

// Stands in for the shared scoped registrar: one name-addressed tool, plus the
// caller/trusted thunks the real registrar uses as its owner key.
const managementRegistrar = seen => ({ server, caller: resolve, trusted }) => {
  seen.push({ caller: resolve, trusted });
  server.registerTool('futureaide_list_agents', { description: 'List this chat\'s subagents.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: '[]' }] }));
};

test('the surface carries the management tools and no reporting tools of its own', async () => {
  const seen = [];
  const { client, close } = await inMemory(async () => caller, managementRegistrar(seen));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['futureaide_list_agents']);
    assert.equal(seen.length, 1);
    const instructions = client.getInstructions();
    assert.match(instructions, /FutureAide Control management tools/);
    assert.match(instructions, /identified from this connection itself/);
    assert.match(instructions, /never look for one/);
    assert.doesNotMatch(instructions, /ask_parent|report_parent|managed session bridge/);
  } finally { await close(); }
});

test('a management tool call is served on the same server', async () => {
  const { client, close } = await inMemory(async () => caller, managementRegistrar([]));
  try {
    const result = await client.callTool({ name: 'futureaide_list_agents', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].text, '[]');
  } finally { await close(); }
});

test('the trusted caller carries only what the connection proved', () => {
  assert.deepEqual(trustedContextOf(caller), trustedShape);
  assert.equal(trustedContextOf({}), undefined);
  assert.equal(trustedContextOf({ sessionId }), undefined, 'a workspace is required');
  const full = trustedContextOf({ ...caller, hostSessionId: 'local_1', name: '测试会话',
    procStart: '134381970992798945', pidDomain: 'win32:h', socketPath: '\\\\.\\pipe\\p',
    recordFile: 'D:\\s\\50124.json', directory: 'D:\\s', image: 'claude.exe', peerToken: 'secret' });
  assert.deepEqual(full, { source: 'claude-desktop', nativeSessionId: sessionId,
    workspace: 'D:\\Work\\xiayuls_workflow', pid: 50124, procStart: '134381970992798945',
    pidDomain: 'win32:h', socketPath: '\\\\.\\pipe\\p', recordFile: 'D:\\s\\50124.json',
    directory: 'D:\\s', hostSessionId: 'local_1', label: '测试会话', via: 'pid' });
  assert.ok(!('peerToken' in full) && !('image' in full));
  assert.ok(!JSON.stringify(full).includes('secret'));
});

test('the service instructions stay short and name no session argument', () => {
  assert.ok(INSTRUCTIONS.length < 400, `instructions are ${INSTRUCTIONS.length} characters`);
  assert.doesNotMatch(INSTRUCTIONS, /ask_parent|report_parent/);
  assert.match(INSTRUCTIONS, /no session id, chat id, name or route is accepted as an argument/);
});

test('a second binder on the same port is refused while the first keeps serving', async () => {
  const first = await startHttpService({ port: 0, resolveCaller: async () => caller });
  try {
    await assert.rejects(startHttpService({ port: first.port, resolveCaller: async () => caller }), error => {
      assert.equal(error.code, 'report-port-in-use');
      assert.match(error.message, /Only one report service may own this port/);
      return true;
    });
    const health = await fetch(`${first.url.replace('/mcp', '/healthz')}`).then(response => response.json());
    assert.equal(health.ok, true);
  } finally { await first.close(); }
});

test('identity is cached per TCP connection while an unidentified peer gets no tools', async () => {
  let resolutions = 0;
  const lines = [];
  const service = await startHttpService({ port: 0, management: managementRegistrar([]),
    resolveCaller: async () => { resolutions += 1; return { ...caller, image: 'claude.exe' }; },
    log: line => lines.push(line) });
  const stranger = await startHttpService({ port: 0,
    resolveCaller: async () => { throw Object.assign(new Error('nope'), { code: 'caller-unresolved' }); },
    log: () => {} });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const post = (target, agent) => new Promise((resolve, reject) => {
    const request = http.request({ port: target.port, method: 'POST', path: '/mcp', agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        accept: 'application/json, text/event-stream' } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve(text));
    });
    request.once('error', reject);
    request.end(body);
  });
  const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const oneShot = new http.Agent({ keepAlive: false });
  try {
    let listed;
    for (let index = 0; index < 3; index += 1) listed = await post(service, keepAlive);
    assert.match(listed, /futureaide_list_agents/);
    assert.equal(resolutions, 1, 'three requests on one socket cost one identity lookup');
    assert.equal(lines.filter(line => line.startsWith('connection from')).length, 1);
    assert.match(lines.join('\n'), /claude\.exe pid=50124/);

    // A fresh connection is a fresh peer and is resolved again.
    await post(service, oneShot);
    assert.equal(resolutions, 2);

    // An unidentified peer reaches a connected surface that lists nothing.
    const open = async url => {
      const client = new Client({ name: 'unknown-peer-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      return client;
    };
    const unknown = await open(stranger.url);
    try { assert.deepEqual((await unknown.listTools()).tools, []); }
    finally { await unknown.close(); }
    const health = await fetch(`${stranger.url.replace('/mcp', '/healthz')}`).then(response => response.json());
    assert.equal(health.stats.unidentified >= 1, true);
  } finally {
    keepAlive.destroy();
    oneShot.destroy();
    await service.close();
    await stranger.close();
  }
});

// A tool call that has to re-identify its caller pays two process lookups first, so
// the connection has to survive the idle gap between two ordinary calls.
const keepAlivePost = (url, agent, body) => new Promise((resolve, reject) => {
  const request = http.request(url, { method: 'POST', agent,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
  request.on('error', reject);
  request.end(JSON.stringify(body));
});

const mcpInitialize = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'keep-alive-test', version: '1' } } };
const mcpListTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

test('a warm connection keeps its identity across an idle gap and close does not wait for it', async () => {
  let resolved = 0;
  const service = await startHttpService({ port: 0,
    resolveCaller: async () => { resolved += 1; return { sessionId: 'keep-alive', cwd: process.cwd(), pid: process.pid }; } });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    assert.equal(service.server.keepAliveTimeout, 600000, 'the pooled socket outlives the old 5 second default');
    const first = await keepAlivePost(service.url, agent, mcpInitialize);
    assert.equal(first.status, 200);
    assert.match(first.headers['keep-alive'] ?? '', /timeout=600/, 'the caller is told the connection stays open');
    assert.equal(resolved, 1);

    await new Promise(resolve => setTimeout(resolve, 5500));
    const second = await keepAlivePost(service.url, agent, mcpListTools);
    assert.equal(second.status, 200);
    assert.equal(resolved, 1, 'one idle gap must not cost a second identity lookup');

    // A new socket is a new caller: the cached identity belongs to the old peer.
    const stranger = new http.Agent({ keepAlive: false });
    await keepAlivePost(service.url, stranger, mcpListTools);
    assert.equal(resolved, 2);
    stranger.destroy();

    // Closing must not wait for the idle keep-alive socket we are still holding.
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(closed, true, 'an idle pooled connection must not hold close open');
    await closing;
  } finally {
    agent.destroy();
    // A failed assertion must still release the listener, or the run would never end.
    await service.close().catch(() => {});
  }
});
