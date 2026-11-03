// Claude Desktop descendant tree. The root projection already pairs each
// successful Agent tool result with the child's native agentId; this module
// follows exactly those pairs — plus each child's own native `<agent>.meta.json`
// (toolUseId / parentAgentId) — into the child's transcript, and never attaches a
// session by directory proximity, cwd, title, or recency.
//
// Nothing new is stored: every node's incremental cursor rides in the same
// backend_state row as the root's own observation (`state`), which this function
// returns so the caller can save it unchanged. There is no cap on how many
// descendants are followed: anything not observed is reported unverified, which
// keeps the tree unsettled, instead of being silently dropped.
//
// A node is never called settled on a quiet file or on a guessed timeline. Each
// node carries the native evidence for its own status: the host's meta `finished`
// flag, a successful SubagentHandback pair, a returned Agent tool result, or its
// own recorded turn end.
import path from 'node:path';
import { open, readdir, readFile } from 'node:fs/promises';
import { CLAUDE_FILE_COVERAGE, emptyClaudeProjection, observeClaudeTranscript } from './claude-observer.mjs';
import { readClaudeEvents } from './claude-inbox.mjs';

export const CLAUDE_TREE_VERSION = 1;
/** Task-tree protocol level this adapter observes (see agent-backend.mjs). */
export const TREE_PROTOCOL = 1;
export const CLAUDE_TREE_LIMITATION = 'Only a successful Agent/Task tool result that returned a native agentId, or a native agent meta whose toolUseId is an Agent tool_use id observed in its parent, is followed — and only inside this session\'s own subagents directory. A child whose transcript cannot be located, read, or matched to this session stays unverified, which keeps the tree unsettled instead of guessing.';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const STORED_MESSAGES = 20;
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Stable internal node id for a native agentId; never the logical session id. */
export const claudeNodeId = nativeAgentId => `claude-agent-${nativeAgentId}`;

export function emptyClaudeTreeState() {
  return { version: CLAUDE_TREE_VERSION, root: null, nodes: {}, order: [], rootToolIds: [], truncated: 0 };
}

function normalizeState(state) {
  if (!state || state.version !== CLAUDE_TREE_VERSION || !state.nodes || typeof state.nodes !== 'object') {
    return emptyClaudeTreeState();
  }
  return { version: CLAUDE_TREE_VERSION, root: state.root ?? null, nodes: { ...state.nodes },
    order: Array.isArray(state.order) ? [...state.order] : [],
    rootToolIds: Array.isArray(state.rootToolIds) ? [...state.rootToolIds] : [], truncated: 0 };
}

/**
 * Read only the head of one native transcript to learn which session id and
 * agentId its lines carry and whether they are marked as sidechain. All three are
 * properties of the file that the reader filters on, so they are measured, and a
 * file that names another session or agent is refused rather than followed.
 */
async function probeTranscript(file, { maxBytes = 131072 } = {}) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (!size) return { sessionId: undefined, agentId: undefined, sidechain: false, size };
    const buffer = Buffer.alloc(Math.min(maxBytes, size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let sessionId, agentId, sidechainLines = 0, plainLines = 0;
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (sessionId === undefined && typeof event.sessionId === 'string') sessionId = event.sessionId;
      if (agentId === undefined && typeof event.agentId === 'string') agentId = event.agentId;
      if (!['user', 'assistant', 'system'].includes(event.type)) continue;
      if (event.isSidechain === true) sidechainLines++;
      else plainLines++;
    }
    return { sessionId, agentId, sidechain: sidechainLines > plainLines, size };
  } finally { await handle.close(); }
}

/**
 * `agent-<agentId>.jsonl` files under this session's own subagents directory
 * (workflow logs live in its `workflows` subtree, so the whole subtree is walked).
 * No file-count or depth cap: an unread child must never hide a running one.
 */
async function indexSubagentTranscripts(directory) {
  const found = new Map();
  const unindexed = [];
  const walk = async dir => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    });
    for (const entry of entries ?? []) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !/\.jsonl$/i.test(entry.name)) continue;
      const match = /^agent-(.+)\.jsonl$/i.exec(entry.name);
      if (!match) { unindexed.push(file); continue; }
      if (!found.has(match[1])) found.set(match[1], file);
    }
  };
  await walk(directory);
  return { files: found, unindexed };
}

