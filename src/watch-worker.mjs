// Detached completion watcher: polls one DSH session until the dispatched turn ends, then
// persists the completion report and, only for an explicitly bound Codex task, posts one
// deduplicated notice. Launched by control.send({ background: true }) and intentionally
// outlives that call. The loop is exported so tests drive it without a child process.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FutureAideClient } from './futureaide-api.mjs';
import { isCodexThreadId } from './codex-target.mjs';
import { notifyCodex } from './codex-notify.mjs';
import { briefSession, endedState, historyMessages } from './control.mjs';
import { readDispatch } from './dispatch.mjs';

/** Atomic report write: a reader never sees a half-written completion. */
export async function writeReportFile(filename, payload) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, filename);
}

/**
 * The notification body is deliberately free of timestamps so a repeated worker run produces the
 * same dedupe key instead of posting a second message. It always names the agent, session,
 * request and report file so a receiver can tell concurrent turns apart, it names the terminal
 * state so a cancelled or failed turn is never read as an ordinary completion, and it carries the
 * exact final assistant text within the existing 4000-character budget. A longer answer is cut
 * with an explicit marker and the report path is the full record.
 * @param {object} input Identifiers, report path, terminal state and the final assistant text.
 * @param {string} input.state `completed`, `cancelled`, `failed` or `timeout`.
 * @param {string} [input.reason] Native `turn/end` reason kind when it adds information.
 * @param {string} [input.reply] This dispatch's final assistant text.
 * @returns {string} Stable summary inside the 4000-character notification limit.
 */
export function notificationSummary({ agentId, taskName, workspace, taskDirectory, sessionId, requestId, reportFile, event, state, reason, reply }) {
  const header = state === 'completed' ? '后台监视：派单回合已结束，完成报告已落盘。'
    : state === 'timeout' ? '后台监视：到达监视期限，任务是否结束仍未确认。'
      : `后台监视：派单回合已结束，终态为 ${state ?? 'unknown'}。`;
  const lines = [
    header,
    `agentId: ${agentId ?? '(普通会话，无 agent)'}`,
    ...(taskName ? [`taskName: ${taskName}`] : []),
    ...(workspace ? [`project: ${workspace}`] : []),
    ...(taskDirectory && taskDirectory !== workspace ? [`taskDirectory: ${taskDirectory}`] : []),
    `sessionId: ${sessionId}`,
    `requestId: ${requestId}`,
    `reportFile: ${reportFile}`,
    `state: ${reason === undefined || reason === null || reason === state ? state : `${state} (reason ${reason})`}`,
  ];
  const base = lines.join('\n');
  const finalText = typeof reply === 'string' ? reply.trim() : '';
  if (!finalText) return `${base}\n最终结果：本次回合没有可用的 assistant 文本；完整报告见 reportFile。`;
  const marker = '最终结果（原文；超出预算时截断，完整内容见 reportFile）：';
  const prefix = `${base}\n${marker}\n`;
  if (prefix.length + finalText.length <= 4000) return prefix + finalText;
  const suffix = `\n[已截断：原文 ${finalText.length} 字，超出通知预算；完整内容见 reportFile]`;
  const room = Math.max(0, 4000 - prefix.length - suffix.length);
  return (prefix + finalText.slice(0, room) + suffix).slice(0, 4000);
}

/** The final assistant answer of this turn, not the whole transcript. */
export function finalAssistantText(messages) {
  const assistant = (messages ?? []).filter(message => message?.role === 'assistant'
    && typeof message.text === 'string' && message.text.trim());
  return assistant.at(-1)?.text ?? '';
}

