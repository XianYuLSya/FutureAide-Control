import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };

export function inboxPath(configFile) {
  if (typeof configFile !== 'string' || !path.isAbsolute(configFile))
    throw new Error('An absolute config path is required.');
  return path.join(path.dirname(configFile), 'feedback', 'inbox.sqlite');
}
export function redact(value) {
  return String(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, '[redacted]')
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[\s\S]*?\1/g, '[redacted]')
    .replace(/\b(?:https?|file):\/\/[^\s<>"']+/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s<>"']+/g, '[redacted]')
    .replace(/(?:^|(?<=\s))\/(?:[^\s<>"']+)/g, '[redacted]')
    .replace(/\b(?:authorization|(?:set-)?cookie)\s*[:=]\s*[^\r\n]*/gi, '[redacted]')
    .replace(/\bbearer\s+[^\s,;]+/gi, '[redacted]')
    .replace(
      /\b(?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|secret|password)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '[redacted]',
    )
    .replace(/\b(?:sk|pk|ghp|github_pat)[-_][A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/[a-f0-9]{64}/gi, '[redacted]');
}
function clean(value, max = 1200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new Error('Invalid feedback text.');
  const result = redact(value.trim());
  if (!result.replace(/\[redacted\]/g, '').replace(/[\s\p{P}\p{S}]/gu, ''))
    throw new Error('Please rewrite without sensitive information.');
  return result;
}
function contextString(value) {
  return typeof value === 'string' && value.trim() ? redact(value.trim()).slice(0, 200) : null;
}
function errorContext(e) {
  if (!e || typeof e !== 'object') return null;
  const tool = typeof e.tool === 'string' && /^[\w.-]{1,100}$/.test(e.tool) ? e.tool : null;
  const code = typeof e.code === 'string' && /^[\w.-]{1,100}$/.test(e.code) ? e.code : null;
  const at =
    typeof e.at === 'string' &&
    Number.isFinite(Date.parse(e.at)) &&
    Date.now() - Date.parse(e.at) <= 900000 &&
    Date.now() >= Date.parse(e.at)
      ? new Date(e.at).toISOString()
      : null;
  if (!tool || !code || !at || redact(tool) !== tool || redact(code) !== code) return null;
  return {
    tool,
    code,
    httpStatus:
      Number.isInteger(e.httpStatus) && e.httpStatus >= 100 && e.httpStatus <= 599 ? e.httpStatus : null,
    at,
  };
}
function open(configFile) {
  const file = inboxPath(configFile);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS problems(id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, kind TEXT NOT NULL, count INTEGER NOT NULL, organized_through INTEGER NOT NULL DEFAULT 0, first_at TEXT NOT NULL, last_at TEXT NOT NULL, severity TEXT);
    CREATE TABLE IF NOT EXISTS occurrences(problem_id TEXT NOT NULL REFERENCES problems(id), seq INTEGER NOT NULL, message TEXT NOT NULL, version TEXT, source TEXT, caller TEXT, target TEXT, name TEXT, at TEXT NOT NULL, error TEXT, PRIMARY KEY(problem_id,seq));
    CREATE TABLE IF NOT EXISTS todos(key TEXT PRIMARY KEY, message TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS todo_problems(todo_key TEXT NOT NULL REFERENCES todos(key), problem_id TEXT NOT NULL REFERENCES problems(id), through INTEGER NOT NULL, PRIMARY KEY(todo_key,problem_id));`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function writeFeedback(input, context, configFile) {
  if (
    !input ||
    !['problem', 'friction'].includes(input.kind) ||
    (input.severity != null && !['low', 'medium', 'high'].includes(input.severity))
  )
    throw new Error('Invalid feedback input.');
  const message = clean(input.message);
  const c = context || {};
  const error = errorContext(c.error);
  const target = contextString(c.target);
  const symptom = message
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/\b(requestId|taskId)\s*[:=]\s*[^\s,;]+/gi, '$1=<id>');
  const generic = /^(?:超时|错误|失败|出错|timeout|error|failed)[.!。！ ]*$/i.test(symptom);
  const fingerprint =
    target && (!generic || error?.tool)
      ? createHash('sha256')
          .update(JSON.stringify([input.kind, target, error?.tool ?? null, error?.code ?? null, symptom]))
          .digest('hex')
      : randomUUID();
  const now = new Date().toISOString();
  const db = open(configFile);
  try {
    db.exec('BEGIN IMMEDIATE');
    let row = db.prepare('SELECT * FROM problems WHERE fingerprint=?').get(fingerprint);
    const id = row?.id ?? randomUUID();
    const seq = (row?.count ?? 0) + 1;
    if (!row)
      db.prepare(
        'INSERT INTO problems(id,fingerprint,kind,count,first_at,last_at,severity) VALUES(?,?,?,?,?,?,?)',
      ).run(id, fingerprint, input.kind, 1, now, now, input.severity ?? null);
    else {
      const rank = { low: 1, medium: 2, high: 3 };
      const severity =
        (rank[input.severity] ?? 0) > (rank[row.severity] ?? 0) ? input.severity : row.severity;
      db.prepare('UPDATE problems SET count=?,last_at=?,severity=? WHERE id=?').run(seq, now, severity, id);
    }
    db.prepare('INSERT INTO occurrences VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      id,
      seq,
      message,
      manifest.version,
      contextString(c.source),
      contextString(c.caller),
      target,
      contextString(c.name),
      now,
      error ? JSON.stringify(error) : null,
    );
    db.exec('COMMIT');
    return { saved: true, id, count: seq };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw e;
  } finally {
    db.close();
  }
}
export function pendingFeedback(configFile) {
  const db = open(configFile);
  try {
    return db
      .prepare(
        'SELECT id,kind,count,organized_through AS organizedThrough, count-organized_through AS newCount,first_at AS firstAt,last_at AS lastAt,severity FROM problems WHERE count>organized_through ORDER BY first_at',
      )
      .all()
      .map((p) => ({
        ...p,
        occurrences: db
          .prepare(
            'SELECT seq,message,version,source,caller,target,name,at,error FROM occurrences WHERE problem_id=? AND seq>? ORDER BY seq',
          )
          .all(p.id, p.organizedThrough)
          .map((o) => ({ ...o, error: o.error ? JSON.parse(o.error) : null })),
      }));
  } finally {
    db.close();
  }
}
export function organizeFeedback(configFile, { id, through, todo, message }) {
  if (typeof todo !== 'string' || redact(todo) !== todo || !/^[a-z][a-z0-9-]{0,39}$/.test(todo))
    throw new Error('Invalid todo key.');
  if (typeof id !== 'string' || !Number.isSafeInteger(through) || through < 1)
    throw new Error('Invalid organization request.');
  const summary = clean(message, 1200);
  const db = open(configFile);
  try {
    db.exec('BEGIN IMMEDIATE');
    const p = db.prepare('SELECT count,organized_through FROM problems WHERE id=?').get(id);
    if (!p || through > p.count) throw new Error('Invalid organization progress.');
    if (through <= p.organized_through) {
      db.exec('COMMIT');
      return { id, through: p.organized_through, unchanged: true };
    }
    db.prepare(
      'INSERT INTO todos VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET message=excluded.message,updated_at=excluded.updated_at',
    ).run(todo, summary, new Date().toISOString());
    db.prepare(
      'INSERT INTO todo_problems VALUES(?,?,?) ON CONFLICT(todo_key,problem_id) DO UPDATE SET through=excluded.through',
    ).run(todo, id, through);
    db.prepare('UPDATE problems SET organized_through=? WHERE id=?').run(through, id);
    db.exec('COMMIT');
    return { id, through, todo };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw e;
  } finally {
    db.close();
  }
}
export function feedbackTodos(configFile) {
  const db = open(configFile);
  try {
    return db
      .prepare('SELECT key,message,updated_at AS updatedAt FROM todos ORDER BY key')
      .all()
      .map((t) => ({
        ...t,
        problems: db
          .prepare('SELECT problem_id AS id,through FROM todo_problems WHERE todo_key=? ORDER BY problem_id')
          .all(t.key),
      }));
  } finally {
    db.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== '--write' || process.argv[3] !== '--config' || !process.argv[4])
      throw new Error('Invalid writer invocation.');
    const { input, context } = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(writeFeedback(input, context, process.argv[4])));
  } catch (e) {
    console.log(
      JSON.stringify({
        saved: false,
        code: /(?:SQLITE_BUSY|database is locked)/i.test(`${e.code} ${e.message}`)
          ? 'feedback-busy'
          : 'feedback-unavailable',
      }),
    );
  }
}
