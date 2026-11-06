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
  const files = Array.isArray(node.changes) ? node.changes.length : 0;
  return { path, state: node.status,
    ...(node.status === REPORTED_ACTIVITY_STATE && node.activity ? { activity: truncate(node.activity, ACTIVITY_LIMIT) } : {}),
    ...(files ? { files: files >= LISTED_FILES ? `${LISTED_FILES}+` : files } : {}) };
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
  if (fits(shortPath) || !row.activity) return shortPath;
  for (let length = row.activity.length - 1; length > 1; length -= 1) {
    const shorter = { ...shortPath, activity: row.activity.slice(0, length) + '…' };
    if (fits(shorter)) return shorter;
  }
  const bare = { ...shortPath };
  delete bare.activity;
  return bare;
};

/**
 * The team roster: every descendant as one line, so a controlling caller sees the
 * whole tree in one list instead of counting nodes and inspecting each one.
 */
const teamField = item => {
  const members = (item.tree?.nodes ?? []).filter(node => (node.depth ?? 0) > 0);
  if (!members.length) return {};
  const paths = teamPaths(members);
  const rows = members.slice(0, TEAM_ROWS).map((node, index) => fitMemberRow(memberRow(node, paths[index])));
  return { team: members.length > TEAM_ROWS ? [...rows, { more: members.length - TEAM_ROWS }] : rows };
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

/**
 * One list or wait entry. Report text appears exactly once here: the service echoes
 * the same reply in task.result, reports.latest and delivery, so only the latest
 * report survives, and the full reply stays reachable through inspect.
 * @param {object} item One publicResult entry, plus list-only supplements/monitor.
 */
export function compactAgent(item = {}) {
  const questions = questionMessages(item);
  return {
    name: item.name,
    ...(item.actualModel === undefined ? {} : { actualModel: item.actualModel }),
    ...targetOfView(item.target),
    state: item.state,
    lifetime: item.lifetime,
    ...(item.state === REPORTED_ACTIVITY_STATE && item.activity ? { activity: item.activity } : {}),
    ...(item.task?.text ? { task: truncate(item.task.text, TASK_LIMIT) } : {}),
    ...(questions.length ? { questions } : {}),
    ...reportField(item),
    ...fileField(item),
    ...teamField(item),
    ...supplementField(item),
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
    ...(result.actualModel === undefined ? {} : { actualModel: result.actualModel }),
    ...targetOfView(result.target),
    lifetime: result.lifetime,
    state: result.state,
    ...(typeof result.created === 'boolean' ? { created: result.created } : {}),
    ...(result.modelRequestsStarted === undefined ? {} : { modelRequestsStarted: result.modelRequestsStarted }),
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
    ...targetOfView(result.target),
    lifetime: result.lifetime,
    state: result.state,
    ...(result.state === REPORTED_ACTIVITY_STATE && result.activity ? { activity: result.activity } : {}),
    ...(chosenPath ? { node: chosenPath } : {}),
    task: compactTask(result.task),
    ...(questions.length ? { questions } : {}),
    changes: { count: changes.count ?? 0, files: files.map(compactChange),
      note: inspectNote(changes.coverage, files, changes.count ?? 0, changes.unconfirmed) },
    tree: { settled: tree.settled === true, running: tree.running === true,
      ...(tree.observationError ? { observationError: tree.observationError } : {}), nodes: nodes.map(compactNode) },
    // latest.summary would repeat the item body that reports.items already carries.
    reports: { total: reports.total ?? 0, pending: reports.pending ?? 0, items: reports.items ?? [] },
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

export function compactList(result = {}) {
  const items = result.items ?? [];
  return { items: items.map(compactAgent), total: result.total ?? items.length };
}

// Used when the compact answer is still larger than one answer may be: a count per
// name keeps every name readable instead of the whole answer collapsing to a preview.
compactList.reduced = (result = {}) => {
  const list = compactList(result);
  return { ...list, items: list.items.map(reducedItem), note: REDUCED_NOTE };
};

/** Wait keeps its own receipt fields: notListed and timedOut are why the caller asked. */
export function compactWait(result = {}) {
  return { items: (result.items ?? []).map(compactAgent), notListed: result.notListed ?? [],
    ...(result.note ? { note: result.note } : {}), timedOut: result.timedOut === true };
}

compactWait.reduced = (result = {}) => {
  const waited = compactWait(result);
  const note = [waited.note, REDUCED_NOTE].filter(Boolean).join(' ');
  return { ...waited, items: waited.items.map(reducedItem), note };
};
