import path from 'node:path';
import { activeManagedRequestId, isCancelledRound } from './roster-store.mjs';
import { classifyManagedRole, resolveRoleDefaults } from './team-config-defaults.mjs';

export const MANAGED_CLI_TARGETS = ['codex-cli', 'claude-cli', 'agy-cli'];
export const MANAGED_TOKEN_FILENAME = 'managed-cli-caller.json';
export const DESKTOP_CALLER_TOKEN_ENV = 'FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE';
export const MANAGED_BASE_TOOLS = Object.freeze([
  'ask_parent', 'report_parent', 'feedback', 'futureaide_board_post', 'futureaide_board_read',
]);
const REVIEW_TOOLS = [
  'futureaide_run_agent', 'futureaide_wait_agents', 'futureaide_read_report',
  'futureaide_list_agents', 'futureaide_answer_agent', 'futureaide_cancel_agent',
];
const LEAD_TOOLS = [
  ...REVIEW_TOOLS, 'futureaide_create_agent', 'futureaide_send_agent', 'futureaide_team',
  'futureaide_inspect_agent', 'futureaide_agent_changes', 'futureaide_delete_agent',
];

export function managedTokenFile(desktopFile) {
  return desktopFile ? path.join(path.dirname(path.resolve(desktopFile)), MANAGED_TOKEN_FILENAME) : undefined;
}

export const managedCliEnv = env => Object.fromEntries(Object.entries(env ?? {})
  .filter(([key]) => key.toUpperCase() !== DESKTOP_CALLER_TOKEN_ENV));

const denied = message => Object.assign(new Error(message), { code: 'permission-denied' });
const samePath = (first, second) => {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(first) === normalize(second);
};

export function managedBindingFromEnv(env = process.env, target) {
  return {
    agentId: env.FUTUREAIDE_PARENT_AGENT_ID ?? env.FUTUREAIDE_AGENT_ID,
    taskId: env.FUTUREAIDE_PARENT_TASK_ID ?? env.FUTUREAIDE_TASK_ID,
    requestId: env.FUTUREAIDE_PARENT_REQUEST_ID ?? env.FUTUREAIDE_RUN_ID,
    target: target ?? env.FUTUREAIDE_MANAGED_TARGET,
    ownerId: env.FUTUREAIDE_CALLER_OWNER_ID,
    workspace: env.FUTUREAIDE_CALLER_WORKSPACE,
    role: env.FUTUREAIDE_CALLER_ROLE,
  };
}

function privileges(role, roleOptions) {
  const tier = classifyManagedRole(role, roleOptions);
  if (tier === 'lead') return 'lead';
  if (tier === 'review') return 'review';
  return 'base';
}

export function managedToolNames(role, roleOptions) {
  const level = privileges(role, roleOptions);
  if (level === 'lead') return [...MANAGED_BASE_TOOLS, ...LEAD_TOOLS];
  if (level === 'review') return [...MANAGED_BASE_TOOLS, ...REVIEW_TOOLS];
  return [...MANAGED_BASE_TOOLS];
}

function ancestry(store, record) {
  const records = [record];
  const seen = new Set([record.agentId]);
  while (records.at(-1).parentAgentId) {
    const parent = store.get(records.at(-1).parentAgentId);
    if (!parent || seen.has(parent.agentId)) return [];
    seen.add(parent.agentId);
    records.push(parent);
  }
  return records;
}

export function verifyManagedCaller(store, binding = {}, { allowFinal = false } = {}) {
  const { agentId, taskId, requestId, target } = binding;
  const record = agentId && store?.get(agentId);
  const task = record?.task;
  const workspace = record?.rootWorkspace ?? record?.workspace;
  if (!record || record.closed || !taskId || !requestId || !MANAGED_CLI_TARGETS.includes(target)
      || record.target !== target || task?.taskId !== taskId || activeManagedRequestId(task) !== requestId
      || ['idle', 'failed', 'cancelled', 'completed', 'cleaning'].includes(record.state)
      || isCancelledRound(record)
      || (binding.ownerId && binding.ownerId !== record.ownerId)
      || (binding.workspace && !samePath(binding.workspace, workspace))
      || (binding.role && binding.role !== record.role)
      || (!allowFinal && (task.reports?.some(report => report.final)
        || store.submissions(agentId, taskId).some(report => report.kind === 'report' && report.final)))) {
    throw denied('This caller has no active managed dispatch.');
  }
  const root = ancestry(store, record).at(-1);
  if (!root) throw denied('The caller team could not be verified.');
  return {
    source: 'managed-cli', nativeSessionId: agentId, callerAgentId: agentId, parentAgentId: agentId,
    callerTaskId: taskId, callerRequestId: requestId, callerRole: record.role, target,
    ownerId: record.ownerId, workspace, rootOwnerId: root.ownerId, callerName: record.name,
  };
}