/** One notification attempt; a failure is recorded, never thrown, so completion evidence stands. */
async function deliver({ notify, config, event, summary }) {
  if (!isCodexThreadId(config.codexThreadId)) {
    return { status: config.codexThreadId === undefined ? 'not_configured' : 'error',
      ...(config.codexThreadId === undefined ? {} : { error: 'The bound Codex task ID is not a valid UUID.' }) };
  }
  try {
    const result = await notify(config, { event, summary });
    // A duplicate is only a repeat of an earlier attempt: a confirmed one stays delivered, while an
    // unconfirmed one (a receipt left mid-flight) is reported as unknown instead of resent.
    return { status: result?.delivered ? 'delivered' : result?.duplicate ? 'unknown' : result?.status ?? 'unknown',
      ...(result?.duplicate ? { duplicate: true } : {}), ...(result?.receipt ? { receipt: result.receipt } : {}) };
  } catch (error) {
    const message = String(error?.message ?? error);
    const receipt = /Receipt: (.+)$/m.exec(message)?.[1];
    return { status: /unconfirmed/i.test(message) ? 'unknown' : 'error',
      error: message.slice(0, 500), ...(receipt ? { receipt } : {}) };
  }
}

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * Poll one dispatched turn to its end. A finished turn writes its completion report before any
 * notification is attempted and returns immediately, so a notification failure or a passed
 * deadline can never replace completion evidence with a timeout. A passed deadline writes a
 * timeout report and reports blocked; it does not claim the task failed, and it leaves an already
 * stored completion report untouched.
 * @param {object} options Session, request, cursors, optional bound target and report location.
 * @param {object} [deps] Injected client, notifier, report writer, clock and sleep.
 * @returns {Promise<object>} The final report payload plus its notification outcome.
 */
