// The cold-start bridge: ensure the one shared monitor, then forward. Everything
// that touches the environment is injected, so these check the decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startColdStartBridge } from '../src/claude-report-bootstrap.mjs';

const config = { configFile: 'D:\\c\\config.json', stateDirectory: 'D:\\c\\state' };

function remote({ tools = [{ name: 'futureaide_status', inputSchema: { type: 'object' } },
  { name: 'ask_parent', inputSchema: { type: 'object' } }], onCall } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async listTools() { return { tools }; },
      async callTool(request) {
        calls.push(request);
        if (onCall) return onCall(request);
        return { content: [{ type: 'text', text: JSON.stringify({ accepted: true }) }] };
      },
      async close() {},
    },
  };
}

const wired = async (options = {}) => {
  const fake = remote(options.remote);
  const events = [];
  const bridge = await startColdStartBridge({
    configPath: 'D:\\c\\config.json',
    load: async () => config,
    storeFor: () => ({ identity: () => 'roster-1' }),
    status: options.status ?? (async () => ({ ready: true })),
    ensure: async () => { events.push('ensure'); return true; },
    connect: async () => fake.client,
    log: message => events.push(`log:${message}`),
    waitMs: options.waitMs ?? 300, pollMs: 0,
    ...options.overrides,
  });
  return { bridge, fake, events };
};

const roundTrip = async server => {
  const client = new Client({ name: 'bootstrap-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, close: () => client.close() };
};

test('a healthy service is bridged without starting anything', async () => {
  const { bridge, fake, events } = await wired();
  assert.equal(bridge.ready, true);
  assert.equal(bridge.tools, 2);
  assert.deepEqual(events.filter(event => event === 'ensure'), [], 'a healthy monitor is left alone');

  const { client, close } = await roundTrip(bridge.server);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['futureaide_status', 'ask_parent']);
    const result = await client.callTool({ name: 'ask_parent', arguments: { message: 'hi' } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(fake.calls.map(call => call.name), ['ask_parent']);
    assert.deepEqual(fake.calls[0].arguments, { message: 'hi' });
  } finally { await close(); await bridge.close(); }
});

test('a cold start asks for the one shared monitor and waits for it', async () => {
  let checks = 0;
  const { bridge, events } = await wired({
    status: async () => { checks += 1; return { ready: checks > 2 }; },
  });
  assert.equal(bridge.ready, true);
  assert.equal(events.filter(event => event === 'ensure').length, 1);
  assert.equal(checks >= 3, true);
  await bridge.close();
});

test('a service that never answers serves no tools instead of broken ones', async () => {
  const { bridge, events } = await wired({
    status: async () => ({ ready: false }),
    waitMs: 40,
  });
  assert.equal(bridge.ready, false);
  assert.equal(bridge.tools, 0);
  assert.equal(events.some(event => /did not answer/.test(event)), true);
  const { client, close } = await roundTrip(bridge.server);
  try {
    assert.deepEqual((await client.listTools()).tools, []);
    const result = await client.callTool({ name: 'ask_parent', arguments: { message: 'hi' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /report-service-unavailable/);
  } finally { await close(); await bridge.close(); }
});

test('a call that loses the service reopens the one monitor and retries once', async () => {
  let attempts = 0;
  const fake = remote({ onCall: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('socket closed');
    return { content: [{ type: 'text', text: JSON.stringify({ accepted: true }) }] };
  } });
  const events = [];
  let connects = 0;
  const bridge = await startColdStartBridge({
    configPath: 'D:\\c\\config.json',
    load: async () => config,
    storeFor: () => ({ identity: () => 'roster-1' }),
    status: async () => ({ ready: true }),
    ensure: async () => { events.push('ensure'); return true; },
    connect: async () => { connects += 1; return fake.client; },
    log: () => {}, waitMs: 100, pollMs: 0,
  });
  const { client, close } = await roundTrip(bridge.server);
  try {
    const result = await client.callTool({ name: 'futureaide_status', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(attempts, 2, 'one retry after a reopen');
    assert.equal(connects, 2, 'the bridge reconnects to the same service');
    assert.deepEqual(events, ['ensure']);
  } finally { await close(); await bridge.close(); }
});

test('a call that keeps failing becomes a coded error, not a hang', async () => {
  const fake = remote({ onCall: async () => { throw new Error('still down'); } });
  const bridge = await startColdStartBridge({
    configPath: 'D:\\c\\config.json',
    load: async () => config,
    storeFor: () => ({ identity: () => 'roster-1' }),
    status: async () => ({ ready: true }),
    ensure: async () => true,
    connect: async () => fake.client,
    log: () => {}, waitMs: 20, pollMs: 0,
  });
  const { client, close } = await roundTrip(bridge.server);
  try {
    const result = await client.callTool({ name: 'ask_parent', arguments: { message: 'x' } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'report-service-unavailable');
  } finally { await close(); await bridge.close(); }
});

test('a bridge without configuration serves no tools and says why', async () => {
  const events = [];
  const bridge = await startColdStartBridge({
    configPath: undefined,
    load: async () => { throw Object.assign(new Error('missing'), { code: 'config-missing' }); },
    log: message => events.push(message),
  });
  assert.equal(bridge.ready, false);
  assert.equal(bridge.tools, 0);
  assert.match(events.join('\n'), /config-missing/);
  await bridge.close();
});
