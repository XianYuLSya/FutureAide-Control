import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCliAgents } from '../src/cli-agents.mjs';
import { resolveCallingContext, ownerIdFor } from '../src/calling-context.mjs';

const PROFILE = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'D:\\Work\\project';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function tempRoot(prefix) {
  await mkdir(path.join(ROOT, 'clean'), { recursive: true });
  return mkdtemp(path.join(ROOT, 'clean', prefix));
}

function caller(ownerId) {
  return { _resolved: true, ownerId, threadId: `thread-${ownerId}`, workspace: WORKSPACE, client: 'claude-code', profileId: PROFILE };
}

function hostContext() {
  return {
    _resolved: true, ownerId: 'codex-dispatcher-owner', threadId: 'codex-dispatcher-session',
    sessionId: 'codex-dispatcher-session', hostId: 'local', workspace: WORKSPACE, client: 'codex-desktop', profileId: PROFILE,
    hostPid: 43068, hostStarted: '2026-11-02T09:00:00.0000000Z',
  };
}

test('Codex child identity comes from the trusted turn metadata and read_thread hostId', async () => {
  const child = '01a19bc8-3361-7130-9403-a1de316db013';
  const parent = '01a1981c-b850-7f63-870d-fb7e0388db36';
  const resolved = await resolveCallingContext({
    _meta: { threadId: child, 'x-codex-turn-metadata': { thread_id: child, parent_thread_id: parent } },
  }, {
    callCodex: async () => ({ content: [{ type: 'text', text: JSON.stringify({ thread: { id: child, kind: 'codex', hostId: 'local', cwd: ROOT } }) }] }),
  });
  assert.equal(resolved.threadId, child);
  assert.equal(resolved.parentThreadId, parent);
  assert.equal(resolved.hostId, 'local');
  assert.equal(resolved.workspace, ROOT);
});

test('native Codex target uses the same roster for receive, ack and report', async () => {
  let wakes = 0;
  const stateDirectory = await tempRoot('codex-native-dispatch-');
  const service = createCliAgents({ stateDirectory, operationWaitMs: 20, configFile: path.join(stateDirectory, 'config.json') }, {
    resolveContext: extra => extra?._resolved === true ? extra : caller('unknown'),
    resolveEnvironment: async ({ runtime }) => {
      throw Object.assign(new Error('desktop required'), { code: runtime === 'codex' ? 'codex-desktop-required' : 'claude-desktop-required' });
    },
    adapterFor: () => ({ id: 'desktop-fake' }),
    wakeCodexDispatcher: async () => { wakes += 1; return { isError: false }; },
    notify: async () => ({ state: 'delivered' }),
    startWorker: async () => { throw new Error('desktop tests must not start a CLI worker'); },
  });
  const owner = caller('codex-owner');
  const host = hostContext();
  try {
    await assert.rejects(service.create({ name: 'codex-once', lifetime: 'once', runtime: 'codex' }, owner), error => error.code === 'desktop-once-cleanup-unsupported');
    const created = await service.create({ name: 'codex-worker', lifetime: 'persistent', runtime: 'codex' }, owner);
    assert.equal(created.transport, 'desktop-native');
    await service.registerDesktopHost(host, { nativeSessionId: 'codex-dispatcher-session' });
    const sent = await service.send({ name: 'codex-worker', message: 'Codex task' }, owner);
    assert.deepEqual({ queued: sent.queued, accepted: sent.accepted }, { queued: true, accepted: false });
    assert.equal(wakes, 1);
    const received = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
    assert.equal(received.delivery, 'received');
    assert.equal(received.accepted, false);
    const attached = await service.resolveDesktopContext({
      client: 'codex-desktop', sessionId: 'native-codex-1', threadId: 'native-codex-1',
      parentThreadId: 'codex-dispatcher-session', hostId: 'local', workspace: WORKSPACE, profileId: PROFILE,
      agentContext: received.bindingTicket,
    });
    assert.equal(attached.agentId, service.store.named('codex-owner', 'codex-worker').agentId);
    const acked = await service.ackDesktopRequest(host, {
      requestId: received.requestId, deliveryReceipt: received.deliveryReceipt,
      status: 'accepted', nativeHandle: 'native-codex-1',
    });
    assert.equal(acked.accepted, true);
    const native = await service.resolveDesktopContext({
      client: 'codex-desktop', sessionId: 'native-codex-1', parentThreadId: 'codex-dispatcher-session',
      hostId: 'local', workspace: WORKSPACE, profileId: PROFILE,
    });
    assert.equal(native.parentAgentId, service.store.named('codex-owner', 'codex-worker').agentId);
    assert.equal(native.ownerId, ownerIdFor('native-codex-1'));
    assert.equal(native.reportContext.ownerId, 'codex-owner');
    const report = await service.report({ message: 'Codex done', final: true }, native);
    assert.equal(report.accepted, true);
    const waited = await service.wait({ names: ['codex-worker'], timeoutSeconds: 0 }, owner);
    assert.equal(waited.reports.length, 1);
    assert.equal(waited.reports[0].message, 'Codex done');
    await service.send({ name: 'codex-worker', message: 'resume task' }, owner);
    const resumed = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
    assert.equal(resumed.nativeHandle, 'native-codex-1');
  } finally { service.close(); }
});
