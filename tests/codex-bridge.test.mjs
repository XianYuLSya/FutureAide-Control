import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { callCodexTool, discoverCodexBridge, invokeCodexTool } from '../src/codex-notify.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const windows = process.platform === 'win32';
const threadId = '11111111-1111-4111-8111-111111111111';
const bridgePipe = () => String.raw`\\.\pipe\codex-app-tools-` + randomUUID();

// A stand-in for the bundled app-tools MCP server. It speaks the real SDK handshake and returns a
// controlled result, so invokeCodexTool is exercised through the same stdio transport the desktop
// bridge uses without touching a real chat.
const FAKE_SERVER = String.raw`
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fake-app-tools', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'read_thread', description: 'fake read', inputSchema: { type: 'object', additionalProperties: true } },
    { name: 'send_message_to_thread', description: 'fake send', inputSchema: { type: 'object', additionalProperties: true } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const args = request.params.arguments ?? {};
  const meta = request.params._meta ?? {};
  if (args.mode === 'error') return { content: [{ type: 'text', text: 'rejected by fake' }], isError: true };
  if (args.mode === 'empty') return { content: [], isError: false };
  return {
    content: [{ type: 'text', text: JSON.stringify({ tool: request.params.name, args, meta }) }],
    structuredContent: { tool: request.params.name, args },
    isError: false,
  };
});
await server.connect(new StdioServerTransport());
`;

async function fakeBridge(t) {
  const directory = await mkdtemp(path.join(testRoot, '.bridge-test-'));
  t.after(async () => {
    assert.ok(directory.startsWith(testRoot + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const serverPath = path.join(directory, 'server.mjs');
  await writeFile(serverPath, FAKE_SERVER, 'utf8');
  return { serverPath, pipePath: bridgePipe() };
}

test('invokeCodexTool returns the complete MCP result and forwards thread metadata', { skip: !windows }, async t => {
  const bridge = await fakeBridge(t);
  const result = await invokeCodexTool(threadId, 'read_thread', { threadId, turnLimit: 2 }, { bridge });
  assert.deepEqual(Object.keys(result).sort(), ['content', 'isError', 'structuredContent']);
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, { tool: 'read_thread', args: { threadId, turnLimit: 2 } });
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const data = JSON.parse(text);
  assert.equal(data.tool, 'read_thread');
  assert.equal(data.args.threadId, threadId);
  assert.equal(data.args.turnLimit, 2);
  assert.equal(data.meta['openai/threadId'], threadId);
});

test('callCodexTool keeps its accepted contract while using the bridge invocation', { skip: !windows }, async t => {
  const bridge = await fakeBridge(t);
  assert.deepEqual(await callCodexTool(threadId, 'read_thread', { threadId }, { bridge }), { accepted: true, threadId });

  const calls = [];
  const result = await callCodexTool(threadId, 'send_message_to_thread', { threadId, prompt: 'not sent' }, {
    invoke: async (...args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: 'accepted' }], isError: false };
    },
  });
  assert.deepEqual(result, { accepted: true, threadId });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), [threadId, 'send_message_to_thread', { threadId, prompt: 'not sent' }]);
});

test('a real isError result stays visible to invoke and is never accepted', { skip: !windows }, async t => {
  const bridge = await fakeBridge(t);
  const raw = await invokeCodexTool(threadId, 'send_message_to_thread', { mode: 'error' }, { bridge });
  assert.equal(raw.isError, true);
  assert.equal(raw.content[0].text, 'rejected by fake');
  await assert.rejects(callCodexTool(threadId, 'read_thread', { mode: 'error' }, { bridge }), /rejected/);
  await assert.rejects(callCodexTool(threadId, 'read_thread', { threadId }, {
    invoke: async () => ({ content: [{ type: 'text', text: 'no' }], isError: true }),
  }), /rejected/);
});

test('malformed or empty results are never accepted', async () => {
  for (const result of [null, {}, { content: [] }, { content: 'text' }, { content: [{}] },
    { content: [{ type: 'text' }], isError: 'false' }, { isError: false }]) {
    await assert.rejects(callCodexTool(threadId, 'read_thread', { threadId }, { invoke: async () => result }),
      /incomplete/, JSON.stringify(result));
  }
});

test('only the allowlisted coordination tools and a valid task ID reach discovery', async () => {
  let inspected = 0;
  const discover = async () => { inspected++; return { serverPath: path.join(testRoot, 'server.mjs'), pipePath: bridgePipe() }; };
  await assert.rejects(invokeCodexTool('not-a-uuid', 'read_thread', {}, { discover }), /target Codex task ID/);
  // create_thread stays outside the bridge: the desktop requires executor thread metadata, so it is
  // not a usable fallback for starting work and must never be silently invoked.
  await assert.rejects(invokeCodexTool(threadId, 'create_thread', { prompt: 'x' }, { discover }), /Unsupported/);
  await assert.rejects(invokeCodexTool(threadId, 'send_message_to_thread', [], { discover }), /arguments must be an object/);
  assert.equal(inspected, 0);
});

test('an explicit bridge locator is used as-is and never starts a fallback', { skip: !windows }, async t => {
  const bridge = await fakeBridge(t);
  let inspected = 0;
  const result = await invokeCodexTool(threadId, 'read_thread', { threadId }, {
    bridge,
    discover: async () => { inspected++; throw new Error('discovery must not run'); },
  });
  assert.equal(result.isError, false);
  assert.equal(inspected, 0);

  await assert.rejects(invokeCodexTool(threadId, 'read_thread', { threadId }, {
    bridge: { serverPath: 'codex.exe', pipePath: bridge.pipePath },
    discover: async () => { inspected++; return bridge; },
  }), /explicit Codex bridge/);
  await assert.rejects(invokeCodexTool(threadId, 'read_thread', { threadId }, {
    bridge: { serverPath: path.join(testRoot, 'not-server.mjs'), pipePath: bridge.pipePath },
    discover: async () => { inspected++; return bridge; },
  }), /explicit Codex bridge/);
  await assert.rejects(invokeCodexTool(threadId, 'read_thread', { threadId }, {
    bridge: { serverPath: bridge.serverPath, pipePath: String.raw`\\.\pipe\codex-app-tools-not-a-uuid` },
    discover: async () => { inspected++; return bridge; },
  }), /explicit Codex bridge/);
  assert.equal(inspected, 0);
});

test('a malformed discovery answer is refused before anything is spawned', async () => {
  await assert.rejects(invokeCodexTool(threadId, 'read_thread', { threadId }, {
    discover: async () => ({ serverPath: path.join(testRoot, 'server.mjs') }),
  }), /bridge is unavailable/);
  await assert.rejects(invokeCodexTool(threadId, 'read_thread', { threadId }, {
    discover: async () => { throw new Error('desktop not running'); },
  }), /desktop not running/);
});

const liveThread = process.env.CODEX_BRIDGE_LIVE_THREAD;
test('a live desktop read_thread returns real thread data without sending anything', { skip: !windows || !liveThread }, async () => {
  const bridge = await discoverCodexBridge({ environment: {} });
  const result = await invokeCodexTool(liveThread, 'read_thread', {
    threadId: liveThread, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0,
  }, { bridge });
  assert.equal(result.isError, false);
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const data = JSON.parse(text);
  assert.equal(data.thread.id, liveThread);
  assert.ok(Array.isArray(data.turns));
  assert.ok(data.turns.length <= 1);
});
