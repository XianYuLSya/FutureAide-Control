// Existing Codex Desktop owner routing; never starts an app-server or CLI.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const METHODS = new Map([['thread-owner-discovery', 1], ['thread-follower-read-model-settings', 1],
  ['thread-follower-interrupt-turn', 3]]);
const fail = (code, message) => Object.assign(new Error(message), { code });

export function requestCodexIpc(method, params, { connect = net.createConnection,
  pipePath = '\\\\.\\pipe\\codex-ipc', timeoutMs = 10000, targetClientId } = {}) {
  if (!METHODS.has(method)) throw fail('codex-ipc-unsupported', `Unsupported desktop owner operation: ${method}`);
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath);
    let received = Buffer.alloc(0), clientId = 'initializing-client', requestId;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(fail('codex-ipc-timeout', 'The desktop owner did not answer.')), timeoutMs);
    function send(name, argumentsValue, version) {
      requestId = randomUUID();
      const payload = Buffer.from(JSON.stringify({ type: 'request', requestId, sourceClientId: clientId,
        method: name, params: argumentsValue, version, timeoutMs,
        ...(name !== 'initialize' && targetClientId ? { targetClientId } : {}) }));
      const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
      socket.write(Buffer.concat([header, payload]));
    }
    socket.on('error', error => finish(fail('codex-desktop-unavailable', error.message)));
    socket.on('close', () => finish(fail('codex-ipc-closed', 'The desktop owner connection closed.')));
    socket.on('connect', () => send('initialize', { clientType: 'futureaide-control' }, 0));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      try {
        while (received.length >= 4) {
          const length = received.readUInt32LE(0);
          if (!length || length > 16 * 1024 * 1024) throw fail('codex-ipc-invalid-response', 'Invalid desktop frame.');
          if (received.length < length + 4) break;
          const response = JSON.parse(received.subarray(4, length + 4).toString('utf8'));
          received = received.subarray(length + 4);
          if (response.type === 'client-discovery-request') {
            const value = Buffer.from(JSON.stringify({ type: 'client-discovery-response', requestId: response.requestId,
              response: { canHandle: false } }));
            const header = Buffer.alloc(4); header.writeUInt32LE(value.length); socket.write(Buffer.concat([header, value]));
            continue;
          }
          if (response.type !== 'response' || response.requestId !== requestId) continue;
          if (response.resultType !== 'success') throw fail('codex-owner-unavailable', response.error || 'Desktop owner rejected the request.');
          if (clientId === 'initializing-client') {
            if (typeof response.result?.clientId !== 'string') throw fail('codex-ipc-invalid-response', 'Missing desktop client identity.');
            clientId = response.result.clientId;
            send(method, params, method === 'thread-follower-interrupt-turn' && params.expectedTurnId ? 4 : METHODS.get(method));
          } else {
            if (response.method !== method) throw fail('codex-ipc-invalid-response', 'Desktop response method mismatch.');
            finish(null, response.result);
          }
        }
      } catch (error) { finish(error); }
    });
  });
}

export async function readCodexSessionModel(threadId, options) {
  const { settings } = await requestCodexIpc('thread-follower-read-model-settings', { conversationId: threadId }, options);
  if (!settings?.model) throw fail('codex-model-unavailable', 'The desktop owner has no live model selection.');
  return { provider: settings.modelProvider ?? 'openai', model: settings.model,
    reasoningEffort: settings.reasoningEffort, verified: true, resolved: true };
}

export async function interruptCodexSession(threadId, { expectedTurnId, ...options } = {}) {
  const result = await requestCodexIpc('thread-follower-interrupt-turn', {
    conversationId: threadId, mode: 'system', ...(expectedTurnId ? { expectedTurnId } : {}),
  }, options);
  return { interrupted: result?.ok === true, ...result };
}
