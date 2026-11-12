import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { FutureAideClient } from '../src/futureaide-api.mjs';
import { createControl } from '../src/control.mjs';

async function fixture({ modern = false, changeInstance = false } = {}) {
  const base = path.resolve('clean', 'managed-dispatch-tests');
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(path.join(base, 'run-'));
  const binding = { ownerId: 'owner-a', agentId: 'agent-a', sessionId: 'session-a', taskId: 'task-a', workspace, treeProtocol: 1, reportProtocol: 1 };
  const credential = path.join(workspace, 'host-bridge.json');
  await writeFile(credential, JSON.stringify({ version: 1, token: 'a'.repeat(64) }));
  const instanceFile = path.join(workspace, 'instance.json');
  const instance = { version: 1, application: 'dsh', pid: process.pid, instanceId: randomUUID(), dataRoot: workspace,
    baseUrl: 'http://127.0.0.1:45678', launchUrl: 'http://127.0.0.1:45678/?token=fixture' };
  await writeFile(instanceFile, JSON.stringify(instance));
  const state = { calls: [], statusCalls: 0, failStatus: 0, losePromptReply: false, prompts: 0, events: [], seq: 4, managedSelections: [] };
  const stalled = signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === '/') return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'dsh-auth-fixture=cookie' } });
    const body = JSON.parse(init.body), method = body.method;
    state.calls.push(body);
    const reply = value => new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
    const reject = code => new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code } } }));
    if (method === 'managedSelectModel') {
      const args = body.payload.args;
      state.managedSelections.push(args);
      return reply({ accepted: true, sessionId: args.sessionId, selected: args.selection,
        source: 'managed-session-selectModel', defaultModelBehavior: 'Session-only: the app-wide default model is unchanged.',
        modelRequestsStarted: 0 });
    }
    if (method === 'managedStatus') {
      state.statusCalls++;
      if (state.failStatus === state.statusCalls) return stalled(init.signal);
      const args = body.payload.args;
      if (['ownerId', 'agentId', 'sessionId', 'taskId', 'workspace'].some(key => args[key] !== binding[key])) return reject('managed-task-mismatch');
      if (changeInstance) await writeFile(instanceFile, JSON.stringify({ ...instance, instanceId: randomUUID() }));
      return reply({ ...binding, running: false, throughSeq: state.seq, model: { provider: 'fixture', model: 'm' },
        currentModel: state.currentModel });
    }
    if (modern && method.includes('/')) return new Response(null, { status: 404 });
    if (['session/modelCatalog', 'llm.models'].includes(method)) return reply({ defaultModel: { provider: 'fixture', model: 'm' } });
    if (['session/list', 'session.list'].includes(method)) return reply({ items: [{ sessionId: binding.sessionId, cwd: workspace,
      running: false, projections: { asOfSeq: state.seq, values: {} } }] });
    if (['session/selectModel', 'session.selectModel'].includes(method)) return reply({ selected: { provider: 'fixture', model: 'm' } });
    if (['session/prompt', 'session.prompt'].includes(method)) {
      const input = modern ? body.payload : body.payload.args.request;
      state.prompts++;
      state.events.push({ seq: ++state.seq, type: 'turn/start', data: { turn: 1 } },
        { seq: ++state.seq, type: 'user/message', data: { source: { rpcId: input.requestId } } },
        { seq: ++state.seq, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
      if (state.losePromptReply) return stalled(init.signal);
      return reply({ accepted: true });
    }
    if (['session/page', 'session.history'].includes(method)) {
      const input = modern ? body.payload : body.payload.args.request;
      const through = modern ? input.beforeSeq - 1 : input.throughSeq;
      assert.ok(Number.isSafeInteger(through), 'managed reads carry the exact session cursor');
      const events = state.events.filter(event => event.seq <= through);
      return reply(modern ? { events: events.map(event => ({ event })), hasMore: false }
        : { records: events.map(event => ({ type: 'event', event })), hasMore: false });
    }
    throw new Error(`Unexpected request ${method}`);
  };
  const options = { instanceFile, hostBridgeFile: credential, fetchImpl, timeoutMs: 40 };
  const client = new FutureAideClient(options);
  const config = { workspace, stateDirectory: path.join(workspace, 'state') };
  const control = createControl(config, { client, managed: binding });
  return { binding, state, client, control, config, options };
}

// The control-level gate runs before managedSendMessage, but that call still awaits the
// managed session, the model catalog and the transport's own discovery and
// authentication. A task can finish inside that window, so the same gate is asked again
// immediately before the prompt is posted — and a refusal there posts nothing.
test('the managed prompt gate is asked again immediately before the POST', async () => {
  const f = await fixture();
  // Control asks once before calling in; the client asks again after its session and
  // catalog reads, and a third time in the transport, just before the prompt is posted.
  const marks = [];
  await assert.rejects(f.control.send({ sessionId: 'session-a', message: 'work', requestId: 'request-blocked',
    writeBlockReason: () => { marks.push(f.state.calls.length); return marks.length < 3 ? undefined : 'dispatch-expired'; } }),
  error => error.code === 'dispatch-expired' && error.terminal === true && error.notSent === true);
  assert.equal(marks.length, 3, 'all three ask points ran, in order');
  assert.ok(marks[1] >= 1, 'the second ask comes after the client has already read the session');
  assert.ok(marks[2] >= marks[1], 'and the last one from where the prompt would be posted');
  assert.equal(f.state.prompts, 0, 'no prompt reached the host');
  // Without the gate, the very same dispatch still goes out.
  const plain = await f.control.send({ sessionId: 'session-a', message: 'work', requestId: 'request-plain' });
  assert.equal(plain.accepted, true);
  assert.equal(f.state.prompts, 1);
});

