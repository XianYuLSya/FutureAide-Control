// G2 evidence pairing: a tool_use only counts when its tool_result is successful.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pairReports } from '../scripts/claude-report-g2-evidence.mjs';

const sessionId = '6808231c-116c-4fc7-b9b0-4d790e763b0b';
const line = value => JSON.stringify({ sessionId, ...value }) + '\n';

test('only tool_use paired with a successful tool_result counts as delivered', () => {
  const body = line({ type: 'assistant', timestamp: 't1', message: { content: [
    { type: 'text', text: 'Reporting.' },
    { type: 'tool_use', id: 'toolu_ok', name: 'report_parent', input: { message: 'done', final: true } },
  ] } })
  + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_bad', name: 'ask_parent', input: { message: '?' } }] } })
  + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_orphan', name: 'report_parent', input: { message: 'x' } }] } })
  + line({ type: 'assistant', isSidechain: true, message: { content: [
    { type: 'tool_use', id: 'toolu_side', name: 'report_parent', input: { message: 'child' } }] } })
  + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_other', name: 'Read', input: {} }] } })
  + line({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_ok', is_error: false, content: [{ type: 'text', text: '{"accepted":true}' }] },
  ] } })
  + line({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true, content: 'refused' }] } })
  + line({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_other', is_error: false, content: 'file' }] } });

  const result = pairReports(body);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.sidechainUses, 1);
  assert.deepEqual(result.counts, { toolUses: 3, delivered: 1, failed: 1, unanswered: 1 });
  assert.deepEqual(result.unanswered, ['toolu_orphan']);
  assert.equal(result.g2Satisfied, true);
  const delivered = result.pairs.find(pair => pair.toolUseId === 'toolu_ok');
  assert.equal(delivered.name, 'report_parent');
  assert.deepEqual(delivered.input, { message: 'done', final: true });
  assert.equal(delivered.result.isError, false);
});

test('a failed or missing result never satisfies G2', () => {
  const failed = pairReports(line({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'toolu_1', name: 'report_parent', input: { message: 'x' } }] } })
  + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true }] } }));
  assert.equal(failed.g2Satisfied, false);
  assert.equal(failed.counts.failed, 1);

  const missing = pairReports(line({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'toolu_2', name: 'ask_parent', input: { message: 'x' } }] } }));
  assert.equal(missing.g2Satisfied, false);
  assert.deepEqual(missing.unanswered, ['toolu_2']);
});

test('a broken transcript line is counted and skipped, not silently trusted', () => {
  const result = pairReports(`${line({ type: 'assistant', message: { content: 'plain text' } })}{not json}\n`);
  assert.equal(result.badLines, 1);
  assert.equal(result.counts.toolUses, 0);
});
