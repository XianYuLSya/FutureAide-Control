// Releasing one finished round's Codex threads from the adapter's own side.
//
// The monitor only decides that asking is due. Here the adapter and host are real and
// the desktop is a stand-in for its RPC endpoint, so these cases pin the part that
// actually holds the thread ids: the stored binding and tree are the only thread set,
// every read is metadata-only (a resume would subscribe the released thread again),
// and `complete` needs the app-server's own `notLoaded`, never an accepted request.
//
// The release also runs beside a live dispatch instead of behind the host write lock
// the delivery waits on, so the round identity is re-checked around every await, the
// attempt is recorded before the request leaves, and an answer that arrives after the
// round moved on is never allowed to become the new round's record.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { loadConfig } from '../src/config.mjs';
import { livePage, liveThread, liveTurn } from '../test/live-thread-fixture.mjs';
import { CODEX_MODELS } from '../test/assembly/renderer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = 'D:/work/project';

/** The Codex Desktop RPC, reduced to the threads one managed name reads and releases. */
function desktop() {
  const calls = [], threads = new Map(), answers = [], hooks = {};
  let clock = 1793932679, created = 0;
  const add = (spec = {}) => {
    const thread = { id: spec.id, cwd: spec.cwd ?? WORKSPACE, parentThreadId: spec.parent ?? null,
      forcedType: spec.type, unreadable: spec.unreadable, active: spec.active === true, loaded: spec.loaded !== false,
      name: spec.name ?? null, model: spec.model ?? 'gpt-6-astra', effort: spec.effort ?? 'high', turns: [] };
    threads.set(thread.id, thread);
    return thread;
  };
  const find = id => {
    const thread = threads.get(id);
    if (!thread) throw Object.assign(new Error(`thread not found: ${id}`), { code: 'codex-thread-not-found' });
    return thread;
  };
  // What a real thread/read answers for an idle, running or unloaded thread.
  const view = thread => liveThread({ id: thread.id, cwd: thread.cwd, parentThreadId: thread.parentThreadId,
    name: thread.name, model: thread.model, reasoningEffort: thread.effort, updatedAt: ++clock,
    status: { type: thread.forcedType ?? (thread.active ? 'active' : thread.loaded ? 'idle' : 'notLoaded') } });
  const textOf = input => (input ?? []).map(item => item.text ?? '').join('');
  async function request(method, params = {}, options) {
    calls.push({ method, params: structuredClone(params), options });
    switch (method) {
      case 'config/read': return { model: 'gpt-6-astra', provider: 'openai', reasoningEffort: 'high', profile: null };
      case 'model/list': return livePage(structuredClone(CODEX_MODELS));
      case 'thread/list': {
        if (typeof params.parentThreadId !== 'string') return livePage();
        const override = hooks.childPage?.(params);
        if (override !== undefined) return override;
        return livePage([...threads.values()]
          .filter(thread => thread.parentThreadId === params.parentThreadId).map(view));
      }
      case 'thread/start': {
        const id = `thread-${String(++created).padStart(4, '0')}`;
        add({ id, cwd: params.cwd });
        return { thread: view(find(id)) };
      }
      case 'thread/read': {
        const thread = find(params.threadId);
        // The native rejection for a child thread this connection cannot read. It is an
        // error, and this build maps it onto the same missing-thread code as a deleted
        // thread, which is exactly why it must never be read as a deletion.
        if (thread.unreadable) {
          throw Object.assign(new Error(`Native Desktop rejected thread/read: ${thread.unreadable}`),
            { code: 'codex-native-rpc-rejected', rpcMessage: thread.unreadable });
        }
        return { thread: view(thread) };
      }
      case 'thread/resume': {
        const thread = find(params.threadId);
        thread.loaded = true;
        return { thread: view(thread) };
      }
      case 'thread/name/set': { find(params.threadId).name = params.name; return {}; }
      case 'thread/unsubscribe': {
        // The release must have recorded this attempt before the request left, so the
        // next real dispatch can restore the subscription even without an answer.
        hooks.beforeUnsubscribe?.(params.threadId);
        const answer = answers.length ? answers.shift() : { status: 'unsubscribed' };
        if (answer.transportFailure) throw Object.assign(new Error('Native Desktop connection failed.'),
          { code: 'codex-native-rpc-unavailable' });
        if (answer.timeout) throw Object.assign(new Error('Native Desktop request timed out.'),
          { code: 'codex-native-rpc-response-timeout' });
        find(params.threadId);
        // The acknowledgement alone never unloads: the desktop drops the thread after
        // its own idle grace, which these cases drive with unloading().
        return answer.body ?? { status: answer.status };
      }
      case 'thread/turns/list': {
        hooks.threadTurnsList?.(params.threadId);
        const thread = find(params.threadId);
        if (params.itemsView === 'notLoaded' || !thread.turns.length) return livePage([]);
        return livePage([...thread.turns].reverse().map(turn => liveTurn({ id: turn.id, rootTurnId: turn.id,
          status: turn.status, startedAt: turn.startedAt,
          items: params.itemsView === 'summary'
            ? [turn.items.find(item => item.type === 'userMessage'),
              turn.items.findLast(item => item.type === 'agentMessage')].filter(Boolean)
            : turn.items })));
      }
      case 'turn/start': {
        const thread = find(params.threadId);
        if (params.model !== undefined) thread.model = params.model;
        if (params.effort !== undefined) thread.effort = params.effort;
        const turn = { id: `turn-${++clock}`, status: 'inProgress', startedAt: ++clock,
          items: [{ id: `item-${++clock}`, type: 'userMessage', content: [{ type: 'text', text: textOf(params.input) }] }] };
        thread.turns.push(turn); thread.active = true; thread.loaded = true;
        return { turn: liveTurn({ id: turn.id, rootTurnId: turn.id, status: 'inProgress', items: [] }) };
      }
      default: throw new Error(`unexpected native method ${method}`);
    }
  }
  return {
    request, calls, answers, add, node: find, hooks,
    count: method => calls.filter(call => call.method === method).length,
    paramsOf: method => calls.filter(call => call.method === method).map(call => call.params),
    optionsOf: method => calls.filter(call => call.method === method).map(call => call.options),
    /** The desktop dropping its own load of a thread after the grace period. */
    unloading: id => { find(id).loaded = false; },
    /** The desktop re-subscribing a thread during the grace, e.g. the user reopens it. */
    resubscribing: id => { find(id).loaded = true; },
    finish: id => {
      const thread = find(id);
      for (const turn of thread.turns) if (turn.status === 'inProgress') { turn.status = 'completed'; thread.active = false; }
    },
  };
}

