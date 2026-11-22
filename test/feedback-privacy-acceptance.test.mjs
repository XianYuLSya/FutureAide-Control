import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { inboxPath, pendingFeedback, writeFeedback } from '../src/feedback-inbox.mjs';

const cli = path.resolve('src/cli.mjs');
const writer = path.resolve('src/feedback-inbox.mjs');
const context = { source: 'dsh', caller: 'codex', target: 'dsh', name: '测试助手' };
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'feedback-acceptance-'));
  const config = path.join(root, 'config.json');
  writeFileSync(config, '{}');
  return { root, config };
}
function run(config, command, ...args) {
  return spawnSync(process.execPath, [cli, command, '--config', config, ...args], { encoding: 'utf8' });
}
function submit(config, input, ctx = context) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writer, '--write', '--config', config], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ value: JSON.parse(stdout), stdout, stderr }) : reject(Error(stderr)));
    child.stdin.end(JSON.stringify({ input, context: ctx }));
  });
}
function result(command) { assert.equal(command.status, 0, command.stderr); return JSON.parse(command.stdout); }

test('privacy in live WAL, main database, CLI output and receipts', async t => {
  const { root, config } = setup();
  const secret = 'a7'.repeat(32), marker = 'WAL-ordinary-marker-中文';
  const sensitive = [`C:\\private\\${secret}\\file`, `https://example.invalid/${secret}`,
    `"C:\\with spaces\\${secret}\\file"`, `Cookie: session=${secret}; other=value`,
    `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`];
  // Keep a reader connection open before writes, so committed frames remain in WAL.
  writeFeedback({ kind: 'problem', message: '初始化' }, context, config);
  const db = new DatabaseSync(inboxPath(config));
  t.after(() => db.close());
  db.exec('PRAGMA wal_autocheckpoint=0');
  db.exec('BEGIN'); db.prepare('SELECT count(*) FROM occurrences').get();
  const receipts = [];
  for (const value of sensitive) {
    const r = await submit(config, { kind: 'problem', message: `${marker} ${value}` },
      { ...context, name: `助手 ${value}`, error: { tool: 'report_parent', code: secret, at: new Date().toISOString() } });
    assert.equal(r.value.saved, true); receipts.push(r.stdout, r.stderr);
  }
  const row = pendingFeedback(config).find(x => x.occurrences.some(o => o.message.includes(marker)));
  assert.ok(row); assert.match(row.occurrences[0].message, /中文/);
  assert.equal(row.occurrences[0].error, null);
  const summary = path.join(root, 'summary.txt');
  writeFileSync(summary, `中文建议 ${sensitive.join(' ')}`);
  const badKey = run(config, 'feedback-organize', '--id', row.id, '--through', '1', '--todo', `bad-${secret}`, '--message-file', summary);
  assert.notEqual(badKey.status, 0); receipts.push(badKey.stdout, badKey.stderr);
  assert.equal(pendingFeedback(config).find(x => x.id === row.id).organizedThrough, 0);
  const organized = run(config, 'feedback-organize', '--id', row.id, '--through', '1', '--todo', 'privacy-case', '--message-file', summary);
  assert.equal(result(organized).through, 1); receipts.push(organized.stdout, organized.stderr);
  const todos = run(config, 'feedback-todos'); assert.match(todos.stdout, /中文建议/); receipts.push(todos.stdout, todos.stderr);
  const wal = `${inboxPath(config)}-wal`;
  assert.ok(existsSync(wal));
  const mainBytes = readFileSync(inboxPath(config)), walBytes = readFileSync(wal);
  assert.ok(walBytes.length > 32, 'WAL contains frames');
  assert.ok(walBytes.includes(Buffer.from(marker)), 'WAL contains this test’s committed ordinary marker');
  for (const [label, bytes] of [['database', mainBytes], ['WAL', walBytes], ['receipts', Buffer.from(receipts.join('\n'))]]) {
    assert.equal(bytes.includes(Buffer.from(secret)), false, `${label} contains fabricated secret`);
    for (const value of sensitive) assert.equal(bytes.includes(Buffer.from(value)), false, `${label} contains raw sensitive value`);
  }
  t.diagnostic(`privacy evidence: WAL=${walBytes.length} bytes, marker present, secret matches=0 in database/WAL/receipts; ${root}`);
});

