// Compact tool views: the text a calling model reads back from the management tools.
// The service keeps its full result for its own callers; a view only reduces what
// enters the model's context, so nothing here may drop information without a route
// back to it: every read tool with a view accepts detail: true for the full
// structure, and a creation receipt is readable again through list or inspect.

const truncate = (value, length) => typeof value === 'string' && value.length > length ? value.slice(0, length) + '…' : value;

// A running subagent is the only state whose activity text says something the state
// itself does not; everywhere else it would repeat the state or the questions.
const REPORTED_ACTIVITY_STATE = 'running';

const OPEN_QUESTION_STATES = ['queued', 'unknown', 'blocked'];
const MESSAGE_LIMIT = 4000;
const TASK_LIMIT = 80;
const REPORT_LIMIT = 200;
// A team roster is capped so one deep tree cannot fill the context on its own.
const TEAM_ROWS = 30;
const TEAM_ROW_BYTES = 120;
const ACTIVITY_LIMIT = 40;
// The service caps a node's file list at twelve, so twelve is a floor, not a count.
const LISTED_FILES = 12;

// dsh is the default everywhere else, so naming it would cost every entry bytes for nothing.
const targetOfView = value => value && value !== 'dsh' ? { target: value } : {};

/**
 * Format compact duration + token bill string (e.g. "18s · 14.2k tok").
 * Returns undefined when both durationSec and totalTokens are <= 0 or absent.
 */
export function formatUsage(raw) {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const inputTokens = Number(raw.inputTokens ?? raw.input_tokens ?? 0) || 0;
  const outputTokens = Number(raw.outputTokens ?? raw.output_tokens ?? 0) || 0;
  const totalTokens = Number(raw.totalTokens ?? raw.total_tokens ?? (inputTokens + outputTokens)) || 0;
  const rawDurationMs = Number(raw.durationMs ?? raw.duration_ms);
  const rawDurationSec = raw.durationSec ?? raw.duration_sec
    ?? (Number.isFinite(rawDurationMs) && rawDurationMs > 0 ? rawDurationMs / 1000 : 0);
  const durationSec = Number(rawDurationSec) > 0 ? Number(rawDurationSec) : 0;
  if (!(totalTokens > 0 || durationSec > 0)) return undefined;

  const durPart = durationSec > 0 ? `${Math.max(1, Math.round(durationSec))}s` : '';
  let tokPart = '';
  if (totalTokens >= 1_000_000) {
    tokPart = `${(totalTokens / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M tok`;
  } else if (totalTokens >= 1000) {
    tokPart = `${(totalTokens / 1000).toFixed(1).replace(/\.0$/, '')}k tok`;
  } else if (totalTokens > 0) {
    tokPart = `${Math.round(totalTokens)} tok`;
  }
  return [durPart, tokPart].filter(Boolean).join(' · ') || undefined;
}

const usageField = value => {
  const raw = value?.usage
    ?? value?.task?.usage
    ?? value?.task?.result?.usage
    ?? value?.observation?.usage
    ?? value?.body?.usage;
  const formatted = formatUsage(raw);
  return formatted ? { usage: formatted } : {};
};

const questionMessages = item => (item.questions ?? []).map(question => question.message);

const reportField = item => {
  const latest = item.reports?.latest;
  if (!latest) return {};
  const pending = item.reports?.pending ?? 0;
  // An earlier report can still be undelivered while the latest one is through; the
  // count is the only field that says a report is stuck.
  return { report: { summary: truncate(latest.summary, REPORT_LIMIT),
    final: latest.final === true, delivery: latest.delivery,
    ...(latest.error ? { error: latest.error } : {}),
    ...(pending > 0 ? { pending } : {}) } };
};

// The count is the honest headline, and it already includes the unconfirmed paths:
// they are part of the same list, not a second total.
const fileField = item => {
  const changes = item.changes ?? {};
  if (!changes.count) return {};
  const unconfirmed = changes.unconfirmed ?? (changes.files ?? []).filter(file => file.attribution === 'unconfirmed').length;
  return { files: { count: changes.count, ...(unconfirmed ? { unconfirmed } : {}) } };
};

/**
 * One reported file. The service entry may hold complete before/after bodies, which
 * a supervising model never reads; path and operation identify the change, and the
 * team path only matters below the root.
 */
const compactChange = change => ({
  path: change.path,
  operation: change.operation,
  ...(Array.isArray(change.agentPath) && change.agentPath.length > 1 ? { agentPath: change.agentPath } : {}),
  ...(change.attribution === 'unconfirmed' ? { attribution: 'unconfirmed' } : {}),
});

// A member's path is relative to the root, which is the caller's own line and needs
// no row of its own.
const memberPath = node => (node.agentPath ?? []).slice(1).join('/') || node.name;

// A member that cannot be told apart by name still has to be addressable: tree order
// numbers the repeats (#2, #3), and inspect's node matches the same strings.
function teamPaths(nodes) {
  const seen = new Map();
  return nodes.map(node => {
    const base = memberPath(node);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  });
}

const memberRow = (node, path) => {
  const state = node.status ?? node.state;
  const files = Array.isArray(node.changes) ? node.changes.length : (typeof node.files === 'number' ? node.files : 0);
  const role = typeof node.role === 'string' && node.role.trim() ? node.role.trim() : undefined;
  return {
    path,
    ...(role ? { role } : {}),
    state,
    ...(state === REPORTED_ACTIVITY_STATE && node.activity ? { activity: truncate(node.activity, ACTIVITY_LIMIT) } : {}),
    ...(files ? { files: files >= LISTED_FILES ? `${LISTED_FILES}+` : files } : {}),
    ...usageField(node),
  };
};