const node = (sessionId, parentSessionId = null) => ({ sessionId, parentSessionId, status: 'idle', changes: [] });
const owned = sessionId => ({ sessionId, owned: true });

async function fixture({ task = { taskId: 'task-1' }, saved, record = {}, hostOptions = {}, lock = 'record', atomic } = {}) {
  const native = desktop();
  const locked = [], patches = [];
  let state = saved === undefined ? undefined : structuredClone(saved);
  const value = { name: 'helper', agentId: 'a', sessionId: 'logical', workspace: WORKSPACE, task, ...record };
  const backend = await createCodexBackend(value, {
    load: () => value,
    readNativeState: () => state === undefined ? undefined : structuredClone(state),
    writeNativeState: next => { state = structuredClone(next); return true; },
    // The store's own atomic patch: it applies only while the round's fence still
    // matches, exactly as roster-store does it, and the caller must not send when it
    // refuses. Absent for deps that only have the in-memory store.
    ...(atomic === undefined ? {} : {
      writeNativeRelease: async (patch, fence) => {
        const index = patches.push({ patch: structuredClone(patch), fence: structuredClone(fence) }) - 1;
        if (typeof atomic === 'function' && atomic({ patch, fence, release: state?.release, index }) === false) return false;
        state = { ...(state ?? { requests: {}, projections: {} }), release: structuredClone(patch) };
        return true;
      },
    }),
    ensureCodexReports: async () => ({ ready: true }),
    readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: [], reports: [] }),
    hostOptions: { nativeRequest: native.request, ...hostOptions },
    // The release must never queue behind the write lock a dispatch waits on.
    withHostLock: async action => {
      locked.push(Date.now());
      if (lock === 'throw') throw new Error('a release must not take the host write lock');
      return action();
    },
  });
  return { backend, native, record: value, locked, patches, state: () => state };
}