function teamMembers(store, caller) {
  return store.list().filter(record => !record.closed && ancestry(store, record).at(-1)?.ownerId === caller.rootOwnerId);
}

function findMember(store, members, name) {
  if (!name || typeof name !== 'string') return undefined;
  const pathMatches = members.filter(record => record.agentId === name
    || (name.includes('/') && ancestry(store, record).map(member => member.name).reverse().join('/') === name));
  const matches = pathMatches.length ? pathMatches : members.filter(record => record.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function canManage(store, caller, record, level, roleOptions) {
  if (!record || record.agentId === caller.callerAgentId) return false;
  const chain = ancestry(store, record);
  const index = chain.findIndex(member => member.agentId === caller.callerAgentId);
  return index > 0 && (level === 'lead' || isReadOnlyScout(chain[index - 1], roleOptions));
}

function isReadOnlyScout(record, roleOptions) {
  return record.readOnlyScout === true && classifyManagedRole(record.role, roleOptions) === 'scout' && record.target === 'codex-cli';
}

export function parseManagedBoardMentions(message, explicit) {
  const mentions = new Set(Array.from(
    String(message ?? '').matchAll(/@([\p{L}\p{N}._-]+(?:\/[\p{L}\p{N}._-]+)*)/gu), match => match[1],
  ));
  for (const name of Array.isArray(explicit) ? explicit : []) {
    if (typeof name === 'string' && name.trim()) mentions.add(name.trim().replace(/^@/, ''));
  }
  return [...mentions].filter(Boolean);
}

export function managedBoardRoutes(store, caller, args, roleOptions) {
  const mentions = parseManagedBoardMentions(args.message, args.mentions);
  const level = privileges(caller.callerRole, roleOptions);
  const members = teamMembers(store, caller);
  const stubs = (store.listAgentStubs?.(caller.rootOwnerId) ?? [])
    .filter(stub => !members.some(member => member.agentId === stub.agentId));
  if (args.urgent === true && level === 'base') throw denied('Only the caller’s team leadership can post urgent messages.');
  const routed = mentions.map(mention => {
    const record = findMember(store, [...members, ...stubs], mention);
    // Urgent posts must preflight every mention before the post or any wake.
    if (args.urgent === true && !canManage(store, caller, record, 'lead')) {
      throw denied('An urgent mention is outside the caller’s descendant team.');
    }
    if (!record) return { mention, action: 'not-found' };
    return {
      mention, name: record.name, targetAgentId: record.agentId,
      targetTaskId: record.task?.taskId ?? null, taskId: record.task?.taskId ?? null,
      agentPath: ancestry(store, record).map(member => member.name).reverse().join('/'),
      action: 'deferred', urgent: args.urgent === true,
    };
  });
  return { mentions, routed };
}

export function mergeRunTaskDefaults(defaults, item) {
  const { tasks, name, message, worktree, workspaceMode, workspace_mode, timeout_minutes, ...shared } = defaults;
  const merged = { ...shared, ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)) };
  const workspaceFor = spec => spec.workspaceMode ?? spec.workspace_mode
    ?? (spec.worktree === true ? 'worktree' : spec.worktree === false ? 'inherit' : undefined);
  const selectedWorkspace = workspaceFor(item) ?? workspaceFor(defaults);
  const selectedTimeout = item.timeoutMinutes ?? item.timeout_minutes ?? defaults.timeoutMinutes ?? timeout_minutes;
  delete merged.worktree;
  delete merged.workspace_mode;
  delete merged.timeout_minutes;
  if (selectedWorkspace !== undefined) merged.workspaceMode = selectedWorkspace;
  if (selectedTimeout !== undefined) merged.timeoutMinutes = selectedTimeout;
  return merged;
}