// A long path or activity is what makes a row overflow; the path gives way first so
// the state and the file count stay readable next to it.
const fitMemberRow = row => {
  const fits = candidate => Buffer.byteLength(JSON.stringify(candidate)) <= TEAM_ROW_BYTES;
  if (fits(row)) return row;
  for (let length = row.path.length - 1; length > 1; length -= 1) {
    const shorter = { ...row, path: row.path.slice(0, length) + '…' };
    if (fits(shorter)) return shorter;
  }
  const shortPath = { ...row, path: '…' };
  if (fits(shortPath) || !row.activity) {
    if (fits(shortPath)) return shortPath;
    const withoutUsage = { ...shortPath };
    delete withoutUsage.usage;
    return withoutUsage;
  }
  for (let length = row.activity.length - 1; length > 1; length -= 1) {
    const shorter = { ...shortPath, activity: row.activity.slice(0, length) + '…' };
    if (fits(shorter)) return shorter;
  }
  const bare = { ...shortPath };
  delete bare.activity;
  if (!fits(bare)) delete bare.usage;
  return bare;
};

/**
 * The team roster: every descendant as one line, so a controlling caller sees the
 * whole tree in one list instead of counting nodes and inspecting each one.
 */
const teamField = item => {
  const members = (item.tree?.nodes ?? []).filter(node => (node.depth ?? 0) > 0);
  if (members.length) {
    const paths = teamPaths(members);
    const rows = members.slice(0, TEAM_ROWS).map((node, index) => fitMemberRow(memberRow(node, paths[index])));
    return { team: members.length > TEAM_ROWS ? [...rows, { more: members.length - TEAM_ROWS }] : rows };
  }
  if (Array.isArray(item.team) && item.team.length) {
    const rows = item.team.slice(0, TEAM_ROWS).map(entry => (
      entry?.more !== undefined
        ? entry
        : fitMemberRow(memberRow(entry, entry.path ?? entry.name ?? ''))
    ));
    return { team: item.team.length > TEAM_ROWS ? [...rows, { more: item.team.length - TEAM_ROWS }] : rows };
  }
  return {};
};

const supplementField = item => {
  const pending = {};
  for (const state of OPEN_QUESTION_STATES) if (item.supplements?.[state]) pending[state] = item.supplements[state];
  return Object.keys(pending).length ? { supplements: pending } : {};
};

const errorFields = value => ({
  ...(value.callbackError ? { callbackError: value.callbackError } : {}),
  ...(value.error ? { error: value.error } : {}),
});

// Default compact views omit the 6 internal effort/lock diagnostic fields
// (requestedEffort, effortSource, selectedEffort, actualEffortSource,
// effortAdjustment, modelLocked); pass detail: true when those are needed.
const actualEffortField = value => (value?.actualEffort === undefined ? {} : { actualEffort: value.actualEffort });
const roleField = value => (typeof value?.role === 'string' && value.role.trim() ? { role: value.role.trim() } : {});
const pathField = value => {
  if (typeof value?.path === 'string' && value.path.trim()) return { path: value.path.trim() };
  if (Array.isArray(value?.agentPath) && value.agentPath.length > 1) return { path: value.agentPath.join('/') };
  return {};
};
const parentField = value => {
  const parent = value?.parentName ?? (typeof value?.parent === 'string' ? value.parent : undefined);
  return parent ? { parent } : {};
};

/**
 * One list or wait entry. Report text appears exactly once here: the service echoes
 * the same reply in task.result, reports.latest and delivery, so only the latest
 * report survives, and the full reply stays reachable through inspect.
 * @param {object} item One publicResult entry, plus list-only supplements/monitor.
 */
export function compactAgent(item = {}) {
  const questions = questionMessages(item);
  const taskText = item.task?.text ?? item.task?.message ?? (typeof item.task === 'string' ? item.task : undefined);
  return {
    name: item.name,
    ...roleField(item),
    ...pathField(item),
    ...parentField(item),
    ...(item.actualModel === undefined ? {} : { actualModel: item.actualModel }),
    ...actualEffortField(item),
    ...(item.inputDelivery ? { inputDelivery: item.inputDelivery } : {}),
    ...targetOfView(item.target),
    state: item.state,
    ...(item.lifetime ? { lifetime: item.lifetime } : {}),
    ...(item.state === REPORTED_ACTIVITY_STATE && item.activity ? { activity: item.activity } : {}),
    ...(taskText ? { task: truncate(taskText, TASK_LIMIT) } : {}),
    ...usageField(item),
    ...(questions.length ? { questions } : {}),
    ...reportField(item),
    ...fileField(item),
    ...teamField(item),
    ...supplementField(item),
    ...(item.expired ? { expired: item.expired } : {}),
    // Only a stopped monitor needs a decision from the caller; every other state is
    // either normal or already visible through the name's own state.
    ...(item.monitor === 'stopped' ? { monitor: 'stopped' } : {}),
    // A tree the host could not observe is not an empty team: saying so is the whole
    // difference between "no members" and "members unknown".
    ...(item.tree?.observationError ? { treeError: item.tree.observationError } : {}),
    ...errorFields(item),
  };
}

