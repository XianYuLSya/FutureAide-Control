import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgents } from '../src/agents.mjs';
import { createControl } from '../src/control.mjs';
import { readDispatch } from '../src/dispatch.mjs';

const event = (seq, type, data = {}) => ({ type: 'event', event: { seq, type, data } });
const catalog = { default: { provider: 'wb', model: 'flash', reasoningEffort: 'max' }, routableProviders: ['wb'],
  groups: [{ id: 'wb', models: [{ id: 'flash', reasoning: { efforts: [{ id: 'max' }] } }] }] };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = [], pages = new Map(), calls = [];
  let failSend = false, hold = false, modelCatalog = catalog;
  const client = {
    status: async () => ({ connected: true, pid: 123 }),
    hostStatus: async () => ({ version: 1, methods: ['capabilities', 'historyCursor'], pid: 123 }),
    connectionIdentity: async () => ({ baseUrl: 'http://127.0.0.1:12345', pid: 123, instanceFile: path.join(root, 'instance.json') }),
    modelCatalog: async () => modelCatalog,
    listSessions: async () => ({ items: rows }),
    createProjectSession: async input => { calls.push('create'); rows.push({ sessionId: input.sessionId, cwd: input.cwd, running: false, projections: { asOfSeq: 0 } }); pages.set(input.sessionId, []); return { accepted: true, sessionId: input.sessionId }; },
    selectModel: async () => { calls.push('model'); return { accepted: true }; },
    sendMessage: async (id, message, { requestId }) => {
      calls.push('send');
      if (failSend) throw Object.assign(new Error('Lost response'), { uncertain: true });
      const page = pages.get(id), turn = page.length + 1, first = page.length + 1;
      page.push(event(first, 'turn/start', { turn }), event(first + 1, 'user/message', { source: { rpcId: requestId }, content: [{ type: 'text', text: message }] }),
        event(first + 2, 'assistant/message', { message: { content: [{ type: 'text', text: 'reply:' + message }] } }));
      if (!hold) page.push(event(first + 3, 'turn/end', { turn, reason: { kind: 'completed' } }));
      rows.find(row => row.sessionId === id).projections.asOfSeq = page.at(-1).event.seq;
      return { accepted: true };
    },
    readSession: async id => ({ records: pages.get(id), hasMore: false }),
    cancelSession: async id => { calls.push('cancel'); const page = pages.get(id), turn = page.findLast(record => record.event.type === 'turn/start').event.data.turn; page.push(event(page.at(-1).event.seq + 1, 'turn/end', { turn, reason: { kind: 'aborted', reason: { kind: 'user' } } })); return { accepted: true, requestId: 'native-random-id' }; },
  };
  const config = { workspace: root, stateDirectory: path.join(root, 'state'), registryDirectory: path.join(root, 'agents') };
  const controlFactory = config => { const control = createControl(config, { client }); return { ...control, send: input => control.send({ ...input, background: false }) }; };
  return { root, calls, client, config, controlFactory, agents: createAgents(config, { controlFactory }),
    failSend: value => { failSend = value; }, hold: value => { hold = value; }, catalog: value => { modelCatalog = value; } };
}

test('one-call spawn selects the real default; another client resumes by id and scopes old replies', async t => {
  const f = await fixture(t);
  const first = await f.agents.spawn({ workspace: f.root, message: 'first', requestId: 'spawn' });
  assert.equal(first.accepted, true); assert.deepEqual(first.model, catalog.default);
  assert.deepEqual(f.calls, ['create', 'model', 'send']);
  const other = createAgents({ ...f.config, workspace: tmpdir(), stateDirectory: path.join(f.root, 'different-profile') }, { controlFactory: f.controlFactory });
  assert.equal((await other.wait({ agentId: first.agentId })).reply, 'reply:first');
  assert.equal((await other.followup({ agentId: first.agentId, message: 'second', requestId: 'follow' })).accepted, true);
  assert.equal((await other.wait({ agentId: first.agentId })).reply, 'reply:second');
  assert.equal((await other.wait({ agentId: first.agentId, requestId: 'spawn' })).reply, 'reply:first');
  const duplicate = await f.agents.spawn({ workspace: f.root, message: 'first', requestId: 'spawn' });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.state, 'completed');
  assert.equal(f.calls.filter(call => call === 'send').length, 2);
  await assert.rejects(f.agents.spawn({ workspace: f.root, message: 'changed', requestId: 'spawn' }), /different spawn/);
});

test('busy followup and concurrent duplicate spawn send no additional prompt; cancellation is scoped', async t => {
  const f = await fixture(t); f.hold(true);
  const results = await Promise.all([1, 2].map(() => f.agents.spawn({ workspace: f.root, message: 'hold', requestId: 'same' })));
  const first = results.find(result => result.accepted);
  assert.ok(first); assert.equal(f.calls.filter(call => call === 'send').length, 1);
  assert.equal((await f.agents.followup({ agentId: first.agentId, message: 'other' })).state, 'busy');
  assert.equal(f.calls.filter(call => call === 'send').length, 1);
  const cancelled = await f.agents.cancel({ agentId: first.agentId });
  assert.equal(cancelled.accepted, true); assert.equal(cancelled.requestId, 'same'); assert.ok(cancelled.cancellationRequestId);
  assert.equal((await f.agents.wait({ agentId: first.agentId })).state, 'cancelled');
});

