import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexNativeRpc } from '../src/codex-ipc.mjs';

function recoveryFixture(t, options = {}) {
  const sockets = [], events = [];
  class Socket extends EventTarget {
    constructor() {
      super();
      sockets.push(this);
      this.frames = [];
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(raw) { this.frames.push(JSON.parse(raw)); }
    reply(index, value) {
      const id = this.frames[index].id;
      const data = JSON.stringify({ id, result: { result: { value } } });
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({ webSocketUrl: 'memory:isolated' }),
    WebSocketImpl: Socket, measure: event => events.push(event), ...options });
  t.after(() => rpc.close());
  async function nextEvent(match) {
    const end = Date.now() + 3000;
    do {
      const event = events.find(match);
      if (event) return event;
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (Date.now() < end);
    assert.fail('Expected transport event did not occur');
  }
  return { rpc, sockets, events, nextEvent };
}

test('a peer close between calls makes the next write wait for a verified socket', async t => {
  const { rpc, sockets, events, nextEvent } = recoveryFixture(t);
  const original = rpc.request('thread/list', {});
  await nextEvent(e => e.event === 'send' && e.method === 'thread/list');
  sockets[0].reply(0, { data: [] });
  await original;
  sockets[0].close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sockets.length, 1, 'an idle process does not keep reconnecting');
  const write = rpc.request('turn/start', {});
  const probe = await nextEvent(e => e.event === 'send' && e.source === 'recovery-probe');
  assert.equal(sockets[1].frames.length, 1);
  sockets[1].reply(0, { data: [] });
  await nextEvent(e => e.event === 'send' && e.method === 'turn/start');
  sockets[1].reply(1, { turn: { id: 'accepted' } });
  assert.deepEqual(await write, { turn: { id: 'accepted' } });
  assert.equal(events.filter(e => e.event === 'send' && e.generation === probe.generation).length, 2);
});

test('a failed recovery probe never sends the waiting write', async t => {
  const { rpc, sockets, events, nextEvent } = recoveryFixture(t, { probeTimeoutMs: 50 });
  rpc.ensureProbe();
  const probe = await nextEvent(event => event.event === 'send' && event.source === 'recovery-probe');
  await assert.rejects(rpc.request('turn/start', {}), {
    code: 'codex-native-rpc-unavailable', notSent: true, transportAdmissionFailed: true,
    transportGeneration: probe.generation, transportFaultSequence: 1,
  });
  assert.equal(sockets[0].frames.length, 1, 'only the read-only probe reached the socket');
  assert.equal(events.find(event => event.event === 'close_requested').reason, 'recovery-probe-failed');
  assert.equal(events.some(event => event.event === 'close_affected' && event.method === 'turn/start'), false);
});

test('a request joining a recovery retry sends once after the replacement passes the probe', async t => {
  const { rpc, sockets, events, nextEvent } = recoveryFixture(t);
  const recovered = [];
  rpc.subscribeRecovery(event => recovered.push(event));
  rpc.ensureProbe();
  const missed = await nextEvent(event => event.event === 'send' && event.source === 'recovery-probe');
  sockets[0].reply(0, { wrongResponse: true });
  await nextEvent(event => event.event === 'close_requested' && event.generation === missed.generation);

  const write = rpc.request('turn/start', {});
  const read = rpc.request('thread/read', {});
  let roundOpen = true;
  const stoppedWrite = rpc.request('turn/steer', {}, { blockReason: () => roundOpen ? undefined : 'round-finished' });
  const stopped = assert.rejects(stoppedWrite, { code: 'round-finished', terminal: true, notSent: true });
  const probe = await nextEvent(event => event.event === 'send' && event.source === 'recovery-probe'
    && event.generation !== missed.generation);
  assert.equal(sockets[1].frames.length, 1);
  roundOpen = false;
  sockets[1].reply(0, { data: [] });

  const writeFrame = await nextEvent(event => event.event === 'send' && event.method === 'turn/start');
  const readFrame = await nextEvent(event => event.event === 'send' && event.method === 'thread/read');
  assert.equal(writeFrame.generation, probe.generation);
  assert.equal(readFrame.generation, probe.generation);
  assert.deepEqual(recovered.map(event => event.mode), ['new']);
  const socket = sockets[1];
  socket.reply(socket.frames.findIndex(frame => frame.id === writeFrame.commandId), { turn: { id: 'turn-1' } });
  socket.reply(socket.frames.findIndex(frame => frame.id === readFrame.commandId), { thread: { id: 'thread-1' } });
  assert.deepEqual(await write, { turn: { id: 'turn-1' } });
  assert.deepEqual(await read, { thread: { id: 'thread-1' } });
  await stopped;
  assert.deepEqual(events.filter(event => event.event === 'send').map(event => event.method),
    ['thread/list', 'thread/list', 'turn/start', 'thread/read']);
});

test('an admission timeout leaves the probe alone to recover and close when idle', async t => {
  const { rpc, sockets, events, nextEvent } = recoveryFixture(t, { timeoutMs: 25, idleMs: 5, probeTimeoutMs: 500 });
  const recovered = [];
  rpc.subscribeRecovery(event => recovered.push(event));
  rpc.ensureProbe();
  const probe = await nextEvent(event => event.event === 'send' && event.source === 'recovery-probe');
  await assert.rejects(rpc.request('turn/start', {}), {
    code: 'codex-native-rpc-timeout', notSent: true, transportAdmissionFailed: true,
    transportGeneration: probe.generation, transportFaultSequence: 1,
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.some(event => event.event === 'close_requested'), false);
  assert.equal(sockets[0].frames.length, 1);
  sockets[0].reply(0, { data: [] });
  await nextEvent(event => event.event === 'close_requested' && event.reason === 'idle');
  assert.deepEqual(recovered.map(event => event.mode), ['new']);
});

test('closing a verified connection after a write leaves the write outcome unknown', async t => {
  const { rpc, sockets, events, nextEvent } = recoveryFixture(t);
  rpc.ensureProbe();
  await nextEvent(event => event.event === 'send' && event.source === 'recovery-probe');
  const write = rpc.request('turn/start', {});
  sockets[0].reply(0, { data: [] });
  await nextEvent(event => event.event === 'send' && event.method === 'turn/start');
  sockets[0].close();
  await assert.rejects(write, error => error.code === 'codex-native-rpc-closed'
    && error.notSent === undefined && error.transportAdmissionFailed === undefined);
  assert.equal(events.filter(event => event.event === 'send' && event.method === 'turn/start').length, 1);
});

test('the page response deadline starts recovery; a native application timeout rejection does not', async () => {
  const window = new EventTarget();
  let probes = 0, rejectNative = false;
  window.electronBridge = { sendMessageFromView({ request }) {
    if (!rejectNative && request.method === 'thread/read') return;
    if (request.method === 'thread/list') probes++;
    const reply = rejectNative ? { error: { code: 'timeout', message: 'Application rejected this request' } } : { result: { data: [] } };
    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'mcp-response', hostId: 'local', message: { id: request.id, ...reply } },
    })));
  } };
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    async send(frame) {
      const { id, params } = JSON.parse(frame);
      const value = await Function('window', 'return ' + params.expression)(window);
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result: { result: { value } } }) }));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({ webSocketUrl: 'memory:only' }),
    WebSocketImpl: Socket, timeoutMs: 30, probeTimeoutMs: 200 });
  const recovered = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('page deadline did not start recovery')), 3000);
    rpc.subscribeRecovery(event => { clearTimeout(timer); resolve(event); });
  });
  try {
    await assert.rejects(rpc.request('thread/read', {}), { code: 'codex-native-rpc-response-timeout' });
    assert.equal((await recovered).mode, 'same');
    rejectNative = true;
    await assert.rejects(rpc.request('thread/read', {}), { code: 'codex-native-rpc-rejected', rpcCode: 'timeout' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(probes, 1);
  } finally { rpc.close(); }
});

