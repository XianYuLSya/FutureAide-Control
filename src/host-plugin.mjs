import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
/** Read the durable descendant catalog; diagnostics never authorize cleanup. */
export async function readManagedTree(subagents, agents, root, changesBySession = {}) {
  if (typeof subagents?.listDescendants !== 'function') throw new Error('managed-tree-unavailable');
  const rows = await subagents.listDescendants(root.id);
  if (!Array.isArray(rows)) throw new Error('managed-tree-unavailable');
  const known = new Set([root.id]);
  const nodes = [{ sessionId: root.id, parentSessionId: null, name: null,
    status: root.status, activity: root.status, changes: structuredClone(changesBySession[root.id] ?? []),
    coverage: { complete: false, source: 'agent-file-tool-results' } }];
  for (const row of rows) {
    if (row.kind !== 'child' || typeof row.id !== 'string' || !known.has(row.parentId) || known.has(row.id)) throw new Error('managed-tree-unverified');
    known.add(row.id);
    const agent = agents.get(row.id);
    nodes.push({ sessionId: row.id, parentSessionId: row.parentId, name: row.label ?? null, mode: row.mode,
      status: agent?.status ?? 'unloaded', activity: agent?.status ?? row.activity ?? 'unknown',
      changes: structuredClone(changesBySession[row.id] ?? []), coverage: { complete: false, source: 'agent-file-tool-results' } });
  }
  return nodes;
}

/** DSH SDK's completion barrier, scoped to the exact live root and task. */
export async function waitManagedTree(subagents, agents, root, isCurrent) {
  if (typeof subagents?.waitForChildren !== 'function' || typeof root.whenIdle !== 'function') throw new Error('managed-tree-unavailable');
  while (isCurrent()) {
    if (agents.get(root.id) !== root) throw new Error('managed-handle-unavailable');
    await root.whenIdle();
    const seq = root.session.seq;
    const joined = await subagents.waitForChildren(root);
    if (!isCurrent()) return null;
    if (agents.get(root.id) !== root) throw new Error('managed-handle-unavailable');
    if (!joined && root.status === 'idle' && root.session.seq === seq) return seq;
  }
  return null;
}