test('a released round asks again while the thread still reads idle, and completes on notLoaded', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1'), node('child-1', 'root-1')] } } });
  f.native.add({ id: 'root-1' });
  f.native.add({ id: 'child-1', parent: 'root-1' });

  const first = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(first.state, 'waiting', 'an accepted request is not an unload');
  assert.equal(first.reason, 'release-unsubscribe-accepted');
  assert.deepEqual(f.native.paramsOf('thread/unsubscribe').map(params => params.threadId),
    ['child-1', 'root-1'], 'children first, then the root, both in this name\'s tree');
  assert.equal(f.native.count('thread/resume'), 0, 'a release never resumes a thread');
  assert.equal(f.native.count('thread/turns/list'), 0, 'a release does not poll the tree');
  assert.deepEqual(f.state().release.nodes, { 'root-1': 'submitted', 'child-1': 'submitted' });
  assert.equal(f.state().release.taskId, 'task-1');
  assert.equal(f.locked.length, 0, 'a release never takes the host write lock');

  // Still idle: the desktop may have re-subscribed the thread during its grace, so the
  // same acknowledgement cannot be assumed to still be in force.
  f.native.resubscribing('root-1');
  const second = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(second.state, 'waiting');
  assert.equal(f.native.count('thread/unsubscribe'), 4, 'a still-idle thread is asked again through the guard');

  f.native.unloading('root-1'); f.native.unloading('child-1');
  const third = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(third.state, 'complete', 'notLoaded is the only evidence that ends a release');
  assert.equal(third.reason, 'release-already-unloaded');
  assert.equal(f.native.count('thread/unsubscribe'), 4, 'an unloaded thread is not asked again');
  assert.equal(f.locked.length, 0);
});

test('an active thread is left running and never unsubscribed', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1', active: true });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-tree-active');
  assert.equal(f.native.count('thread/unsubscribe'), 0);
});

test('an incomplete ancestry walk never releases the root past cold direct children', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });
  for (let index = 0; index < 200; index++) {
    f.native.add({ id: `cold-${index}`, parent: 'root-1', loaded: false });
  }
  f.native.add({ id: 'active-grandchild', parent: 'cold-0', active: true });
  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(f.native.count('thread/unsubscribe'), 0, 'a partial tree must not authorize unloading its root');
  assert.equal(outcome.state, 'deferred');
});

test('a non-progressing child cursor or failed child read defers the whole release', async () => {
  for (const page of [
    () => ({ data: [], nextCursor: 'same-page' }),
    () => { throw Error('tree read failed'); },
  ]) {
    const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
    f.native.add({ id: 'root-1' });
    let reads = 0;
    f.native.hooks.childPage = () => {
      assert.ok(++reads <= 3, 'a repeated cursor must not keep the tree walk alive');
      return page();
    };
    const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
    assert.equal(outcome.state, 'deferred');
    assert.equal(f.native.count('thread/unsubscribe'), 0);
  }
});

test('a thread state this build does not know is not guessed at', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1', type: 'paused' });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-node-status-unknown');
  assert.equal(f.native.count('thread/unsubscribe'), 0);
});

test('a recorded node that is no longer under this root is not unsubscribed', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1'), node('child-1', 'root-1')] } } });
  f.native.add({ id: 'root-1' });
  f.native.add({ id: 'child-1' }); // alive, but no longer a native descendant

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-node-not-descendant');
  assert.equal(f.native.count('thread/unsubscribe'), 0, 'no ancestor evidence, no request');
});

test('a guard that cannot prove the subscription answers deferred, and a later retry may ask again', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });
  f.native.answers.push({ status: 'inUse' });

  const refused = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(refused.state, 'deferred');
  assert.equal(refused.reason, 'release-unsubscribe-inUse');
  assert.equal(f.state().release.nodes['root-1'], 'inUse', 'a refusal is recorded, not treated as sent');

  const retried = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(retried.state, 'waiting');
  assert.equal(f.native.count('thread/unsubscribe'), 2, 'nothing was acknowledged, so a retry is allowed');
});

