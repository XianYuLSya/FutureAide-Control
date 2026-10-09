import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createControl } from '../src/control.mjs';
import { makeServer } from '../src/mcp-server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const root = path.dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  const workspace = await mkdtemp(path.join(root, '.control-test-'));
  t.after(async () => { assert.ok(workspace.startsWith(root + path.sep)); await rm(workspace, { recursive: true, force: true }); });
  let sends = 0;
  const config = { workspace, stateDirectory: path.join(workspace, 'state'), futureaideSessionId: 'parent' };
  const client = {
    listSessions: async () => ({ items: [{ sessionId: 'parent', cwd: workspace, running: true, projections: { asOfSeq: 5 } }, { sessionId: 'other', cwd: path.dirname(workspace) }] }),
    status: async () => ({ connected: true }),
    readSession: async (id, opts) => ({ id, ...opts, records: [], hasMore: false }),
    sendMessage: async () => { sends++; return { accepted: true }; },
  };
  return { control: createControl(config, { client }), sends: () => sends };
}

test('scope filtering excludes unrelated project sessions', async t => {
  const { control } = await fixture(t);
  assert.deepEqual((await control.sessions()).items.map(i => i.sessionId), ['parent']);
  await assert.rejects(control.read({ sessionId: 'other' }), /configured project/);
});

