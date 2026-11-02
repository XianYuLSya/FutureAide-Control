import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { invokeCodexTool } from './codex-notify.mjs';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export function callingThread(extra) {
  const turn = extra?._meta?.['x-codex-turn-metadata'];
  const id = extra?._meta?.threadId ?? extra?._meta?.['openai/threadId'] ?? turn?.thread_id;
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw Object.assign(new Error('Codex did not provide its calling chat identity. Reload the plugin in this chat; do not supply a chat ID in tool arguments.'), { code: 'calling-context-unavailable' });
  }
  return id.toLowerCase();
}

/** Read the trusted parent thread supplied for a native child turn. */
export function callingParentThread(extra) {
  const turn = extra?._meta?.['x-codex-turn-metadata'];
  const id = turn?.parent_thread_id ?? extra?._meta?.parentThreadId ?? extra?._meta?.['openai/parentThreadId'];
  return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : undefined;
}

export function ownerIdFor(threadId) {
  return 'owner-' + createHash('sha256').update(`codex:local:${threadId.toLowerCase()}`).digest('hex').slice(0, 32);
}

export function threadFromResult(result) {
  if (result?.isError) throw new Error('The Codex desktop rejected the chat lookup.');
  const candidates = [result, result?.structuredContent, result?.structuredContent?.result];
  for (const content of result?.content ?? []) {
    if (content?.type !== 'text') continue;
    try {
      const value = JSON.parse(content.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      candidates.push(value, value?.result);
    } catch { /* Plain text is not a trusted thread record. */ }
  }
  return candidates.find(value => value?.thread && typeof value.thread === 'object')?.thread;
}

/** The host supplies identity; only the native desktop supplies the initial cwd. */
export async function resolveCallingContext(extra, { knownOwner, callCodex = invokeCodexTool } = {}) {
  const threadId = callingThread(extra);
  const ownerId = ownerIdFor(threadId);
  if (knownOwner) {
    if (knownOwner.ownerId !== ownerId || knownOwner.threadId !== threadId) throw new Error('Saved chat ownership does not match the caller.');
    const parentThreadId = callingParentThread(extra);
    return parentThreadId ? { ...knownOwner, parentThreadId } : knownOwner;
  }
  const thread = threadFromResult(await callCodex(threadId, 'read_thread', {
    threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100,
  }));
  if (thread?.id?.toLowerCase() !== threadId || thread.kind !== 'codex' || thread.hostId !== 'local'
      || typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd)) {
    throw Object.assign(new Error('The calling Codex chat and its local project could not be verified.'), { code: 'calling-context-unavailable' });
  }
  return { ownerId, threadId, workspace: await realpath(thread.cwd), hostId: thread.hostId,
    ...(callingParentThread(extra) ? { parentThreadId: callingParentThread(extra) } : {}), createdAt: new Date().toISOString() };
}
