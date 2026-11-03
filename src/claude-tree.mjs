// Claude Desktop descendant tree. The root projection already pairs each
// successful Agent tool result with the child's native agentId; this module
// follows exactly those pairs into the child's own native transcript, and never
// attaches a session by directory proximity, cwd, or a matching title.
//
// Nothing new is stored here: every node's incremental cursor rides in the same
// backend_state row as the root's own observation (`treeState`), which this
// function returns so the caller can save it unchanged. A node without positive
// native evidence of a finished turn is never reported as settled, so a running
// background child blocks a final report and one-shot cleanup instead of the
// tree looking idle. Nodes already known from earlier observations keep being
// read: a child that outlives the turn that launched it cannot disappear from
// the tree.
import path from 'node:path';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { CLAUDE_FILE_COVERAGE, emptyClaudeProjection, observeClaudeTranscript } from './claude-observer.mjs';
import { readClaudeEvents } from './claude-inbox.mjs';

export const CLAUDE_TREE_VERSION = 1;
/** Task-tree protocol level this adapter observes (see agent-backend.mjs). */
export const TREE_PROTOCOL = 1;
export const CLAUDE_TREE_LIMITATION = 'Only a successful Agent/Task tool result that returned a native agentId is followed, and only inside this session\'s own subagents directory. Children whose transcript cannot be located or read stay unverified, which keeps the tree unsettled instead of guessing.';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const STORED_MESSAGES = 20;
const DEFAULT_MAX_NODES = 32;
const DEFAULT_MAX_DEPTH = 4;
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
 * Read only the head of one native transcript to learn which session id its
 * lines carry and whether they are marked as sidechain. Both are properties of
 * the file that the shared reader filters on, so they are measured, not guessed.
 */
async function probeTranscript(file, { maxBytes = 131072 } = {}) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (!size) return { sessionId: undefined, sidechain: false, size };
    const buffer = Buffer.alloc(Math.min(maxBytes, size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let sessionId, sidechainLines = 0, plainLines = 0;
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (sessionId === undefined && typeof event.sessionId === 'string') sessionId = event.sessionId;
      if (!['user', 'assistant', 'system'].includes(event.type)) continue;
      if (event.isSidechain === true) sidechainLines++;
      else plainLines++;
    }
    return { sessionId, sidechain: sidechainLines > plainLines, size };
  } finally { await handle.close(); }
}

/** `agent-<agentId>.jsonl` files, only under this session's own directory. */
async function indexSubagentTranscripts(directory, { maxDepth = DEFAULT_MAX_DEPTH, maxFiles = 64 } = {}) {
  const found = new Map();
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && found.size < maxFiles) await walk(file, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.jsonl$/i.test(entry.name)) continue;
      const match = /^agent-(.+)\.jsonl$/i.exec(entry.name);
      if (!match || found.has(match[1]) || found.size >= maxFiles) continue;
      found.set(match[1], file);
    }
  };
  await walk(directory, 0);
  return found;
}

/**
 * The native `<agent>.meta.json` beside each subagent transcript. Measured on
 * Claude Desktop 2.1.309: {agentType, description, toolUseId, spawnDepth,
 * requestShape, finished}. `toolUseId` is the Agent tool_use the parent emitted,
 * so it cross-checks the pairing, and `finished` is the host's own completion
 * marker — a subagent does not always end its transcript with a stop_reason.
 */
