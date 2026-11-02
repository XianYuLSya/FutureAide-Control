import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCliAgents } from '../src/cli-agents.mjs';

const PROFILE = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'D:\\Work\\project';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function tempRoot(prefix) {
  await mkdir(path.join(ROOT, 'clean'), { recursive: true });
  return mkdtemp(path.join(ROOT, 'clean', prefix));
}

function caller(ownerId, threadId = `thread-${ownerId}`) {
  return { _resolved: true, ownerId, threadId, workspace: WORKSPACE, client: 'codex-desktop', profileId: PROFILE };
}

function hostContext() {
  return {
    _resolved: true, ownerId: 'dispatcher-owner', threadId: 'dispatcher-session',
    sessionId: 'dispatcher-session', workspace: WORKSPACE, client: 'claude-code', profileId: PROFILE,
    hostPid: 43068, hostStarted: '2026-11-02T09:00:00.0000000Z',
  };
}

function makeService(stateDirectory) {
  return createCliAgents({ stateDirectory, operationWaitMs: 20, configFile: path.join(stateDirectory, 'config.json') }, {
    resolveContext: extra => extra?._resolved === true ? extra : caller('unknown'),
    resolveEnvironment: async () => { throw Object.assign(new Error('desktop required'), { code: 'claude-desktop-required' }); },
    adapterFor: () => ({ id: 'desktop-fake' }),
    nativeSessionRoot: async () => stateDirectory,
    notify: async () => ({ state: 'delivered' }),
    startWorker: async () => { throw new Error('desktop tests must not start a CLI worker'); },
  });
}

test('two service instances share one roster/inbox and pending receive does not hold send locks', async () => {
  const stateDirectory = await tempRoot('desktop-two-services-');
  await writeFile(path.join(stateDirectory, 'local_c.json'), JSON.stringify({ sessionId: 'local-c', cliSessionId: 'native-two-service', cwd: WORKSPACE }));
  const sender = makeService(stateDirectory);
  const hostService = makeService(stateDirectory);
  const owner = caller('owner-a');
  const host = hostContext();
  try {
    await sender.create({ name: 'worker', lifetime: 'persistent', runtime: 'claude' }, owner);
    await hostService.registerDesktopHost(host, { nativeSessionId: 'dispatcher-session' });

    const pending = hostService.receiveDesktopRequest(host, { timeoutMs: 800 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const began = Date.now();
    const sent = await sender.send({ name: 'worker', message: 'two-service task' }, owner);
    assert.equal(sent.queued, true);
    assert.ok(Date.now() - began < 500, 'send must not wait for the host_receive operation lock');

    const received = await pending;
    assert.equal(received.delivery, 'received');
    assert.equal(received.requestId, sent.requestId);
    assert.equal(received.accepted, false);

    const attached = await hostService.attachDesktopRequest({
      _resolved: true, ownerId: 'native-child', client: 'claude-code', sessionId: 'native-two-service', threadId: 'native-two-service',
      workspace: WORKSPACE, profileId: PROFILE, hostPid: 43068, hostStarted: '2026-11-02T09:00:00.0000000Z',
    }, received.bindingTicket);
    assert.equal(attached.attached, true);
    const acked = await hostService.ackDesktopRequest(host, {
      requestId: received.requestId, deliveryReceipt: received.deliveryReceipt,
      status: 'accepted', nativeHandle: 'local-c',
    });
    assert.equal(acked.accepted, true);
    const childContext = await hostService.resolveDesktopContext({
      _resolved: true, client: 'claude-code', sessionId: 'dispatcher-session', threadId: 'dispatcher-session',
      workspace: WORKSPACE, profileId: PROFILE, hostPid: 43068, hostStarted: '2026-11-02T09:00:00.0000000Z',
      agentContext: received.bindingTicket,
    });
    assert.equal(childContext.agentId, sender.store.named('owner-a', 'worker').agentId);
    const report = await hostService.report({ message: 'two-service complete', final: true }, childContext);
    assert.equal(report.accepted, true);
    const waited = await sender.wait({ names: ['worker'], timeoutSeconds: 0 }, owner);
    assert.equal(waited.reports.length, 1);
    assert.equal(waited.reports[0].message, 'two-service complete');
  } finally {
    sender.close();
    hostService.close();
  }
});