/** A creation receipt: coverage and the tree are not what a creation answer is for. */
export function compactCreate(result = {}) {
  return {
    name: result.name,
    ...roleField(result),
    ...(result.actualModel === undefined ? {} : { actualModel: result.actualModel }),
    ...actualEffortField(result),
    ...targetOfView(result.target),
    lifetime: result.lifetime,
    state: result.state,
    ...(typeof result.created === 'boolean' ? { created: result.created } : {}),
    ...(result.modelRequestsStarted === undefined ? {} : { modelRequestsStarted: result.modelRequestsStarted }),
    ...errorFields(result),
  };
}

function formatRunSpec(item = {}) {
  if (typeof item.spec === 'string' && item.spec.trim()) return item.spec.trim();
  const target = typeof item.target === 'string' && item.target.trim() ? item.target.trim() : '';
  const model = [item.actualModel, item.model, item.selectedModel]
    .find(value => typeof value === 'string' && value.trim())?.trim() ?? '';
  const effort = [item.actualEffort, item.selectedEffort, item.requestedEffort, item.effort]
    .find(value => typeof value === 'string' && value.trim())?.trim() ?? '';
  const head = [target, model].filter(Boolean).join(' · ');
  if (head && effort) return `${head} (${effort})`;
  if (head) return head;
  if (effort) return `(${effort})`;
  return '';
}

function compactRunOne(item = {}, { omitWakeCmd = false } = {}) {
  if (!item || typeof item !== 'object') return item;
  const spec = formatRunSpec(item);
  return {
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...roleField(item),
    ...(spec ? { spec } : {}),
    ...(item.taskKey ? { taskKey: item.taskKey } : {}),
    ...(!omitWakeCmd && item.wakeCmd ? { wakeCmd: item.wakeCmd } : {}),
    ...(item.worktreePath ? { worktreePath: item.worktreePath } : {}),
    ...usageField(item),
    ...errorFields(item),
  };
}

/** Slim dispatch receipt for single or batch futureaide_run_agent calls. */
export function compactRun(result = {}) {
  if (result?.batch === true || Array.isArray(result?.items) || Array.isArray(result?.agents)) {
    const rawItems = Array.isArray(result.items)
      ? result.items
      : (Array.isArray(result.agents) ? result.agents : []);
    const omitWakeCmd = typeof result.wakeCmd === 'string' && result.wakeCmd.length > 0;
    return {
      agents: rawItems.map(entry => compactRunOne(entry, { omitWakeCmd })),
      ...(result.wakeCmd !== undefined ? { wakeCmd: result.wakeCmd } : {}),
      ...(Array.isArray(result.errors) && result.errors.length ? { errors: result.errors } : {}),
      ...errorFields(result),
    };
  }
  return compactRunOne(result);
}

/** Slim confirmation receipt for futureaide_send_agent. */
export function compactSend(result = {}) {
  const spec = formatRunSpec(result);
  return {
    ...(result.name !== undefined ? { name: result.name } : {}),
    ...roleField(result),
    ...(spec ? { spec } : {}),
    ...(result.state ? { state: result.state } : {}),
    ...(result.delivery && result.delivery !== 'local-pending' ? { delivery: result.delivery } : {}),
    ...(result.taskKey ? { taskKey: result.taskKey } : {}),
    ...(result.wakeCmd ? { wakeCmd: result.wakeCmd } : {}),
    ...usageField(result),
    ...errorFields(result),
  };
}

