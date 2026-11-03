// G2 evidence: a pair counts only when the tool name is an exact registered MCP
// name, the native result is successful, its body (however nested) says
// accepted:true, and the receipt carries the task under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pairReports, REPORT_TOOL_ALLOWLIST } from '../scripts/claude-report-g2-evidence.mjs';
import { reportReceipt } from '../src/claude-inbox.mjs';

const sessionId = '6808231c-116c-4fc7-b9b0-4d790e763b0b';
const line = value => JSON.stringify({ sessionId, ...value }) + '\n';
const REPORT = 'mcp__futureaide-report__report_parent';
const ASK = 'mcp__futureaide-report__ask_parent';
const receipt = (overrides = {}) => JSON.stringify({ accepted: true, kind: 'report', taskId: 7,
  agentId: 'agent-7f3a', final: true, receiptId: 'accept-0123456789abcdef', ...overrides });
const use = (id, name, input = { message: 'done', final: true }) => ({ type: 'tool_use', id, name, input });
const result = (id, content, isError = false) => ({ type: 'tool_result', tool_use_id: id, is_error: isError, content });

test('a successful registered call whose receipt matches the task is the only pass', () => {
  const body = line({ type: 'assistant', message: { content: [use('toolu_1', REPORT)] } })
    + line({ type: 'user', message: { content: [result('toolu_1', [{ type: 'text', text: receipt() }])] } });
  const value = pairReports(body, { taskId: 7 });
  assert.equal(value.expectedTaskId, 7);
  assert.deepEqual(value.counts, { toolUses: 1, delivered: 1, refused: 0, notAccepted: 0,
    taskMismatch: 0, agentMismatch: 0, unknownTask: 0, unanswered: 0 });
  assert.equal(value.g2Satisfied, true);
  const [pair] = value.pairs;
  assert.equal(pair.kind, 'report');
  assert.equal(pair.receipt.taskId, 7);
  assert.equal(pair.receipt.agentId, 'agent-7f3a');
  assert.equal(pair.status, 'delivered');
});

test('the underscore spelling of the same registered name also counts', () => {
  const body = line({ type: 'assistant', message: { content: [use('toolu_1', 'mcp__futureaide_report__ask_parent', { message: 'which?' })] } })
    + line({ type: 'user', message: { content: [result('toolu_1', [{ type: 'text', text: receipt({ kind: 'question' }) }])] } });
  const value = pairReports(body, { taskId: 7 });
  assert.equal(value.pairs[0].kind, 'question');
  assert.equal(value.g2Satisfied, true);
});

test('a bare or look-alike tool name is reported, never counted', () => {
  const body = line({ type: 'assistant', message: { content: [use('toolu_1', 'report_parent')] } })
    + line({ type: 'user', message: { content: [result('toolu_1', [{ type: 'text', text: receipt() }])] } })
    + line({ type: 'assistant', message: { content: [use('toolu_2', 'mcp__other-server__report_parent')] } })
    + line({ type: 'user', message: { content: [result('toolu_2', [{ type: 'text', text: receipt() }])] } });
  const value = pairReports(body, { taskId: 7 });
  assert.equal(value.counts.toolUses, 0);
  assert.equal(value.g2Satisfied, false);
  assert.deepEqual(value.lookalikeTools.sort(), ['mcp__other-server__report_parent', 'report_parent']);
});

test('a native refusal never counts, even if the body echoes accepted', () => {
  const body = line({ type: 'assistant', message: { content: [use('toolu_1', REPORT)] } })
    + line({ type: 'user', message: { content: [result('toolu_1', [{ type: 'text', text: receipt() }], true)] } });
  const value = pairReports(body, { taskId: 7 });
  assert.equal(value.pairs[0].status, 'refused');
  assert.equal(value.counts.refused, 1);
  assert.equal(value.g2Satisfied, false);
});

test('a successful call with a refusal body is not a report', () => {
  const body = line({ type: 'assistant', message: { content: [use('toolu_1', REPORT)] } })
    + line({ type: 'user', message: { content: [result('toolu_1', [{ type: 'text',
      text: JSON.stringify({ error: { code: 'task-cancelled', message: 'stop' } }) }])] } })
    + line({ type: 'assistant', message: { content: [use('toolu_2', REPORT)] } })
    + line({ type: 'user', message: { content: [result('toolu_2', [{ type: 'text', text: 'Report recorded.' }])] } });
  const value = pairReports(body, { taskId: 7 });
  assert.deepEqual(value.pairs.map(pair => pair.status), ['not-accepted', 'not-accepted']);
  assert.equal(value.counts.notAccepted, 2);
  assert.equal(value.g2Satisfied, false);
});

