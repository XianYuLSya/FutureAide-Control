import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCallingContext } from '../src/calling-context.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const threadId = '11111111-1111-4111-8111-111111111111';
const extra = { _meta: { threadId } };
const appToolsThread = () => ({ thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } });

test('a Codex caller is verified by the native thread read before app-tools', async () => {
  const methods = [];
  const owner = await resolveCallingContext(extra, {
    nativeRequest: async (method, params) => {
      methods.push([method, params]);
      return { thread: { id: threadId, cwd: workspace } };
    },
  });
  assert.equal(owner.threadId, threadId);
  assert.deepEqual(methods, [['thread/read', { threadId, includeTurns: false }]]);
});

test('a desktop without a debug port falls back to the app-tools read', async () => {
  let appTools = 0;
  const owner = await resolveCallingContext(extra, {
    nativeRequest: async () => { throw Object.assign(new Error('no debug port'), { code: 'codex-native-rpc-unavailable' }); },
    codexInvoke: async () => { appTools++; return appToolsThread(); },
  });
  assert.equal(owner.workspace, workspace);
  assert.equal(appTools, 1);
});

test('a rejected native read is not silently retried over another transport', async () => {
  let appTools = 0;
  await assert.rejects(resolveCallingContext(extra, {
    nativeRequest: async () => { throw Object.assign(new Error('plugin method rejected'), { code: 'codex-native-rpc-rejected' }); },
    codexInvoke: async () => { appTools++; return appToolsThread(); },
  }), /plugin method rejected/);
  assert.equal(appTools, 0);
});
