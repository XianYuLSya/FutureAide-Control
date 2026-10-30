import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgents } from '../src/agents.mjs';

const catalog = {
  default: { provider: 'wb', model: 'flash', reasoningEffort: 'max' },
  routableProviders: ['wb'],
  groups: [{ id: 'wb', models: [{ id: 'flash', reasoning: { efforts: [{ id: 'max' }] } }] }],
};

function fakeControl(overrides = {}) {
  const calls = { configs: [], create: [], sends: [], waits: [], archives: [], restores: [] };
  const factory = config => {
    calls.configs.push(config);
    return {
      async connect() { return { ready: true }; },
      async connectionIdentity() { return { baseUrl: 'http://127.0.0.1:12345', pid: 123 }; },
      async models() { return catalog; },
      async createSession(input) {
        calls.create.push(input);
        return { accepted: true, sessionId: 'session-1', workspaceId: 'workspace-root',
          workspaceTitle: 'Project One', projectCreated: true, projectRenamed: true };
      },
      async selectModel() { return { accepted: true }; },
      async send(input) { calls.sends.push(input); return { accepted: true, afterSeq: 0 }; },
      async wait(input) {
        calls.waits.push(input);
        return { state: 'ended', completionReason: { kind: 'completed' }, messages: [], afterSeq: 0 };
      },
      async cancel() { return { accepted: true }; },
      async archiveSession(input) {
        calls.archives.push(input);
        return overrides.archiveSession ? overrides.archiveSession(input) : { accepted: true, receipt: 'archive-receipt' };
      },
      async unarchiveSession(input) {
        calls.restores.push(input);
        return overrides.unarchiveSession ? overrides.unarchiveSession(input) : { accepted: true, receipt: 'restore-receipt' };
      },
    };
  };
  return { factory, calls };
}

async function setup(t, overrides) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-agent-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const taskDirectory = path.join(workspace, 'sub', 'task');
  await mkdir(taskDirectory, { recursive: true });
  const config = { workspace, stateDirectory: path.join(workspace, 'state'), registryDirectory: path.join(workspace, 'agents') };
  const control = fakeControl(overrides);
  const agents = createAgents(config, { controlFactory: control.factory });
  return { root: workspace, taskDirectory, config, agents, control };
}

const recordOf = async (root, agentId) => JSON.parse(await readFile(path.join(root, 'agents', agentId, 'agent.json'), 'utf8'));

test('a subdirectory task is attributed to the explicit project root without losing its task directory', async t => {
  const f = await setup(t);
  const spawned = await f.agents.spawn({ workspace: f.taskDirectory, projectWorkspace: f.root,
    projectName: 'Project One', message: 'only the task text', requestId: 'project-spawn' });
  assert.equal(spawned.accepted, true);
  assert.equal(spawned.workspace, f.root);
  assert.equal(spawned.taskDirectory, f.taskDirectory);
  assert.deepEqual(spawned.project, { workspaceId: 'workspace-root', path: f.root, title: 'Project One', created: true, renamed: true });
  // The native session root is the project root; the task directory is explicit context.
  assert.equal(f.control.calls.configs[0].workspace, f.root);
  assert.deepEqual(f.control.calls.create[0], { requestId: f.control.calls.create[0].requestId, agentPreset: undefined, projectName: 'Project One' });
  const sent = f.control.calls.sends[0];
  assert.ok(sent.message.startsWith('['));
  assert.ok(sent.message.split('\n').length >= 6);
  assert.ok(sent.message.includes(f.root));
  assert.ok(sent.message.includes(f.taskDirectory));
  assert.ok(sent.message.endsWith('only the task text'));
  assert.equal(sent.archive, true);
  assert.equal(sent.suppressCallback, false);
  const record = await recordOf(f.root, spawned.agentId);
  assert.equal(record.workspace, f.root);
  assert.equal(record.taskDirectory, f.taskDirectory);
  assert.equal(record.input.message, 'only the task text');
  assert.equal(record.input.projectName, 'Project One');
});

test('without project_workspace the task directory remains the project and no context is invented', async t => {
  const f = await setup(t);
  const spawned = await f.agents.spawn({ workspace: f.taskDirectory, message: 'plain task', requestId: 'plain-spawn' });
  assert.equal(spawned.workspace, f.taskDirectory);
  assert.equal(spawned.taskDirectory, undefined);
  assert.equal(f.control.calls.sends[0].message, 'plain task');
  assert.equal(f.control.calls.create[0].projectName, undefined);
});

test('project_workspace must be the task workspace or an ancestor', async t => {
  const f = await setup(t);
  const unrelated = path.join(f.root, 'other');
  await mkdir(unrelated, { recursive: true });
  await assert.rejects(f.agents.spawn({ workspace: f.taskDirectory, projectWorkspace: unrelated, message: 'x', requestId: 'bad-root' }),
    /task workspace or one of its ancestors/);
  assert.deepEqual(f.control.calls.create, []);
});