async function readNativeMeta(entry) {
  if (!entry.file) return undefined;
  const metaFile = entry.file.replace(/\.jsonl$/i, '.meta.json');
  let value;
  try { value = JSON.parse((await readFile(metaFile, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  return metaShape(value, metaFile);
}

function metaShape(value, file) {
  return { file, finished: value.finished === true,
    ...(value.finished === false ? { running: true } : {}),
    ...(typeof value.toolUseId === 'string' ? { toolUseId: value.toolUseId } : {}),
    ...(typeof value.parentAgentId === 'string' ? { parentAgentId: value.parentAgentId } : {}),
    ...(Number.isSafeInteger(value.spawnDepth) ? { spawnDepth: value.spawnDepth } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.agentType === 'string' ? { agentType: value.agentType } : {}),
    ...(typeof value.requestShape === 'string' ? { requestShape: value.requestShape } : {}) };
}

/** Every native agent meta in this session's own directory, keyed by agentId. */
async function indexSubagentMetas(index) {
  const metas = new Map();
  for (const [agentId, file] of index) {
    const metaFile = file.replace(/\.jsonl$/i, '.meta.json');
    try { metas.set(agentId, metaShape(JSON.parse((await readFile(metaFile, 'utf8')).replace(/^\uFEFF/, '')), metaFile)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return metas;
}

/** Agent/Task tool_use ids this node emitted; the native pairing anchor. */
function collectAgentToolIds(projection, previous = []) {
  const ids = new Set(previous);
  for (const message of projection?.messages ?? []) {
    for (const tool of message.tools ?? []) {
      if (AGENT_TOOLS.has(tool?.name) && typeof tool.id === 'string') ids.add(tool.id);
    }
  }
  return [...ids].slice(-500);
}

/** A subagent that handed its result back is finished, whatever its stop reason. */
function handedBack(projection) {
  const last = [...(projection.messages ?? [])].reverse()
    .find(message => message.role === 'assistant' && message.tools?.length);
  const handback = last?.tools?.find(tool => tool.name === 'SubagentHandback');
  return Boolean(handback) && (projection.completedTools ?? []).includes(handback.id);
}

function nodeCoverage(entry) {
  if (entry.limited) return { source: entry.limited, complete: false,
    limitation: entry.limited === 'depth-limit'
      ? 'This child is deeper than the observed depth limit, so its own transcript was not read.'
      : 'This child was not read because the per-observation node limit was reached.' };
  if (!entry.file) return { source: 'missing-agent-transcript', complete: false,
    limitation: 'The Agent result named a native agentId but no transcript for it exists in this session directory.' };
  if (entry.filtered) return { source: 'filtered-agent-transcript', complete: false,
    limitation: 'The transcript exists but none of its lines match the observed session id and sidechain marker.' };
  return CLAUDE_FILE_COVERAGE;
}

/** Status of one child, from native evidence only; every branch names its proof. */
function childStatus(entry, { quietPolls }) {
  if (entry.limited) {
    return !entry.background && entry.resultSeq !== undefined
      ? { status: 'ended', evidence: 'parent-agent-tool-result', activity: `not read: ${entry.limited}` }
      : { status: 'unverified', evidence: entry.limited, activity: `not read: ${entry.limited}` };
  }
  if (!entry.background && entry.resultSeq !== undefined) {
    return { status: 'ended', evidence: 'parent-agent-tool-result',
      activity: entry.resultStatus ? `agent ${entry.resultStatus}` : 'agent result returned' };
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
  const pending = Object.values(entry.projection.pendingTools ?? {});
  if (pending.length) return { status: 'running', evidence: 'pending-tool', activity: `tool: ${pending.at(-1).name}` };
  if (entry.meta?.running === true) {
    return { status: 'running', evidence: 'agent-meta-running',
      activity: 'native agent meta still reports an unfinished subagent' };
  }
  if (handedBack(entry.projection)) {
    return { status: 'ended', evidence: 'subagent-handback', endSeq: entry.projection.throughSeq ?? 0,
      activity: 'subagent handed its result back' };
  }
  const completed = (entry.projection.completions ?? []).at(-1);
  if (completed) {
    if (entry.background && !entry.meta && (entry.quiet ?? 0) < quietPolls) {
      return { status: 'running', evidence: 'turn-ended-unconfirmed',
        activity: 'turn ended; waiting for the background child to stay quiet' };
    }
    return { status: 'ended', evidence: 'own-transcript-turn-end', endSeq: completed.seq,
      activity: `turn-ended: ${completed.reason?.kind ?? 'completed'}` };
  }
  const last = entry.projection.messages?.at(-1);
  return { status: 'running', evidence: 'no-completed-turn',
    activity: last?.role === 'assistant' ? 'responding' : 'launched; no completed turn yet' };
}

/**
 * Read one child transcript incrementally into its own stored projection.
 * The session id and sidechain marker come from the file's own head; if the
 * marker proves useless (nothing passes the reader's filter) it is flipped once.
 */
async function observeChild(entry, { binding, index, readEvents, options }) {
  if (!entry.file) entry.file = index.get(entry.agentId) ?? undefined;
  if (!entry.file) return;
  entry.sample ??= await probeTranscript(entry.file);
  entry.meta = await readNativeMeta(entry);
  if (entry.meta?.description && !entry.name) entry.name = entry.meta.description;
  if (entry.sample.sessionId === undefined) return; // empty transcript: nothing to pair yet
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
  try { entry.size = (await stat(entry.file)).size; } catch { entry.size = entry.sample.size; }
  const previous = entry.lastSize;
  entry.lastSize = entry.size;
  if (previous === undefined) entry.quiet = 0;
  else if (entry.size === previous && (entry.projection.completions ?? []).length) entry.quiet = (entry.quiet ?? 0) + 1;
  else if (entry.size !== previous) entry.quiet = 0;
}

function trimMessages(projection) {
  if (!Array.isArray(projection?.messages) || projection.messages.length <= STORED_MESSAGES) return projection;
  projection.messagesOmitted = (projection.messagesOmitted ?? 0) + projection.messages.length - STORED_MESSAGES;
  projection.messages = projection.messages.slice(-STORED_MESSAGES);
  return projection;
}

function pendingAgentTools(projection) {
  return Object.values(projection?.pendingTools ?? {}).filter(tool => AGENT_TOOLS.has(tool?.name))
    .map(tool => tool.id);
}

/**
 * Observe one Claude Desktop root session and its explicitly paired descendants.
 * @param {object} binding Root binding (sessionId + transcriptFile) verified by the adapter.
 * @param {object} rootProjection The incremental projection observeClaudeTranscript maintains for the root.
 * @param {object} options logicalSessionId, agentId, name, workspace, state, taskId,
 *   nativeStatus (the native registry status, 'idle' when the session is at rest),
 *   plus readEvents / maxNodes / maxDepth / quietPolls overrides for tests.
 * @returns {{tree: object, state: object, histories: object}} tree for the shared FSM,
 *   the treeState to persist in backend_state, and per-node normalized history.
 */
export async function observeClaudeTree(binding, rootProjection, {
  logicalSessionId, agentId, name, workspace, state = {}, taskId, nativeStatus,
  readEvents = readClaudeEvents, maxNodes = DEFAULT_MAX_NODES, maxDepth = DEFAULT_MAX_DEPTH,
  quietPolls = 1,
} = {}) {
  if (typeof logicalSessionId !== 'string' || !logicalSessionId) {
    throw fail('claude-tree-root-required', 'A logical session id is required to name the root of the task tree.');
  }
  if (typeof binding?.transcriptFile !== 'string' || !binding.transcriptFile || typeof binding.sessionId !== 'string') {
    throw fail('claude-tree-binding-required', 'The bound Claude session must carry its native session id and transcript file.');
  }
  const rootDirectory = path.join(path.dirname(binding.transcriptFile), binding.sessionId);
  const index = await indexSubagentTranscripts(rootDirectory, { maxFiles: Math.max(8, maxNodes * 2) });
  const treeState = normalizeState(state);
  const options = { workspace };
  const rootPending = Object.values(rootProjection.pendingTools ?? {});
  const rootCompleted = (rootProjection.completions ?? []).at(-1);
  const rootRunning = rootPending.length > 0
    || (typeof nativeStatus === 'string' ? nativeStatus !== 'idle' : !rootCompleted);
  const nodes = [{ sessionId: logicalSessionId, parentSessionId: null,
    name: typeof name === 'string' && name ? name : null, mode: 'root', depth: 0,
    nativeAgentId: agentId ?? null,
    status: rootRunning ? 'running' : 'ended',
    activity: rootPending.length ? `tool: ${rootPending.at(-1).name}` : rootProjection.activity ?? 'unknown',
    changes: (rootProjection.changes ?? []).slice(0, 32), coverage: CLAUDE_FILE_COVERAGE,
    messages: rootProjection.messages ?? [], lastSeq: rootProjection.throughSeq ?? 0,
    pendingAgentTools: pendingAgentTools(rootProjection) }];
  const order = [];
  let budget = maxNodes;
  let truncated = 0;

  const pushNode = (entry, parentSessionId, depth) => {
    const known = entry ?? { agentId: undefined, projection: emptyClaudeProjection('claude-tree-unknown') };
    const state = childStatus(known, { quietPolls });
    nodes.push({ sessionId: claudeNodeId(known.agentId), parentSessionId,
      name: known.name ?? null, mode: known.background ? 'background-subagent' : 'foreground-subagent',
      depth, nativeAgentId: known.agentId, status: state.status, activity: state.activity,
      ...(known.meta?.spawnDepth !== undefined ? { nativeDepth: known.meta.spawnDepth } : {}),
      ...(known.meta?.agentType ? { agentType: known.meta.agentType } : {}),
      changes: (known.projection.changes ?? []).slice(0, 32), coverage: nodeCoverage(known),
      messages: known.projection.messages ?? [], lastSeq: known.projection.throughSeq ?? 0,
      evidence: state.evidence, ...(state.endSeq !== undefined ? { endSeq: state.endSeq } : {}),
      pendingAgentTools: pendingAgentTools(known.projection), background: known.background === true });
  };

  // A node is placed only by an explicit native pair: its own meta.toolUseId is
  // an Agent tool_use id already seen in the parent it names (meta.parentAgentId
  // or the parent session itself), or a successful Agent tool result returned its
  // agentId. Nothing is attached by directory proximity, cwd, title, or recency.
  const indexedMetas = await indexSubagentMetas(index);
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
        await observeChild(entry, { binding, index, readEvents, options });
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
  // An agent meta that names no id we observed is never attached; it is reported
  // instead, and one that is not finished keeps the tree unsettled.
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
  const evidence = nodes.map(node => ({ sessionId: node.sessionId, parentSessionId: node.parentSessionId,
    name: node.name, status: node.status, evidence: node.evidence ?? (node.parentSessionId ? 'observed' : 'root-observation'),
    endSeq: node.endSeq ?? node.lastSeq ?? 0,
    endedAfterCancel: node.status === 'ended' && Number(node.endSeq ?? node.lastSeq ?? 0) >= afterSeq }));
  const stopped = tree?.running === false && (tree?.unverified ?? []).length === 0
    && nodes.every(node => node.status === 'ended')
    && evidence.every(item => item.endedAfterCancel) && pendingAgentTools.length === 0;
  return { stopped, afterSeq, pendingAgentTools, nodes: evidence,
    ...(stopped ? {} : { limitation: CLAUDE_TREE_LIMITATION }) };
}

/** The native files this tree read, so a caller can verify deletion afterwards. */
export function claudeTreeFiles(treeState) {
  return Object.values(treeState?.nodes ?? {}).filter(entry => typeof entry?.file === 'string')
    .map(entry => ({ agentId: entry.agentId, file: entry.file, transcriptRead: (entry.projection?.throughSeq ?? 0) > 0 }));
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
