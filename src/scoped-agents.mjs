import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createControl, endedState, modelTurnError } from './control.mjs';
import { FutureAideClient } from './futureaide-api.mjs';
import { resolveModel } from './agents.mjs';
import { invokeCodexTool } from './codex-notify.mjs';
import { callingThread, ownerIdFor, ownerIdForSource, resolveCallingContext, threadFromResult, trustedCaller } from './calling-context.mjs';
import { bindClaude, discoverClaude, readClaudeEvents, sendClaude } from './claude-inbox.mjs';
import { resolveNativeSession } from './claude-host.mjs';
import { RosterStore } from './roster-store.mjs';
import { canSleep } from './idle-monitor-eligibility.mjs';
import { idleSignal } from './idle-monitor.mjs';
import { ensureSharedMonitor, monitorAlive } from './shared-monitor.mjs';
import { readReportStatus, reportPort, reportUrl, rosterIdentity } from './report-endpoint.mjs';
import { diagnoseTarget, DSH_HOST_METHODS, hostLabel, normalizeTarget, resolveBackend,
  TARGET_REQUIRES_REPORT_SERVICE, targetOf } from './agent-backend.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const uid = prefix => `${prefix}-${randomUUID().replaceAll('-', '')}`;
const now = () => new Date().toISOString();
const ACTIVE = new Set(['creating', 'running', 'awaiting_input', 'awaiting_report', 'reconnecting', 'delivery_pending', 'cleaning']);
const METHODS = DSH_HOST_METHODS;
const TREE_PROTOCOL = 1;
const REPORT_PROTOCOL = 1;
let codexProbePromise;
/** codex-host's own registration probe, imported lazily so only the Codex path loads it. */
function defaultCodexProbe() {
  codexProbePromise ??= import('./codex-host.mjs')
    .then(module => module.probeCodexReportRegistration)
    .catch(() => undefined);
  return codexProbePromise;
}
const reportProtocolError = (host = 'DSH') => Object.assign(new Error(`Update the ${host} plugin bridge and reload the plugin/MCP connection to enable explicit reports; restarting ${host} is not required.`), { code: 'report-protocol-required' });
const treeProtocolError = (host = 'DSH') => Object.assign(new Error(`The ${host} bridge and caller must support task-tree protocol 1. Update the plugin bridge and reload the plugin/MCP connection; restarting ${host} is not required.`), { code: 'tree-protocol-required' });
const safeError = error => ({ code: error?.code ?? 'operation-failed', message: String(error?.message ?? error).slice(0, 1200) });

function assertName(name) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name)) {
    throw new Error('Use a nonempty subagent name of at most 80 characters, without leading/trailing whitespace.');
  }
  return name;
}
function textMessage(message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw new Error('A message of 1–100000 characters is required.');
  return message;
}
function stableHost(identity) {
  return { application: identity.application ?? null, dataRoot: path.resolve(identity.dataRoot ?? '') };
}
const fileSummary = change => ({ path: change.path, operation: change.operation,
  ...(change.agentPath ? { agentPath: change.agentPath } : {}) });
const compactText = (value, length) => typeof value === 'string' && value.length > length ? value.slice(0, length) + '…' : value;

// Native IDs stay internal. Even a malformed snapshot cannot expose an unrelated
// session: a node must have an acyclic parent chain to this named agent's root.
function ownedTree(record, view) {
  const source = view.tree?.nodes ?? [];
  const byId = new Map(source.filter(node => typeof node?.sessionId === 'string').map(node => [node.sessionId, node]));
  const root = byId.get(record.sessionId);
  const nodes = [];
  if (root && root.parentSessionId == null) {
    for (const node of byId.values()) {
      const names = [], visited = new Set();
      let current = node;
      while (current && !visited.has(current.sessionId)) {
        visited.add(current.sessionId);
        if (current.sessionId === record.sessionId) {
          names.unshift(record.name);
          nodes.push({ node, agentPath: names, depth: names.length - 1 });
          break;
        }
        names.unshift(typeof current.name === 'string' && current.name ? current.name : 'subagent');
        current = byId.get(current.parentSessionId);
      }
    }
  }
  nodes.sort((a, b) => a.depth - b.depth);
  return { nodes, complete: nodes.length > 0 && nodes.length === source.length };
}

function treeSettled(record, view) {
  return !record.task?.cancelPending && view.tree?.settled === true && view.tree.running === false && ownedTree(record, view).complete;
}

function rootSummary(view) {
  const summary = view.tree?.rootSummary;
  return summary?.ready === true && typeof summary.reply === 'string'
    && ['completed', 'failed', 'cancelled'].includes(summary.state) ? summary : undefined;
}

function attributedChanges(record, view) {
  const tree = ownedTree(record, view);
  if (!tree.nodes.length) return (view.changes ?? []).map(change => ({ ...change, agentPath: [record.name] }));
  return tree.nodes.flatMap(({ node, agentPath }) => (node.changes ?? []).map(change => {
    const { sessionId, parentSessionId, agentId, ...file } = change;
    return { ...file, agentPath };
  }));
}

function publicTree(record, view) {
  const { nodes, complete } = ownedTree(record, view);
  const observationError = view.tree?.observationError ?? view.observationError;
  return { settled: complete && view.tree?.settled === true && view.tree.running === false,
    running: view.tree?.running ?? view.running ?? false,
    ...(observationError ? { observationError: safeError(observationError) } : {}),
    nodes: nodes.map(({ node, agentPath, depth }) => ({ name: agentPath.at(-1),
      parentName: depth ? agentPath.at(-2) : null, agentPath, depth, status: node.status,
      activity: node.activity, changes: (node.changes ?? []).slice(0, 12).map(change => fileSummary({ ...change, agentPath })),
      coverage: node.coverage ?? 'Not observed' })) };
}

function treeCoverage(record, view) {
  const { nodes } = ownedTree(record, view);
  return nodes.length > 1 ? { scope: `${hostLabel(record)} task tree`,
    nodes: nodes.map(({ node, agentPath }) => ({ agentPath, coverage: node.coverage ?? 'Not observed' })) }
    : view.coverage ?? 'Not observed yet; zero known files is not a complete filesystem audit.';
}

