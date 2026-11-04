// Read a Claude Desktop native transcript and decide whether a structured report
// really reached the plugin.
//
// G2 is only satisfied by a pair that clears every step:
//   1. the tool_use name is one exact registered MCP name (allowlist below; a bare
//      `report_parent` or any other suffix is reported, never counted);
//   2. its tool_result has is_error false;
//   3. the result body parses to a receipt with accepted:true — judged by the very
//      parser the runtime uses (`reportReceipt` from claude-inbox.mjs), so evidence
//      and runtime cannot drift apart;
//   4. that receipt carries the task under test (and the agent id, when the roster
//      names it).
// A refusal, a successful call whose body is not accepted:true, a receipt for
// another task, or a missing result never counts.
//
// Read-only. It starts, resumes, modifies and cleans nothing, and reads only the
// given transcript plus, optionally, the shared roster.
//
//   node scripts/claude-report-g2-evidence.mjs <transcript.jsonl> --task 7 [--out evidence.json]
//   node scripts/claude-report-g2-evidence.mjs <transcript.jsonl> --roster <roster.sqlite> [--out ...]
//   node scripts/claude-report-g2-evidence.mjs <transcript.jsonl> --allow mcp__other__report_parent
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { reportReceipt } from '../src/claude-inbox.mjs';
import { REPORT_TOOL_ALLOWLIST } from '../src/claude-report-binding.mjs';

// The same allowlist the runtime gate uses: exact registered names only.
export { REPORT_TOOL_ALLOWLIST };

/** Names that look like reports but are not registered MCP tools: diagnostics only. */
const LOOKALIKE = /(?:^|__)(ask_parent|report_parent)$/;

const textOf = content => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (part?.type === 'text' ? part.text : '')).filter(Boolean).join('\n');
};

function kindOf(name) {
  if (name.endsWith('__ask_parent')) return 'question';
  if (name.endsWith('__report_parent')) return 'report';
  return undefined;
}

/**
 * Pair recognized report tool calls with their results.
 * @param {string} body Raw JSONL text.
 * @param {object} [options] `taskId`/`agentId` under test and an allowlist override.
 * @returns {object} Pairs with a per-pair status and counts; `g2Satisfied` is true
 *   only for a delivered pair.
 */
export function pairReports(body, { taskId, agentId, allowlist = REPORT_TOOL_ALLOWLIST } = {}) {
  const allowed = new Set(allowlist);
  const expectedTask = taskId === undefined || taskId === null ? undefined : taskId;
  const expectedAgent = typeof agentId === 'string' && agentId ? agentId : undefined;
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
    const full = results.get(use.toolUseId) ?? null;
    const { content: _content, ...resultView } = full ?? {};
    // One parser for evidence and runtime: a body earns nothing unless the runtime
    // parser itself accepts it.
    const receipt = full && !full.isError ? reportReceipt(full.content) : undefined;
    let status;
    if (!full) status = 'unanswered';
    else if (full.isError) status = 'refused';
    else if (!receipt) status = 'not-accepted';
    else if (expectedTask === undefined) status = 'unknown-task';
    else if (receipt.taskId !== expectedTask) status = 'task-mismatch';
    else if (expectedAgent && receipt.agentId && receipt.agentId !== expectedAgent) status = 'agent-mismatch';
    else status = 'delivered';
    return { ...use, result: full ? resultView : null, receipt: receipt ?? null, status, delivered: status === 'delivered' };
  });
  const count = status => pairs.filter(pair => pair.status === status).length;
  return {
    sessionId, lines, badLines, sidechainUses, pairs,
    expectedTaskId: expectedTask ?? null,
    expectedAgentId: expectedAgent ?? null,
    lookalikeTools: [...lookalikes],
    counts: {
      toolUses: pairs.length, delivered: count('delivered'), refused: count('refused'),
      notAccepted: count('not-accepted'), taskMismatch: count('task-mismatch'),
      agentMismatch: count('agent-mismatch'), unknownTask: count('unknown-task'),
      unanswered: count('unanswered'),
    },
    unanswered: pairs.filter(pair => pair.status === 'unanswered').map(pair => pair.toolUseId),
    g2Satisfied: count('delivered') > 0,
  };
}

async function bindingFromRoster(rosterPath, sessionId) {
  if (!rosterPath || !sessionId) return {};
  const { RosterStore } = await import('../src/roster-store.mjs');
  const store = new RosterStore(rosterPath);
  const agent = store.agentForNativeSession(sessionId);
  if (!agent) throw new Error(`No claude-desktop name is bound to session ${sessionId} in ${rosterPath}.`);
  return { agentId: agent.agentId, taskId: store.get(agent.agentId)?.task?.taskId };
}

async function main(argv = process.argv.slice(2)) {
  const files = [];
  const allow = [];
  let taskId;
  let agentId;
  let rosterPath;
  let out;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--task') taskId = Number.parseInt(argv[++index], 10);
    else if (value === '--agent') agentId = argv[++index];
    else if (value === '--roster') rosterPath = argv[++index];
    else if (value === '--out') out = argv[++index];
    else if (value === '--allow') allow.push(argv[++index]);
    else if (value.startsWith('--')) throw new Error(`Unknown option ${value}`);
    else files.push(value);
  }
  if (files.length !== 1) throw new Error('usage: claude-report-g2-evidence.mjs <transcript.jsonl> [--task <id>] [--agent <id>] [--roster <sqlite>] [--allow <name>] [--out <file>]');
  const transcript = path.resolve(files[0]);
  const body = await readFile(transcript, 'utf8');
  const allowlist = [...REPORT_TOOL_ALLOWLIST, ...allow];
  const first = pairReports(body, { taskId, agentId, allowlist });
  const bound = (taskId === undefined || agentId === undefined) ? await bindingFromRoster(rosterPath, first.sessionId) : {};
  const resolved = { taskId: taskId ?? bound.taskId, agentId: agentId ?? bound.agentId };
  const result = resolved.taskId === taskId && resolved.agentId === agentId
    ? first
    : pairReports(body, { taskId: resolved.taskId, agentId: resolved.agentId, allowlist });
  const evidence = { transcript, at: new Date().toISOString(), allowlist, ...result };
  if (out) await writeFile(out, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ transcript, sessionId: result.sessionId,
    taskId: result.expectedTaskId, agentId: result.expectedAgentId, counts: result.counts,
    g2Satisfied: result.g2Satisfied, unanswered: result.unanswered,
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