test('archive only claims success for a confirmed native receipt and keeps unknown receipts inspectable', async t => {
  const f = await setup(t, {
    archiveSession: async () => ({ accepted: false, status: 'unknown', receipt: 'C:/receipts/archive.json' }),
  });
  const spawned = await f.agents.spawn({ workspace: f.taskDirectory, projectWorkspace: f.root, message: 'work', requestId: 'archive-unknown' });
  await f.agents.wait({ agentId: spawned.agentId });
  const result = await f.agents.archive({ agentId: spawned.agentId });
  assert.equal(result.accepted, false);
  assert.equal(result.archive.state, 'unknown');
  assert.equal(result.archive.status, 'unknown');
  assert.equal(result.archive.receipt, 'C:/receipts/archive.json');
  assert.equal(result.archive.requestId, 'archive-unknown');
  assert.match(result.note, /not assumed|inspectable/);
  const record = await recordOf(f.root, spawned.agentId);
  assert.equal(record.archive.state, 'unknown');
});

test('followup restores the same archived session and keeps the restore scoped to that dispatch', async t => {
  const f = await setup(t);
  const spawned = await f.agents.spawn({ workspace: f.taskDirectory, projectWorkspace: f.root, message: 'work', requestId: 'spawn' });
  await f.agents.wait({ agentId: spawned.agentId });
  const archived = await f.agents.archive({ agentId: spawned.agentId });
  assert.equal(archived.accepted, true);
  assert.equal(archived.archive.state, 'archived');
  assert.equal(archived.archive.requestId, 'spawn');

  const followed = await f.agents.followup({ agentId: spawned.agentId, message: 'continue', requestId: 'follow' });
  assert.equal(followed.accepted, true);
  assert.equal(followed.restored, true);
  assert.equal(f.control.calls.restores.length, 1);
  assert.equal(f.control.calls.restores[0].sessionId, 'session-1');
  assert.match(f.control.calls.restores[0].requestId, /restore/);
  assert.ok(f.control.calls.sends[1].message.includes('continue'));
  let record = await recordOf(f.root, spawned.agentId);
  assert.equal(record.archive.state, 'restored');
  assert.equal(record.archive.requestId, 'spawn', 'the restore belongs to the archived dispatch, not the next one');

  // The next dispatch finishes and archives again. A report for that newer request must surface
  // its own archive instead of inheriting the old restored marker.
  await f.agents.wait({ agentId: spawned.agentId });
  const archivedAgain = await f.agents.archive({ agentId: spawned.agentId });
  assert.equal(archivedAgain.archive.state, 'archived');
  assert.equal(archivedAgain.archive.requestId, 'follow');
  const reportFile = path.join(f.root, 'agents', spawned.agentId, 'state', 'reports', 'session-1.follow.json');
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, JSON.stringify({ state: 'ended', terminalState: 'completed', sessionId: 'session-1',
    requestId: 'follow', afterSeq: 0, completionReason: { kind: 'completed' },
    archive: { state: 'archived', requestId: 'follow' } }));
  const listed = (await f.agents.list({ workspace: f.root })).items.find(item => item.agentId === spawned.agentId);
  assert.equal(listed.archive.state, 'archived');
  assert.equal(listed.archive.requestId, 'follow');
  record = await recordOf(f.root, spawned.agentId);
  assert.equal(record.archive.requestId, 'follow');
});

test('an unconfirmed restore is reported and nothing is sent, while an unsupported restore continues with the fact stated', async t => {
  const unconfirmed = await setup(t, {
    unarchiveSession: async () => ({ accepted: false, status: 'unknown', receipt: 'C:/receipts/restore.json' }),
  });
  const first = await unconfirmed.agents.spawn({ workspace: unconfirmed.taskDirectory, projectWorkspace: unconfirmed.root, message: 'work', requestId: 'spawn' });
  await unconfirmed.agents.wait({ agentId: first.agentId });
  await unconfirmed.agents.archive({ agentId: first.agentId });
  const blocked = await unconfirmed.agents.followup({ agentId: first.agentId, message: 'next', requestId: 'follow' });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.state, 'archived');
  assert.equal(blocked.restored, false);
  assert.equal(blocked.error.code, 'restore-unconfirmed');
  assert.equal(unconfirmed.control.calls.sends.length, 1, 'the followup was not sent');
  const record = await recordOf(unconfirmed.root, first.agentId);
  assert.equal(record.archive.state, 'unknown');
  assert.equal(record.archive.receipt, 'C:/receipts/restore.json');

  const unsupported = await setup(t, {
    unarchiveSession: async () => { throw Object.assign(new Error('unknown endpoint'), { code: 'unknown-endpoint' }); },
  });
  const second = await unsupported.agents.spawn({ workspace: unsupported.taskDirectory, projectWorkspace: unsupported.root, message: 'work', requestId: 'spawn' });
  await unsupported.agents.wait({ agentId: second.agentId });
  await unsupported.agents.archive({ agentId: second.agentId });
  const continued = await unsupported.agents.followup({ agentId: second.agentId, message: 'continue', requestId: 'follow' });
  assert.equal(continued.accepted, true);
  assert.equal(continued.restored, false);
  assert.equal(continued.restoreUnavailable, true);
  assert.match(continued.note, /does not expose session restore/);
  assert.equal(unsupported.control.calls.sends.length, 2, 'the same session was still attempted');
  const continuedRecord = await recordOf(unsupported.root, second.agentId);
  assert.equal(continuedRecord.archive.state, 'restore-unavailable');
  assert.equal(continuedRecord.archive.requestId, 'spawn');
});
