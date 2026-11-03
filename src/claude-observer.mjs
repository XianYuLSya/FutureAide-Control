// Incremental projection of one positively bound Claude transcript. Native JSONL
// is the evidence; this small cache lives beside the shared roster, not in a
// second task/notification state machine. Ordinary text never becomes a report.
import path from 'node:path';
import { readClaudeEvents } from './claude-inbox.mjs';

export const CLAUDE_REPORT_TOOLS = Object.freeze({
  'mcp__futureaide-report__ask_parent': 'question',
  'mcp__futureaide-report__report_parent': 'report',
  'mcp__futureaide_report__ask_parent': 'question',
  'mcp__futureaide_report__report_parent': 'report',
});
export const CLAUDE_FILE_COVERAGE = Object.freeze({ source: 'native-successful-file-tool-results',
  complete: false, limitation: 'Only successful Write/Edit/NotebookEdit tools are attributed; shell and external writes are not inferred.' });
const FILE_TOOLS = new Map([['Write', 'create'], ['Edit', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit']]);

export function emptyClaudeProjection(taskId, { throughSeq = 0, currentModel } = {}) {
  return { taskId, throughSeq, currentModel, messages: [], messagesOmitted: 0, pendingTools: {},
    completedTools: [], successfulTools: [], agentTools: {}, changes: [], reports: [], questions: [], deliveries: {}, children: {},
    completions: [], badLines: 0, activity: 'idle' };
}

function appendMessage(projection, event) {
  if (!event.text && !event.tools.length) return;
  const entry = { seq: event.seq, time: event.timestamp, role: event.type, text: event.text,
    ...(event.textTruncated ? { textTruncated: true } : {}),
    ...(event.tools.length ? { tools: event.tools.map(({ id, name }) => ({ id, name })) } : {}) };
  projection.messages.push(entry);
  let size = projection.messages.reduce((total, value) => total + JSON.stringify(value).length, 0);
  while (projection.messages.length > 100 || size > 28000) {
    size -= JSON.stringify(projection.messages.shift()).length;
    projection.messagesOmitted++;
  }
}

function completeTool(projection, result, event, { workspace, agentId, reportTools }) {
  const use = projection.pendingTools[result.id];
  if (!use || projection.completedTools.includes(result.id)) return;
  delete projection.pendingTools[result.id];
  projection.completedTools.push(result.id);
  projection.completedTools = projection.completedTools.slice(-512);
  projection.activity = `finished tool: ${use.name}`;
  if (result.isError) return;
  (projection.successfulTools ??= []).push(result.id);
  projection.successfulTools = projection.successfulTools.slice(-512);
  const kind = reportTools[use.name];
  const receipt = result.receipt;
  if (kind && receipt?.accepted === true && receipt.taskId === projection.taskId
      && (!receipt.agentId || receipt.agentId === agentId)
      && typeof use.input?.message === 'string' && use.input.message.trim()) {
    // Use the native tool id as identity. The successful result supplies the
    // task id, so a delayed old-task result cannot report on a new task.
    const id = `${agentId}:${use.id}`;
    if (kind === 'question' && !projection.questions.some(item => item.id === id)) {
      projection.questions.push({ id, taskId: receipt.taskId, state: 'pending',
        message: use.input.message, createdAt: event.timestamp, seq: event.seq });
    } else if (kind === 'report' && !projection.reports.some(item => item.id === id)) {
      projection.reports.push({ id, taskId: receipt.taskId, message: use.input.message,
        final: use.input.final === true, createdAt: event.timestamp, seq: event.seq });
    }
  }
  if (FILE_TOOLS.has(use.name)) {
    const value = use.input?.file_path ?? use.input?.notebook_path ?? use.input?.path;
    if (typeof value === 'string' && value) {
      const file = path.resolve(workspace, value);
      const change = { path: file, operation: FILE_TOOLS.get(use.name), seq: event.seq };
      const previous = projection.changes.findIndex(item => item.path.toLowerCase() === file.toLowerCase());
      if (previous === -1) projection.changes.push(change);
      else projection.changes[previous] = change;
    }
  }
  // Native Agent results identify their child; no other directory or session is
  // pulled into this tree by proximity, cwd, or a matching title.
  if (['Agent', 'Task'].includes(use.name) && typeof result.metadata?.agentId === 'string') {
    const childId = result.metadata.agentId;
    projection.children[childId] = { ...(projection.children[childId] ?? {}),
      agentId: childId, parentToolUseId: use.id, name: use.input?.description ?? use.input?.name ?? childId,
      status: result.metadata.status, background: result.metadata.isAsync === true || use.input?.run_in_background === true,
      resultSeq: event.seq };
  }
}

/** Pure projection update; tests and the runtime use the exact same path. */
export function projectClaudePage(projection, page, { workspace, agentId, requestIds = [],
  reportTools = CLAUDE_REPORT_TOOLS } = {}) {
  const known = new Set(requestIds);
  for (const delivery of page.deliveries ?? []) if (known.has(delivery.requestId)) {
    const previous = projection.deliveries[delivery.requestId];
    if (!previous || previous.stage !== 'inserted') projection.deliveries[delivery.requestId] = delivery;
  }
  for (const event of page.events ?? []) {
    if (event.seq <= projection.throughSeq) continue;
    appendMessage(projection, event);
    if (event.type === 'assistant') {
      if (event.model && event.model !== '<synthetic>') projection.currentModel = {
        provider: 'anthropic', model: event.model,
        ...(event.effort ? { reasoningEffort: event.effort } : {}) };
      projection.activity = event.tools.length ? `tool: ${event.tools.at(-1).name}` : 'responding';
      for (const tool of event.tools) if (!projection.completedTools.includes(tool.id)) {
        projection.pendingTools[tool.id] = { ...tool, seq: event.seq };
        if (['Agent', 'Task'].includes(tool.name)) (projection.agentTools ??= {})[tool.id] = { ...tool, seq: event.seq };
      }
      if (event.stopReason === 'end_turn' || event.stopReason === 'stop_sequence' || event.apiError) {
        projection.completions.push({ seq: event.seq, timestamp: event.timestamp,
          reason: event.apiError ? { kind: 'error', error: { code: 'claude-api-error',
            message: 'Claude Desktop recorded a failed API turn. Inspect the bound session for details.' } }
            : { kind: 'completed' } });
        projection.activity = 'turn-ended';
      }
    }
    for (const result of event.results ?? []) completeTool(projection, result, event, { workspace, agentId, reportTools });
    if (event.type === 'user' && ['[Request interrupted by user]', '[Request interrupted by user for tool use]'].includes(event.text)
        && !event.results?.length) {
      projection.completions.push({ seq: event.seq, timestamp: event.timestamp, reason: { kind: 'cancelled' } });
      projection.lastInterruptSeq = event.seq;
      projection.activity = 'interrupted';
    }
  }
  projection.completions = projection.completions.slice(-128);
  projection.badLines += page.badLines ?? 0;
  projection.throughSeq = page.offset;
  return projection;
}

/** Bounded pages, persisted byte cursor, no full-file reread on the hot path. */
export async function observeClaudeTranscript(binding, projection, options = {}) {
  const read = options.readEvents ?? readClaudeEvents;
  let page, pages = 0;
  do {
    const before = projection.throughSeq;
    try { page = await read(binding, { offset: before, sidechain: options.sidechain === true }); }
    catch (error) {
      if (error.message !== 'claude-transcript-line-exceeds-page') throw error;
      // File tools can place a large payload on a single line. Grow only for
      // that line; a normal poll still allocates at most the default page.
      page = await read(binding, { offset: before, maxBytes: 16 * 1024 * 1024, sidechain: options.sidechain === true });
    }
    projectClaudePage(projection, page, options);
    if (page.offset === before) break; // a partially appended final line
  } while (page.hasMore && ++pages < 16);
  return { projection, hasMore: page?.hasMore ?? false };
}

export function claudeTurn(projection, requestId, { running = false, afterSeq = 0 } = {}) {
  const delivery = projection.deliveries[requestId];
  if (!delivery || delivery.stage !== 'inserted') return { state: 'running', afterSeq };
  const completed = projection.completions.find(item => item.seq > Math.max(delivery.seq, afterSeq));
  if (running || !completed) return { state: 'running', correlation: 'request-id', afterSeq };
  return { state: 'ended', correlation: 'request-id', afterSeq, endSeq: completed.seq,
    completionReason: completed.reason };
}
