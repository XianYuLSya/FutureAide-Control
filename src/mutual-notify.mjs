import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { invokeCodexTool } from './codex-notify.mjs';
import { threadFromResult } from './calling-context.mjs';

/** Deliver only explicit reports/questions, to the exact owner recorded at creation. */
export async function notifyParent(notice, config, { invoke = invokeCodexTool } = {}) {
  const { owner, agent, kind, message, final, id } = notice;
  if (owner.client === 'managed-cli') {
    const { createCliAgents } = await import('./cli-agents.mjs');
    const service = createCliAgents(config);
    try { return await service.deliverToParent(owner, { id, message, kind, final, agent }); }
    finally { service.close(); }
  }
  if (owner.client === 'claude-code') return { state: 'pending', receiveWith: 'futureaide_wait_agents' };
  if (owner.client !== 'codex-desktop') return { state: 'blocked', reason: 'unsupported-parent-host' };
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
