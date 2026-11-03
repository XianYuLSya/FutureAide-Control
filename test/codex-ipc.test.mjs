import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readCodexSessionModel, interruptCodexSession } from '../src/codex-ipc.mjs';

function fakeConnect(responder, calls) {
  return () => {
    const socket = new EventEmitter(); socket.destroy = () => {};
    socket.write = buffer => {
      const request = JSON.parse(buffer.subarray(4)); calls.push(request);
      const result = request.method === 'initialize' ? { clientId: 'client' } : responder(request);
      const data = Buffer.from(JSON.stringify({ type: 'response', requestId: request.requestId,
        method: request.method, resultType: 'success', result }));
      const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
      queueMicrotask(() => { socket.emit('data', header.subarray(0, 2)); socket.emit('data', Buffer.concat([header.subarray(2), data])); });
    };
    queueMicrotask(() => socket.emit('connect')); return socket;
  };
}
test('desktop owner protocol handles split frames and exact interrupt version', async () => {
  const calls = [];
  const connect = fakeConnect(request => request.method.includes('read-model') ? { settings: { model: 'native', reasoningEffort: 'max', modelProvider: 'openai' } } : { ok: true }, calls);
  assert.equal((await readCodexSessionModel('owned', { connect })).model, 'native');
  assert.equal((await interruptCodexSession('owned', { connect, expectedTurnId: 'turn' })).interrupted, true);
  const last = calls.at(-1); assert.equal(last.version, 4); assert.equal(last.params.conversationId, 'owned');
  assert.equal(last.params.mode, 'system'); assert.equal(last.params.expectedTurnId, 'turn');
});