test('a failed request proves nothing and leaves nothing recorded as sent', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });
  f.native.answers.push({ transportFailure: true });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-unsubscribe-unverified');
  assert.equal(f.state().release.nodes['root-1'], 'unverified');
});

test('a notSubscribed answer is never reported as a wait that will end', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });
  f.native.answers.push({ status: 'notSubscribed' });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred', 'this connection held no subscription, so no grace was started');
  assert.equal(outcome.reason, 'release-unsubscribe-notSubscribed');
  assert.equal(f.state().release.nodes['root-1'], 'notSubscribed');
});

test('a notSubscribed no-op after a real acknowledgement keeps the wait', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });
  f.native.answers.push({ status: 'unsubscribed' }, { status: 'notSubscribed' });

  assert.equal((await f.backend.releaseIdleThreads({ taskId: 'task-1' })).state, 'waiting');
  const second = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(second.state, 'waiting', 'the earlier acknowledgement already started the grace');
  assert.equal(f.state().release.nodes['root-1'], 'submitted');
});

test('a binding this name does not own is never released', async () => {
  for (const binding of [{ sessionId: 'root-1' }, { sessionId: 'root-1', owned: false }]) {
    const f = await fixture({ saved: { binding, tree: { nodes: [node('root-1')] } } });
    f.native.add({ id: 'root-1' });
    const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
    assert.equal(outcome.state, 'deferred');
    assert.equal(outcome.reason, 'release-no-owned-binding');
    assert.equal(f.native.calls.length, 0, 'an unowned binding issues no native call at all');
  }
});

test('another round never releases the threads this one is using', async () => {
  const f = await fixture({ task: { taskId: 'task-2' },
    saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-task-changed');
  assert.equal(f.native.calls.length, 0);
});

test('a new task asks again for the same thread instead of reusing the last round', async () => {
  const f = await fixture({ task: { taskId: 'task-2' },
    saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] },
      release: { taskId: 'task-1', state: 'waiting', nodes: { 'root-1': 'submitted' } } } });
  f.native.add({ id: 'root-1' });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-2' });
  assert.equal(outcome.state, 'waiting');
  assert.equal(f.native.count('thread/unsubscribe'), 1, 'the previous round\'s acknowledgement does not suppress this one');
  assert.equal(f.state().release.taskId, 'task-2');
});

