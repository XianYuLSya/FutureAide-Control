import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { emptyClaudeProjection, projectClaudePage, claudeTurn, observeClaudeTranscript } from '../src/claude-observer.mjs';
import { reportReceipt } from '../src/claude-inbox.mjs';

const options = { workspace: path.resolve('clean/validation'), agentId: 'owned-agent', requestIds: ['request-1'] };
const event = (seq, extra = {}) => ({ seq, type: 'assistant', timestamp: `time-${seq}`, text: '', tools: [], results: [], ...extra });
const use = (id, name, input) => ({ id, name, input });
const report = (id, message, final = false) => use(id, 'mcp__futureaide-report__report_parent', { message, final });
const result = (id, extra = {}) => ({ id, isError: false, ...extra });
const page = (offset, events, extra = {}) => ({ offset, events, deliveries: [], ...extra });
const project = (p, batch) => projectClaudePage(p, batch, options);

test('only a successful accepted native report pair for this task is a report', () => {
  const p = emptyClaudeProjection('task-1');
  project(p, page(10, [event(10, { text: 'I finished and reported.', stopReason: 'end_turn',
    tools: [report('good', 'Deliverable', true), report('error', 'Refused'), report('old', 'Old task'),
      report('not-accepted', 'No acceptance'), use('foreign', 'mcp__other__report_parent', { message: 'Foreign' })] })]));
  assert.equal(p.reports.length, 0);
  project(p, page(20, [event(20, { type: 'user', results: [
    result('good', { receipt: { accepted: true, taskId: 'task-1', agentId: 'owned-agent' } }),
    result('error', { isError: true, receipt: { accepted: true, taskId: 'task-1' } }),
    result('old', { receipt: { accepted: true, taskId: 'task-0' } }), result('not-accepted'),
    result('foreign', { receipt: { accepted: true, taskId: 'task-1' } }),
  ] })]));
  assert.deepEqual(p.reports.map(({ id, message, final }) => ({ id, message, final })),
    [{ id: 'owned-agent:good', message: 'Deliverable', final: true }]);
  // Re-reading an already consumed page does not issue a second report.
  project(p, page(20, [event(20, { type: 'user', results: [result('good', { receipt: { accepted: true, taskId: 'task-1' } })] })]));
  assert.equal(p.reports.length, 1);
});

test('accepted questions have a stable native identity, ordinary text does not ask', () => {
  const p = emptyClaudeProjection('task-1');
  project(p, page(2, [event(1, { text: 'Which option?', tools: [use('q', 'mcp__futureaide-report__ask_parent', { message: 'A or B?' })] }),
    event(2, { type: 'user', results: [result('q', { receipt: { accepted: true, taskId: 'task-1' } })] })]));
  assert.deepEqual(p.questions.map(({ id, state, message }) => ({ id, state, message })),
    [{ id: 'owned-agent:q', state: 'pending', message: 'A or B?' }]);
});

test('file attribution waits for success and does not infer shell writes', () => {
  const p = emptyClaudeProjection('task-1');
  project(p, page(1, [event(1, { tools: [use('write', 'Write', { file_path: 'new.txt' }),
    use('edit', 'Edit', { file_path: 'unchanged.txt' }), use('shell', 'Bash', { file_path: 'secret.txt' })] })]));
  assert.equal(p.changes.length, 0);
  project(p, page(2, [event(2, { type: 'user', results: [result('write'), result('edit', { isError: true }), result('shell')] })]));
  assert.deepEqual(p.changes.map(({ path: file, operation }) => ({ file, operation })),
    [{ file: path.join(options.workspace, 'new.txt'), operation: 'create' }]);
});

test('busy acceptance is not insertion and a running tree is not an ended turn', () => {
  const p = emptyClaudeProjection('task-1');
  project(p, page(10, [event(9, { stopReason: 'end_turn' })],
    { deliveries: [{ requestId: 'request-1', stage: 'accepted', seq: 10 }] }));
  assert.equal(claudeTurn(p, 'request-1').state, 'running');
  project(p, page(25, [event(25, { stopReason: 'end_turn' })],
    { deliveries: [{ requestId: 'request-1', stage: 'inserted', seq: 20 }] }));
  assert.equal(claudeTurn(p, 'request-1', { running: true }).state, 'running');
  assert.deepEqual(claudeTurn(p, 'request-1'), { state: 'ended', correlation: 'request-id',
    afterSeq: 0, endSeq: 25, completionReason: { kind: 'completed' } });
});

test('the native interrupt marker ends the turn but does not manufacture a final report', () => {
  const p = emptyClaudeProjection('task-1');
  project(p, page(2, [event(2, { type: 'user', text: '[Request interrupted by user]' })],
    { deliveries: [{ requestId: 'request-1', stage: 'inserted', seq: 1 }] }));
  assert.equal(claudeTurn(p, 'request-1').completionReason.kind, 'cancelled');
  assert.equal(p.reports.length, 0);
});

test('MCP envelopes require accepted true and preserve the task identity', () => {
  const receipt = { accepted: true, taskId: 'task-1', agentId: 'owned-agent' };
  assert.equal(reportReceipt('not json'), undefined);
  assert.equal(reportReceipt({ accepted: false }), undefined);
  assert.equal(reportReceipt({ isError: true, ...receipt }), undefined);
  const native = [{ type: 'text', text: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(receipt) }] }) }];
  assert.equal(reportReceipt(native).taskId, 'task-1');
});

test('incremental observation retains unresolved tool pairs and stops on partial lines', async () => {
  const p = emptyClaudeProjection('task-1');
  const calls = [];
  const readEvents = async (_binding, { offset }) => {
    calls.push(offset);
    if (!offset) return page(10, [event(10, { tools: [report('r', 'Done')] })], { hasMore: true });
    return page(10, [], { hasMore: true });
  };
  await observeClaudeTranscript({}, p, { ...options, readEvents });
  assert.deepEqual(calls, [0, 10]);
  assert.equal(p.pendingTools.r.input.message, 'Done');
  assert.equal(p.reports.length, 0);
});
