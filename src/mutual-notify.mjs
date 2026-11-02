import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { invokeCodexTool } from './codex-notify.mjs';
import { threadFromResult } from './calling-context.mjs';
import { RosterStore } from './roster-store.mjs';
import { desktopHostKey } from './claude-desktop-protocol.mjs';

/**
 * For a managed native parent, store the explicit report/question in the existing
 * cli-roster record as dispatcher-pending. The registered dispatcher is only woken;
 * the wake is not delivery. host_receive returns the notification and
 * host_delivery_ack marks it delivered only after the dispatcher's native
 * followup_task/SendMessage reaches the manager.
 */
async function notifyNativeManager(notice, config, invoke) {
  const { owner, agent, kind, id } = notice;
  if (!owner.parentAgentId) return { state: 'blocked', reason: 'native-manager-record-missing' };
  const stateDirectory = config.cliStateDirectory ?? config.stateDirectory;
  if (!stateDirectory) return { state: 'blocked', reason: 'native-state-unavailable' };
  const store = new RosterStore(path.join(stateDirectory, 'cli-roster.sqlite'));
  let manager;
  let host;
  let record;
  try {
    manager = store.get(owner.parentAgentId);
    if (!manager || manager.desktopMode !== 'native' || manager.runtime !== 'codex') {
      return { state: 'blocked', reason: 'native-manager-record-missing' };
    }
    const profileId = manager.desktopProfileId ?? owner.profileId;
    const workspace = manager.workspace ?? owner.workspace;
    if (!profileId || !workspace) return { state: 'blocked', reason: 'native-manager-binding-missing' };
    host = store.desktopHost(desktopHostKey({
      targetRuntime: 'codex', targetClient: 'codex-desktop', profileId, workspace,
    }));
    if (!host) return { state: 'blocked', reason: 'codex-dispatcher-unregistered' };
    if (typeof manager.desktopNativeHandle !== 'string' || !manager.desktopNativeHandle.trim()) {
      return { state: 'blocked', reason: 'native-manager-native-handle-missing' };
    }
    record = store.named(owner.ownerId, agent.name)
      ?? store.list().find(item => item.name === agent.name
        && (item.ownerId === owner.ownerId || item.owner?.ownerId === owner.ownerId));
    if (!record?.task) return { state: 'blocked', reason: 'native-child-record-missing' };
    const notification = kind === 'question'
      ? (record.task.questions ?? []).find(item => item.id === id)
      : (record.task.reports ?? []).find(item => item.id === id);
    if (!notification) return { state: 'blocked', reason: `native-${kind}-missing` };
    const current = kind === 'question' ? notification.noticeState : notification.delivery?.state;
    if (current === 'delivered') {
      return { state: 'delivered', target: host.nativeThreadId, managerNativeHandle: manager.desktopNativeHandle, managerAgentId: manager.agentId, duplicate: true };
    }
    if (current === 'blocked') return { state: 'blocked', reason: `native-${kind}-blocked` };
    if (current === 'dispatcher-pending') {
      return { state: 'dispatcher-pending', target: host.nativeThreadId, managerNativeHandle: manager.desktopNativeHandle, managerAgentId: manager.agentId, duplicate: true };
    }
  } finally {
    store.close();
  }

  const managerThread = manager.desktopSessionId ?? manager.agentId;
  const wakePrompt = [
    `FutureAide dispatcher: pending ${kind} ${id} for manager_agent_id=${manager.agentId} manager_thread_id=${managerThread}.`,
    'Call host_receive and return this explicit item through native followup_task/SendMessage to that manager.',
    'This wake is not delivery; only host_delivery_ack after the native send may mark it delivered.',
    `<!-- futureaide-manager:${id} -->`,
  ].join('\n');
  try {
    const result = await invoke(host.nativeThreadId, 'send_message_to_thread', {
      threadId: host.nativeThreadId,
      prompt: wakePrompt,
    });
    return {
      state: 'dispatcher-pending',
      target: host.nativeThreadId,
      managerNativeHandle: manager.desktopNativeHandle,
      managerAgentId: manager.agentId,
      ...(result?.isError ? { note: 'dispatcher-wake-rejected' } : {}),
    };
  } catch {
    return {
      state: 'dispatcher-pending', target: host.nativeThreadId,
      managerNativeHandle: manager.desktopNativeHandle, managerAgentId: manager.agentId, note: 'dispatcher-wake-failed',
    };
  }
}