test('a released name resumes for the next task with the same frozen model and effort', async () => {
  const f = await fixture();
  const selection = { provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'low' };
  await f.backend.beginTask();
  assert.equal((await f.backend.deliver({ requestId: 'r1', message: 'first', explicitModel: true, model: selection })).accepted, true);
  const rootId = f.state().binding.sessionId;
  assert.equal(f.state().binding.owned, true);
  f.native.finish(rootId);
  await f.backend.observe();

  assert.equal((await f.backend.releaseIdleThreads({ taskId: 'task-1' })).state, 'waiting');
  f.native.unloading(rootId);
  assert.equal((await f.backend.releaseIdleThreads({ taskId: 'task-1' })).state, 'complete');
  assert.equal(f.native.node(rootId).loaded, false);
  const resumes = f.native.count('thread/resume');

  // The same name gets more work: the existing ensure/resume path is the recovery, and
  // the selection stored with the request is what reaches the new turn.
  f.record.task = { taskId: 'task-2' };
  await f.backend.beginTask();
  assert.equal((await f.backend.deliver({ requestId: 'r2', message: 'second', explicitModel: true, model: selection })).accepted, true);
  assert.equal(f.native.node(rootId).loaded, true, 'the cold thread was resumed');
  assert.equal(f.native.count('thread/resume'), resumes + 1);
  const starts = f.native.paramsOf('turn/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].threadId, rootId, 'the second round reuses the same thread');
  assert.deepEqual([starts[1].model, starts[1].effort], ['gpt-6-luna', 'low']);
  assert.deepEqual(f.state().requests.r2.model, selection);
});

test('an idle list, inspect or model read leaves a released thread cold', async () => {
  const f = await fixture();
  const selection = { provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'low' };
  await f.backend.beginTask();
  await f.backend.deliver({ requestId: 'r1', message: 'first', explicitModel: true, model: selection });
  const rootId = f.state().binding.sessionId;
  f.native.finish(rootId);
  await f.backend.observe();
  await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  f.native.unloading(rootId);
  assert.equal((await f.backend.releaseIdleThreads({ taskId: 'task-1' })).state, 'complete');
  const resumes = f.native.count('thread/resume');

  // A status poll, a name list and an inspect all read the same metadata: none of them
  // may resume the thread the desktop just dropped.
  const view = await f.backend.observe();
  const model = await f.backend.model();
  await f.backend.beginTask();
  assert.equal(f.native.count('thread/resume'), resumes, 'no read resumes a cold thread');
  assert.equal(f.native.paramsOf('turn/start').length, 1, 'no read starts a turn either');
  assert.equal(view.tree.nodes[0].status, 'idle');
  assert.ok(view.throughSeq >= 1, 'the persisted transcript is still readable while unloaded');
  assert.equal(model?.model, 'gpt-6-luna', 'the selection is read from metadata, not by loading');
});

test('with the release switch off, the cold reads go back to the resume path of HEAD', async () => {
  const reading = await fixture({ hostOptions: { idleSessionCleanup: false },
    saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  reading.native.add({ id: 'root-1', loaded: false });
  await reading.backend.observe();
  assert.equal(reading.native.count('thread/resume'), 1, 'HEAD resumes the cold thread on a status read');
  assert.equal(reading.native.node('root-1').loaded, true);
  reading.native.unloading('root-1');
  await reading.backend.model();
  assert.equal(reading.native.count('thread/resume'), 2, 'and the model read does the same');

  const releasing = await fixture({ hostOptions: { idleSessionCleanup: false },
    saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  releasing.native.add({ id: 'root-1' });
  const outcome = await releasing.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-disabled');
  assert.equal(releasing.native.calls.length, 0, 'the switch off keeps today behaviour: no request at all');
});

test('a dispatch after an acknowledged release puts the subscription back before the turn', async () => {
  const f = await fixture();
  const selection = { provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'low' };
  await f.backend.beginTask();
  await f.backend.deliver({ requestId: 'r1', message: 'first', explicitModel: true, model: selection });
  const rootId = f.state().binding.sessionId;
  f.native.finish(rootId);
  // The desktop acknowledged the request, but the idle grace has not ended: the thread
  // still reads idle while this connection may already hold no subscription.
  assert.equal((await f.backend.releaseIdleThreads({ taskId: 'task-1' })).state, 'waiting');
  assert.equal(f.native.node(rootId).loaded, true, 'the read still says idle');
  const resumes = f.native.count('thread/resume');

  f.record.task = { taskId: 'task-2' };
  await f.backend.beginTask();
  await f.backend.deliver({ requestId: 'r2', message: 'second', explicitModel: true, model: selection });
  assert.equal(f.native.count('thread/resume'), resumes + 1, 'the first write after a release resubscribed');
  const starts = f.native.paramsOf('turn/start');
  assert.equal(starts.length, 2);
  assert.deepEqual([starts[1].model, starts[1].effort], ['gpt-6-luna', 'low'], 'the pinned selection is unchanged');
  assert.equal(f.state().release.nodes[rootId], 'resubscribed', 'the next round asks the desktop again');
});

test('the attempt is durable before the request leaves, so a timeout still resubscribes', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });
  f.native.answers.push({ timeout: true });
  const seen = [];
  f.native.hooks.beforeUnsubscribe = id => seen.push(f.state().release?.nodes?.[id]);

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.deepEqual(seen, ['sending'], 'the record already says an attempt was made when the request leaves');
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-unsubscribe-unverified');

  // No answer arrived, yet the next real dispatch must still put the subscription back.
  f.record.task = { taskId: 'task-2' };
  await f.backend.beginTask();
  await f.backend.deliver({ requestId: 'r2', message: 'again' });
  assert.equal(f.native.count('thread/resume'), 1, 'an unanswered attempt still resubscribes');
});

test('a round that ends during the release stops the rest and keeps the late answer', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1'), node('child-1', 'root-1')] } } });
  f.native.add({ id: 'root-1' });
  f.native.add({ id: 'child-1', parent: 'root-1' });
  // The caller assigns the next task while the child request is in flight.
  f.native.hooks.beforeUnsubscribe = () => { f.record.task = { taskId: 'task-2' }; };

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-task-changed');
  assert.deepEqual(f.native.paramsOf('thread/unsubscribe').map(params => params.threadId), ['child-1'],
    'the ancestor is not asked once the round moved on');
  assert.equal(f.state().release.taskId, 'task-1', 'the late answer never becomes the new round\'s record');
  assert.equal(f.state().release.nodes['child-1'], 'sending',
    'the durable mark written before the request is kept, and no late state is written after the round moved on');

  // The next round starts its own turn; only a thread that was actually asked for needs
  // its subscription restored, so this one is not resumed gratuitously.
  await f.backend.beginTask();
  assert.equal((await f.backend.deliver({ requestId: 'r2', message: 'next' })).accepted, true);
  assert.equal(f.native.paramsOf('turn/start').length, 1);
  assert.equal(f.native.count('thread/resume'), 0, 'a thread that was never asked for is not resubscribed');
});

test('the authorization and the abort signal reach the guarded request', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });
  const controller = new AbortController();
  const canRelease = () => true;

  await f.backend.releaseIdleThreads({ taskId: 'task-1', canRelease, signal: controller.signal });
  const [options] = f.native.optionsOf('thread/unsubscribe');
  assert.equal(options?.signal, controller.signal, 'the guarded request carries the abort signal');
  assert.equal(typeof options?.canRelease, 'function', 'and the authorization callback it must honour');
});

