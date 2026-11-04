// The cold-start bridge: it prepares the one shared monitor before forwarding, it
// never replays a write whose answer was lost, and a service it could not reach is
// an explicit error that a later attempt can recover from. Everything that touches
// the environment is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mayRetry, READ_ONLY_TOOLS, startColdStartBridge } from '../src/claude-report-bootstrap.mjs';

const config = { configFile: 'D:\\c\\config.json', stateDirectory: 'D:\\c\\state' };
const TOOLS = [{ name: 'futureaide_status', inputSchema: { type: 'object' } },
  { name: 'ask_parent', inputSchema: { type: 'object' } }];

function remote({ tools = TOOLS, onCall } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async listTools() { return { tools }; },
      async callTool(request) {
        calls.push(request);
        if (onCall) return onCall(request, calls.length);
        return { content: [{ type: 'text', text: JSON.stringify({ accepted: true }) }] };
      },
      async close() {},
    },
  };
}

async function bridgeWith(options = {}) {
  const fake = remote(options.remote);
  const events = [];
  let connects = 0;
  const store = { identity: () => 'roster-1', closed: 0, close() { this.closed += 1; } };
  const bridge = await startColdStartBridge({
    configPath: 'D:\\c\\config.json',
    load: async () => config,
    storeFor: () => store,
    status: options.status ?? (async () => ({ ready: true })),
    ensure: async () => { events.push('ensure'); return true; },
    connect: async () => { connects += 1; return fake.client; },
    log: message => events.push(`log:${message}`),
    waitMs: options.waitMs ?? 60, pollMs: 0,
  });
  return { bridge, fake, events, store, connects: () => connects };
}

const roundTrip = async server => {
  const client = new Client({ name: 'bootstrap-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, close: () => client.close() };
};

test('a healthy service is bridged without starting anything', async () => {
  const { bridge, fake, events } = await bridgeWith();
  assert.equal(bridge.ready, true);
  assert.equal(bridge.tools, 2);
  assert.deepEqual(events.filter(event => event === 'ensure'), [], 'a healthy monitor is left alone');

  const { client, close } = await roundTrip(bridge.server);
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name),
      ['futureaide_status', 'ask_parent']);
    const result = await client.callTool({ name: 'ask_parent', arguments: { message: 'hi' } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(fake.calls.map(call => call.name), ['ask_parent']);
  } finally { await close(); await bridge.close(); }
});

test('a cold start asks for the one shared monitor and waits for it', async () => {
  let checks = 0;
  const { bridge, events } = await bridgeWith({
    status: async () => { checks += 1; return { ready: checks > 2 }; },
  });
  assert.equal(bridge.ready, true);
  assert.equal(events.filter(event => event === 'ensure').length, 1);
  await bridge.close();
});

test('an unreachable service is an explicit error that a later attempt recovers from', async () => {
  let healthy = false;
  const { bridge, events } = await bridgeWith({
    status: async () => ({ ready: healthy }),
    waitMs: 30,
  });
  assert.equal(bridge.tools, 0);
  assert.equal(bridge.ready, false);

  const { client, close } = await roundTrip(bridge.server);
  try {
    // Listing must say it is unavailable instead of quietly returning no tools.
    await assert.rejects(client.listTools(), /not reachable|report-service-unavailable/);
    const failed = await client.callTool({ name: 'futureaide_status', arguments: {} });
    assert.equal(failed.isError, true);
    assert.equal(JSON.parse(failed.content[0].text).error.code, 'report-service-unavailable');

    // The monitor comes back: the same bridge serves tools afterwards.
    healthy = true;
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['futureaide_status', 'ask_parent']);
    assert.equal(events.filter(event => event === 'ensure').length >= 1, true);
  } finally { await close(); await bridge.close(); }
});

test('a write whose answer was lost is never replayed', async () => {
  const { bridge, fake, connects } = await bridgeWith({
    remote: { onCall: async () => { throw new Error('socket closed after the write'); } },
  });
  const { client, close } = await roundTrip(bridge.server);
  try {
    const result = await client.callTool({ name: 'futureaide_send_agent', arguments: { name: 'a', message: 'go' } });
    assert.equal(fake.calls.length, 1, 'exactly one attempt reaches the service');
    assert.equal(connects(), 1, 'no reconnect-and-replay for a write');
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.error.code, 'write-outcome-unknown');
    assert.equal(payload.error.operation, 'futureaide_send_agent');
  } finally { await close(); await bridge.close(); }
});

test('a read-only call that loses the connection is retried once', async () => {
  const { bridge, fake } = await bridgeWith({
    remote: { onCall: async (_request, attempt) => {
      if (attempt === 1) throw new Error('socket closed');
      return { content: [{ type: 'text', text: '[]' }] };
    } },
  });
  const { client, close } = await roundTrip(bridge.server);
  try {
    const result = await client.callTool({ name: 'futureaide_list_agents', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(fake.calls.length, 2);
  } finally { await close(); await bridge.close(); }
});

test('only reads and keyed calls may be retried', () => {
  for (const name of READ_ONLY_TOOLS) assert.equal(mayRetry(name, {}), true, name);
  for (const name of ['futureaide_send_agent', 'futureaide_answer_agent', 'futureaide_create_agent',
    'futureaide_cancel_agent', 'futureaide_delete_agent', 'ask_parent', 'report_parent']) {
    assert.equal(mayRetry(name, {}), false, name);
  }
  assert.equal(mayRetry('futureaide_send_agent', { request_id: 'r-1' }), true);
});

test('closing the bridge closes both the client and the roster handle', async () => {
  const { bridge, store } = await bridgeWith();
  await bridge.close();
  assert.equal(store.closed, 1);
});

test('a bridge without configuration reports that instead of serving silence', async () => {
  const events = [];
  const bridge = await startColdStartBridge({
    configPath: undefined,
    load: async () => { throw Object.assign(new Error('missing'), { code: 'config-missing' }); },
    log: message => events.push(message),
  });
  assert.equal(bridge.ready, false);
  assert.match(events.join('\n'), /config-missing/);
  const { client, close } = await roundTrip(bridge.server);
  try {
    await assert.rejects(client.listTools(), /configuration|unavailable/);
    const result = await client.callTool({ name: 'futureaide_status', arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).error.code, 'configuration-unavailable');
  } finally { await close(); await bridge.close(); }
});
