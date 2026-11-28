import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { callCodexOwner } from './codex-notify.mjs';
import { codexDomainForThread } from './codex-domain.mjs';

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
 * Owner ids are namespaced by source, so the same name in a Codex chat, a
 * Claude session, and an Antigravity conversation are different owners and can
 * never collide in the roster.
 * @param {'codex-desktop'|'claude-desktop'|'antigravity'} source Calling application.
 * @param {string} key Thread id, verified native session id, or Antigravity conversation id.
 */
export function ownerIdForSource(source, key) {
  if (source === 'codex-desktop') return ownerIdFor(key);
  if (typeof key !== 'string' || !key) throw new Error('A verified native session id is required.');
  if (source === 'managed-cli') {
    const trimmed = key.trim();
    if (trimmed.startsWith('owner-')) return trimmed;
    return 'owner-' + createHash('sha256').update(`managed-cli:local:${trimmed.toLowerCase()}`).digest('hex').slice(0, 32);
  }
  if (source === 'antigravity') {
    return 'owner-' + createHash('sha256').update(`antigravity:local:${key.toLowerCase()}`).digest('hex').slice(0, 32);
  }
  return 'owner-' + createHash('sha256').update(`claude:desktop:${key.toLowerCase()}`).digest('hex').slice(0, 32);
}