function metaShape(value, file) {
  return { file, finished: value.finished === true,
    ...(value.finished === false ? { running: true } : {}),
    ...(value.stoppedByUser === true ? { stoppedByUser: true } : {}),
    ...(typeof value.toolUseId === 'string' ? { toolUseId: value.toolUseId } : {}),
    ...(typeof value.parentAgentId === 'string' ? { parentAgentId: value.parentAgentId } : {}),
    ...(Number.isSafeInteger(value.spawnDepth) ? { spawnDepth: value.spawnDepth } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.agentType === 'string' ? { agentType: value.agentType } : {}),
    ...(typeof value.requestShape === 'string' ? { requestShape: value.requestShape } : {}) };
}

/** Every native agent meta in this session's own directory, keyed by agentId. */
async function indexSubagentMetas(files) {
  const metas = new Map();
  for (const [agentId, file] of files) {
    const metaFile = file.replace(/\.jsonl$/i, '.meta.json');
    try { metas.set(agentId, metaShape(JSON.parse((await readFile(metaFile, 'utf8')).replace(/^\uFEFF/, '')), metaFile)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return metas;
}

/**
 * Agent/Task tool_use ids this node emitted; the native pairing anchor. The
 * observer keeps every one of them in agentTools, so a session with many
 * children cannot lose a node to the bounded message window.
 */
function collectAgentToolIds(projection, previous = []) {
  const ids = new Set(previous);
  for (const toolId of Object.keys(projection?.agentTools ?? {})) {
    if (typeof toolId === 'string' && toolId) ids.add(toolId);
  }
  for (const message of projection?.messages ?? []) {
    for (const tool of message.tools ?? []) {
      if (AGENT_TOOLS.has(tool?.name) && typeof tool.id === 'string') ids.add(tool.id);
    }
  }
  return [...ids];
}

/**
 * The turn's own interrupt record. The observer sets lastInterruptSeq for the
 * exact sentence, but Claude Desktop 2.1.309 also writes
 * "[Request interrupted by user for tool use]" — measured in the live cancel
 * run — so the normalized messages are checked for the same prefix.
 */
function interruptSeqOf(projection) {
  const recorded = projection?.lastInterruptSeq ?? 0;
  let seq = recorded;
  for (const message of projection?.messages ?? []) {
    if (message.role !== 'user' || typeof message.text !== 'string') continue;
    if (!message.text.startsWith('[Request interrupted by user')) continue;
    if ((message.seq ?? 0) > seq) seq = message.seq;
  }
  return seq;
}

/** Calls left open after the turn's own interrupt are not evidence of work. */
function openTools(projection) {
  const interruptSeq = interruptSeqOf(projection);
  return Object.values(projection?.pendingTools ?? {}).filter(tool => (tool.seq ?? 0) > interruptSeq);
}

/**
 * A SubagentHandback that the host reported as successful is finished work. The
 * observer records only non-error results in successfulTools, so a failed
 * handback can never end a node.
 */
function handedBack(projection) {
  const successful = projection?.successfulTools;
  if (!Array.isArray(successful) || !successful.length) return false;
  for (const message of [...(projection.messages ?? [])].reverse()) {
    if (message.role !== 'assistant' || !message.tools?.length) continue;
    const handback = message.tools.find(tool => tool.name === 'SubagentHandback');
    return Boolean(handback) && successful.includes(handback.id);
  }
  return false;
}

function nodeCoverage(entry) {
  if (entry.limited) return { source: entry.limited, complete: false,
    limitation: entry.limited === 'depth-limit'
      ? 'This child is deeper than the requested depth limit, so its own transcript was not read.'
      : 'This child was not read because the requested node limit was reached.' };
  if (entry.identityMismatch) return { source: 'agent-identity-mismatch', complete: false,
    limitation: entry.identityMismatch === 'session'
      ? 'The transcript names another session id, so it was not read.'
      : 'The transcript does not name this agentId, so it was not read.' };
  if (!entry.file) return { source: 'missing-agent-transcript', complete: false,
    limitation: 'The Agent result named a native agentId but no transcript for it exists in this session directory.' };
  if (entry.filtered) return { source: 'filtered-agent-transcript', complete: false,
    limitation: 'The transcript exists but none of its lines match the observed session id and sidechain marker.' };
  return CLAUDE_FILE_COVERAGE;
}

/** Status of one child, from native evidence only; every branch names its proof. */
function childStatus(entry) {
  if (entry.identityMismatch) {
    return { status: 'unverified', evidence: 'agent-identity-mismatch',
      activity: 'transcript identity does not match this session and agent' };
  }
  // Anything not fully observed stays unverified: a shortcut here would let an
  // unread child hide its own descendants.
  if (entry.limited) {
    return { status: 'unverified', evidence: entry.limited, activity: `not read: ${entry.limited}` };
  }
  if (entry.filtered) {
    return { status: 'unverified', evidence: 'filtered-transcript',
      activity: 'transcript not readable with the observed session/sidechain marker' };
  }
  if (!entry.file) {
    return { status: 'unverified', evidence: 'missing-transcript', activity: 'subagent transcript not located' };
  }
  if (entry.meta?.toolUseId && entry.parentToolUseId && entry.meta.toolUseId !== entry.parentToolUseId) {
    return { status: 'unverified', evidence: 'agent-pairing-mismatch',
      activity: 'the native agent meta names a different Agent tool than the one that launched it' };
  }
  if (entry.meta?.finished === true) {
    return { status: 'ended', evidence: 'agent-meta-finished', endSeq: entry.projection.throughSeq ?? 0,
      activity: entry.meta.agentType ? `finished: ${entry.meta.agentType}` : 'native agent meta reports finished' };
  }
  // 2.1.309 writes stoppedByUser on a background task the user stopped.
  if (entry.meta?.stoppedByUser === true) {
    return { status: 'ended', evidence: 'agent-stopped-by-user', endSeq: entry.projection.throughSeq ?? 0,
      activity: 'the host recorded a user stop for this subagent' };
  }
  if (!entry.background && entry.resultSeq !== undefined) {
    return { status: 'ended', evidence: 'parent-agent-tool-result',
      activity: entry.resultStatus ? `agent ${entry.resultStatus}` : 'agent result returned' };
  }
  const pending = openTools(entry.projection);
  if (pending.length) return { status: 'running', evidence: 'pending-tool', activity: `tool: ${pending.at(-1).name}` };
  // The app's own interrupt record is stronger than an unfinished meta: the agent
  // stopped there, and any result that arrives later still pairs by tool id.
  const interruptSeq = interruptSeqOf(entry.projection);
  if (interruptSeq > 0) {
    return { status: 'ended', evidence: 'agent-interrupted', endSeq: interruptSeq,
      activity: 'the app recorded an interrupt in this agent\'s transcript' };
  }
  if (entry.meta?.running === true) {
    return { status: 'running', evidence: 'agent-meta-running',
      activity: 'native agent meta still reports an unfinished subagent' };
  }
  if (handedBack(entry.projection)) {
    return { status: 'ended', evidence: 'subagent-handback', endSeq: entry.projection.throughSeq ?? 0,
      activity: 'subagent handed its result back' };
  }
  const completed = (entry.projection.completions ?? []).at(-1);
  if (completed && !entry.background) {
    return { status: 'ended', evidence: 'own-transcript-turn-end', endSeq: completed.seq,
      activity: `turn-ended: ${completed.reason?.kind ?? 'completed'}` };
  }
  if (completed) {
    // A background child that ended a turn without a handback or a finished meta
    // has not proven it stopped; no quiet-time inference is used here.
    return { status: 'running', evidence: 'turn-ended-unconfirmed',
      activity: 'turn ended without a native finished marker' };
  }
  const last = entry.projection.messages?.at(-1);
  return { status: 'running', evidence: 'no-completed-turn',
    activity: last?.role === 'assistant' ? 'responding' : 'launched; no completed turn yet' };
}

function trimMessages(projection) {
  if (!Array.isArray(projection?.messages) || projection.messages.length <= STORED_MESSAGES) return projection;
  projection.messagesOmitted = (projection.messagesOmitted ?? 0) + projection.messages.length - STORED_MESSAGES;
  projection.messages = projection.messages.slice(-STORED_MESSAGES);
  return projection;
}

function pendingAgentTools(projection) {
  return openTools(projection).filter(tool => AGENT_TOOLS.has(tool?.name)).map(tool => tool.id);
}

/**
 * Read one child transcript incrementally into its own stored projection. The
 * session id and agentId come from the file's own head and must match; the
 * sidechain marker is taken from the same sample and flipped once if it proves
 * useless.
 */
async function observeChild(entry, { binding, files, readEvents, options }) {
  if (!entry.file) entry.file = files.get(entry.agentId) ?? undefined;
  if (!entry.file) return;
  entry.sample ??= await probeTranscript(entry.file);
  entry.meta = await readNativeMeta(entry);
  if (entry.sample.sessionId !== binding.sessionId) { entry.identityMismatch = 'session'; return; }
  if (entry.sample.agentId !== entry.agentId) { entry.identityMismatch = 'agent'; return; }
  entry.identityMismatch = undefined;
  if (entry.sample.sessionId === undefined) return; // empty transcript: nothing to pair yet
  if (entry.meta?.description && !entry.name) entry.name = entry.meta.description;
  if (entry.sidechain === undefined) entry.sidechain = entry.sample.sidechain;
  const childBinding = { ...binding, sessionId: entry.sample.sessionId, transcriptFile: entry.file };
  const run = async sidechain => {
    let events = 0;
    const counting = async (target, page) => {
      const value = await readEvents(target, page);
      events += value.events?.length ?? 0;
      return value;
    };
    await observeClaudeTranscript(childBinding, entry.projection, { ...options, readEvents: counting,
      sidechain, workspace: options.workspace, agentId: entry.agentId });
    return events;
  };
  let seen = await run(entry.sidechain === true);
  if (seen === 0 && entry.projection.throughSeq === 0 && entry.sample.size > 0 && !entry.sidechainRetried) {
    entry.sidechainRetried = true;
    entry.sidechain = !(entry.sidechain === true);
    seen = await run(entry.sidechain);
  }
  entry.filtered = seen === 0 && entry.projection.throughSeq === 0 && entry.sample.size > 0;
}

async function readNativeMeta(entry) {
  if (!entry.file) return undefined;
  const metaFile = entry.file.replace(/\.jsonl$/i, '.meta.json');
  let value;
  try { value = JSON.parse((await readFile(metaFile, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  return metaShape(value, metaFile);
}

/**
 * Observe one Claude Desktop root session and its explicitly paired descendants.
 * @param {object} binding Root binding (sessionId + transcriptFile) verified by the adapter.
 * @param {object} rootProjection The incremental projection observeClaudeTranscript maintains for the root.
 * @param {object} options logicalSessionId, agentId, name, workspace, state, taskId,
 *   nativeStatus (the native registry status: 'idle' when the session is at rest),
 *   plus readEvents and the optional maxNodes/maxDepth paging limits for callers
 *   that deliberately observe a slice. A paged-out node is unverified, never ended.
 * @returns {{tree: object, state: object, histories: object}} tree for the shared FSM,
 *   the state to persist in backend_state, and per-node normalized history.
 */
export async function observeClaudeTree(binding, rootProjection, {
  logicalSessionId, agentId, name, workspace, state = {}, taskId, nativeStatus,
  readEvents = readClaudeEvents, maxNodes = Number.POSITIVE_INFINITY,
  maxDepth = Number.POSITIVE_INFINITY,
} = {}) {
  if (typeof logicalSessionId !== 'string' || !logicalSessionId) {
    throw fail('claude-tree-root-required', 'A logical session id is required to name the root of the task tree.');
  }
  if (typeof binding?.transcriptFile !== 'string' || !binding.transcriptFile || typeof binding.sessionId !== 'string') {
    throw fail('claude-tree-binding-required', 'The bound Claude session must carry its native session id and transcript file.');
  }
  const subagentsRoot = path.join(path.dirname(binding.transcriptFile), binding.sessionId, 'subagents');
  const { files, unindexed } = await indexSubagentTranscripts(subagentsRoot);
  const treeState = normalizeState(state);
  const options = { workspace };

  const rootPending = openTools(rootProjection);
  const rootCompleted = (rootProjection.completions ?? []).at(-1);
  // The native registry is authoritative about the root turn: after an interrupt
  // a pending tool result can stay unanswered forever, while registry 'idle' (or a
  // recorded completion, including the interrupt marker) proves the turn stopped.
  const rootStopped = typeof nativeStatus === 'string' ? nativeStatus === 'idle' : Boolean(rootCompleted);
  const nodes = [{ sessionId: logicalSessionId, parentSessionId: null,
    name: typeof name === 'string' && name ? name : null, mode: 'root', depth: 0,
    nativeAgentId: agentId ?? null,
    status: rootStopped ? 'ended' : 'running',
    activity: rootPending.length && !rootStopped ? `tool: ${rootPending.at(-1).name}` : rootProjection.activity ?? 'unknown',
    changes: rootProjection.changes ?? [], coverage: CLAUDE_FILE_COVERAGE,
    messages: rootProjection.messages ?? [], lastSeq: rootProjection.throughSeq ?? 0,
    pendingAgentTools: pendingAgentTools(rootProjection) }];
  const order = [];
  let budget = Number.isFinite(maxNodes) ? Math.max(0, Math.floor(maxNodes)) : Number.POSITIVE_INFINITY;
  let truncated = 0;

  const pushNode = (entry, parentSessionId, depth) => {
    const known = entry ?? { agentId: undefined, projection: emptyClaudeProjection('claude-tree-unknown') };
    const status = childStatus(known);
    nodes.push({ sessionId: claudeNodeId(known.agentId), parentSessionId,
      name: known.name ?? null, mode: known.background ? 'background-subagent' : 'foreground-subagent',
      depth, nativeAgentId: known.agentId, status: status.status, activity: status.activity,
      ...(known.meta?.spawnDepth !== undefined ? { nativeDepth: known.meta.spawnDepth } : {}),
      ...(known.meta?.agentType ? { agentType: known.meta.agentType } : {}),
      changes: known.projection.changes ?? [], coverage: nodeCoverage(known),
      messages: known.projection.messages ?? [], lastSeq: known.projection.throughSeq ?? 0,
      evidence: status.evidence, ...(status.endSeq !== undefined ? { endSeq: status.endSeq } : {}),
      pendingAgentTools: pendingAgentTools(known.projection), background: known.background === true });
  };

  // A node is placed only by an explicit native pair: its own meta.toolUseId is
  // an Agent tool_use id already seen in the parent it names (meta.parentAgentId
  // or the parent session itself), or a successful Agent tool result returned its
  // agentId. A still-pending Agent tool_use is included, so a child that is
  // already running in the background is never missed while its result is open.
  const indexedMetas = await indexSubagentMetas(files);
  const rootToolIds = collectAgentToolIds(rootProjection, treeState.rootToolIds ?? []);
  treeState.rootToolIds = rootToolIds;
  nodes[0].agentToolIds = rootToolIds.length;
  const byToolId = new Map(rootToolIds.map(toolId => [toolId, logicalSessionId]));
  const discovered = new Map();
  for (const child of Object.values(rootProjection.children ?? {})) {
    if (child && typeof child.agentId === 'string') discovered.set(child.agentId, child);
  }
  const candidates = [...new Set([...Object.keys(treeState.nodes), ...discovered.keys(), ...indexedMetas.keys()])].sort();
  const placedDepth = new Map([[logicalSessionId, 0]]);
  const parents = new Map();
  let rounds = 0, progress = true;
  while (progress && rounds++ <= maxDepth + 1) {
    progress = false;
    for (const nativeId of candidates) {
      if (parents.has(nativeId)) continue;
      const child = discovered.get(nativeId);
      let entry = treeState.nodes[nativeId];
      const meta = indexedMetas.get(nativeId) ?? entry?.meta;
      const anchors = [meta?.toolUseId, child?.parentToolUseId].filter(id => typeof id === 'string');
      let parentSessionId = anchors.map(id => byToolId.get(id)).find(Boolean);
      if (!parentSessionId && typeof meta?.parentAgentId === 'string' && parents.has(meta.parentAgentId)) {
        parentSessionId = claudeNodeId(meta.parentAgentId);
      }
      if (!parentSessionId && entry?.parentSessionId && placedDepth.has(entry.parentSessionId)) {
        parentSessionId = entry.parentSessionId;
      }
      if (!parentSessionId) continue;
      const depth = (placedDepth.get(parentSessionId) ?? 0) + 1;
      if (!entry) {
        entry = { agentId: nativeId,
          projection: emptyClaudeProjection(taskId ? `${taskId}:${nativeId}` : `claude-tree-${nativeId}`) };
        treeState.nodes[nativeId] = entry;
      }
      entry.parentSessionId = parentSessionId;
      entry.depth = depth;
      if (child) {
        if (typeof child.name === 'string' && child.name) entry.name = child.name;
        if (child.resultSeq !== undefined) entry.resultSeq = child.resultSeq;
        if (typeof child.status === 'string') entry.resultStatus = child.status;
        if (typeof child.parentToolUseId === 'string') entry.parentToolUseId = child.parentToolUseId;
        if (child.background === true) entry.background = true;
      }
      if (!entry.name && meta?.description) entry.name = meta.description;
      if (depth > maxDepth) { entry.limited = 'depth-limit'; truncated++; }
      else if (budget <= 0) { entry.limited = 'node-limit'; truncated++; }
      else {
        budget--;
        entry.limited = undefined;
        await observeChild(entry, { binding, files, readEvents, options });
        // The native request shape decides the completion rule, not our guess.
        if (entry.meta?.requestShape === 'background') entry.background = true;
        else if (entry.meta?.requestShape === 'foreground') entry.background = false;
        entry.agentToolIds = collectAgentToolIds(entry.projection, entry.agentToolIds ?? []);
        for (const id of entry.agentToolIds) if (!byToolId.has(id)) byToolId.set(id, claudeNodeId(nativeId));
        // A grandchild pairs through the Agent tool result its own transcript
        // holds; it is admitted here, never inferred from a directory listing.
        for (const [childId, record] of Object.entries(entry.projection.children ?? {})) {
          if (!record || typeof record.agentId !== 'string' || discovered.has(childId)) continue;
          discovered.set(childId, record);
          if (!candidates.includes(childId)) candidates.push(childId);
        }
      }
      parents.set(nativeId, parentSessionId);
      placedDepth.set(claudeNodeId(nativeId), depth);
      progress = true;
    }
  }
  const placed = [...parents.keys()]
    .sort((left, right) => (placedDepth.get(claudeNodeId(left)) ?? 0) - (placedDepth.get(claudeNodeId(right)) ?? 0)
      || String(treeState.nodes[left]?.name ?? '').localeCompare(String(treeState.nodes[right]?.name ?? '')));
  for (const nativeId of placed) {
    pushNode(treeState.nodes[nativeId], parents.get(nativeId), placedDepth.get(claudeNodeId(nativeId)));
    order.push(nativeId);
  }
  // An agent meta that names no id observed in this session is never attached; it
  // is reported instead, and one that is not finished keeps the tree unsettled.
  const unpaired = [...indexedMetas.keys()].filter(nativeId => !parents.has(nativeId));
  const unpairedRunning = unpaired.filter(nativeId => indexedMetas.get(nativeId)?.finished !== true);
  for (const entry of Object.values(treeState.nodes)) trimMessages(entry.projection);

  treeState.root = { sessionId: binding.sessionId, transcriptFile: binding.transcriptFile };
  treeState.order = order;
  treeState.truncated = truncated;

  const descendants = nodes.slice(1);
  const running = nodes.some(node => node.status === 'running');
  const unverified = descendants.filter(node => node.status === 'unverified');
  const settled = !running && unverified.length === 0 && unpairedRunning.length === 0
    && nodes.every(node => node.status === 'ended');
  // Non-root history is served per node, keyed by the same internal node id the
  // tree publishes, so the adapter never reads another session's transcript.
  const histories = {};
  for (const node of descendants) {
    const omitted = treeState.nodes[node.nativeAgentId]?.projection?.messagesOmitted ?? 0;
    histories[node.sessionId] = { messages: node.messages ?? [], hasMore: omitted > 0 };
  }
  return { tree: { version: CLAUDE_TREE_VERSION, settled, running, nodes,
    ...(unverified.length ? { unverified: unverified.map(node => node.sessionId), limitation: CLAUDE_TREE_LIMITATION } : {}),
    ...(unpaired.length ? { unpaired } : {}),
    ...(unpairedRunning.length ? { unpairedRunning } : {}),
    ...(unindexed.length ? { unindexed } : {}),
    ...(truncated ? { truncated } : {}) }, state: treeState, histories };
}

/** Normalized messages for exactly one node, for the adapter's history reply. */
export function claudeTreeNodeMessages(tree, { sessionId, name, parentName } = {}, { maxMessages = 20 } = {}) {
  const nodes = tree?.nodes ?? [];
  let node;
  if (typeof sessionId === 'string') node = nodes.find(entry => entry.sessionId === sessionId);
  if (!node && typeof name === 'string') {
    const matches = nodes.filter(entry => entry.name === name
      && (parentName === undefined || nodes.find(parent => parent.sessionId === entry.parentSessionId)?.name === parentName));
    if (matches.length === 1) node = matches[0];
  }
  if (!node) return { found: false, messages: [], hasMore: false };
  const messages = node.messages ?? [];
  return { found: true, sessionId: node.sessionId, name: node.name, status: node.status,
    activity: node.activity, changes: node.changes ?? [], coverage: node.coverage,
    messages: messages.slice(-maxMessages), hasMore: messages.length > maxMessages };
}

/**
 * Proof that a whole tree stopped, not just that its root looks idle. `afterSeq`
 * is the root transcript cursor at the moment cancellation was requested: every
 * node must show a finished turn at or after it, and no Agent tool may be left
 * unanswered anywhere in the tree.
 */
export function claudeTreeStopEvidence(tree, { afterSeq = 0 } = {}) {
  const nodes = tree?.nodes ?? [];
  const pendingAgentTools = nodes.flatMap(node => node.pendingAgentTools ?? []);
  // The root's own open Agent tool is covered by the root turn's own proof (the
  // registry status or the recorded interrupt); only a descendant that still has
  // an unanswered Agent call is unproven work.
  const descendantPending = nodes.filter(node => node.parentSessionId)
    .flatMap(node => node.pendingAgentTools ?? []);
  const evidence = nodes.map(node => ({ sessionId: node.sessionId, parentSessionId: node.parentSessionId,
    name: node.name, status: node.status, evidence: node.evidence ?? (node.parentSessionId ? 'observed' : 'root-observation'),
    endSeq: node.endSeq ?? node.lastSeq ?? 0,
    endedAfterCancel: node.status === 'ended' && Number(node.endSeq ?? node.lastSeq ?? 0) >= afterSeq }));
  const stopped = tree?.running === false && (tree?.unverified ?? []).length === 0
    && (tree?.unpairedRunning ?? []).length === 0
    && nodes.every(node => node.status === 'ended')
    && evidence.every(item => item.endedAfterCancel) && descendantPending.length === 0;
  return { stopped, afterSeq, pendingAgentTools, ...(descendantPending.length ? { descendantPending } : {}),
    nodes: evidence, ...(stopped ? {} : { limitation: CLAUDE_TREE_LIMITATION }) };
}

/** The native files this tree read, so a caller can verify deletion afterwards. */
export function claudeTreeFiles(treeState) {
  return Object.values(treeState?.nodes ?? {}).filter(entry => typeof entry?.file === 'string')
    .map(entry => ({ agentId: entry.agentId, file: entry.file, transcriptRead: (entry.projection?.throughSeq ?? 0) > 0 }));
}

/**
 * What a whole-tree cancel still has to stop: one entry per node that is not
 * finished, with the native task id the host's per-task stop takes (the same id
 * as its `<session>/tasks/<agentId>.output` file). This function stops nothing.
 */
export function claudeTreeStopTargets(tree) {
  return (tree?.nodes ?? []).filter(node => node.status !== 'ended')
    .map(node => ({ sessionId: node.sessionId, name: node.name ?? null, depth: node.depth ?? 0,
      status: node.status, evidence: node.evidence ?? null,
      // The root is stopped by the session interrupt; a child by its task id.
      ...(node.parentSessionId
        ? (typeof node.nativeAgentId === 'string' ? { taskId: node.nativeAgentId } : {})
        : { root: true }) }));
}

/**
 * Whole-tree cancellation check. This function cancels nothing by itself and
 * never touches the app: the adapter performs the root interrupt (host.interrupt)
 * and then calls this with `afterSeq` = the root cursor at the moment it asked.
 * It re-observes every node and reports what is really stopped. A descendant that
 * is still running is named with its evidence; there is no external kill call for
 * a background subagent in the native files observed so far, so nothing here
 * pretends to have stopped it.
 */
export async function cancelClaudeTree(binding, rootProjection, options = {}) {
  const { afterSeq, ...rest } = options;
  const observed = await observeClaudeTree(binding, rootProjection, { ...rest, state: rest.state ?? {} });
  const tree = observed.tree;
  const cursor = Number.isSafeInteger(afterSeq) ? afterSeq : rootProjection?.throughSeq ?? 0;
  const evidence = claudeTreeStopEvidence(tree, { afterSeq: cursor });
  return {
    stopped: evidence.stopped,
    remaining: tree.nodes.filter(node => node.status !== 'ended')
      .map(node => ({ sessionId: node.sessionId, name: node.name, status: node.status, evidence: node.evidence })),
    evidence, tree, state: observed.state,
    method: 'observe-only',
    limitation: 'The root interrupt is the adapter\'s call. A background child is stopped only when its own native evidence says so; no external per-subagent kill is issued here.',
  };
}
