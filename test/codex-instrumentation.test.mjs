import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexNativeRpc } from '../src/codex-ipc.mjs';
import { withCodexInstrumentation, getCodexInstrumentation } from '../src/codex-instrumentation.mjs';

test('disabled instrumentation does not install a context', () => {
  const flag = process.env.FUTUREAIDE_CODEX_INSTRUMENTATION;
  const file = process.env.FUTUREAIDE_CODEX_METRICS_FILE;
  delete process.env.FUTUREAIDE_CODEX_INSTRUMENTATION;
  delete process.env.FUTUREAIDE_CODEX_METRICS_FILE;
  try { assert.deepEqual(withCodexInstrumentation({ source: 'inspect' }, getCodexInstrumentation), {}); }
  finally {
    if (flag !== undefined) process.env.FUTUREAIDE_CODEX_INSTRUMENTATION = flag;
    if (file !== undefined) process.env.FUTUREAIDE_CODEX_METRICS_FILE = file;
  }
});

test('measurements correlate real native ID and never include params', async () => {
  const previous = process.env.FUTUREAIDE_CODEX_INSTRUMENTATION;
  process.env.FUTUREAIDE_CODEX_INSTRUMENTATION = '1';
  const events = []; let sent;
  class Socket {
    constructor() { this.handlers = {}; queueMicrotask(() => this.emit('open', {})); }
    addEventListener(name, handler) { (this.handlers[name] ??= []).push(handler); }
    emit(name, data) { for (const handler of this.handlers[name] ?? []) handler(data); }
    send(data) { sent = JSON.parse(data); queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: sent.id, result: { result: { value: { ok: true } } } }) })); }
    close() { this.emit('close', {}); }
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({ webSocketUrl: 'fake:', pid: 7, targetId: 'target' }), WebSocketImpl: Socket, measure: e => events.push(e) });
  const result = await withCodexInstrumentation({ source: 'inspect', currentStage: 'poll', operationId: 'op-1', agentId: 'agent-1', secret: 'hidden' }, () => rpc.request('thread/read', { threadId: 'secret-body' }));
  assert.deepEqual(result, { ok: true });
  const send = events.find(e => e.event === 'send');
  assert.equal(send.source, 'inspect'); assert.equal(send.currentStage, 'poll'); assert.equal(send.generation, 1);
  assert.ok(sent.params.expression.includes(send.requestId));
  assert.equal(events.find(e => e.event === 'response').requestId, send.requestId);
  assert.ok(!JSON.stringify(events).includes('secret-body')); assert.ok(!JSON.stringify(events).includes('hidden'));
  rpc.close();
  if (previous === undefined) delete process.env.FUTUREAIDE_CODEX_INSTRUMENTATION;
  else process.env.FUTUREAIDE_CODEX_INSTRUMENTATION = previous;
});

test('timeout records active close and affected pending request', async () => {
  const events = [];
  class Socket {
    constructor() { this.handlers = {}; queueMicrotask(() => this.emit('open', {})); }
    addEventListener(name, handler) { (this.handlers[name] ??= []).push(handler); }
    emit(name, data) { for (const handler of this.handlers[name] ?? []) handler(data); }
    send() {} close() { this.emit('close', {}); }
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({ webSocketUrl: 'fake:' }), WebSocketImpl: Socket, timeoutMs: 5, measure: e => events.push(e) });
  const a = rpc.request('thread/read', {}).catch(e => e.code);
  await new Promise(resolve => setTimeout(resolve, 30));
  const b = rpc.request('thread/read', {}).catch(e => e.code);
  assert.deepEqual(await Promise.all([a, b]), ['codex-native-rpc-response-timeout', 'codex-native-rpc-closed']);
  assert.ok(events.some(e => e.event === 'close_requested' && e.reason === 'codex-native-rpc-response-timeout' && e.inFlight === 1));
  assert.ok(events.some(e => e.event === 'socket_close' && e.inFlight === 1));
});

test('bounded async writer reports dropped events without blocking', async () => {
  const { createCodexMeasurementWriter } = await import('../src/codex-instrumentation.mjs');
  const batches = [];
  const write = createCodexMeasurementWriter('unused', { capacity: 2, batchSize: 2, append: async (_path, text) => { batches.push(text); } });
  write({ event: 'one' }); write({ event: 'two' }); write({ event: 'three' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(batches.length, 1);
  const entries = batches[0].trim().split('\n').map(JSON.parse);
  assert.equal(entries[0].event, 'metrics_dropped'); assert.equal(entries[0].count, 1);
  assert.deepEqual(entries.slice(1).map(x => x.event), ['one', 'two']);
});

test('passive close and synchronous send failure are attributed without free text', async () => {
  const events = []; let socket;
  class Socket {
    constructor() { socket = this; this.handlers = {}; queueMicrotask(() => this.emit('open', {})); }
    addEventListener(name, handler) { (this.handlers[name] ??= []).push(handler); }
    emit(name, data) { for (const handler of this.handlers[name] ?? []) handler(data); }
    send() {} close() { this.emit('close', { code: 1000, wasClean: true, reason: 'private reason' }); }
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({ webSocketUrl: 'ws://127.0.0.1:1234/devtools/page/private', targetId: 'id' }), WebSocketImpl: Socket, measure: e => events.push(e) });
  const pending = rpc.request('thread/read', {}).catch(e => e.code);
  await new Promise(resolve => setImmediate(resolve));
  socket.emit('close', { code: 1006, wasClean: false, reason: 'private reason' });
  assert.equal(await pending, 'codex-native-rpc-closed');
  const closed = events.find(e => e.event === 'socket_close');
  assert.equal(closed.code, 1006); assert.equal(closed.wasClean, false); assert.equal(closed.localReason, undefined);
  assert.ok(events.find(e => e.event === 'close_affected').requestId);
  assert.ok(!JSON.stringify(events).includes('private'));
  class FailingSocket extends Socket { send() { throw new Error('private'); } }
  const failing = createCodexNativeRpc({ discover: async () => ({ webSocketUrl: 'fake:' }), WebSocketImpl: FailingSocket, measure: e => events.push(e) });
  await assert.rejects(failing.request('thread/read', {}));
  assert.ok(events.find(e => e.event === 'send_error').commandId);
});
