// Read a Claude Desktop native transcript and decide whether a structured report
// really reached the plugin.
//
// G2 is only satisfied by a pair that clears every step:
//   1. the tool_use name is one exact registered MCP name (allowlist above; a bare
//      `report_parent` or any other suffix is reported, never counted);
//   2. its tool_result has is_error false;
//   3. the result body — including an MCP-nested `content` array — parses to a
//      receipt with accepted:true;
//   4. that receipt carries the task id under test.
// A refusal, a successful call whose body is not accepted:true, a receipt for
// another task, or a missing result never counts.
//
// Read-only. It starts, resumes, modifies and cleans nothing, and reads only the
// given transcript plus, optionally, the shared roster for the task id.
//
//   node scripts/claude-report-g2-evidence.mjs <transcript.jsonl> --task 7 [--out evidence.json]
//   node scripts/claude-report-g2-evidence.mjs <transcript.jsonl> --roster <roster.sqlite> [--out ...]
//   node scripts/claude-report-g2-evidence.mjs <transcript.jsonl> --allow mcp__other__report_parent
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Exact registered names. `mcp__<config key>__<tool>` is how Claude namespaces an
 * MCP tool, and the plugin's config key is `futureaide-report`; the underscore
 * variant is kept because the observer accepts both spellings. Confirm the real
 * name in the first live transcript and shrink or extend this list, never match by
 * suffix.
 */
export const REPORT_TOOL_ALLOWLIST = Object.freeze([
  'mcp__futureaide-report__ask_parent',
  'mcp__futureaide-report__report_parent',
  'mcp__futureaide_report__ask_parent',
  'mcp__futureaide_report__report_parent',
]);

/** Names that look like reports but are not registered MCP tools: diagnostics only. */
const LOOKALIKE = /(?:^|__)(ask_parent|report_parent)$/;

const textOf = content => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (part?.type === 'text' ? part.text : '')).filter(Boolean).join('\n');
};

function kindOf(name) {
  if (name.endsWith('__ask_parent') || name === 'ask_parent') return 'question';
  if (name.endsWith('__report_parent') || name === 'report_parent') return 'report';
  return undefined;
}

/**
 * Find an accepted receipt inside a tool result body. The body may be a JSON
 * string, a text part, a `content` array from the MCP result, or a nested
 * `structuredContent`/`result` object; anything that is itself an error or that
 * never says accepted:true yields undefined.
 */