/** Slim confirmation receipt for futureaide_answer_agent. */
export function compactAnswer(result = {}) {
  const pendingQuestions = Array.isArray(result.pendingQuestions) && result.pendingQuestions.length
    ? result.pendingQuestions.map(q => (typeof q === 'string' ? q : q?.message ?? q)).filter(Boolean)
    : undefined;
  return {
    ...(result.name !== undefined ? { name: result.name } : {}),
    ...roleField(result),
    answered: result.answered === true,
    ...(typeof result.delivered === 'boolean' ? { delivered: result.delivered } : {}),
    ...(result.state ? { state: result.state } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(pendingQuestions ? { pendingQuestions } : {}),
    ...(result.taskKey ? { taskKey: result.taskKey } : {}),
    ...(result.wakeCmd ? { wakeCmd: result.wakeCmd } : {}),
    ...usageField(result),
    ...errorFields(result),
  };
}

/** Slim confirmation receipt for futureaide_board_post. */
export function compactBoardPost(result = {}) {
  const seq = result.seq ?? result.message?.seq;
  const mentions = Array.isArray(result.mentions)
    ? result.mentions
    : (Array.isArray(result.message?.mentions) ? result.message.mentions : []);
  const woken = Array.isArray(result.woken)
    ? result.woken
    : Array.isArray(result.routed)
      ? result.routed
        .filter(entry => entry && (entry.action === 'woken' || entry.action === 'revived'))
        .map(entry => entry.name ?? entry.agentPath ?? entry.mention)
        .filter(Boolean)
      : [];
  return {
    posted: result.posted === true,
    ...(seq !== undefined ? { seq } : {}),
    mentions,
    woken,
    ...errorFields(result),
  };
}

const slimAffectedEntry = entry => {
  if (!entry || typeof entry !== 'object') return entry;
  return entry.agentPath ?? entry.path ?? entry.name ?? entry;
};

const slimStrayEntry = entry => {
  if (!entry || typeof entry !== 'object') return entry;
  const taskText = typeof entry.task === 'string'
    ? entry.task
    : (entry.task?.text ?? entry.task?.message ?? undefined);
  const reason = entry.reason ?? entry.strayReason;
  return {
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...roleField(entry),
    ...pathField(entry),
    ...(entry.state ? { state: entry.state } : {}),
    ...(reason ? { reason } : {}),
    ...(taskText ? { task: truncate(taskText, TASK_LIMIT) } : {}),
  };
};

/** Slim receipt for futureaide_team governance actions (adopt/kick/reparent/resume/strays/sweep/merge). */
export function compactTeamManage(result = {}) {
  const ok = typeof result.ok === 'boolean' ? result.ok : !result.error;
  const summary = typeof result.summary === 'string' && result.summary.trim()
    ? truncate(result.summary.trim(), REPORT_LIMIT)
    : (typeof result.message === 'string' && result.message.trim()
      ? truncate(result.message.trim(), REPORT_LIMIT)
      : undefined);

  let affected;
  if (Array.isArray(result.affected)) {
    affected = result.affected.map(slimAffectedEntry);
  } else if (result.affected !== undefined) {
    affected = result.affected;
  } else if (Array.isArray(result.adopted)) {
    affected = result.adopted.map(slimAffectedEntry);
  } else if (Array.isArray(result.swept)) {
    affected = result.swept.map(slimAffectedEntry);
  } else if (Array.isArray(result.promotedChildren)) {
    affected = result.promotedChildren.map(slimAffectedEntry);
  } else if (typeof result.name === 'string' && result.name.trim()) {
    affected = result.parent !== undefined ? { name: result.name, parent: result.parent } : result.name;
  }

  const rawMergedFiles = Array.isArray(result.mergedFiles)
    ? result.mergedFiles
    : (result.action === 'merge' && Array.isArray(result.files) ? result.files : undefined);
  const mergedFiles = rawMergedFiles
    ? rawMergedFiles.map(entry => (typeof entry === 'string' ? entry : (entry?.path ?? entry)))
    : undefined;

  const strays = Array.isArray(result.strays) ? result.strays.map(slimStrayEntry) : undefined;

  return {
    ...(result.action ? { action: result.action } : {}),
    ok,
    ...(summary ? { summary } : {}),
    ...(mergedFiles !== undefined ? { mergedFiles } : {}),
    ...(affected !== undefined ? { affected } : {}),
    ...(strays !== undefined ? { strays } : {}),
    ...(result.taskKey ? { taskKey: result.taskKey } : {}),
    ...(result.wakeCmd ? { wakeCmd: result.wakeCmd } : {}),
    ...usageField(result),
    ...errorFields(result),
  };
}

const UNCONFIRMED_NOTE = 'Paths from the before/after workspace comparison may include edits made meanwhile by other processes or assistants.';
const COMPARED_NOTE = 'Shell writes are only found by comparing the workspace before and after the task; ignored paths and non-git folders stay invisible.';

/**
 * The caveat every coverage answer states, in one sentence.
 * @param {object} coverage The service's treeCoverage result.
 * @param {number} unconfirmed How many of the answer's paths came from a comparison.
 */
function baseNote(coverage, unconfirmed) {
  if (unconfirmed) return `${UNCONFIRMED_NOTE} ${unconfirmed} path(s) in this answer are unconfirmed.`;
  const reason = coverage?.workspace?.reason;
  // A task still running has simply not been compared yet, which is not a failure.
  if (reason === 'not-captured') return 'The workspace is compared when the task ends; changes can compare it now.';
  if (reason) return `No workspace comparison was available (${reason}), so changes written through a shell may be missing.`;
  return COMPARED_NOTE;
}

/**
 * A changes answer lists every path it has, so only the workspace comparison itself
 * can have clipped it.
 * @param {object} coverage The service's treeCoverage result.
 * @param {Array<object>} changes The listed changes, for the unconfirmed count.
 */
function changesNote(coverage, changes = []) {
  const unconfirmed = changes.filter(change => change.attribution === 'unconfirmed').length;
  const clipped = coverage?.workspace?.truncated === true ? ' Only the first 200 changed paths are listed.' : '';
  return `${baseNote(coverage, unconfirmed)}${clipped}`;
}

/**
 * An inspect answer only lists what fits beside the conversations, so it says how
 * many paths it left out and where the rest are.
 * @param {object} coverage The service's treeCoverage result.
 * @param {Array<object>} files The file summaries this answer kept.
 * @param {number} count Every path the service knows for this task.
 * @param {number} [unconfirmed] The service's exact unconfirmed total.
 */
function inspectNote(coverage, files = [], count = 0, unconfirmed) {
  const flagged = unconfirmed ?? files.filter(file => file.attribution === 'unconfirmed').length;
  const shown = count > files.length ? ` Showing ${files.length} of ${count} paths; changes lists them.` : '';
  return `${baseNote(coverage, flagged)}${shown}`;
}

/** A changes answer keeps one line per path; only coverage and the tree are reduced. */
export function compactChanges(result = {}) {
  const changes = Array.isArray(result.changes) ? result.changes : [];
  return {
    name: result.name,
    ...(result.message ? { message: truncate(result.message, 240) } : {}),
    task: result.task,
    changes: changes.map(compactChange),
    stale: result.stale === true,
    note: changesNote(result.coverage, changes),
    ...errorFields(result),
  };
}

const compactMessage = message => typeof message?.text === 'string' && message.text.length > MESSAGE_LIMIT
  ? { ...message, text: message.text.slice(0, MESSAGE_LIMIT) + '…', truncated: true }
  : message;

const compactTask = task => task ? { text: truncate(task.text, TASK_LIMIT), state: task.state, startedAt: task.startedAt,
  ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
  // The outcome state is the one part of result that reports.items does not repeat.
  ...(task.result ? { result: { state: task.result.state } } : {}) } : null;

// Per-node changes repeat the top-level file list, so a node keeps only its own
// conversation.
const compactNode = node => {
  const { coverage, changes, ...rest } = node ?? {};
  return { ...rest, ...(Array.isArray(rest.messages) ? { messages: rest.messages.map(compactMessage) } : {}) };
};

const INPUT_REASON_LIMIT = 200;

/**
 * One input row from inspect. These are the same fields the send or run receipt
 * carried, so a caller can look up the requestId it kept and read that input's own
 * outcome instead of inferring one from the name's state. `accepted` alone never
 * says which turn received the text; only delivery and its turn IDs do.
 * @param {object} input One service input record.
 */
const compactInput = input => ({
  requestId: input.requestId,
  ...actualEffortField(input),
  mode: input.mode ?? null,
  delivery: input.delivery ?? null,
  accepted: input.accepted === true,
  queued: input.queued === true,
  ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
  ...(input.afterTurnId === undefined ? {} : { afterTurnId: input.afterTurnId }),
  ...(input.reason === undefined ? {} : { reason: truncate(String(input.reason), INPUT_REASON_LIMIT) }),
  ...(input.status === undefined ? {} : { status: input.status }),
  ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
});

/** One node's messages, the rest as a name so the tree stays recognisable. */
const narrowedNodes = (nodes, chosen) => nodes.map(node => node === chosen ? node : { name: node.name, status: node.status });

// A raw name repeated by several nodes cannot address one of them; the paths can.
const ambiguousNode = (wanted, paths) => Object.assign(
  new Error(`“${wanted}” matches ${paths.length} nodes: ${paths.join(', ')}. Pass one of those paths.`),
  { code: 'node-ambiguous' });

/**
 * Pick one tree node by its team path or by its name. A path wins because it is
 * unique; a name that fits several nodes is refused with the paths that would work,
 * and a path shortened with "…" is matched by its remaining prefix.
 * @param {Array<object>} nodes tree.nodes entries.
 * @param {string} wanted Node name or team path from a roster row.
 */
function selectNode(nodes, wanted) {
  const members = nodes.filter(node => (node.depth ?? 0) > 0);
  const paths = teamPaths(members);
  const at = members.map((node, index) => ({ node, path: paths[index] }));
  const byPath = at.filter(entry => entry.path === wanted);
  if (byPath.length === 1) return byPath[0].node;
  if (wanted.endsWith('…')) {
    const prefix = wanted.slice(0, -1);
    const near = at.filter(entry => entry.path.startsWith(prefix));
    if (near.length === 1) return near[0].node;
    if (near.length > 1) throw ambiguousNode(wanted, near.map(entry => entry.path));
  }
  const byName = nodes.filter(node => node.name === wanted);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw ambiguousNode(wanted, at.filter(entry => entry.node.name === wanted).map(entry => entry.path));
  throw Object.assign(new Error(`No tree node named “${wanted}”. Available nodes: ${paths.join(', ') || 'none'}.`),
    { code: 'node-not-found' });
}

/**
 * An inspect answer: the top-level messages are the root node's messages again, so
 * they are kept only inside tree.nodes. Long message text is clipped per message
 * instead of losing whole messages.
 * @param {object} result The service's inspect result.
 * @param {{node?: string}} [options] One node to read; the rest stay as names.
 */
export function compactInspect(result = {}, { node } = {}) {
  const tree = result.tree ?? {};
  const allNodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  const members = allNodes.filter(entry => (entry.depth ?? 0) > 0);
  const paths = teamPaths(members);
  const chosen = node === undefined ? undefined : selectNode(allNodes, node);
  const chosenPath = chosen ? paths[members.indexOf(chosen)] ?? memberPath(chosen) : undefined;
  const nodes = chosen ? narrowedNodes(allNodes, chosen) : allNodes;
  const changes = result.changes ?? {};
  const reports = result.reports ?? {};
  const questions = questionMessages(result);
  // The page note belongs to whoever's conversation this answer carries.
  const noteOwner = chosen ?? nodes.find(entry => entry.depth === 0);
  const hasMore = chosen ? chosen.hasMore === true : result.hasMore === true;
  const files = changes.files ?? [];
  return {
    name: result.name,
    ...roleField(result),
    ...targetOfView(result.target),
    ...actualEffortField(result),
    ...(result.inputDelivery ? { inputDelivery: result.inputDelivery } : {}),
    lifetime: result.lifetime,
    state: result.state,
    ...(result.state === REPORTED_ACTIVITY_STATE && result.activity ? { activity: result.activity } : {}),
    ...(chosenPath ? { node: chosenPath } : {}),
    task: compactTask(result.task),
    ...usageField(result),
    ...(questions.length ? { questions } : {}),
    changes: { count: changes.count ?? 0, files: files.map(compactChange),
      note: inspectNote(changes.coverage, files, changes.count ?? 0, changes.unconfirmed) },
    tree: { settled: tree.settled === true, running: tree.running === true,
      ...(tree.observationError ? { observationError: tree.observationError } : {}), nodes: nodes.map(compactNode) },
    // latest.summary would repeat the item body that reports.items already carries.
    reports: { total: reports.total ?? 0, pending: reports.pending ?? 0, items: reports.items ?? [] },
    // Every input of this task, including accepted ones: a request id is only
    // useful if the row that owns it can still be found after the turn moved on.
    ...(Array.isArray(result.inputs) && result.inputs.length ? { inputs: result.inputs.map(compactInput) } : {}),
    ...(hasMore ? { hasMore: true } : {}),
    ...(noteOwner?.note ? { note: noteOwner.note } : {}),
    ...(result.inspectionIncomplete === true ? { inspectionIncomplete: true } : {}),
    ...(result.historyCount === undefined ? {} : { historyCount: result.historyCount }),
    history: result.history ?? [],
    ...errorFields(result),
  };
}

/**
 * The detail path of inspect: the service structure unchanged, but a requested node
 * still decides whose conversation — and whose pagination and note — is returned.
 * @param {object} result The service's inspect result.
 * @param {{node?: string}} [options] One node to read; the rest stay as names.
 */
export function inspectDetail(result = {}, { node } = {}) {
  if (node === undefined) return result;
  const tree = result.tree ?? {};
  const allNodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  const chosen = selectNode(allNodes, node);
  const detailView = { ...result,
    messages: chosen.messages ?? [],
    hasMore: chosen.hasMore === true,
    tree: { ...tree, nodes: narrowedNodes(allNodes, chosen) } };
  // The root page's note would describe a page this answer no longer carries.
  if (chosen.note) detailView.note = chosen.note;
  else delete detailView.note;
  return detailView;
}

// The registrar's detail path still has to honour the node filter this view owns.
compactInspect.detail = inspectDetail;

const withoutMethods = entry => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).filter(([field]) => field !== 'methods')) : entry;

