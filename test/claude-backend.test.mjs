import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClaudeBackend } from '../src/claude-backend.mjs';
import { markerLine } from '../src/claude-host.mjs';

async function setup() {
  const directory = fileURLToPath(new URL(`../clean/validation/claude-backend/${randomUUID()}/`, import.meta.url));
  await mkdir(path.join(directory, 'sessions'), { recursive: true });
  const sid = randomUUID();
  const recordFile = path.join(directory, 'sessions', `${process.pid}.json`);
  const transcriptFile = path.join(directory, `${sid}.jsonl`);
  const native = { pid: process.pid, sessionId: sid, procStart: 'fixture-start', entrypoint: 'claude-desktop',
    cwd: directory, status: 'idle', hostSessionId: 'local-' + sid };
  await writeFile(recordFile, JSON.stringify(native));
  await writeFile(transcriptFile, '');
  const record = { agentId: 'owned', sessionId: 'logical', name: 'helper', workspace: directory, target: 'claude-desktop',
    task: { taskId: 'task-1' } };
  let saved;
  const counters = { created: 0, sent: 0, reportsStarted: 0, locks: 0, defaults: 0 };
  const model = { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'max', verified: true, resolved: true };
  const append = events => appendFile(transcriptFile, events.map(e => JSON.stringify({ sessionId: sid, ...e })).join('\n') + '\n');
  const binding = { pid: process.pid, sessionId: sid, workspace: directory, procStart: 'fixture-start', recordFile,
    transcriptFile, hostSessionId: native.hostSessionId };
  const deps = {
    env: { CLAUDE_CONFIG_DIR: directory }, load: () => record, driver: {},
    readNativeState: () => saved && structuredClone(saved),
    writeNativeState: value => { saved = structuredClone(value); return true; },
    withHostLock: async action => { counters.locks++; return action(); },
    ensureClaudeReports: async () => { counters.reportsStarted++; return { ready: true }; },
    bindClaude: async () => binding,
    sendClaude: async () => { counters.sent++; return { status: 'written' }; },
    tree: { TREE_PROTOCOL: 1, observeClaudeTree: async (_binding, projection, options) => ({
      tree: { settled: true, running: false, nodes: [{ sessionId: options.logicalSessionId,
        parentSessionId: null, status: 'idle', changes: projection.changes }] }, state: {}, histories: {} }) },
    host: {
      readDefaultModel: async () => { counters.defaults++; return model; }, readCurrentModel: async () => model,
      createFirstTurn: async (input, options) => {
        await (options.withUiLock ?? (action => action()))(async () => {
          await options.onBeforeSubmit?.();
          counters.created++;
          await append([{ type: 'user', uuid: randomUUID(), message: { content: input.message + '\n' + markerLine(input.requestId, input.bindingNonce) } }]);
        });
        const result = { created: true, nativeSessionId: sid, pid: process.pid, hostSessionId: native.hostSessionId };
        await options.onBound(result);
        return result;
      },
      interrupt: async () => ({ interrupted: true }), destroy: async () => ({ destroyed: false, deleted: false }),
    },
  };
  const adapter = await createClaudeBackend(record, deps);
  return { adapter, deps, counters, append, record, getState: () => saved,
    replace: value => { saved = structuredClone(value); },
    setStatus: async status => { native.status = status; await writeFile(recordFile, JSON.stringify(native)); },
    sessionId: sid, recordFile, native };
}

test('reservation starts no model and first deliver binds by the host marker', async () => {
  const f = await setup();
  const probe = await f.adapter.probe();
  assert.equal(probe.treeProtocol, 1);
  assert.equal(f.counters.reportsStarted, 0);
  assert.deepEqual(await f.adapter.create(), { sessionId: 'logical', modelRequestsStarted: 0 });
  assert.equal(f.counters.created, 0);
  await f.adapter.beginTask();
  assert.equal((await f.adapter.deliver({ requestId: 'first', message: 'Do work' })).accepted, true);
  assert.equal(f.counters.created, 1);
  assert.equal(f.counters.sent, 0);
  assert.equal(f.getState().binding.sessionId.length, 36);
  assert.equal((await f.adapter.receipt({ requestId: 'first' })).status, 'accepted');
});