async function claudePending(owner, config) {
  // A normal Claude user chat has no managed parent record. It consumes reports
  // through futureaide_wait_agents and must not enter the native relay.
  if (!owner.parentAgentId) return { state: 'pending', receiveWith: 'futureaide_wait_agents' };
  const stateDirectory = config.cliStateDirectory ?? config.stateDirectory;
  if (!stateDirectory) return { state: 'blocked', reason: 'native-state-unavailable' };
  const store = new RosterStore(path.join(stateDirectory, 'cli-roster.sqlite'));
  try {
    const manager = store.get(owner.parentAgentId);
    if (!manager || manager.desktopMode !== 'native' || manager.runtime !== 'claude') {
      return { state: 'pending', receiveWith: 'futureaide_wait_agents' };
    }
    const profileId = manager.desktopProfileId ?? owner.profileId;
    const workspace = manager.workspace ?? owner.workspace;
    if (!profileId || !workspace) return { state: 'blocked', reason: 'claude-manager-binding-missing' };
    if (typeof manager.desktopNativeHandle !== 'string' || !manager.desktopNativeHandle.trim()) {
      return { state: 'blocked', reason: 'claude-manager-native-handle-missing' };
    }
    const host = store.desktopHost(desktopHostKey({
      targetRuntime: 'claude', targetClient: 'claude-code', profileId, workspace,
    }));
    if (!host) return { state: 'blocked', reason: 'claude-dispatcher-unregistered' };
    return { state: 'dispatcher-pending', receiveWith: 'host_receive',
      managerNativeHandle: manager.desktopNativeHandle, managerAgentId: manager.agentId };
  } finally {
    store.close();
  }
}

/** Deliver only explicit reports/questions, to the exact owner recorded at creation. */
export async function notifyParent(notice, config, { invoke = invokeCodexTool } = {}) {
  const { owner, agent, kind, message, final, id } = notice;
  if (owner.client === 'managed-cli') {
    const { createCliAgents } = await import('./cli-agents.mjs');
    const service = createCliAgents(config);
    try { return await service.deliverToParent(owner, { id, message, kind, final, agent }); }
    finally { service.close(); }
  }
  if (owner.client === 'claude-code') return claudePending(owner, config);
  if (owner.client !== 'codex-desktop') return { state: 'blocked', reason: 'unsupported-parent-host' };
  if (owner.parentThreadId) return notifyNativeManager(notice, config, invoke);

  // A root Codex caller has no managed native parent: keep the existing explicit
  // direct-thread delivery path and its deduplicated delivery table.
  const directory = config.cliStateDirectory ?? config.stateDirectory;
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, 'mutual-deliveries.sqlite'));
  database.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL)');
  const marker = `<!-- futureaide-mutual:${id} -->`;
  try {
    let previous = database.prepare('SELECT owner,state FROM notices WHERE id=?').get(id);
    if (previous?.owner !== undefined && previous.owner !== owner.ownerId) return { state: 'blocked', reason: 'notice-owner-mismatch' };
    if (previous?.state === 'delivered') return { state: 'delivered' };
    if (previous?.state === 'blocked') return { state: 'blocked', reason: 'native-callback-unavailable' };
    if (previous && ['sending', 'unknown'].includes(previous.state)) {
      try {
        const history = await invoke(owner.threadId, 'read_thread', { threadId: owner.threadId, turnLimit: 20, includeOutputs: true, maxOutputCharsPerItem: 20000 });
        if (!history?.isError && JSON.stringify(history).includes(marker)) {
          database.prepare('UPDATE notices SET state=? WHERE id=?').run('delivered', id);
          return { state: 'delivered', recovered: true };
        }
      } catch { /* An uncertain delivery is read back, never blindly repeated. */ }
      return { state: 'unknown' };
    }
    const response = await invoke(owner.threadId, 'read_thread', { threadId: owner.threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100 });
    const thread = threadFromResult(response);
    if (!thread || thread.id !== owner.threadId || thread.kind !== 'codex' || thread.hostId !== 'local'
      || path.resolve(thread.cwd).toLowerCase() !== path.resolve(owner.workspace).toLowerCase()) return { state: 'blocked', reason: 'parent-context-changed' };
    database.prepare('INSERT OR IGNORE INTO notices(id,owner,state) VALUES(?,?,?)').run(id, owner.ownerId, 'pending');
    const claimed = database.prepare("UPDATE notices SET state='sending' WHERE id=? AND state='pending'").run(id);
    if (claimed.changes !== 1) return { state: 'pending' };
    try {
      const prompt = `${agent.runtime === 'claude' ? 'Claude Code' : 'Codex'}「${agent.name}」${kind === 'question' ? '提问' : final ? '完成报告' : '汇报'}：\n${message}\n\n${marker}`;
      const result = await invoke(owner.threadId, 'send_message_to_thread', { threadId: owner.threadId, prompt });
      const unavailable = result?.isError && JSON.stringify(result).includes('direct app-server input is not allowed for multi-agent v2 sub-agents');
      const state = unavailable ? 'blocked' : result?.isError ? 'pending' : 'delivered';
      database.prepare('UPDATE notices SET state=? WHERE id=?').run(state, id);
      return { state, ...(unavailable ? { reason: 'native-callback-unavailable' } : {}) };
    } catch {
      database.prepare('UPDATE notices SET state=? WHERE id=?').run('unknown', id);
      return { state: 'unknown' };
    }
  } catch { return { state: 'pending' }; }
  finally { database.close(); }
}
