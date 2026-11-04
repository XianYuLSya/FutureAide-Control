import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { invokeCodexTool } from './codex-notify.mjs';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

/**
 * A caller identity that the transport already verified. Only the MCP/HTTP edge
 * puts it here, after checking the native session; tool arguments can never
 * supply it (they are model-controlled), so a model cannot claim another chat.
 */
export const TRUSTED_CALLER = Symbol.for('futureaide.trustedCaller');

export function callingThread(extra) {
  const id = extra?._meta?.threadId ?? extra?._meta?.['openai/threadId'];
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw Object.assign(new Error('Codex did not provide its calling chat identity. Reload the plugin in this chat; do not supply a chat ID in tool arguments.'), { code: 'calling-context-unavailable' });
  }
  return id.toLowerCase();
}

/** Owner id of a Codex chat. Unchanged from 0.5.7 so existing rosters keep working. */
export function ownerIdFor(threadId) {
  return 'owner-' + createHash('sha256').update(`codex:local:${threadId.toLowerCase()}`).digest('hex').slice(0, 32);
}

/**
 * Owner ids are namespaced by source, so the same name in a Codex chat and in a
 * Claude session are different owners and can never collide in the roster.
 * @param {'codex-desktop'|'claude-desktop'} source Calling application.
 * @param {string} key Thread id or verified native session id.
 */
export function ownerIdForSource(source, key) {
  if (source === 'codex-desktop') return ownerIdFor(key);
  if (typeof key !== 'string' || !key) throw new Error('A verified native session id is required.');
  return 'owner-' + createHash('sha256').update(`claude:desktop:${key.toLowerCase()}`).digest('hex').slice(0, 32);
}

export function trustedCaller(extra) {
  const value = extra?.[TRUSTED_CALLER];
  if (!value) return undefined;
  if (typeof value !== 'object' || typeof value.nativeSessionId !== 'string' || !value.nativeSessionId) {
    throw Object.assign(new Error('The trusted caller record is incomplete.'), { code: 'calling-context-unavailable' });
  }
  return { source: value.source ?? 'claude-desktop', nativeSessionId: value.nativeSessionId,
    workspace: value.workspace, label: value.label };
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

async function resolveClaudeOwner(caller, { knownOwner, verifyClaude, bindOwner }) {
  const nativeSessionId = caller.nativeSessionId.toLowerCase();
  const ownerId = ownerIdForSource('claude-desktop', nativeSessionId);
  if (knownOwner) {
    if (knownOwner.ownerId !== ownerId || String(knownOwner.nativeSessionId ?? '').toLowerCase() !== nativeSessionId) {
      throw new Error('Saved session ownership does not match the caller.');
    }
    return knownOwner;
  }
  const verified = await verifyClaude(caller);
  if (!verified || !path.isAbsolute(verified.workspace ?? '')) {
    throw Object.assign(new Error('The calling Claude session and its project could not be verified.'),
      { code: 'calling-context-unavailable' });
  }
  const workspace = await realpath(verified.workspace);
  // Capture this session's own transport binding once, while it is verified, so its
  // notices never need a discovery pass; it is refreshed only when the session
  // outgrows it. A caller that is not a managed name just gets its own namescope.
  let binding;
  if (typeof bindOwner === 'function') {
    try { binding = await bindOwner({ pid: verified.pid, sessionId: nativeSessionId, workspace }); }
    catch { /* Bound lazily by the first notice instead. */ }
  }
  return { ownerId, source: 'claude-desktop', nativeSessionId, hostSessionId: nativeSessionId,
    pid: verified.pid, workspace, ...(binding ? { binding } : {}), createdAt: new Date().toISOString() };
}

/**
 * The host supplies identity; only the native desktop supplies the initial cwd.
 * A verified Claude caller takes precedence over the Codex metadata path, and the
 * two owners are namespaced apart.
 */
export async function resolveCallingContext(extra, { knownOwner, callCodex = invokeCodexTool, verifyClaude, bindOwner } = {}) {
  const caller = trustedCaller(extra);
  if (caller) {
    if (typeof verifyClaude !== 'function') {
      throw Object.assign(new Error('This plugin build cannot verify Claude session callers.'),
        { code: 'calling-context-unavailable' });
    }
    return resolveClaudeOwner(caller, { knownOwner, verifyClaude, bindOwner });
  }
  const threadId = callingThread(extra);
  const ownerId = ownerIdFor(threadId);
  if (knownOwner) {
    if (knownOwner.ownerId !== ownerId || knownOwner.threadId !== threadId) throw new Error('Saved chat ownership does not match the caller.');
    return knownOwner;
  }
  const thread = threadFromResult(await callCodex(threadId, 'read_thread', {
    threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100,
  }));
  if (thread?.id?.toLowerCase() !== threadId || thread.kind !== 'codex' || thread.hostId !== 'local'
      || typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd)) {
    throw Object.assign(new Error('The calling Codex chat and its local project could not be verified.'), { code: 'calling-context-unavailable' });
  }
  return { ownerId, source: 'codex-desktop', threadId, workspace: await realpath(thread.cwd), createdAt: new Date().toISOString() };
}
