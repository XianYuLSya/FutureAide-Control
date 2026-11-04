// Ownership for the Claude report surface: the one place a native Claude session
// is tied to the plugin's own roster.
//
// It validates only what the surface needs to decide "this submission may be
// recorded": the caller's native session is bound to a live claude-desktop name,
// that name is not closed, and its current task is still open (not cancelled, not
// terminal, and without a final report already). It then answers `accepted` with
// the agent id, the task id and a stable receipt id — the fields the observer
// already reads from a successful native `tool_result`.
//
// It deliberately does not deliver anything and does not create a second notice
// path: the observer projects native `tool_use` + successful `tool_result` into
// the single shared scoped state machine, which owns delivery, backoff and
// cleanup. Reads only; the roster stays the source of truth.
import { createHash } from 'node:crypto';
import { requireRootCall, transcriptPathFor } from './claude-report-binding.mjs';

const refuse = (code, message) => Object.assign(new Error(message), { code });

/** States in which a task has already finished and must not accept new reports. */
const TERMINAL_TASK_STATES = Object.freeze(['completed', 'cancelled', 'failed']);

/**
 * Stable per (agent, task, kind, final) acceptance id. Deterministic on purpose:
 * a repeated submission returns the same id, and a late result from an older task
 * is distinguishable by the task id it carries.
 */
export function receiptIdFor(agentId, taskId, kind, final = false) {
  const digest = createHash('sha256').update(JSON.stringify([agentId, taskId, kind, final === true])).digest('hex');
  return `accept-${digest.slice(0, 16)}`;
}

/**
 * @param {object} options
 * @param {object} options.store Live RosterStore. Only its read-only reverse
 *   lookup (`agentForNativeSession`) and `get` are used.
 * @returns {(caller: {sessionId: string}, context: {tool: string}) => Promise<object|null>}
 *   Resolves an owned handle `{agentId, agentName, taskId, ask, report}`, null
 *   when the session is not bound to a plugin-owned name, and throws a coded
 *   Error when the name exists but must not report right now.
 */
export function createReportOwnership({ store, env = process.env, transcript = transcriptPathFor,
  requireCall = requireRootCall } = {}) {
  if (typeof store?.agentForNativeSession !== 'function' || typeof store?.get !== 'function') {
    throw new TypeError('createReportOwnership requires the shared RosterStore');
  }
  return async (caller, { tool, input, toolUseId } = {}) => {
    const sessionId = caller?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const agent = store.agentForNativeSession(sessionId);
    if (!agent) return null;
    const record = store.get(agent.agentId);
    // A name removed between the join and this read is not owned any more.
    if (!record || record.closed === true) return null;
    const task = record.task;
    if (!task || task.taskId === undefined || task.taskId === null) {
      throw refuse('task-missing', 'This subagent has no current task, so there is nothing to report on.');
    }
    if (task.cancelRequested === true) {
      throw refuse('task-cancelled', 'The main chat cancelled this task; stop writing reports and end your turn.');
    }
    if (task.result || TERMINAL_TASK_STATES.includes(task.state)) {
      throw refuse('task-finished', `Task ${task.taskId} has already finished; only the running task accepts reports.`);
    }
    if ((task.reports ?? []).some(report => report.final === true)) {
      throw refuse('report-final-already-submitted',
        `A final report was already submitted for task ${task.taskId}; do not submit another.`);
    }
    // Submissions additionally need the root session's own open tool call: a
    // sub-agent shares the process and connection but its calls are sidechain
    // records the main chat never observes.
    if (tool === 'ask' || tool === 'report') {
      const file = await transcript({ sessionId, workspace: caller.cwd, env });
      if (!file) {
        throw refuse('transcript-unavailable',
          'This session transcript could not be read, so the report cannot be tied to a tool call.');
      }
      await requireCall({ transcriptFile: file, tool: tool === 'ask' ? 'question' : 'report',
        message: input?.message, final: input?.final === true, toolUseId });
    }
    const { agentId, name } = record;
    const { taskId } = task;
    const accept = (kind, final) => ({ accepted: true, agentId, taskId, receiptId: receiptIdFor(agentId, taskId, kind, final) });
    return {
      agentId, agentName: name, taskId,
      async ask() { return accept('ask', false); },
      async report({ final } = {}) { return accept('report', final === true); },
    };
  };
}