test('an uncertain native write survives reconstruction without a duplicate send', async () => {
  const f = await setup();
  await f.adapter.create();
  await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'first', message: 'First' });
  assert.equal((await f.adapter.deliver({ requestId: 'followup', message: 'More' })).status, 'unknown');
  const recovered = await createClaudeBackend(f.record, f.deps);
  assert.equal((await recovered.deliver({ requestId: 'followup', message: 'More' })).accepted, false);
  assert.equal(f.counters.sent, 1);
  assert.equal((await recovered.receipt({ requestId: 'followup' })).status, 'unknown');
  assert.equal(await recovered.receipt({ requestId: 'never-attempted' }), undefined);
  await f.append([{ type: 'user', uuid: 'followup', message: { content: 'More' } },
    { type: 'assistant', uuid: 'reply', message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } }]);
  assert.equal((await recovered.receipt({ requestId: 'followup' })).status, 'accepted');
  assert.equal((await recovered.turn({ requestId: 'followup' })).state, 'ended');
  assert.equal(f.counters.sent, 1);
});

test('reusing a persistent agent keeps native identity but resets the task projection', async () => {
  const f = await setup();
  await f.adapter.create();
  await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'first', message: 'First' });
  await f.append([{ type: 'assistant', uuid: 'done', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ordinary reply' }] } }]);
  const old = await f.adapter.observe();
  const sid = f.getState().binding.sessionId;
  f.record.task = { taskId: 'task-2' };
  await f.adapter.beginTask();
  const next = await f.adapter.observe();
  assert.equal(next.taskId, 'task-2');
  assert.equal(next.throughSeq, old.throughSeq);
  assert.equal(f.getState().binding.sessionId, sid);
  assert.deepEqual(next.reports, []);
  assert.equal(f.counters.created, 1);
});

test('failed native cleanup is never upgraded to destroyed', async () => {
  const f = await setup();
  await f.adapter.create();
  await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'first', message: 'First' });
  assert.equal((await f.adapter.destroy()).destroyed, false);
  assert.equal(f.getState().binding.sessionId.length, 36);
});

test('a failed report-service startup leaves the native host untouched', async () => {
  const f = await setup();
  const adapter = await createClaudeBackend(f.record, { ...f.deps, ensureClaudeReports: async () => ({ ready: false }) });
  await assert.rejects(adapter.create(), { code: 'claude-report-not-ready' });
  assert.equal(f.counters.created, 0);
  assert.equal(f.counters.sent, 0);
});

test('waiting for another UI operation does not become an uncertain native send', async () => {
  const f = await setup();
  const busy = await createClaudeBackend(f.record, { ...f.deps, withHostLock: async () => {
    throw Object.assign(new Error('Host busy'), { code: 'agent-busy' });
  } });
  await assert.rejects(busy.deliver({ requestId: 'first', message: 'First' }), { code: 'agent-busy', retryableRead: true });
  assert.equal((await busy.receipt({ requestId: 'first' })).status, 'retryable');
  assert.equal(f.counters.created, 0);
  assert.equal((await f.adapter.deliver({ requestId: 'first', message: 'First' })).accepted, true);
  assert.equal(f.counters.created, 1);
});

test('a failed receipt save after a native write cannot cause a resend', async () => {
  const f = await setup();
  await f.adapter.create();
  await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'first', message: 'First' });
  let failed = false;
  const interrupted = await createClaudeBackend(f.record, { ...f.deps, writeNativeState: state => {
    if (!failed && state.requests?.followup?.transport === 'written') { failed = true; throw new Error('Temporary database failure'); }
    return f.deps.writeNativeState(state);
  } });
  await assert.rejects(interrupted.deliver({ requestId: 'followup', message: 'More' }), /database failure/);
  const recovered = await createClaudeBackend(f.record, f.deps);
  assert.equal((await recovered.receipt({ requestId: 'followup' })).status, 'unknown');
  await recovered.deliver({ requestId: 'followup', message: 'More' });
  assert.equal(f.counters.sent, 1);
});

test('a proven pre-submit block keeps the original request retryable', async () => {
  const f = await setup();
  const blocked = await createClaudeBackend(f.record, { ...f.deps, host: { ...f.deps.host,
    createFirstTurn: async () => ({ created: false, attempted: false, reason: 'workspace-trust-prompt' }) } });
  await assert.rejects(blocked.deliver({ requestId: 'first', message: 'First' }), {
    code: 'workspace-trust-prompt', retryableRead: true,
  });
  assert.equal(f.getState().requests.first.attempted, false);
  assert.equal((await blocked.receipt({ requestId: 'first' })).status, 'retryable');
  assert.equal((await f.adapter.deliver({ requestId: 'first', message: 'First' })).accepted, true);
  assert.equal(f.counters.created, 1);
});

