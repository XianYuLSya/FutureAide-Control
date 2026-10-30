import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.mjs';
import { makeServer } from '../src/mcp-server.mjs';
import { createPeers } from '../src/peers.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const agentId = 'agent-' + 'a'.repeat(32);
const runFile = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

async function harness(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'futureaide-peer-lifecycle-'));
  const workspace = await realpath(temporary);
  const configPath = path.join(workspace, '配置 with spaces.json');
  await writeFile(configPath, JSON.stringify({ workspace }));
  const turns = new Map([['bootstrap', { state: 'completed', reply: 'ready' }]]);
  const heldWaits = new Map();
  let currentRequest = 'bootstrap';
  const dispatches = [], notices = [];
  const agents = {
    list: async () => ({ items: [{ agentId, workspace, requestId: currentRequest, state: turns.get(currentRequest).state }] }),
    followup: async input => {
      if (turns.get(currentRequest).state === 'running') return { accepted: false, state: 'busy' };
      dispatches.push(input);
      currentRequest = input.requestId;
      turns.set(currentRequest, { state: 'running' });
      return { accepted: true, requestId: currentRequest, state: 'running' };
    },
    wait: async input => {
      const result = { ...turns.get(input.requestId), requestId: input.requestId };
      const hold = heldWaits.get(input.requestId);
      if (hold) {
        heldWaits.delete(input.requestId);
        hold.reached();
        await hold.block;
      }
      return result;
    },
    archive: async () => ({ accepted: true }),
  };
  const codexCall = async (id, name, args) => {
    assert.equal(id, threadId);
    if (name === 'read_thread') return { content: [{ type: 'text', text: JSON.stringify({ thread: { id, kind: 'codex', hostId: 'local', cwd: workspace } }) }] };
    assert.equal(name, 'send_message_to_thread');
    notices.push(args.prompt);
    return { content: [{ type: 'text', text: JSON.stringify({ accepted: true }) }] };
  };
  const deps = { agentsFactory: () => agents, codexCall, startWorker: async () => process.pid };
  const server = makeServer(undefined, { configPath, peersFactory: config => createPeers(config, deps) });
  const client = new Client({ name: 'peer-lifecycle-integration', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const consumer = createPeers(await loadConfig(configPath), deps);
  t.after(async () => {
    await client.close();
    await server.close();
    assert.ok(path.basename(temporary).startsWith('futureaide-peer-lifecycle-'));
    await rm(temporary, { recursive: true, force: true });
  });
  const call = async (name, args) => {
    const result = await client.callTool({ name: 'futureaide_' + name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return JSON.parse(result.content[0].text);
  };
  await call('register_peer', { peer_id: 'desktop', kind: 'codex-desktop', workspace, thread_id: threadId });
  await call('register_peer', { peer_id: 'dsh', kind: 'dsh', workspace, agent_id: agentId });
  return {
    call, dispatches, notices,
    pump: exchangeId => consumer.pump({ exchangeId }),
    finish: (requestId, reply) => { assert.ok(turns.has(requestId)); turns.set(requestId, { state: 'completed', reply }); },
    holdNextWait: requestId => {
      let reached, release;
      const ready = new Promise(resolve => { reached = resolve; });
      const block = new Promise(resolve => { release = resolve; });
      heldWaits.set(requestId, { reached, block });
      return { ready, release };
    },
    replyCli: async (exchangeId, message, requestId) => {
      const messageFile = path.join(workspace, '回答 with spaces.txt');
      await writeFile(messageFile, message);
      const { stdout } = await runFile(process.execPath, [cliPath, 'reply-exchange', '--config', configPath,
        '--exchange-id', exchangeId, '--peer-id', 'desktop', '--message-file', messageFile, '--request-id', requestId], { windowsHide: true });
      return JSON.parse(stdout);
    },
  };
}

test('MCP parent task survives a released question turn and returns the resumed final result once', async t => {
  const h = await harness(t);
  const parent = await h.call('send_peer', { from_peer_id: 'desktop', to_peer_id: 'dsh', message: 'Build the result after asking for the required value.', request_id: 'parent' });
  const firstRequest = h.dispatches[0].requestId;
  const question = await h.call('send_peer', { from_peer_id: 'dsh', to_peer_id: 'desktop', message: 'Which value?', request_id: 'question', parent_exchange_id: parent.exchangeId });
  assert.equal(question.parentExchangeId, parent.exchangeId);
  h.finish(firstRequest, 'Waiting for the question answer; the original task is unfinished.');
  await h.pump(parent.exchangeId);
  const waiting = await h.call('read_exchange', { exchange_id: parent.exchangeId });
  assert.equal(waiting.state, 'awaiting_input');
  assert.equal(h.notices.length, 1, 'only the question has been sent; the task must not report completion');

  const answer = await h.replyCli(question.exchangeId, 'VALUE-47', 'answer');
  assert.equal(answer.state, 'completed', 'a separate CLI process must reply into the same custom Unicode configuration root');
  await h.pump(question.exchangeId);
  await h.pump(parent.exchangeId);
  assert.equal(h.dispatches.length, 2, 'the answer resumes the existing DSH agent once');
  assert.ok(h.dispatches[1].message.includes('VALUE-47'));
  assert.ok(h.dispatches[1].message.includes(parent.exchangeId));
  assert.ok(h.dispatches.every(dispatch => dispatch.suppressCallback === true));
  await h.pump(question.exchangeId);
  assert.equal(h.dispatches.length, 2);
  await h.pump(parent.exchangeId);
  const resuming = await h.call('read_exchange', { exchange_id: parent.exchangeId });
  assert.notEqual(resuming.state, 'completed', 'a running continuation must not reuse the original waiting response as its final result');
  assert.equal(h.notices.length, 1);

  const resumedRequest = h.dispatches[1].requestId;
  h.finish(resumedRequest, 'BUILT_WITH_VALUE_47');
  await h.pump(parent.exchangeId);
  const result = await h.call('read_exchange', { exchange_id: parent.exchangeId });
  assert.equal(result.state, 'completed');
  assert.equal(result.reply.message, 'BUILT_WITH_VALUE_47');
  assert.equal(result.native.requestId, resumedRequest);
  assert.equal(h.notices.length, 2);
  assert.ok(h.notices[1].includes(parent.exchangeId));
  assert.match(h.notices[1], /completed/);
  await h.pump(parent.exchangeId);
  assert.equal(h.notices.length, 2, 're-reading a completion never produces another notice');
});

test('a source consuming its answer in the running DSH turn finishes without an extra continuation', async t => {
  const h = await harness(t);
  const parent = await h.call('send_peer', { from_peer_id: 'desktop', to_peer_id: 'dsh', message: 'Use the answer in this turn.', request_id: 'parent-inline' });
  const request = h.dispatches[0].requestId;
  const question = await h.call('send_peer', { from_peer_id: 'dsh', to_peer_id: 'desktop', message: 'Confirm the value.', request_id: 'question-inline', parent_exchange_id: parent.exchangeId });
  await h.call('reply_exchange', { exchange_id: question.exchangeId, peer_id: 'desktop', message: 'INLINE_VALUE', request_id: 'answer-inline' });
  await h.pump(question.exchangeId);
  assert.equal(h.dispatches.length, 1, 'a busy source is never queued an extra model turn');
  const answer = await h.call('read_exchange', { exchange_id: question.exchangeId, peer_id: 'dsh' });
  assert.equal(answer.reply.message, 'INLINE_VALUE');
  h.finish(request, 'DONE_IN_ORIGINAL_TURN');
  await h.pump(question.exchangeId);
  await h.pump(parent.exchangeId);
  const result = await h.call('read_exchange', { exchange_id: parent.exchangeId });
  assert.equal(result.state, 'completed');
  assert.equal(result.reply.message, 'DONE_IN_ORIGINAL_TURN');
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.notices.length, 2);
});

test('two sequential questions in one task each resume the matching native turn', async t => {
  const h = await harness(t);
  const parent = await h.call('send_peer', { from_peer_id: 'desktop', to_peer_id: 'dsh', message: 'Ask for both values as needed.', request_id: 'two-inputs' });
  for (let index = 0; index < 2; index++) {
    const currentRequest = h.dispatches.at(-1).requestId;
    const question = await h.call('send_peer', { from_peer_id: 'dsh', to_peer_id: 'desktop', message: 'Input ' + index, request_id: 'input-' + index, parent_exchange_id: parent.exchangeId });
    assert.equal(question.sourceRequestId, currentRequest);
    h.finish(currentRequest, 'Waiting for input ' + index);
    await h.pump(parent.exchangeId);
    assert.equal((await h.call('read_exchange', { exchange_id: parent.exchangeId })).state, 'awaiting_input');
    await h.call('reply_exchange', { exchange_id: question.exchangeId, peer_id: 'desktop', message: 'Value ' + index, request_id: 'value-' + index });
    await h.pump(parent.exchangeId);
    assert.equal(h.dispatches.length, index + 2);
    assert.notEqual(h.dispatches.at(-1).requestId, currentRequest);
    await h.pump(parent.exchangeId);
    assert.notEqual((await h.call('read_exchange', { exchange_id: parent.exchangeId })).state, 'completed');
  }
  h.finish(h.dispatches.at(-1).requestId, 'BOTH_VALUES_USED');
  await h.pump(parent.exchangeId);
  const result = await h.call('read_exchange', { exchange_id: parent.exchangeId });
  assert.equal(result.state, 'completed');
  assert.equal(result.reply.message, 'BOTH_VALUES_USED');
  assert.equal(h.notices.length, 3, 'two questions and one final return');
});

test('a late read of the pre-question turn cannot finish an already resumed task', async t => {
  const h = await harness(t);
  const parent = await h.call('send_peer', { from_peer_id: 'desktop', to_peer_id: 'dsh', message: 'Continue after the question.', request_id: 'race-parent' });
  const originalRequest = h.dispatches[0].requestId;
  const question = await h.call('send_peer', { from_peer_id: 'dsh', to_peer_id: 'desktop', message: 'Input?', request_id: 'race-question', parent_exchange_id: parent.exchangeId });
  h.finish(originalRequest, 'OLD_WAITING_OUTPUT');
  const hold = h.holdNextWait(originalRequest);
  const delayedRead = h.call('read_exchange', { exchange_id: parent.exchangeId });
  await hold.ready;
  try {
    await h.pump(parent.exchangeId);
    await h.call('reply_exchange', { exchange_id: question.exchangeId, peer_id: 'desktop', message: 'Proceed.', request_id: 'race-answer' });
    await h.pump(parent.exchangeId);
    assert.equal(h.dispatches.length, 2);
  } finally {
    hold.release();
  }
  const stale = await delayedRead;
  assert.notEqual(stale.state, 'completed');
  assert.equal(stale.native.requestId, h.dispatches[1].requestId);
  h.finish(h.dispatches[1].requestId, 'CURRENT_RESULT');
  await h.pump(parent.exchangeId);
  const result = await h.call('read_exchange', { exchange_id: parent.exchangeId });
  assert.equal(result.reply.message, 'CURRENT_RESULT');
});
