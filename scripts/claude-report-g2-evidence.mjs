// Read a Claude Desktop native transcript and pair every ask_parent / report_parent
// tool_use with its tool_result. G2 counts only pairs whose result is successful
// (is_error false); a tool_use without a result is not a delivery.
//
// Read-only. It does not start, resume, modify or clean any session, and it reads
// only the transcript file it is given. Root records only: sidechain (subagent)
// records are counted separately and never treated as the managed session's own
// report.
//
//   node scripts/claude-report-g2-evidence.mjs <transcript.jsonl> [--out evidence.json]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPORT_TOOLS = Object.freeze(['ask_parent', 'report_parent']);

const textOf = content => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (part?.type === 'text' ? part.text : '')).filter(Boolean).join('\n');
};

/**
 * Pair tool calls and results from a transcript body.
 * @param {string} body Raw JSONL text.
 * @returns {object} Pairs, orphans and counts, all keyed by native record ids.
 */
export function pairReports(body) {
  const uses = new Map();
  const results = new Map();
  let sessionId = null;
  let lines = 0;
  let badLines = 0;
  let sidechainUses = 0;
  for (const line of String(body).split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines += 1;
    let record;
    try { record = JSON.parse(line); } catch { badLines += 1; continue; }
    sessionId ??= typeof record?.sessionId === 'string' ? record.sessionId : null;
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'tool_use' && REPORT_TOOLS.includes(part.name)) {
        if (record.isSidechain === true) { sidechainUses += 1; continue; }
        uses.set(part.id, { toolUseId: part.id, name: part.name, input: part.input ?? null,
          timestamp: record.timestamp ?? null, result: null });
      }
      if (part?.type === 'tool_result' && uses.has(part.tool_use_id)) {
        results.set(part.tool_use_id, {
          toolUseId: part.tool_use_id, isError: part.is_error === true,
          text: textOf(part.content).slice(0, 4000), timestamp: record.timestamp ?? null,
        });
      }
    }
  }
  const pairs = [...uses.values()].map(use => ({ ...use, result: results.get(use.toolUseId) ?? null,
    delivered: results.get(use.toolUseId)?.isError === false }));
  const unanswered = pairs.filter(pair => pair.result === null).map(pair => pair.toolUseId);
  return {
    sessionId, lines, badLines, sidechainUses, pairs,
    counts: {
      toolUses: pairs.length,
      delivered: pairs.filter(pair => pair.delivered).length,
      failed: pairs.filter(pair => pair.result?.isError === true).length,
      unanswered: unanswered.length,
    },
    unanswered,
    g2Satisfied: pairs.some(pair => pair.delivered),
  };
}

async function main(argv = process.argv.slice(2)) {
  const file = argv.find(value => !value.startsWith('--'));
  if (!file) throw new Error('usage: claude-report-g2-evidence.mjs <transcript.jsonl> [--out <file>]');
  const outIndex = argv.indexOf('--out');
  const result = pairReports(await readFile(file, 'utf8'));
  const evidence = { transcript: path.resolve(file), at: new Date().toISOString(), ...result };
  const out = outIndex === -1 ? undefined : argv[outIndex + 1];
  if (out) await writeFile(out, JSON.stringify(evidence, null, 2));
  const summary = { transcript: evidence.transcript, sessionId: result.sessionId, counts: result.counts,
    g2Satisfied: result.g2Satisfied, unanswered: result.unanswered, ...(out ? { evidenceFile: path.resolve(out) } : {}) };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = result.g2Satisfied ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
