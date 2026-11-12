// The Codex dispatch write gate.
//
// The shared layer hands each dispatch a fence (`writeBlockReason`) with the call itself;
// it reads the current name's row, so every answer is current. The shared loop already
// asks it once before calling the adapter, but a Codex write can still be far away: the
// host lock may queue, a cold thread is resumed, turns are listed. These cases pin the
// places the adapter asks again, that a refusal is reported as "never sent" instead of
// the ambiguous "unknown" a real transport failure produces, and that an accepted native
// receipt always wins over a fence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { createCodexNativeRpc } from '../src/codex-ipc.mjs';
import { livePage, liveThread, liveTurn } from './live-thread-fixture.mjs';
import { CODEX_MODELS } from './assembly/renderer.mjs';

const WORKSPACE = 'D:/work/project';

/** The Codex Desktop RPC, reduced to the threads one managed dispatch reads and writes. */
function desktop() {
  const calls = [], threads = new Map(), hooks = {};
  let clock = 1793932679, created = 0;
  const find = id => {
    const thread = threads.get(id);
    if (!thread) throw Object.assign(new Error(`thread not found: ${id}`), { code: 'codex-thread-not-found' });
    return thread;
  };
  const view = thread => liveThread({ id: thread.id, cwd: thread.cwd, name: thread.name, model: thread.model,
    reasoningEffort: thread.effort, updatedAt: ++clock,
    status: { type: thread.active ? 'active' : thread.loaded ? 'idle' : 'notLoaded' } });
  async function request(method, params = {}, options) {
    // The transport asks the fence a last time once the page is live, right before the
    // write is committed. The stand-in does the same for the same three methods, and a
    // refused write is not counted: it never reached the page.
    if (['thread/start', 'turn/start', 'turn/steer'].includes(method) && typeof options?.blockReason === 'function') {
      hooks.beforeRequestGate?.(method);
      const refused = options.blockReason();
      if (typeof refused === 'string' && refused) {
        throw Object.assign(new Error('refused at the transport'), { code: refused, terminal: true, notSent: true });
      }
    }
    calls.push({ method, params: structuredClone(params) });
    switch (method) {
      case 'config/read': return { model: 'gpt-6-astra', provider: 'openai', reasoningEffort: 'high', profile: null };
      case 'model/list': return livePage(structuredClone(CODEX_MODELS));
      case 'thread/list': return livePage();
      case 'thread/start': {
        const id = `thread-${String(++created).padStart(4, '0')}`;
        threads.set(id, { id, cwd: params.cwd, name: null, loaded: true, active: false,
          model: 'gpt-6-astra', effort: 'high', turns: [] });
        hooks.afterThreadStart?.(id);
        return { thread: view(find(id)) };
      }
      case 'thread/read': return { thread: view(find(params.threadId)) };
      case 'thread/resume': {
        const thread = find(params.threadId);
        thread.loaded = true;
        hooks.afterResume?.(thread.id);
        return { thread: view(thread) };
      }
      case 'thread/name/set': { find(params.threadId).name = params.name; return {}; }
      case 'thread/turns/list': {
        const thread = find(params.threadId);
        hooks.afterTurnsList?.(params.threadId);
        if (!thread.turns.length) return livePage([]);
        const items = turn => params.itemsView === 'summary'
          ? turn.items.filter(item => item.type === 'userMessage') : [];
        return livePage([...thread.turns].reverse().map(turn => liveTurn({ id: turn.id, rootTurnId: turn.id,
          status: turn.status, startedAt: turn.startedAt, items: items(turn) })));
      }
      case 'turn/start': {
        const thread = find(params.threadId);
        const turn = { id: `turn-${++clock}`, status: 'inProgress', startedAt: ++clock,
          items: [{ id: `item-${++clock}`, type: 'userMessage', content: [{ type: 'text', text: '' }] }] };
        thread.turns.push(turn); thread.active = true;
        return { turn: liveTurn({ id: turn.id, rootTurnId: turn.id, status: 'inProgress', items: [] }) };
      }
      case 'turn/steer': {
        const thread = find(params.threadId);
        const turn = thread.turns.find(item => item.status === 'inProgress');
        if (!turn || turn.id !== params.expectedTurnId) throw new Error('no active turn to steer');
        return { turnId: turn.id };
      }
      default: throw new Error(`unexpected native method ${method}`);
    }
  }
  return {
    request, calls, hooks,
    count: method => calls.filter(call => call.method === method).length,
    paramsOf: method => calls.filter(call => call.method === method).map(call => call.params),
    add(spec) { threads.set(spec.id, { cwd: WORKSPACE, name: null, active: false, turns: [], model: 'gpt-6-astra',
      effort: 'high', loaded: true, ...spec }); },
  };
}