test('a cold probe survives failed discovery and retries without an incoming tool call', async () => {
  let discoveries = 0, closed = 0;
  class Socket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(frame) {
      const { id } = JSON.parse(frame);
      const data = JSON.stringify({ id, result: { result: { value: { data: [] } } } });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
    }
    close() { closed++; this.dispatchEvent(new Event('close')); }
  }
  const rpc = createCodexNativeRpc({ idleMs: 20, WebSocketImpl: Socket, discover: async () => {
    if (++discoveries === 1) throw Object.assign(new Error('fixture unavailable'), { code: 'codex-native-rpc-unavailable' });
    return { webSocketUrl: 'memory:isolated' };
  } });
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('no recovery after failed discovery')), 4000);
    rpc.subscribeRecovery(event => { clearTimeout(timeout); resolve(event); });
  });
  rpc.ensureProbe();
  assert.equal((await done).mode, 'new');
  assert.equal(discoveries, 2);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(closed, 1, 'a probe-only connection releases its socket while idle');
  rpc.close();
});

test('read timeout preserves sibling and same-generation probe notifies once', async () => {
  const recovery = []; let count = 0, closed = 0;
  class Socket {
    constructor() { this.handlers = {}; queueMicrotask(() => this.emit('open', {})); }
    addEventListener(n, f) { (this.handlers[n] ??= []).push(f); }
    emit(n, x) { for (const f of this.handlers[n] ?? []) f(x); }
    send(raw) { const req = JSON.parse(raw); const n = ++count;
      if (n === 2) setTimeout(() => this.emit('message', { data: JSON.stringify({ id:req.id, result:{result:{value:{old:true}}} }) }), 950);
      if (n === 3) queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id:req.id, result:{result:{value:{data:[]}}} }) }));
      if (n === 4) queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id:req.id, result:{result:{value:{ok:true}}} }) }));
    }
    close() { closed++; this.emit('close', {}); }
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({webSocketUrl:'fake:'}), WebSocketImpl: Socket, timeoutMs: 5, probeTimeoutMs: 100, onRecovery: e => recovery.push(e) });
  const first = rpc.request('thread/read', {}).catch(e => e.code);
  await new Promise(r => setTimeout(r, 100));
  const sibling = rpc.request('thread/read', {});
  assert.equal(await first, 'codex-native-rpc-response-timeout');
  assert.deepEqual(await sibling, {ok:true});
  assert.equal(closed, 0); assert.equal(recovery.length, 1); assert.equal(recovery[0].mode, 'same');
  rpc.close();
});

