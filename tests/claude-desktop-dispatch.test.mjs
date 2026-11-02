import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

function desktopService(stateDirectory, runtime = 'claude') {
  const store = new RosterStore(':memory:');
  return createCliAgents({
    stateDirectory, operationWaitMs: 20, configFile: path.join(stateDirectory, 'config.json'),
  }, {
    store,
    resolveContext: extra => extra?._resolved === true ? extra : caller('unknown'),
    resolveEnvironment: async () => {
      throw Object.assign(new Error('desktop required'), { code: `${runtime}-desktop-required` });
    },
    adapterFor: () => ({ id: 'desktop-fake' }),
    nativeSessionRoot: async () => stateDirectory,
    notify: async () => ({ state: 'delivered' }),
    startWorker: async () => { throw new Error('desktop tests must not start a CLI worker'); },
  });
}

function codexHostContext() {
  return {
    ...hostContext(), ownerId: 'codex-dispatcher-owner', threadId: 'codex-dispatcher-session',
    sessionId: 'codex-dispatcher-session', client: 'codex-desktop', hostId: 'local-codex',
  };
}

test('in-memory dispatcher covers cross-owner same-name task and Q&A round trip', async () => {
  const stateDirectory = await tempRoot('desktop-dispatch-');
  await writeFile(path.join(stateDirectory, 'local_a.json'), JSON.stringify({ sessionId: 'local-a', cliSessionId: 'native-a', cwd: WORKSPACE }));
  await writeFile(path.join(stateDirectory, 'local_b.json'), JSON.stringify({ sessionId: 'local-b', cliSessionId: 'native-b', cwd: WORKSPACE }));
  const store = new RosterStore(':memory:');
  const service = createCliAgents({
    stateDirectory, operationWaitMs: 20, configFile: path.join(stateDirectory, 'config.json'),
  }, {
    store,
    resolveContext: extra => extra?._resolved === true ? extra : caller('unknown'),
    resolveEnvironment: async () => { throw Object.assign(new Error('desktop required'), { code: 'claude-desktop-required' }); },
    adapterFor: () => ({ id: 'desktop-fake' }),
    nativeSessionRoot: async () => stateDirectory,
    notify: async () => ({ state: 'delivered' }),
    startWorker: async () => { throw new Error('desktop tests must not start a CLI worker'); },
  });

  const host = hostContext();
  const ownerA = caller('owner-a');
  const ownerB = caller('owner-b');
  const createdA = await service.create({ name: 'worker', lifetime: 'persistent', runtime: 'claude' }, ownerA);
  const createdB = await service.create({ name: 'worker', lifetime: 'persistent', runtime: 'claude' }, ownerB);
  assert.equal(createdA.created, true);
  assert.equal(createdB.created, true);
  assert.notEqual(service.store.named('owner-a', 'worker').agentId, service.store.named('owner-b', 'worker').agentId);

  await service.registerDesktopHost(host, { nativeSessionId: 'dispatcher-session' });
  assert.equal((await service.desktopHostStatus(host)).ready, true);
  await assert.rejects(
    service.receiveDesktopRequest({ ...host, sessionId: 'other-dispatcher-session' }, { timeoutMs: 0 }),
    error => error.code === 'desktop-host-binding-mismatch',
  );
  const sentA = await service.send({ name: 'worker', message: 'A task' }, ownerA);
  assert.deepEqual({ queued: sentA.queued, accepted: sentA.accepted }, { queued: true, accepted: false });
  assert.match(sentA.taskId, /^task-/);
  assert.match(sentA.deliveryReceipt, /^rcpt_/);

  const receivedA = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
  assert.equal(receivedA.delivery, 'received');
  assert.equal(receivedA.accepted, false);
  const childA = { _resolved: true, ownerId: 'child-a', client: 'claude-code', sessionId: 'native-a', threadId: 'native-a', workspace: WORKSPACE, profileId: PROFILE, hostPid: 43068, hostStarted: '2026-11-02T09:00:00.0000000Z' };
  const attachedA = await service.attachDesktopRequest(childA, receivedA.bindingTicket);
  assert.equal(attachedA.attached, true);
  const ackedA = await service.ackDesktopRequest(host, {
    requestId: receivedA.requestId, deliveryReceipt: receivedA.deliveryReceipt,
    status: 'accepted', nativeHandle: 'local-a', nativeAgentId: 'a55840d3c26ec820a',
  });
  assert.equal(ackedA.accepted, true);
  assert.equal(service.store.named('owner-a', 'worker').desktopNativeAgentId, 'a55840d3c26ec820a');
  const childContextA = await service.resolveDesktopContext({ ...host, agentContext: receivedA.bindingTicket });
  assert.equal(childContextA.agentId, service.store.named('owner-a', 'worker').agentId);

  const question = await service.ask({ message: 'Need a decision' }, childContextA);
  assert.equal(question.waiting, true);
  const waitQuestion = await service.wait({ names: ['worker'], timeoutSeconds: 0 }, ownerA);
  assert.equal(waitQuestion.questions.length, 1);
  const answered = await service.answer({ name: 'worker', message: 'Proceed' }, ownerA);
  assert.equal(answered.queued, true);
  const receivedAnswer = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
  assert.equal(receivedAnswer.kind, 'answer');
  const attachedAnswer = await service.attachDesktopRequest(childA, receivedAnswer.bindingTicket);
  assert.equal(attachedAnswer.attached, true);
  const ackedAnswer = await service.ackDesktopRequest(host, {
    requestId: receivedAnswer.requestId, deliveryReceipt: receivedAnswer.deliveryReceipt,
    status: 'accepted', nativeHandle: 'local-a', nativeAgentId: 'a55840d3c26ec820a',
  });
  assert.equal(ackedAnswer.accepted, true);

  const report = await service.report({ message: 'A complete', final: true }, childContextA);
  assert.equal(report.accepted, true);
  const waitA = await service.wait({ names: ['worker'], timeoutSeconds: 0 }, ownerA);
  assert.equal(waitA.reports.length, 1);
  assert.equal(waitA.reports[0].name, 'worker');
  assert.equal(waitA.reports[0].final, true);

  const sentB = await service.send({ name: 'worker', message: 'B task' }, ownerB);
  assert.equal(sentB.queued, true);
  assert.equal(sentB.accepted, false);
  const receivedB = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
  assert.equal(receivedB.requestId, sentB.requestId);
  assert.equal(receivedB.message, 'B task');
  const childB = { _resolved: true, ownerId: 'child-b', client: 'claude-code', sessionId: 'native-b', threadId: 'native-b', workspace: WORKSPACE, profileId: PROFILE, hostPid: 43068, hostStarted: '2026-11-02T09:00:00.0000000Z' };
  const attachedB = await service.attachDesktopRequest(childB, receivedB.bindingTicket);
  assert.equal(attachedB.attached, true);
  const ackedB = await service.ackDesktopRequest(host, {
    requestId: receivedB.requestId, deliveryReceipt: receivedB.deliveryReceipt,
    status: 'accepted', nativeHandle: 'local-b', nativeAgentId: 'b55840d3c26ec820b',
  });
  assert.equal(ackedB.accepted, true);
  const childContextB = await service.resolveDesktopContext({ ...host, agentContext: receivedB.bindingTicket });
  const reportB = await service.report({ message: 'B complete', final: true }, childContextB);
  assert.equal(reportB.accepted, true);
  const waitB = await service.wait({ names: ['worker'], timeoutSeconds: 0 }, ownerB);
  assert.equal(waitB.reports.length, 1);
  assert.equal(waitB.reports[0].message, 'B complete');

  const sentA2 = await service.send({ name: 'worker', message: 'A task two' }, ownerA);
  assert.equal(sentA2.queued, true);
  assert.equal(sentA2.accepted, false);
  const receivedA2 = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
  assert.equal(receivedA2.requestId, sentA2.requestId);
  assert.equal(receivedA2.message, 'A task two');

  service.close();
});

