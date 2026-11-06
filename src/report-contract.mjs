// The report and question shape every managed target is asked to follow.
//
// One copy lives here and is embedded in the ask_parent / report_parent tool
// descriptions of the two surfaces: the Codex side in mcp-server.mjs and the DSH
// side in host-plugin.mjs. The DSH plugin may only import node: builtins, so it
// keeps a literal copy of both strings; tests/report-contract.test.mjs compares it
// with this module verbatim.

/** How a final report is written, for an agent whose lead spot-checks it. */
export const FINAL_REPORT_CONTRACT = 'Write a final report for a controlling agent that will spot-check it, not re-read your work. '
  + 'Use these labelled parts in the language of the task, and leave out a part only when it is empty. '
  + 'Result: done, partly done or blocked, in one sentence. '
  + 'Changes: file:line and what changed, one line each, at most 10; give the total if there are more. '
  + 'Verified: the commands you ran with their numbers, and whether the check fails without the change. '
  + 'Not verified: what you could not check; never present an assumption as a result. '
  + 'Decisions: only choices the controlling agent must make. '
  + 'Stay under about 300 words. Do not restate the task or narrate your process. '
  + 'Put long material in a file and name it. '
  + 'If you delegated work, send one summary of the combined result.';

/** How a question is written, so it can be answered without reading the work. */
export const QUESTION_CONTRACT = 'State the decision you need, the options and your recommendation in a few lines, '
  + 'so it can be answered without reading your work.';

/**
 * Sent once when a managed DSH agent's turn ends without a final report: the caller
 * never sees ordinary reply text, so the agent has to be told that the turn changed
 * nothing for it.
 */
export const FINAL_REPORT_REMINDER = 'Your turn ended without a final report, so the controlling agent has not received your result. '
  + 'If the task is done, submit it now with report_parent and final: true. If work remains, continue it. '
  + 'If you need a decision, use ask_parent.';