/** Status keeps every readiness field; the advertised method lists are internal detail. */
export function compactStatus(result = {}) {
  const backends = result.backends;
  if (!backends || typeof backends !== 'object') return result;
  return { ...result, backends: Object.fromEntries(Object.entries(backends).map(([key, entry]) => [key, withoutMethods(entry)])) };
}

const teamSize = team => team.reduce((total, row) => total + (row.more ?? 1), 0);

const reducedItem = item => {
  if (!item.team) return item;
  const { team, ...rest } = item;
  return { ...rest, teamSize: teamSize(team) };
};

const REDUCED_NOTE = 'Team rosters were replaced by their size so this answer fits; inspect one name for its members.';

const hasAgentHierarchy = item => Boolean(
  item?.parentAgentId || item?.parent || item?.parentName
  || (Array.isArray(item?.agentPath) && item.agentPath.length > 1)
  || (typeof item?.path === 'string' && item.path.includes('/'))
  || (Array.isArray(item?.children) && item.children.length > 0)
  || (Array.isArray(item?.team) && item.team.length > 0)
  || (item?.tree?.nodes ?? []).some(node => (node.depth ?? 0) > 0),
);

function matchesRoleFilter(item, wantedRole) {
  if (!wantedRole) return true;
  const target = wantedRole.trim().toLowerCase();
  if (!target) return true;
  const checkOne = entry => {
    const entryRole = typeof entry?.role === 'string' ? entry.role.trim().toLowerCase() : '';
    const entryName = typeof entry?.name === 'string' ? entry.name.trim().toLowerCase() : '';
    const entryPath = typeof entry?.path === 'string' ? entry.path.trim().toLowerCase() : '';
    return (entryRole && (entryRole === target || entryRole.includes(target)))
      || (entryName && entryName.startsWith(target))
      || (entryPath && entryPath.split('/').some(seg => seg.startsWith(target)));
  };
  if (checkOne(item)) return true;
  if ((item?.tree?.nodes ?? []).some(node => (node.depth ?? 0) > 0 && checkOne(node))) return true;
  if ((item?.team ?? []).some(checkOne)) return true;
  if ((item?.children ?? []).some(checkOne)) return true;
  return false;
}