test('a timeout after submit retains unknown ownership and cannot resend', async () => {
  const f = await setup();
  let submissions = 0;
  const adapter = await createClaudeBackend(f.record, { ...f.deps, host: { ...f.deps.host,
    createFirstTurn: async (_input, options) => {
      await options.onBeforeSubmit(); submissions++;
      return { created: false, status: 'unconfirmed', reason: 'no-native-session-registered' };
    }, findCreatedSession: async () => undefined } });
  assert.equal((await adapter.deliver({ requestId: 'first', message: 'First' })).status, 'unknown');
  assert.equal((await adapter.receipt({ requestId: 'first' })).status, 'unknown');
  await adapter.deliver({ requestId: 'first', message: 'First' });
  assert.equal(submissions, 1);
  assert.equal((await adapter.destroy()).destroyed, false);
});

test('existing ambiguous submission evidence survives a preflight error', async () => {
  const f = await setup();
  let checks = 0;
  const adapter = await createClaudeBackend(f.record, { ...f.deps, host: { ...f.deps.host,
    createFirstTurn: async () => { checks++; throw Object.assign(new Error('Existing marker is duplicated'),
      { code: 'marker-not-unique', uncertain: true }); } } });
  await assert.rejects(adapter.deliver({ requestId: 'first', message: 'First' }), {
    code: 'marker-not-unique', uncertain: true,
  });
  assert.equal(f.getState().requests.first.attempted, true);
  assert.equal(f.getState().requests.first.status, 'unknown');
  assert.equal((await adapter.deliver({ requestId: 'first', message: 'First' })).status, 'unknown');
  assert.equal(checks, 1);
});

test('one operation reuses an observation and refreshes after native changes', async () => {
  const f = await setup();
  let reads = 0;
  const adapter = await createClaudeBackend(f.record, { ...f.deps, reuseObservation: true,
    tree: { ...f.deps.tree, observeClaudeTree: async (...args) => {
      reads++; return f.deps.tree.observeClaudeTree(...args);
    } }, host: { ...f.deps.host, selectModel: async () => ({ selected: true }) } });
  await adapter.beginTask();
  await adapter.models();
  await adapter.model();
  assert.equal(f.counters.defaults, 1, 'one first dispatch shares one live default selection');
  await adapter.deliver({ requestId: 'first', message: 'First' });
  await adapter.models();
  assert.equal(f.counters.defaults, 2, 'the next input reads the current host default again');
  await adapter.observe();
  const before = reads;
  await adapter.receipt({ requestId: 'first' });
  await adapter.turn({ requestId: 'first' });
  await adapter.history();
  await adapter.cursor();
  assert.equal(reads, before, 'receipt/turn/history/cursor share the locked operation observation');
  await f.append([{ type: 'assistant', uuid: 'done', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } }]);
  await adapter.observe();
  assert.equal(reads, before + 1, 'the next explicit observation reads new native state');
  await adapter.selectModel({ model: 'claude-opus-5-5' });
  await adapter.receipt({ requestId: 'first' });
  assert.equal(reads, before + 2, 'model mutation invalidates an earlier observation');
  await adapter.deliver({ requestId: 'followup', message: 'More' });
  assert.equal(reads, before + 3, 'a native write always observes its own delivery anew');
});

test('a bound input reads current and default controls together without trusting stored history', async () => {
  const f = await setup();
  await f.adapter.deliver({ requestId: 'first', message: 'First' });
  let snapshots = 0;
  const selection = { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'max', resolved: true };
  const adapter = await createClaudeBackend(f.record, { ...f.deps, reuseObservation: true,
    driver: { modelSnapshot() {} }, host: { ...f.deps.host,
      readCurrentModel: async () => { throw new Error('must use the current composer snapshot'); },
      readModelSnapshot: async () => { snapshots++; return {
        titleMatchesRecord: true, current: selection, default: selection,
      }; },
    } });
  const begun = await adapter.beginTask();
  assert.equal(begun.modelSelectionObserved, false, 'task negotiation makes no claim about next-turn selection');
  assert.equal(snapshots, 0);
  assert.equal((await adapter.models()).default.reasoningEffort, 'max');
  assert.equal((await adapter.model()).reasoningEffort, 'max');
  assert.equal(snapshots, 1);
  await adapter.deliver({ requestId: 'next', message: 'Next input' });
  await adapter.models();
  assert.equal(snapshots, 2, 'each subsequent input takes a new live control snapshot');
});

// ------------------------------------------------------------------ cancel