test('an unauthorized release sends nothing', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });
  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1', canRelease: () => false });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-round-moved-on');
  assert.equal(f.native.count('thread/unsubscribe'), 0);
});

test('a native child this name never observed blocks the root release', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });
  f.native.add({ id: 'late-child', parent: 'root-1' });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-tree-unexpected-node');
  assert.equal(f.native.count('thread/unsubscribe'), 0, 'the root stays loaded while a child is unproven');
});

test('a refused child blocks its ancestor instead of unloading the tree around it', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1'), node('child-1', 'root-1')] } } });
  f.native.add({ id: 'root-1' });
  f.native.add({ id: 'child-1', parent: 'root-1' });
  f.native.answers.push({ status: 'inUse' });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-unsubscribe-inUse');
  assert.deepEqual(f.native.paramsOf('thread/unsubscribe').map(params => params.threadId), ['child-1'],
    'children are released first, so a refused child can still block the root');
  assert.equal(f.state().release.nodes['root-1'], 'blocked-by-descendant');
});

test('a status read that started before the attempt cannot erase it', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });
  // A poll that began before the attempt must not save its older record over it: the
  // mark is what tells the next dispatch to restore the subscription.
  let late;
  let openView;
  const viewHeld = new Promise(resolve => { openView = resolve; });
  f.native.hooks.threadTurnsList = () => { openView(); };
  f.native.hooks.beforeUnsubscribe = () => { late = f.backend.observe(); };
  await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  await viewHeld;
  await late;
  assert.equal(f.state().release.nodes['root-1'], 'submitted',
    'the poll\'s own save keeps the release record it never owned');
  assert.ok(f.state().requests !== undefined, 'and the rest of the state is still written');
});

test('with the switch off a stored attempt never forces an extra resubscribe', async () => {
  const f = await fixture({ hostOptions: { idleSessionCleanup: false },
    saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] },
      release: { taskId: 'task-1', state: 'waiting', nodes: { 'root-1': 'submitted' } } } });
  f.native.add({ id: 'root-1' });

  f.record.task = { taskId: 'task-2' };
  await f.backend.beginTask();
  await f.backend.deliver({ requestId: 'r2', message: 'next' });
  assert.equal(f.native.count('thread/resume'), 0, 'the original ensure path is the only one left');
  assert.equal(f.native.paramsOf('turn/start').length, 1);
});

