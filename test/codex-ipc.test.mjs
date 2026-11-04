import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readCodexSessionModel, interruptCodexSession, nativeRpcExpression } from '../src/codex-ipc.mjs';

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

test('native renderer RPC uses correlated app-server envelope and only returns model config fields', async () => {
  const listeners = new Set(), requests = [];
  const window = { addEventListener: (_, cb) => listeners.add(cb), removeEventListener: (_, cb) => listeners.delete(cb),
    electronBridge: { sendMessageFromView: async value => {
      requests.push(value);
      const message = { id: value.request.id, result: { config: { model: 'actual', model_reasoning_effort: 'max', secret: 'must stay inside renderer' } } };
      queueMicrotask(() => { for (const cb of listeners) cb({ data: { type: 'mcp-response', hostId: 'local', message } }); });
    } } };
  const model = await Function('window', `return ${nativeRpcExpression('config/read', { includeLayers: false, cwd: 'D:/work' }, 1000)}`)(window);
  assert.deepEqual(model, { model: 'actual', provider: 'openai', reasoningEffort: 'max', profile: null });
  assert.equal(requests[0].type, 'mcp-request'); assert.equal(requests[0].request.params.cwd, 'D:/work');
  assert.deepEqual(await Function('window', `return ${nativeRpcExpression('thread/delete', { threadId: 'owned' }, 1000)}`)(window), { deleted: true });
  assert.equal(listeners.size, 0);
  assert.throws(() => nativeRpcExpression('turn/start', {}, 1000), { code: 'codex-native-rpc-unsupported' });
});