function publicResult(record, { fullResult = false } = {}) {
  const task = record.task;
  const lastDispatch = task?.dispatches?.at(-1);
  const error = record.error ?? task?.cancelError ?? (lastDispatch?.state === 'failed' ? lastDispatch.failure : undefined)
    ?? (!['completed', 'cancelled'].includes(lastDispatch?.state) ? lastDispatch?.error : undefined);
  const view = record.observation ?? {};
  const changes = attributedChanges(record, view);
  return {
    name: record.name, lifetime: record.lifetime, target: targetOf(record), state: record.state,
    task: task ? { text: compactText(task.message, 240), state: task.state, startedAt: task.startedAt,
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.result ? { result: { state: task.result.state,
        ...(fullResult ? { reply: task.result.reply } : { summary: compactText(task.result.reply, 800) }),
        files: (task.result.changes ?? []).map(fileSummary), coverage: task.result.coverage } } : {}) } : null,
    activity: view.activity ?? (record.state === 'idle' ? 'Waiting for a task' : record.state),
    changes: { count: changes.length, files: changes.slice(0, 12).map(fileSummary),
      coverage: treeCoverage(record, view),
      observedAt: view.capturedAt ?? null, stale: Boolean(view.stale) },
    questions: (view.questions ?? []).filter(question => question.state === 'pending').map(question => ({ message: question.message })),
    tree: publicTree(record, view),
    reports: { total: task?.reports?.length ?? 0, pending: (task?.reports ?? []).filter(report => report.delivery.state !== 'delivered').length,
      ...(task?.reports?.length ? { latest: { summary: compactText(task.reports.at(-1).message, 240), final: task.reports.at(-1).final, delivery: task.reports.at(-1).delivery.state } } : {}) },
    delivery: task?.reports?.find(report => report.delivery.state !== 'delivered')?.delivery.state ?? task?.reports?.at(-1)?.delivery.state ?? null, updatedAt: record.updatedAt,
    ...(record.callbackBlocked ? { callbackError: { code: 'native-callback-unavailable', message: 'The desktop does not permit background reports to this native multi-agent v2 sub-agent.' } } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Native receipt for a Claude notice. Our request id survives as the queue,
 * attachment or user uuid, so the delivery record — not the transcript text — is
 * the evidence: the reader truncates text at 8k, which would drop the trailing
 * marker of a long report.
 * @param {Array<{requestId: string, stage: string, seq?: number}>} deliveries
 * @param {string} requestId
 */
export function claudeNoticeReceipt(deliveries, requestId) {
  if (!Array.isArray(deliveries) || typeof requestId !== 'string') return undefined;
  return deliveries.find(item => item?.requestId === requestId && ['accepted', 'inserted'].includes(item.stage));
}

const CLAUDE_STALE_BINDING = ['claude-session-changed', 'claude-process-replaced', 'claude-inbox-key-mismatch',
  'claude-binding-mismatch', 'claude-transcript-unresolved', 'claude-binding-invalid', 'claude-transcript-replaced'];

/** A cached Claude transport binding the session has outgrown: refresh it once. */
export const claudeBindingStale = error =>
  CLAUDE_STALE_BINDING.some(code => String(error?.message ?? error ?? '').includes(code));

const CLAUDE_PAGE_BYTES = 1 << 20;
const CLAUDE_MAX_PAGE_BYTES = 16 << 20;
const CLAUDE_PAGES_PER_POLL = 8;

/**
 * Complete-line byte cursor at the current end of a transcript: where a new notice
 * starts looking for its receipt. Only a small tail window is read, so a long parent
 * chat costs the same as an empty one.
 */
export async function transcriptCursor(binding) {
  const handle = await open(binding.transcriptFile, 'r');
  try {
    const { size } = await handle.stat();
    const window = Math.min(size, 64 * 1024);
    if (!window) return 0;
    const buffer = Buffer.alloc(window);
    await handle.read(buffer, 0, window, size - window);
    const lastBreak = buffer.lastIndexOf(10);
    // A tail with no line break cannot be a cursor; start over rather than misalign.
    return lastBreak === -1 ? 0 : size - window + lastBreak + 1;
  } finally { await handle.close(); }
}

/**
 * Follow one notice's page window for its own request id, advancing the saved cursor
 * as it goes. Pages continue on the next poll instead of rescanning history, and a
 * line longer than a page retries at the reader's 16MiB ceiling.
 * @param {object} binding Native transport binding.
 * @param {{id: string, cursor?: number}} notice Persisted notice; its cursor advances.
 */
export const claudeNoticeRequestId = id => /^[a-zA-Z0-9-]{1,100}$/.test(id)
  ? id : `notice-${createHash('sha256').update(id).digest('hex')}`;

export async function findClaudeReceipt(binding, notice) {
  let cursor = Number.isSafeInteger(notice.cursor) ? notice.cursor : 0;
  for (let page = 0; page < CLAUDE_PAGES_PER_POLL; page++) {
    let read;
    try { read = await readClaudeEvents(binding, { offset: cursor, maxBytes: CLAUDE_PAGE_BYTES }); }
    catch (error) {
      if (!String(error?.message ?? '').includes('line-exceeds-page') || CLAUDE_PAGE_BYTES >= CLAUDE_MAX_PAGE_BYTES) throw error;
      read = await readClaudeEvents(binding, { offset: cursor, maxBytes: CLAUDE_MAX_PAGE_BYTES });
    }
    const matched = claudeNoticeReceipt(read.deliveries, claudeNoticeRequestId(notice.id));
    const next = Number.isSafeInteger(read.offset) ? read.offset : cursor;
    notice.cursor = next;
    if (matched) return matched;
    if (read.hasMore !== true || next <= cursor) return undefined;
    cursor = next;
  }
  return undefined;
}

/** Name-addressed operations; owner and native identifiers never come from tool arguments. */
export function createScopedAgents(config, {
  store = new RosterStore(path.join(config.stateDirectory, 'roster.sqlite')),
  callCodex = invokeCodexTool,
  clientFactory = settings => new FutureAideClient({ dataHome: settings.dataRoot, dshDataHome: settings.dshDataRoot,
    target: settings.target, instanceFile: settings.instanceFile, preferredInstanceFile: settings.preferredInstanceFile,
    baseUrl: settings.baseUrl, timeoutMs: settings.timeoutMs, hostBridgeFile: settings.hostBridgeFile }),
  controlFactory = createControl,
  startSharedMonitor = ensureSharedMonitor,
  monitorFailureGraceMs = 60000,
  removeTree = rm,
  backendAdapters = {},
  backendAdapterLoader = undefined,
  reportStatusProbe = readReportStatus,
  codexReportReady = undefined,
  codexToolsStatus = undefined,
  codexProbeRegistration = undefined,
  reportReadyTimeoutMs = 2000,
  onPollComplete = () => {},
} = {}) {
  const clients = new Map();
  const operationBackends = new WeakMap();
  const inflight = new Map(), monitorInflight = new Map();
  const nextPollAt = new Map();
  let draining = false;
  let monitorUnavailableSince, monitorError;
  const agentDirectory = record => path.join(config.stateDirectory, 'scoped', record.ownerId, record.agentId);
  const settings = record => ({ ...config, target: targetOf(record), workspace: record.workspace,
    stateDirectory: agentDirectory(record), codexThreadId: undefined, futureaideSessionId: undefined });
  const hostArgs = record => ({ ownerId: record.ownerId, agentId: record.agentId,
    sessionId: record.sessionId, workspace: record.workspace, treeProtocol: TREE_PROTOCOL, reportProtocol: REPORT_PROTOCOL,
    ...(record.task ? { taskId: record.task.taskId } : {}) });
  // Handles an adapter needs on the shared side: the target's own state in its own
  // row (never inside the record the shared layer will save again) and one host
  // lock per target application, reusing the existing lease table.
  //
  // ensureClaudeReports() makes the loopback tool service ready and returns
  // {url, ready}: it starts THE shared monitor (the single host of that service —
  // never a service per MCP connection) and waits for its health check with a
  // short deadline. If the monitor cannot answer, ready is false with a reason; no
  // other process grabs the port. readClaudeReportStatus() only reads
  // readiness/registration, so a status probe can ask without starting anything.
  const adapterDeps = (record, { startReports = true } = {}) => {
    const load = () => store.get(record.agentId) ?? record;
    const target = targetOf(record);
    const readStatus = () => reportStatusProbe({ port: reportPort(config), expectedRoster: rosterIdentity(store) });
    return {
      load,
      requestDirectory: () => agentDirectory(load()),
      readNativeState: () => store.backendState(record.agentId),
      writeNativeState: value => store.saveBackendState(record.agentId, value),
      withHostLock: (action, { key } = {}) => store.locked(`backend:${target}${key ? `:${key}` : ''}`, action),
      ensureClaudeReports: () => (startReports ? ensureReportsReady() : readStatus()),
      readClaudeReportStatus: readStatus,
      ensureCodexReports: () => beginCodexReports(record),
      readCodexReportState: () => readCodexReportState(load()),
      // The Codex probe reads its protocol readiness only; this must never start a
      // session, so it is the same read-only evidence status uses.
      readCodexReportStatus: () => readCodexReportStatus(record),
      // A Codex child's bridge is anchored on a verified Codex chat, never on a Claude
      // session id, and the same resolver is offered both ways for its host options.
      anchorResolver: () => anchorResolver(load()),
      hostOptions: { anchorResolver: () => anchorResolver(load()) },
    };
  };
  async function ensureReportsReady() {
    const port = reportPort(config);
    await ensureMonitor();
    const deadline = Date.now() + reportReadyTimeoutMs;
    for (;;) {
      const status = await reportStatusProbe({ port, expectedRoster: rosterIdentity(store) });
      if (status.ready) return { ...status, via: 'monitor' };
      if (Date.now() >= deadline) break;
      await wait(50);
    }
    // The single monitor owns the service; this call never takes the port itself.
    return { port, url: reportUrl(port), ready: false, via: 'none',
      reason: { code: 'report-service-unavailable', message: 'The shared monitor that hosts the tool service did not answer in time.' } };
  }
  // The chosen backend is rebuilt per operation from the live record, so a new
  // task id or state never hides behind a cached binding. Only the DSH client
  // (one authenticated connection per agent) is kept.
  async function backendFor(record) {
    if (operationBackends.has(record)) return operationBackends.get(record);
    const pending = resolveRecordBackend(record);
    operationBackends.set(record, pending);
    try { return await pending; }
    catch (error) { operationBackends.delete(record); throw error; }
  }
  async function resolveRecordBackend(record) {
    const target = targetOf(record);
    const load = () => store.get(record.agentId) ?? record;
    const deps = { ...adapterDeps(record), reuseObservation: true };
    if (target === 'dsh') {
      if (!clients.has(record.agentId)) clients.set(record.agentId, clientFactory(settings(record)));
      const client = clients.get(record.agentId);
      return resolveBackend(record, { target, load, deps, dsh: { client, requestDirectory: deps.requestDirectory,
        control: () => controlFactory(settings(load()), { client, managed: hostArgs(load()) }),
        hostArgs: () => hostArgs(load()) } });
    }
    return resolveBackend(record, { target, load, deps, adapters: backendAdapters, ...(backendAdapterLoader ? { adapterLoader: backendAdapterLoader } : {}) });
  }
  const forgetBackend = record => { clients.delete(record.agentId); operationBackends.delete(record); };
  // A target without a usable adapter is refused before the name is taken, and is
  // never answered by the DSH path instead. Pre-conditions that would only fail
  // later (unfinished protocols, a tool service that never came up) are settled
  // here too, so a broken name is never left in the roster.
  async function ensureTargetBackend(record) {
    const target = targetOf(record);
    if (target === 'dsh') return target;
    const deps = adapterDeps(record);
    const backend = await resolveBackend(record, { target, load: () => record, deps, adapters: backendAdapters,
      ...(backendAdapterLoader ? { adapterLoader: backendAdapterLoader } : {}) });
    const probe = await backend.probe();
    const required = backend.requiredMethods ?? probe.methods ?? [];
    const label = backend.labels?.host ?? hostLabel(record);
    if (!required.every(method => probe.methods?.includes(method))) {
      throw Object.assign(new Error(`${backend.labels?.bridge ?? `The ${label} backend`} needs this plugin version installed before subagents can be created.`), { code: 'managed-host-required' });
    }
    if (probe.treeProtocol !== TREE_PROTOCOL) throw treeProtocolError(label);
    if (probe.reportProtocol !== REPORT_PROTOCOL) throw reportProtocolError(label);
    // A zero-model session whose tool endpoint is not up would make the target's
    // first turn call nothing. Refuse the name instead of creating it half-wired.
    if (TARGET_REQUIRES_REPORT_SERVICE[target] === true) {
      const endpoint = await deps.ensureClaudeReports();
      if (endpoint?.ready !== true) {
        throw Object.assign(new Error('The loopback tool service that managed sessions report through is not ready; no subagent was created.'),
          { code: 'report-service-unavailable', ...(endpoint?.reason ? { detail: endpoint.reason } : {}) });
      }
    }
    // A Codex Desktop name is useless without its own ask/report tool surface, and
    // an online endpoint alone does not mean those tools are registered.
    if (target === 'codex-desktop') {
      const endpoint = await deps.ensureCodexReports();
      if (endpoint?.ready !== true) {
        const reason = endpoint?.reason ?? { code: 'codex-tools-not-registered' };
        throw Object.assign(new Error('The Codex Desktop tool service is not ready; no subagent was created.'),
          { code: reason.code ?? 'codex-tools-not-registered', detail: reason, registered: endpoint?.registered === true });
      }
    }
    return target;
  }

  async function context(extra) {
    // The owner comes from a verified caller (Codex chat metadata or a verified
    // Claude native session); owner ids are namespaced by source, so the same name
    // in two applications never collides.
    const caller = trustedCaller(extra);
    const ownerId = caller ? ownerIdForSource(caller.source, caller.nativeSessionId) : ownerIdFor(callingThread(extra));
    return store.saveOwner(await resolveCallingContext(extra,
      { knownOwner: store.owner(ownerId), callCodex, verifyClaude, bindOwner: bindClaude }));
  }
  /**
   * Records this owner can see: its own, plus every managed descendant that a
   * session beneath it created — including descendants on another application,
   * which have their own owner id. One tree, one state machine.
   */
  function visibleRecords(ownerId) {
    const own = store.list(ownerId);
    return { own, all: [...own, ...store.descendantsOf(own.map(record => record.agentId))] };
  }
  function named(owner, name) {
    // Addressable names are this chat's own, exactly as in 0.5.7: a descendant's name
    // belongs to the session that created it and never hijacks this chat's namespace.
    const record = store.named(owner.ownerId, assertName(name));
    if (!record) throw Object.assign(new Error(`No subagent named “${name}” exists in this chat.`), { code: 'agent-not-found' });
    return record;
  }

  /** A Claude caller is checked against the native registry before it becomes an owner. */
  async function verifyClaude(caller) {
    const session = await resolveNativeSession(caller.nativeSessionId,
      { ...(caller.workspace ? { workspace: caller.workspace } : {}) });
    return { pid: session?.pid, workspace: session?.cwd ?? session?.workspace ?? caller.workspace };
  }

  /**
   * Bridge anchor for a Codex Desktop child: a Codex chat this plugin already
   * verified and saved in this roster, preferring the same project. A Claude session
   * id is never an anchor, because only a verified chat can carry a Codex bridge.
   * The object is the contract; toString() yields the thread id so a host that still
   * expects a plain string keeps working while it moves to the object.
   */
  function anchorResolver(record) {
    const owners = store.codexOwners();
    if (!owners.length) {
      throw Object.assign(new Error('No verified Codex chat is available to anchor this Codex Desktop session.'),
        { code: 'codex-anchor-unavailable' });
    }
    const anchor = owners.find(owner => owner.workspace === record?.workspace) ?? owners[0];
    return { threadId: anchor.threadId, ownerId: anchor.ownerId, workspace: anchor.workspace,
      toString() { return anchor.threadId; } };
  }

  /**
   * Codex-side explicit ask/report arrive through the shared submission queue. The
   * adapter surfaces them as its own questions/reports; the one state machine owns
   * delivery, so no second task or notice machine exists.
   */
  function readCodexReportState(record) {
    if (!record?.task) return { questions: [], reports: [] };
    const pending = store.submissions(record.agentId, record.task.taskId);
    // Both lists carry the task they belong to: the Codex backend filters by taskId, so
    // a question without it would be dropped before the shared layer ever saw it.
    return {
      questions: pending.filter(item => item.kind === 'ask').map(item => ({ id: `submission:${item.id}`,
        taskId: record.task.taskId, state: 'pending', message: item.message, createdAt: item.created })),
      reports: pending.filter(item => item.kind === 'report').map(item => ({ id: `submission:${item.id}`,
        taskId: record.task.taskId, message: item.message, final: item.final, createdAt: item.created })),
    };
  }
  /**
   * Position of a record in the managed graph: root/child/grand. It comes from the
   * saved parentAgentId edges, never from a name lookup, so same-named records at
   * different depths are reported separately.
   */
  function managedPath(record) {
    const names = [];
    const seen = new Set();
    let current = record;
    while (current && !seen.has(current.agentId)) {
      seen.add(current.agentId);
      names.unshift(current.name);
      current = current.parentAgentId ? store.get(current.parentAgentId) : undefined;
    }
    return names.join('/');
  }

  /**
   * The one read-only registration probe: a trusted entry in this project's effective
   * config that points at the same DEV tree and roster, plus that entry's real MCP
   * tools/list — exactly what codex-host.probeCodexReportRegistration answers. It never
   * starts a Codex session and never sends a model turn, so sessionVerified stays false
   * until a real dispatch proves otherwise.
   *
   * A caller may inject its own probe (tests, a host that owns the check); otherwise the
   * default is codex-host's own function, imported lazily so only the Codex path ever
   * loads it. Either way it is asked about this record's workspace and this config file.
   */
  async function probeCodexRegistration(record) {
    const probe = typeof codexProbeRegistration === 'function' ? codexProbeRegistration : await defaultCodexProbe();
    if (typeof probe !== 'function') {
      return { ready: false, registered: false, sessionVerified: false,
        reason: { code: 'codex-tools-not-registered', message: 'This build has no Codex registration probe.' } };
    }
    try {
      return (await probe({ workspace: record?.workspace ?? config.workspace,
        configPath: config.configFile })) ?? undefined;
    } catch (error) { return { ready: false, registered: false, sessionVerified: false, reason: safeError(error) }; }
  }
  /** Read-only Codex tool registration, for status: it never starts a session. */
  async function readCodexToolsStatus(record) {
    const probed = await probeCodexRegistration(record);
    if (probed) return probed;
    if (typeof codexToolsStatus !== 'function') return { registered: false };
    try { return (await codexToolsStatus(record)) ?? { registered: false }; }
    catch (error) { return { registered: false, reason: safeError(error) }; }
  }
  /**
   * Read-only status for the Codex backend's own probe, which fills reportProtocol
   * from it. `registered` means this project's effective MCP registration points at the
   * DEV entry over this same roster and that entry's tools/list carries ask_parent and
   * report_parent — verified by reading, never by starting a Codex session and never by
   * an HTTP answer. The first real dispatch proves the integration in a real session.
   */
  async function readCodexReportStatus(record) {
    const value = await readCodexToolsStatus(record);
    const registered = provenRegistration(value);
    return { ...value, ready: registered, registered, evidence: value?.evidence ?? 'registration',
      sessionVerified: value?.sessionVerified === true };
  }
  /** Both tool names, proven by whichever evidence the adapter has. */
  function provenRegistration(value) {
    return value?.registered === true && Array.isArray(value.tools)
      && ['ask_parent', 'report_parent'].every(tool => value.tools.includes(tool));
  }
  function codexToolsDiagnostics(value) {
    const registered = provenRegistration(value);
    return { ready: registered, present: true, registered, evidence: value?.evidence ?? 'registration',
      ...(registered ? {} : { reason: value?.reason ?? { code: 'codex-tools-not-registered',
        message: 'The Codex-side ask/report registration was not verified for this project.' } }) };
  }
  async function beginCodexReports(record) {
    // Preflight is read-only registration verification only: the project's effective MCP
    // entry must be the DEV entry over this roster and list both tools. It must not
    // create or reuse a Codex session — the first dispatch is the real integration test,
    // and a zero-model create stays zero-model. The host probe is the one source of that
    // evidence; codexReportReady stays as a fallback for a host that supplies it instead.
    const probed = await probeCodexRegistration(record);
    if (probed) {
      const registered = provenRegistration(probed);
      return { ...probed, ready: registered && probed.ready !== false, registered,
        evidence: probed.evidence ?? 'registration', sessionVerified: probed.sessionVerified === true,
        ...(registered ? {} : { reason: probed.reason ?? { code: 'codex-tools-not-registered',
          message: 'The Codex-side ask/report registration was not verified for this project.' } }) };
    }
    if (typeof codexReportReady !== 'function') {
      return { ready: false, registered: false,
        reason: { code: 'codex-tools-not-registered', message: 'This build does not register the Codex-side ask/report tools yet.' } };
    }
    const value = (await codexReportReady(record, { phase: 'preflight' })) ?? {};
    const registered = provenRegistration(value);
    if (value.ready !== true || !registered) {
      return { ...value, ready: false, registered,
        reason: value.reason ?? { code: 'codex-tools-not-registered',
          message: 'The Codex-side ask/report registration is not verified for this project.' } };
    }
    return { ...value, ready: true, registered, evidence: value.evidence ?? 'registration' };
  }

  /**
   * Fold pending explicit submissions into the task: a report becomes a task
   * report, an ask becomes a pending question. Task changes and consumption commit
   * together; the durable submission remains readable by the Codex backend.
   */
  function absorbSubmissions(record) {
    const pending = store.pendingSubmissions(record.agentId, record.task.taskId);
    if (!pending.length) return;
    let changed = false;
    for (const item of pending) {
      changed = true;
      if (item.kind === 'report') {
        record.task.reports ??= [];
        if (!record.task.reports.some(report => report.id === `submission:${item.id}`)) {
          record.task.reports.push({ id: `submission:${item.id}`, taskId: record.task.taskId,
            message: item.message, final: item.final, createdAt: item.created, delivery: { state: 'pending' } });
        }
      } else {
        record.observation ??= {};
        record.observation.questions ??= [];
        if (!record.observation.questions.some(question => question.id === `submission:${item.id}`)) {
          record.observation.questions.push({ id: `submission:${item.id}`, state: 'pending', message: item.message });
        }
        record.state = 'awaiting_input';
      }
    }
    if (changed) store.saveAndConsumeSubmissions(record, pending.map(item => item.id));
  }
  async function withName(extra, name, action, options) {
    const owner = await context(extra);
    const record = named(owner, name);
    return store.locked(record.agentId, async () => {
      const fresh = store.get(record.agentId);
      if (!fresh || fresh.ownerId !== owner.ownerId) throw new Error('This subagent instance has already been removed.');
      return action(fresh, owner);
    }, options);
  }

  async function checkHost(record, { creation = false, taskTree = false } = {}) {
    const backend = await backendFor(record);
    const probe = await backend.probe();
    const stable = stableHost(probe.identity);
    const labels = backend.labels ?? {};
    if (record.host && JSON.stringify(record.host) !== JSON.stringify(stable)) {
      throw Object.assign(new Error(`The original ${labels.host ?? targetOf(record)} data store is not connected. The task was not sent to another host.`), { code: 'host-ownership-mismatch' });
    }
    if (creation || taskTree) {
      const required = backend.requiredMethods ?? probe.methods ?? [];
      if (!required.every(method => probe.methods?.includes(method))) {
        throw Object.assign(new Error(`${labels.bridge ?? `The ${targetOf(record)} backend`} needs this plugin version installed before subagents can be created.`), { code: 'managed-host-required' });
      }
      if (probe.treeProtocol !== TREE_PROTOCOL) throw treeProtocolError(labels.host ?? hostLabel(record));
      if (probe.reportProtocol !== REPORT_PROTOCOL) throw reportProtocolError(labels.host ?? hostLabel(record));
    }
    record.host ??= stable;
    return backend;
  }

  // DSH readiness for status, derived from the one host probe status already made.
  function dshDiagnostics(host, status) {
    if (!host) return { ready: false, connected: false, treeProtocol: null, reportProtocol: null,
      reason: safeError(status.hostError ?? { message: 'The DSH host is not reachable.' }) };
    const connected = status.dshConnected === true;
    const entry = { ready: connected && host.treeProtocol === TREE_PROTOCOL && host.reportProtocol === REPORT_PROTOCOL,
      connected, treeProtocol: host.treeProtocol ?? null, reportProtocol: host.reportProtocol ?? null,
      ...(connected ? {} : { missing: METHODS.filter(method => !host.methods?.includes(method)) }) };
    if (!connected) entry.reason = { code: 'managed-host-required', message: 'Install the current managed DSH bridge.' };
    else if (entry.treeProtocol !== TREE_PROTOCOL) entry.reason = safeError(treeProtocolError());
    else if (entry.reportProtocol !== REPORT_PROTOCOL) entry.reason = safeError(reportProtocolError());
    return entry;
  }

  // Does this name still owe the shared monitor a poll? Sleeping names are driven
  // by the monitor's existing DSH host-state wake path instead.
  function needsPoll(record) {
    if (record?.state === 'cleaning') return true;
    if (!record || record.closed || record.sleep) return false;
    if (ACTIVE.has(record.state)) return true;
    if (store.supplements(record.agentId).some(item => item.task === record.task?.taskId && item.status !== 'blocked')) return true;
    return !record.callbackBlocked
      && (record.task?.reports ?? []).some(report => !['delivered', 'blocked'].includes(report.delivery.state));
  }

  async function ensureMonitor() {
    try { return await startSharedMonitor(config, store); }
    catch (error) {
      monitorError = safeError(error);
      return false;
    }
  }

  // One monitor serves every name: this only makes sure it exists and, for a
  // sleeping name, clears the marker so the same durable task is polled again.
  async function ensureWorker(record, { wake = false } = {}) {
    if (!record) return false;
    if (wake && record.sleep) {
      if (!await ensureMonitor()) {
        // Nothing can watch this installation right now. Keep the sleeping
        // baseline so a later call resumes the same task instead of losing it.
        store.setError(record.agentId, monitorError ?? { code: 'monitor-unavailable', message: 'The shared monitor could not start.' });
        return false;
      }
      store.wake(record.agentId, record.sleep.taskId);
      record = store.get(record.agentId) ?? record;
    }
    if (record.sleep) return true;
    if (!needsPoll(record)) return false;
    const ready = await ensureMonitor();
    if (!ready) store.setError(record.agentId, monitorError ?? { code: 'monitor-unavailable', message: 'The shared monitor could not start.' });
    return ready;
  }

  /** The record's own backend observation, exactly as its host reported it. */
  async function observeOwn(record) {
    const backend = await checkHost(record);
    const observed = await backend.observe();
    if (observed.sessionId !== record.sessionId || (record.task && observed.taskId !== record.task.taskId)) {
      throw new Error('The host returned a different subagent task.');
    }
    if (record.task?.treeProtocol === TREE_PROTOCOL && !observed.tree) throw treeProtocolError(hostLabel(record));
    return observed;
  }

  /**
   * One view for the whole managed tree: the record's own native tree plus every
   * managed descendant's native tree, each child's native root hanging under the
   * parent's own node. Everything downstream (settled, public shape, changes,
   * coverage, finish gate, history snapshots, inspect) reads this view and nothing
   * else, so no interface grows its own tree logic.
   *
   * The root's questions and reports stay the root's own: a child's questions and
   * reports are delivered through that child's own state machine, never folded into
   * the root's report.
   */
  async function observe(record) {
    const own = await observeOwn(record);
    const keyOf = (agentId, native) => agentId === record.agentId ? native : `${agentId}:${native}`;
    const nodes = (own.tree?.nodes ?? []).map(node => ({ ...node,
      name: node.sessionId === record.sessionId ? record.name : node.name,
      backendKey: record.agentId, nativeSessionId: node.sessionId }));
    const managed = new Map([[record.agentId, { record, backend: await backendFor(record), rootKey: record.sessionId }]]);
    let settled = own.tree?.settled === true && !record.task?.cancelPending;
    let running = own.tree?.running === true || record.task?.cancelPending === true;
    for (const child of store.descendantsOf([record.agentId])) {
      const parentEntry = managed.get(child.parentAgentId);
      if (!parentEntry) continue;
      const parentKey = parentEntry.rootKey;
      const entry = { record: child, backend: undefined, view: undefined, rootKey: keyOf(child.agentId, child.sessionId) };
      managed.set(child.agentId, entry);
      // A child owns its adapter under its own operation lock. Reading its durable
      // observation never races its request/receipt writes or blocks this parent.
      const saved = child.observation;
      entry.view = saved?.sessionId === child.sessionId && saved?.taskId === child.task?.taskId
        ? saved : undefined;
      const childNodes = (entry.view?.tree?.nodes ?? []).filter(node => !node.archived
        && (!node.backendKey || node.backendKey === child.agentId));
      if (childNodes.length) {
        entry.rootKey = keyOf(child.agentId, child.sessionId);
        for (const node of childNodes) nodes.push({ ...node,
          sessionId: keyOf(child.agentId, node.sessionId),
          parentSessionId: node.parentSessionId ? keyOf(child.agentId, node.parentSessionId) : parentKey,
          name: node.sessionId === child.sessionId ? child.name : node.name,
          backendKey: child.agentId, nativeSessionId: node.sessionId });
      } else {
        // A managed child with no native tree of its own still belongs in the tree, so
        // an unfinished child can never let the parent settle early.
        nodes.push({ sessionId: entry.rootKey, parentSessionId: parentKey, name: child.name,
          status: child.closed ? 'closed' : child.state, activity: child.state, changes: [], coverage: 'Not observed',
          backendKey: child.agentId, nativeSessionId: child.sessionId, synthetic: true });
      }
      const pendingReports = (child.task?.reports ?? []).some(report => report.delivery.state !== 'delivered');
      const pendingQuestions = (entry.view?.questions ?? []).some(question => question.state === 'pending');
      const busy = Boolean(child.task) && (pendingReports || pendingQuestions
        || ACTIVE.has(child.state) || child.state === 'cleanup_failed'
        || !['completed', 'failed', 'cancelled'].includes(child.task.state));
      const childSettled = !child.task
        ? true
        : entry.view?.capturedAt && !entry.view.stale && entry.view?.tree?.settled === true
          && entry.view?.tree?.running === false && !busy;
      settled = settled && childSettled;
      running = running || entry.view?.tree?.running === true || busy;
    }
    // Removed one-shot children remain part of this task's evidence. Live records
    // take precedence while cleanup is in progress or being retried.
    for (const entry of managed.values()) {
      const latest = store.get(entry.record.agentId);
      const snapshots = latest?.task?.taskId === entry.record.task?.taskId
        ? latest?.task?.childSnapshots : entry.record.task?.childSnapshots;
      for (const snapshot of snapshots ?? []) {
        if (managed.has(snapshot.agentId)) continue;
        const snapshotKey = native => `${snapshot.agentId}:${native}`;
        for (const node of snapshot.nodes ?? []) nodes.push({ ...node,
          sessionId: snapshotKey(node.sessionId),
          parentSessionId: node.parentSessionId ? snapshotKey(node.parentSessionId) : entry.rootKey,
          archived: true });
      }
    }
    const composed = { ...own, tree: { ...(own.tree ?? {}), nodes, settled, running } };
    composed.managed = managed;
    // Everything persisted stays plain data: backends and the managed map are live
    // objects and must never reach the roster.
    const { managed: _managed, ...storable } = composed;
    record.observation = { ...storable, capturedAt: now() };
    record.error = undefined;
    return composed;
  }

  function sameModel(left, right) {
    if (!left || !right) return false;
    return left.provider === right.provider && left.model === right.model
      && (left.reasoningEffort ?? undefined) === (right.reasoningEffort ?? undefined);
  }

  async function followHostModel(record, dispatch, observed) {
    if (dispatch.modelReady) return;
    const backend = await backendFor(record);
    if (!dispatch.model) {
      dispatch.model = resolveModel(await backend.models(), {});
      store.save(record);
    }
    // Only a live host observation proves what the session will use. The roster
    // model is a display snapshot and may have been migrated while asleep. An
    // observation that reports modelSelectionObserved:false carries a historical
    // value (read back from a transcript), which is stale exactly when the user
    // changed the model in the UI without sending a turn — then the real
    // next-turn control is read instead of trusting that value.
    const current = observed && observed.modelSelectionObserved !== false
      ? observed.currentModel
      : await backend.model();
    if (!sameModel(current, dispatch.model)) {
      const selected = await backend.selectModel({ ...dispatch.model, requestId: `${dispatch.requestId}-model` });
      if (selected.accepted !== true) throw Object.assign(new Error(`${backend.labels?.host ?? targetOf(record)} did not confirm the default model selection.`),
        { code: 'model-selection-unconfirmed', uncertain: selected.status === 'unknown' });
    }
    record.model = dispatch.model;
    dispatch.modelReady = true;
    store.save(record);
  }

  async function sendDispatch(record, message, kind = 'task', answerIds = [], requestId = uid('request'), observed) {
    const task = record.task;
    const baseline = Number.isSafeInteger(observed?.throughSeq)
      ? observed : await (await backendFor(record)).cursor();
    const dispatch = { requestId, message, kind, answerIds, state: 'sending', afterSeq: baseline.throughSeq, startedAt: now() };
    task.dispatches.push(dispatch);
    record.state = 'running'; task.state = 'running';
    store.save(record); // The intent survives a caller or worker exiting during the write.
    await dispatchOnce(record, dispatch, observed);
    return dispatch;
  }

  async function dispatchOnce(record, dispatch, observed) {
    const current = store.get(record.agentId);
    if (current?.task?.taskId !== record.task?.taskId || current.closed || current.task.cancelRequested) return;
    if (dispatch.nextAttemptAt > Date.now()) return;
    let delivering = false;
    try {
      await followHostModel(record, dispatch, observed);
      // The model this request runs on is given explicitly, so a backend never has to
      // guess it from a catalog default that may have moved since the preflight.
      const backend = await backendFor(record);
      delivering = true;
      const sent = await backend.deliver({ requestId: dispatch.requestId,
        message: dispatch.message, kind: dispatch.kind, model: dispatch.model });
      Object.assign(dispatch, { state: sent.accepted ? 'running' : sent.status ?? 'unknown', accepted: sent.accepted === true,
        afterSeq: sent.afterSeq ?? dispatch.afterSeq, ...(sent.accepted ? { error: undefined, nextAttemptAt: undefined } : {}) });
      if (!sent.accepted && ['retryable', 'retrying'].includes(dispatch.state)) {
        dispatch.state = 'retrying'; deferRetry(dispatch);
      }
    } catch (error) {
      const retryable = error.retryableRead === true || (targetOf(record) !== 'dsh' && (!delivering || error.code === 'agent-busy'));
      const state = targetOf(record) !== 'dsh' && !delivering ? 'retrying'
        : error.uncertain ? 'unknown' : retryable ? 'retrying' : 'failed';
      Object.assign(dispatch, { state, afterSeq: error.afterSeq ?? dispatch.afterSeq, error: safeError(error) });
      if (dispatch.state === 'retrying' && targetOf(record) !== 'dsh') deferRetry(dispatch);
    }
    store.save(record);
    const latest = store.get(record.agentId);
    if (latest?.task?.taskId === record.task.taskId && latest.task.cancelRequested) {
      record.task.cancelRequested = true;
      record.task.cancelVerified = false;
      store.save(record);
      const result = await (await checkHost(record)).cancel();
      retainCancelError(record, result);
      if (result.cancelRequested === true) {
        store.confirmCancel(record, result);
        record.task.cancelVerified = true;
        record.task.cancelPending = result.cancelPending === true;
        store.save(record);
      }
    }
  }

  function deferRetry(value) {
    value.retryAttempts = (value.retryAttempts ?? 0) + 1;
    value.nextAttemptAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(value.retryAttempts, 5));
  }

  // A native refusal is often a normal return value, not an exception. Keep its
  // bounded explanation with the cancellation intent so observe() cannot erase it.
  function retainCancelError(record, result) {
    const task = record.task;
    if (result.treeSettled === true) { task.cancelError = undefined; return; }
    const rounds = (result.cancelRounds ?? []).slice(-3);
    const refused = rounds.some(round => round.action === 'stop-tasks-unsupported'
      || (round.action === 'interrupt-root' && round.interrupted === false)
      || (round.detail ?? []).some(row => row.clicked === false));
    if (result.cancelRequested !== false && !refused) return;
    const details = rounds.map(round => ({ action: round.action,
      ...(round.reason ? { reason: compactText(String(round.reason), 200) } : {}),
      ...(round.status ? { status: round.status } : {}),
      ...(typeof round.clicked === 'number' ? { clicked: round.clicked } : {}),
      ...(typeof round.remaining === 'number' ? { remaining: round.remaining } : {}),
      ...(round.detail?.length ? { rows: round.detail.slice(0, 4).map(row => ({
        row: compactText(String(row.rowText ?? ''), 200), clicked: row.clicked === true, state: row.state,
        ...(row.error ? { error: { code: row.error.code ?? 'native-stop-refused',
          message: compactText(String(row.error.message ?? ''), 240) } } : {}),
      })) } : {}),
    }));
    task.cancelError = { code: result.cancelRequested === false ? 'native-cancel-unconfirmed' : 'native-cancel-partial',
      message: result.cancelRequested === false
        ? 'The native host has not accepted a stop. Cancellation remains pending and will retry.'
        : 'The native host refused part of the stop. Cancellation remains pending and will retry.',
      detail: { ...(result.reason ? { reason: compactText(String(result.reason), 200) } : {}), rounds: details } };
    if (targetOf(record) !== 'dsh') deferRetry(record);
    store.save(record);
  }

  async function verifyOwner(owner) {
    const thread = threadFromResult(await callCodex(owner.threadId, 'read_thread', {
      threadId: owner.threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100,
    }));
    if (thread?.id?.toLowerCase() !== owner.threadId || thread.kind !== 'codex' || thread.hostId !== 'local'
        || typeof thread.cwd !== 'string' || await realpath(thread.cwd) !== owner.workspace) {
      throw new Error('The original Codex chat project could not be re-verified.');
    }
  }

  async function deliver(record, notice, text) {
    if (notice.state === 'delivered') return;
    if (notice.state === 'blocked') return;
    if (notice.nextAttemptAt && notice.nextAttemptAt > Date.now()) return;
    const owner = store.owner(record.ownerId);
    notice.id ??= uid('notice');
    notice.attempts = (notice.attempts ?? 0) + 1;
    notice.nextAttemptAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(notice.attempts, 5));
    const marker = `<!-- futureaide-control:${notice.id} -->`;
    const claude = owner?.source === 'claude-desktop' || Boolean(owner?.nativeSessionId);
    // This exact legacy failure happened before sendClaude opened a socket. It
    // can resume with the mapped native id; other unknown outcomes stay read-only.
    if (claude && claudeNoticeRequestId(notice.id) !== notice.id
        && notice.error?.message === 'claude-request-id-invalid') notice.state = 'pending';
    if (notice.state === 'unknown' || notice.state === 'sending') {
      try {
        if (claude) {
          // The native receipt is the request id itself: our envelope uuid survives
          // as the queue/attachment/user uuid. Transcript text is truncated at 8k,
          // so a long report's trailing marker is never reliable — deliveries are.
          // The scan starts at this notice's own cursor, so a long parent chat is
          // never rescanned and a page boundary simply continues on the next poll.
          const settled = await findClaudeReceipt(await claudeNoticeBinding(owner), notice);
          Object.assign(notice, settled
            ? { state: 'delivered', deliveredAt: now(), recovered: true, receipt: settled, error: undefined }
            : { state: 'unknown' });
        } else {
          const history = await callCodex(owner.threadId, 'read_thread', {
            threadId: owner.threadId, turnLimit: 30, includeOutputs: true, maxOutputCharsPerItem: 100000,
          });
          if (!history?.isError && JSON.stringify(history).includes(marker)) {
            Object.assign(notice, { state: 'delivered', deliveredAt: now(), recovered: true, error: undefined });
          } else notice.state = 'unknown';
        }
      } catch { notice.state = 'unknown'; }
      store.save(record);
      return;
    }
    // A newly confirmed channel rejection must not rewrite an older ambiguous
    // delivery: the read-back branch above remains its only recovery path.
    if (record.callbackBlocked) { notice.state = 'blocked'; store.save(record); return; }
    try { await (claude ? claudeNoticeBinding(owner) : verifyOwner(owner)); }
    catch (error) { Object.assign(notice, { state: 'pending', error: safeError(error) }); store.save(record); return; }
    // A previous attempt may have reached the desktop. Never send a second copy blindly.
    Object.assign(notice, { state: 'sending', attemptedAt: now() });
    store.save(record);
    try {
      if (claude) {
        // The Claude inbox answers 'written' when the channel accepted the text,
        // which is not that the session read it: stay unknown until the read-back
        // branch finds our request id in the native deliveries. A definite channel
        // failure stays 'pending'. The cached binding is reused; only a binding the
        // session outgrew is refreshed, and the parent session is never replaced.
        const binding = await claudeNoticeBinding(owner);
        // Remember where the transcript ends before writing: the receipt can only
        // appear after this point, so later polls start here instead of rescanning.
        notice.cursor = await transcriptCursor(binding).catch(() => undefined);
        const send = target => sendClaude(target, `${text}\n\n${marker}`, { requestId: claudeNoticeRequestId(notice.id) });
        let sent;
        try { sent = await send(binding); }
        catch (error) {
          // A binding is refreshed only when the write provably failed before it
          // happened; a written/uncertain channel is never retried here.
          if (!claudeBindingStale(error)) throw error;
          const fresh = await refreshClaudeBinding(owner);
          notice.cursor = await transcriptCursor(fresh).catch(() => undefined);
          sent = await send(fresh);
        }
        if (sent?.status === 'failed') Object.assign(notice, { state: 'pending', error: { message: 'The Claude inbox rejected this notice before acceptance.' } });
        else Object.assign(notice, { state: 'unknown', error: undefined });
      } else {
        const result = await callCodex(owner.threadId, 'send_message_to_thread', { threadId: owner.threadId, prompt: `${text}\n\n${marker}` });
        const unavailable = result?.isError && JSON.stringify(result).includes('direct app-server input is not allowed for multi-agent v2 sub-agents');
        if (unavailable) record.callbackBlocked = true;
        Object.assign(notice, unavailable ? { state: 'blocked', error: { code: 'native-callback-unavailable' } } : result?.isError ? { state: 'pending', error: { message: 'The desktop rejected this notice before acceptance.' } }
          : { state: 'delivered', deliveredAt: now(), error: undefined });
      }
    } catch (error) { Object.assign(notice, { state: 'unknown', error: safeError(error) }); }
    store.save(record);
  }

  /**
   * Transport binding for the Claude session that owns this name. A saved binding
   * is re-validated natively by sendClaude/readClaudeEvents on every use, so the
   * normal path runs no discovery and no rebind, and a cold process resumes straight
   * from the roster.
   */
  async function claudeNoticeBinding(owner) {
    const cached = owner?.binding;
    if (cached?.socketPath && cached?.recordFile && cached?.transcriptFile) return cached;
    return refreshClaudeBinding(owner);
  }
  async function refreshClaudeBinding(owner) {
    if (!owner?.nativeSessionId) throw Object.assign(new Error('This owner has no native Claude session to answer.'),
      { code: 'callback-target-missing' });
    const wanted = String(owner.nativeSessionId).toLowerCase();
    const { sessions } = await discoverClaude();
    const session = (sessions ?? []).find(item => String(item.sessionId).toLowerCase() === wanted);
    if (!session) throw Object.assign(new Error('The Claude session that owns this name is not running.'),
      { code: 'callback-target-missing' });
    // Same native session, same parent context: only the transport binding is
    // refreshed, never the conversation it belongs to.
    const binding = await bindClaude({ pid: session.pid, sessionId: session.sessionId, workspace: owner.workspace });
    store.saveOwner({ ...(store.owner(owner.ownerId) ?? owner), hostSessionId: owner.nativeSessionId, binding });
    return binding;
  }

  async function prepare(record) {
    const backend = await checkHost(record, { creation: true });
    store.save(record);
    const created = await backend.create();
    if (created.sessionId !== record.sessionId || created.modelRequestsStarted !== 0) throw new Error(`${backend.labels?.host ?? targetOf(record)} did not confirm the requested empty subagent.`);
    // The model is resolved from the live host default when the first input is
    // sent; creation must not add a second catalog round-trip or pin a stale model.
    record.model = created.model;
    record.created = true; record.state = 'idle'; record.error = undefined; store.save(record);
  }

  async function negotiateTree(record, force = false) {
    if (!force && record.task.treeProtocol === TREE_PROTOCOL && record.task.reportProtocol === REPORT_PROTOCOL) return;
    const backend = await checkHost(record, { taskTree: true });
    const after = record.task.dispatches[0]?.afterSeq;
    const started = await backend.beginTask({
      ...(Number.isSafeInteger(after) && after >= -1 ? { taskStartSeq: after } : {}) });
    if (started.treeProtocol !== TREE_PROTOCOL) throw treeProtocolError(hostLabel(record));
    if (started.reportProtocol !== REPORT_PROTOCOL) throw reportProtocolError(hostLabel(record));
    record.task.treeProtocol = TREE_PROTOCOL;
    record.task.reportProtocol = REPORT_PROTOCOL;
    store.save(record);
    return started;
  }

  async function beginTask(record) {
    const observed = await negotiateTree(record, true);
    await sendDispatch(record, record.task.message, 'task', [], undefined, observed);
  }

  async function resolveAnswer(record, answer) {
    if (answer.questionIds) return;
    const result = await (await backendFor(record)).answer({ answerId: answer.answerId, message: answer.message });
    if (!result.consumedQuestionIds?.length) throw new Error('This subagent has no unanswered question.');
    answer.questionIds = result.consumedQuestionIds;
    answer.continuation = result.continuation ?? `主控回答：\n${answer.message}\n请继续完成原任务。`;
    store.save(record);
  }

  /**
   * Close one name and everything created beneath it. Children go first: a child that
   * cannot be cleaned keeps the parent in cleanup_failed (still listed, still retryable)
   * instead of vanishing from the roster while its session survives. A child already in
   * cleanup_failed is retried too — closed is not the same as cleaned.
   */
  async function clearRecord(record, { autoClaimed = false } = {}) {
    record.state = 'cleaning'; record.closed = true;
    if (!autoClaimed) store.save(record);
    try {
      for (const child of store.childrenOf(record.agentId)) {
        const current = store.get(child.agentId);
        if (!current || current.agentId === record.agentId) continue;
        const verdict = await store.locked(current.agentId, async () => {
          const fresh = store.get(current.agentId);
          return fresh ? clearRecord(fresh) : { deleted: true };
        }, { waitMs: 0 });
        if (verdict?.deleted !== true) {
          throw Object.assign(new Error(`The managed subagent “${current.name}” could not be cleaned; this name stays listed so cleanup can be retried.`),
            { code: verdict?.queued ? 'agent-busy' : 'child-cleanup-failed', child: current.name, childError: verdict?.error });
        }
      }
      if (record.lifetime === 'once' && record.parentAgentId) await keepChildSnapshot(record);
      if (!record.nativeDestroyed) {
        const backend = await checkHost(record);
        const result = await backend.destroy();
        if (result.destroyed !== true) throw new Error(result.message ?? `${backend.labels?.host ?? targetOf(record)} has not confirmed complete session cleanup.`);
        record.nativeDestroyed = true; store.save(record);
      }
      const directory = agentDirectory(record);
      const root = path.resolve(config.stateDirectory, 'scoped');
      const relative = path.relative(root, path.resolve(directory));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The subagent state directory is outside its owned root.');
      try {
        const meta = await lstat(directory);
        if (meta.isSymbolicLink() || !meta.isDirectory()) throw new Error('The owned state path is not a plain directory.');
        const resolved = await realpath(directory);
        const actualRoot = await realpath(root);
        const actualRelative = path.relative(actualRoot, resolved);
        if (!actualRelative || actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) throw new Error('The state directory resolves outside its owned root.');
        await removeTree(directory, { recursive: true, force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      store.remove(record);
      forgetBackend(record);
      return { name: record.name, deleted: true, sessionDataRemoved: true };
    } catch (error) {
      const current = store.get(record.agentId);
      if (current && error.code === 'agent-busy' && targetOf(record) !== 'dsh') {
        current.state = 'cleaning'; current.closed = true; current.error = safeError(error); deferRetry(current); store.save(current);
        return { name: record.name, deleted: false, queued: true, state: 'cleaning', error: safeError(error) };
      }
      if (current) { current.state = 'cleanup_failed'; current.closed = true; current.error = safeError(error); store.save(current); }
      return { name: record.name, deleted: false, state: 'cleanup_failed', error: safeError(error) };
    }
  }

  /**
   * Keep a one-shot child's terminal tree, files and history inside the parent's
   * current task snapshot, in the fields the task already has. No second state machine.
   */
  async function keepChildSnapshot(child) {
    const parent = store.get(child.parentAgentId);
    if (!parent?.task) return;
    const view = child.nativeDestroyed ? child.observation ?? {} : await observe(child);
    const nodes = [];
    for (const { node } of ownedTree(child, view).nodes) {
      const saved = { ...node };
      if (!saved.archivedHistory && !child.nativeDestroyed) {
        const backend = view.managed?.get(node.backendKey)?.backend ?? await backendFor(child);
        const page = await backend.history({ targetSessionId: node.nativeSessionId ?? node.sessionId,
          running: false, maxMessages: 100 });
        saved.archivedHistory = { messages: page.messages ?? [], hasMore: page.hasMore === true,
          ...(page.note ? { note: page.note } : {}) };
      }
      nodes.push(saved);
    }
    store.saveChildSnapshot(parent.agentId, parent.task.taskId,
      { agentId: child.agentId, taskId: child.task?.taskId, nodes });
  }

  // Only persisted report_parent calls may wake the parent chat.
  async function deliverReports(record) {
    for (const report of record.task.reports ?? []) {
      if (report.final && !report.treeSettledConfirmed) continue;
      await deliver(record, report.delivery, `${hostLabel(record)}「${record.name}」${report.final ? '交付' : '汇报'}：\n${report.message}`);
      if (report.delivery.state !== 'delivered') return false;
    }
    return true;
  }

  async function finishDeliveredReport(record) {
    const task = record.task;
    const current = store.get(record.agentId);
    if (current?.task?.taskId === task.taskId && current.task.cancelRequested) {
      task.cancelRequested = true;
      task.cancelPending = current.task.cancelPending === true;
    }
    if (task.cancelRequested && (!task.cancelVerified || task.cancelPending || !task.cancelTreeSettled)) {
      record.state = task.state = 'running';
      store.save(record);
      return publicResult(record);
    }
    task.state = task.cancelRequested ? 'cancelled' : task.result.state;
    task.finishedAt ??= now();
    if (record.lifetime === 'once' && task.state === 'completed') {
      if (store.claimAutoCleanup(record)) return clearRecord(record, { autoClaimed: true });
      const latest = store.get(record.agentId);
      if (latest?.task?.taskId === task.taskId && latest.task.cancelRequested) {
        task.cancelRequested = true;
        record.state = task.state = 'running';
        store.save(record);
        return publicResult(record);
      }
      if (store.supplementSummary(record.agentId, task.taskId).blocked) {
        record.state = 'supplement_blocked';
        store.save(record);
        return publicResult(record);
      }
      else return publicResult(latest ?? record);
    }
    record.state = task.state === 'completed' ? 'idle' : task.state;
    store.save(record);
    return publicResult(record);
  }

  async function finishReports(record, view) {
    const task = record.task;
    task.reports ??= [];
    for (const incoming of view.reports ?? []) {
      if (incoming.taskId !== task.taskId || typeof incoming.id !== 'string'
          || typeof incoming.message !== 'string' || !incoming.message.trim()
          || typeof incoming.final !== 'boolean') throw new Error('The bridge returned an invalid explicit report.');
      const previous = task.reports.find(report => report.id === incoming.id);
      if (previous) {
        if (previous.message !== incoming.message || previous.final !== incoming.final) throw new Error('A persisted report identity changed.');
      } else task.reports.push({ id: incoming.id, taskId: incoming.taskId, message: incoming.message,
        final: incoming.final, createdAt: incoming.createdAt, delivery: { id: 'report-' + incoming.id, state: 'pending' } });
    }
    const final = task.reports.find(report => report.final);
    if (final && treeSettled(record, view) && !(view.questions ?? []).some(question => question.state === 'pending')) final.treeSettledConfirmed = true;
    if (final && final.treeSettledConfirmed) {
      task.result = { state: task.cancelRequested || rootSummary(view)?.state === 'cancelled' ? 'cancelled' : task.state === 'failed' || rootSummary(view)?.state === 'failed' ? 'failed' : 'completed',
        reply: final.message, changes: attributedChanges(record, view), coverage: treeCoverage(record, view), tree: publicTree(record, view) };
      task.state = task.result.state;
    }
    // Persist the terminal outcome before delivery can succeed or become ambiguous.
    store.save(record);
    const delivered = await deliverReports(record);
    if (final && final.treeSettledConfirmed) {
      if (delivered) return finishDeliveredReport(record);
      record.state = record.callbackBlocked && ['failed', 'cancelled'].includes(task.result.state)
        && (!task.cancelRequested || (task.cancelVerified && task.cancelTreeSettled)) ? task.result.state : 'delivery_pending';
    }
    store.save(record);
    return publicResult(record);
  }

  function waitForTree(record, view, summaryOnly = false) {
    record.state = record.task.state = 'running';
    record.observation = { ...view, activity: summaryOnly ? `Waiting for the top-level ${hostLabel(record)} summary` : `Waiting for the ${hostLabel(record)} task tree and notifications to settle` };
    store.save(record);
    return publicResult(record);
  }

  async function recoverDispatch(record, dispatch, { allowResend = true } = {}) {
    if (dispatch.accepted || !['sending', 'retrying', 'unknown'].includes(dispatch.state)) return;
    if (dispatch.nextAttemptAt > Date.now()) return;
    // The backend owns its own receipt format; undefined means this saved intent
    // never reached a native write.
    const receipt = await (await backendFor(record)).receipt({ requestId: dispatch.requestId });
    if (!receipt) {
      if (!['sending', 'retrying'].includes(dispatch.state)) return;
      // The receipt is written before entering the native send. No receipt means
      // this intent never reached that send; keep the exact request ID.
      if (!allowResend) return 'not-sent';
      await dispatchOnce(record, dispatch);
      return;
    }
    dispatch.afterSeq = receipt.afterSeq ?? dispatch.afterSeq;
    if (receipt.status === 'accepted') Object.assign(dispatch, { accepted: true, state: 'running', error: undefined, failure: undefined, nextAttemptAt: undefined, retryAttempts: undefined });
    if (receipt.status === 'rejected') dispatch.state = 'failed';
    if (receipt.status === 'retryable') {
      if (!allowResend) return 'not-sent';
      await dispatchOnce(record, dispatch);
    }
  }

  async function drainSupplements(record) {
    if (record.task.cancelRequested) store.blockQueued(record.agentId, record.task.taskId, 'task-cancelled');
    else if (record.task.reports?.some(report => report.final)) store.blockQueued(record.agentId, record.task.taskId, 'final-submitted');
    const sealed = record.task.cancelRequested || record.task.reports?.some(report => report.final);
    if (!sealed && (!(record.task.dispatches?.[0]?.accepted) || (record.task.answers ?? []).some(answer => !answer.dispatched))) return;
    for (const item of store.supplements(record.agentId)) {
      if (item.task !== record.task?.taskId) { store.setSupplement(item.requestId, 'blocked', 'task-changed'); continue; }
      if (item.status === 'blocked') continue;
      const current = store.get(record.agentId);
      if (!current || current.ownerId !== item.owner || current.sessionId !== item.session || current.task?.taskId !== item.task) {
        store.setSupplement(item.requestId, 'blocked', current?.task?.taskId !== item.task ? 'task-changed' : current?.task?.cancelRequested ? 'task-cancelled' : 'task-closed'); return;
      }
      const prior = record.task.dispatches.find(dispatch => dispatch.requestId === item.requestId);
      if (prior) {
        const recovered = await recoverDispatch(record, prior, { allowResend: false });
        if (recovered === 'not-sent') {
          const view = sealed ? undefined : await observe(record);
          if (sealed || (view.reports ?? []).some(report => report.final)) {
            store.setSupplement(item.requestId, 'blocked', record.task.cancelRequested ? 'task-cancelled' : 'final-submitted');
            prior.state = 'blocked';
            store.save(record);
            continue;
          }
          await dispatchOnce(record, prior);
        }
        if (!prior.accepted && prior.state !== 'failed' && Number.isSafeInteger(prior.afterSeq)) {
          const observed = await (await backendFor(record)).turn({ requestId: prior.requestId,
            afterSeq: prior.afterSeq, timeoutSeconds: 0, maxMessages: 100 });
          if (observed.state === 'ended' && observed.correlation === 'request-id') Object.assign(prior,
            { accepted: true, state: endedState(observed.completionReason), endSeq: observed.endSeq, error: undefined, nextAttemptAt: undefined, retryAttempts: undefined,
              failure: modelTurnError(observed.completionReason) });
        }
        store.save(record);
        if (prior.accepted) { store.setSupplement(item.requestId, 'accepted'); continue; }
        store.setSupplement(item.requestId, prior.state === 'failed' ? 'blocked' : 'unknown', prior.error?.code ?? (prior.state === 'failed' ? 'send-failed' : 'acceptance-unknown')); return;
      }
      const priorAnswer = (record.task.answers ?? []).find(answer => answer.answerId === item.requestId);
      if (priorAnswer && sealed) {
        store.setSupplement(item.requestId, priorAnswer.questionIds ? 'accepted' : 'unknown', priorAnswer.questionIds ? null : 'answer-confirmation-unknown');
        if (!priorAnswer.questionIds) return;
        continue;
      }
      if (current.closed || current.task.cancelRequested || ['cleaning','cleanup_failed','cancelled','failed','idle','delivery_pending'].includes(current.state)) {
        store.setSupplement(item.requestId, 'blocked', current.task.cancelRequested ? 'task-cancelled' : 'task-closed'); continue;
      }
      if (priorAnswer) {
        if (!priorAnswer.questionIds) await answerLocked(record, item.message, item.requestId);
        store.setSupplement(item.requestId, 'accepted');
        if (!priorAnswer.dispatched) return;
        continue;
      }
      const view = await observe(record);
      if ((view.reports ?? []).some(report => report.final)) { store.blockQueued(record.agentId, record.task.taskId, 'final-submitted'); store.setSupplement(item.requestId, 'blocked', 'final-submitted'); return; }
      store.setSupplement(item.requestId, 'sending');
      if ((view.questions ?? []).some(question => question.state === 'pending')) {
        await answerLocked(record, item.message, item.requestId);
        store.setSupplement(item.requestId, 'accepted');
        return;
      } else {
        const dispatch = await sendDispatch(record, item.message, 'supplement', [], item.requestId, view);
        store.setSupplement(item.requestId, dispatch.accepted ? 'accepted' : dispatch.state === 'failed' ? 'blocked' : 'unknown', dispatch.accepted ? null : dispatch.error?.code ?? (dispatch.state === 'failed' ? 'send-failed' : 'acceptance-unknown'));
        if (!dispatch.accepted) return;
      }
    }
  }

  async function pollLocked(record) {
    if (record.nextAttemptAt > Date.now()) return publicResult(record);
    if (!record.task?.cancelRequested && (record.task?.dispatches ?? []).some(d => !d.accepted && d.state === 'retrying' && d.nextAttemptAt > Date.now())) return publicResult(record);
    if (record.state === 'cleaning') return clearRecord(record);
    if (record.closed || record.state === 'cleanup_failed' || record.state === 'idle') return publicResult(record);
    const task = record.task;
    try {
      // Explicit ask/report that a Codex-side tool wrote into the shared queue join
      // the same task as questions/reports before anything else looks at them.
      if (task) absorbSubmissions(record);
      if (task?.cancelRequested && (!task.cancelVerified || task.cancelPending)) {
        const result = await (await checkHost(record)).cancel();
        retainCancelError(record, result);
        if (result.cancelRequested === true) {
          store.confirmCancel(record, result);
          task.cancelAccepted = true; task.cancelVerified = true;
          task.cancelPending = result.cancelPending === true;
          if (task.cancelPending) task.cancelTreeSettled = false;
          store.save(record);
        }
      }
      if (task && store.supplements(record.agentId).length) await drainSupplements(record);
      // Never migrate an automatic result into an explicit report or cleanup.
      if (task?.result && task.reportProtocol !== REPORT_PROTOCOL) {
        if (['sending', 'unknown'].includes(task.delivery?.state)) await deliver(record, task.delivery, '');
        task.legacyAutomaticResult = task.result;
        delete task.result; task.delivery = undefined;
        record.state = task.state = 'awaiting_report';
        store.save(record);
        return publicResult(record);
      }
      if (task?.reports?.length) {
        await deliverReports(record);
        const final = task.reports.find(report => report.final && report.treeSettledConfirmed);
        if (final && task.result && task.reports.every(report => report.delivery.state === 'delivered')
            && (!task.cancelRequested || (task.cancelVerified && task.cancelTreeSettled))) {
          return finishDeliveredReport(record);
        }
      }
      if (!record.created) { await prepare(record); return publicResult(record); }
      if (!task) return publicResult(record);
      if (!task.dispatches.length && !task.cancelRequested && !task.legacyAutomaticResult) {
        await beginTask(record);
        record.nextAttemptAt = undefined; record.retryAttempts = 0;
        if (task.dispatches[0]?.state === 'retrying' && task.dispatches[0].nextAttemptAt > Date.now()) return publicResult(record);
      }
      else await negotiateTree(record);
      for (const answer of task.answers ?? []) if (!answer.questionIds && !task.cancelRequested) await resolveAnswer(record, answer);
      const view = await observe(record);
      if (task.cancelRequested && task.cancelVerified && !view.running && treeSettled(record, view)) {
        task.cancelTreeSettled = true;
        task.cancelError = undefined;
        store.save(record);
      }
      // Persist and deliver explicit reports before inspecting older dispatches:
      // an ordinary history/read failure must not suppress an accepted report.
      const reported = await finishReports(record, view);
      if ((task.reports ?? []).some(report => report.final && report.treeSettledConfirmed)) return reported;
      const unanswered = (view.questions ?? []).filter(question => question.state === 'pending');
      for (const question of unanswered) {
        task.questionNotices ??= {};
        const notice = task.questionNotices[question.id] ??= { state: 'pending' };
        await deliver(record, notice,
          `${hostLabel(record)} 子代理「${record.name}」等待回答：\n${question.message}\n\n请调用 futureaide_answer_agent，name=${JSON.stringify(record.name)}，message 为回答正文。任务保持等待；无需文件、命令或内部编号。`);
      }
      for (const dispatch of task.dispatches) {
        if (['completed', 'cancelled', 'failed', 'blocked'].includes(dispatch.state)) continue;
        await recoverDispatch(record, dispatch);
        if (['completed', 'cancelled', 'failed', 'blocked'].includes(dispatch.state)) continue;
        if (dispatch.state === 'retrying' && dispatch.nextAttemptAt > Date.now()) continue;
        const result = await (await backendFor(record)).turn({ requestId: dispatch.requestId,
          ...(Number.isSafeInteger(dispatch.afterSeq) ? { afterSeq: dispatch.afterSeq } : {}), timeoutSeconds: 0, maxMessages: 100 });
        dispatch.afterSeq ??= result.afterSeq;
        if (result.state === 'ended' && (dispatch.accepted || result.correlation === 'request-id')) {
          Object.assign(dispatch, { state: endedState(result.completionReason), accepted: true, error: undefined, nextAttemptAt: undefined, retryAttempts: undefined,
            endSeq: result.endSeq, failure: modelTurnError(result.completionReason) });
        }
      }
      const outstanding = task.dispatches.some(dispatch => !['completed', 'cancelled', 'failed', 'blocked'].includes(dispatch.state));
      if (task.cancelRequested && !view.running && treeSettled(record, view)) {
        for (const dispatch of task.dispatches) if (!['completed', 'cancelled', 'failed'].includes(dispatch.state)) dispatch.state = 'cancelled';
      } else if (outstanding || view.running || task.cancelRequested) {
        record.state = unanswered.length ? 'awaiting_input' : 'running';
        task.state = record.state;
        store.save(record);
        return await finishReports(record, view);
      }
      if (unanswered.length && !task.cancelRequested) {
        record.state = task.state = 'awaiting_input'; store.save(record); return await finishReports(record, view);
      }
      const pendingAnswers = (task.answers ?? []).filter(answer => !answer.dispatched);
      if (pendingAnswers.length && !task.cancelRequested) {
        const ids = pendingAnswers.flatMap(answer => answer.questionIds);
        for (const answer of pendingAnswers) answer.dispatched = true;
        await sendDispatch(record, pendingAnswers.map(answer => answer.continuation).join('\n\n'), 'answer', ids, undefined, view);
        return publicResult(record);
      }
      if (!treeSettled(record, view)) {
        waitForTree(record, view);
        return await finishReports(record, view);
      }
      const finalDispatch = task.dispatches.at(-1);
      const terminal = task.cancelRequested || rootSummary(view)?.state === 'cancelled' ? 'cancelled'
        : rootSummary(view)?.state === 'failed' || finalDispatch?.state === 'failed' ? 'failed'
          : finalDispatch?.state === 'cancelled' ? 'cancelled' : undefined;
      record.state = task.state = terminal ?? 'awaiting_report';
      return await finishReports(record, view);
    } catch (error) {
      record.state = record.task?.result ? 'delivery_pending' : 'reconnecting';
      record.error = safeError(error); record.observation = { ...record.observation, stale: true };
      if (targetOf(record) !== 'dsh') deferRetry(record);
      forgetBackend(record);
      store.save(record);
      return publicResult(record);
    }
  }

  const service = {
    store,
    async status(extra) {
      const status = { toolsLoaded: true, contextVerified: false, dshConnected: false, returnChannel: 'not-checked' };
      let owner;
      try {
        owner = await context(extra);
        Object.assign(status, { contextVerified: true, workspace: owner.workspace, returnChannel: 'chat-verified',
          agents: typeof store.count === 'function' ? store.count(owner.ownerId) : store.list(owner.ownerId).length });
      } catch (error) { status.contextError = safeError(error); }
      let host;
      try {
        host = await clientFactory(config).hostStatus();
        status.dshConnected = METHODS.every(method => host.methods?.includes(method));
        status.treeProtocolReady = host.treeProtocol === TREE_PROTOCOL;
        status.reportProtocolReady = host.reportProtocol === REPORT_PROTOCOL;
        if (!status.dshConnected) status.hostError = { message: 'Install the current managed DSH bridge.' };
        else if (!status.treeProtocolReady) status.hostError = safeError(treeProtocolError());
      } catch (error) { status.hostError = safeError(error); }
      status.ready = status.contextVerified && status.dshConnected && status.treeProtocolReady === true && status.reportProtocolReady === true;
      // Per-target readiness beside the unchanged DSH fields. Neither entry starts
      // a model turn or a session: the DSH probe is the same one above, and the
      // claude-desktop entry imports its adapter and asks probe() only.
      const probe = { agentId: 'agent-status-probe', ownerId: owner?.ownerId ?? 'status', name: 'status-probe',
        lifetime: 'once', target: 'claude-desktop', workspace: owner?.workspace ?? config.workspace,
        state: 'probing', createdAt: now(), updatedAt: now(), history: [] };
      status.backends = {
        dsh: dshDiagnostics(host, status),
        // This probe name is not in the roster, so a state write during diagnostics
        // reports false instead of inventing a row.
        'claude-desktop': await diagnoseTarget('claude-desktop', { adapters: backendAdapters,
          ...(backendAdapterLoader ? { adapterLoader: backendAdapterLoader } : {}),
          record: probe, deps: adapterDeps(probe, { startReports: false }) }),
      };
      // A Codex Desktop entry is ready only when a real native Codex session reports
      // the ask/report tools; an adapter that merely answers probe() is not enough,
      // and a healthy loopback endpoint proves nothing about those tools.
      const codexProbe = { ...probe, target: 'codex-desktop' };
      const codexEntry = await diagnoseTarget('codex-desktop', { adapters: backendAdapters,
        ...(backendAdapterLoader ? { adapterLoader: backendAdapterLoader } : {}),
        record: codexProbe, deps: adapterDeps(codexProbe, { startReports: false }) });
      status.backends['codex-desktop'] = codexEntry.ready ? codexToolsDiagnostics(await readCodexToolsStatus(codexProbe)) : codexEntry;
      return status;
    },
    async create({ name, lifetime, target }, extra) {
      assertName(name);
      if (!['once', 'persistent'].includes(lifetime)) throw new Error('lifetime must be once or persistent.');
      const backendTarget = normalizeTarget(target);
      const owner = await context(extra);
      // A cross-application call: when the caller is itself a managed name — a
      // Claude session by its native id, or a Codex child by its own chat — the new
      // name is its child and follows that owner tree.
      const caller = trustedCaller(extra);
      const parent = caller ? store.agentForNativeSession(caller.nativeSessionId)
        : store.agentForCodexThread(callingThread(extra));
      const record = { agentId: uid('agent'), ownerId: owner.ownerId, sessionId: uid('session-codex'), name, lifetime,
        target: backendTarget, workspace: owner.workspace, state: 'creating', createdAt: now(), updatedAt: now(), history: [],
        ...(parent ? { parentAgentId: parent.agentId } : {}) };
      await ensureTargetBackend(record);
      store.insert(record); // The database's (owner,name) constraint arbitrates parallel creation.
      return store.locked(record.agentId, async () => {
        if (!store.get(record.agentId)) throw new Error('This subagent was removed while it was being created.');
        try {
          await prepare(record);
          return { ...publicResult(record), created: true, modelRequestsStarted: 0 };
        } catch (error) {
          record.state = 'reconnecting'; record.error = safeError(error); store.save(record); await ensureWorker(record);
          return { ...publicResult(record), created: false };
        }
      });
    },
    async send({ name, message }, extra) {
      textMessage(message);
      let enteredOperation = false;
      const enqueue = async record => {
        const requestId = uid('request');
        if (!store.enqueueSupplement(record, requestId, message)) throw Object.assign(new Error('The task changed, stopped or is no longer accepting supplements.'), { code: 'supplement-unavailable' });
        await ensureWorker(store.get(record.agentId) ?? record, { wake: true });
        return { name: record.name, accepted: false, queued: true, state: record.state,
          ...(record.callbackBlocked ? { callbackError: { code: 'native-callback-unavailable', message: 'The desktop does not permit background reports to this native multi-agent v2 sub-agent.' } } : {}) };
      };
      try { return await withName(extra, name, async record => {
        enteredOperation = true;
        if (record.closed || ['cleaning', 'cleanup_failed', 'creating', 'supplement_blocked'].includes(record.state)) throw new Error('This subagent is closing, has blocked supplements, or is not yet ready.');
        if (record.state === 'delivery_pending') throw new Error('The final report is waiting for delivery; wait before assigning another task.');
        if (!record.created) throw new Error('This subagent is still connecting; check its list status before sending a task.');
        if (targetOf(record) === 'dsh') await checkHost(record);
        const stoppedTask = record.task && ['cancelled', 'failed'].includes(record.state);
        if (!stoppedTask && store.supplements(record.agentId).some(item => item.task === record.task?.taskId && item.status !== 'blocked')) return enqueue(record);
        const pendingReports = (record.task?.reports ?? []).some(report => report.delivery.state !== 'delivered');
        if (stoppedTask && (record.lifetime === 'once' || pendingReports)) throw new Error('This task stopped; delete the one-shot agent or wait for its submitted reports before reusing a persistent agent.');
        if (record.state !== 'idle' && !stoppedTask && record.task?.reports?.some(report => report.final)) throw new Error('The agent has submitted its final report; wait for delivery or explicitly delete the agent.');
        if (record.task && ACTIVE.has(record.state)) {
          if (targetOf(record) !== 'dsh' || !record.task.dispatches.length) return enqueue(record);
          await negotiateTree(record);
          const view = await observe(record);
          if ((view.reports ?? []).some(report => report.final)) throw new Error('The agent has already submitted its final report.');
          if ((view.questions ?? []).some(question => question.state === 'pending')) return answerLocked(record, message);
          await sendDispatch(record, message, 'supplement', [], undefined, view);
        } else {
          if (record.task) record.history.push({ ...record.task, changes: attributedChanges(record, record.observation ?? {}),
            coverage: treeCoverage(record, record.observation ?? {}), tree: publicTree(record, record.observation ?? {}) });
          record.task = { taskId: uid('task'), message, state: 'starting', startedAt: now(), dispatches: [], answers: [] };
          record.state = 'running'; record.observation = undefined; record.error = undefined;
          record.nextAttemptAt = undefined; record.retryAttempts = 0; store.save(record);
          if (targetOf(record) !== 'dsh') {
            await ensureWorker(record, { wake: true });
            return { name: record.name, accepted: false, queued: true, state: record.state };
          }
          try { await beginTask(record); }
          catch (error) { record.state = 'reconnecting'; record.error = safeError(error); store.save(record); }
        }
        await ensureWorker(record, { wake: true });
        const current = store.get(record.agentId) ?? record;
        const dispatch = record.task.dispatches.at(-1);
        const error = current.error ?? dispatch?.error;
        return { name: current.name, accepted: dispatch?.accepted === true, state: current.state,
          ...(dispatch?.state === 'retrying' ? { retrying: true } : {}),
          ...(error ? { error } : {}),
          ...(current.callbackBlocked ? { callbackError: { code: 'native-callback-unavailable', message: 'The desktop does not permit background reports to this native multi-agent v2 sub-agent.' } } : {}) };
      }, { waitMs: 0 }); } catch (error) {
        if (enteredOperation || error.code !== 'agent-busy') throw error;
        const owner = await context(extra);
        const record = named(owner, name);
        return enqueue(record);
      }
    },
    async answer({ name, message }, extra) {
      textMessage(message);
      return withName(extra, name, record => answerLocked(record, message));
    },
    async list(extra) {
      const owner = await context(extra);
      // Own names only, each with its own composed tree; managed descendants appear
      // inside that tree, never as extra entries in this chat's list.
      for (const record of store.list(owner.ownerId)) await ensureWorker(record);
      const records = store.list(owner.ownerId);
      return { items: records.map(record => ({ ...publicResult(record),
        monitor: record.sleep ? (record.sleep.wakePending ? 'waking' : 'sleeping') : (monitorAlive(store) ? 'running' : 'stopped'),
        supplements: store.supplementSummary(record.agentId, record.task?.taskId ?? '') })), total: records.length };
    },
    async changes({ name, task = 0 }, extra) {
      return withName(extra, name, async record => {
        if (task !== 0) {
          const historical = record.history.at(-task);
          if (!historical) throw new Error('That earlier task is not available. Use 0 for the current or latest task.');
          return { name, task, message: historical.message, changes: historical.changes ?? historical.result?.changes ?? [],
            coverage: historical.coverage, tree: historical.tree ?? historical.result?.tree };
        }
        try { await observe(record); store.save(record); } catch (error) { record.error = safeError(error); }
        // The composed view already carries every managed descendant's attributed
        // changes under its own agentPath, so no second walk happens here.
        return { name, task: 0, changes: attributedChanges(record, record.observation ?? {}),
          tree: publicTree(record, record.observation ?? {}), coverage: treeCoverage(record, record.observation ?? {}),
          stale: Boolean(record.error || record.observation?.stale), ...(record.error ? { error: record.error } : {}) };
      });
    },
    async inspect({ name, maxMessages = 20 }, extra) {
      if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) throw new Error('Inspect between 1 and 100 messages per tree node.');
      return withName(extra, name, async record => {
        const view = await observe(record);
        store.save(record);
        // Newly created and historical idle leaf records need no execution
        // handshake just to read their own history.
        const inspectionView = ownedTree(record, view).nodes.length ? view : { ...view,
          tree: { ...view.tree, settled: false, nodes: [{ sessionId: record.sessionId, parentSessionId: null,
            status: view.status, activity: view.activity, changes: view.changes, coverage: view.coverage }] } };
        const tree = publicTree(record, inspectionView);
        const nodes = ownedTree(record, inspectionView).nodes;
        let rootHistory, rootError;
        // Every node — this record's own sessions and managed descendants on any
        // application — reads its history through the backend that owns it. The public
        // shape stays the existing tree.nodes[].messages/agentPath/depth; internal ids
        // and bindings never leave this loop.
        const backend = await backendFor(record);
        for (let index = 0; index < nodes.length; index++) {
          const { node } = nodes[index];
          if (node.archived) {
            const page = node.archivedHistory ?? { messages: [], hasMore: false };
            Object.assign(tree.nodes[index], { ...page, messages: page.messages.slice(-maxMessages),
              hasMore: page.hasMore || page.messages.length > maxMessages });
            continue;
          }
          const owner = node.backendKey && node.backendKey !== record.agentId ? view.managed?.get(node.backendKey) : undefined;
          const nodeBackend = backend;
          const targetSessionId = node.nativeSessionId ?? node.sessionId;
          if (node.synthetic && !owner?.view) { tree.nodes[index].status = tree.nodes[index].status ?? node.status; continue; }
          try {
            const dispatch = node.sessionId === record.sessionId ? record.task?.dispatches?.at(-1) : undefined;
            // Upgrade old failed records from this inspection's own page, and only
            // when it contains this task's original request. The backend reads its
            // own native history: no target format is parsed in this shared layer.
            const upgrade = dispatch?.state === 'failed' && !dispatch.failure;
            const request = { targetSessionId, running: node.status === 'running',
              maxMessages, ...(upgrade ? { requestId: dispatch.requestId, afterSeq: dispatch.afterSeq ?? -1 } : {}) };
            const page = owner ? await store.locked(owner.record.agentId, async () => {
              const child = store.get(owner.record.agentId);
              if (!child) throw Object.assign(new Error('This child finished; inspect the refreshed tree.'), { code: 'agent-removed' });
              return (await backendFor(child)).history(request);
            }, { waitMs: 0 }) : await nodeBackend.history(request);
            if (!Array.isArray(page?.messages)) throw Object.assign(new Error(`${nodeBackend.labels?.bridge ?? `The ${targetOf(record)} backend`} returned invalid session history.`), { code: 'invalid-response' });
            if (upgrade && page.failure) { dispatch.failure = page.failure; store.save(record); }
            const selected = { messages: page.messages, hasMore: page.hasMore === true,
              ...(page.note ? { note: page.note } : {}) };
            Object.assign(tree.nodes[index], selected);
            if (node.sessionId === record.sessionId) rootHistory = selected;
          } catch (error) {
            tree.nodes[index].error = safeError(error);
            if (node.sessionId === record.sessionId) rootError = safeError(error);
          }
        }
        return { ...publicResult(record), ...(rootHistory ?? {}), ...(rootError ? { error: rootError } : {}),
          reports: { ...publicResult(record).reports, items: (record.task?.reports ?? []).map(report => ({ message: report.message, final: report.final, delivery: report.delivery.state })) },
          tree,
          inspectionIncomplete: tree.nodes.some(node => node.error !== undefined),
          historyCount: record.history.length,
          history: record.history.slice(-20).reverse().map((task, index) => ({ task: index + 1, message: compactText(task.message, 240),
            state: task.state, startedAt: task.startedAt, finishedAt: task.finishedAt })) };
      });
    },
    async cancel({ name }, extra) {
      const owner = await context(extra);
      const record = named(owner, name);
      if (!record.task || record.closed) return { name, accepted: false, state: record.state };
      if (!store.requestCancel(record)) return { name, accepted: false, state: store.get(record.agentId)?.state ?? 'removed' };
      if (targetOf(record) !== 'dsh') {
        for (const child of store.descendantsOf([record.agentId])) {
          if (!child.closed && child.task && store.requestCancel(child)) await ensureWorker(store.get(child.agentId), { wake: true });
        }
        await ensureWorker(store.get(record.agentId), { wake: true });
        return { name, accepted: false, queued: true, state: 'cancelling' };
      }
      try {
        const result = await (await checkHost(record)).cancel();
        if (result.cancelRequested === true) store.confirmCancel(record, result);
        // Descendants on any application stop with their parent; each keeps its own
        // record and report, so nothing is dropped from the tree.
        for (const child of store.descendantsOf([record.agentId])) {
          if (child.closed || !child.task) continue;
          if (targetOf(child) !== 'dsh') {
            if (store.requestCancel(child)) await ensureWorker(store.get(child.agentId), { wake: true });
            continue;
          }
          try {
            await store.locked(child.agentId, async () => {
              const current = store.get(child.agentId);
              if (!current || current.closed || !store.requestCancel(current)) return;
              const cancelled = await (await checkHost(current)).cancel();
              if (cancelled.cancelRequested === true) store.confirmCancel(current, cancelled);
            });
          } catch { /* its own poll reports the failure on that record. */ }
        }
        return { name, accepted: result.cancelRequested === true, state: 'cancelling' };
      } finally {
        const current = store.get(record.agentId);
        if (current?.task?.taskId === record.task.taskId) await ensureWorker(current);
      }
    },
    async delete({ name }, extra) {
      const owner = await context(extra);
      const record = named(owner, name);
      if (targetOf(record) === 'dsh') return withName(extra, name, current => clearRecord(current));
      const queued = store.requestCleanup(record);
      if (queued) await ensureWorker(store.get(record.agentId), { wake: true });
      return { name, deleted: false, queued, state: queued ? 'cleaning' : 'removed' };
    },
    /**
     * Explicit ask/report from a managed Codex Desktop child, called from that
     * child's own chat. The caller is found from its chat metadata (never a tool
     * argument) through the binding its backend recorded, and the submission joins
     * the same task so the one state machine delivers it to the parent.
     */
    async submitToParent({ kind, message, final = false }, extra) {
      textMessage(message);
      if (!['ask', 'report'].includes(kind)) throw new Error('kind must be ask or report.');
      const threadId = callingThread(extra);
      const bound = store.agentForCodexThread(threadId);
      const record = bound ? store.get(bound.agentId) : undefined;
      if (!record || record.closed || !record.task) {
        throw Object.assign(new Error('This chat is not bound to a managed subagent with a current task.'),
          { code: 'submission-not-owned' });
      }
      if (record.task.reports?.some(report => report.final)) {
        throw Object.assign(new Error('This task already submitted its final report.'), { code: 'final-already-submitted' });
      }
      const id = uid('submission');
      store.enqueueSubmission({ id, ownerId: record.ownerId, agentId: record.agentId,
        taskId: record.task.taskId, kind, message, final: final === true });
      await ensureWorker(record, { wake: true });
      return { accepted: true, name: record.name, taskId: record.task.taskId, submissionId: id, kind };
    },
    async wait({ names, timeoutSeconds = 0 } = {}, extra) {
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 45) throw new Error('Wait between 0 and 45 seconds.');
      const owner = await context(extra);
      if (names) names.forEach(assertName);
      const available = store.list(owner.ownerId);
      const selected = available.filter(record => !names || names.includes(record.name));
      const selectedIds = selected.map(record => record.agentId);
      const notListed = new Set((names ?? []).filter(name => !available.some(record => record.name === name)));
      const deadline = Date.now() + timeoutSeconds * 1000;
      let items;
      do {
        items = [];
        for (const id of selectedIds) {
          const record = store.get(id);
          if (!record) { notListed.add(selected.find(item => item.agentId === id).name); continue; }
          items.push(publicResult(record, { fullResult: true }));
        }
        if (!selectedIds.length || notListed.size || items.some(item => item.error || ['awaiting_input', 'awaiting_report', 'cancelled', 'idle', 'delivery_pending', 'cleanup_failed', 'failed'].includes(item.state))) break;
        if (Date.now() >= deadline) break;
        await wait(Math.min(250, deadline - Date.now()));
      } while (true);
      return { items, notListed: [...notListed],
        ...(notListed.size ? { note: 'These names are not in this chat’s current list. Absence alone does not prove task completion; use the delivered result.' } : {}),
        timedOut: Date.now() >= deadline && items.some(item => item.state === 'running') };
    },
    poll(agentId) {
      if (inflight.has(agentId)) return inflight.get(agentId);
      if (draining) return Promise.resolve({ draining: true });
      const work = store.locked(agentId, async () => { const record = store.get(agentId); return record ? pollLocked(record) : { removed: true }; }, { waitMs: 0 })
        .finally(() => { inflight.delete(agentId); onPollComplete(); });
      inflight.set(agentId, work);
      return work;
    },
    async resume() {
      const records = typeof store.listWorkerCandidates === 'function' ? store.listWorkerCandidates() : store.list();
      const pending = records.filter(record => record.sleep?.wakePending === true || needsPoll(record));
      if (!pending.length) return;
      if (await ensureMonitor()) return;
      // One listener serves every name: record the failure on each waiting name
      // instead of starting a process per agent.
      for (const record of pending) {
        store.setError(record.agentId, monitorError ?? { code: 'monitor-unavailable', message: 'The shared monitor could not start.' });
      }
    },
    // One shared round: poll every name that still owes work through the same
    // state machine. The shared monitor calls this each round, and the degraded
    // in-process sweep below reuses it when no monitor can be started.
    async monitorScan() {
      if (draining) return inflight.size > 0 || monitorInflight.size > 0;
      const candidates = typeof store.listWorkerCandidates === 'function' ? store.listWorkerCandidates() : store.list();
      let busy = inflight.size > 0 || monitorInflight.size > 0;
      for (const candidate of candidates) {
        const record = store.get(candidate.agentId);
        if (!record || !needsPoll(record)) continue;
        busy = true;
        if (monitorInflight.has(record.agentId) || nextPollAt.get(record.agentId) > Date.now() || record.nextAttemptAt > Date.now()
            || (!record.task?.cancelRequested && (record.task?.dispatches ?? []).some(d => !d.accepted && d.state === 'retrying' && d.nextAttemptAt > Date.now()))) continue;
        const work = service.poll(record.agentId).then(() => service.trySleep(record.agentId))
          .catch(() => { /* The next round retries from durable state. */ })
          .finally(() => {
            monitorInflight.delete(record.agentId);
            if (store.get(record.agentId)) nextPollAt.set(record.agentId, Date.now() + 1000);
            else nextPollAt.delete(record.agentId);
            onPollComplete();
          });
        monitorInflight.set(record.agentId, work);
      }
      return busy;
    },
    async drainPolls() {
      draining = true;
      await Promise.allSettled([...monitorInflight.values(), ...inflight.values()]);
    },
    async ensureIdleMonitor() {
      const records = typeof store.listWorkerCandidates === 'function' ? store.listWorkerCandidates() : store.list();
      const pending = records.some(record => record.sleep?.wakePending === true || needsPoll(record));
      if (!store.hasSleeping() && !pending) { monitorUnavailableSince = undefined; return false; }
      let ready = false;
      try { ready = await startSharedMonitor(config, store); } catch { ready = false; }
      if (ready) { monitorUnavailableSince = undefined; return true; }
      monitorUnavailableSince ??= Date.now();
      if (Date.now() - monitorUnavailableSince >= monitorFailureGraceMs) {
        // Degraded mode: sweep in this process instead of spawning one per name.
        monitorUnavailableSince = Date.now();
        try { await service.monitorScan(); } catch { /* The next call retries. */ }
        return true;
      }
      return false;
    },
    async wake(agentId, taskId) {
      const record = store.get(agentId);
      if (!record || record.sleep?.taskId !== taskId || record.sleep.sessionId !== record.sessionId) return false;
      await ensureWorker(record, { wake: true });
      return true;
    },
    async trySleep(agentId) {
      return store.locked(agentId, async () => {
        const record = store.get(agentId);
        if (!record || !canSleep(record, store.supplements(agentId), treeSettled)) return false;
        if (!await startSharedMonitor(config, store)) return false;
        return store.sleep(record, idleSignal({ ...record.observation, taskId: record.task.taskId }));
      });
    },
    close() { store.close(); },
  };

  async function answerLocked(record, message, queuedAnswerId) {
    if (!record.task || record.closed || record.task.cancelRequested) throw new Error('This subagent has no open task waiting for an answer.');
    await negotiateTree(record);
    await checkHost(record);
    const view = await observe(record);
    const existing = (record.task.answers ?? []).find(answer => queuedAnswerId ? answer.answerId === queuedAnswerId : !answer.questionIds && answer.message === message);
    if (!existing && !(view.questions ?? []).some(question => question.state === 'pending')) throw new Error('This subagent has no unanswered question.');
    record.task.answers ??= [];
    const answer = existing ?? { answerId: queuedAnswerId ?? uid('answer'), message, dispatched: false };
    if (!existing) record.task.answers.push(answer);
    store.save(record);
    try { await resolveAnswer(record, answer); }
    catch (error) { record.error = safeError(error); store.save(record); await ensureWorker(record); throw error; }
    record.state = 'running'; record.task.state = 'running'; store.save(record);
    await ensureWorker(record, { wake: true });
    return { name: record.name, answered: true, state: 'resuming' };
  }
  return service;
}