/** A managed name with one saved binding (or none), plus the fence the shared layer hands in. */
async function fixture({ binding, thread = {}, onWrite, lock } = {}) {
  const native = desktop();
  let saved, reason, writes = 0;
  const record = { name: 'helper', agentId: 'a', sessionId: 'logical', workspace: WORKSPACE,
    task: { taskId: 'task-1' } };
  if (binding) native.add({ id: binding, ...thread });
  const backend = await createCodexBackend(record, {
    load: () => record,
    readNativeState: () => saved && structuredClone(saved),
    writeNativeState: value => { saved = structuredClone(value); writes += 1; onWrite?.(writes); return true; },
    ensureCodexReports: async () => ({ ready: true }),
    readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: [], reports: [] }),
    hostOptions: { nativeRequest: native.request },
    withHostLock: lock ?? (async action => action()),
  });
  if (binding) {
    saved = { requests: {}, projections: {}, binding: { sessionId: binding, owned: true },
      tree: { nodes: [{ sessionId: binding, parentSessionId: null, status: 'idle', changes: [] }] } };
  }
  return { backend, native, record, state: () => saved, writes: () => writes,
    block: value => { reason = value; }, fence: () => reason };
}

test('a round that ended while the lock was queued is refused before the attempt is recorded', async () => {
  let f;
  // The round ends while this dispatch waits for the host lock.
  f = await fixture({ binding: 'root-1', lock: async action => { f.block('round-finished'); return action(); } });

  await assert.rejects(f.backend.deliver({ requestId: 'r1', message: 'work', writeBlockReason: f.fence }), error => {
    assert.equal(error.code, 'round-finished');
    assert.equal(error.terminal, true);
    assert.equal(error.notSent, true, 'the caller can tell this apart from an unknown write');
    return true;
  });
  assert.equal(f.native.count('turn/start'), 0, 'nothing was written');
  assert.equal(f.native.count('thread/resume'), 0, 'not even a resume was attempted');
  const record = f.state().requests.r1;
  assert.equal(record.attempted, false, 'an un-attempted request is never marked attempted');
  assert.equal(record.status, 'rejected', 'and it is terminal, so it can never be revived as a send');
  assert.equal((await f.backend.receipt({ requestId: 'r1' })).status, 'rejected');
});

test('a round that ends while a cold thread is being read is refused after the resume', async () => {
  const f = await fixture({ binding: 'root-1', thread: { loaded: false } });
  // The thread read and its resume happen first; the round ends while they are in flight.
  f.native.hooks.afterResume = () => f.block('dispatch-expired');

  await assert.rejects(f.backend.deliver({ requestId: 'r1', message: 'work', writeBlockReason: f.fence }), error => {
    assert.equal(error.code, 'dispatch-expired');
    assert.equal(error.notSent, true);
    assert.equal(error.terminal, true);
    return true;
  });
  assert.equal(f.native.count('thread/resume'), 1, 'the read and resume were the ordinary path');
  assert.equal(f.native.count('turn/start'), 0, 'the turn itself was never sent');
  assert.equal(f.state().requests.r1.status, 'rejected', 'a fence refusal always reads as rejected');
  assert.equal(f.state().requests.r1.attempted, true, 'this one was attempted, and was refused as not sent');
});

test('a round that ends before the new thread is created never starts a thread', async () => {
  let f;
  // The attempt record is written inside the lock; the round ends right after it.
  f = await fixture({ onWrite: count => { if (count === 2) f.block('round-finished'); } });

  await assert.rejects(f.backend.deliver({ requestId: 'r1', message: 'work', writeBlockReason: f.fence }), error => {
    assert.equal(error.code, 'round-finished');
    assert.equal(error.notSent, true);
    return true;
  });
  assert.equal(f.native.count('thread/start'), 0, 'no thread was created for a finished round');
  assert.equal(f.state().binding, undefined);
  assert.equal(f.state().requests.r1.status, 'rejected');
  assert.equal(f.state().requests.r1.refused, 'round-finished');
});

test('a thread created before the round ended stays owned and never gets a turn', async () => {
  const f = await fixture();
  f.native.hooks.afterThreadStart = () => f.block('round-finished');

  await assert.rejects(f.backend.deliver({ requestId: 'r1', message: 'work', writeBlockReason: f.fence }), error => {
    assert.equal(error.code, 'round-finished');
    assert.equal(error.notSent, true);
    return true;
  });
  assert.equal(f.native.count('thread/start'), 1);
  assert.equal(f.native.count('turn/start'), 0, 'the first turn was never started');
  const binding = f.state().binding;
  assert.equal(binding.owned, true, 'the thread that exists is still this name\'s');
  assert.equal(binding.sessionId, 'thread-0001');
  assert.equal(f.state().requests.r1.status, 'rejected', 'not unknown: nothing was written');
});