test('a new native session on the same host refreshes the dispatcher binding', async () => {
  const stateDirectory = await tempRoot('desktop-rebind-session-');
  const service = desktopService(stateDirectory);
  const first = hostContext();
  await service.registerDesktopHost(first, { nativeSessionId: first.sessionId });

  const next = { ...first, sessionId: 'dispatcher-session-2', threadId: 'dispatcher-session-2' };
  assert.equal((await service.desktopHostStatus(next)).ready, true);
  await service.registerDesktopHost(next, { nativeSessionId: next.sessionId });
  assert.equal((await service.desktopHostStatus(next)).ready, true);
  assert.equal((await service.desktopHostStatus(first)).ready, true);
  assert.equal((await service.receiveDesktopRequest(next, { timeoutMs: 0 })).delivery, 'none');
  await assert.rejects(
    service.receiveDesktopRequest(first, { timeoutMs: 0 }),
    error => error.code === 'desktop-host-binding-mismatch',
  );
  service.close();
});

test('a restarted host process can replace the prior dispatcher binding', async () => {
  const stateDirectory = await tempRoot('desktop-rebind-process-');
  const service = desktopService(stateDirectory);
  const first = hostContext();
  await service.registerDesktopHost(first, { nativeSessionId: first.sessionId });

  const restarted = {
    ...first, sessionId: 'dispatcher-restarted', threadId: 'dispatcher-restarted',
    hostPid: 43069, hostStarted: '2026-11-02T09:05:00.0000000Z',
  };
  assert.equal((await service.desktopHostStatus(restarted)).ready, true);
  await assert.rejects(
    service.registerDesktopHost(restarted, { nativeSessionId: restarted.sessionId }),
    error => error.code === 'desktop-host-binding-mismatch',
  );
  await service.registerDesktopHost(restarted, { nativeSessionId: restarted.sessionId, replace: true });

  assert.equal((await service.desktopHostStatus(restarted)).ready, true);
  assert.equal((await service.desktopHostStatus(first)).ready, true);
  assert.equal((await service.receiveDesktopRequest(restarted, { timeoutMs: 0 })).delivery, 'none');
  await assert.rejects(
    service.receiveDesktopRequest(first, { timeoutMs: 0 }),
    error => error.code === 'desktop-host-binding-mismatch',
  );
  service.close();
});

