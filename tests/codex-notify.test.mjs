import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { notificationText, notifyCodex } from '../src/codex-notify.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
async function setup(t) {
  const workspace = await mkdtemp(path.join(testRoot, '.notify-test-'));
  t.after(async () => {
    assert.ok(workspace.startsWith(testRoot + path.sep));
    await rm(workspace, { recursive: true, force: true });
  });
  return { workspace, stateDirectory: path.join(workspace, 'state'), codexThreadId: '11111111-1111-4111-8111-111111111111', futureaideSessionId: 'parent-session' };
}

test('completion is a request for verification, not an acceptance claim', () => {
  const text = notificationText({ workspace: 'another-project' }, { event: 'completed', summary: 'done' });
  assert.match(text, /尚待独立验收/);
  assert.doesNotMatch(text, /Codex监督与接口\/目标\.md/);
});

test('an identical completion is delivered only once, even concurrently', async t => {
  const config = await setup(t);
  await writeFile(path.join(config.workspace, 'evidence.md'), 'verified build');
  let calls = 0;
  const callTool = async (threadId, name, args) => {
    calls++;
    assert.equal(name, 'send_message_to_thread');
    assert.equal(threadId, config.codexThreadId);
    assert.equal(args.threadId, config.codexThreadId);
  };
  const input = { event: 'completed', summary: 'ready', evidence: 'evidence.md' };
  const results = await Promise.all([notifyCodex(config, input, { callTool }), notifyCodex(config, input, { callTool })]);
  assert.equal(calls, 1);
  assert.ok(results.some(result => result.delivered));
  const duplicate = await notifyCodex(config, input, { callTool });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.delivered, true);
});

test('unknown delivery is retained and never silently resent', async t => {
  const config = await setup(t);
  let calls = 0;
  const callTool = async () => { calls++; throw new Error('connection ended'); };
  const input = { event: 'blocked', summary: 'needs repair' };
  await assert.rejects(notifyCodex(config, input, { callTool }), /unconfirmed/);
  const duplicate = await notifyCodex(config, input, { callTool });
  assert.equal(duplicate.status, 'unknown');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(duplicate.receipt, 'utf8')).status, 'unknown');
});

test('evidence cannot escape the project', async t => {
  const config = await setup(t);
  await assert.rejects(notifyCodex(config, { event: 'completed', summary: 'done', evidence: '../outside.md' }), /configured project/);
});
