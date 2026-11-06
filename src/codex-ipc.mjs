// Codex Desktop native RPC over the running renderer's local debug endpoint.
// Nothing here starts an app-server, a CLI, a window, or a model turn by itself.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);

// The methods the managed Codex path needs. config/read is kept separate below
// because its result is reduced to model fields before it leaves the renderer.
const NATIVE_METHODS = new Set([
  'config/read',
  'thread/start', 'thread/name/set', 'thread/read', 'thread/turns/list', 'thread/list',
  'thread/resume', 'thread/delete',
  'turn/start', 'turn/steer', 'turn/interrupt',
]);

const THREAD_MISSING = /(?:thread|conversation)[^.]*(?:not found|does not exist|unknown)|no (?:such )?thread|invalid thread/i;
const EMPTY_ROLLOUT = /rollout (?:is )?empty|no rollout/i;

export function codexThreadNotFound(threadId) {
  return fail('codex-thread-not-found',
    `The Codex thread ${threadId} is not visible in the current profile. If FAswitch switched accounts, switch back to the profile that created it; this managed session will not be retried automatically.`,
    { terminal: true });
}

export function isCodexThreadMissing(error) {
  return error?.code === 'codex-thread-not-found'
    || THREAD_MISSING.test(String(error?.rpcMessage ?? error?.message ?? ''));
}

/** A thread exists but its first rollout content has not been written yet. */
export function isCodexRolloutEmpty(error) {
  return error?.code === 'codex-empty-rollout'
    || EMPTY_ROLLOUT.test(String(error?.rpcMessage ?? error?.message ?? ''));
}

/** A request that never reached the desktop: safe to fall back to app-tools. */
export function isCodexRpcUnavailable(error) {
  return ['codex-native-rpc-unavailable', 'codex-native-rpc-timeout'].includes(error?.code);
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
      try { const parsed = stdout.trim() ? JSON.parse(stdout) : []; resolve(Array.isArray(parsed) ? parsed : [parsed]); } catch { reject(fail('codex-native-rpc-unavailable', 'The Desktop native endpoint discovery returned an invalid response.')); }
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
  if (!NATIVE_METHODS.has(method)) throw fail('codex-native-rpc-unsupported', 'Unsupported native Desktop method.');
  const request = JSON.stringify({ id: `futureaide-native-${randomUUID()}`, method, params });
  // The response envelope uses a sentinel for a JSON-RPC error, so its numeric
  // code survives Runtime.evaluate and can be reported as a structured failure.
  // config/read still returns only model fields: auth, provider keys and
  // unrelated configuration never cross the CDP connection.
  return `new Promise((resolve,reject)=>{const request=${request};let timer;
    const finish=(error,value)=>{clearTimeout(timer);window.removeEventListener('message',listen);error?reject(error):resolve(value)};
    function listen(event){const d=event.data;if(d?.type!=='mcp-response'||d.hostId!=='local'||d.message?.id!==request.id)return;
      const m=d.message;if(m.error)return finish(null,{__futureaideRpcError:{code:m.error.code,message:m.error.message,data:m.error.data}});
      if(request.method==='config/read'){const c=m.result?.config??{};finish(null,{model:c.model,provider:c.model_provider??'openai',reasoningEffort:c.model_reasoning_effort,profile:c.profile??null});}
      else finish(null,m.result);}
    timer=setTimeout(()=>finish(new Error('Native Desktop response timed out')),${timeoutMs});
    window.addEventListener('message',listen);
    window.electronBridge.sendMessageFromView({type:'mcp-request',hostId:'local',request}).catch(e=>finish(e));})`;
}

/** One existing renderer socket per monitor process. No model runner or per-name
 * process is created. A failed mutation is never retried by this transport. */
