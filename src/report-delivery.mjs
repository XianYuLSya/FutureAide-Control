import { createHash } from 'node:crypto';

/**
 * Delivery facts shared by every report exit.
 *
 * A final report may wait for its task tree, but never indefinitely: the wait is
 * measured from the report's own persisted creation time, so a monitor restart
 * cannot start a new countdown. The two automatic exits (the ordinary native
 * notification and the wait tool) read the same persisted notice record.
 */
export const TREE_RELEASE_MS = 120 * 1000;
export const REPORT_BODY_PAGE_CHARS = 8000;
export const REPORT_BODY_MAX_CHARS = 20000;
// A page is bounded by the actual JSON encoding, not by raw character count alone:
// a control character becomes six ASCII characters ("\u0000"), so 8000 raw chars
// can exceed an MCP text result. The wire budget covers the quoted JSON string.
export const REPORT_BODY_WIRE_BUDGET = 24000;
export const REPORT_BODY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const TERMINAL_NODE_STATES = new Set(['completed', 'failed', 'cancelled']);
const NODE_REASONS = {
  running: '仍在运行',
  cleaning: '正在清理',
  cleanup_failed: '清理失败，节点仍保留在子代理目录',
  closed: '节点已关闭但仍保留在子代理目录',
  unloaded: '节点未加载但仍保留在持久子代理目录',
  idle: '节点空闲但仍保留在子代理目录',
  queued: '排队中',
  unknown: '宿主未给出可读状态',
};

/** A final may be delivered after its tree settled or after the bounded release. */
export function finalReportReady(report) {
  return report?.treeSettledConfirmed === true || report?.treeReleased === true;
}

/**
 * The one release moment. Only a real persisted creation time counts; an old row
 * with no time has no deadline and keeps the existing delivery rules.
 */
export function finalReportDeadline(report, task) {
  const raw = report?.createdAt ?? report?.delivery?.createdAt ?? task?.startedAt;
  const created = Date.parse(raw ?? '');
  return Number.isFinite(created) ? created + TREE_RELEASE_MS : undefined;
}

export function treeReleaseDue(report, task, at = Date.now()) {
  const deadline = finalReportDeadline(report, task);
  return deadline !== undefined && at >= deadline;
}

const nodeText = node => {
  const status = typeof node?.status === 'string' && node.status ? node.status : 'unknown';
  if (node?.error?.message) return String(node.error.message);
  if (typeof node?.error === 'string' && node.error) return node.error;
  return NODE_REASONS[status] ?? `宿主报告状态 ${status}`;
};

/**
 * Describe exactly what kept the tree from settling. Nodes come from the same
 * trusted owned-tree walk the settled proof uses; a node that could not be read
 * keeps its last known row and is marked unreadable instead of being omitted.
 */
export function treeReleaseRecord({ nodes = [], settled = false, running = false, complete = false,
  readable = true, reason, at = Date.now(), deadlineAt } = {}) {
  const releasedAt = typeof at === 'number' ? at : Date.parse(at);
  const deadline = typeof deadlineAt === 'number' ? deadlineAt : Date.parse(deadlineAt);
  const rows = [];
  for (const node of nodes) {
    const value = node?.node ?? node;
    const depth = Number.isInteger(node?.depth) ? node.depth : 0;
    const path = Array.isArray(node?.agentPath) && node.agentPath.length
      ? node.agentPath.slice(1).join('/') || node.agentPath.at(-1)
      : (value?.name ?? (depth ? 'subagent' : 'root'));
    const status = typeof value?.status === 'string' && value.status ? value.status : 'unknown';
    // The root is only a residual when it is still running; an idle root with
    // retained descendants is represented by those descendants, not repeated.
    if (depth === 0 && status !== 'running') continue;
    if (depth > 0 && TERMINAL_NODE_STATES.has(status)) continue;
    rows.push({ path, status, reason: nodeText(value), readable: readable !== false });
  }
  // A release can happen while the tree is unreadable, or while every visible node
  // is terminal but the host never declared the tree settled. Neither is an empty
  // result: say which condition stopped the early release.
  if (!rows.length && !settled) {
    rows.push({ path: '（根代理）', status: running ? 'running' : 'unsettled',
      reason: readable === false ? '树状态读不到' : running ? NODE_REASONS.running : '宿主未报告树已收尾',
      readable: readable !== false });
  }
  const why = readable === false ? (reason?.message ?? String(reason ?? '树状态读不到'))
    : running ? 'tree-running'
      : !settled ? 'tree-not-settled'
        : !complete ? 'tree-incomplete' : undefined;
  return {
    state: readable === false ? 'unreadable' : 'released',
    at: new Date(releasedAt).toISOString(),
    ...(Number.isFinite(deadline) ? { deadlineAt: new Date(deadline).toISOString(), overdueMs: Math.max(0, releasedAt - deadline) } : {}),
    settled: settled === true,
    running: running === true,
    complete: complete === true,
    readable: readable !== false,
    ...(why ? { reason: typeof why === 'object' ? { code: why.code ?? 'tree-unreadable', message: why.message ?? String(why) } : { code: why, message: why } } : {}),
    nodes: rows,
  };
}

