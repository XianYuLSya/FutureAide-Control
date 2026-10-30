import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeServer } from '../src/mcp-server.mjs';
import { createPeers } from '../src/peers.mjs';

test('two MCP clients register native peers and exchange a durable answer in both directions', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'futureaide-peers-mcp-'));
  const workspace = await realpath(temporary);
  const configPath = path.join(workspace, '配置 with spaces.json');
  await writeFile(configPath, JSON.stringify({ workspace }));
  const threadId = '11111111-1111-4111-8111-111111111111';
  const agentId = 'agent-' + 'a'.repeat(32);
  const deliveries = [], dispatched = [], reads = [];
  const agents = {
    list: async () => ({ items: [{ agentId, workspace }] }),
    followup: async input => { dispatched.push(input); return { accepted: true, requestId: input.requestId }; },
    wait: async input => { reads.push(input); return { state: 'completed', reply: 'DSH_NATIVE_ANSWER' }; },
    archive: async () => ({ accepted: true }),
  };
  const codexCall = async (targetId, name, args) => {
    assert.equal(targetId, threadId);
    if (name === 'read_thread') return { content: [{ type: 'text', text: JSON.stringify({ thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } }) }] };
    assert.equal(name, 'send_message_to_thread');
    assert.deepEqual(Object.keys(args).sort(), ['prompt', 'threadId']);
    deliveries.push(args);
    return { content: [{ type: 'text', text: JSON.stringify({ accepted: true }) }] };
  };
  const connections = [];
  t.after(async () => {
    for (const { client, server } of connections) { await client.close(); await server.close(); }
    assert.ok(path.basename(temporary).startsWith('futureaide-peers-mcp-'));
    await rm(temporary, { recursive: true, force: true });
  });
  async function connect() {
    const server = makeServer(undefined, { configPath, peersFactory: config => createPeers(config, { agentsFactory: () => agents, codexCall, startWorker: async () => process.pid }) });
    const client = new Client({ name: 'peer-integration', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, server });
    return async (name, args) => {
      const result = await client.callTool({ name: 'futureaide_' + name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return JSON.parse(result.content[0].text);
    };
  }
  const caller = await connect();
  await caller('register_peer', { peer_id: 'desktop', kind: 'codex-desktop', workspace, thread_id: threadId });
  await caller('register_peer', { peer_id: 'dsh', kind: 'dsh', workspace, agent_id: agentId });
  const question = { from_peer_id: 'dsh', to_peer_id: 'desktop', message: 'Which runtime answers?', request_id: 'question-1' };
  const sent = await caller('send_peer', question);
  assert.equal(sent.accepted, true);
  assert.equal(sent.state, 'pending');
  assert.match(deliveries[0].prompt, new RegExp(sent.exchangeId));
  assert.ok(deliveries[0].prompt.includes(`--config "${configPath}"`));
  const receiver = await connect();
  const pending = await receiver('read_exchange', { exchange_id: sent.exchangeId });
  assert.equal(pending.state, 'pending');
  await receiver('reply_exchange', { exchange_id: sent.exchangeId, peer_id: 'desktop', message: 'The existing desktop runtime.', request_id: 'reply-1' });
  const collected = await caller('read_exchange', { exchange_id: sent.exchangeId });
  assert.equal(collected.state, 'completed');
  assert.equal(collected.reply.message, 'The existing desktop runtime.');
  const duplicate = await receiver('send_peer', question);
  assert.equal(duplicate.exchangeId, sent.exchangeId);
  assert.equal(duplicate.duplicate, true);
  assert.equal(deliveries.length, 1);
  const reverse = await receiver('send_peer', { from_peer_id: 'desktop', to_peer_id: 'dsh', message: 'Check the answer.', request_id: 'reverse-1' });
  const answer = await caller('read_exchange', { exchange_id: reverse.exchangeId });
  assert.equal(answer.state, 'completed');
  assert.equal(answer.reply.message, 'DSH_NATIVE_ANSWER');
  assert.equal(reads.at(-1).requestId, dispatched[0].requestId);
  await receiver('unregister_peer', { peer_id: 'dsh' });
  const listing = await caller('list_peers', {});
  assert.equal(listing.items.find(peer => peer.peerId === 'dsh').state, 'disabled');
  assert.equal((await caller('read_exchange', { exchange_id: sent.exchangeId })).reply.message, collected.reply.message);
});