export function createCodexNativeRpc({ discover = discoverCodexRenderer, WebSocketImpl = WebSocket,
  idleMs = 30000, timeoutMs = 15000 } = {}) {
  let connection, timer, sequence = 0, active = 0, failedUntil = 0, failure;
  function close(target = connection) {
    clearTimeout(timer);
    if (connection === target) connection = undefined;
    target?.socket?.close();
  }
  async function endpoint() {
    // A missing debug port is a property of the running application, not of each
    // call; do not spawn a process inspection for every status or fallback attempt.
    if (failedUntil > Date.now()) throw failure;
    try { return await discover(); }
    catch (error) { failedUntil = Date.now() + 5000; failure = error; throw error; }
  }
  async function connect(target) {
    const found = await endpoint();
    const socket = target.socket = new WebSocketImpl(found.webSocketUrl);
    target.pending = new Map();
    socket.addEventListener('message', event => {
      let value;
      try { value = JSON.parse(event.data); } catch { return; }
      const waiter = target.pending.get(value.id);
      if (!waiter) return;
      target.pending.delete(value.id); clearTimeout(waiter.timer);
      if (value.error || value.result?.exceptionDetails) waiter.reject(fail('codex-native-rpc-rejected',
        value.error?.message ?? value.result.exceptionDetails.exception?.description ?? 'Native Desktop request failed.'));
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
      const value = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { target.pending.delete(id); reject(fail('codex-native-rpc-response-timeout', 'Native Desktop request timed out.')); }, timeoutMs + 1000);
        target.pending.set(id, { resolve, reject, timer });
        target.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      if (value?.__futureaideRpcError) throw fail('codex-native-rpc-rejected',
        `Native Desktop rejected ${method}: ${value.__futureaideRpcError.message}`,
        { rpcCode: value.__futureaideRpcError.code, rpcMessage: value.__futureaideRpcError.message, rpcData: value.__futureaideRpcError.data });
      return value;
    } catch (error) {
      // This socket is shared by every managed name in the monitor process. A
      // JSON-RPC/application rejection (bad params, missing thread, unsupported
      // method) must not tear down another name's in-flight write. Only a real
      // transport failure invalidates the socket.
      if (!error?.code || ['codex-native-rpc-unavailable', 'codex-native-rpc-timeout',
        'codex-native-rpc-response-timeout', 'codex-native-rpc-closed',
        'codex-native-rpc-invalid-response'].includes(error.code)) close(target);
      throw error;
    }
    finally { if (!--active) { timer = setTimeout(() => close(), idleMs); timer.unref?.(); } }
  } };
}

const nativeRpc = createCodexNativeRpc();
export const requestCodexNative = (method, params) => nativeRpc.request(method, params);
export const closeCodexNative = () => nativeRpc.close();

/** Read one thread's metadata; a profile switch is surfaced as a terminal error. */
export async function readCodexThreadNative(threadId, { request = requestCodexNative, includeTurns = false } = {}) {
  try {
    const result = await request('thread/read', { threadId, includeTurns });
    const thread = result?.thread;
    if (!thread || typeof thread.id !== 'string') throw fail('codex-native-rpc-invalid-response', 'Codex returned no thread metadata.');
    return thread;
  } catch (error) {
    if (isCodexThreadMissing(error)) throw codexThreadNotFound(threadId);
    if (isCodexRolloutEmpty(error)) throw fail('codex-empty-rollout',
      'The Codex thread exists but its rollout content is not written yet.', { threadId });
    throw error;
  }
}

/** Cold threads are resumed before a read of turns or a new turn is attempted. */
export async function ensureCodexThreadNative(threadId, { request = requestCodexNative } = {}) {
  let thread = await readCodexThreadNative(threadId, { request });
  if (thread?.status?.type !== 'notLoaded') return thread;
  try {
    const resumed = await request('thread/resume', { threadId, excludeTurns: true });
    if (resumed?.thread) return resumed.thread;
  } catch (error) {
    if (isCodexThreadMissing(error)) throw codexThreadNotFound(threadId);
    throw error;
  }
  return readCodexThreadNative(threadId, { request });
}

export async function listCodexTurnsNative(threadId, { limit = 40, request = requestCodexNative } = {}) {
  try {
    const result = await request('thread/turns/list', { threadId, limit, itemsView: 'full', sortDirection: 'desc' });
    if (!Array.isArray(result?.data)) throw fail('codex-native-rpc-invalid-response', 'Codex returned no turn page.');
    return result;
  } catch (error) {
    // A thread created by thread/start has no rollout until its first turn is
    // written; that is an empty page, not a missing thread.
    if (EMPTY_ROLLOUT.test(String(error?.rpcMessage ?? error?.message ?? ''))) return { data: [], nextCursor: null };
    if (isCodexThreadMissing(error)) throw codexThreadNotFound(threadId);
    throw error;
  }
}

/** Send text to an idle thread with turn/start, or steer the active turn. */
export async function sendCodexTextNative(threadId, text, { request = requestCodexNative } = {}) {
  await ensureCodexThreadNative(threadId, { request });
  const page = await listCodexTurnsNative(threadId, { limit: 10, request });
  const active = (page.data ?? []).find(turn => turn?.status === 'inProgress' && typeof turn.id === 'string');
  const input = [{ type: 'text', text, text_elements: [] }];
  if (active) {
    const result = await request('turn/steer', { threadId, expectedTurnId: active.id, clientUserMessageId: randomUUID(), input });
    return { ...(result ?? {}), turnId: result?.turnId ?? active.id };
  }
  return request('turn/start', { threadId, clientUserMessageId: randomUUID(), input });
}
