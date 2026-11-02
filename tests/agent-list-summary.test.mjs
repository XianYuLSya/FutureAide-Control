import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedOutput } from '../src/control.mjs';
import { summarizeAgentList } from '../src/agent-list-summary.mjs';

function largeFiles(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    path: `D:/Work/example/src/${prefix}/module-${index}.js`,
    operation: 'write',
    agentPath: ['lead', `worker-${index}`],
    before: 'x'.repeat(120),
    after: 'y'.repeat(120),
  }));
}

function largeTree(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-node-${index}`,
    parentName: index === 0 ? null : `${prefix}-node-${index - 1}`,
    agentPath: ['lead', `${prefix}-node-${index}`],
    status: index % 2 ? 'completed' : 'running',
    activity: 'working on repeated large payload '.repeat(20),
    changes: largeFiles(`${prefix}-${index}`, 20),
    coverage: { source: 'dsh-task-tree', complete: false, limitation: 'partial '.repeat(80) },
  }));
}

function item(name, index) {
  const files = largeFiles(name, 40);
  return {
    name,
    runtime: 'dsh',
    lifetime: 'persistent',
    state: 'running',
    task: {
      text: `Task ${name} summary`,
      state: 'running',
      startedAt: `2026-11-02T09:0${index}:00.000Z`,
      result: {
        state: 'completed',
        reply: `completed reply ${name} `.repeat(300),
        files,
        coverage: { source: 'dsh-task-tree', complete: false, limitation: 'partial '.repeat(160) },
      },
    },
    activity: 'processing repeated list payload '.repeat(40),
    questions: Array.from({ length: 10 }, (_, question) => ({ state: 'pending', message: `Question ${question} for ${name} `.repeat(8) })),
    changes: { count: files.length, files, coverage: { source: 'dsh-task-tree', complete: false, limitation: 'partial '.repeat(160) } },
    tree: { settled: false, running: true, nodes: largeTree(name, 24) },
  };
}

test('summarizes an oversized three-agent list into complete items without boundedOutput preview', () => {
  const fixture = {
    items: ['alpha', 'beta', 'gamma'].map(item),
    total: 3,
  };
  const raw = boundedOutput(fixture);
  assert.equal(JSON.parse(raw).truncated, true, 'fixture must exceed the normal output budget');

  const output = boundedOutput(summarizeAgentList(fixture));
  const parsed = JSON.parse(output);
  assert.equal(parsed.truncated, undefined);
  assert.equal(parsed.items.length, 3);
  assert.deepEqual(parsed.items.map(value => value.name), ['alpha', 'beta', 'gamma']);

  const first = parsed.items[0];
  assert.equal(first.task.result, undefined);
  assert.equal(first.changes.count, 40);
  assert.equal(first.changes.files.length, 8);
  assert.equal(first.changes.truncated, true);
  assert.equal(first.tree.nodes.length, 12);
  assert.equal(first.tree.truncated, true);
  assert.equal(first.tree.nodes[0].changes, undefined);
  assert.equal(first.tree.nodes[0].coverage, undefined);
});

test('keeps real list diagnostics, queue state, reports and partial changes coverage', () => {
  const fixture = {
    items: [{
      name: 'partial-dsh',
      runtime: 'dsh',
      lifetime: 'persistent',
      state: 'running',
      error: { code: 'pending-input', message: `A queued supplement is still in flight. ${'detail '.repeat(80)}` },
      monitor: 'sleeping',
      supplements: { queued: 2, unknown: 0, blocked: 1, accepted: 0, latest: { status: 'queued', reason: 'waiting for the active turn' } },
      reports: { total: 3, pending: 1, latest: { summary: 'final report body', final: true, delivery: 'dispatcher-pending' } },
      delivery: 'dispatcher-pending',
      changes: {
        count: 1,
        observedAt: '2026-11-02T10:00:00.000Z',
        files: [{ path: 'D:/Work/example/src/real.js' }],
        coverage: { scope: 'DSH task tree', complete: false, limitation: `partial tree observation ${'do not copy '.repeat(40)}`,
          nodes: [{ agentPath: ['lead'], coverage: { complete: false } }] },
      },
      tree: { settled: false, running: true, nodes: [{ name: 'lead', status: 'running' }] },
    }, {
      name: 'native-unobserved',
      runtime: 'claude',
      lifetime: 'persistent',
      state: 'idle',
      changes: { count: 0, files: [], coverage: { source: 'cli-json-events', complete: false, limitation: 'Only paths present in CLI events are attributed.' } },
    }],
    total: 2,
  };
  const parsed = summarizeAgentList(fixture);
  const first = parsed.items[0];
  assert.equal(first.error.code, 'pending-input');
  assert.match(first.error.message, /^A queued supplement/);
  assert.ok(first.error.message.length <= 241);
  assert.equal(first.monitor, 'sleeping');
  assert.equal(first.queue.queued, 2);
  assert.equal(first.queue.blocked, 1);
  assert.equal(first.queue.latest.status, 'queued');
  assert.deepEqual(first.reports, { total: 3, pending: 1, latestFinal: true, delivery: 'dispatcher-pending' });
  assert.equal(first.delivery, 'dispatcher-pending');
  assert.equal(first.changes.count, 1);
  assert.equal(first.changes.coverage.complete, false);
  assert.match(first.changes.coverage.unsupported, /partial tree observation/);
  assert.equal(first.changes.coverage.nodes, undefined, 'do not copy tree coverage');
  const native = parsed.items[1];
  assert.equal(native.changes.count, undefined, 'native unobserved must not show count 0');
  assert.equal(native.changes.coverage.complete, false);
  assert.match(native.changes.coverage.unsupported, /Only paths present/);
});
