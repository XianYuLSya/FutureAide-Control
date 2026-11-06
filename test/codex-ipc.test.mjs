import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCodexNativeRpc, nativeRpcExpression, sendCodexTextNative, ensureCodexThreadNative,
  readCodexThreadNative, listCodexTurnsNative, isCodexRpcUnavailable, isCodexThreadMissing,
  codexThreadNotFound,
} from '../src/codex-ipc.mjs';
import { liveThread, livePage, liveTurn } from './live-thread-fixture.mjs';

function fakeWindow(answer) {
  const listeners = new Set(), requests = [];
  return { requests, window: {
    addEventListener: (_, callback) => listeners.add(callback),
    removeEventListener: (_, callback) => listeners.delete(callback),
    electronBridge: { sendMessageFromView: async value => {
      requests.push(value);
      const message = { id: value.request.id, ...answer(value.request) };
      queueMicrotask(() => { for (const callback of [...listeners]) callback({ data: { type: 'mcp-response', hostId: 'local', message } }); });
    } },
  } };
}

async function run(method, params, answer) {
  const fake = fakeWindow(answer);
  const value = await Function('window', `return ${nativeRpcExpression(method, params, 1000)}`)(fake.window);
  return { value, requests: fake.requests };
}

test('config/read still returns only the four model fields', async () => {
  const { value, requests } = await run('config/read', { includeLayers: false, cwd: 'D:/work' }, () => ({
    result: { config: { model: 'actual', model_reasoning_effort: 'max', secret: 'must stay inside renderer' } },
  }));
  assert.deepEqual(value, { model: 'actual', provider: 'openai', reasoningEffort: 'max', profile: null });
  assert.equal(requests[0].type, 'mcp-request');
  assert.equal(requests[0].hostId, 'local');
  assert.equal(requests[0].request.method, 'config/read');
  assert.equal(requests[0].request.params.cwd, 'D:/work');
});

test('the managed thread and turn methods are allowed and return the raw app-server result', async () => {
  const thread = { id: 'thread-1', cwd: 'D:/work', status: { type: 'idle' }, turns: [] };
  for (const method of ['thread/start', 'thread/read', 'thread/turns/list', 'thread/list',
    'thread/resume', 'thread/name/set', 'thread/delete', 'turn/start', 'turn/steer', 'turn/interrupt']) {
    const { value, requests } = await run(method, { threadId: 'thread-1' }, () => ({ result: { thread } }));
    assert.deepEqual(value, { thread }, method);
    assert.equal(requests[0].request.method, method);
  }
});

test('a JSON-RPC error keeps its numeric code for the Node side', async () => {
  const { value } = await run('thread/read', { threadId: 'missing' }, () => ({
    error: { code: -32600, message: 'thread not found' },
  }));
  assert.deepEqual(value.__futureaideRpcError,
    { code: -32600, message: 'thread not found', data: undefined });
  assert.throws(() => nativeRpcExpression('exec/start', {}, 1000), { code: 'codex-native-rpc-unsupported' });
});

function scriptedRequest(handler) {
  const calls = [];
  return { calls, request: async (method, params) => { calls.push({ method, params }); return handler(method, params); } };
}

test('an application rejection does not close another in-flight request', async () => {
  let socket;
  class FakeWebSocket {
    constructor() {
      socket = this; this.handlers = new Map(); this.sent = [];
      queueMicrotask(() => this.emit('open'));
    }
    addEventListener(type, callback, options) {
      const list = this.handlers.get(type) ?? [];
      this.handlers.set(type, [...list, { callback, once: options?.once === true }]);
    }
    emit(type, event = {}) {
      const list = this.handlers.get(type) ?? [];
      this.handlers.set(type, list.filter(entry => !entry.once));
      for (const entry of list) entry.callback(event);
    }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.emit('close'); }
    respond(index, payload) {
      const frame = this.sent[index];
      this.emit('message', { data: JSON.stringify({ id: frame.id, ...payload }) });
    }
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({ webSocketUrl: 'ws://fixture' }),
    WebSocketImpl: FakeWebSocket, idleMs: 10000 });
  const rejected = rpc.request('thread/read', { threadId: 'missing' });
  const concurrent = rpc.request('thread/list', { limit: 1 });
  await new Promise(resolve => setImmediate(resolve));
  socket.respond(0, { result: { exceptionDetails: { exception: { description: 'thread not found' } } } });
  socket.respond(1, { result: { result: { value: { data: [] } } } });
  await assert.rejects(rejected, { code: 'codex-native-rpc-rejected' });
  assert.deepEqual(await concurrent, { data: [] }, 'the concurrent request survives the application rejection');
  await rpc.close();
});

