import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCliAgents } from '../src/cli-agents.mjs';
import { notifyParent } from '../src/mutual-notify.mjs';
import { desktopHostKey } from '../src/claude-desktop-protocol.mjs';

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

function dispatcher() {
  return {
    _resolved: true, ownerId: 'dispatcher-owner', threadId: 'dispatcher-session', sessionId: 'dispatcher-session',
    workspace: WORKSPACE, client: 'codex-desktop', profileId: PROFILE, hostId: 'local',
  };
}

test('Codex manager receives a Claude subordinate report through the Codex dispatcher', async () => {
  const stateDirectory = await tempRoot('cross-codex-manager-');
  const wakes = [];
  const service = createCliAgents({ stateDirectory, operationWaitMs: 20, configFile: path.join(stateDirectory, 'config.json') }, {
    resolveContext: extra => extra,
    resolveEnvironment: async () => { throw Object.assign(new Error('desktop required'), { code: 'claude-desktop-required' }); },
    adapterFor: () => ({ id: 'desktop-fake' }),
    wakeCodexDispatcher: async (host, request) => { wakes.push({ host, request }); return { isError: false }; },
    startWorker: async () => { throw new Error('desktop tests must not start a CLI worker'); },
  });
  const managerId = 'agent-cross-codex-manager';
  const host = dispatcher();
  try {
    service.store.insert({
      agentId: managerId, ownerId: 'root-owner', name: 'codex-manager', runtime: 'codex', lifetime: 'persistent',
      workspace: WORKSPACE, state: 'running', desktopMode: 'native', desktopProfileId: PROFILE,
      desktopNativeHandle: 'manager-codex-operation-handle', desktopSessionId: 'manager-thread',
      desktopParentThreadId: 'dispatcher-session',
      owner: { ownerId: 'root-owner', threadId: 'root-thread', workspace: WORKSPACE, client: 'codex-desktop', profileId: PROFILE },
      task: { taskId: 'task-manager-codex', state: 'running', reports: [], questions: [], dispatches: [] },
    });
    const managerCtx = {
      _resolved: true, ownerId: 'manager-owner', threadId: 'manager-thread', workspace: WORKSPACE,
      client: 'claude-code', profileId: PROFILE, parentAgentId: managerId, parentTaskId: 'task-manager-codex',
    };
    await service.create({ name: 'claude-child', lifetime: 'persistent', runtime: 'claude' }, managerCtx);
    await service.send({ name: 'claude-child', message: 'Claude task' }, managerCtx);
    const child = service.store.named('manager-owner', 'claude-child');
    await service.registerDesktopHost(host, { nativeSessionId: 'dispatcher-session' });
    const report = await service.report({ message: 'Claude reports to Codex manager', final: true }, {
      _resolved: true, ownerId: 'manager-owner', threadId: 'manager-thread', workspace: WORKSPACE,
      client: 'claude-code', profileId: PROFILE,
      reportContext: { ownerId: 'manager-owner', threadId: 'manager-thread', parentAgentId: child.agentId,
        parentTaskId: child.task.taskId, workspace: WORKSPACE, client: 'claude-code', profileId: PROFILE },
    });
    assert.equal(report.delivery, 'dispatcher-pending');
    assert.equal(service.store.get(child.agentId).state, 'delivery_pending');
    assert.equal(service.store.get(child.agentId).task.reports[0].delivery.managerNativeHandle, 'manager-codex-operation-handle');
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].host.nativeThreadId, 'dispatcher-session');

    const notification = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
    assert.equal(notification.kind, 'report');
    assert.equal(notification.notification_id, service.store.get(child.agentId).task.reports[0].id);
    assert.equal(notification.manager_native_handle, 'manager-codex-operation-handle');
    assert.equal(notification.agent_name, 'claude-child');
    await service.deliveryAck(host, { notificationId: notification.notification_id, status: 'delivered' });
    assert.equal(service.store.get(child.agentId).task.reports[0].delivery.state, 'delivered');
    assert.equal(service.store.get(child.agentId).state, 'idle');
    assert.equal(service.store.get(child.agentId).task.state, 'completed');
  } finally {
    service.close();
  }
});

