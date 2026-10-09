import assert from 'node:assert/strict';
import test from 'node:test';
import { createControl, historyMessages } from '../src/control.mjs';

test('history handles both native message shapes without exposing stream reasoning or request payloads', () => {
  const event = (type, data, seq) => ({ type: 'event', event: { type, seq, time: 100 + seq, data } });
  const page = { hasMore: true, nextThroughSeq: 5, records: [
    event('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Please continue.' }] }, 6),
    event('user/message', { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Internal timing' }] }, 7),
    event('assistant/chunk', { chunk: { type: 'reasoning-delta', text: 'internal reasoning' } }, 8),
    event('request/header', { secret: 'not a message' }, 9),
    event('assistant/message', { role: 'assistant', content: [{ type: 'text', text: 'Older format' }, { type: 'reasoning', text: 'private' }] }, 10),
    event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Current format' }, { type: 'tool-call', name: 'read', id: 'call', arguments: { secret: 'not included' } }] } }, 11),
  ] };
  const value = historyMessages(page, { sessionId: 'session', running: true });
  assert.deepEqual(value.messages.map(m => m.text), ['Please continue.', 'Older format', 'Current format']);
  assert.deepEqual(value.messages[2].tools, [{ name: 'read', id: 'call' }]);
  assert.equal(value.hasMore, true);
  assert.equal(value.nextThroughSeq, 5);
  assert.equal(value.scannedRecords, 6);
  assert.doesNotMatch(JSON.stringify(value), /private|reasoning|secret|Internal timing/);
});

test('long messages are individually bounded and an in-progress-only page stays explicit', () => {
  const empty = historyMessages({ records: [], hasMore: false }, { sessionId: 's' });
  assert.match(empty.note, /No completed text/);
  const value = historyMessages({ records: [{ type: 'event', event: { type: 'assistant/message', data: { content: [{ type: 'text', text: 'x'.repeat(9000) }] } } }], hasMore: false }, { sessionId: 's' });
  assert.equal(value.messages[0].text.length, 8000);
  assert.equal(value.messages[0].textTruncated, true);
});

test('bounded summaries retain the newest messages and raw events remain explicitly available', async () => {
  const page = { records: Array.from({ length: 12 }, (_, seq) => ({ type: 'event', event: { type: 'assistant/message', seq, data: { content: [{ type: 'text', text: String(seq) + 'x'.repeat(8000) }] } } })), hasMore: false };
  const row = { sessionId: 's', cwd: process.cwd() };
  const value = historyMessages(page, row);
  assert.ok(JSON.stringify(value).length < 40000);
  assert.equal(value.messages.at(-1).seq, 11);
  assert.ok(value.olderMessagesOmitted > 0);
  assert.equal(value.hasMore, true);
  assert.equal(value.nextThroughSeq, value.messages[0].seq - 1);
  const control = createControl({ workspace: process.cwd(), futureaideSessionId: 's' }, { client: { listSessions: async () => ({ items: [row] }), readSession: async () => page } });
  assert.equal(await control.read({ view: 'events' }), page);
  await assert.rejects(control.read({ view: 'unknown' }), /History view/);
});

test('a configured default session cannot override another project scope', async () => {
  const control = createControl({ workspace: process.cwd(), futureaideSessionId: 'foreign' }, { client: { listSessions: async () => ({ items: [{ sessionId: 'foreign', cwd: 'Z:/another-project' }] }) } });
  await assert.rejects(control.read(), /configured project/);
});

test('default reads ask the client to repair a stale cold cursor while explicit cursors stay literal', async () => {
  const row = { sessionId: 's', cwd: process.cwd(), projections: { asOfSeq: -1 } };
  const calls = [];
  const control = createControl({ workspace: process.cwd(), futureaideSessionId: 's' }, { client: {
    listSessions: async () => ({ items: [row] }),
    readSession: async (id, options) => { calls.push([id, options]); return { records: [], hasMore: false }; },
  } });
  await control.read();
  await control.read({ throughSeq: -1 });
  assert.deepEqual(calls, [
    ['s', { maxMessages: 8, workspace: process.cwd() }],
    ['s', { maxMessages: 8, workspace: process.cwd(), throughSeq: -1 }],
  ]);
});

test('native injected instructions are omitted without hiding human quotations', () => {
  const records = ['agent-instructions', 'skill-catalog', 'user'].map((kind, seq) => ({
    type: 'event', event: { type: 'user/message', seq, data: { message: {
      role: 'user', source: { kind }, content: [{ type: 'text', text: '<system-reminder>quoted text</system-reminder>' }],
    } } },
  }));
  const result = historyMessages({ records, hasMore: false }, { sessionId: 's' });
  assert.deepEqual(result.messages.map(message => message.seq), [2]);
  assert.equal(result.messages[0].text, '<system-reminder>quoted text</system-reminder>');
  assert.equal(records.length, 3);
});