const runningChild = (name, taskId) => ({ sessionId: `claude-agent-${taskId}`, parentSessionId: 'logical',
  name, status: 'running', nativeAgentId: taskId });
const cancelTree = (nodes, extra = {}) => ({ settled: false, running: true,
  nodes: [{ sessionId: 'logical', parentSessionId: null, status: 'idle' }, ...nodes], ...extra });
const cancelDeps = (f, overrides) => ({ ...f.deps,
  tree: { TREE_PROTOCOL: 1,
    observeClaudeTree: async () => ({ tree: overrides.current(), state: {}, histories: {} }),
    claudeTreeStopTargets: tree => (tree?.nodes ?? []).filter(node => node.status !== 'ended')
      .map(node => ({ sessionId: node.sessionId, status: node.status,
        ...(node.parentSessionId ? { taskId: node.nativeAgentId } : { root: true }) })) },
  host: { ...f.deps.host, ...overrides.host } });

async function bound(f, deps) {
  const adapter = await createClaudeBackend(f.record, deps);
  await adapter.create();
  await adapter.beginTask();
  await adapter.deliver({ requestId: 'first', message: 'Go' });
  return adapter;
}

test('cancel interrupts the root first, then stops the running child tasks', async () => {
  const f = await setup();
  const order = [];
  let tree = cancelTree([runningChild('leaf one', 'a1')], { nodes: [
    { sessionId: 'logical', parentSessionId: null, status: 'running' }, runningChild('leaf one', 'a1')] });
  const adapter = await bound(f, cancelDeps(f, { current: () => tree,
    host: {
      interrupt: async () => { order.push('interrupt-root'); return { interrupted: true }; },
      stopBackgroundTasks: async input => {
        order.push(`stop-tasks:${input.nativeSessionId}`);
        tree = { settled: true, running: false, nodes: tree.nodes.map(node => ({ ...node, status: 'ended' })) };
        return { stopped: [{ index: 0, rowText: 'leaf one', clicked: true }], remaining: [] };
      },
    } }));
  await f.setStatus('busy');
  const result = await adapter.cancel();
  assert.deepEqual(order, ['interrupt-root', `stop-tasks:${f.sessionId}`]);
  assert.equal(result.cancelRequested, true);
  assert.equal(result.treeSettled, true, 'settle comes from the same observer');
  assert.deepEqual({ ...result.cancelRounds[1], detail: undefined }, { round: 1, action: 'stop-tasks',
    requested: ['a1'], clicked: 1, rows: 1, remaining: 0, detail: undefined });
  assert.equal(result.cancelRounds[1].detail[0].state, null);
});

test('an idle root with a running child still stops the child tasks', async () => {
  const f = await setup();
  const calls = [];
  let tree = cancelTree([runningChild('leaf one', 'a1')]);
  const adapter = await bound(f, cancelDeps(f, { current: () => tree,
    host: {
      interrupt: async () => { calls.push('interrupt'); return { interrupted: false, status: 'not-running' }; },
      stopBackgroundTasks: async () => { calls.push('stop'); tree = { settled: true, running: false,
        nodes: tree.nodes.map(node => ({ ...node, status: 'ended' })) }; return { stopped: [{}], remaining: [] }; },
    } }));
  await f.setStatus('idle');
  const result = await adapter.cancel();
  assert.deepEqual(calls, ['stop'], 'an idle root is not interrupted, but its child is stopped');
  assert.equal(result.cancelRequested, true);
  assert.equal(result.treeSettled, true);
});

test('a handback that wakes the root is interrupted again', async () => {
  const f = await setup();
  const order = [];
  let interrupts = 0;
  let tree = cancelTree([runningChild('leaf one', 'a1')], { nodes: [
    { sessionId: 'logical', parentSessionId: null, status: 'running' }, runningChild('leaf one', 'a1')] });
  const adapter = await bound(f, cancelDeps(f, { current: () => tree,
    host: {
      interrupt: async () => {
        interrupts += 1;
        order.push(`interrupt-${interrupts}`);
        // the second interrupt ends the turn the handback woke
        if (interrupts >= 2) tree = { settled: true, running: false,
          nodes: [{ sessionId: 'logical', parentSessionId: null, status: 'ended' }] };
        return { interrupted: true };
      },
      stopBackgroundTasks: async () => {
        order.push('stop');
        // the child's handback leaves the root running one short turn
        tree = cancelTree([], { nodes: [{ sessionId: 'logical', parentSessionId: null, status: 'running' }] });
        return { stopped: [{ index: 0, rowText: 'leaf one', clicked: true }], remaining: [] };
      },
    } }));
  await f.setStatus('busy');
  const result = await adapter.cancel();
  assert.deepEqual(order, ['interrupt-1', 'stop', 'interrupt-2']);
  assert.equal(result.cancelRequested, true);
  assert.equal(result.treeSettled, true);
});