export function trustedCaller(extra) {
  const raw = extra?.[TRUSTED_CALLER];
  const directManaged = !raw && extra && typeof extra === 'object'
    && (typeof extra.parentAgentId === 'string' && extra.parentAgentId.trim())
    ? {
        source: 'managed-cli',
        parentAgentId: extra.parentAgentId,
        ownerId: extra.ownerId,
        workspace: extra.workspace,
        label: extra.label,
      }
    : undefined;
  const value = raw ?? directManaged;
  if (!value) return undefined;
  if (typeof value !== 'object') {
    throw Object.assign(new Error('The trusted caller record is incomplete.'), { code: 'calling-context-unavailable' });
  }
  const source = value.source ?? 'claude-desktop';
  if (source === 'managed-cli') {
    const parentAgentId = typeof (value.parentAgentId ?? value.callerAgentId ?? extra?.parentAgentId) === 'string'
      ? (value.parentAgentId ?? value.callerAgentId ?? extra?.parentAgentId).trim()
      : '';
    const ownerId = typeof (value.ownerId ?? extra?.ownerId) === 'string'
      ? (value.ownerId ?? extra?.ownerId).trim()
      : '';
    if (!parentAgentId && !ownerId) {
      throw Object.assign(new Error('The trusted managed-cli caller record is incomplete.'), { code: 'calling-context-unavailable' });
    }
    return {
      source: 'managed-cli',
      ...(parentAgentId ? { parentAgentId, callerAgentId: parentAgentId } : {}),
      ...(ownerId ? { ownerId } : {}),
      nativeSessionId: parentAgentId || ownerId,
      workspace: value.workspace ?? extra?.workspace,
      label: value.label,
    };
  }
  if (source === 'antigravity') {
    const conversationId = value.conversationId ?? value.nativeSessionId;
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
      throw Object.assign(new Error('The trusted Antigravity caller record is incomplete.'), { code: 'calling-context-unavailable' });
    }
    const normalizedId = conversationId.trim();
    return { source: 'antigravity', conversationId: normalizedId, nativeSessionId: normalizedId,
      workspace: value.workspace, label: value.label };
  }
  if (typeof value.nativeSessionId !== 'string' || !value.nativeSessionId) {
    throw Object.assign(new Error('The trusted caller record is incomplete.'), { code: 'calling-context-unavailable' });
  }
  return { source, nativeSessionId: value.nativeSessionId,
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

async function resolveAntigravityOwner(caller, { knownOwner, defaultWorkspace } = {}) {
  const conversationId = (caller.conversationId ?? caller.nativeSessionId).trim();
  const ownerId = ownerIdForSource('antigravity', conversationId);
  const candidateWorkspace = caller.workspace ?? defaultWorkspace;
  let workspace;
  if (typeof candidateWorkspace === 'string' && path.isAbsolute(candidateWorkspace)) {
    try { workspace = await realpath(candidateWorkspace); }
    catch { workspace = path.resolve(candidateWorkspace); }
  }
  if (knownOwner) {
    const knownId = String(knownOwner.conversationId ?? knownOwner.nativeSessionId ?? '').trim();
    if (knownOwner.ownerId !== ownerId || knownId.toLowerCase() !== conversationId.toLowerCase()) {
      throw new Error('Saved Antigravity conversation ownership does not match the caller.');
    }
    const isPluginFallbackDir = typeof knownOwner.workspace === 'string'
      && /[\\/]\.gemini[\\/]config[\\/]plugins([\\/]|$)/i.test(knownOwner.workspace);
    if ((!knownOwner.workspace || isPluginFallbackDir) && workspace && !/[\\/]\.gemini[\\/]config[\\/]plugins([\\/]|$)/i.test(workspace)) {
      return {
        ...knownOwner,
        workspace,
        ...(caller.label && !knownOwner.label ? { label: caller.label } : {}),
      };
    }
    return knownOwner;
  }
  return {
    ownerId,
    source: 'antigravity',
    conversationId,
    ...(workspace ? { workspace } : {}),
    ...(caller.label ? { label: caller.label } : {}),
    createdAt: new Date().toISOString(),
  };
}

async function resolveManagedCliOwner(caller, { knownOwner, defaultWorkspace } = {}) {
  const callerAgentId = caller.parentAgentId ?? caller.callerAgentId;
  if (knownOwner) {
    return {
      ...knownOwner,
      ...(callerAgentId ? { callerAgentId, parentAgentId: callerAgentId } : {}),
    };
  }
  const ownerId = caller.ownerId || ownerIdForSource('managed-cli', callerAgentId);
  const candidateWorkspace = caller.workspace ?? defaultWorkspace;
  let workspace;
  if (typeof candidateWorkspace === 'string' && path.isAbsolute(candidateWorkspace)) {
    try { workspace = await realpath(candidateWorkspace); }
    catch { workspace = path.resolve(candidateWorkspace); }
  }
  return {
    ownerId,
    source: 'managed-cli',
    ...(callerAgentId ? { callerAgentId, parentAgentId: callerAgentId } : {}),
    ...(workspace ? { workspace } : {}),
    createdAt: new Date().toISOString(),
  };
}

/**
 * The host supplies identity; only the native desktop supplies the initial cwd.
 * A verified Claude or Antigravity caller takes precedence over the Codex metadata
 * path, and the owners are namespaced apart. A Codex caller is read over the native
 * RPC first; a desktop without a debug port falls back to its app-tools bridge,
 * which is the normal path for an ordinary Codex chat.
 */
export async function resolveCallingContext(extra, {
  knownOwner, callCodex = callCodexOwner, nativeRequest, codexInvoke, verifyClaude, bindOwner, defaultWorkspace,
} = {}) {
  const caller = trustedCaller(extra);
  if (caller) {
    if (caller.source === 'managed-cli') {
      return resolveManagedCliOwner(caller, { knownOwner, defaultWorkspace });
    }
    if (caller.source === 'antigravity') {
      return resolveAntigravityOwner(caller, { knownOwner, defaultWorkspace });
    }
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
  // The shared owner entry reads over native RPC first and falls back to app-tools
  // only when no debug port exists. A confirmed missing thread is terminal.
  const lookup = await callCodex(threadId, 'read_thread', {
    threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100,
  }, { nativeRequest, ...(codexInvoke ? { invoke: codexInvoke } : {}) });
  const thread = threadFromResult(lookup);
  if (thread?.id?.toLowerCase() !== threadId || typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd)) {
    throw Object.assign(new Error('The calling Codex chat and its local project could not be verified.'), { code: 'calling-context-unavailable' });
  }
  // Only native RPC metadata carries the provenance needed for this domain.
  const codexDomain = lookup?.via === 'native-rpc' ? await codexDomainForThread(thread) : undefined;
  return { ownerId, source: 'codex-desktop', threadId, workspace: await realpath(thread.cwd), ...(codexDomain ? { codexDomain } : {}), createdAt: new Date().toISOString() };
}