test('Claude manager receives a Codex subordinate report through the Claude dispatcher', async () => {
  const stateDirectory = await tempRoot('cross-claude-manager-');
  const wakes = [];
  const service = createCliAgents({ stateDirectory, operationWaitMs: 20, configFile: path.join(stateDirectory, 'config.json') }, {
    resolveContext: extra => extra,
    resolveEnvironment: async () => { throw Object.assign(new Error('desktop required'), { code: 'codex-desktop-required' }); },
    adapterFor: () => ({ id: 'desktop-fake' }),
    wakeCodexDispatcher: async (host, request) => { wakes.push({ host, request }); return { isError: false }; },
    startWorker: async () => { throw new Error('desktop tests must not start a CLI worker'); },
  });
  const managerId = 'agent-cross-claude-manager';
  const host = {
    _resolved: true, ownerId: 'claude-dispatcher-owner', threadId: 'claude-dispatcher-session', sessionId: 'claude-dispatcher-session',
    workspace: WORKSPACE, client: 'claude-code', profileId: PROFILE, hostPid: 43068, hostStarted: '2026-11-02T09:00:00.0000000Z',
  };
  try {
    service.store.insert({
      agentId: managerId, ownerId: 'root-owner', name: 'claude-manager', runtime: 'claude', lifetime: 'persistent',
      workspace: WORKSPACE, state: 'running', desktopMode: 'native', desktopProfileId: PROFILE,
      desktopNativeHandle: 'manager-claude-operation-handle', desktopSessionId: 'manager-claude-thread',
      owner: { ownerId: 'root-owner', threadId: 'root-thread', workspace: WORKSPACE, client: 'codex-desktop', profileId: PROFILE },
      task: { taskId: 'task-manager-claude', state: 'running', reports: [], questions: [], dispatches: [] },
    });
    const managerCtx = {
      _resolved: true, ownerId: 'manager-owner', threadId: 'manager-claude-thread', workspace: WORKSPACE,
      client: 'codex-desktop', profileId: PROFILE, parentAgentId: managerId, parentTaskId: 'task-manager-claude',
    };
    await service.create({ name: 'codex-child', lifetime: 'persistent', runtime: 'codex' }, managerCtx);
    await service.send({ name: 'codex-child', message: 'Codex task' }, managerCtx);
    const child = service.store.named('manager-owner', 'codex-child');
    await service.registerDesktopHost(host, { nativeSessionId: 'claude-dispatcher-session' });
    const report = await service.report({ message: 'Codex reports to Claude manager', final: true }, {
      _resolved: true, ownerId: 'manager-owner', threadId: 'manager-claude-thread', workspace: WORKSPACE,
      client: 'codex-desktop', profileId: PROFILE,
      reportContext: { ownerId: 'manager-owner', threadId: 'manager-claude-thread', parentAgentId: child.agentId,
        parentTaskId: child.task.taskId, workspace: WORKSPACE, client: 'codex-desktop', profileId: PROFILE },
    });
    assert.equal(report.delivery, 'dispatcher-pending');
    assert.equal(wakes.length, 0, 'Claude dispatcher must not be woken through Codex app-tools');
    const notification = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
    assert.equal(notification.kind, 'report');
    assert.equal(notification.manager_native_handle, 'manager-claude-operation-handle');
    assert.equal(notification.agent_name, 'codex-child');
    await service.deliveryAck(host, { notificationId: notification.notification_id, status: 'delivered' });
    assert.equal(service.store.get(child.agentId).task.reports[0].delivery.state, 'delivered');
  } finally {
    service.close();
  }
});