const MEANINGLESS_ACTIVITIES = new Set([
  'running',
  'creating',
  'idle',
  'completed',
  'failed',
  'cancelled',
  'awaiting_input',
  'awaiting_report',
  'delivery_pending',
  'reconnecting',
  'cleaning',
  'waiting',
  'waiting for a task',
]);

function meaningfulActivity(raw, state) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (MEANINGLESS_ACTIVITIES.has(lower)) return undefined;
  if (typeof state === 'string' && state.trim() && lower === state.trim().toLowerCase()) return undefined;
  return trimmed;
}

function slimListAgent(item = {}) {
  const base = compactAgent(item);
  delete base.inputDelivery;
  const rawStep = item.lastStep ?? item.step ?? item.observation?.lastStep ?? item.activity;
  const realStep = item.state === REPORTED_ACTIVITY_STATE ? meaningfulActivity(rawStep, item.state) : undefined;
  if (realStep !== undefined) base.activity = realStep;
  else delete base.activity;
  if (item.stalled === true || item.observation?.stalled === true) {
    base.stalled = true;
  }
  if (Array.isArray(base.team)) {
    const rawMembers = (item.tree?.nodes ?? []).filter(node => (node.depth ?? 0) > 0);
    base.team = base.team.map((row, index) => {
      if (!row || row.more !== undefined) return row;
      const cleaned = { ...row };
      const sourceNode = rawMembers[index] ?? (Array.isArray(item.team) ? item.team[index] : undefined);
      const rowStep = meaningfulActivity(
        sourceNode?.lastStep ?? sourceNode?.step ?? cleaned.activity,
        cleaned.state,
      );
      if (cleaned.state === REPORTED_ACTIVITY_STATE && rowStep !== undefined) {
        cleaned.activity = truncate(rowStep, ACTIVITY_LIMIT);
      } else {
        delete cleaned.activity;
      }
      if (sourceNode?.stalled === true || row.stalled === true) {
        cleaned.stalled = true;
      }
      return cleaned;
    });
  }
  return base;
}