test('CLI organization, concurrent recurrence, isolation, and fingerprint cases', async t => {
  const a = setup(), b = setup();
  const err = tool => ({ ...context, error: { tool, code: 'timed-out', at: new Date().toISOString() } });
  const input = id => ({ kind: 'problem', message: `派单回执超时 requestId=${id}` });
  const one = await submit(a.config, input('one'), err('dispatch'));
  const two = await submit(a.config, input('two'), err('dispatch'));
  assert.equal(two.value.id, one.value.id); assert.equal(two.value.count, 2);
  const read = result(run(a.config, 'feedback-pending')).find(x => x.id === one.value.id);
  assert.equal(read.count, 2); assert.equal(read.occurrences.length, 2);
  const summary = path.join(a.root, 'summary.txt'); writeFileSync(summary, '建议检查派单回执');
  const third = await submit(a.config, input('three'), err('dispatch'));
  assert.equal(third.value.count, 3);
  result(run(a.config, 'feedback-organize', '--id', one.value.id, '--through', '2', '--todo', 'dispatch-timeout', '--message-file', summary));
  writeFileSync(summary, '过时摘要不应覆盖');
  assert.equal(result(run(a.config, 'feedback-organize', '--id', one.value.id, '--through', '2', '--todo', 'dispatch-timeout', '--message-file', summary)).unchanged, true);
  assert.equal(result(run(a.config, 'feedback-todos'))[0].message, '建议检查派单回执');
  const pending = result(run(a.config, 'feedback-pending')).find(x => x.id === one.value.id);
  assert.equal(pending.newCount, 1); assert.equal(pending.occurrences[0].seq, 3);
  const db = new DatabaseSync(inboxPath(a.config));
  assert.deepEqual(db.prepare('SELECT seq FROM occurrences WHERE problem_id=? ORDER BY seq').all(one.value.id).map(x => x.seq), [1, 2, 3]);
  db.close();
  const differentTool = await submit(a.config, input('four'), err('report'));
  const differentCode = await submit(a.config, input('five'), { ...err('dispatch'), error: { ...err('dispatch').error, code: 'other-error' } });
  assert.notEqual(differentTool.value.id, one.value.id); assert.notEqual(differentCode.value.id, one.value.id);
  const generic1 = await submit(a.config, { kind: 'problem', message: '超时' }, { ...context, target: null });
  const generic2 = await submit(a.config, { kind: 'problem', message: '超时' }, { ...context, target: null });
  assert.notEqual(generic1.value.id, generic2.value.id);
  const n1 = await submit(a.config, { kind: 'problem', message: '第 1 次回包错位' });
  const n2 = await submit(a.config, { kind: 'problem', message: '第 2 次回包错位' });
  assert.notEqual(n1.value.id, n2.value.id);
  const isolated = await submit(b.config, input('one'), err('dispatch'));
  assert.equal(isolated.value.count, 1); assert.notEqual(isolated.value.id, one.value.id);
  assert.equal(result(run(b.config, 'feedback-pending')).length, 1);
  const bad = run(a.config, 'feedback-organize', '--id', one.value.id, '--through', '4', '--todo', 'bad-progress', '--message-file', summary);
  assert.notEqual(bad.status, 0); assert.equal(result(run(a.config, 'feedback-pending')).find(x => x.id === one.value.id).organizedThrough, 2);
  t.diagnostic(`CLI evidence: A=${a.root}, B=${b.root}; three occurrences preserved; organized through 2 with third pending`);
});

test('concurrent subprocess writes reconcile receipts and locked failure changes no count', async t => {
  const { root, config } = setup();
  const input = { kind: 'friction', message: '操作按钮回执不明显' };
  const results = await Promise.all([submit(config, input), submit(config, input)]);
  const success = results.filter(r => r.value.saved === true);
  const failures = results.filter(r => r.value.saved === false);
  assert.ok(success.length > 0);
  assert.ok(failures.every(r => r.value.code === 'feedback-busy'));
  const rows = result(run(config, 'feedback-pending'));
  assert.equal(rows.length, 1); assert.equal(rows[0].count, success.length);
  assert.equal(rows[0].occurrences.length, success.length);
  const db = new DatabaseSync(inboxPath(config));
  db.exec('BEGIN IMMEDIATE');
  try {
    const busy = await submit(config, input);
    assert.deepEqual(busy.value, { saved: false, code: 'feedback-busy' });
  } finally { db.exec('ROLLBACK'); db.close(); }
  const after = result(run(config, 'feedback-pending'));
  assert.equal(after[0].count, success.length);
  t.diagnostic(`concurrency evidence: ${root}; success=${success.length}, busy=${failures.length}, locked busy=1, count=${after[0].count}`);
});