export const name = 'futureaide-control-host';
// Tools belong to each Agent's composition; the bridge also mounts at host scope.
export const inject = ['connection', 'webServer', 'agents', 'sessions'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
export const MANAGED_METHODS = ['managedCreate', 'managedBeginTask', 'managedStatus', 'managedHistory', 'managedAnswer', 'managedCancel', 'managedDestroy'];

function managedId(value) {
  if (!ID.test(value ?? '')) reject('invalid-managed-identity');
  return value;
}

function canonicalEqual(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sessionCursor(session) {
  return Number.isSafeInteger(session?.seq) && session.seq >= 0
    ? session.seq - 1 : session?.events?.at(-1)?.seq ?? -1;
}

/** Private records are separate from the project and never become model-facing files. */
function managedFileStore(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) reject('managed-storage-required');
  const filename = key => path.join(directory, `${key}.json`);
  return {
    async read(key) {
      try { return JSON.parse(await readFile(filename(key), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async write(key, record) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // The host is the sole writer; direct writes avoid moving files on user volumes.
      await writeFile(filename(key), JSON.stringify(record), { mode: 0o600 });
    },
    async remove(key) { await rm(filename(key), { force: true }); },
  };
}

/**
 * Own ordinary DSH agents from creation through disposal. The small persistence
 * adapter below targets the JSONL, workspace and projection services verified in
 * DSH 0.2.1-rc.3; unsupported storage refuses cleanup instead of archiving it.
 */
export function createManagedHost(ctx, { stateDirectory, store, removeDirectory = rm, installDelegation: testInstallDelegation } = {}) {
  const root = ctx.root ?? ctx;
  const runtimeKey = Symbol.for('futureaide-control.managed-runtimes');
  const runtimes = root[runtimeKey] ??= new Map();
  const directoryKey = typeof stateDirectory === 'string'
    ? (process.platform === 'win32' ? path.resolve(stateDirectory).toLowerCase() : path.resolve(stateDirectory)) : store;
  let runtime = runtimes.get(directoryKey);
  if (!runtime) {
    runtime = { records: new Map(), handles: new Map(), operations: new Map(), writes: new Map(), bindings: new Map(),
      storage: store ?? managedFileStore(stateDirectory) };
    runtimes.set(directoryKey, runtime);
  }
  const { records, handles, operations, writes, bindings, storage } = runtime;
  runtime.treeBarriers ??= new Map();
  runtime.treeInspections ??= new Map();
  runtime.managedAgents ??= new Map();
  // The Agent factory ties ownership to the caller's fiber. The host root stays
  // alive across bridge reloads; replacing only the RPC fiber must not stop agents.
  const owner = typeof root.get === 'function' ? root : ctx;
  const keyOf = input => createHash('sha256').update(`${managedId(input.ownerId)}\n${managedId(input.agentId)}`).digest('hex');
  const service = name => owner.get(name);
  async function installDelegation(agentCtx, agent, record) {
    if (testInstallDelegation) return testInstallDelegation(agentCtx, agent, record);
    const presets = agentCtx.get('agentPresets');
    const tree = presets?.generationFor?.(agentCtx)?.mount?.tree;
    const loader = agentCtx.get('loader');
    if (typeof tree?.entries !== 'function' || typeof loader?.unwrapExports !== 'function' || typeof agentCtx.plugin !== 'function') reject('managed-delegation-unavailable');
    const entry = [...tree.entries()].find(item => item.options?.name === '@deepseek-ai/dsh-tool-subagent'
      && (item.fiber?.config?.toolName ?? 'subagent') === 'subagent');
    if (!entry?.moduleNamespace || !entry.fiber?.config || typeof entry.fiber.config.provider !== 'string') reject('managed-delegation-unavailable');
    const config = structuredClone(entry.fiber.config);
    const fiber = agentCtx.plugin(loader.unwrapExports(entry.moduleNamespace), { ...config, maxDepth: 'provider-managed', toolName: 'managed_subagent' });
    await fiber.await();
    agentCtx.get('systemPrompt')?.context?.({ name: 'futureaide:delegation', order: 100,
      text: 'For delegating work, prefer managed_subagent; use native send_message to communicate with your direct parent and children.' });
  }
  runtime.installManagedDescendant = async agent => {
    if (runtime.managedAgents.has(agent)) return;
    for (const [parent, record] of runtime.managedAgents) {
      if (owner.agents.isOwnedBy?.(agent.id, parent)) {
        await installDelegation(agent.ctx, agent, record);
        runtime.managedAgents.set(agent, record);
        agent.ctx.on('tools/result', (exec, result) => runtime.observeManagedDescendant(agent, exec, result));
        return;
      }
    }
  };
  if (!runtime.managedAgentListener && typeof owner.on === 'function') {
    owner.on('agent/created', async ({ agent }) => runtime.installManagedDescendant(agent));
    owner.on('agent/disposed', ({ agent }) => runtime.managedAgents.delete(agent));
    runtime.managedAgentListener = true;
  }
  const persist = record => {
    const key = keyOf(record);
    record.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify(record);
    const next = (writes.get(key) ?? Promise.resolve()).then(() => storage.write(key, JSON.parse(snapshot)));
    // A failed write remains observable, but must not permanently poison later repair attempts.
    writes.set(key, next.catch(() => {}));
    return next;
  };
  const observeWrite = record => {
    void persist(record).catch(() => { record.observationError = 'managed-state-write-failed'; });
  };
  runtime.observeManagedDescendant = (agent, exec, result) => {
    const record = runtime.managedAgents.get(agent);
    if (!record || exec.agent !== agent || !record.taskId || record.closing || result.isError) return;
    const changes = record.descendantChanges ??= {};
    const own = changes[agent.id] ??= [];
    const values = Array.isArray(result.value?.changes) ? result.value.changes : [result.value];
    for (const change of values) {
      if (typeof change?.path !== 'string' || !path.isAbsolute(change.path)
          || !['create', 'update', 'delete', 'rename'].includes(change.operation)) continue;
      const item = { path: change.path, operation: change.operation, source: 'agent-file-tool-result', attribution: 'confirmed',
        ...(typeof change.before === 'string' || change.before === null ? { before: change.before } : {}),
        ...(typeof change.after === 'string' || change.after === null ? { after: change.after } : {}),
        ...(typeof change.oldPath === 'string' ? { oldPath: change.oldPath } : {}) };
      const existing = own.find(value => value.path === item.path);
      if (existing) {
        if ('before' in existing) item.before = existing.before;
        if (existing.operation === 'create' && item.operation === 'update') item.operation = 'create';
        Object.assign(existing, item);
      }
      else own.push(item);
    }
    observeWrite(record);
  };
  const serial = (input, operation) => {
    const key = keyOf(input);
    const next = (operations.get(key) ?? Promise.resolve()).then(operation);
    operations.set(key, next.catch(() => {}));
    return next;
  };
  async function load(input) {
    const key = keyOf(input);
    const record = records.get(key) ?? await storage.read(key);
    if (!record) reject('managed-agent-not-found');
    if (record.ownerId !== input.ownerId || record.agentId !== input.agentId) reject('managed-owner-mismatch');
    if (input.sessionId !== undefined && record.sessionId !== input.sessionId) reject('managed-session-mismatch');
    if (input.workspace !== undefined && !canonicalEqual(record.workspace, await realpath(input.workspace))) reject('workspace-mismatch');
    if (input.taskId !== undefined && record.taskId !== input.taskId) reject('managed-task-mismatch');
    records.set(key, record);
    return record;
  }
  function snapshot(record, agent = handles.get(keyOf(record))?.agent) {
    return {
      ownerId: record.ownerId, agentId: record.agentId, sessionId: record.sessionId,
      workspace: record.workspace, workspaceId: record.workspaceId, taskId: record.taskId ?? null,
      model: record.model, currentModel: liveModelSelection(agent), agentPreset: record.agentPreset,
      running: agent?.status === 'running', status: record.closing ? 'cleaning' : agent?.status ?? 'unloaded',
      activity: record.activity ?? 'idle', throughSeq: agent ? sessionCursor(agent.session) : record.throughSeq ?? -1,
      questions: structuredClone(record.questions ?? []), changes: structuredClone(record.changes ?? []),
      reports: structuredClone((record.reports ?? []).filter(report => report.taskId === record.taskId)),
      coverage: { source: 'agent-file-tool-results', complete: false,
        limitation: 'Only successful file mutations observed in this agent are attributed; shell and external writes are not inferred from the shared workspace.' },
      updatedAt: record.updatedAt, ...(record.observationError ? { observationError: record.observationError } : {}),
      ...(record.cancelled ? { cancelled: true } : {}),
    };
  }
  async function treeSnapshot(record, agent) {
    const tree = { settled: false, running: agent?.status === 'running', nodes: [], rootSummary: { ready: false } };
    if (!agent || !record.taskId) return tree;
    const subagents = service('subagents');
    try {
      const changes = { ...(record.descendantChanges ?? {}), [record.sessionId]: record.changes ?? [] };
      tree.nodes = await readManagedTree(subagents, owner.agents, agent, changes);
      tree.running ||= tree.nodes.some(node => node.status === 'running');
      if (record.cancelled && record.cancellationSettled && !tree.running) {
        tree.settled = true;
        return tree;
      }
      const after = record.taskStartSeq;
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(agent.session.seq) || tree.running || agent.session.seq <= after + 1) return tree;
      const key = keyOf(record);
      const inspectTask = async () => {
        let cached = runtime.treeInspections.get(key);
        if (!cached || cached.taskId !== record.taskId || cached.seq !== agent.session.seq) {
          const inspectedSeq = agent.session.seq;
          const inspected = await service('sessionController')?.inspect(record.sessionId);
          if (!Array.isArray(inspected?.events) || agent.session.seq !== inspectedSeq) throw new Error('managed-tree-unavailable');
          const taskEvents = inspected.events.filter(event => Number.isSafeInteger(event.seq) && event.seq > after);
          const end = taskEvents.findLastIndex(event => event.type === 'turn/end');
          cached = { taskId: record.taskId, seq: inspectedSeq, taskEvents, end,
            completeTurn: end >= 0 && !taskEvents.slice(end + 1).some(event => event.type === 'turn/start') };
          runtime.treeInspections.set(key, cached);
        }
        return cached;
      };
      if (!Number.isSafeInteger(record.taskTurnEndSeq) || record.taskTurnEndSeq <= after) {
        const recovered = await inspectTask();
        if (!recovered.completeTurn) return tree;
        record.taskTurnEndSeq = recovered.taskEvents[recovered.end].seq;
        await persist(record);
      }
      let barrier = runtime.treeBarriers.get(key);
      if (!barrier || barrier.failed || barrier.taskId !== record.taskId || (barrier.seq !== undefined && barrier.seq !== agent.session.seq)) {
        barrier = { taskId: record.taskId };
        runtime.treeBarriers.set(key, barrier);
        void waitManagedTree(subagents, owner.agents, agent, () => runtime.treeBarriers.get(key) === barrier && record.taskId === barrier.taskId)
          .then(seq => { if (seq !== null) barrier.seq = seq; })
          .catch(() => { barrier.failed = true; });
      }
      tree.settled = !tree.running && !barrier.failed && barrier.seq !== undefined && barrier.seq === agent.session.seq;
      if (tree.settled) {
        const { taskEvents, end, completeTurn } = await inspectTask();
        if (!completeTurn || barrier.seq !== agent.session.seq) { tree.settled = false; return tree; }
        const start = taskEvents.findLastIndex((event, index) => index <= end && event.type === 'turn/start');
        if (start >= 0) {
          const reply = taskEvents.slice(start, end + 1).filter(event => event.type === 'assistant/message')
            .map(event => event.data?.message ?? event.data)
            .map(message => (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'))
            .filter(Boolean).at(-1);
          const reason = taskEvents[end].data?.reason;
          const state = reason?.kind === 'cancelled' || (reason?.kind === 'aborted' && reason?.reason?.kind === 'user')
            ? 'cancelled' : !reason?.kind || reason.kind === 'completed' ? 'completed' : 'failed';
          if (reply || state !== 'completed') tree.rootSummary = { ready: true, reply: reply ?? '', state };
        }
      }
    } catch { tree.settled = false; tree.rootSummary = { ready: false }; tree.observationError = 'managed-tree-unavailable'; }
    return tree;
  }
  function installTools(agentCtx, agent, record) {
    const tools = agentCtx.get('tools');
    if (!tools?.register || !tools.guard) reject('managed-tools-unavailable');
    const key = keyOf(record);
    const previous = bindings.get(key);
    const fresh = previous?.agent !== agent;
    const binding = fresh ? { agent, record } : previous;
    bindings.set(key, binding);
    binding.guard = exec => {
      if (exec.agent !== agent) return undefined;
      if (record.closing || record.cancelled) return 'The controlling agent has stopped this task.';
      if (record.questions.some(question => question.state === 'pending') && exec.name !== 'ask_parent') {
        return 'Wait for the controlling agent to answer before continuing this task.';
      }
      if (record.treeProtocol !== 1 && (exec.name === 'managed_subagent' || exec.name === 'subagent' || exec.name === 'subagent_fork')) {
        return 'The controlling client must reload and enable managed tree support before delegation.';
      }
      return undefined;
    };
    if (fresh) tools.guard(exec => binding.guard(exec));
    binding.questionTool = {
      name: 'ask_parent',
      description: 'Ask the controlling Codex agent a question needed for your current task. Provide the question directly. This ends the current turn; the answer will resume this same task. Do not create a file or run a command to communicate.',
      parameters: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 100000 } }, required: ['message'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { waiting: { type: 'boolean' } }, required: ['waiting'], additionalProperties: false },
        render: () => [{ type: 'text', text: 'Your question has been sent to the controlling agent. Wait for its answer; the original task remains active.' }] },
      async execute(args, exec) {
        if (exec.agent !== agent || record.closing || record.cancelled) reject('managed-task-closed');
        if (!record.taskId) reject('managed-task-required');
        if ((record.reports ?? []).some(report => report.taskId === record.taskId && report.final)) reject('managed-report-finalized');
        if (typeof args?.message !== 'string' || !args.message.trim() || args.message.length > 100000) reject('invalid-question');
        record.questions.push({ id: `question-${randomUUID()}`, taskId: record.taskId, message: args.message,
          state: 'pending', createdAt: new Date().toISOString() });
        record.activity = 'awaiting-answer';
        await persist(record);
        exec.concludeTurn();
        return { waiting: true };
      },
    };
    if (fresh) tools.register({ ...binding.questionTool, execute: (args, exec) => binding.questionTool.execute(args, exec) });
    binding.reportTool = {
      name: 'report_parent',
      description: 'Send a report to your controlling Codex agent. Set final to true for the completed task deliverable. Descendants report to their native parent.',
      parameters: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 100000 }, final: { type: 'boolean', default: false } }, required: ['message'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { accepted: { type: 'boolean' }, final: { type: 'boolean' } }, required: ['accepted', 'final'], additionalProperties: false },
        render: () => [{ type: 'text', text: 'Your report was recorded for delivery to the controlling agent.' }] },
      async execute(args, exec) {
        if (exec.agent !== agent || record.closing || record.cancelled || record.reportProtocol !== 1) reject('managed-task-closed');
        if (!record.taskId) reject('managed-task-required');
        if (typeof args?.message !== 'string' || !args.message.trim() || args.message.length > 100000 || (args.final !== undefined && typeof args.final !== 'boolean')) reject('invalid-report');
        const reports = record.reports ??= [];
        if (reports.some(report => report.taskId === record.taskId && report.final)) reject('managed-report-finalized');
        const report = { id: `report-${randomUUID()}`, taskId: record.taskId, message: args.message, final: args.final === true, createdAt: new Date().toISOString() };
        reports.push(report);
        try { await persist(record); } catch (error) { reports.splice(reports.indexOf(report), 1); throw error; }
        if (report.final) exec.concludeTurn();
        return { accepted: true, final: report.final };
      },
    };
    if (!binding.reportRegistered) {
      tools.register({ ...binding.reportTool, execute: (args, exec) => binding.reportTool.execute(args, exec) });
      binding.reportRegistered = true;
      agentCtx.get('systemPrompt')?.context?.({ name: 'futureaide:reports', order: 100,
        text: 'Keep routine progress in the task record. Use report_parent for agreed milestones, deliverables or issues requiring your controlling agent\'s action, and final: true when the task is complete. Use ask_parent for a decision you need.' });
    }
    binding.preExecute = async (exec, next) => {
      if (exec.agent === agent && record.taskId && !record.closing) {
        record.activity = `tool: ${exec.name}`;
        observeWrite(record);
      }
      return next();
    };
    if (fresh) agentCtx.on('tools/pre-execute', (...args) => binding.preExecute(...args));
    binding.result = (exec, result) => {
      if (exec.agent !== agent || !record.taskId || record.closing || result.isError) return;
      const value = result.value;
      const values = Array.isArray(value?.changes) ? value.changes : [value];
      for (const change of values) {
        if (typeof change?.path !== 'string' || !path.isAbsolute(change.path)
            || !['create', 'update', 'delete', 'rename'].includes(change.operation)) continue;
        const existing = record.changes.find(item => item.path === change.path);
        const item = { path: change.path, operation: change.operation,
          source: 'agent-file-tool-result', attribution: 'confirmed',
          ...(typeof change.before === 'string' || change.before === null ? { before: change.before } : {}),
          ...(typeof change.after === 'string' || change.after === null ? { after: change.after } : {}),
          ...(typeof change.oldPath === 'string' ? { oldPath: change.oldPath } : {}) };
        if (existing) {
          if ('before' in existing) item.before = existing.before;
          if (existing.operation === 'create' && item.operation === 'update') item.operation = 'create';
          Object.assign(existing, item);
        } else record.changes.push(item);
      }
      if (exec.name !== 'ask_parent') record.activity = `finished tool: ${exec.name}`;
      observeWrite(record);
    };
    if (fresh) agentCtx.on('tools/result', (...args) => binding.result(...args));
    binding.event = (session, event) => {
      if (session.id !== record.sessionId || record.closing) return;
      if (Number.isSafeInteger(event.seq)) record.throughSeq = event.seq;
      if (event.type === 'turn/end' && record.taskId && Number.isSafeInteger(event.seq)
          && Number.isSafeInteger(record.taskStartSeq) && event.seq > record.taskStartSeq) record.taskTurnEndSeq = event.seq;
      if (event.type === 'turn/start') record.activity = 'running';
      if (event.type === 'turn/end') record.activity = record.questions.some(question => question.state === 'pending')
        ? 'awaiting-answer' : record.cancelled ? 'cancelled' : 'turn-ended';
      if (['turn/start', 'turn/end', 'tool/call', 'assistant/message'].includes(event.type)) observeWrite(record);
    };
    if (fresh) agentCtx.on('session/event', (...args) => binding.event(...args));
  }
  async function activate(record, { fresh = false } = {}) {
    const key = keyOf(record);
    const owned = handles.get(key);
    if (owned && owner.agents.get(record.sessionId) === owned.agent) return owned.agent;
    if (record.closing) return undefined;
    if (owner.agents.get(record.sessionId)) reject('managed-handle-unavailable');
    const controller = service('sessionController');
    const composer = controller?.agents;
    if (typeof composer?.composeAgent !== 'function') reject('managed-composition-unavailable');
    const composition = await composer.composeAgent(record.agentPreset);
    record.agentPreset = composition.agentPreset;
    const setup = async (agentCtx, agent) => {
      const commit = await composition.setup(agentCtx, agent);
      installTools(agentCtx, agent, record);
      await installDelegation(agentCtx, agent, record);
      bindings.get(key).delegationReady = true;
      runtime.managedAgents.set(agent, record);
      return commit;
    };
    let handle;
    if (fresh) {
      handle = await owner.agents.create({ sessionId: record.sessionId, agentOptions: record.model,
        meta: { cwd: record.workspace, ...(record.agentPreset ? { agentPreset: record.agentPreset } : {}) }, setup });
    } else {
      const inspected = await controller.inspect(record.sessionId);
      const header = inspected?.meta ?? inspected?.header;
      if (header?.id !== record.sessionId || !canonicalEqual(await realpath(header.cwd), record.workspace)) reject('managed-session-mismatch');
      handle = await owner.agents.resume({ resumeSessionId: record.sessionId, agentOptions: record.model, setup });
    }
    if (!handle?.agent || typeof handle.dispose !== 'function') reject('managed-handle-unavailable');
    handles.set(key, handle);
    record.throughSeq = sessionCursor(handle.agent.session);
    await persist(record);
    return handle.agent;
  }
  async function validateOwnedDirectory(directory, root, expectedName) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || typeof directory !== 'string' || !path.isAbsolute(directory)
        || path.basename(directory) !== expectedName) reject('managed-cleanup-path-unavailable');
    let entry;
    try { entry = await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!entry.isDirectory() || entry.isSymbolicLink()) reject('managed-cleanup-path-invalid');
    const [actualRoot, actualDirectory] = await Promise.all([realpath(root), realpath(directory)]);
    const relative = path.relative(actualRoot, actualDirectory);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) reject('managed-cleanup-path-invalid');
    return actualDirectory;
  }
  async function removeOwnedDirectory(directory, root, expectedName) {
    const actualDirectory = await validateOwnedDirectory(directory, root, expectedName);
    if (actualDirectory) await removeDirectory(actualDirectory, { recursive: true, force: true });
  }
  async function cleanupPlan(record, agent, { persistPlan = true } = {}) {
    if (record.cleanup) return record.cleanup;
    const persistence = service('sessionPersistence');
    const registry = service('workspaceRegistry');
    const projectionCache = service('sessionProjectionCache');
    const query = service('sessionQuery');
    if (persistence?.name !== 'session-persistence-jsonl' || typeof persistence.resolveCurrentLog !== 'function'
        || typeof persistence.config?.root !== 'string') reject('managed-cleanup-backend-unsupported');
    const workspace = registry?.get(record.workspaceId);
    if (typeof workspace?.detachSession !== 'function') reject('managed-cleanup-workspace-unsupported');
    if (projectionCache && typeof projectionCache.requireTable?.()?.delete !== 'function') reject('managed-cleanup-cache-unsupported');
    if (query && (typeof query._serialized !== 'function' || typeof query._ensureReady !== 'function'
        || typeof query._reconcile !== 'function' || typeof query._requireDb !== 'function'
        || typeof query._observations?.cache?.delete !== 'function')) reject('managed-cleanup-query-unsupported');
    if (agent) await owner.sessions.flush(agent.session);
    const log = await persistence.resolveCurrentLog(record.sessionId);
    if (typeof log !== 'string' || path.basename(path.dirname(log)) !== record.sessionId) reject('managed-cleanup-path-unavailable');
    const spill = service('spillStore');
    const spillName = `session-${createHash('sha256').update(record.sessionId).digest('hex').slice(0, 12)}`;
    record.cleanup = { sessionRoot: path.resolve(persistence.config.root), sessionDirectory: path.dirname(log),
      ...(typeof spill?.root === 'string' ? { spillRoot: spill.root, spillDirectory: path.join(spill.root, spillName), spillName } : {}) };
    if (persistPlan) await persist(record);
    return record.cleanup;
  }
  const methods = {
    managedCreate(input) { return serial(input, async () => {
      const key = keyOf(input);
      managedId(input.sessionId);
      if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) reject('workspace-required');
      let record = records.get(key) ?? await storage.read(key);
      if (record) {
        record = await load(input);
        if (record.closing) reject('managed-agent-closing');
        const persisted = await service('sessionPersistence')?.stat(record.sessionId);
        const agent = await activate(record, { fresh: record.phase === 'creating' && !persisted });
        const project = service('workspaceRegistry').get(record.workspaceId);
        await owner.sessions.flush(agent.session);
        await project.attachSession(record.sessionId);
        if (!project.sessionIds.includes(record.sessionId)) reject('managed-project-attach-failed');
        record.phase = 'created';
        await persist(record);
        return { ...snapshot(record, agent), created: true, modelRequestsStarted: 0 };
      }
      const workspace = await realpath(input.workspace);
      const registry = service('workspaceRegistry');
      if (!registry?.resolveByPath || !registry?.create) reject('managed-workspace-unavailable');
      const project = await registry.resolveByPath(workspace) ?? await registry.create(workspace);
      const selection = service('agentDefaultModel')?.currentSelection();
      const model = modelValue(selection);
      if (owner.agents.get(input.sessionId) || await service('sessionPersistence')?.stat(input.sessionId)) reject('managed-session-already-exists');
      record = { version: 1, ownerId: input.ownerId, agentId: input.agentId, sessionId: input.sessionId,
        workspace, workspaceId: project.id, model, questions: [], changes: [], activity: 'idle', phase: 'creating' };
      records.set(key, record);
      await persist(record);
      const agent = await activate(record, { fresh: true });
      await owner.sessions.flush(agent.session);
      await project.attachSession(record.sessionId);
      if (!project.sessionIds.includes(record.sessionId)) reject('managed-project-attach-failed');
      record.phase = 'created';
      await persist(record);
      return { ...snapshot(record, agent), created: true, modelRequestsStarted: 0 };
    }); },
    managedBeginTask(input) { return serial(input, async () => {
      managedId(input.taskId);
      if (input.reportProtocol !== 1) reject('managed-report-protocol-required');
      const record = await load({ ...input, taskId: undefined });
      const treeProtocol = input.treeProtocol === 1;
      if ((!treeProtocol && input.treeProtocol !== undefined) || (!treeProtocol && record.treeProtocol === 1)) reject('managed-tree-protocol-required');
      if (record.closing) reject('managed-agent-closing');
      let agent = await activate(record);
      if (record.taskId === input.taskId) {
        record.reportProtocol = 1;
        if (treeProtocol && record.treeProtocol !== 1) {
          record.treeProtocol = 1;
          if (!Number.isSafeInteger(record.taskStartSeq) && Number.isSafeInteger(input.taskStartSeq) && input.taskStartSeq >= -1) record.taskStartSeq = input.taskStartSeq;
        }
        await persist(record);
        return { ...snapshot(record, agent), reportProtocol: 1, ...(treeProtocol ? { treeProtocol: 1 } : {}) };
      }
      if (agent.status === 'running' || record.questions.some(question => question.state === 'pending')) reject('managed-agent-busy');
      const key = keyOf(record);
      if (treeProtocol && !bindings.get(key)?.delegationReady) {
        const handle = handles.get(key);
        if (!handle) reject('managed-handle-unavailable');
        await handle.dispose();
        handles.delete(key); bindings.delete(key); runtime.managedAgents.delete(agent);
        agent = await activate(record);
      }
      runtime.treeBarriers.delete(key); runtime.treeInspections.delete(key);
      Object.assign(record, { taskId: input.taskId, reportProtocol: 1, reports: [], treeProtocol: treeProtocol ? 1 : undefined, taskStartSeq: sessionCursor(agent.session), taskTurnEndSeq: undefined, questions: [], changes: [], descendantChanges: {}, cancelled: false, cancellationSettled: false,
        activity: 'ready', answers: [], throughSeq: sessionCursor(agent.session) });
      await persist(record);
      return { ...snapshot(record, agent), reportProtocol: 1, ...(treeProtocol ? { treeProtocol: 1 } : {}) };
    }); },
    managedStatus(input) { return serial(input, async () => {
      if (input.reportProtocol !== 1) reject('managed-report-protocol-required');
      const record = await load(input);
      if (record.treeProtocol === 1 && input.treeProtocol !== 1) reject('managed-tree-protocol-required');
      const agent = record.closing ? handles.get(keyOf(record))?.agent : await activate(record);
      await (writes.get(keyOf(record)) ?? Promise.resolve());
      return { ...snapshot(record, agent), reportProtocol: 1, tree: await treeSnapshot(record, agent) };
    }); },
    managedHistory(input) { return serial(input, async () => {
      const record = await load(input);
      if (input.treeProtocol !== 1) reject('managed-tree-protocol-required');
      const target = managedId(input.targetSessionId);
      const root = handles.get(keyOf(record))?.agent ?? { id: record.sessionId, status: 'unloaded' };
      let nodes;
      try { nodes = await readManagedTree(service('subagents'), owner.agents, root, record.descendantChanges); }
      catch { reject('managed-tree-unverified'); }
      if (!nodes.some(node => node.sessionId === target)) reject('managed-session-mismatch');
      const inspected = await service('sessionController')?.inspect(target);
      if (!Array.isArray(inspected?.events)) reject('managed-history-unavailable');
      return { events: inspected.events };
    }); },
    managedAnswer(input) { return serial(input, async () => {
      const record = await load(input);
      if (record.closing || record.cancelled) reject('managed-task-closed');
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 100000) reject('invalid-answer');
      if (input.answerId !== undefined) managedId(input.answerId);
      const prior = input.answerId === undefined ? undefined : record.answers?.find(answer => answer.answerId === input.answerId);
      if (prior) {
        if (prior.message !== input.message) reject('managed-answer-conflict');
        return { accepted: true, ...prior };
      }
      const pending = record.questions.filter(question => question.taskId === record.taskId && question.state === 'pending');
      if (!pending.length) reject('managed-no-pending-question');
      const answeredAt = new Date().toISOString();
      for (const question of pending) Object.assign(question, { state: 'answered', answer: input.message, answeredAt });
      const answer = { answerId: input.answerId ?? `answer-${randomUUID()}`, message: input.message,
        consumedQuestionIds: pending.map(question => question.id),
        continuation: `The controlling agent answered your question(s):\n${pending.map(question => `- ${question.message}`).join('\n')}\n\nAnswer:\n${input.message}\n\nContinue the original task. If complete, provide the final result normally.` };
      record.answers ??= [];
      record.answers.push(answer);
      record.activity = 'answer-ready';
      await persist(record);
      return { accepted: true, ...answer };
    }); },
    managedCancel(input) { return serial(input, async () => {
      const record = await load(input);
      if (record.closing) reject('managed-agent-closing');
      const agent = await activate(record);
      const subagents = service('subagents');
      if (typeof subagents?.drainDescendants !== 'function') reject('managed-tree-unavailable');
      let nodes;
      try { nodes = await readManagedTree(subagents, owner.agents, agent, record.descendantChanges); }
      catch { reject('managed-tree-unverified'); }
      record.cancelled = true;
      for (const question of record.questions) if (question.state === 'pending') question.state = 'cancelled';
      record.activity = 'cancelling';
      await persist(record);
      agent.cancel({ kind: 'user' });
      await subagents.drainDescendants([agent]);
      const key = keyOf(record);
      const handle = handles.get(key);
      if (!handle) reject('managed-handle-unavailable');
      await handle.dispose();
      handles.delete(key); bindings.delete(key); runtime.managedAgents.delete(agent);
      record.cancellationSettled = true;
      record.activity = agent.status === 'running' ? 'cancelling' : 'cancelled';
      await persist(record);
      return { ...snapshot(record, agent), cancelled: true, cancelRequested: true, pendingInputCleared: true };
    }); },
    managedDestroy(input) { return serial(input, async () => {
      if (input.reportProtocol !== 1) reject('managed-report-protocol-required');
      let record;
      try { record = await load(input); }
      catch (error) {
        if (error.controlCode !== 'managed-agent-not-found') throw error;
        managedId(input.sessionId);
        const persistence = service('sessionPersistence');
        const registry = service('workspaceRegistry');
        if (!persistence?.stat || !registry?.list) reject('managed-cleanup-verification-unavailable');
        if (owner.agents.get(input.sessionId) || owner.sessions.get(input.sessionId) || await persistence.stat(input.sessionId)
            || registry.list().some(project => project.sessionIds.includes(input.sessionId))
            || registry.pinnedSessionIds?.includes(input.sessionId) || registry.archivedSessionIds?.includes(input.sessionId)
            || service('sessionProjectionCache')?.requireTable().get(input.sessionId)) reject('managed-agent-not-found');
        const query = service('sessionQuery');
        if (query && (typeof query._serialized !== 'function' || typeof query._ensureReady !== 'function'
            || typeof query._requireDb !== 'function')) reject('managed-cleanup-verification-unavailable');
        if (query?._observations?.cache?.has(input.sessionId)) reject('managed-cleanup-incomplete');
        if (typeof query?._serialized === 'function') await query._serialized(undefined, async () => {
          await query._ensureReady(undefined);
          const db = query._requireDb();
          if (db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get(input.sessionId)
              || db.prepare('SELECT id FROM temp.live_sessions WHERE id = ?').get(input.sessionId)) reject('managed-cleanup-incomplete');
        });
        return { sessionId: input.sessionId, released: true, dataDeleted: true, destroyed: true, alreadyDestroyed: true };
      }
      if (record.treeProtocol === 1 && input.treeProtocol !== 1) reject('managed-tree-protocol-required');
      const key = keyOf(record);
      const agent = record.closing ? handles.get(key)?.agent : await activate(record);
      if (!record.cleanupTree) {
        const subagents = service('subagents');
        if (typeof subagents?.drainDescendants !== 'function') reject('managed-tree-unavailable');
        const root = agent ?? { id: record.sessionId, status: 'unloaded' };
        let nodes;
        try { nodes = await readManagedTree(subagents, owner.agents, root, record.descendantChanges); }
        catch { reject('managed-tree-unverified'); }
        if (nodes.some(node => node.mode === 'external' || (node !== nodes[0] && !['one-shot', 'continuable'].includes(node.mode)))) reject('managed-external-cleanup-unsupported');
        record.closing = true;
        record.activity = 'cleaning';
        await persist(record);
        if (agent) {
          agent.cancel({ kind: 'user' });
          await subagents.drainDescendants([agent]);
        } else if (nodes.some(node => owner.agents.get(node.sessionId) || owner.sessions.get(node.sessionId))) {
          reject('managed-release-incomplete');
        }
        try { nodes = await readManagedTree(subagents, owner.agents, root, record.descendantChanges); }
        catch { reject('managed-tree-unverified'); }
        if (nodes.some(node => node.mode === 'external' || (node !== nodes[0] && !['one-shot', 'continuable'].includes(node.mode)))) reject('managed-external-cleanup-unsupported');
        if (!agent && nodes.some(node => owner.agents.get(node.sessionId) || owner.sessions.get(node.sessionId))) reject('managed-release-incomplete');
        const plans = [];
        for (const node of nodes.slice().reverse()) {
          const candidate = node.sessionId === record.sessionId ? record : { ...record, sessionId: node.sessionId, cleanup: undefined };
          if (candidate !== record) {
            const inspected = await service('sessionController')?.inspect(node.sessionId);
            const header = inspected?.meta ?? inspected?.header;
            if (header?.id !== node.sessionId || typeof header.cwd !== 'string') reject('managed-tree-unverified');
            const relative = path.relative(record.workspace, await realpath(header.cwd));
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) reject('managed-tree-unverified');
          }
          const plan = await cleanupPlan(candidate, owner.agents.get(node.sessionId), { persistPlan: false });
          if (!await validateOwnedDirectory(plan.sessionDirectory, plan.sessionRoot, node.sessionId)) reject('managed-cleanup-path-unavailable');
          if (plan.spillDirectory) await validateOwnedDirectory(plan.spillDirectory, plan.spillRoot, plan.spillName);
          plans.push({ sessionId: node.sessionId, ...plan });
        }
        record.cleanupTree = plans;
        await persist(record);
      }
      record.closing = true;
      record.activity = 'cleaning';
      await persist(record);
      const handle = handles.get(key);
      if (handle) {
        handle.agent.cancel({ kind: 'user' });
        await service('subagents').drainDescendants([handle.agent]);
        await handle.dispose();
        handles.delete(key);
        bindings.delete(key);
      }
      for (const cleanup of record.cleanupTree) {
        if (owner.agents.get(cleanup.sessionId) || owner.sessions.get(cleanup.sessionId)) reject('managed-release-incomplete');
        await removeOwnedDirectory(cleanup.sessionDirectory, cleanup.sessionRoot, cleanup.sessionId);
        if (cleanup.spillDirectory) await removeOwnedDirectory(cleanup.spillDirectory, cleanup.spillRoot, cleanup.spillName);
      }
      const persistence = service('sessionPersistence');
      for (const cleanup of record.cleanupTree) persistence.coldLogMemo?.delete(cleanup.sessionId);
      const projectionCache = service('sessionProjectionCache');
      // Disposal emits a final asynchronous cache write; enqueue our final delete after it.
      if (projectionCache) {
        if (agent) await projectionCache.flushSoft(agent.session, 'managed-delete');
        for (const cleanup of record.cleanupTree) await projectionCache.requireTable().delete(cleanup.sessionId);
      }
      const registry = service('workspaceRegistry');
      for (const cleanup of record.cleanupTree) {
        await registry.get(record.workspaceId).detachSession(cleanup.sessionId);
        await registry.unpinSession(cleanup.sessionId);
        await registry.unarchiveSession(cleanup.sessionId);
        for (const field of ['headers', 'sessionPaths', 'invalidSessionPaths', 'missingSessionPaths']) registry[field]?.delete(cleanup.sessionId);
      }
      const query = service('sessionQuery');
      if (typeof query?._serialized === 'function' && typeof query?._reconcile === 'function') {
        await query._serialized(undefined, async () => {
          for (const cleanup of record.cleanupTree) query._observations.cache.delete(cleanup.sessionId);
          await query._ensureReady(undefined);
          await query._reconcile(undefined);
        });
      }
      for (const cleanup of record.cleanupTree) if (await persistence.stat(cleanup.sessionId)) reject('managed-cleanup-incomplete');
      await (writes.get(key) ?? Promise.resolve());
      await storage.remove(key);
      records.delete(key);
      writes.delete(key);
      return { sessionId: record.sessionId, released: true, dataDeleted: true, destroyed: true };
    }); },
  };
  // Existing registrations belong to their Agent scopes. Swap only their
  // callbacks so hot code uses the shared record and current implementation.
  for (const binding of bindings.values()) {
    if (owner.agents.get(binding.record.sessionId) === binding.agent) installTools(binding.agent.ctx, binding.agent, binding.record);
  }
  return methods;
}

