import assert from 'node:assert/strict';
import test from 'node:test';
import { createControl, modelTurnError } from '../src/control.mjs';

const reason = { kind: 'error', error: { code: 'SERVER', message: '503: ' + JSON.stringify({
  code: 'no_healthy_account', message: 'all accounts are temporarily unavailable',
  headers: { authorization: 'Bearer private-key' }, request: { prompt: 'private-prompt' },
}) } };
const expected = { source: 'model', code: 'no_healthy_account', httpStatus: 503,
  message: 'The model gateway has no healthy account available.' };

test('model failure summary retains stable cause while omitting remote payloads and unknown messages', () => {
  assert.deepEqual(modelTurnError(reason), expected);
  assert.doesNotMatch(JSON.stringify(modelTurnError(reason)), /private|headers|request|authorization/);
  assert.deepEqual(modelTurnError({ kind: 'error', error: { code: 'SERVER', message: 'HTTP 502: private upstream message' } }),
    { source: 'model', code: 'SERVER', httpStatus: 502, message: 'DSH model execution failed.' });
  assert.equal(modelTurnError({ kind: 'error', error: { code: 'sk-private-key', message: 'private' } }).code, 'model-turn-failed');
  assert.equal(modelTurnError({ kind: 'completed' }), undefined);
  assert.equal(modelTurnError({ kind: 'cancelled' }), undefined);
});

test('wait exposes only the requested turn failure and a later successful turn has no old error', async () => {
  const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data } });
  const row = { sessionId: 'session', cwd: process.cwd(), running: false, projections: { asOfSeq: 6 } };
  const records = [
    event(1, 'turn/start', { turn: 'failed-turn' }),
    event(2, 'user/message', { source: { rpcId: 'failed-request' }, content: [] }),
    event(3, 'turn/end', { turn: 'failed-turn', reason }),
    event(4, 'turn/start', { turn: 'successful-turn' }),
    event(5, 'user/message', { source: { rpcId: 'successful-request' }, content: [] }),
    event(6, 'turn/end', { turn: 'successful-turn', reason: { kind: 'completed' } }),
  ];
  const control = createControl({ workspace: process.cwd() }, { client: {
    listSessions: async () => ({ items: [row] }),
    readSession: async () => ({ records, hasMore: false }),
  } });
  const failed = await control.wait({ sessionId: row.sessionId, requestId: 'failed-request', afterSeq: 0, timeoutSeconds: 0 });
  assert.equal(failed.state, 'ended');
  assert.equal(failed.correlation, 'request-id');
  assert.deepEqual(failed.error, expected);
  assert.deepEqual(modelTurnError(failed.completionReason), expected);
  assert.doesNotMatch(JSON.stringify(failed), /private|"headers"|"request"|"authorization"/);
  const success = await control.wait({ sessionId: row.sessionId, requestId: 'successful-request', afterSeq: 3, timeoutSeconds: 0 });
  assert.equal(success.state, 'ended');
  assert.equal(success.error, undefined);
});
