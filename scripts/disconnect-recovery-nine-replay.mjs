// Synthetic replay only: in-memory roster, fake native RPC, no Desktop discovery.
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { createWakeQueue, planMonitorRound, monitorWaitMs, throttledSignal } from '../src/shared-monitor.mjs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { liveThread, liveTurn, livePage } from '../test/live-thread-fixture.mjs';
import { CODEX_MODELS } from '../test/assembly/renderer.mjs';

// Install before loading product code, so an accidentally omitted fake still cannot
// discover a Desktop, open a socket, or spawn a bridge or other process.
const forbidden = () => { throw new Error('Real network and subprocesses forbidden in isolated replay'); };
net.connect = net.createConnection = forbidden;
childProcess.execFile = childProcess.spawn = forbidden;
syncBuiltinESMExports();
globalThis.fetch = forbidden;
globalThis.WebSocket = class { constructor() { forbidden(); } };
process.env.FUTUREAIDE_CODEX_INSTRUMENTATION = '1';
const { createScopedAgents } = await import('../src/scoped-agents.mjs');
const { createCodexBackend } = await import('../src/codex-backend.mjs');
const { RosterStore } = await import('../src/roster-store.mjs');
const { ownerIdFor } = await import('../src/calling-context.mjs');
const { getCodexInstrumentation } = await import('../src/codex-instrumentation.mjs');
const { createCodexNativeRpc } = await import('../src/codex-ipc.mjs');

const root = '11111111-1111-4111-8111-111111111112';
const boss = '11111111-1111-4111-8111-111111111111';
const children = [];
const roots = Array.from({ length: 9 }, (_, i) => `33333333-3333-4333-8333-${String(i + 1).padStart(12, '0')}`);
let nextRoot = 0; const activeRoots = new Set(); let offline = false;
const base = await mkdtemp(path.join(os.tmpdir(), 'futureaide-isolated-replay-'));
const workspace = base;
const store = new RosterStore(':memory:');
const calls = [];
let clock = 1800000000;
let phaseClock, firstRead, firstWrite;
const acceptedAt = new Map(), rootReads = new Map();
const originalSetSupplement = store.setSupplement.bind(store);
store.setSupplement = (id, status, ...rest) => {
  const result = originalSetSupplement(id, status, ...rest);
  if (phaseClock !== undefined && status === 'accepted' && result && !acceptedAt.has(id)) acceptedAt.set(id, performance.now() - phaseClock);
  return result;
};
const makeThread = id => liveThread({ id, cwd: workspace, updatedAt: clock,
  model: 'gpt-6-astra', reasoningEffort: 'high',
  status: activeRoots.has(id) ? { type: 'active', activeFlags: [] } : { type: 'idle' } });