test('a host that cannot stop tasks says so instead of pretending', async () => {
  const f = await setup();
  let tree = cancelTree([runningChild('leaf one', 'a1')]);
  const adapter = await bound(f, cancelDeps(f, { current: () => tree, host: { stopBackgroundTasks: undefined } }));
  await f.setStatus('idle');
  const result = await adapter.cancel();
  assert.equal(result.stopTasksUnsupported, true);
  assert.equal(result.cancelRequested, false, 'nothing reached the host for the running child');
  assert.equal(result.treeSettled, false);
  assert.equal(result.cancelRounds.filter(entry => entry.action === 'stop-tasks-unsupported').length, 1,
    'an unsupported stop is reported once, not repeated');
});

test('cancel needs no native work when the first send never happened', async () => {
  const f = await setup();
  const calls = [];
  const adapter = await createClaudeBackend(f.record, cancelDeps(f, { current: () => cancelTree([]),
    host: { interrupt: async () => { calls.push('interrupt'); return { interrupted: true }; },
      stopBackgroundTasks: async () => { calls.push('stop'); return {}; } } }));
  await adapter.create();
  assert.equal((await adapter.cancel()).cancelRequested, true);
  assert.deepEqual(calls, []);
});

test('an unobservable session never counts as a stopped tree', async () => {
  const f = await setup();
  const adapter = await bound(f, cancelDeps(f, { current: () => cancelTree([runningChild('leaf one', 'a1')]),
    host: { resolveNativeSession: async () => {
      throw Object.assign(new Error('unknown native session'), { code: 'unknown-native-session' });
    } } }));
  // Break the fast path so nativeSession has to resolve through the host.
  await writeFile(f.recordFile, JSON.stringify({ ...f.native, pid: 424242 }));
  const result = await adapter.cancel();
  assert.equal(result.cancelRequested, false, 'a child can outlive the handle that named it');
  assert.equal(result.reason, 'session-unavailable');
  assert.equal(result.cancelPending, true);
});

test('a row state of requested is never read as a successful stop', async () => {
  const f = await setup();
  const tree = cancelTree([runningChild('leaf one', 'a1')]);
  const adapter = await bound(f, cancelDeps(f, { current: () => tree,
    host: { interrupt: async () => ({ interrupted: false, status: 'not-running' }),
      stopBackgroundTasks: async () => ({ stopped: [{ index: 0, rowText: 'leaf one', clicked: false,
        state: 'requested', error: { code: 'task-stop-refused', message: 'the press was refused' } }],
        remaining: [{ index: 0, rowText: 'leaf one' }], status: 'stop-refused' }) } }));
  await f.setStatus('idle');
  const result = await adapter.cancel();
  assert.equal(result.cancelRequested, false, 'state:requested is filled even when the press failed');
  assert.equal(result.cancelPending, true);
  assert.equal(result.reason, 'no-native-stop-accepted');
  assert.equal(result.cancelRounds.filter(entry => entry.action === 'stop-tasks').length, 1,
    'a refused row is reported once, not repeated');
  const row = result.cancelRounds.find(entry => entry.action === 'stop-tasks').detail[0];
  assert.deepEqual({ clicked: row.clicked, state: row.state, code: row.error.code },
    { clicked: false, state: 'requested', code: 'task-stop-refused' });
});

test('a stop that clicked nothing is not an accepted cancel', async () => {
  const f = await setup();
  const tree = cancelTree([runningChild('leaf one', 'a1')]);
  const adapter = await bound(f, cancelDeps(f, { current: () => tree,
    host: { interrupt: async () => ({ interrupted: false, status: 'not-running' }),
      stopBackgroundTasks: async () => ({ stopped: [], remaining: [{ index: 0, rowText: 'leaf one' }],
        archiveOnly: true }) } }));
  await f.setStatus('idle');
  const result = await adapter.cancel();
  assert.equal(result.cancelRequested, false, 'no click and no interrupt is not an accepted cancel');
  assert.equal(result.reason, 'no-native-stop-accepted');
  assert.equal(result.cancelPending, true);
  assert.deepEqual(result.remainingTasks, ['a1']);
});