function compactConcreteAgent(item = {}) {
  const base = slimListAgent(item);
  const fullQuestions = (item.questions ?? []).map(question => (
    typeof question === 'string'
      ? { message: question }
      : {
        ...(question.id ? { id: question.id } : {}),
        message: question.message,
        ...(question.state ? { state: question.state } : {}),
        ...(question.createdAt ? { createdAt: question.createdAt } : {}),
      }
  ));
  const latestSource = item.reports?.latest
    ?? (Array.isArray(item.reports?.items) && item.reports.items.length ? item.reports.items.at(-1) : undefined)
    ?? item.report;
  const latestSummary = latestSource?.message ?? latestSource?.summary;
  const deliveryValue = latestSource?.delivery && typeof latestSource.delivery === 'object'
    ? latestSource.delivery.state
    : latestSource?.delivery;
  const report = latestSource
    ? {
      ...(latestSummary !== undefined ? { summary: truncate(latestSummary, MESSAGE_LIMIT) } : {}),
      final: latestSource.final === true,
      ...(deliveryValue !== undefined ? { delivery: deliveryValue } : {}),
      ...(latestSource.error ? { error: latestSource.error } : {}),
      ...((item.reports?.pending ?? 0) > 0 ? { pending: item.reports.pending } : {}),
    }
    : undefined;
  const rawChanges = Array.isArray(item.changes) ? item.changes : (item.changes?.files ?? []);
  const changes = {
    count: item.changes?.count ?? rawChanges.length,
    ...(item.changes?.unconfirmed ? { unconfirmed: item.changes.unconfirmed } : {}),
    files: rawChanges.map(entry => (typeof entry === 'string' ? { path: entry } : compactChange(entry))),
  };
  const pathStr = item.path
    ?? (Array.isArray(item.agentPath) && item.agentPath.length ? item.agentPath.join('/') : item.name);
  const parent = item.parentName ?? item.parent ?? item.parentAgentName ?? item.parentAgentId ?? null;
  const children = Array.isArray(item.children)
    ? item.children.map(child => ({
      name: child.name,
      ...roleField(child),
      state: child.state ?? child.status,
      ...(child.path ? { path: child.path } : {}),
      ...(child.stalled === true ? { stalled: true } : {}),
    }))
    : (base.team ?? []);
  const taskText = item.task?.text ?? item.task?.message ?? (typeof item.task === 'string' ? item.task : undefined);
  return {
    ...base,
    ...(taskText ? { task: truncate(taskText, MESSAGE_LIMIT) } : {}),
    path: pathStr,
    parent,
    hierarchy: {
      path: pathStr,
      parent,
      depth: item.depth ?? (Array.isArray(item.agentPath) && item.agentPath.length > 0 ? item.agentPath.length - 1 : (parent ? 1 : 0)),
      children,
    },
    questions: fullQuestions,
    ...(report ? { report } : {}),
    changes,
  };
}

function compactTeamGroup(group = {}, roleFilter) {
  const rawItems = group.items ?? group.agents ?? group.members ?? [];
  const filteredRaw = roleFilter ? rawItems.filter(entry => matchesRoleFilter(entry, roleFilter)) : rawItems;
  const items = filteredRaw.map(slimListAgent);
  const hasHierarchy = typeof group.hasHierarchy === 'boolean'
    ? group.hasHierarchy
    : rawItems.some(hasAgentHierarchy);
  const ownerId = group.ownerId ?? group.owner?.ownerId ?? (typeof group.owner === 'string' ? group.owner : 'unknown');
  const source = group.source ?? group.owner?.source ?? 'unknown';
  const workspace = group.workspace ?? group.owner?.workspace ?? null;
  const conversationId = group.conversationId ?? group.owner?.conversationId;
  return {
    ownerId,
    source,
    workspace,
    ...(conversationId ? { conversationId } : {}),
    hasHierarchy,
    total: roleFilter ? items.length : (group.total ?? items.length),
    items,
  };
}

function groupFlatItemsByCaller(items = []) {
  const map = new Map();
  for (const item of items) {
    const ownerId = item.ownerId ?? item.owner?.ownerId ?? (typeof item.owner === 'string' ? item.owner : 'default');
    const source = item.source ?? item.owner?.source ?? 'unknown';
    const workspace = item.workspace ?? item.owner?.workspace ?? null;
    const key = `${source}::${workspace ?? ''}::${ownerId}`;
    if (!map.has(key)) {
      map.set(key, {
        ownerId,
        source,
        workspace,
        ...(item.conversationId ? { conversationId: item.conversationId } : {}),
        items: [],
      });
    }
    map.get(key).items.push(item);
  }
  return [...map.values()];
}

