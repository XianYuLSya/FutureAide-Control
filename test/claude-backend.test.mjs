import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClaudeBackend } from '../src/claude-backend.mjs';
import { markerLine } from '../src/claude-host.mjs';

async function setup() {
  const directory = fileURLToPath(new URL(`../clean/validation/claude-backend/${randomUUID()}/`, import.meta.url));
  await mkdir(path.join(directory, 'sessions'), { recursive: true });
  const sid = randomUUID();
  const recordFile = path.join(directory, 'sessions', `${process.pid}.json`);
  const transcriptFile = path.join(directory, `${sid}.jsonl`);
  const native = { pid: process.pid, sessionId: sid, procStart: 'fixture-start', entrypoint: 'claude-desktop',
    cwd: directory, status: 'idle', hostSessionId: 'local-' + sid };
  await writeFile(recordFile, JSON.stringify(native));
  await writeFile(transcriptFile, '');
  const record = { agentId: 'owned', sessionId: 'logical', name: 'helper', workspace: directory, target: 'claude-desktop',
    task: { taskId: 'task-1' } };
  let saved;
  const counters = { created: 0, sent: 0, reportsStarted: 0, locks: 0 };
  const model = { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'max', verified: true, resolved: true };
  const append = events => appendFile(transcriptFile, events.map(e => JSON.stringify({ sessionId: sid, ...e })).join('\n') + '\n');
  const binding = { pid: process.pid, sessionId: sid, workspace: directory, procStart: 'fixture-start', recordFile,
    transcriptFile, hostSessionId: native.hostSessionId };
  const deps = {
    env: { CLAUDE_CONFIG_DIR: directory }, load: () => record, driver: {},
    readNativeState: () => saved && structuredClone(saved),
    writeNativeState: value => { saved = structuredClone(value); return true; },
    withHostLock: async action => { counters.locks++; return action(); },
    ensureClaudeReports: async () => { counters.reportsStarted++; return { ready: true }; },
    bindClaude: async () => binding,
    sendClaude: async () => { counters.sent++; return { status: 'written' }; },
    tree: { TREE_PROTOCOL: 1, observeClaudeTree: async (_binding, projection, options) => ({
      tree: { settled: true, running: false, nodes: [{ sessionId: options.logicalSessionId,
        parentSessionId: null, status: 'idle', changes: projection.changes }] }, state: {}, histories: {} }) },
    host: {
      readDefaultModel: async () => model, readCurrentModel: async () => model,
      createFirstTurn: async (input, options) => {
        counters.created++;
        await append([{ type: 'user', uuid: randomUUID(), message: { content: input.message + '\n' + markerLine(input.requestId, input.bindingNonce) } }]);
        const result = { created: true, nativeSessionId: sid, pid: process.pid, hostSessionId: native.hostSessionId };
        await options.onBound(result);
        return result;
      },
      interrupt: async () => ({ interrupted: true }), destroy: async () => ({ destroyed: false, deleted: false }),
    },
  };
  const adapter = await createClaudeBackend(record, deps);
  return { adapter, deps, counters, append, record, getState: () => saved,
    replace: value => { saved = structuredClone(value); } };
}

test('reservation starts no model and first deliver binds by the host marker', async () => {
  const f = await setup();
  const probe = await f.adapter.probe();
  assert.equal(probe.treeProtocol, 1);
  assert.equal(f.counters.reportsStarted, 0);
  assert.deepEqual(await f.adapter.create(), { sessionId: 'logical', modelRequestsStarted: 0 });
  assert.equal(f.counters.created, 0);
  await f.adapter.beginTask();
  assert.equal((await f.adapter.deliver({ requestId: 'first', message: 'Do work' })).accepted, true);
  assert.equal(f.counters.created, 1);
  assert.equal(f.counters.sent, 0);
  assert.equal(f.getState().binding.sessionId.length, 36);
  assert.equal((await f.adapter.receipt({ requestId: 'first' })).status, 'accepted');
});

test('an uncertain native write survives reconstruction without a duplicate send', async () => {
  const f = await setup();
  await f.adapter.create();
  await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'first', message: 'First' });
  assert.equal((await f.adapter.deliver({ requestId: 'followup', message: 'More' })).status, 'unknown');
  const recovered = await createClaudeBackend(f.record, f.deps);
  assert.equal((await recovered.deliver({ requestId: 'followup', message: 'More' })).accepted, false);
  assert.equal(f.counters.sent, 1);
  assert.equal((await recovered.receipt({ requestId: 'followup' })).status, 'unknown');
  assert.equal(await recovered.receipt({ requestId: 'never-attempted' }), undefined);
  await f.append([{ type: 'user', uuid: 'followup', message: { content: 'More' } },
    { type: 'assistant', uuid: 'reply', message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } }]);
  assert.equal((await recovered.receipt({ requestId: 'followup' })).status, 'accepted');
  assert.equal((await recovered.turn({ requestId: 'followup' })).state, 'ended');
  assert.equal(f.counters.sent, 1);
});

test('reusing a persistent agent keeps native identity but resets the task projection', async () => {
  const f = await setup();
  await f.adapter.create();
  await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'first', message: 'First' });
  await f.append([{ type: 'assistant', uuid: 'done', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ordinary reply' }] } }]);
  const old = await f.adapter.observe();
  const sid = f.getState().binding.sessionId;
  f.record.task = { taskId: 'task-2' };
  await f.adapter.beginTask();
  const next = await f.adapter.observe();
  assert.equal(next.taskId, 'task-2');
  assert.equal(next.throughSeq, old.throughSeq);
  assert.equal(f.getState().binding.sessionId, sid);
  assert.deepEqual(next.reports, []);
  assert.equal(f.counters.created, 1);
});

test('failed native cleanup is never upgraded to destroyed', async () => {
  const f = await setup();
  await f.adapter.create();
  await f.adapter.beginTask();
  await f.adapter.deliver({ requestId: 'first', message: 'First' });
  assert.equal((await f.adapter.destroy()).destroyed, false);
  assert.equal(f.getState().binding.sessionId.length, 36);
});

test('a failed report-service startup leaves the native host untouched', async () => {
  const f = await setup();
  const adapter = await createClaudeBackend(f.record, { ...f.deps, ensureClaudeReports: async () => ({ ready: false }) });
  await assert.rejects(adapter.create(), { code: 'claude-report-not-ready' });
  assert.equal(f.counters.created, 0);
  assert.equal(f.counters.sent, 0);
});