test('a round that ends while the active turn is being read is refused before the steer', async () => {
  const f = await fixture({ binding: 'root-1',
    thread: { active: true, turns: [{ id: 'turn-1', status: 'inProgress', startedAt: 1, items: [] }] } });
  // The turn page is what tells the send to steer instead of start; the round ends there.
  f.native.hooks.afterTurnsList = () => f.block('round-finished');

  await assert.rejects(f.backend.deliver({ requestId: 'r1', message: 'more', writeBlockReason: f.fence }), error => {
    assert.equal(error.code, 'round-finished');
    assert.equal(error.notSent, true);
    return true;
  });
  assert.equal(f.native.count('turn/steer'), 0, 'the steer itself was never sent');
  assert.equal(f.native.count('turn/start'), 0);
});

test('an accepted native receipt wins over the fence', async () => {
  const f = await fixture({ binding: 'root-1' });
  const first = await f.backend.deliver({ requestId: 'r1', message: 'work', writeBlockReason: f.fence });
  assert.equal(first.accepted, true);
  assert.equal(f.native.count('turn/start'), 1);

  // The round is over and the same request comes back: the native receipt already says
  // this input was accepted, so the duplicate is answered without asking the fence.
  f.block('round-finished');
  const again = await f.backend.deliver({ requestId: 'r1', message: 'work', writeBlockReason: f.fence });
  assert.equal(again.accepted, true);
  assert.equal(again.status, 'accepted');
  assert.equal(f.native.count('turn/start'), 1, 'no second write was attempted');
  assert.equal(f.state().requests.r1.status, 'accepted', 'the recorded outcome is untouched');
});

test('a round that ends while the page is being opened is refused before the write leaves', async () => {
  const sockets = [];
  class DelayedSocket {
    constructor() { this.sent = []; this.listeners = {}; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    send(data) { this.sent.push(data); }
    close() {}
    open() { for (const fn of this.listeners.open ?? []) fn(); }
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({ webSocketUrl: 'ws://127.0.0.1:1/app' }),
    WebSocketImpl: DelayedSocket, timeoutMs: 5000, idleMs: 1 });
  let reason;
  const pending = rpc.request('turn/start', { threadId: 'thread-1' }, { blockReason: () => reason });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets.length, 1, 'the cold page is being opened');
  // The round ends while the socket is still opening; the last check inside the send has
  // already passed, so only the request-level fence can stop it.
  reason = 'round-finished';
  sockets[0].open();

  await assert.rejects(pending, error => {
    assert.equal(error.code, 'round-finished');
    assert.equal(error.terminal, true);
    assert.equal(error.notSent, true);
    return true;
  });
  assert.deepEqual(sockets[0].sent, [], 'nothing was evaluated in the page');

  // The same fence on a read is ignored: only the managed writes are gated.
  const reading = rpc.request('thread/read', { threadId: 'thread-1' }, { blockReason: () => reason });
  reading.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets[0].sent.length, 1, 'a status read is never refused here');
  rpc.close();
});

test('a fence that closes only inside the native request still keeps the thread and refuses', async () => {
  const f = await fixture();
  // The host's own checks all pass; the round ends in the instant before the page write.
  f.native.hooks.beforeRequestGate = method => { if (method === 'turn/start') f.block('round-finished'); };

  await assert.rejects(f.backend.deliver({ requestId: 'r1', message: 'work', writeBlockReason: f.fence }), error => {
    assert.equal(error.code, 'round-finished');
    assert.equal(error.terminal, true, 'the typed answer is not swallowed into uncertain');
    assert.equal(error.notSent, true);
    return true;
  });
  assert.equal(f.native.count('thread/start'), 1);
  assert.equal(f.native.count('turn/start'), 0, 'the turn was never written');
  const binding = f.state().binding;
  assert.equal(binding.owned, true, 'the empty thread it did create is still owned');
  assert.equal(binding.sessionId, 'thread-0001');
  assert.equal(f.state().requests.r1.status, 'rejected', 'a refusal is a rejection, never unknown');
});

test('a dispatch without the fence keeps the old call and wire shape', async () => {
  const f = await fixture();
  const sent = await f.backend.deliver({ requestId: 'r1', message: 'work' });
  assert.equal(sent.accepted, true);
  const [start] = f.native.paramsOf('turn/start');
  assert.deepEqual(Object.keys(start).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.equal(f.state().requests.r1.status, 'accepted');
});