/** The human-readable section appended to the ordinary notification. */
export function treeReleaseText(release) {
  if (!release) return '';
  const head = release.readable === false
    ? `树放行：已满 120 秒仍未收尾，树状态读不到；以下为最后已知状态。`
    : `树放行：已满 120 秒，树仍未收尾。`;
  const lines = [head];
  if (release.reason?.message) lines.push(`原因：${release.reason.message}`);
  if (release.nodes?.length) lines.push('未完成节点：');
  for (const node of release.nodes ?? []) {
    lines.push(`- 相对路径：${node.path}；状态：${node.status}；原因：${node.reason}；可读：${node.readable ? '是' : '否'}`);
  }
  if (!release.nodes?.length) lines.push('未完成节点：无（宿主仍未报告树已收尾）。');
  return lines.join('\n');
}

/** The status a wait event carries instead of the report body. */
export function waitDeliveryStatus(report, notice, taskKey) {
  const delivery = notice ?? report?.delivery;
  const message = typeof report?.message === 'string' ? report.message : undefined;
  const submissionId = typeof report?.id === 'string'
    ? (report.id.startsWith('submission:') ? report.id.slice('submission:'.length) : report.id) : undefined;
  return {
    state: delivery?.state ?? 'pending',
    final: report?.final === true,
    ...(delivery?.deliveredAt ? { deliveredAt: delivery.deliveredAt } : {}),
    ...(delivery?.error ? { error: delivery.error } : {}),
    ...(delivery?.treeRelease ? { tree: delivery.treeRelease } : {}),
    ...(submissionId && taskKey && typeof message === 'string'
      ? { body: reportBodyReference({ taskKey, submissionId, body: message }) } : {}),
  };
}

export function reportBodyReference({ taskKey, submissionId, body, characters: exactCharacters }) {
  const characters = Number.isSafeInteger(exactCharacters) ? exactCharacters
    : typeof body === 'string' ? body.length : undefined;
  return {
    taskKey, submissionId, tool: 'futureaide_read_report',
    ...(characters === undefined ? {} : { characters,
      pages: typeof body === 'string' ? reportBodyPageCount(body) : Math.max(1, Math.ceil(characters / REPORT_BODY_PAGE_CHARS)) }),
  };
}

/** Exact page count under the same wire budget used by read_report. */
export function reportBodyPageCount(body) {
  if (typeof body !== 'string' || !body.length) return 1;
  let offset = 0, pages = 0;
  do {
    const page = reportBodyPage(body, { offset });
    pages += 1;
    offset = page.nextOffset;
  } while (offset !== null);
  return pages;
}

/**
 * One page of the exact original text. Offsets are UTF-16 code units, exactly the
 * unit JavaScript and JSON use, so newlines, surrogate pairs and every other
 * character survive a page boundary unchanged.
 */
export function reportBodyPage(body, { offset = 0, limit = REPORT_BODY_PAGE_CHARS } = {}) {
  if (typeof body !== 'string') return undefined;
  let start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  // A page never begins or ends between a surrogate pair. A client that is not a
  // JavaScript string consumer would otherwise receive an unpaired surrogate.
  if (start > 0 && start < body.length && isLowSurrogate(body.charCodeAt(start))) start -= 1;
  const requested = Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, REPORT_BODY_MAX_CHARS) : REPORT_BODY_PAGE_CHARS;
  let end = Math.min(body.length, start + requested);
  if (end < body.length && end > start && isHighSurrogate(body.charCodeAt(end - 1))) end -= 1;
  if (end === start && start < body.length) end = Math.min(body.length, start + 2);
  let text = body.slice(start, end);
  // Shrink to the wire budget with a binary search over code units, keeping the
  // same surrogate rule. The encoded length includes the surrounding JSON quotes.
  if (JSON.stringify(text).length > REPORT_BODY_WIRE_BUDGET) {
    let low = 1, high = text.length;
    const fits = length => {
      let cut = length;
      if (cut < text.length && cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
      if (cut === 0) cut = Math.min(text.length, 2);
      return JSON.stringify(text.slice(0, cut)).length <= REPORT_BODY_WIRE_BUDGET ? cut : 0;
    };
    let best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const cut = fits(mid);
      if (cut > 0) { best = cut; low = mid + 1; } else high = mid - 1;
    }
    if (best > 0) text = text.slice(0, best);
    else { text = text.slice(0, Math.min(text.length, 2)); }
  }
  const nextOffset = start + text.length < body.length ? start + text.length : null;
  return {
    text,
    offset: start,
    nextOffset,
    characters: body.length,
    pageCharacters: text.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

const isHighSurrogate = code => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = code => code >= 0xdc00 && code <= 0xdfff;