export function authorizeManagedTool(store, caller, tool, args = {}, roleOptions) {
  const verified = verifyManagedCaller(store, {
    agentId: caller.callerAgentId, taskId: caller.callerTaskId, requestId: caller.callerRequestId,
    target: caller.target, ownerId: caller.ownerId, workspace: caller.workspace,
  });
  const level = privileges(verified.callerRole, roleOptions);
  if (!managedToolNames(verified.callerRole, roleOptions).includes(tool)) throw denied('This tool is outside the caller’s managed role.');
  if (tool === 'futureaide_board_post' && args.urgent === true) managedBoardRoutes(store, verified, args, roleOptions);
  if (MANAGED_BASE_TOOLS.includes(tool)) return verified;

  if (args.scope === 'all' || ['strays', 'sweep', 'adopt'].includes(args.action)) {
    throw denied('Global team operations require the owner.');
  }
  if (tool === 'futureaide_wait_agents' && !args.names?.length && !args.taskKeys?.length) {
    throw denied('Select a descendant by name or task key.');
  }
  const members = teamMembers(store, verified);
  const requireMember = name => {
    if (!canManage(store, verified, findMember(store, members, name), level, roleOptions)) {
      throw denied('The target is outside the caller’s managed team.');
    }
  };
  if (tool === 'futureaide_run_agent' || tool === 'futureaide_create_agent') {
    const batch = Array.isArray(args.tasks) ? args.tasks.map(item => mergeRunTaskDefaults(args, item)) : [args];
    for (const item of batch) {
      const existing = item.name && members.some(member => member.name === item.name || member.agentId === item.name
        || ancestry(store, member).map(node => node.name).reverse().join('/') === item.name);
      if (level === 'review') {
        const defaults = resolveRoleDefaults(item.role, roleOptions);
        const target = item.target ?? defaults.target;
        const lifetime = item.lifetime ?? defaults.lifetime;
        if (classifyManagedRole(item.role, roleOptions) !== 'scout' || target !== 'codex-cli' || lifetime !== 'once'
            || item.worktree || (item.workspaceMode ?? item.workspace_mode) === 'worktree' || item.baseSha || existing
            || (item.name && (item.name.includes('/') || (store.listAgentStubs?.(verified.rootOwnerId) ?? []).some(stub => stub.name === item.name)))) {
          throw denied('Reviewers can only start new, read-only, once Codex CLI scouts.');
        }
      } else if (existing || item.name?.includes('/')) {
        requireMember(item.name);
      }
    }
    return level === 'review' ? { ...verified, readOnlyScout: true } : verified;
  }
  if (args.name) requireMember(args.name);
  for (const name of args.names ?? []) requireMember(name);
  if (tool === 'futureaide_team') {
    requireMember(args.target);
    if (args.action === 'reparent' && args.parent == null) throw denied('Reparenting to the team root requires the owner.');
    if (args.parent) requireMember(args.parent);
  }
  for (const key of args.taskKeys ?? (args.task_key ? [args.task_key] : [])) {
    const mapping = store.resolveTaskKeyAnyOwner(key);
    if (!mapping || !canManage(store, verified, store.get(mapping.agentId), level, roleOptions)) {
      throw denied('The task receipt is outside the caller’s managed team.');
    }
  }
  return verified;
}

export function restrictManagedRoster(store, caller, result, roleOptions) {
  if (!Array.isArray(result?.items) || result.scope !== 'team') return result;
  const level = privileges(caller.callerRole, roleOptions);
  const allowed = new Set(teamMembers(store, caller).filter(record => canManage(store, caller, record, level, roleOptions))
    .map(record => ancestry(store, record).map(member => member.name).reverse().join('/')));
  const items = result.items.filter(item => allowed.has(item.agentPath ?? item.name));
  return { ...result, hasHierarchy: items.some(item => item.depth > 0), items, total: items.length };
}
