import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCliAgents } from '../src/cli-agents.mjs';
import { desktopHostKey } from '../src/claude-desktop-protocol.mjs';
import { RosterStore } from '../src/roster-store.mjs';

const PROFILE = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'D:\\Work\\project';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function tempRoot(prefix) {
  await mkdir(path.join(ROOT, 'clean'), { recursive: true });
  return mkdtemp(path.join(ROOT, 'clean', prefix));
}

function caller(ownerId) {
  return { _resolved: true, ownerId, threadId: `thread-${ownerId}`, workspace: WORKSPACE, client: 'codex-desktop', profileId: PROFILE };
}

function hostContext(overrides = {}) {
  return {
    _resolved: true, ownerId: 'dispatcher-owner', threadId: 'dispatcher-session',
    sessionId: 'dispatcher-session', hostId: 'local', workspace: WORKSPACE,
    client: 'codex-desktop', profileId: PROFILE, ...overrides,
  };
}

function makeService(stateDirectory) {
  const store = new RosterStore(':memory:');
  const service = createCliAgents({
    stateDirectory, operationWaitMs: 20, configFile: path.join(stateDirectory, 'config.json'),
  }, {
    store,
    resolveContext: extra => extra?._resolved === true ? extra : caller('unknown'),
    resolveEnvironment: async () => { throw Object.assign(new Error('desktop required'), { code: 'codex-desktop-required' }); },
    adapterFor: () => ({ id: 'desktop-fake' }),
    nativeSessionRoot: async () => stateDirectory,
    wakeCodexDispatcher: async () => ({ isError: false }),
    notify: async () => ({ state: 'delivered' }),
    startWorker: async () => { throw new Error('desktop tests must not start a CLI worker'); },
  });
  return { service, store };
}

async function acceptedAgent(service, host, owner) {
  await service.create({ name: 'worker', lifetime: 'persistent', runtime: 'codex' }, owner);
  await service.registerDesktopHost(host, { nativeSessionId: host.sessionId });
  const sent = await service.send({ name: 'worker', message: 'first task' }, owner);
  const received = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
  await service.resolveDesktopContext({
    client: 'codex-desktop', sessionId: 'native-codex-1', threadId: 'native-codex-1',
    parentThreadId: host.threadId, hostId: host.hostId, workspace: WORKSPACE, profileId: PROFILE,
    agentContext: received.bindingTicket,
  });
  await service.ackDesktopRequest(host, {
    requestId: received.requestId, deliveryReceipt: received.deliveryReceipt,
    status: 'accepted', nativeHandle: 'native-codex-1',
  });
  return sent;
}

const hostKey = () => desktopHostKey({ targetRuntime: 'codex', targetClient: 'codex-desktop', profileId: PROFILE, workspace: WORKSPACE });

test('a persistent Codex handle survives a stale host heartbeat', async () => {
  const stateDirectory = await tempRoot('desktop-native-resume-stale-');
  const { service, store } = makeService(stateDirectory);
  const owner = caller('codex-owner');
  const host = hostContext();
  try {
    await acceptedAgent(service, host, owner);
    const saved = store.desktopHost(hostKey());
    store.registerDesktopHost({ ...saved, lastSeenAt: '2000-01-01T00:00:00.000Z' }, { replace: true });

    await service.send({ name: 'worker', message: 'second task' }, owner);
    const resumed = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
    assert.equal(resumed.nativeHandle, 'native-codex-1');
  } finally { service.close(); }
});

test('a changed Codex host binding rejects native resume without mutating the task', async () => {
  const stateDirectory = await tempRoot('desktop-native-resume-changed-');
  const { service, store } = makeService(stateDirectory);
  const owner = caller('codex-owner');
  const host = hostContext();
  try {
    await acceptedAgent(service, host, owner);
    const before = store.named(owner.ownerId, 'worker');
    const taskId = before.task.taskId;
    const dispatchCount = before.task.dispatches.length;
    const handle = before.desktopNativeHandle;

    const changed = hostContext({ threadId: 'dispatcher-session-2', hostId: 'local-2' });
    await service.registerDesktopHost(changed, { nativeSessionId: changed.sessionId, replace: true });
    await assert.rejects(
      service.send({ name: 'worker', message: 'must not respawn' }, owner),
      error => error.code === 'desktop-native-resume-host-changed',
    );

    const after = store.named(owner.ownerId, 'worker');
    assert.equal(after.task.taskId, taskId);
    assert.equal(after.task.dispatches.length, dispatchCount);
    assert.equal(after.desktopNativeHandle, handle);
  } finally { service.close(); }
});