test('a receipt for another task is a late old result and is separated', () => {
  const body = line({ type: 'assistant', message: { content: [use('toolu_1', REPORT)] } })
    + line({ type: 'user', message: { content: [result('toolu_1', [{ type: 'text', text: receipt({ taskId: 8 }) }])] } });
  const value = pairReports(body, { taskId: 7 });
  assert.equal(value.pairs[0].status, 'task-mismatch');
  assert.equal(value.counts.taskMismatch, 1);
  assert.equal(value.g2Satisfied, false);
});

test('an MCP-nested content body is unwrapped before the receipt is judged', () => {
  const nested = JSON.stringify({ content: [{ type: 'text', text: receipt() }] });
  const body = line({ type: 'assistant', message: { content: [use('toolu_1', REPORT)] } })
    + line({ type: 'user', message: { content: [result('toolu_1', [{ type: 'text', text: nested }])] } });
  const value = pairReports(body, { taskId: 7 });
  assert.equal(value.pairs[0].status, 'delivered');
  assert.equal(value.g2Satisfied, true);
});

test('without a task under test nothing claims a pass', () => {
  const body = line({ type: 'assistant', message: { content: [use('toolu_1', REPORT)] } })
    + line({ type: 'user', message: { content: [result('toolu_1', [{ type: 'text', text: receipt() }])] } });
  const value = pairReports(body);
  assert.equal(value.pairs[0].status, 'unknown-task');
  assert.equal(value.counts.unknownTask, 1);
  assert.equal(value.g2Satisfied, false);
});

test('sidechain uses, unrelated tools and broken lines are not evidence', () => {
  const body = line({ type: 'assistant', isSidechain: true, message: { content: [use('toolu_side', REPORT)] } })
    + line({ type: 'assistant', message: { content: [use('toolu_read', 'Read', { file_path: 'x' })] } })
    + line({ type: 'user', message: { content: [result('toolu_read', 'file body')] } })
    + '{not json}\n';
  const value = pairReports(body, { taskId: 7 });
  assert.equal(value.sidechainUses, 1);
  assert.equal(value.counts.toolUses, 0);
  assert.equal(value.badLines, 1);
  assert.equal(value.g2Satisfied, false);
});

test('a leading byte-order mark does not swallow the first record', () => {
  const body = '\uFEFF' + line({ type: 'assistant', message: { content: [use('toolu_1', REPORT)] } })
    + line({ type: 'user', message: { content: [result('toolu_1', [{ type: 'text', text: receipt() }])] } });
  const value = pairReports(body, { taskId: 7 });
  assert.equal(value.badLines, 0);
  assert.equal(value.g2Satisfied, true);
});

test('a receipt from another agent id is separated when the roster names one', () => {
  const body = line({ type: 'assistant', message: { content: [use('toolu_1', REPORT)] } })
    + line({ type: 'user', message: { content: [result('toolu_1', [{ type: 'text', text: receipt({ agentId: 'agent-other' }) }])] } })
    + line({ type: 'assistant', message: { content: [use('toolu_2', REPORT)] } })
    + line({ type: 'user', message: { content: [result('toolu_2', [{ type: 'text', text: receipt({ agentId: 'agent-7f3a' }) }])] } });
  const mismatched = pairReports(body, { taskId: 7, agentId: 'agent-7f3a' });
  assert.deepEqual(mismatched.pairs.map(pair => pair.status), ['agent-mismatch', 'delivered']);
  assert.equal(mismatched.counts.agentMismatch, 1);
  assert.equal(mismatched.g2Satisfied, true);
});

test('the evidence accepts exactly what the runtime parser accepts', () => {
  assert.deepEqual(reportReceipt({ content: [{ type: 'text', text: receipt() }] }),
    { accepted: true, taskId: 7, agentId: 'agent-7f3a', kind: 'report', final: true,
      questionId: undefined, receiptId: 'accept-0123456789abcdef' });
  // The wire format is plain JSON text; a Markdown fence is not something the
  // runtime parses, so it must not pass here either.
  assert.equal(reportReceipt({ content: [{ type: 'text', text: '```json\n' + receipt() + '\n```' }] }), undefined);
  assert.equal(reportReceipt({ content: [{ type: 'text', text: '{"error":{"code":"task-cancelled"}}' }] }), undefined);
  assert.equal(reportReceipt({ content: [{ type: 'text', text: 'all good' }] }), undefined);
  assert.ok(REPORT_TOOL_ALLOWLIST.every(name => name.startsWith('mcp__')));
});
