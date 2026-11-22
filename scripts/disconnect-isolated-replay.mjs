// Synthetic replay only: in-memory roster, fake native RPC, no Desktop discovery.
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
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
const children = Array.from({ length: 5 }, (_, i) => `22222222-2222-4222-8222-${String(i + 1).padStart(12, '0')}`);
const base = await mkdtemp(path.join(os.tmpdir(), 'futureaide-isolated-replay-'));
const workspace = base;
const store = new RosterStore(':memory:');
const calls = [];
let active = false, clock = 1800000000;
const makeThread = id => liveThread({ id, cwd: workspace, updatedAt: clock,
  model: 'gpt-6-astra', reasoningEffort: 'high',
  status: id === root && active ? { type: 'active', activeFlags: [] } : { type: 'idle' } });
const monotonic = () => Number(process.hrtime.bigint()) / 1e6;
const timings = new Map();
function receiveNative({ method, params = {}, id: requestId }) {
  const context = { ...getCodexInstrumentation() };
  const timing = timings.get(requestId);
  assert.ok(timing, 'every fixture request must have a measured transport send');
  let value;
  switch (method) {
    case 'thread/start': value = { thread: makeThread(root) }; break;
    case 'thread/name/set': value = {}; break;
    case 'thread/read': case 'thread/resume':
      assert.ok([root, ...children].includes(params.threadId)); value = { thread: makeThread(params.threadId) }; break;
    case 'thread/list': value = livePage(params.parentThreadId === root ? children.map(makeThread) : []); break;
    case 'thread/turns/list': value = livePage(params.threadId === root && active
      ? [liveTurn({ id: 'synthetic-turn', rootTurnId: 'synthetic-turn', status: 'inProgress', items: [] })] : []); break;
    case 'turn/start': active = true; clock++; value = { turn: liveTurn({ id: 'synthetic-turn', rootTurnId: 'synthetic-turn', status: 'inProgress', items: [] }) }; break;
    case 'turn/steer': value = { turnId: 'synthetic-turn' }; break;
    case 'model/list': value = livePage(CODEX_MODELS); break;
    case 'config/read': value = { config: { model: 'gpt-6-astra', model_provider: 'openai', model_reasoning_effort: 'high' } }; break;
    default: throw new Error(`Forbidden synthetic RPC: ${method}`);
  }
  calls.push({ requestId, method, source: context.source ?? 'unlabelled', operationId: context.operationId,
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
  WebSocketImpl: MemorySocket,
  measure(event) {
    if (!event.requestId) return;
    if (event.event === 'send') timings.set(event.requestId, { sent: event.monotonicMs });
    if (event.event === 'response') timings.get(event.requestId).pluginReceived = event.monotonicMs;
  },
});
const fakeRequest = (method, params, options) => rpc.request(method, params, options);
const service = createScopedAgents({ stateDirectory: base, workspace, configFile: path.join(base, 'absent.json'), target: 'dsh' }, {
  store, nativeRequest: fakeRequest,
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
const extra = { _meta: { threadId: boss } };
const phases = {};
async function phase(name, action) {
  const startIndex = calls.length, start = performance.now();
  await action();
  const requests = calls.slice(startIndex);
  const counts = {};
  for (const call of requests) counts[call.method] = (counts[call.method] ?? 0) + 1;
  phases[name] = { durationMs: performance.now() - start, counts, requests };
}
try {
  let agentId;
  await phase('setup', async () => {
    await service.create({ name: 'synthetic-lead', lifetime: 'persistent', target: 'codex-desktop' }, extra);
    await service.send({ name: 'synthetic-lead', message: 'synthetic-0' }, extra);
    agentId = store.named(ownerIdFor(boss), 'synthetic-lead').agentId;
    await service.poll(agentId);
  });
  await phase('assignments', async () => {
    for (let i = 1; i < 14; i++) {
      await service.send({ name: 'synthetic-lead', message: `synthetic-${i}` }, extra);
      await service.poll(agentId);
    }
  });
  // drainPolls() is shutdown-only; waiting on the agent's existing poll and one
  // event-loop turn settles its monitor continuation without disabling the service.
  await service.poll(agentId);
  await new Promise(resolve => setImmediate(resolve));
  await phase('monitorScan', async () => {
    await service.monitorScan({ force: true, fresh: [agentId] });
    await service.poll(agentId);
    await new Promise(resolve => setImmediate(resolve));
  });
  await phase('inspect', () => service.inspect({ name: 'synthetic-lead' }, extra));
  await phase('changes', () => service.changes({ name: 'synthetic-lead' }, extra));
  // The external endpoint stays healthy. A record whose persisted retry is not
  // due should reproduce the old monitor's behaviour without changing any real clock.
  const record = store.get(agentId);
  record.state = 'reconnecting';
  record.error = { code: 'codex-native-rpc-closed', message: 'Synthetic closed connection' };
  record.retryAttempts = 25;
  record.nextAttemptAt = Date.now() + 300_000;
  store.save(record);
  await phase('unexpiredRetryWithHealthyEndpoint', () => service.poll(agentId));
  const beforeDue = store.get(agentId).state;
  const dueRecord = store.get(agentId);
  dueRecord.nextAttemptAt = Date.now() - 1;
  store.save(dueRecord);
  await phase('dueRetryWithHealthyEndpoint', () => service.poll(agentId));
  const afterDue = store.get(agentId).state;
  assert.ok(calls.some(c => c.method === 'thread/turns/list' && children.includes(c.nodeId)));
  assert.ok(calls.every(c => c.operationId));
  assert.equal(calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(calls.filter(c => c.method === 'turn/steer').length, 13);
  for (const name of ['monitorScan', 'inspect', 'changes']) {
    assert.ok(phases[name].requests.some(c => c.source === name && c.agentId === agentId && children.includes(c.nodeId)), name);
  }
  // Phase one can resolve every dispatch from the first observed tree, producing
  // zero dispatch-turn requests. Any extra refresh must still identify its dispatch.
  assert.ok(phases.monitorScan.requests.filter(c => c.currentStage === 'dispatch-turn').every(c => c.dispatchId));
  for (const { timing } of calls) {
    assert.ok(timing.sent <= timing.routed && timing.routed <= timing.windowReceived
      && timing.windowReceived <= timing.pluginReceived, 'same requestId must span all four measured boundaries');
  }
  console.log(JSON.stringify({ fixture: { root, children: children.length, assignments: 14, roster: 'memory', endpoint: 'in-memory renderer and app-server stub' },
    persistedRetry: { beforeDue, afterDue }, totalRequests: calls.length, phases }, null, 2));
} finally {
  await service.drainPolls();
  rpc.close();
  store.close();
  await rm(base, { recursive: true, force: true });
}