test('a late accepted host ack does not reopen a completed native task', async () => {
  const stateDirectory = await tempRoot('late-host-ack-');
  const service = createCliAgents({ stateDirectory, operationWaitMs: 20, configFile: path.join(stateDirectory, 'config.json') }, {
    resolveContext: extra => extra,
    resolveEnvironment: async () => { throw Object.assign(new Error('desktop required'), { code: 'codex-desktop-required' }); },
    adapterFor: () => ({ id: 'desktop-fake' }),
    wakeCodexDispatcher: async () => ({ isError: false }),
    startWorker: async () => { throw new Error('desktop tests must not start a CLI worker'); },
  });
  const host = dispatcher();
  const hostKey = desktopHostKey({ targetRuntime: 'codex', targetClient: 'codex-desktop', profileId: PROFILE, workspace: WORKSPACE });
  const agentId = 'agent-late-host-ack';
  const taskId = 'task-late-host-ack';
  const requestId = 'req_late_host_ack';
  try {
    await service.registerDesktopHost(host, { nativeSessionId: 'dispatcher-session' });
    service.store.insert({
      agentId, ownerId: 'late-owner', name: 'late', runtime: 'codex', lifetime: 'persistent',
      workspace: WORKSPACE, state: 'idle', desktopMode: 'native', desktopProfileId: PROFILE,
      desktopNativeHandle: 'late-native-handle',
      owner: { ownerId: 'late-owner', threadId: 'late-thread', workspace: WORKSPACE, client: 'codex-desktop', profileId: PROFILE },
      task: {
        taskId, state: 'completed', finalSubmitted: true,
        reports: [{ id: 'report-late', message: 'done', final: true, delivery: { state: 'delivered' } }],
        questions: [], answers: [],
        dispatches: [{
          requestId, deliveryReceipt: 'rcpt_late_host_ack', bindingTicket: 'ticket_late_host_ack',
          taskId, state: 'received', accepted: false, nativeHandle: null, hostKey, attached: true,
          envelope: { kind: 'task' },
        }],
      },
    });
    const acked = await service.ackDesktopRequest(host, {
      requestId, deliveryReceipt: 'rcpt_late_host_ack', status: 'accepted', nativeHandle: 'late-native-handle',
    });
    assert.equal(acked.accepted, true);
    const record = service.store.get(agentId);
    assert.equal(record.state, 'idle');
    assert.equal(record.task.state, 'completed');

    const awaitingId = 'agent-late-awaiting';
    const awaitingTaskId = 'task-late-awaiting';
    const awaitingRequestId = 'req_late_awaiting';
    service.store.insert({
      agentId: awaitingId, ownerId: 'late-owner', name: 'late-awaiting', runtime: 'codex', lifetime: 'persistent',
      workspace: WORKSPACE, state: 'awaiting_input', desktopMode: 'native', desktopProfileId: PROFILE,
      owner: { ownerId: 'late-owner', threadId: 'late-thread', workspace: WORKSPACE, client: 'codex-desktop', profileId: PROFILE },
      task: {
        taskId: awaitingTaskId, state: 'awaiting_input', finalSubmitted: false,
        reports: [], answers: [],
        questions: [{ id: 'question-late', message: 'answer?', state: 'pending' }],
        dispatches: [{
          requestId: awaitingRequestId, deliveryReceipt: 'rcpt_late_awaiting', bindingTicket: 'ticket_late_awaiting',
          taskId: awaitingTaskId, state: 'received', accepted: false, nativeHandle: null, hostKey, attached: true,
          envelope: { kind: 'task' },
        }],
      },
    });
    await service.ackDesktopRequest(host, {
      requestId: awaitingRequestId, deliveryReceipt: 'rcpt_late_awaiting', status: 'accepted', nativeHandle: 'late-awaiting-handle',
    });
    const awaiting = service.store.get(awaitingId);
    assert.equal(awaiting.state, 'awaiting_input');
    assert.equal(awaiting.task.state, 'awaiting_input');
  } finally {
    service.close();
  }
});