const monotonic = () => Number(process.hrtime.bigint()) / 1e6;
const timings = new Map();
function receiveNative({ method, params = {}, id: requestId }) {
  if (phaseClock !== undefined && firstWrite === undefined && ['turn/start', 'turn/steer'].includes(method)) firstWrite = performance.now() - phaseClock;
  const context = { ...getCodexInstrumentation() };
  const timing = timings.get(requestId);
  assert.ok(timing, 'every fixture request must have a measured transport send');
  let value;
  switch (method) {
    case 'thread/start': value = { thread: makeThread(roots[nextRoot++]) }; break;
    case 'thread/name/set': value = {}; break;
    case 'thread/read': case 'thread/resume':
      assert.ok([root, ...roots, ...children].includes(params.threadId)); value = { thread: makeThread(params.threadId) }; break;
    case 'thread/list': value = livePage(params.parentThreadId === root ? children.map(makeThread) : []); break;
    case 'thread/turns/list': value = livePage(activeRoots.has(params.threadId)
      ? [liveTurn({ id: `turn-${params.threadId}`, rootTurnId: `turn-${params.threadId}`, status: 'inProgress', items: [] })] : [liveTurn({ id: `turn-${params.threadId}`, rootTurnId: `turn-${params.threadId}`, status: 'completed', items: [] })]); break;
    case 'turn/start': activeRoots.add(params.threadId); clock++; value = { turn: liveTurn({ id: `turn-${params.threadId}`, rootTurnId: `turn-${params.threadId}`, status: 'inProgress', items: [] }) }; break;
    case 'turn/steer': value = { turnId: `turn-${params.threadId}` }; break;
    case 'model/list': value = livePage(CODEX_MODELS); break;
    case 'config/read': value = { config: { model: 'gpt-6-astra', model_provider: 'openai', model_reasoning_effort: 'high' } }; break;
    default: throw new Error(`Forbidden synthetic RPC: ${method}`);
  }
  calls.push({ requestId, method, params, source: context.source ?? 'unlabelled', operationId: context.operationId,
    currentStage: context.currentStage, agentId: context.agentId, rootId: context.rootId, nodeId: context.nodeId,
    dispatchId: context.dispatchId,
    timing });
  return value;
}
// Only product-generated expressions for this synthetic tree enter the in-memory
// window. No Desktop discovery, OS sockets or application registration is used.
const window = new EventTarget();
window.electronBridge = {
  sendMessageFromView({ request }) {
    if (offline && ['thread/read', 'thread/list'].includes(request.method)) return;
    const result = receiveNative(request);
    const timing = timings.get(request.id);
    timing.routed = monotonic();
    queueMicrotask(() => {
      timing.windowReceived = monotonic();
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'mcp-response', hostId: 'local', message: { id: request.id, result },
      } }));
    });
  },
};
const renderer = createContext({ window, setTimeout, clearTimeout });
class MemorySocket extends EventTarget {
  constructor(url) {
    super();
    assert.equal(url, 'memory:isolated');
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(frame) {
    const { id, method, params } = JSON.parse(frame);
    assert.equal(method, 'Runtime.evaluate');
    queueMicrotask(async () => {
      let reply;
      try {
        const value = await runInContext(params.expression, renderer);
        reply = { id, result: { result: { value } } };
      } catch (error) { reply = { id, error: { message: error.message } }; }
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(reply) }));
    });
  }
  close() { this.dispatchEvent(new Event('close')); }
}
const rpc = createCodexNativeRpc({
  discover: async () => ({ webSocketUrl: 'memory:isolated', targetId: 'fixture-page', pid: 1 }),
  WebSocketImpl: MemorySocket, timeoutMs: 700, probeTimeoutMs: 400,
  measure(event) {
    if (!event.requestId) return;
    if (event.event === 'send') timings.set(event.requestId, { sent: event.monotonicMs });
    if (event.event === 'response') timings.get(event.requestId).pluginReceived = event.monotonicMs;
  },
});
const hints = createWakeQueue({ sweepRequestMs: 1000 });
let wakeResolve, signalled = false;
function signal() { if (wakeResolve) { const resolve = wakeResolve; wakeResolve = undefined; resolve(); } else signalled = true; }
const pollSignal = throttledSignal(signal, { intervalMs: 1000 });
async function sleepUntilSignal(ms) {
  if (signalled) { signalled = false; return; }
  await new Promise(resolve => { let timer; wakeResolve = () => { clearTimeout(timer); resolve(); }; timer = setTimeout(() => { wakeResolve = undefined; resolve(); }, ms); });
}
async function fakeRequest(method, params, options) {
  const startedIn = phaseClock;
  const value = await rpc.request(method, params, options);
  if (startedIn !== undefined && startedIn === phaseClock && method === 'thread/read' && value.thread?.id === params.threadId) {
    const readMs = performance.now() - phaseClock;
    firstRead ??= readMs;
    if (roots.includes(params.threadId) && !rootReads.has(params.threadId)) {
      rootReads.set(params.threadId, { threadId: params.threadId, readMs, status: value.thread.status.type });
    }
  }
  return value;
}
const service = createScopedAgents({ stateDirectory: base, workspace, configFile: path.join(base, 'absent.json'), target: 'dsh' }, {
  store, nativeRequest: fakeRequest, onWorkQueued: id => { if (hints.queued(id)) signal(); }, onPollComplete: () => pollSignal.request(),
  clientFactory: () => { throw new Error('DSH forbidden in isolated replay'); },
  callCodex: async (_threadId, tool) => {
    if (tool !== 'read_thread') throw new Error(`Forbidden callback ${tool}`);
    return { thread: { id: boss, kind: 'codex', hostId: 'local', cwd: workspace } };
  },
  backendAdapters: { 'codex-desktop': (record, deps) => createCodexBackend(record,
    { ...deps, hostOptions: { nativeRequest: fakeRequest } }) },
  codexProbeRegistration: async () => ({ ready: true, registered: true, tools: ['ask_parent', 'report_parent'], sessionVerified: false }),
  startSharedMonitor: () => true, removeTree: async () => {},
});
let monitorRunning = false, monitor;
const extra = { _meta: { threadId: boss } };
const ids = [], requestIds = [], recoveryEvents = [];
let wake = false;
rpc.subscribeRecovery(event => {
  if (phaseClock !== undefined) firstRead ??= performance.now() - phaseClock;
  recoveryEvents.push(event);
  return service.transportRecovered(event).then(() => { wake = true; });
});
async function waitUntil(fn, limit = 15000) {
  const until = performance.now() + limit;
  while (!fn()) { if (performance.now() > until) throw new Error('Recovery deadline exceeded'); await new Promise(r => setTimeout(r, 50)); }
}
try {
  for (let i = 0; i < 9; i++) {
    const name = `agent-${i}`;
    await service.create({ name, lifetime: 'persistent', target: 'codex-desktop' }, extra);
    await service.send({ name, message: `initial-${i}` }, extra);
    const agentId = store.named(ownerIdFor(boss), name).agentId; ids.push(agentId);
    await service.poll(agentId);
    const queued = await service.send({ name, message: `queued-${i}`, mode: 'queue' }, extra);
    assert.equal(queued.accepted, false, JSON.stringify(queued));
    requestIds.push(store.supplements(agentId).at(-1).requestId);
  }
  const queuedBefore = ids.map(id => store.supplements(id).filter(x => x.status !== 'accepted').length);
  assert.ok(queuedBefore.every(count => count > 0));
  monitorRunning = true;
  monitor = (async () => {
    let lastSweepAt = 0;
    while (monitorRunning) {
      const roundStarted = Date.now();
      const { taken, only, sweepDue } = planMonitorRound(hints, service, lastSweepAt, { sweepMs: 5000 });
      const deferred = [];
      const busy = await service.monitorScan({ only, fresh: taken.names, sweep: sweepDue, force: taken.force, deferred });
      if (sweepDue) lastSweepAt = Date.now();
      if (hints.defer(deferred)) signal();
      const floor = Math.max(0, 250 - (Date.now() - roundStarted));
      const releaseAt = service.releaseWakeAt();
      const wait = monitorWaitMs({ busy, busyMs: 1000, idleMs: 5000, sweepInMs: lastSweepAt + 5000 - Date.now(),
        releaseInMs: releaseAt === undefined ? undefined : releaseAt - Date.now(), floorMs: floor });
      if (signalled) { signalled = false; await new Promise(r => setTimeout(r, floor)); }
      else await sleepUntilSignal(wait);
    }
  })();
  const results = [];
  for (const mode of ['same', 'new']) {
    offline = true;
    if (mode === 'new') rpc.close();
    await rpc.request('thread/list', { limit: 1 }).catch(() => {});
    if (mode === 'new') rpc.close();
    const before = recoveryEvents.length;
    for (const id of ids) {
      const record = store.get(id); record.state = 'reconnecting';
      record.error = { code: 'codex-native-rpc-timeout', message: 'fixture disconnect' };
      record.nextAttemptAt = Date.now() + 300000; store.save(record);
    }
    activeRoots.clear();
    const startCalls = calls.length;
    const messages = requestIds.map(id => store.supplement(id).message);
    acceptedAt.clear(); rootReads.clear(); firstRead = undefined; firstWrite = undefined;
    const t0 = performance.now(); phaseClock = t0; offline = false;
    await waitUntil(() => recoveryEvents.length > before && wake); wake = false;
    const event = recoveryEvents.at(-1);
    await waitUntil(() => rootReads.size === roots.length && requestIds.every(id => store.supplement(id)?.status === 'accepted'), 15000);
    const accepted = requestIds.filter(id => store.supplement(id)?.status === 'accepted').length;
    const elapsedMs = performance.now() - t0; phaseClock = undefined;
    assert.equal(event.mode, mode);
    assert.equal(accepted, 9, JSON.stringify({ mode, accepted, elapsedMs, counts: calls.slice(startCalls).reduce((a,c)=>(a[c.method]=(a[c.method]??0)+1,a),{}), sample: store.get(ids[0]), supplements: store.supplements(ids[0]) }));
    assert.ok(firstRead <= 5000, JSON.stringify({ firstRead }));
    const reads = roots.map((id, i) => ({ name: `agent-${i}`, ...rootReads.get(id) }));
    assert.ok(reads.every(x => x.threadId && x.readMs <= 15000 && x.status), JSON.stringify(reads));
    assert.ok(firstWrite <= 10000, JSON.stringify({ firstWrite }));
    const perName = requestIds.map((id, i) => ({ name: `agent-${i}`, acceptedMs: acceptedAt.get(id) }));
    assert.ok(perName.every(item => item.acceptedMs !== undefined && item.acceptedMs <= 10000), JSON.stringify(perName));
    for (const message of messages) {
      const writes = calls.slice(startCalls).filter(c => ['turn/start','turn/steer'].includes(c.method) && JSON.stringify(c.params).includes(message));
      assert.equal(writes.length, 1, JSON.stringify({ mode, message, count: writes.length }));
    }
    for (const id of requestIds) { const receipt = store.supplement(id).receipt; assert.equal(receipt.accepted, true); assert.equal(receipt.queued, false); }
    results.push({ mode, elapsedMs, firstReadMs: firstRead, rootReads: reads, firstQueueMs: firstWrite, perName, acceptedAt5s: perName.filter(x => x.acceptedMs <= 5000).length, acceptedAt10s: perName.filter(x => x.acceptedMs <= 10000).length, acceptedAt15s: perName.filter(x => x.acceptedMs <= 15000).length, uniqueWrites: messages.length, receipts: requestIds.map(id => store.supplement(id)?.receipt) });
    if (mode === 'same') {
      for (let i = 0; i < 9; i++) {
        await service.send({ name: `agent-${i}`, message: `queued-again-${i}`, mode: 'queue' }, extra);
        requestIds[i] = store.supplements(ids[i]).at(-1).requestId;
      }
      assert.ok(ids.every(id => store.supplements(id).some(x => x.status !== 'accepted')));
    }
  }
  monitorRunning = false; signal(); await monitor;
  const output = path.resolve(import.meta.dirname, '../.runtime/verification/disconnect-recovery-nine.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify({ output, results }));
} finally { monitorRunning = false; signal(); await monitor?.catch(() => {}); pollSignal.close(); await service.drainPolls(); rpc.close(); store.close(); await rm(base, { recursive: true, force: true }); }