export async function runWatchWorker(options, { client, notify = notifyCodex, report = writeReportFile, sleep = defaultSleep, now = Date.now } = {}) {
  const { workspace, taskDirectory, stateDirectory, sessionId, requestId, afterSeq, agentId, codexThreadId, taskName } = options;
  const pollMs = Math.max(1, Number(options.pollMs ?? 5000));
  const maxMinutes = Math.max(0, Number(options.maxMinutes ?? 360));
  const autoArchive = options.autoArchive === true && typeof agentId === 'string' && agentId.length > 0;
  const reportFile = options.reportFile ?? path.join(stateDirectory, 'reports', `${sessionId}.${requestId}.json`);
  const notifyConfig = { workspace, stateDirectory, codexThreadId, futureaideSessionId: sessionId };
  const deadline = now() + maxMinutes * 60000;
  let lastError;

  const store = async payload => {
    await report(reportFile, payload);
    return payload;
  };
  /**
   * Close this agent's own session after a finished turn. The completion report is already on
   * disk, so a failed archive is recorded as an inspectable status instead of replacing the result.
   * Timeout and running are not terminal and are never archived.
   */
  const archiveOnce = async payload => {
    if (!autoArchive || payload.state !== 'ended' || payload.archive !== undefined
      || !['completed', 'cancelled', 'failed'].includes(payload.terminalState)) return payload;
    // The finished turn is not proof that the session is idle: a caller may already have collected
    // the result and started a followup, so archiving now would close the active conversation.
    if (payload.running === true) {
      return { ...payload, archive: { state: 'skipped', at: new Date().toISOString(),
        reason: 'The session is still running (a followup already started); an active session is never archived.' } };
    }
    if (typeof client.archiveSession !== 'function') {
      return { ...payload, archive: { state: 'unavailable', at: new Date().toISOString(),
        error: 'This host client has no session archive operation.' } };
    }
    try {
      const result = await client.archiveSession(sessionId);
      if (result?.accepted === false) {
        return { ...payload, archive: { state: result?.status === 'unknown' ? 'unknown' : 'failed', at: new Date().toISOString(),
          ...(result?.status === undefined ? {} : { status: result.status }),
          ...(result?.receipt === undefined ? {} : { receipt: result.receipt }) } };
      }
      return { ...payload, archive: { state: 'archived', at: new Date().toISOString(),
        ...(Array.isArray(result?.archivedSessionIds) ? { archivedSessionCount: result.archivedSessionIds.length } : {}),
        ...(result?.receipt === undefined ? {} : { receipt: result.receipt }) } };
    } catch (error) {
      return { ...payload, archive: { state: 'failed', at: new Date().toISOString(),
        error: String(error?.message ?? error).slice(0, 500) } };
    }
  };
  /** The report already on disk for this dispatch, whichever baseline it covers. */
  const storedReport = async () => {
    try {
      const existing = JSON.parse(await readFile(reportFile, 'utf8'));
      return existing?.sessionId === sessionId && existing?.requestId === requestId ? existing : undefined;
    } catch { return undefined; }
  };
  /** A stored report is this run's own evidence only for the same baseline cursor. */
  const sameBaseline = existing => !Number.isSafeInteger(afterSeq)
    || (Number.isSafeInteger(existing.afterSeq) && existing.afterSeq === afterSeq);
  const finish = async (payload, event, state, reason, reply) => {
    // 1. Persist the outcome first: report landing must not depend on archive or notification.
    await store(payload);
    // 2. Close only this finished agent session; a failure leaves completion evidence intact.
    const archived = await archiveOnce(payload);
    if (archived !== payload) {
      payload = archived;
      await store(payload);
    }
    // 3. Reuse the existing receipt-backed, deduplicated notifier for the explicit target only.
    const notification = await deliver({ notify, config: notifyConfig, event,
      summary: notificationSummary({ agentId, taskName, workspace, taskDirectory, sessionId, requestId, reportFile, event, state, reason, reply }) });
    const finished = { ...payload, notification };
    // 4. Record the delivery outcome without risking the report written in step 1.
    const updated = await store(finished).then(() => true, () => false);
    return { ...finished, reportUpdateStored: updated };
  };

  for (;;) {
    let row;
    let dispatch;
    try {
      row = (await client.listSessions()).items.find(item => item.sessionId === sessionId);
      if (!row) throw new Error('The session is not listed by the host.');
      dispatch = await readDispatch(client, sessionId, { maxMessages: 40, workspace, requestId, afterSeq });
    } catch (error) {
      lastError = error;
    }
    if (dispatch?.ended) {
      const page = historyMessages(dispatch.page, row);
      // A native aborted/error reason is a cancelled or failed turn, not a completion; it still
      // notifies as blocked so the receiver is told to coordinate instead of treating it as done.
      const terminalState = endedState(dispatch.boundary.completionReason);
      const messages = (page.messages ?? []).filter(message => Number.isSafeInteger(message.seq) && message.seq > afterSeq);
      // A repeated run must not archive twice when the stored report already carries the result.
      const previous = await storedReport();
      const priorArchive = previous?.state === 'ended' && sameBaseline(previous) ? previous.archive : undefined;
      return await finish({ state: 'ended', terminalState, sessionId, requestId, afterSeq, ...(agentId ? { agentId } : {}),
        ...(codexThreadId ? { codexThreadId } : {}),
        correlation: dispatch.boundary.correlation, endSeq: dispatch.boundary.endSeq, completionReason: dispatch.boundary.completionReason,
        session: briefSession(row), running: Boolean(row.running), lastEventType: page.lastEventType,
        messages, ...(priorArchive === undefined ? {} : { archive: priorArchive }),
        storedAt: new Date().toISOString(), source: 'detached-watch' },
      terminalState === 'completed' ? 'completed' : 'blocked', terminalState, dispatch.boundary.completionReason?.kind,
      finalAssistantText(messages));
    }
    if (now() >= deadline) {
      // A stored completion is never replaced by a later deadline: a host restart, a pruned page
      // or a repeated send with the same request can start a second worker that no longer sees the
      // ended turn, and its timeout would erase the reply.
      const existing = await storedReport();
      if (existing?.state === 'ended') {
        const terminalState = existing.terminalState ?? endedState(existing.completionReason);
        const event = terminalState === 'completed' ? 'completed' : 'blocked';
        if (!sameBaseline(existing)) {
          // The stored completion belongs to another baseline of this dispatch. Adopting it would
          // misreport this run, and overwriting it with a deadline would erase a real reply, so the
          // file stays untouched and this run reports its own timeout.
          const notification = await deliver({ notify, config: notifyConfig, event: 'blocked',
            summary: notificationSummary({ agentId, taskName, workspace, taskDirectory, sessionId, requestId, reportFile, event: 'blocked', state: 'timeout' }) });
          return { state: 'timeout', sessionId, requestId, afterSeq, ...(agentId ? { agentId } : {}),
            gaveUpAt: new Date().toISOString(), lastError: lastError?.message, source: 'detached-watch',
            reportFile, reportState: 'ended', reportUntouched: true, notification,
            note: 'The watch deadline passed; the turn may still be running. This is not a task failure and nothing was resent. The completion report already on disk covers another baseline, so it was left untouched.' };
        }
        // A completion that was never announced still gets its one notice: the first worker may have
        // died before recording any delivery. The retry reuses the report's own identity and target,
        // so its dedupe key is the first attempt's and a second real delivery is impossible.
        const retryable = existing.notification === undefined
          && (existing.codexThreadId === undefined || existing.codexThreadId === codexThreadId);
        const reply = finalAssistantText(existing.messages);
        let kept = await archiveOnce({ ...existing, terminalState });
        const notification = retryable ? await deliver({ notify, config: notifyConfig, event,
          summary: notificationSummary({ agentId: existing.agentId ?? agentId, taskName, workspace, taskDirectory,
            sessionId, requestId, reportFile, event, state: terminalState, reason: existing.completionReason?.kind, reply }) })
          : existing.notification;
        kept = { ...kept, ...(notification === undefined ? {} : { notification }), timeoutSuppressed: true, reportFile,
          note: retryable ? 'A stored completion report already covers this dispatch; this later watch run kept it and only completed the missing notice.'
            : 'A stored completion report already covers this dispatch; this later watch run kept it and posted no notice.' };
        if (retryable || kept.archive !== existing.archive) await store(kept).then(() => true, () => false);
        return kept;
      }
      return await finish({ state: 'timeout', sessionId, requestId, afterSeq, ...(agentId ? { agentId } : {}),
        ...(codexThreadId ? { codexThreadId } : {}),
        gaveUpAt: new Date().toISOString(), lastError: lastError?.message, source: 'detached-watch',
        note: 'The watch deadline passed; the turn may still be running. This is not a task failure and nothing was resent.' }, 'blocked', 'timeout');
    }
    await sleep(Math.max(1, Math.min(pollMs, deadline - now())));
  }
}

