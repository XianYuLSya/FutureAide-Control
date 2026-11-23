// One isolated, in-memory admission fixture for the disconnect read path.
// It uses the real createCodexNativeRpc and a fake WebSocket: no Desktop
// discovery, no network, no real Codex process, and no test-only seam inside
// the transport. `probeReplyMs > probeTimeoutMs` reproduces a slow probe.
import { setTimeout as delay } from 'node:timers/promises';

const frameMethod = frame => {
  const expression = String(frame?.params?.expression ?? '');
  if (expression.includes('useStateDbOnly') && expression.includes('"method":"thread/list"')) return 'probe';
  const match = /"method":"([^"]+)"/.exec(expression);
  return match?.[1] ?? 'unknown';
};

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(5);
  }
  return false;
}

export async function runReadRecoveryFixture(createCodexNativeRpc, options = {}) {
  const {
    discoveryMs = 120,
    probeReplyMs = 150,
    probeTimeoutMs = 50,
    readCount = 7,
    timeoutMs = 2000,
  } = options;
  const sockets = [];
  const events = [];
  let probeSentAt = null, writeSentAt = null;
  class Socket extends EventTarget {
    constructor() {
      super();
      this.frames = [];
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(raw) {
      const frame = JSON.parse(raw);
      this.frames.push(frame);
      const method = frameMethod(frame);
      if (method === 'probe' && probeSentAt === null) probeSentAt = Date.now();
      if (method === 'turn/start' && writeSentAt === null) writeSentAt = Date.now();
      const value = method === 'probe' ? { data: [] }
        : method === 'thread/read' ? { thread: { id: 'thread-1' } }
          : method === 'turn/start' ? { turn: { id: 'turn-1' } } : { ok: true };
      setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ id: frame.id, result: { result: { value } } }),
      })), method === 'probe' ? probeReplyMs : 5);
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const rpc = createCodexNativeRpc({
    discover: async () => {
      await delay(discoveryMs);
      return { webSocketUrl: 'memory:isolated', targetId: 'fixture-page', pid: 1 };
    },
    WebSocketImpl: Socket,
    probeTimeoutMs,
    timeoutMs,
    idleMs: 60_000,
    measure: event => events.push(event),
  });
  const result = { discoveryMs, probeReplyMs, probeTimeoutMs, readCount, beforeClose: null,
    afterClose: null, reads: null, write: null, writeSentBeforeProbeResult: null, sockets: 0, frames: [] };
  try {
    const first = await rpc.request('thread/read', { threadId: 'thread-1' });
    result.beforeClose = { ok: true, thread: first?.thread?.id ?? null };
    sockets[0].dispatchEvent(new Event('close'));
    await delay(10);
    const started = Date.now();
    const reads = Array.from({ length: readCount }, () => rpc.request('thread/read', { threadId: 'thread-1' }).then(
      value => ({ ok: true, thread: value?.thread?.id ?? null }),
      error => ({ ok: false, code: error?.code ?? 'unknown', notSent: error?.notSent === true,
        transportAdmissionFailed: error?.transportAdmissionFailed === true,
        transportGeneration: error?.transportGeneration, transportFaultSequence: error?.transportFaultSequence })));
    // Wait until every read has either reached the replacement socket or failed.
    await waitFor(() => sockets.slice(1).some(socket => socket.frames.filter(frame => frameMethod(frame) === 'thread/read').length >= readCount)
      || events.some(event => event.event === 'send' && event.source === 'recovery-probe'), Math.max(1000, discoveryMs + 500));
    const readResults = await Promise.all(reads);
    result.afterClose = { elapsedMs: Date.now() - started };
    result.reads = { ok: readResults.filter(item => item.ok).length,
      failed: readResults.filter(item => !item.ok).length,
      codes: [...new Set(readResults.filter(item => !item.ok).map(item => item.code))],
      transportAdmissionFailed: readResults.filter(item => item.transportAdmissionFailed).length,
      transportGenerations: [...new Set(readResults.filter(item => !item.ok).map(item => item.transportGeneration).filter(value => value !== undefined))],
      transportFaultSequences: [...new Set(readResults.filter(item => !item.ok).map(item => item.transportFaultSequence).filter(value => value !== undefined))] };
    // A write must not reach the replacement socket before the probe verifies it.
    const writeOutcome = rpc.request('turn/start', { threadId: 'thread-1' }).then(
      value => ({ ok: true, turn: value?.turn?.id ?? null }),
      error => ({ ok: false, code: error?.code ?? 'unknown', notSent: error?.notSent === true,
        transportAdmissionFailed: error?.transportAdmissionFailed === true }));
    await delay(Math.max(20, Math.min(probeReplyMs, probeTimeoutMs) + 20));
    result.writeSentBeforeProbeResult = writeSentAt !== null && probeSentAt !== null
      && writeSentAt < probeSentAt + probeReplyMs;
    result.write = await writeOutcome;
    result.sockets = sockets.length;
    result.frames = sockets.map(socket => socket.frames.map(frameMethod));
  } catch (error) {
    result.fatal = { code: error?.code ?? 'unknown', message: String(error?.message ?? error) };
  } finally {
    rpc.close();
  }
  return result;
}

export const readRecoveryFixtureFrameMethod = frameMethod;