test('cold recovery probe is single-flight and announces a new generation', async () => {
  let sockets = 0, sends = 0; const events = [];
  class Socket {
    constructor() { sockets++; this.handlers = {}; queueMicrotask(() => this.emit('open', {})); }
    addEventListener(n, f) { (this.handlers[n] ??= []).push(f); }
    emit(n, x) { for (const f of this.handlers[n] ?? []) f(x); }
    send(raw) { sends++; const req = JSON.parse(raw); queueMicrotask(() => this.emit('message', { data: JSON.stringify({id:req.id,result:{result:{value:{data:[]}}}}) })); }
    close() { this.emit('close', {}); }
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({webSocketUrl:'fake:'}), WebSocketImpl: Socket });
  const done = new Promise(resolve => { const off = rpc.subscribeRecovery(event => { events.push(event); off(); resolve(); }); });
  rpc.ensureProbe(); rpc.ensureProbe(); await done;
  assert.equal(sockets, 1); assert.equal(sends, 1); assert.equal(events[0].mode, 'new');
  rpc.close();
});


test('hung generation is replaced and late replies cannot announce recovery', async () => {
  let sockets = 0, first; const events = []; let oldCommand;
  class Socket {
    constructor() { this.number = ++sockets; this.handlers = {}; if (this.number === 1) first = this; queueMicrotask(() => this.emit('open', {})); }
    addEventListener(n, f) { (this.handlers[n] ??= []).push(f); }
    emit(n, x) { for (const f of this.handlers[n] ?? []) f(x); }
    send(raw) { const req = JSON.parse(raw); if (this.number === 1) { oldCommand = req.id; return; }
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({id:req.id,result:{result:{value:{data:[]}}}}) })); }
    close() { this.emit('close', {}); }
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({webSocketUrl:'fake:'}), WebSocketImpl: Socket, probeTimeoutMs: 40 });
  const old = rpc.request('thread/read', {}).catch(e => e.code);
  await new Promise(resolve => setImmediate(resolve));
  const started = Date.now();
  const done = new Promise(resolve => rpc.subscribeRecovery(event => { events.push(event); resolve(); }));
  rpc.ensureProbe(); await done;
  assert.equal(await old, 'codex-native-rpc-closed');
  assert.equal(events[0].mode, 'new'); assert.ok(Date.now() - started < 5000); assert.equal(sockets, 2);
  first.emit('message', {data:JSON.stringify({id:oldCommand,result:{result:{value:{data:[]}}}})});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.length, 1); rpc.close();
});