test('duplicate writes reuse the receipt and conflicting contents are rejected', async t => {
  const { control, sends } = await fixture(t);
  await control.send({ message: 'continue', requestId: 'work-1' });
  const duplicate = await control.send({ message: 'continue', requestId: 'work-1' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(sends(), 1);
  await assert.rejects(control.send({ message: 'different', requestId: 'work-1' }), /different content/);
});

test('a repeated request cannot be delivered to a different discovered instance', async t => {
  const workspace = await mkdtemp(path.join(root, '.identity-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let pid = 1; let sends = 0;
  const client = {
    listSessions: async () => ({ items: [{ sessionId: 'parent', cwd: workspace }] }),
    connectionIdentity: async () => ({ baseUrl: 'http://127.0.0.1:41000', pid, dataRoot: workspace }),
    sendMessage: async () => { sends++; return { accepted: true }; },
  };
  const config = { workspace, stateDirectory: path.join(workspace, 'state') };
  await createControl(config, { client }).send({ sessionId: 'parent', message: 'work', requestId: 'same' });
  pid = 2;
  await assert.rejects(createControl(config, { client }).send({ sessionId: 'parent', message: 'work', requestId: 'same' }), /another host instance/);
  assert.equal(sends, 1);
});

test('historical receipts without an instance identity remain unknown after upgrade', async t => {
  const workspace = await mkdtemp(path.join(root, '.receipt-upgrade-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let sends = 0;
  const client = {
    listSessions: async () => ({ items: [{ sessionId: 'parent', cwd: workspace }] }),
    sendMessage: async () => { sends++; return { accepted: true }; },
  };
  const config = { workspace, stateDirectory: path.join(workspace, 'state') };
  await createControl(config, { client }).send({ sessionId: 'parent', message: 'work', requestId: 'old' });
  client.connectionIdentity = async () => ({ baseUrl: 'http://127.0.0.1:41000', pid: 2, dataRoot: workspace });
  const result = await createControl(config, { client }).send({ sessionId: 'parent', message: 'work', requestId: 'old' });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 'unknown');
  assert.equal(sends, 1);
});

test('an uncertain project session creation is not resubmitted', async t => {
  const workspace = await mkdtemp(path.join(root, '.project-creation-uncertain-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let creates = 0;
  const client = { createProjectSession: async () => {
    creates++;
    throw Object.assign(new Error('timeout'), { uncertain: true });
  } };
  const control = createControl({ workspace, stateDirectory: path.join(workspace, 'state') }, { client });
  await assert.rejects(control.createSession({ requestId: 'project-uncertain' }), /timeout/);
  const duplicate = await control.createSession({ requestId: 'project-uncertain' });
  assert.equal(duplicate.status, 'unknown');
  assert.equal(creates, 1);
});

test('wait returns the reply of the dispatched turn once it ends', async t => {
  const workspace = await mkdtemp(path.join(root, '.wait-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let polls = 0;
  const client = {
    listSessions: async () => ({ items: [{ sessionId: 'parent', cwd: workspace, running: polls < 2, projections: { asOfSeq: 5 } }] }),
    readSession: async () => {
      polls += 1;
      return polls < 2
        ? { records: [{ type: 'event', event: { type: 'step/start', seq: 6, time: 0 } }], hasMore: false }
        : { records: [
          { type: 'event', event: { type: 'assistant/message', seq: 10, time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } } },
          { type: 'event', event: { type: 'turn/end', seq: 11, time: 2 } },
        ], hasMore: false };
    },
    sendMessage: async () => ({ accepted: true }),
  };
  const control = createControl({ workspace, stateDirectory: path.join(workspace, 'state'), futureaideSessionId: 'parent' }, { client });
  const sent = await control.send({ message: 'work', requestId: 'wait-1' });
  assert.equal(sent.afterSeq, 5);
  const result = await control.wait({ requestId: 'wait-1', timeoutSeconds: 2, pollIntervalMs: 250 });
  assert.equal(result.state, 'ended');
  assert.equal(result.afterSeq, 5);
  assert.deepEqual(result.messages.map(message => message.text), ['done']);
});

test('wait reports a still-running turn and revalidates its inputs', async t => {
  const workspace = await mkdtemp(path.join(root, '.wait-running-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const client = {
    listSessions: async () => ({ items: [{ sessionId: 'parent', cwd: workspace, running: true, projections: { asOfSeq: 3 } }] }),
    readSession: async () => ({ records: [{ type: 'event', event: { type: 'step/start', seq: 4, time: 0 } }], hasMore: false }),
    sendMessage: async () => ({ accepted: true }),
  };
  const control = createControl({ workspace, stateDirectory: path.join(workspace, 'state'), futureaideSessionId: 'parent' }, { client });
  const result = await control.wait({ timeoutSeconds: 0, pollIntervalMs: 250 });
  assert.equal(result.state, 'running');
  assert.equal(result.afterSeq, 3);
  assert.match(result.nextAction, /futureaide_wait/);
  await assert.rejects(control.wait({ timeoutSeconds: 601 }), /timeout_seconds/);
  await assert.rejects(control.wait({ pollIntervalMs: 10 }), /poll_interval_ms/);
});

test('watch stores the finished reply without claiming automatic chat delivery', async t => {
  const workspace = await mkdtemp(path.join(root, '.watch-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const stateDirectory = path.join(workspace, 'state');
  const client = {
    listSessions: async () => ({ items: [{ sessionId: 'parent', cwd: workspace, running: false, projections: { asOfSeq: 9 } }] }),
    readSession: async () => ({ records: [
      { type: 'event', event: { type: 'assistant/message', seq: 8, time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'report ready' }] } } } },
      { type: 'event', event: { type: 'turn/end', seq: 9, time: 2 } },
    ], hasMore: false }),
    sendMessage: async () => ({ accepted: true }),
  };
  const control = createControl({ workspace, stateDirectory, futureaideSessionId: 'parent' }, { client });
  const result = await control.watch({ requestId: 'watch-1', afterSeq: 4, timeoutSeconds: 0 });
  assert.equal(result.state, 'ended');
  assert.equal(result.deliveredAutomatically, false);
  assert.equal(result.reportStored, true);
  assert.ok(result.reportFile.startsWith(stateDirectory));
  const stored = JSON.parse(await readFile(result.reportFile, 'utf8'));
  assert.deepEqual(stored.messages.map(message => message.text), ['report ready']);
});

test('the actual MCP transport exposes and calls the scoped read tools', async t => {
  const { control } = await fixture(t);
  const server = makeServer(control);
  const client = new Client({ name: 'control-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 21);
  assert.equal(tools.find(tool => tool.name === 'futureaide_connect').annotations.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === 'futureaide_wait').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'futureaide_watch').annotations.readOnlyHint, true);
  const result = await client.callTool({ name: 'futureaide_read', arguments: { max_messages: 3 } });
  assert.equal(JSON.parse(result.content[0].text).maxMessages, 3);
  const rejected = await client.callTool({ name: 'futureaide_send', arguments: { message: 'x' } });
  assert.equal(rejected.isError, true);
});
