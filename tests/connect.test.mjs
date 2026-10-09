import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createControl } from '../src/control.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'futureaide-connect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const instance = { connected: true, baseUrl: 'http://127.0.0.1:44000', pid: 123 };
  const state = { installed: 0, created: 0, ready: false, prompts: 0 };
  const client = {
    status: async () => instance,
    hostStatus: async () => {
      if (!state.ready) throw Object.assign(new Error('missing bridge'), { code: 'http-error', httpStatus: 405 });
      return { version: 1, methods: ['capabilities', 'historyCursor'], pid: instance.pid };
    },
    createSession: async input => { state.created++; state.ready = true; return { accepted: true, ...input }; },
    sendMessage: async () => { state.prompts++; },
  };
  const config = { workspace: root, stateDirectory: path.join(root, 'state') };
  const control = createControl(config, { client, installHost: async () => { state.installed++; } });
  return { instance, state, client, control };
}

test('connect loads the owned bridge without inference and reuses a ready host', async t => {
  const { state, control } = await fixture(t);
  const result = await control.connect({ requestId: 'first' });
  assert.equal(result.ready, true);
  assert.equal(result.modelRequestsStarted, 0);
  assert.equal(result.applicationRestarted, false);
  assert.match(result.bootstrapSessionId, /^session-codex-bridge-/);
  assert.equal((await control.connect({ requestId: 'again' })).ready, true);
  assert.deepEqual(state, { installed: 1, created: 1, ready: true, prompts: 0 });
});

test('connect does not install or start an application when it is disconnected', async t => {
  const { state, client, control } = await fixture(t);
  client.status = async () => ({ connected: false });
  assert.equal((await control.connect({ requestId: 'offline' })).ready, false);
  assert.equal(state.installed, 0);
  assert.equal(state.created, 0);
});

test('connect does not treat unrelated host failures as an installation request', async t => {
  const { state, client, control } = await fixture(t);
  client.hostStatus = async () => { throw Object.assign(new Error('forbidden'), { code: 'http-error', httpStatus: 403 }); };
  await assert.rejects(control.connect({ requestId: 'forbidden' }), /forbidden/);
  assert.equal(state.installed, 0);
});

test('an uncertain bootstrap is not submitted twice', async t => {
  const { state, client, control } = await fixture(t);
  client.createSession = async () => { state.created++; throw Object.assign(new Error('timeout'), { uncertain: true }); };
  await assert.rejects(control.connect({ requestId: 'uncertain' }), /timeout/);
  const result = await control.connect({ requestId: 'uncertain' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.ready, false);
  assert.equal(state.created, 1);
  assert.equal(state.installed, 1);
});

test('a changed host is rejected before bootstrap creation', async t => {
  const { state, client, control } = await fixture(t);
  let reads = 0;
  client.status = async () => ({ connected: true, baseUrl: 'http://127.0.0.1:44000', pid: ++reads === 1 ? 123 : 456 });
  await assert.rejects(control.connect({ requestId: 'restart' }), /changed/);
  assert.equal(state.created, 0);
});

test('connect refreshes an older bridge that lacks the cold-history cursor', async t => {
  const { state, client, control } = await fixture(t);
  let calls = 0;
  client.hostStatus = async () => {
    calls++;
    return { version: 1, methods: calls === 1 ? ['capabilities'] : ['capabilities', 'historyCursor'], pid: 123 };
  };
  const result = await control.connect({ requestId: 'refresh-history' });
  assert.equal(result.ready, true);
  assert.equal(state.installed, 1);
  assert.equal(state.created, 1);
});

test('connect installs its bridge into the discovered native data root', async t => {
  const { client, state, instance } = await fixture(t);
  const nativeHome = path.resolve('native-discovered-home');
  const receiptRoot = await mkdtemp(path.join(tmpdir(), 'dsh-install-root-'));
  t.after(() => rm(receiptRoot, { recursive: true, force: true }));
  client.connectionIdentity = async () => ({ baseUrl: instance.baseUrl, pid: instance.pid, dataRoot: nativeHome });
  const control = createControl({ workspace: nativeHome, dataRoot: path.resolve('wrong-default-home'),
    stateDirectory: path.join(receiptRoot, 'state') }, {
    client, installHost: async config => { assert.equal(config.dataRoot, nativeHome); state.installed++; },
  });
  const identity = await client.connectionIdentity();
  assert.equal(identity.dataRoot, nativeHome);
  const result = await control.connect({ requestId: 'native-root' });
  assert.equal(result.ready, true);
  assert.equal(state.installed, 1);
});
