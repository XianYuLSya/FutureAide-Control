import assert from 'node:assert/strict';
import test from 'node:test';
import { readDispatch } from '../src/dispatch.mjs';

const event = (seq, type, data = {}) => ({ type: 'event', event: { seq, type, data } });
const requestId = 'peer-bridge-conclude-20261019-r1';

// A steer message can join a turn that started long before the send cursor. The first page only
// reaches the marker; the turn/start sits hundreds of events earlier and must still be paged in.
function steerBeforeStart() {
  const records = [event(100, 'turn/start', { turn: 1 })];
  for (let seq = 101; seq <= 678; seq++) records.push(event(seq, 'assistant/message', {}));
  records.push(event(679, 'agent/inbox/spliced', { inserted: [{ source: { rpcId: requestId } }] }));
  for (let seq = 680; seq <= 685; seq++) records.push(event(seq, 'assistant/message', {}));
  records.push(event(686, 'user/message', { source: { rpcId: requestId }, content: [{ type: 'text', text: 'stop' }] }));
  for (let seq = 687; seq <= 756; seq++) records.push(event(seq, 'assistant/message', {}));
  records.push(event(757, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
  records.push(event(758, 'turn/start', { turn: 2 }));
  records.push(event(759, 'user/message', { source: { rpcId: 'later-request' } }));
  records.push(event(760, 'turn/end', { turn: 2, reason: { kind: 'completed' } }));
  return records;
}

async function pagedApi(records, maxMessages = 100) {
  const calls = [];
  const api = {
    readSession: async (id, options = {}) => {
      calls.push(options.throughSeq);
      const through = options.throughSeq ?? Infinity;
      const eligible = records.filter(record => record.event.seq <= through);
      const size = options.maxMessages ?? maxMessages;
      const start = Math.max(0, eligible.length - size);
      return { records: eligible.slice(start), hasMore: start > 0 };
    },
  };
  return { api, calls };
}

test('a steer whose turn started before the send cursor is followed to its own start across pages', async () => {
  const records = steerBeforeStart();
  const { api, calls } = await pagedApi(records);
  const read = await readDispatch(api, 'session', { requestId, afterSeq: 678, maxMessages: 100 });

  assert.equal(read.ended, true);
  assert.equal(read.boundary.correlation, 'request-id');
  assert.equal(read.boundary.matched, true);
  assert.equal(read.boundary.hasStart, true);
  assert.equal(read.boundary.turn, 1);
  assert.equal(read.boundary.startSeq, 100);
  assert.equal(read.boundary.endSeq, 757);
  assert.deepEqual(read.boundary.completionReason, { kind: 'completed' });
  assert.deepEqual(calls, [undefined, 660, 560, 460, 360, 260, 160]);

  const scoped = read.page.records.map(record => record.event.seq);
  assert.equal(scoped[0], 101);
  assert.equal(scoped.at(-1), 757);
  assert.ok(scoped.includes(686));
  assert.ok(!scoped.includes(758));
  assert.ok(!scoped.includes(760));
  assert.equal(read.page.hasMore, false);
});

test('queued or unmatched native RPCs never adopt an unrelated turn end', async () => {
  const queuedApi = {
    readSession: async () => ({
      records: [event(2, 'agent/inbox/spliced', { inserted: [{ source: { rpcId: 'queued' } }] }),
        event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })],
      hasMore: false,
    }),
  };
  const queued = await readDispatch(queuedApi, 'session', { requestId: 'queued', afterSeq: 0 });
  assert.equal(queued.ended, false);
  assert.equal(queued.boundary.correlation, 'request-id');
  assert.equal(queued.boundary.matched, false);

  const nativeApi = {
    readSession: async () => ({
      records: [event(1, 'turn/start', { turn: 1 }), event(2, 'user/message', { source: { rpcId: 'other' } }),
        event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })],
      hasMore: false,
    }),
  };
  const native = await readDispatch(nativeApi, 'session', { requestId: requestId, afterSeq: 0 });
  assert.equal(native.ended, false);
  assert.equal(native.boundary.correlation, 'request-id');
  assert.equal(native.boundary.matched, false);
});

test('a turn end for another turn never completes the matched request', async () => {
  const api = {
    readSession: async () => ({
      records: [event(1, 'turn/start', { turn: 1 }), event(2, 'user/message', { source: { rpcId: requestId } }),
        event(3, 'turn/start', { turn: 2 }), event(4, 'turn/end', { turn: 2, reason: { kind: 'completed' } })],
      hasMore: false,
    }),
  };
  const read = await readDispatch(api, 'session', { requestId, afterSeq: 0 });
  assert.equal(read.ended, false);
  assert.equal(read.boundary.matched, true);
  assert.equal(read.boundary.hasStart, true);
  assert.equal(read.boundary.turn, 1);
  assert.equal(read.boundary.endSeq, undefined);
  assert.equal(read.boundary.completionReason, undefined);
});

test('an unmatched request never pages below its send cursor', async () => {
  const calls = [];
  const api = {
    readSession: async (id, options) => {
      calls.push(options.throughSeq);
      return { records: [event(5, 'assistant/message', {})], hasMore: true };
    },
  };
  const read = await readDispatch(api, 'session', { requestId: 'missing', afterSeq: 10 });
  assert.equal(read.ended, false);
  assert.equal(read.boundary.matched, false);
  assert.deepEqual(calls, [undefined]);
});

test('a matched marker without a start stops at the end of history instead of looping', async () => {
  const api = {
    readSession: async () => ({ records: [event(10, 'user/message', { source: { rpcId: requestId } })], hasMore: false }),
  };
  const read = await readDispatch(api, 'session', { requestId, afterSeq: 0 });
  assert.equal(read.ended, false);
  assert.equal(read.boundary.matched, true);
  assert.equal(read.boundary.hasStart, false);
  assert.deepEqual(read.page.records.map(record => record.event.seq), [10]);
});
