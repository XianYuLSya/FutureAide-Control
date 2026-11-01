import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeScopedServer } from '../src/mcp-server.mjs';

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
    assert.equal(tools.length, 10);
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
