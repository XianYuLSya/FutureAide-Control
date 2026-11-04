// Existing Codex Desktop owner routing; never starts an app-server or CLI.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';

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

// The running Desktop already opens this local debug endpoint. Never restart it
// with extra flags or connect to a web/account/browser profile instead.
const DISCOVER_RENDERER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$all = @(Get-CimInstance Win32_Process)
$native = @($all | Where-Object {
  $_.ExecutablePath -and $_.Name -match '^(ChatGPT|Codex)\.exe$' -and
  $_.CommandLine -match '--remote-debugging-port=' -and $_.CommandLine -notmatch '--type=' -and
  (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $_.ExecutablePath) 'resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs'))
})
@(Get-NetTCPConnection -State Listen | Where-Object {
  $_.OwningProcess -in $native.ProcessId -and $_.LocalAddress -eq '127.0.0.1'
} | ForEach-Object { [pscustomobject]@{ port=$_.LocalPort; pid=$_.OwningProcess } }) | ConvertTo-Json -Compress
`;

export async function discoverCodexRenderer() {
  if (process.platform !== 'win32') throw fail('codex-native-rpc-unavailable', 'Desktop renderer discovery is currently implemented for Windows.');
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const endpoints = await new Promise((resolve, reject) => execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', DISCOVER_RENDERER],
    { windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(fail('codex-native-rpc-unavailable', 'Could not locate the running Desktop native endpoint.'));
      try { const parsed = stdout.trim() ? JSON.parse(stdout) : []; resolve(Array.isArray(parsed) ? parsed : [parsed]); } catch (error) { reject(error); }
    }));
  const matches = [];
  for (const endpoint of endpoints) {
    try {
      const origin = `http://127.0.0.1:${endpoint.port}`;
      const targets = await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(1500) }).then(r => r.json());
      const pages = targets.filter(t => t.type === 'page' && t.url === 'app://-/index.html');
      for (const target of pages) {
        const ws = new URL(target.webSocketDebuggerUrl);
        if (ws.hostname === '127.0.0.1' && ws.port === String(endpoint.port) && ws.pathname.startsWith('/devtools/page/')) {
          matches.push({ endpoint, target, webSocketUrl: ws.href });
        }
      }
    } catch { /* An unrelated local listener is never used as a fallback. */ }
  }
  if (new Set(matches.map(m => m.endpoint.pid)).size !== 1 || matches.length !== 1) {
    throw fail('codex-native-rpc-unavailable', 'Exactly one running Codex main renderer must be available.');
  }
  return { webSocketUrl: matches[0].webSocketUrl, pid: matches[0].endpoint.pid, targetId: matches[0].target.id };
}

export function nativeRpcExpression(method, params, timeoutMs) {
  if (!['config/read', 'thread/delete'].includes(method)) throw fail('codex-native-rpc-unsupported', 'Unsupported native Desktop method.');
  const request = JSON.stringify({ id: `futureaide-native-${randomUUID()}`, method, params });
  // Read config inside the renderer but return only model fields. Auth, provider
  // keys and unrelated configuration never cross the CDP connection.
  return `new Promise((resolve,reject)=>{const request=${request};let timer;
    const finish=(error,value)=>{clearTimeout(timer);window.removeEventListener('message',listen);error?reject(error):resolve(value)};
    function listen(event){const d=event.data;if(d?.type!=='mcp-response'||d.hostId!=='local'||d.message?.id!==request.id)return;
      const m=d.message;if(m.error)return finish(new Error('Native request rejected ('+m.error.code+')'));
      if(request.method==='config/read'){const c=m.result?.config??{};finish(null,{model:c.model,provider:c.model_provider??'openai',reasoningEffort:c.model_reasoning_effort,profile:c.profile??null});}
      else finish(null,{deleted:true});}
    timer=setTimeout(()=>finish(new Error('Native Desktop response timed out')),${timeoutMs});
    window.addEventListener('message',listen);
    window.electronBridge.sendMessageFromView({type:'mcp-request',hostId:'local',request}).catch(e=>finish(e));})`;
}

/** One existing renderer socket per monitor process. No model runner or per-name
 * process is created. A failed mutation is never retried by this transport. */
export function createCodexNativeRpc({ discover = discoverCodexRenderer, WebSocketImpl = WebSocket,
  idleMs = 30000, timeoutMs = 15000 } = {}) {
  let connection, timer, sequence = 0, active = 0;
  function close(target = connection) {
    clearTimeout(timer);
    if (connection === target) connection = undefined;
    target?.socket?.close();
  }
  async function connect(target) {
    const endpoint = await discover();
    const socket = target.socket = new WebSocketImpl(endpoint.webSocketUrl);
    target.pending = new Map();
    socket.addEventListener('message', event => {
      const value = JSON.parse(event.data), waiter = target.pending.get(value.id);
      if (!waiter) return;
      target.pending.delete(value.id); clearTimeout(waiter.timer);
      if (value.error || value.result?.exceptionDetails) waiter.reject(fail('codex-native-rpc-rejected', value.error?.message ?? value.result.exceptionDetails.exception?.description ?? 'Native Desktop request failed.'));
      else waiter.resolve(value.result?.result?.value);
    });
    socket.addEventListener('close', () => {
      if (connection === target) connection = undefined;
      for (const waiter of target.pending.values()) { clearTimeout(waiter.timer); waiter.reject(fail('codex-native-rpc-closed', 'Native Desktop connection closed.')); }
      target.pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(fail('codex-native-rpc-timeout', 'Native Desktop connection timed out.')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(fail('codex-native-rpc-unavailable', 'Native Desktop connection failed.')); }, { once: true });
    });
    return target;
  }
  return { close, async request(method, params) {
    const expression = nativeRpcExpression(method, params, timeoutMs);
    clearTimeout(timer); active++;
    let target;
    try {
      if (!connection) { connection = {}; connection.ready = connect(connection); }
      target = connection; await target.ready;
      const id = ++sequence;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { target.pending.delete(id); reject(fail('codex-native-rpc-timeout', 'Native Desktop request timed out.')); }, timeoutMs + 1000);
        target.pending.set(id, { resolve, reject, timer });
        target.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
    } catch (error) { close(target); throw error; }
    finally { if (!--active) { timer = setTimeout(() => close(), idleMs); timer.unref?.(); } }
  } };
}

const nativeRpc = createCodexNativeRpc();
export const requestCodexNative = (method, params) => nativeRpc.request(method, params);
export const closeCodexNative = () => nativeRpc.close();