test('an idle thread gets turn/start with no model, effort or permission fields', async () => {
  const fake = scriptedRequest(method => {
    if (method === 'thread/read') return { thread: liveThread({ id: 'thread-1', cwd: 'D:/work/p', updatedAt: 1 }) };
    if (method === 'thread/turns/list') return livePage();
    if (method === 'turn/start') return { turn: liveTurn({ id: 'turn-1', status: 'inProgress', completedAt: null, durationMs: null }) };
    throw new Error('unexpected ' + method);
  });
  const result = await sendCodexTextNative('thread-1', 'hello', { request: fake.request });
  assert.equal(result.turn.id, 'turn-1');
  assert.deepEqual(fake.calls.map(call => call.method), ['thread/read', 'thread/turns/list', 'turn/start']);
  const params = fake.calls.at(-1).params;
  assert.deepEqual(params.input, [{ type: 'text', text: 'hello', text_elements: [] }]);
  for (const forbidden of ['model', 'effort', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'permissions']) {
    assert.equal(forbidden in params, false, `${forbidden} must not be sent`);
  }
  assert.match(params.clientUserMessageId, /^[a-f0-9-]{36}$/);
});

test('a running thread is steered with the active turn id', async () => {
  const fake = scriptedRequest(method => {
    if (method === 'thread/read') return { thread: liveThread({ id: 'thread-1', cwd: 'D:/work/p', status: { type: 'active' }, updatedAt: 1 }) };
    if (method === 'thread/turns/list') return livePage([liveTurn({ id: 'turn-active', status: 'inProgress', completedAt: null, durationMs: null })]);
    if (method === 'turn/steer') return { turnId: 'turn-active' };
    throw new Error('unexpected ' + method);
  });
  await sendCodexTextNative('thread-1', 'next step', { request: fake.request });
  assert.equal(fake.calls.at(-1).method, 'turn/steer');
  assert.equal(fake.calls.at(-1).params.expectedTurnId, 'turn-active');
});

test('a cold thread is resumed before its first new turn', async () => {
  const fake = scriptedRequest(method => {
    if (method === 'thread/read') return { thread: liveThread({ id: 'thread-1', cwd: 'D:/work/p', status: { type: 'notLoaded' }, updatedAt: 1 }) };
    if (method === 'thread/resume') return { thread: liveThread({ id: 'thread-1', cwd: 'D:/work/p', updatedAt: 1 }) };
    if (method === 'thread/turns/list') return livePage();
    if (method === 'turn/start') return { turn: liveTurn({ id: 'turn-1', status: 'inProgress', completedAt: null, durationMs: null }) };
    throw new Error('unexpected ' + method);
  });
  await ensureCodexThreadNative('thread-1', { request: fake.request });
  assert.deepEqual(fake.calls.map(call => call.method), ['thread/read', 'thread/resume']);
  assert.equal(fake.calls[1].params.excludeTurns, true, 'resume does not hydrate a long turn history');
});

test('a missing thread becomes a terminal codex-thread-not-found error', async () => {
  const missing = Object.assign(new Error('Native Desktop rejected thread/read: thread not found'),
    { rpcMessage: 'thread not found' });
  await assert.rejects(readCodexThreadNative('gone', { request: async () => { throw missing; } }),
    { code: 'codex-thread-not-found', terminal: true });
  assert.equal(isCodexThreadMissing(missing), true);
  assert.equal(isCodexThreadMissing(new Error('socket closed')), false);
  assert.match(codexThreadNotFound('gone').message, /current profile/);
});

test('an empty rollout is an empty turn page, not a missing thread', async () => {
  const page = await listCodexTurnsNative('thread-1', { request: async () => {
    throw Object.assign(new Error('rollout is empty'), { rpcMessage: 'rollout is empty' });
  } });
  assert.deepEqual(page, { data: [], nextCursor: null });
});

test('only pre-send transport failures count as unavailable for a fallback', () => {
  assert.equal(isCodexRpcUnavailable({ code: 'codex-native-rpc-unavailable' }), true);
  assert.equal(isCodexRpcUnavailable({ code: 'codex-native-rpc-timeout' }), true);
  assert.equal(isCodexRpcUnavailable({ code: 'codex-native-rpc-closed' }), false);
  assert.equal(isCodexRpcUnavailable({ code: 'codex-native-rpc-rejected' }), false);
});
