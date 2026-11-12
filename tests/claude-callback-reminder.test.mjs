import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { absentClaudeReportReminder, claudeCallbackReminderMs, createDesktopToastNotifier,
  DEFAULT_CLAUDE_CALLBACK_REMINDER_MS, REMINDER_BODY_LIMIT, TOAST_PROGRAM } from '../src/claude-report-reminder.mjs';
import { loadConfig } from '../src/config.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(workspace, '.runtime', 'tests');

test('the reminder wait is a whole number of milliseconds and ten minutes unless configured', () => {
  assert.equal(DEFAULT_CLAUDE_CALLBACK_REMINDER_MS, 600000);
  assert.equal(claudeCallbackReminderMs(undefined), 600000);
  assert.equal(claudeCallbackReminderMs(600000), 600000);
  assert.equal(claudeCallbackReminderMs(0), 0, '0 means the first definite absence is enough');
  assert.equal(claudeCallbackReminderMs(1500), 1500);
  // No second ceiling: the notice's own six-hour expiry already bounds a long wait.
  assert.equal(claudeCallbackReminderMs(7 * 60 * 60 * 1000), 7 * 60 * 60 * 1000);
  for (const bad of [-1, 1.5, '600000', Number.NaN, true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => claudeCallbackReminderMs(bad), /claudeCallbackReminderMs/, `${String(bad)} is refused`);
  }
});

test('the reminder body carries only the assistant name, the short session id, a bounded summary and how to read it', () => {
  const { title, body } = absentClaudeReportReminder({ name: '审阅-Alpha',
    sessionId: 'ab12cd34-1111-4111-8111-111111111111', summary: '第一行\n\n第二行  ' + 'x'.repeat(2000) });
  assert.match(body, /审阅-Alpha/);
  assert.match(body, /ab12cd34/);
  assert.equal(body.includes('1111-4111'), false, 'the session is named by its short id only');
  assert.equal(body.includes('\n\n'), false, 'the summary is folded to one bounded block');
  assert.match(body, /futureaide_inspect_agent\(detail=true\)/);
  assert.ok(body.length <= REMINDER_BODY_LIMIT, `a balloon holds 255: ${body.length}`);
  assert.equal(body.includes('x'.repeat(300)), false, 'the summary is bounded');
  assert.equal(title.includes('ab12cd34'), false, 'the title carries no report data');
  // Even the longest legal name and summary leave the read-full-text instruction intact.
  const longest = absentClaudeReportReminder({ name: '名'.repeat(100), sessionId: 'f'.repeat(80),
    summary: '报'.repeat(5000) });
  assert.ok(longest.body.length <= REMINDER_BODY_LIMIT, `a long report still fits: ${longest.body.length}`);
  assert.equal(longest.body.endsWith('打开原会话读全文。'), true, 'the way to the full text is never clipped away');
  assert.match(longest.body, /futureaide_inspect_agent\(detail=true\)/);
  assert.equal(absentClaudeReportReminder().body.includes('助手'), true, 'a missing name still yields a body');
});

/** A child process stand-in: it settles exactly the way the case needs. */
function fakeChild(outcome) {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  if (outcome === 'hang') return child;
  queueMicrotask(() => {
    if (outcome === 'spawn-error') child.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));
    else child.emit('close', outcome);
  });
  return child;
}

test('the reminder is handed to the Windows notification area as data, never as program text', async () => {
  const seen = [];
  const notify = createDesktopToastNotifier({ spawnProcess: (file, args, options) => {
    seen.push({ file, args, options });
    return fakeChild(0);
  } });
  const body = '助手「a」的回报投不进 Claude 会话 ab12cd34。\n结论 "引号" & `反引号` $(calc) <tag>';
  assert.deepEqual(await notify({ title: 'FutureAide：有回报投不进 Claude 会话', body }), { status: 'submitted' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].file, 'powershell.exe', 'the Windows PowerShell that ships with the OS');
  assert.equal(seen[0].options.windowsHide, true, 'no console window is opened');
  assert.equal(seen[0].args.at(-2), '-EncodedCommand', 'a multi-line program is never re-quoted by a shell');
  assert.equal(Buffer.from(seen[0].args.at(-1), 'base64').toString('utf16le'), TOAST_PROGRAM,
    'the encoded program is exactly the constant');
  assert.equal(seen[0].args.join('\n').includes('ab12cd34'), false, 'no report text reaches the program string');
  assert.deepEqual(JSON.parse(seen[0].options.env.FUTUREAIDE_REMINDER_JSON),
    { title: 'FutureAide：有回报投不进 Claude 会话', body });
  assert.match(TOAST_PROGRAM, /System\.Windows\.Forms\.NotifyIcon/);
  assert.match(TOAST_PROGRAM, /ShowBalloonTip/);
  assert.match(TOAST_PROGRAM, /if \(\$requested\) \{ exit 2 \}/,
    'a failure after the request may already be queued, so it is not reported as refused');
  assert.equal(/Register|AUMID|ToastNotificationManager/.test(TOAST_PROGRAM), false,
    'the OS notification area is used as it is: no app registration and no new dependency');
});

test('a reminder the system refused before showing it may be tried again, an unknown one never is', async () => {
  const notifyWith = outcome => createDesktopToastNotifier({ spawnProcess: () => fakeChild(outcome), timeoutMs: 20 });
  const refused = await notifyWith(1)({ title: 't', body: 'b' }).then(() => null, error => error);
  assert.equal(refused.beforeSubmit, true, 'nothing was shown, so the original cadence may try again');
  const missing = await notifyWith('spawn-error')({ title: 't', body: 'b' }).then(() => null, error => error);
  assert.equal(missing.beforeSubmit, true);
  const unclear = await notifyWith('hang')({ title: 't', body: 'b' }).then(() => null, error => error);
  assert.equal(unclear.unknown, true, 'a call that may have landed is never repeated');
  const odd = await notifyWith(2)({ title: 't', body: 'b' }).then(() => null, error => error);
  assert.equal(odd.unknown, true);
});

test('a configured wait is validated from the configuration file and defaults to ten minutes', async () => {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'reminder-config-'));
  const file = path.join(directory, 'config.json');
  await writeFile(file, JSON.stringify({}));
  assert.equal((await loadConfig(file)).claudeCallbackReminderMs, DEFAULT_CLAUDE_CALLBACK_REMINDER_MS);
  await writeFile(file, JSON.stringify({ claudeCallbackReminderMs: 0 }));
  assert.equal((await loadConfig(file)).claudeCallbackReminderMs, 0);
  await writeFile(file, JSON.stringify({ claudeCallbackReminderMs: 90000 }));
  assert.equal((await loadConfig(file)).claudeCallbackReminderMs, 90000);
  await writeFile(file, JSON.stringify({ claudeCallbackReminderMs: -1 }));
  await assert.rejects(loadConfig(file), /claudeCallbackReminderMs/);
  await writeFile(file, JSON.stringify({ claudeCallbackReminderMs: 1.5 }));
  await assert.rejects(loadConfig(file), /claudeCallbackReminderMs/);
  await writeFile(file, JSON.stringify({ claudeCallbackReminderMs: '600000' }));
  await assert.rejects(loadConfig(file), /claudeCallbackReminderMs/);
});