test('uncertain delivery survives a new process facade and reuses the receipt without resending', async t => {
  const f = await fixture(t); f.failSend(true);
  const failed = await f.agents.spawn({ workspace: f.root, message: 'work', requestId: 'uncertain' });
  assert.equal(failed.accepted, false); assert.ok(failed.agentId); assert.ok(failed.sessionId); assert.equal(failed.requestId, 'uncertain');
  assert.ok(failed.receipt); assert.equal(failed.afterSeq, 0);
  const receipt = JSON.parse(await readFile(failed.receipt, 'utf8'));
  assert.equal(receipt.status, 'unknown'); assert.equal(receipt.afterSeq, 0);
  f.failSend(false);
  const retry = await createAgents(f.config, { controlFactory: f.controlFactory }).spawn({ workspace: f.root, message: 'work', requestId: 'uncertain' });
  assert.equal(retry.accepted, false); assert.equal(retry.status, 'unknown'); assert.ok(retry.receipt);
  assert.equal(retry.afterSeq, 0);
  assert.deepEqual(f.calls, ['create', 'model', 'send']);
});

test('a lost send response retains its pre-send cursor and the native reply can be read without resending', async t => {
  const f = await fixture(t);
  const send = f.client.sendMessage;
  f.client.sendMessage = async (...args) => { await send(...args); throw Object.assign(new Error('Response lost'), { uncertain: true }); };
  const failed = await f.agents.spawn({ workspace: f.root, message: 'landed', requestId: 'lost-response' });
  assert.ok(failed.receipt); assert.equal(failed.afterSeq, 0);
  const control = f.controlFactory({ ...f.config, stateDirectory: path.join(f.root, 'agents', failed.agentId, 'state') });
  const read = await control.wait({ sessionId: failed.sessionId, requestId: 'lost-response', timeoutSeconds: 0 });
  assert.equal(read.state, 'ended'); assert.equal(read.correlation, 'request-id');
  assert.equal(read.messages.find(message => message.role === 'assistant').text, 'reply:landed');
  assert.deepEqual(f.calls, ['create', 'model', 'send']);
});

test('missing default fails before creation and a repaired catalog resumes the saved identity', async t => {
  const f = await fixture(t); f.catalog({ ...catalog, default: undefined });
  const input = { workspace: f.root, message: 'work', requestId: 'default' };
  const failed = await f.agents.spawn(input); assert.equal(failed.accepted, false); assert.deepEqual(f.calls, []);
  f.catalog(catalog);
  const resumed = await f.agents.spawn(input); assert.equal(resumed.accepted, true); assert.equal(resumed.agentId, failed.agentId);
  assert.deepEqual(f.calls, ['create', 'model', 'send']);
});

test('a stale process lock recovers while a changed host blocks cancellation', async t => {
  const f = await fixture(t); f.hold(true);
  const spawned = await f.agents.spawn({ workspace: f.root, message: 'work', requestId: 'stale' });
  const filename = path.join(f.root, 'agents', spawned.agentId, 'lock.json');
  await writeFile(filename, JSON.stringify({ pid: 2147483647, nonce: 'dead-owner' }));
  assert.equal((await f.agents.wait({ agentId: spawned.agentId })).state, 'running');
  f.client.connectionIdentity = async () => ({ baseUrl: 'http://127.0.0.1:12345', pid: 456 });
  await assert.rejects(f.agents.cancel({ agentId: spawned.agentId }), /host instance changed/);
  assert.equal(f.calls.includes('cancel'), false);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'agents', spawned.agentId, 'agent.json'))).host.pid, 123);
});

test('dispatch pagination finds the original turn and excludes a later turn', async () => {
  const records = [event(1, 'turn/start', { turn: 1 }), event(2, 'user/message', { source: { rpcId: 'original' } }),
    event(3, 'assistant/message', {}), event(4, 'turn/end', { turn: 1 }), event(5, 'turn/start', { turn: 2 }),
    event(6, 'user/message', { source: { rpcId: 'later' } }), event(7, 'turn/end', { turn: 2 })];
  const calls = [];
  const api = { readSession: async (id, options) => { calls.push(options.throughSeq); return options.throughSeq === undefined
    ? { records: records.slice(4), hasMore: true } : options.throughSeq === 4 ? { records: records.slice(1, 4), hasMore: true }
      : { records: records.slice(0, 1), hasMore: false }; } };
  const read = await readDispatch(api, 'session', { requestId: 'original', afterSeq: 0 });
  assert.equal(read.ended, true); assert.equal(read.boundary.turn, 1);
  assert.deepEqual(read.page.records.map(record => record.event.seq), [2, 3, 4]);
  assert.deepEqual(calls, [undefined, 4, 1]);
});

test('a queued native RPC cannot be satisfied by an earlier turn end', async () => {
  const api = { readSession: async () => ({ records: [event(2, 'agent/inbox/spliced', { inserted: [{ source: { rpcId: 'queued' } }] }),
    event(3, 'turn/end', { turn: 1 })], hasMore: false }) };
  const read = await readDispatch(api, 'session', { requestId: 'queued', afterSeq: 0 });
  assert.equal(read.ended, false); assert.equal(read.boundary.correlation, 'request-id');
});
