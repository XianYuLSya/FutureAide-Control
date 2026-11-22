// Reproduce the deployed baseline without discovering a renderer or opening any socket.
// Run from the development worktree root with node scripts/disconnect-baseline.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const baseline = '9cc875baceccf339292465e6b4dc46414aee0c11';
const code = execFileSync('git', ['show', baseline + ':src/codex-ipc.mjs']);
const { createCodexNativeRpc } = await import('data:text/javascript;base64,' + code.toString('base64'));

function fixture() {
  const sockets = [];
  let discoveries = 0;
  let reply = false;
  let sends = 0;
  class MemorySocket extends EventTarget {
    constructor(url) {
      super();
      assert.equal(url, 'memory:isolated');
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(message) {
      sends++;
      if (reply) {
        const { id } = JSON.parse(message);
        const data = JSON.stringify({ id, result: { result: { value: 'recovered' } } });
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
      }
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.dispatchEvent(new Event('close'));
    }
  }
  const rpc = createCodexNativeRpc({
    discover: async () => {
      discoveries++;
      return { webSocketUrl: 'memory:isolated', targetId: 'memory-only', pid: 1 };
    },
    WebSocketImpl: MemorySocket,
    timeoutMs: 20,
  });
  return {
    read: background => rpc.request('thread/read', { threadId: 'fixture' }, { background })
      .catch(error => error.code),
    get sockets() { return sockets; },
    recover() { reply = true; },
    counts() { return { discoveries, sockets: sockets.length, sends }; },
    close: () => rpc.close(),
  };
}

const a = fixture();
const first = a.read(false);
await delay(150);
const sibling = a.read(false);
const cascade = await Promise.all([first, sibling]);
assert.deepEqual(cascade, ['codex-native-rpc-response-timeout', 'codex-native-rpc-closed']);
assert.deepEqual(a.counts(), { discoveries: 1, sockets: 1, sends: 2 });
a.close();

const b = fixture();
const background = await b.read(true);
assert.equal(background, 'codex-native-rpc-response-timeout');
assert.ok(!b.sockets[0].closed);
const waiting = b.read(false);
await delay(0);
b.sockets[0].close();
const closed = await waiting;
b.recover();
const recovered = await b.read(false);
assert.equal(closed, 'codex-native-rpc-closed');
assert.equal(recovered, 'recovered');
assert.deepEqual(b.counts(), { discoveries: 2, sockets: 2, sends: 3 });
b.close();

const result = { baseline, time: new Date().toISOString(), transport: 'in-memory',
  foreground: { results: cascade, ...a.counts() },
  background: { results: [background, closed, recovered], ...b.counts() } };
const json = JSON.stringify(result, null, 2);
console.log(json);
