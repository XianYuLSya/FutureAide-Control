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
const THREAD = '11111111-1111-4111-8111-111111111112';

async function tempRoot(prefix) {
  await mkdir(path.join(ROOT, 'clean'), { recursive: true });
  return mkdtemp(path.join(ROOT, 'clean', prefix));
}

function caller(ownerId, threadId = `thread-${ownerId}`) {
  return { _resolved: true, ownerId, threadId, workspace: WORKSPACE, client: 'codex-desktop', profileId: PROFILE };
}

function codexHost(threadId = THREAD) {
  return {
    _resolved: true, ownerId: 'codex-dispatcher-owner', threadId, sessionId: threadId,
    workspace: WORKSPACE, client: 'codex-desktop', profileId: PROFILE, hostId: 'local-codex',
  };
}

function serviceWithProbe(stateDirectory, codexThreadAlive) {
  const store = new RosterStore(':memory:');
  return createCliAgents({
    stateDirectory, operationWaitMs: 20, configFile: path.join(stateDirectory, 'config.json'),
  }, {
    store,
    resolveContext: extra => extra?._resolved === true ? extra : caller('unknown'),
    resolveEnvironment: async () => { throw Object.assign(new Error('desktop required'), { code: 'codex-desktop-required' }); },
    adapterFor: () => ({ id: 'desktop-fake' }),
    nativeSessionRoot: async () => stateDirectory,
    notify: async () => ({ state: 'delivered' }),
    startWorker: async () => { throw new Error('desktop tests must not start a CLI worker'); },
    codexThreadAlive,
  });
}

test('an idle Codex dispatcher status probes only its bound native thread', async () => {
  const stateDirectory = await tempRoot('desktop-idle-codex-');
  const probes = [];
  const service = serviceWithProbe(stateDirectory, async host => {
    probes.push(host.nativeThreadId);
    return true;
  });
  const host = codexHost();
  await service.registerDesktopHost(host, { nativeSessionId: host.sessionId });
  const hostKey = desktopHostKey({ targetRuntime: 'codex', targetClient: 'codex-desktop', profileId: PROFILE, workspace: WORKSPACE });
  const saved = service.store.desktopHost(hostKey);
  service.store.registerDesktopHost({ ...saved, lastSeenAt: '2000-01-01T00:00:00.000Z' }, { replace: true });

  const status = await service.desktopHostStatus(caller('codex-idle', 'codex-idle-thread'), {
    targetRuntime: 'codex', targetClient: 'codex-desktop',
  });
  assert.equal(status.ready, true);
  assert.deepEqual(probes, [THREAD]);
  assert.notEqual(service.store.desktopHost(hostKey).lastSeenAt, '2000-01-01T00:00:00.000Z');
  service.close();
});

test('an idle Codex dispatcher with an unreachable thread is not ready', async () => {
  const stateDirectory = await tempRoot('desktop-idle-codex-down-');
  const probes = [];
  const service = serviceWithProbe(stateDirectory, async host => {
    probes.push(host.nativeThreadId);
    return false;
  });
  const host = codexHost();
  await service.registerDesktopHost(host, { nativeSessionId: host.sessionId });
  const hostKey = desktopHostKey({ targetRuntime: 'codex', targetClient: 'codex-desktop', profileId: PROFILE, workspace: WORKSPACE });
  const saved = service.store.desktopHost(hostKey);
  service.store.registerDesktopHost({ ...saved, lastSeenAt: '2000-01-01T00:00:00.000Z' }, { replace: true });

  const status = await service.desktopHostStatus(caller('codex-idle-down', 'codex-idle-down-thread'), {
    targetRuntime: 'codex', targetClient: 'codex-desktop',
  });
  assert.equal(status.ready, false);
  assert.deepEqual(probes, [THREAD]);
  service.close();
});