test('a refused attempt patch means the request is never sent', async () => {
  const f = await fixture({ atomic: ({ index }) => index !== 0,
    saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1', ticket: 'release-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-round-moved-on');
  assert.equal(f.native.count('thread/unsubscribe'), 0, 'the fence was gone, so nothing may be sent');
  assert.equal(f.patches[0].fence.ticket, 'release-1', 'the store is given the fence it must match');
});

test('a late answer whose fence is gone is dropped, not written over the next round', async () => {
  const f = await fixture({ atomic: ({ index }) => index !== 1,
    saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1', ticket: 'release-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-fence-lost');
  assert.equal(f.native.count('thread/unsubscribe'), 1, 'the request itself was sent');
  assert.equal(f.state().release.nodes['root-1'], 'sending', 'the record belongs to the round that still owns the fence');
});

test('a refused restore patch never turns an accepted turn into a failure', async () => {
  const f = await fixture({ atomic: () => false,
    saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] },
      release: { taskId: 'task-1', ticket: 'release-1', state: 'waiting', nodes: { 'root-1': 'submitted' } } } });
  f.native.add({ id: 'root-1' });

  f.record.task = { taskId: 'task-2' };
  await f.backend.beginTask();
  const accepted = await f.backend.deliver({ requestId: 'r2', message: 'next' });
  assert.equal(accepted.accepted, true, 'the turn was written and stays accepted');
  assert.equal(f.native.count('thread/resume'), 1, 'the restore itself was attempted first');
  assert.equal(f.state().release.nodes['root-1'], 'submitted', 'a refused patch leaves the old record alone');
});

test('a recorded child whose thread read fails is never treated as a deleted thread', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1'), node('child-1', 'root-1')] } } });
  f.native.add({ id: 'root-1' });
  // The native rejection a child returns while the connection cannot read it. This
  // build maps it onto the missing-thread code, so a code test alone would call it a
  // deletion and release the parent around a child nobody could read.
  f.native.add({ id: 'child-1', parent: 'root-1', unreadable: 'thread child not loaded' });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-node-unreadable');
  assert.equal(f.native.count('thread/unsubscribe'), 0, 'nothing is released while a child cannot be read');
  assert.equal(f.state().release.nodes['child-1'], 'unreadable');
});

test('an unobserved child that cannot be read also blocks the release', async () => {
  const f = await fixture({ saved: { binding: owned('root-1'), tree: { nodes: [node('root-1')] } } });
  f.native.add({ id: 'root-1' });
  f.native.add({ id: 'late-child', parent: 'root-1', unreadable: 'thread child not loaded' });

  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-tree-unexpected-node');
  assert.equal(f.native.count('thread/unsubscribe'), 0);
  assert.equal(f.state().release.nodes['late-child'], 'unreadable');
});

test('the release switch defaults on and a profile may inherit or override it', async () => {
  const base = path.join(root, 'clean', 'dsh-only-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'idle-release-')); // Retained; no destructive test cleanup.
  const filename = path.join(directory, 'config.json');
  const workspace = path.join(directory, 'main');
  const write = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  await mkdir(path.join(directory, 'profiles'), { recursive: true });

  await write(filename, { workspace });
  assert.equal((await loadConfig(filename)).idleSessionCleanup, true, 'a configuration that says nothing releases');

  await write(filename, { workspace, idleSessionCleanup: false });
  assert.equal((await loadConfig(filename)).idleSessionCleanup, false, 'the global switch turns it off');

  await write(path.join(directory, 'profiles', 'quiet.json'), { workspace: path.join(directory, 'quiet') });
  assert.equal((await loadConfig(filename, 'quiet')).idleSessionCleanup, false, 'a profile inherits the base switch');

  await write(filename, { workspace });
  await write(path.join(directory, 'profiles', 'loud.json'),
    { workspace: path.join(directory, 'loud'), idleSessionCleanup: false });
  assert.equal((await loadConfig(filename, 'loud')).idleSessionCleanup, false, 'a profile may set its own switch');
  await write(path.join(directory, 'profiles', 'formal.json'),
    { workspace: path.join(directory, 'formal'), idleSessionCleanup: true });
  assert.equal((await loadConfig(filename, 'formal')).idleSessionCleanup, true);

  await write(path.join(directory, 'profiles', 'broken.json'),
    { workspace: path.join(directory, 'broken'), idleSessionCleanup: 'yes' });
  await assert.rejects(loadConfig(filename, 'broken'), /idleSessionCleanup/);
});