/** @returns {Map<string,string|true>} `--flag value` pairs and known bare boolean flags. */
export function workerArguments(argv) {
  const args = new Map();
  const BOOLEAN = new Set(['auto-archive']);
  for (let index = 2; index < argv.length;) {
    const key = String(argv[index]).replace(/^--/, '');
    if (BOOLEAN.has(key)) { args.set(key, true); index += 1; continue; }
    const next = argv[index + 1];
    if (next === undefined) { args.set(key, true); index += 1; continue; }
    args.set(key, next);
    index += 2;
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = workerArguments(process.argv);
  const sessionId = args.get('session');
  const workspace = args.get('workspace');
  const stateDirectory = args.get('state');
  const requestId = args.get('request');
  if (!sessionId || !stateDirectory || !requestId || !workspace) {
    console.error('watch-worker: --session, --workspace, --state and --request are required.');
    process.exit(2);
  }
  const client = new FutureAideClient({
    dataHome: args.get('data-root') || undefined,
    dshDataHome: args.get('dsh-data-root') || undefined,
    target: args.get('target') || undefined,
    instanceFile: args.get('instance-file') || undefined,
    preferredInstanceFile: args.get('preferred-instance-file') || undefined,
    hostBridgeFile: args.get('host-bridge-file') || undefined,
    timeoutMs: args.has('timeout-ms') ? Number(args.get('timeout-ms')) : undefined,
    baseUrl: args.get('base-url') || undefined,
  });
  await runWatchWorker({
    workspace, stateDirectory, sessionId, requestId,
    afterSeq: Number(args.get('after-seq') ?? -1),
    agentId: args.get('agent-id'),
    ...(args.get('task-name') === undefined ? {} : { taskName: args.get('task-name') }),
    codexThreadId: args.get('codex-thread-id'),
    autoArchive: args.has('auto-archive'),
    pollMs: Math.max(2000, Number(args.get('poll') ?? 5000)),
    maxMinutes: Math.max(1, Number(args.get('max-minutes') ?? 360)),
  }, { client });
  process.exit(0);
}