export function parseAcceptedReceipt(content, depth = 0) {
  if (depth > 12) return undefined;
  if (typeof content === 'string') {
    const text = content.trim();
    if (!text) return undefined;
    for (const candidate of [text, text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')]) {
      try {
        const found = parseAcceptedReceipt(JSON.parse(candidate), depth + 1);
        if (found) return found;
      } catch { /* plain text is not a receipt */ }
    }
    return undefined;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      const found = parseAcceptedReceipt(part, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!content || typeof content !== 'object') return undefined;
  if (content.isError === true || content.is_error === true) return undefined;
  if (content.accepted === true) {
    return { accepted: true, taskId: content.taskId, agentId: content.agentId,
      kind: content.kind, final: content.final, receiptId: content.receiptId };
  }
  if (content.type === 'text' && typeof content.text === 'string') {
    const found = parseAcceptedReceipt(content.text, depth + 1);
    if (found) return found;
  }
  for (const key of ['content', 'result', 'structuredContent']) {
    if (content[key] !== undefined) {
      const found = parseAcceptedReceipt(content[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Pair recognized report tool calls with their results.
 * @param {string} body Raw JSONL text.
 * @param {object} [options] `taskId` under test and an allowlist override.
 * @returns {object} Pairs with a per-pair status and counts; `g2Satisfied` is true
 *   only for a delivered pair.
 */
export function pairReports(body, { taskId, allowlist = REPORT_TOOL_ALLOWLIST } = {}) {
  const allowed = new Set(allowlist);
  const expectedTask = taskId === undefined || taskId === null ? undefined : taskId;
  const uses = new Map();
  const results = new Map();
  const lookalikes = new Set();
  let sessionId = null;
  let lines = 0;
  let badLines = 0;
  let sidechainUses = 0;
  for (const line of String(body).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines += 1;
    let record;
    try { record = JSON.parse(line); } catch { badLines += 1; continue; }
    sessionId ??= typeof record?.sessionId === 'string' ? record.sessionId : null;
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'tool_use' && typeof part.name === 'string') {
        if (!allowed.has(part.name)) {
          if (LOOKALIKE.test(part.name)) lookalikes.add(part.name);
          continue;
        }
        if (record.isSidechain === true) { sidechainUses += 1; continue; }
        uses.set(part.id, { toolUseId: part.id, name: part.name, kind: kindOf(part.name),
          input: part.input ?? null, timestamp: record.timestamp ?? null });
      }
      if (part?.type === 'tool_result' && uses.has(part.tool_use_id)) {
        results.set(part.tool_use_id, { toolUseId: part.tool_use_id, isError: part.is_error === true,
          content: part.content, text: textOf(part.content).slice(0, 4000), timestamp: record.timestamp ?? null });
      }
    }
  }
  const pairs = [...uses.values()].map(use => {
    const { content: _content, ...resultView } = results.get(use.toolUseId) ?? {};
    const result = results.get(use.toolUseId) ?? null;
    const receipt = result && result.isError ? undefined : parseAcceptedReceipt(result?.content ?? result?.text);
    let status;
    if (!result) status = 'unanswered';
    else if (result.isError) status = 'refused';
    else if (!receipt) status = 'not-accepted';
    else if (expectedTask === undefined) status = 'unknown-task';
    else if (receipt.taskId !== expectedTask) status = 'task-mismatch';
    else status = 'delivered';
    return { ...use, result: result ? resultView : null, receipt, status, delivered: status === 'delivered' };
  });
  const count = status => pairs.filter(pair => pair.status === status).length;
  return {
    sessionId, lines, badLines, sidechainUses, pairs,
    expectedTaskId: expectedTask ?? null,
    lookalikeTools: [...lookalikes],
    counts: {
      toolUses: pairs.length, delivered: count('delivered'), refused: count('refused'),
      notAccepted: count('not-accepted'), taskMismatch: count('task-mismatch'),
      unknownTask: count('unknown-task'), unanswered: count('unanswered'),
    },
    unanswered: pairs.filter(pair => pair.status === 'unanswered').map(pair => pair.toolUseId),
    g2Satisfied: count('delivered') > 0,
  };
}

async function taskIdFromRoster(rosterPath, sessionId) {
  if (!rosterPath || !sessionId) return undefined;
  const { RosterStore } = await import('../src/roster-store.mjs');
  const store = new RosterStore(rosterPath);
  const agent = store.agentForNativeSession(sessionId);
  if (!agent) throw new Error(`No claude-desktop name is bound to session ${sessionId} in ${rosterPath}.`);
  return store.get(agent.agentId)?.task?.taskId;
}

async function main(argv = process.argv.slice(2)) {
  const files = [];
  const allow = [];
  let taskId;
  let rosterPath;
  let out;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--task') taskId = Number.parseInt(argv[++index], 10);
    else if (value === '--roster') rosterPath = argv[++index];
    else if (value === '--out') out = argv[++index];
    else if (value === '--allow') allow.push(argv[++index]);
    else if (value.startsWith('--')) throw new Error(`Unknown option ${value}`);
    else files.push(value);
  }
  if (files.length !== 1) throw new Error('usage: claude-report-g2-evidence.mjs <transcript.jsonl> [--task <id>] [--roster <sqlite>] [--allow <name>] [--out <file>]');
  const transcript = path.resolve(files[0]);
  const first = pairReports(await readFile(transcript, 'utf8'), { taskId, allowlist: [...REPORT_TOOL_ALLOWLIST, ...allow] });
  const resolvedTask = taskId ?? await taskIdFromRoster(rosterPath, first.sessionId);
  const result = resolvedTask === taskId
    ? first
    : pairReports(await readFile(transcript, 'utf8'), { taskId: resolvedTask, allowlist: [...REPORT_TOOL_ALLOWLIST, ...allow] });
  const evidence = { transcript, at: new Date().toISOString(), allowlist: [...REPORT_TOOL_ALLOWLIST, ...allow], ...result };
  if (out) await writeFile(out, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ transcript, sessionId: result.sessionId, taskId: result.expectedTaskId,
    counts: result.counts, g2Satisfied: result.g2Satisfied, unanswered: result.unanswered,
    lookalikeTools: result.lookalikeTools,
    reason: result.g2Satisfied ? 'a successful tool_result carried accepted:true for this task'
      : result.expectedTaskId === null ? 'no task id under test; pass --task or --roster'
        : 'no tool_use/tool_result pair cleared every G2 step',
    ...(out ? { evidenceFile: path.resolve(out) } : {}) }, null, 2));
  process.exitCode = result.g2Satisfied ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