test('managed session uses live model state and does not mistake an old host snapshot for current selection', async () => {
  const f = await fixture();
  assert.equal((await f.client.managedSession(f.binding)).projections.values.modelSelection.next, undefined);
  f.state.currentModel = { provider: 'new-provider', model: 'new-model', reasoningEffort: 'high' };
  assert.deepEqual((await f.client.managedSession(f.binding)).projections.values.modelSelection.next, f.state.currentModel);
  assert.ok(f.state.calls.every(call => !['session/list', 'session.list'].includes(call.method)));
});

test('managed model selection, dispatch, wait and read never list all sessions', async () => {
  const f = await fixture();
  await f.control.selectModel({ sessionId: 'session-a', provider: 'fixture', model: 'm', requestId: 'task-a-model' });
  const sent = await f.control.send({ sessionId: 'session-a', message: 'work', requestId: 'request-a' });
  assert.equal(sent.accepted, true);
  assert.equal(sent.afterSeq, 4);
  const ended = await f.control.wait({ sessionId: 'session-a', requestId: 'request-a', afterSeq: 4, timeoutSeconds: 0 });
  assert.equal(ended.state, 'ended');
  assert.equal(ended.correlation, 'request-id');
  await f.control.read({ sessionId: 'session-a' });
  assert.equal(f.state.prompts, 1);
  assert.ok(f.state.calls.every(call => !['session/list', 'session.list'].includes(call.method)));
});

test('explicit managed selection uses the session-only host method while default-follow keeps the native path', async () => {
  const selection = { provider: 'fixture', model: 'm', reasoningEffort: 'high' };
  const explicit = await fixture();
  await explicit.control.selectModel({ sessionId: 'session-a', ...selection, requestId: 'session-only-1', sessionOnly: true });
  assert.equal(explicit.state.managedSelections.length, 1);
  assert.deepEqual(explicit.state.managedSelections[0].selection, selection);
  assert.ok(explicit.state.calls.some(call => call.method === 'managedSelectModel'));
  assert.equal(explicit.state.calls.some(call => call.method === 'session/selectModel'), false,
    'explicit session-only selection never calls the default-saving native command');

  const follow = await fixture();
  const follows = await follow.control.selectModel({ sessionId: 'session-a', provider: 'fixture', model: 'm', requestId: 'default-follow-1' });
  assert.equal(follows.accepted, true);
  assert.equal(follow.state.managedSelections.length, 0);
  assert.ok(follow.state.calls.some(call => call.method === 'session/selectModel'),
    'the unpinned/default-follow path is unchanged');
});

test('fresh modern managed wait and history detect the dialect without send or list', async () => {
  const f = await fixture({ modern: true });
  const waiting = await f.control.wait({ sessionId: 'session-a', requestId: 'existing', afterSeq: 4, timeoutSeconds: 0 });
  assert.equal(waiting.state, 'running');
  await f.control.read({ sessionId: 'session-a' });
  assert.ok(f.state.calls.some(call => call.method === 'llm.models'));
  assert.ok(f.state.calls.some(call => call.method === 'session.history'));
  assert.ok(f.state.calls.every(call => !['session/list', 'session.list', 'session/prompt', 'session.prompt'].includes(call.method)));
});

test('a pre-write managed read timeout retries the same receipt once; a lost write reply stays unknown', async () => {
  const f = await fixture();
  f.state.failStatus = 2; // After the receipt, but before native prompt.
  let receipt;
  await assert.rejects(f.control.send({ sessionId: 'session-a', message: 'work', requestId: 'retry-read' }), error => {
    receipt = error.receipt; return error.code === 'timeout' && error.retryableRead === true && error.uncertain === false;
  });
  assert.equal(JSON.parse(await readFile(receipt, 'utf8')).status, 'retryable');
  assert.equal(f.state.prompts, 0);
  assert.equal((await f.control.send({ sessionId: 'session-a', message: 'work', requestId: 'retry-read' })).accepted, true);
  assert.equal((await f.control.send({ sessionId: 'session-a', message: 'work', requestId: 'retry-read' })).duplicate, true);
  assert.equal(f.state.prompts, 1);
  f.state.losePromptReply = true;
  await assert.rejects(f.control.send({ sessionId: 'session-a', message: 'next', requestId: 'unknown-write' }), error => error.uncertain === true && !error.retryableRead);
  const duplicate = await f.control.send({ sessionId: 'session-a', message: 'next', requestId: 'unknown-write' });
  assert.equal(duplicate.status, 'unknown');
  assert.equal(f.state.prompts, 2);
});

test('managed ownership or host instance mismatch blocks the native write', async () => {
  const f = await fixture();
  await assert.rejects(f.client.managedSendMessage({ ...f.binding, taskId: 'wrong' }, 'work'), error => error.code === 'managed-task-mismatch');
  assert.equal(f.state.prompts, 0);
  const moved = await fixture({ changeInstance: true });
  await assert.rejects(moved.client.managedSendMessage(moved.binding, 'work'), error => error.code === 'instance-changed');
  assert.equal(moved.state.prompts, 0);
});

test('ordinary CLI calls retain session-list ownership checks', async () => {
  const f = await fixture();
  const plain = createControl(f.config, { client: f.client });
  assert.equal((await plain.send({ sessionId: 'session-a', message: 'ordinary', requestId: 'ordinary' })).accepted, true);
  await assert.rejects(plain.send({ sessionId: 'another-session', message: 'wrong', requestId: 'wrong' }), /configured project/);
  assert.ok(f.state.calls.some(call => call.method === 'session/list'));
  assert.equal(f.state.prompts, 1);
});