test('ordinary Claude user report stays pending for wait_agents, not host_receive', async () => {
  const stateDirectory = await tempRoot('native-claude-relay-');
  const service = createCliAgents({ stateDirectory, operationWaitMs: 20, configFile: path.join(stateDirectory, 'config.json') }, {
    resolveContext: extra => extra,
    resolveEnvironment: async () => { throw Object.assign(new Error('desktop required'), { code: 'claude-desktop-required' }); },
    adapterFor: () => ({ id: 'desktop-fake' }),
    wakeCodexDispatcher: async () => ({ isError: false }),
    notify: (notice, config) => notifyParent(notice, { ...config, cliStateDirectory: stateDirectory }, { invoke: async () => ({ isError: false }) }),
    startWorker: async () => { throw new Error('desktop tests must not start a CLI worker'); },
  });
  const owner = caller('claude-owner');
  const host = {
    _resolved: true, ownerId: 'claude-dispatcher-owner', threadId: 'claude-dispatcher-session', sessionId: 'claude-dispatcher-session',
    workspace: WORKSPACE, client: 'claude-code', profileId: PROFILE, hostPid: 43068, hostStarted: '2026-11-02T09:00:00.0000000Z',
  };
  try {
    await service.create({ name: 'claude-worker', lifetime: 'persistent', runtime: 'claude' }, owner);
    await service.registerDesktopHost(host, { nativeSessionId: 'claude-dispatcher-session' });
    const sent = await service.send({ name: 'claude-worker', message: 'Claude task' }, owner);
    const received = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
    assert.equal(received.requestId, sent.requestId);
    const child = {
      _resolved: true, ownerId: 'claude-owner', client: 'claude-code', sessionId: 'claude-native-1', threadId: 'claude-native-1',
      workspace: WORKSPACE, profileId: PROFILE, hostPid: 43068, hostStarted: '2026-11-02T09:00:00.0000000Z',
    };
    const attached = await service.attachDesktopRequest(child, received.bindingTicket);
    assert.equal(attached.attached, true);
    const native = await service.resolveDesktopContext({ ...child, agentContext: received.bindingTicket });
    assert.ok(native);
    const acked = await service.ackDesktopRequest(host, {
      requestId: received.requestId, deliveryReceipt: received.deliveryReceipt,
      status: 'accepted', nativeHandle: 'claude-native-1',
    });
    assert.equal(acked.accepted, true);

    const reported = await service.report({ message: 'Claude done', final: true }, native);
    assert.equal(reported.accepted, true);
    const record = service.store.named('claude-owner', 'claude-worker');
    assert.equal(record.task.reports[0].delivery.state, 'pending');
    assert.equal(record.state, 'delivery_pending', 'native final must settle instead of staying running');
    const noNotification = await service.receiveDesktopRequest(host, { timeoutMs: 20 });
    assert.equal(noNotification.delivery, 'none');
    const waited = await service.wait({ names: ['claude-worker'], timeoutSeconds: 0 }, owner);
    assert.equal(waited.reports[0].delivery, 'delivered');
    const settled = service.store.named('claude-owner', 'claude-worker');
    assert.equal(settled.state, 'idle');
    assert.equal(settled.task.state, 'completed');
  } finally {
    service.close();
  }
});

test('unknown agent_context is rejected instead of falling back to the caller root', async () => {
  const stateDirectory = await tempRoot('bad-agent-context-');
  const service = createCliAgents({ stateDirectory, operationWaitMs: 20, configFile: path.join(stateDirectory, 'config.json') }, {
    resolveContext: extra => extra,
    resolveEnvironment: async () => { throw Object.assign(new Error('desktop required'), { code: 'codex-desktop-required' }); },
    adapterFor: () => ({ id: 'desktop-fake' }),
    wakeCodexDispatcher: async () => ({ isError: false }),
    startWorker: async () => { throw new Error('desktop tests must not start a CLI worker'); },
  });
  const host = dispatcher();
  try {
    await service.registerDesktopHost(host, { nativeSessionId: 'dispatcher-session' });
    await assert.rejects(
      service.resolveDesktopContext({
        client: 'codex-desktop', sessionId: 'unknown-child', threadId: 'unknown-child',
        parentThreadId: 'dispatcher-session', hostId: 'local', workspace: WORKSPACE, profileId: PROFILE,
        agentContext: 'ticket_unknown',
      }),
      error => error.code === 'desktop-context-invalid',
    );
  } finally {
    service.close();
  }
});