export function compactList(result = {}, args = {}) {
  const scope = result.scope ?? args?.scope;
  const roleFilter = args?.role ?? result.role;

  if (scope === 'all' || Array.isArray(result.teams) || Array.isArray(result.groups)) {
    const rawGroups = Array.isArray(result.teams)
      ? result.teams
      : Array.isArray(result.groups)
        ? result.groups
        : groupFlatItemsByCaller(result.items ?? []);
    const teams = rawGroups
      .map(group => compactTeamGroup(group, roleFilter))
      .filter(group => !roleFilter || group.items.length > 0);
    return {
      scope: 'all',
      ...(roleFilter ? { role: roleFilter } : {}),
      teams,
      totalTeams: teams.length,
      total: roleFilter ? teams.reduce((sum, team) => sum + team.total, 0) : (result.total ?? teams.reduce((sum, team) => sum + team.total, 0)),
      ...errorFields(result),
    };
  }

  if (scope === 'agent') {
    const rawTarget = result.agent ?? result.item ?? (Array.isArray(result.items) ? result.items[0] : undefined);
    if (!rawTarget) {
      return {
        scope: 'agent',
        ...(roleFilter ? { role: roleFilter } : {}),
        agent: null,
        items: [],
        total: 0,
        ...errorFields(result),
      };
    }
    const agent = compactConcreteAgent(rawTarget);
    return {
      scope: 'agent',
      ...(roleFilter ? { role: roleFilter } : {}),
      agent,
      items: [agent],
      total: 1,
      ...errorFields(result),
    };
  }

  const rawItems = result.items ?? [];
  const filtered = roleFilter ? rawItems.filter(entry => matchesRoleFilter(entry, roleFilter)) : rawItems;
  const items = filtered.map(slimListAgent);
  if (scope === 'team') {
    return {
      scope: 'team',
      ...(roleFilter ? { role: roleFilter } : {}),
      hasHierarchy: typeof result.hasHierarchy === 'boolean'
        ? result.hasHierarchy
        : rawItems.some(hasAgentHierarchy),
      items,
      total: roleFilter && filtered.length !== rawItems.length ? items.length : (result.total ?? items.length),
      ...errorFields(result),
    };
  }

  return {
    ...(roleFilter ? { role: roleFilter } : {}),
    items,
    total: roleFilter && filtered.length !== rawItems.length ? items.length : (result.total ?? items.length),
  };
}

// Used when the compact answer is still larger than one answer may be: a count per
// name keeps every name readable instead of the whole answer collapsing to a preview.
compactList.reduced = (result = {}, args = {}) => {
  const list = compactList(result, args);
  if (list.scope === 'all' && Array.isArray(list.teams)) {
    return {
      ...list,
      teams: list.teams.map(team => ({ ...team, items: (team.items ?? []).map(reducedItem) })),
      note: REDUCED_NOTE,
    };
  }
  return { ...list, items: (list.items ?? []).map(reducedItem), note: REDUCED_NOTE };
};

const TERMINAL_WAIT_STATES = new Set(['completed', 'idle', 'failed', 'cancelled', 'cleanup_failed']);

const isSettledWaitItem = item => Boolean(
  TERMINAL_WAIT_STATES.has(item?.state)
  || item?.report?.final === true
  || item?.reports?.latest?.final === true,
);

const compactWaitEvent = event => {
  if (!event || typeof event !== 'object') return event;
  const inlineMessage = event.message
    ?? (typeof event.body?.message === 'string' ? event.body.message : undefined)
    ?? (typeof event.body?.text === 'string' ? event.body.text : undefined);
  return {
    ...(event.name !== undefined ? { name: event.name } : {}),
    ...roleField(event),
    type: event.type,
    ...(inlineMessage !== undefined ? { message: inlineMessage } : {}),
    ...usageField(event),
    ...(event.error !== undefined ? { error: event.error } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
  };
};

/**
 * Snapshot wait (no streaming events) preserves items + notListed verbatim for
 * backward compatibility; event-driven wait strips internal event IDs, body pointers,
 * empty notListed, and redundant settled items.
 */
export function compactWait(result = {}) {
  if (!Array.isArray(result.events)) {
    return {
      items: (result.items ?? []).map(compactAgent),
      notListed: result.notListed ?? [],
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.note ? { note: result.note } : {}),
      timedOut: result.timedOut === true,
    };
  }
  const events = result.events.map(compactWaitEvent);
  const rawItems = Array.isArray(result.items) ? result.items : [];
  const notListed = Array.isArray(result.notListed) ? result.notListed : [];
  const allSettled = rawItems.length === 0 || rawItems.every(isSettledWaitItem);
  const hasActionableEvent = events.some(ev => ev && ['final', 'question', 'delivered', 'failed', 'cancelled', 'completed'].includes(ev.type));
  const omitRosterEcho = allSettled || hasActionableEvent;

  return {
    ...(!omitRosterEcho && rawItems.length ? { items: rawItems.map(slimListAgent) } : {}),
    ...(notListed.length ? { notListed } : {}),
    events,
    timedOut: result.timedOut === true,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.note ? { note: result.note } : {}),
  };
}

compactWait.reduced = (result = {}) => {
  const waited = compactWait(result);
  const note = [waited.note, REDUCED_NOTE].filter(Boolean).join(' ');
  return {
    ...waited,
    ...(Array.isArray(waited.items) ? { items: waited.items.map(reducedItem) } : {}),
    note,
  };
};