test('slow discovery is shared and not cut short by socket deadline', async () => {
  let discoveries = 0, sockets = 0;
  class Socket {
    constructor() { sockets++; this.handlers = {}; queueMicrotask(() => this.emit('open', {})); }
    addEventListener(n, f) { (this.handlers[n] ??= []).push(f); }
    emit(n, x) { for (const f of this.handlers[n] ?? []) f(x); }
    send(raw) { const req = JSON.parse(raw); queueMicrotask(() => this.emit('message', {data:JSON.stringify({id:req.id,result:{result:{value:{data:[]}}}})})); }
    close() { this.emit('close', {}); }
  }
  const rpc = createCodexNativeRpc({ discover: async () => { discoveries++; await new Promise(r => setTimeout(r, 1300)); return {webSocketUrl:'fake:'}; }, WebSocketImpl: Socket, probeTimeoutMs: 100 });
  const done = new Promise(resolve => rpc.subscribeRecovery(resolve)); rpc.ensureProbe(); rpc.ensureProbe();
  const event = await done; assert.equal(event.mode, 'new'); assert.equal(discoveries, 1); assert.equal(sockets, 1); rpc.close();
});

test('older same-generation timeout after recovery does not reopen fault', async () => {
  let count = 0, closes = 0; const events = [];
  class Socket {
    constructor() { this.handlers = {}; queueMicrotask(() => this.emit('open', {})); }
    addEventListener(n, f) { (this.handlers[n] ??= []).push(f); }
    emit(n, x) { for (const f of this.handlers[n] ?? []) f(x); }
    send(raw) { const req = JSON.parse(raw); if (++count === 3) queueMicrotask(() => this.emit('message', {data:JSON.stringify({id:req.id,result:{result:{value:{data:[]}}}})})); }
    close() { closes++; this.emit('close', {}); }
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({webSocketUrl:'fake:'}), WebSocketImpl: Socket, timeoutMs: 5, probeTimeoutMs: 100, onRecovery: x => events.push(x) });
  const a = rpc.request('thread/read', {}).catch(e => e); await new Promise(r => setTimeout(r, 100));
  const b = rpc.request('thread/read', {}).catch(e => e); const first = await a; const second = await b;
  assert.equal(first.transportFaultSequence, 1); assert.equal(second.transportFaultSequence, 1);
  await new Promise(r => setTimeout(r, 80)); assert.equal(events.length, 1); assert.equal(count, 3); assert.equal(closes, 0); rpc.close();
});
