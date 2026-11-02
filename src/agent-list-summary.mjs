const MAX_TASK_TEXT = 240;
const MAX_ACTIVITY = 240;
const MAX_QUESTION_TEXT = 200;
const MAX_QUESTIONS = 6;
const MAX_FILES = 8;
const MAX_TREE_NODES = 12;
const MAX_NAME = 120;

const compact = (value, maximum) => {
  if (value === undefined || value === null) return value;
  const text = String(value);
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
};

const filePath = value => typeof value === 'string' ? value : value?.path;

function summarizeError(error) {
  if (!error) return undefined;
  const source = typeof error === 'string' ? { message: error } : error;
  const result = {};
  if (source?.code !== undefined) result.code = compact(source.code, 120);
  if (source?.message !== undefined) result.message = compact(source.message, 240);
  return Object.keys(result).length ? result : undefined;
}

function summarizeCoverage(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return { complete: false, unsupported: compact(value, 200) };
  if (typeof value !== 'object') return undefined;
  const result = {};
  if (typeof value.complete === 'boolean') result.complete = value.complete;
  else result.complete = false;
  const unsupported = value.unsupported ?? value.limitation;
  if (unsupported !== undefined && unsupported !== null && unsupported !== '') result.unsupported = compact(unsupported, 200);
  return result;
}

function summarizeQueue(value) {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  for (const key of ['queued', 'pending', 'unknown', 'blocked', 'accepted']) {
    if (Number.isInteger(value[key])) result[key] = value[key];
  }
  if (value.latest && typeof value.latest === 'object') {
    result.latest = {
      ...(value.latest.status !== undefined ? { status: compact(value.latest.status, 80) } : {}),
      ...(value.latest.reason !== undefined ? { reason: compact(value.latest.reason, 200) } : {}),
    };
  }
  return Object.keys(result).length ? result : undefined;
}

function summarizeReports(value) {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  if (Number.isInteger(value.total)) result.total = value.total;
  if (Number.isInteger(value.pending)) result.pending = value.pending;
  if (value.latest && typeof value.latest === 'object') {
    result.latestFinal = value.latest.final === true;
    if (value.latest.delivery !== undefined) result.delivery = compact(value.latest.delivery, 80);
  }
  return Object.keys(result).length ? result : undefined;
}

function summarizeChanges(item) {
  const source = Array.isArray(item?.changes?.files) ? item.changes.files
    : Array.isArray(item?.task?.result?.files) ? item.task.result.files
      : Array.isArray(item?.task?.result?.changes) ? item.task.result.changes : [];
  const paths = [...new Set(source.map(filePath).filter(path => typeof path === 'string' && path))];
  const declared = Number.isInteger(item?.changes?.count) ? item.changes.count : paths.length;
  const count = Math.max(declared, paths.length);
  const native = item?.runtime === 'claude' || item?.runtime === 'codex';
  const observed = !native || paths.length > 0 || item?.changes?.observedAt !== undefined
    || item?.changes?.coverage?.complete === true;
  const coverage = summarizeCoverage(item?.changes?.coverage);
  return {
    ...(observed ? { count, files: paths.slice(0, MAX_FILES), truncated: count > MAX_FILES } : {}),
    ...(coverage ? { coverage } : {}),
  };
}

function summarizeQuestions(item) {
  const source = Array.isArray(item?.questions) ? item.questions : [];
  const questions = source
    .filter(question => question?.state !== 'resolved')
    .map(question => compact(question?.message ?? question, MAX_QUESTION_TEXT))
    .filter(Boolean);
  return { questions: questions.slice(0, MAX_QUESTIONS), truncated: questions.length > MAX_QUESTIONS };
}

function summarizeTree(item) {
  const source = Array.isArray(item?.tree?.nodes) ? item.tree.nodes : [];
  const nodes = source.slice(0, MAX_TREE_NODES).map(node => ({
    name: compact(node?.name ?? node?.agentPath?.at(-1) ?? 'subagent', MAX_NAME),
    parent: compact(node?.parentName ?? node?.parent ?? null, MAX_NAME),
    status: compact(node?.status ?? 'unknown', MAX_NAME),
  }));
  return {
    settled: item?.tree?.settled === true,
    running: item?.tree?.running === true,
    totalNodes: source.length,
    nodes,
    truncated: source.length > nodes.length,
  };
}

/** Compact one futureaide_list_agents item for the named-list view. */
export function summarizeAgentListItem(item = {}) {
  const task = item.task && typeof item.task === 'object' ? {
    text: compact(item.task.text ?? item.task.message, MAX_TASK_TEXT),
    state: item.task.state ?? null,
    startedAt: item.task.startedAt ?? null,
    ...(item.task.finishedAt ? { finishedAt: item.task.finishedAt } : {}),
  } : null;
  const { questions, truncated: questionsTruncated } = summarizeQuestions(item);
  const error = summarizeError(item.error);
  const monitor = item.monitor !== undefined ? compact(item.monitor, 80) : undefined;
  const queue = summarizeQueue(item.queue ?? item.supplements);
  const reports = summarizeReports(item.reports);
  const delivery = item.delivery !== undefined ? compact(item.delivery, 80) : undefined;
  const changes = summarizeChanges(item);
  return {
    name: item.name,
    runtime: item.runtime ?? null,
    lifetime: item.lifetime ?? null,
    state: item.state ?? null,
    task,
    activity: compact(item.activity, MAX_ACTIVITY),
    ...(error ? { error } : {}),
    ...(monitor !== undefined ? { monitor } : {}),
    ...(queue ? { queue } : {}),
    ...(reports ? { reports } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
    questions,
    questionsTruncated,
    ...(Object.keys(changes).length ? { changes } : {}),
    tree: summarizeTree(item),
  };
}

/**
 * Preserve every named item while removing repeated result/coverage payloads.
 * Call this before boundedOutput in the list tool; deeper history stays in
 * inspect_agent / agent_changes.
 */
export function summarizeAgentList(result = {}) {
  const items = Array.isArray(result?.items) ? result.items : [];
  return {
    items: items.map(summarizeAgentListItem),
    total: Number.isInteger(result?.total) ? result.total : items.length,
  };
}