test('status rejects a registered binding with a stale heartbeat', async () => {
  const stateDirectory = await tempRoot('desktop-stale-binding-');
  const service = desktopService(stateDirectory);
  const host = hostContext();
  await service.registerDesktopHost(host, { nativeSessionId: host.sessionId });
  const key = desktopHostKey({ targetRuntime: 'claude', targetClient: 'claude-code', profileId: PROFILE, workspace: WORKSPACE });
  const saved = service.store.desktopHost(key);
  service.store.registerDesktopHost({ ...saved, lastSeenAt: '2000-01-01T00:00:00.000Z' }, { replace: true });
  assert.equal((await service.desktopHostStatus(host)).ready, false);
  service.close();
});

test('cross-runtime status and same-runtime callers share the target dispatcher', async () => {
  const claudeState = await tempRoot('desktop-cross-runtime-claude-');
  const claudeService = desktopService(claudeState, 'claude');
  const claudeHost = hostContext();
  await claudeService.registerDesktopHost(claudeHost, { nativeSessionId: claudeHost.sessionId });

  const codexObserver = caller('codex-observer', 'codex-observer-thread');
  assert.equal((await claudeService.desktopHostStatus(codexObserver, {
    targetRuntime: 'claude', targetClient: 'claude-code',
  })).ready, true);

  const codexState = await tempRoot('desktop-cross-runtime-codex-');
  const codexService = desktopService(codexState, 'codex');
  const codexHost = codexHostContext();
  await codexService.registerDesktopHost(codexHost, { nativeSessionId: codexHost.sessionId });

  const claudeObserver = {
    ...caller('claude-observer', 'claude-observer-thread'),
    client: 'claude-code', sessionId: 'claude-observer-thread',
  };
  assert.equal((await codexService.desktopHostStatus(claudeObserver, {
    targetRuntime: 'codex', targetClient: 'codex-desktop',
  })).ready, true);

  const codexA = caller('codex-a', 'codex-a-thread');
  const codexB = caller('codex-b', 'codex-b-thread');
  assert.equal((await codexService.desktopHostStatus(codexA)).ready, true);
  assert.equal((await codexService.desktopHostStatus(codexB)).ready, true);
  await codexService.create({ name: 'worker', lifetime: 'persistent', runtime: 'codex' }, codexA);
  await codexService.create({ name: 'worker', lifetime: 'persistent', runtime: 'codex' }, codexB);
  assert.notEqual(codexService.store.named('codex-a', 'worker').agentId,
    codexService.store.named('codex-b', 'worker').agentId);
  assert.equal(codexService.store.list('codex-a').length, 1);
  assert.equal(codexService.store.list('codex-b').length, 1);

  claudeService.close();
  codexService.close();
});

test('another caller can use a registered dispatcher without becoming it', async () => {
  const stateDirectory = await tempRoot('desktop-cross-caller-');
  const service = desktopService(stateDirectory);
  const host = hostContext();
  await service.registerDesktopHost(host, { nativeSessionId: host.sessionId });

  const codexCaller = caller('codex-owner', 'codex-thread');
  const status = await service.desktopHostStatus(codexCaller, {
    targetRuntime: 'claude', targetClient: 'claude-code',
  });
  assert.equal(status.ready, true);
  const created = await service.create({ name: 'relay', lifetime: 'persistent', runtime: 'claude' }, codexCaller);
  assert.equal(created.created, true);
  await assert.rejects(
    service.receiveDesktopRequest(codexCaller, { timeoutMs: 0, targetRuntime: 'claude', targetClient: 'claude-code' }),
    error => error.code === 'desktop-host-context-required',
  );
  service.close();
});

test('a managed child context cannot register or replace the dispatcher', async () => {
  const stateDirectory = await tempRoot('desktop-child-register-');
  const service = desktopService(stateDirectory);
  const host = hostContext();
  await service.registerDesktopHost(host, { nativeSessionId: host.sessionId });
  const child = { ...host, sessionId: 'child-session', threadId: 'child-session', agentContext: 'ticket_child' };
  await assert.rejects(
    service.registerDesktopHost(child, { nativeSessionId: child.sessionId, replace: true }),
    error => error.code === 'desktop-host-context-required',
  );
  assert.equal((await service.desktopHostStatus(host)).ready, true);
  service.close();
});

test('a Codex managed child context cannot register or replace the dispatcher', async () => {
  const stateDirectory = await tempRoot('desktop-codex-child-register-');
  const service = desktopService(stateDirectory, 'codex');
  const host = codexHostContext();
  await service.registerDesktopHost(host, { nativeSessionId: host.sessionId });
  const child = {
    ...host, sessionId: 'codex-child-session', threadId: 'codex-child-session',
    parentAgentId: 'agent-00000000000000000000000000000000', reportContext: {},
  };
  await assert.rejects(
    service.registerDesktopHost(child, { nativeSessionId: child.sessionId, replace: true }),
    error => error.code === 'desktop-host-context-required',
  );
  assert.equal((await service.desktopHostStatus(host)).ready, true);
  service.close();
});
