import { spawn } from 'node:child_process';

/**
 * One OS reminder for a report that cannot reach the Claude session that owns the name.
 *
 * The plugin already retries such a report on the notice's own schedule and delivers it
 * the moment the session comes back; this module only adds the human-facing half: once
 * the same report has found the same session gone for the configured wait, the report is
 * handed to the Windows notification area as it ships with the OS — no application
 * window, no registered app, no new dependency. The reply is "the system was asked to
 * show this", never "somebody saw it".
 */

/** Ten minutes: long enough for a session that comes back by itself to be left alone. */
export const DEFAULT_CLAUDE_CALLBACK_REMINDER_MS = 600000;

/**
 * The configured wait before the reminder, in whole milliseconds. `0` means the first
 * definite absence is enough. Any non-negative safe integer is accepted: a notice of its
 * own expires six hours after it was written, and that existing limit — not a second
 * ceiling here — is what bounds a very long wait.
 * @param {unknown} value Configured value; undefined keeps the default.
 * @param {number} [fallback] Default to use when the value is undefined.
 * @returns {number} The wait in milliseconds.
 */
export function claudeCallbackReminderMs(value, fallback = DEFAULT_CLAUDE_CALLBACK_REMINDER_MS) {
  const chosen = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(chosen) || chosen < 0) {
    throw new Error('claudeCallbackReminderMs must be a whole non-negative number of milliseconds.');
  }
  return chosen;
}

/**
 * A notification balloon holds one short block: NOTIFYICONDATA.szInfo is 256 UTF-16
 * code units including its terminator, so the body is built to 255 at most and the
 * instruction that reads the full report is reserved before the excerpt gets its room.
 */
export const REMINDER_BODY_LIMIT = 255;
const SUMMARY_LIMIT = 240;
const READ_FULL_TEXT = '用 futureaide_inspect_agent(detail=true) 打开原会话读全文。';
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
/** Never longer than `limit`, the ellipsis included. */
const clip = (value, limit) => value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;

/**
 * The reminder body: the assistant name, the short id of the session that is away, a
 * bounded excerpt of the report, and the one call that reads the rest. Nothing else —
 * the report's full text stays in the roster where inspect reads it as data.
 * @param {{name?: string, sessionId?: string, summary?: string}} input Reminder facts.
 * @returns {{title: string, body: string}} What the notification area shows.
 */
export function absentClaudeReportReminder({ name, sessionId, summary } = {}) {
  const assistant = clip(oneLine(name), 40) || '未知助手';
  const session = oneLine(sessionId).replace(/[^0-9A-Za-z-]/g, '').slice(0, 8) || '未知会话';
  const head = clip(`助手「${assistant}」的回报投不进 Claude 会话 ${session}。`,
    Math.max(0, REMINDER_BODY_LIMIT - READ_FULL_TEXT.length - 2));
  const room = REMINDER_BODY_LIMIT - head.length - READ_FULL_TEXT.length - 2;
  const excerpt = room > 8 ? clip(oneLine(summary), Math.min(SUMMARY_LIMIT, room)) : '';
  const body = [head, excerpt, READ_FULL_TEXT].filter(Boolean).join('\n');
  return { title: 'FutureAide：有回报投不进 Claude 会话', body };
}

/**
 * The Windows side, kept as a constant on purpose: the reminder text arrives in the
 * environment as JSON and is only ever read with ConvertFrom-Json, so a report that
 * contains quotes, backticks or PowerShell syntax can never be parsed as code. The
 * program travels as -EncodedCommand, so no line of it is ever re-quoted by a shell.
 *
 * Exit codes are the whole protocol, and they describe the system, never the reader:
 * 0 the notification area accepted the request, 1 it refused before anything was
 * requested, 2 the request may have been accepted before the failure — that one is
 * never repeated.
 */
export const TOAST_PROGRAM = [
  "$ErrorActionPreference = 'Stop'",
  '$requested = $false',
  'try {',
  '$note = $env:FUTUREAIDE_REMINDER_JSON | ConvertFrom-Json',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$balloon = New-Object System.Windows.Forms.NotifyIcon',
  'try {',
  '  $balloon.Icon = [System.Drawing.SystemIcons]::Information',
  '  $balloon.BalloonTipTitle = [string]$note.title',
  '  $balloon.BalloonTipText = [string]$note.body',
  '  $balloon.Visible = $true',
  '  $balloon.ShowBalloonTip(6000)',
  '  $requested = $true',
  '  Start-Sleep -Milliseconds 6000',
  '} finally {',
  '  try { $balloon.Visible = $false; $balloon.Dispose() } catch { }',
  '}',
  '} catch {',
  '  if ($requested) { exit 2 }',
  '  exit 1',
  '}',
  'exit 0',
].join('\n');

/** PowerShell reads -EncodedCommand as base64 of its own UTF-16LE program text. */
export const encodedToastProgram = () => Buffer.from(TOAST_PROGRAM, 'utf16le').toString('base64');

/**
 * A notifier that shows one short native notification in the Windows notification area
 * through the PowerShell and WinForms the OS already carries.
 * @param {{powershell?: string, timeoutMs?: number, spawnProcess?: Function}} [options] Seams.
 * @returns {(payload: {title: string, body: string}) => Promise<{status: 'submitted'}>} Notifier.
 */
export function createDesktopToastNotifier({ powershell = process.env.FUTUREAIDE_POWERSHELL || 'powershell.exe',
  timeoutMs = 20000, spawnProcess = spawn } = {}) {
  return async function notifyDesktop(payload) {
    const env = { ...process.env, FUTUREAIDE_REMINDER_JSON: JSON.stringify({
      title: String(payload?.title ?? ''), body: String(payload?.body ?? '') }) };
    let child;
    try {
      child = spawnProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA',
        '-EncodedCommand', encodedToastProgram()], { windowsHide: true, stdio: 'ignore', env });
    } catch (error) {
      throw Object.assign(new Error(`The Windows notification area could not be started: ${error?.message ?? error}`), { beforeSubmit: true });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* the outcome is already unclear */ }
        reject(Object.assign(new Error('The notification area did not answer in time, so the reminder may or may not be queued.'), { unknown: true }));
      }, timeoutMs);
      const done = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', error => done(Object.assign(
        new Error(`The Windows notification area could not be started: ${error?.message ?? error}`), { beforeSubmit: true })));
      child.once('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 0 means the notification area took the request — never that anyone saw it.
        if (code === 0) { resolve({ status: 'submitted' }); return; }
        if (code === 1) {
          reject(Object.assign(new Error('The Windows notification area refused this reminder before it was requested.'), { beforeSubmit: true }));
          return;
        }
        // 2, and anything unexpected, may already be queued: that is never repeated.
        reject(Object.assign(new Error(`The reminder ended without a definite outcome (exit ${code}).`), { unknown: true }));
      });
    });
  };
}