function reject(code) {
  const error = new Error(code);
  error.controlCode = code;
  throw error;
}

function latest(events, type) {
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === type) return events[i].data;
}

function modelValue(value) {
  if (!value || typeof value.provider !== 'string' || !value.provider.trim() || value.provider.length > 200
      || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200
      || (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string'
        || !value.reasoningEffort.trim() || value.reasoningEffort.length > 100))) reject('invalid-model');
  return { provider: value.provider, model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) };
}

async function inWorkspace(candidate, workspace) {
  if (typeof candidate !== 'string' || typeof workspace !== 'string' || !path.isAbsolute(workspace)) return false;
  const [root, target] = await Promise.all([realpath(workspace), realpath(candidate)]);
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveAgent(ctx, sessionId, workspace, activate) {
  if (!ID.test(sessionId ?? '')) reject('invalid-session');
  let agent = ctx.agents.get(sessionId);
  let activated = false;
  if (!agent && activate) {
    const controller = ctx.get('sessionController');
    if (controller) {
      const inspected = await controller.inspect(sessionId);
      const header = inspected?.header ?? inspected?.meta;
      if (!await inWorkspace(header?.cwd, workspace)) reject('workspace-mismatch');
      const result = await controller.resolveAgent(sessionId);
      if (result.error) reject('agent-unavailable');
      agent = result.agent;
    } else {
      const proxy = ctx.get('apiProxy');
      if (!proxy) reject('host-api-unavailable');
      const listed = await proxy.sessions.list({ rpcId: 'codex-capabilities-list', payload: {} });
      const row = listed.result?.value?.items?.find(item => item.sessionId === sessionId);
      if (!await inWorkspace(row?.cwd, workspace)) reject('workspace-mismatch');
      if (row.origin === 'subagent') reject('subagent-owned');
      const loaded = await proxy.sessions.models({ rpcId: 'codex-capabilities-load', payload: { sessionId } });
      if (!loaded.result?.ok) reject('agent-unavailable');
      agent = ctx.agents.get(sessionId);
    }
    activated = true;
  }
  if (!agent) reject('agent-not-loaded');
  if (!await inWorkspace(agent.session.header.cwd, workspace)) reject('workspace-mismatch');
  return { agent, activated };
}

/** Return a durable ordinary session's final event sequence without loading its Agent. */
async function historyCursor(ctx, sessionId, workspace) {
  if (!ID.test(sessionId ?? '')) reject('invalid-session');
  const controller = ctx.get('sessionController');
  if (!controller || typeof controller.inspect !== 'function') reject('history-cursor-unavailable');
  const inspected = await controller.inspect(sessionId);
  const header = inspected?.meta ?? inspected?.header;
  if (!await inWorkspace(header?.cwd, workspace)) reject('workspace-mismatch');
  if (header?.origin === 'subagent') reject('subagent-owned');
  const events = inspected?.events;
  if (!Array.isArray(events)) reject('history-cursor-unavailable');
  const event = events.findLast(value => Number.isSafeInteger(value?.seq) && value.seq >= 0);
  return { sessionId, throughSeq: event?.seq ?? -1 };
}

/** Read registered schemas and effective policy without executing any tool or model. */
export function liveModelSelection(agent) {
  if (!agent) return undefined;
  const session = agent.session;
  const projections = agent.ctx?.get('sessionProjections')?.snapshot(session)?.values ?? {};
  const value = projections.modelSelection?.next ?? projections.modelSelection?.lastUsed
    ?? latest(session.events ?? [], 'model/selection') ?? session.requestHeader?.()?.config ?? agent.options;
  return value?.provider && value?.model ? modelValue(value) : undefined;
}

export function capabilitySnapshot(agent, { activated = false } = {}) {
  const ctx = agent.ctx;
  const get = key => ctx.get(key);
  const session = agent.session;
  const tools = get('tools');
  if (!tools || typeof tools.schemas !== 'function') reject('tool-registry-unavailable');
  const projections = get('sessionProjections')?.snapshot(session)?.values ?? {};
  const sandbox = get('sandboxPolicy');
  const approval = get('approval');
  const permission = get('permissionPresets');
  const plan = get('planMode');
  const schemas = tools.schemas(agent).map(schema => {
    const definition = tools.get(schema.name, agent);
    return { ...schema,
      ...(definition?.output?.schema === undefined ? {} : { outputSchema: definition.output.schema }),
      ...(definition?.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
      availability: 'visible-in-session', permissionEvaluation: 'at-call-time',
    };
  });
  return {
    version: 1, capturedAt: new Date().toISOString(), sessionId: agent.id,
    cwd: session.header.cwd, status: agent.status, activated,
    agentPreset: projections.agentPreset ?? session.header.agentPreset ?? null,
    model: liveModelSelection(agent) ?? null,
    tools: schemas, totalTools: schemas.length,
    permissions: {
      sandbox: sandbox ? sandbox.resolve({ session }) : { available: false },
      processSandbox: { available: Boolean(get('sandbox')), implementation: get('sandbox')?.constructor?.name ?? null },
      approval: approval ? { policy: approval.overrideOf(session) ?? approval.config.policy ?? 'ask',
        source: approval.overrideOf(session) === undefined ? 'composition-default' : 'session-override' } : { available: false },
      preset: permission ? { current: projections.permissions?.currentValue
        ?? permission.current(Array.isArray(session.events) ? session.events : session), options: [...permission.names] } : { available: false },
      plan: projections.plan ? { ...projections.plan, source: 'session-projection' }
        : plan || schemas.some(tool => tool.name === 'exit_plan_mode')
          ? { active: latest(session.events, 'plan/mode')?.active ?? false, pending: null, source: 'session-events', pendingStateKnown: false }
          : { available: false },
      limitations: ['Tool schemas are the complete currently visible registry, not a guarantee that every argument is permitted.',
        'Argument-specific approval, filesystem observation, tool guards, external credentials and provider availability are evaluated when called.'],
    },
    complete: true, source: 'live-agent-services', modelRequestsStarted: 0,
  };
}

/** Build the fixed authenticated host methods; no arbitrary tool execution is exposed. */
export function createHostHandler(ctx, token, options = {}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Invalid host bridge credential.');
  const managed = options.stateDirectory || options.store ? createManagedHost(ctx, options) : undefined;
  return async (endpoint, payload) => {
    try {
      const input = payload?.args;
      const supplied = input?.token;
      if (typeof supplied !== 'string' || supplied.length !== token.length
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) reject('bridge-auth-required');
      if (managed && MANAGED_METHODS.includes(endpoint)) return { ok: true, value: await managed[endpoint](input) };
      if (!['capabilities', 'historyCursor', 'ping'].includes(endpoint)) reject('unknown-method');
      if (endpoint === 'ping') return { ok: true, value: { version: 1, revision: options.revision ?? null, ...(managed ? { treeProtocol: 1, reportProtocol: 1 } : {}),
        methods: ['capabilities', 'historyCursor', ...(managed ? MANAGED_METHODS : [])], pid: process.pid } };
      if (endpoint === 'historyCursor') return { ok: true, value: await historyCursor(ctx, input.sessionId, input.workspace) };
      const { agent, activated } = await resolveAgent(ctx, input.sessionId, input.workspace, input.activate === true);
      return { ok: true, value: capabilitySnapshot(agent, { activated }) };
    } catch (error) {
      return { ok: false, error: { code: error.controlCode ?? 'host-operation-failed',
        message: error.controlCode ?? 'The host operation failed; no private runtime configuration is returned.' } };
    }
  };
}

/** Mount an authenticated side channel through the host's normal Connection plugin. */
export async function apply(ctx, config) {
  if (typeof config?.credentialFile !== 'string' || !path.isAbsolute(config.credentialFile)) throw new Error('credentialFile must be absolute.');
  const record = JSON.parse(await readFile(config.credentialFile, 'utf8'));
  const handler = createHostHandler(ctx, record.token, {
    stateDirectory: config.managedStateDirectory ?? path.join(path.dirname(config.credentialFile), 'managed-host'),
    revision: new URL(import.meta.url).searchParams.get('v'),
  });
  const key = Symbol.for('futureaide-control.host-handler');
  const current = ctx.root[key];
  if (current && typeof current.dispose !== 'function') { current.handler = handler; return; }
  if (current) await current.dispose();
  const binding = { handler };
  // New Connection services expose register(owner, ...); pass our injected context
  // explicitly, because the rpc getter retains the Connection provider's context.
  const dispose = await (typeof ctx.connection.register === 'function'
    ? ctx.connection.register(ctx, '/futureaide-control', (...args) => binding.handler(...args))
    : ctx.connection.rpc.handle('/futureaide-control', (...args) => binding.handler(...args), { authority: 'loopback' }));
  // A replacement fiber owns its route; disposing the previous fiber must not
  // remove the replacement's route or leave an active bridge without one.
  let disposed = false;
  binding.dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (typeof dispose === 'function') await dispose();
    if (ctx.root[key] === binding) delete ctx.root[key];
  };
  ctx.root[key] = binding;
  ctx.effect(() => binding.dispose);
  if (config.discoveryFile !== undefined) {
    if (typeof config.discoveryFile !== 'string' || !path.isAbsolute(config.discoveryFile)
        || typeof config.dataRoot !== 'string' || !path.isAbsolute(config.dataRoot)) throw new Error('Discovery paths must be absolute.');
    const instanceKey = Symbol.for('futureaide-control.host-instance');
    const instanceId = ctx.root[instanceKey] ??= randomUUID();
    const launchUrl = await ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`);
    await mkdir(path.dirname(config.discoveryFile), { recursive: true, mode: 0o700 });
    await writeFile(config.discoveryFile, JSON.stringify({ version: 1, application: 'dsh', pid: process.pid,
      instanceId, dataRoot: config.dataRoot, launchUrl, startedAt: new Date().toISOString() }), { mode: 0o600 });
  }
}
