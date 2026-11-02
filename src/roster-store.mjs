import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** One small local database serializes overlapping MCP and recovery-worker calls. */
export class RosterStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,name));
      CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, holder TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS supplements (requestId TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, session TEXT NOT NULL, task TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created TEXT NOT NULL);`);
  }

  owner(id) { const row = this.db.prepare('SELECT body FROM owners WHERE id=?').get(id); return row ? JSON.parse(row.body) : undefined; }
  saveOwner(owner) {
    this.db.prepare('INSERT OR IGNORE INTO owners(id,body) VALUES (?,?)').run(owner.ownerId, JSON.stringify(owner));
    const saved = this.owner(owner.ownerId);
    if (saved.threadId !== owner.threadId || saved.workspace !== owner.workspace) throw new Error('This chat is already bound to another project.');
    return saved;
  }
  get(id) { const row = this.db.prepare('SELECT body FROM agents WHERE id=?').get(id); return row ? JSON.parse(row.body) : undefined; }
  lease(key) { return this.db.prepare('SELECT holder,expires FROM leases WHERE key=?').get(key); }
  wake(id, taskId) {
    return this.db.prepare("UPDATE agents SET body=json_remove(body,'$.sleep') WHERE id=? AND json_extract(body,'$.sleep.taskId')=? AND json_extract(body,'$.sessionId')=json_extract(body,'$.sleep.sessionId')").run(id, taskId).changes === 1;
  }
  markWake(id, taskId) {
    return this.db.prepare("UPDATE agents SET body=json_set(body,'$.sleep.wakePending',json('true')) WHERE id=? AND json_extract(body,'$.sleep.taskId')=?").run(id, taskId).changes === 1;
  }
  sleep(record, signal) {
    return this.db.prepare(`UPDATE agents SET body=json_set(body,'$.sleep',json(?)) WHERE id=? AND owner=?
      AND json_extract(body,'$.task.taskId')=? AND json_extract(body,'$.state')=?
      AND (coalesce(json_extract(body,'$.task.cancelRequested'),0)=0 OR (json_extract(body,'$.task.cancelVerified')=1 AND json_extract(body,'$.task.cancelTreeSettled')=1))
      AND EXISTS (SELECT 1 FROM leases a JOIN leases b ON a.holder=b.holder WHERE a.key='idle-monitor' AND b.key='idle-monitor:ready' AND a.expires>? AND b.expires>?)
      AND NOT EXISTS (SELECT 1 FROM supplements WHERE agent=agents.id AND task=? AND status IN ('queued','sending','unknown'))`)
      .run(JSON.stringify({ taskId: record.task.taskId, sessionId: record.sessionId, signal }), record.agentId, record.ownerId, record.task.taskId, record.state, Date.now(), Date.now(), record.task.taskId).changes === 1;
  }
  restoreSleep(record) {
    return this.db.prepare(`UPDATE agents SET body=json_set(body,'$.sleep',json(?))
      WHERE id=? AND owner=? AND json_extract(body,'$.sessionId')=?
      AND coalesce(json_extract(body,'$.closed'),0)=0`)
      .run(JSON.stringify(record.sleep), record.agentId, record.ownerId, record.sleep.sessionId).changes === 1;
  }
  named(owner, name) { const row = this.db.prepare('SELECT body FROM agents WHERE owner=? AND name=?').get(owner, name); return row ? JSON.parse(row.body) : undefined; }
  enqueueSupplement(record, requestId, message) {
    return this.db.prepare(`INSERT INTO supplements(requestId,owner,agent,session,task,message,status,created)
      SELECT ?,id.owner,id.id,json_extract(id.body,'$.sessionId'),json_extract(id.body,'$.task.taskId'),?,'queued',?
      FROM agents AS id WHERE id.id=? AND id.owner=? AND id.name=? AND json_extract(id.body,'$.sessionId')=?
      AND json_extract(id.body,'$.task.taskId')=? AND coalesce(json_extract(id.body,'$.closed'),0)=0
      AND coalesce(json_extract(id.body,'$.task.cancelRequested'),0)=0
      AND json_extract(id.body,'$.state') IN ('running','awaiting_input','awaiting_report','reconnecting')
      AND NOT EXISTS (SELECT 1 FROM json_each(id.body,'$.task.reports') WHERE json_extract(value,'$.final')=1)`)
      .run(requestId, message, new Date().toISOString(), record.agentId, record.ownerId, record.name, record.sessionId, record.task?.taskId).changes === 1;
  }
  supplements(agentId) { return this.db.prepare("SELECT * FROM supplements WHERE agent=? AND status IN ('queued','sending','unknown','blocked') ORDER BY rowid").all(agentId); }
  setSupplement(requestId, status, reason = null) { this.db.prepare('UPDATE supplements SET status=?,reason=? WHERE requestId=?').run(status, reason, requestId); }
  blockQueued(agentId, taskId, reason) { this.db.prepare("UPDATE supplements SET status='blocked',reason=? WHERE agent=? AND task=? AND status='queued'").run(reason, agentId, taskId); }
  supplementSummary(agentId, taskId) {
    const rows = this.db.prepare('SELECT status,count(*) AS count FROM supplements WHERE agent=? AND task=? GROUP BY status').all(agentId, taskId);
    const counts = { queued: 0, unknown: 0, blocked: 0, accepted: 0 };
    for (const row of rows) counts[row.status === 'sending' ? 'unknown' : row.status] = (counts[row.status === 'sending' ? 'unknown' : row.status] ?? 0) + row.count;
    const latest = this.db.prepare('SELECT status,reason FROM supplements WHERE agent=? AND task=? ORDER BY rowid DESC LIMIT 1').get(agentId, taskId);
    return { ...counts, ...(latest ? { latest: { status: latest.status, ...(latest.reason ? { reason: latest.reason } : {}) } } : {}) };
  }
  list(owner) {
    const rows = owner === undefined
      ? this.db.prepare('SELECT body FROM agents ORDER BY name').all()
      : this.db.prepare('SELECT body FROM agents WHERE owner=? ORDER BY name').all(owner);
    return rows.map(row => JSON.parse(row.body));
  }
  count(owner) {
    return this.db.prepare(owner === undefined ? 'SELECT count(*) AS count FROM agents' : 'SELECT count(*) AS count FROM agents WHERE owner=?')
      .get(...(owner === undefined ? [] : [owner])).count;
  }
  // These projections keep periodic checks and shared-monitor scans independent
  // of task/report/history body size. Full records are loaded only for an agent
  // whose worker or delivery poll is actually about to run.
  hasSleeping() {
    return this.db.prepare("SELECT 1 AS found FROM agents WHERE json_type(body,'$.sleep')='object' LIMIT 1").get() !== undefined;
  }
  listSleeping() {
    return this.db.prepare(`SELECT id AS agentId, owner AS ownerId, json_extract(body,'$.sessionId') AS sessionId,
      json_extract(body,'$.state') AS state, json_extract(body,'$.task.taskId') AS taskId,
      json_extract(body,'$.task.cancelRequested') AS cancelRequested,
      json_extract(body,'$.task.cancelVerified') AS cancelVerified,
      json_extract(body,'$.task.cancelTreeSettled') AS cancelTreeSettled,
      json_extract(body,'$.sleep') AS sleep,
      EXISTS (SELECT 1 FROM supplements AS queued WHERE queued.agent=agents.id
        AND queued.task=json_extract(agents.body,'$.task.taskId')
        AND queued.status IN ('queued','sending','unknown')) AS hasSupplement
      FROM agents WHERE json_type(body,'$.sleep')='object' ORDER BY name`).all().map(row => ({
      agentId: row.agentId, ownerId: row.ownerId, sessionId: row.sessionId, state: row.state,
      task: row.taskId == null ? undefined : { taskId: row.taskId,
        ...(row.cancelRequested ? { cancelRequested: true } : {}),
        ...(row.cancelVerified ? { cancelVerified: true } : {}),
        ...(row.cancelTreeSettled ? { cancelTreeSettled: true } : {}) },
      sleep: JSON.parse(row.sleep), hasSupplement: Boolean(row.hasSupplement),
    }));
  }
  listPendingDeliveries() {
    return this.db.prepare(`SELECT id AS agentId, json_extract(body,'$.sleep.taskId') AS taskId,
      json_extract(body,'$.sleep.sessionId') AS sessionId
      FROM agents WHERE json_type(body,'$.sleep')='object'
        AND coalesce(json_extract(body,'$.callbackBlocked'),0)=0
        AND (EXISTS (SELECT 1 FROM json_each(agents.body,'$.task.reports') AS report
              WHERE coalesce(json_extract(report.value,'$.delivery.state'),'') NOT IN ('delivered','blocked'))
          OR EXISTS (SELECT 1 FROM json_each(agents.body,'$.observation.questions') AS question
              WHERE json_extract(question.value,'$.state')='pending'
              AND NOT EXISTS (SELECT 1 FROM json_each(agents.body,'$.task.questionNotices') AS notice
                WHERE notice.key=CAST(json_extract(question.value,'$.id') AS TEXT)
                AND json_extract(notice.value,'$.state') IN ('delivered','blocked'))))
      ORDER BY name`).all().map(row => ({ agentId: row.agentId, taskId: row.taskId, sessionId: row.sessionId }));
  }
  listWorkerCandidates() {
    return this.db.prepare(`SELECT id AS agentId, owner AS ownerId, json_extract(body,'$.sessionId') AS sessionId,
      json_extract(body,'$.state') AS state, json_extract(body,'$.callbackBlocked') AS callbackBlocked,
      json_extract(body,'$.sleep') AS sleep, json_extract(body,'$.task.taskId') AS taskId,
      (SELECT coalesce(json_group_array(coalesce(json_extract(value,'$.delivery.state'),'')),'[]')
        FROM json_each(agents.body,'$.task.reports')) AS deliveries
      FROM agents ORDER BY name`).all().map(row => ({
      agentId: row.agentId, ownerId: row.ownerId, sessionId: row.sessionId, state: row.state,
      ...(row.callbackBlocked ? { callbackBlocked: true } : {}),
      ...(row.sleep == null ? {} : { sleep: JSON.parse(row.sleep) }),
      ...(row.taskId == null ? {} : { task: { taskId: row.taskId,
        reports: JSON.parse(row.deliveries).map(delivery => ({ delivery: { state: delivery } })) } }),
    }));
  }
  insert(record) {
    try { this.db.prepare('INSERT INTO agents(id,owner,name,body) VALUES (?,?,?,?)').run(record.agentId, record.ownerId, record.name, JSON.stringify(record)); }
    catch (error) {
      if (String(error.message).includes('UNIQUE')) throw Object.assign(new Error('A subagent with this name already exists in this chat.'), { code: 'name-in-use' });
      throw error;
    }
  }
  save(record) {
    record.updatedAt = new Date().toISOString();
    // A watcher or sender can wake without the operation lock. Never restore a
    // sleep marker from an older in-memory poll after that atomic wake.
    const input = "CASE WHEN json_type(body,'$.sleep') IS NULL THEN json_remove(?1,'$.sleep') WHEN json_extract(body,'$.sleep.wakePending')=1 AND json_extract(body,'$.sleep.taskId')=json_extract(?1,'$.sleep.taskId') THEN json_set(?1,'$.sleep.wakePending',json('true')) ELSE ?1 END";
    const result = this.db.prepare(`UPDATE agents SET body=CASE
      WHEN json_extract(body,'$.task.taskId')=json_extract(${input},'$.task.taskId') AND json_extract(body,'$.task.cancelRequested')=1
      THEN json_set(${input},'$.task.cancelRequested',json('true'),'$.task.cancelAccepted',json(CASE WHEN json_extract(body,'$.task.cancelAccepted')=1 THEN 'true' ELSE 'false' END),'$.state',CASE WHEN json_extract(${input},'$.task.cancelRequested')=1 THEN json_extract(${input},'$.state') ELSE 'running' END)
      WHEN json_extract(${input},'$.state')='idle' AND json_extract(body,'$.task.taskId')=json_extract(${input},'$.task.taskId')
        AND EXISTS (SELECT 1 FROM supplements WHERE agent=agents.id AND status IN ('queued','sending','unknown'))
      THEN json_set(${input},'$.state','running') ELSE ${input} END
      WHERE id=?2 AND owner=?3 AND name=?4`)
      .run(JSON.stringify(record), record.agentId, record.ownerId, record.name);
    if (!result.changes) throw new Error('This subagent instance has already been removed.');
  }
  requestCancel(record) {
    return this.db.prepare(`UPDATE agents SET body=json_set(body,'$.task.cancelRequested',json('true'),'$.state','running')
      WHERE id=? AND owner=? AND name=? AND json_extract(body,'$.sessionId')=? AND json_extract(body,'$.task.taskId')=?
      AND coalesce(json_extract(body,'$.closed'),0)=0 AND coalesce(json_extract(body,'$.state'),'') NOT IN ('cleaning','cleanup_failed')`)
      .run(record.agentId, record.ownerId, record.name, record.sessionId, record.task?.taskId).changes === 1;
  }
  claimAutoCleanup(record) {
    return this.db.prepare(`UPDATE agents SET body=json_set(body,'$.closed',json('true'),'$.state','cleaning')
      WHERE id=? AND owner=? AND json_extract(body,'$.task.taskId')=? AND coalesce(json_extract(body,'$.task.cancelRequested'),0)=0
      AND coalesce(json_extract(body,'$.closed'),0)=0
      AND NOT EXISTS (SELECT 1 FROM supplements WHERE agent=agents.id AND task=json_extract(agents.body,'$.task.taskId') AND status IN ('queued','sending','unknown','blocked'))`)
      .run(record.agentId, record.ownerId, record.task?.taskId).changes === 1;
  }
  confirmCancel(record) {
    return this.db.prepare(`UPDATE agents SET body=json_set(body,'$.task.cancelAccepted',json('true'))
      WHERE id=? AND json_extract(body,'$.task.taskId')=? AND json_extract(body,'$.task.cancelRequested')=1`)
      .run(record.agentId, record.task?.taskId).changes === 1;
  }
  setWorker(id, pid) { this.db.prepare("UPDATE agents SET body=json_set(body,'$.workerPid',?) WHERE id=?").run(pid ?? null, id); }
  setWorkerError(id, holder, error) {
    // The launcher may have awaited spawn while another call advanced or removed
    // this record. Update only the error, and only for our still-owned lease.
    this.db.prepare(`UPDATE agents SET body=json_set(body,'$.error',json(?)) WHERE id=?
      AND EXISTS (SELECT 1 FROM leases WHERE key=? AND holder=? AND expires>?)`)
      .run(JSON.stringify(error), id, `worker:${id}`, holder, Date.now());
  }
  claimLease(key, holder, leaseMs) {
    return this.db.prepare(`INSERT INTO leases(key,holder,expires) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET holder=excluded.holder,expires=excluded.expires WHERE leases.expires<? OR leases.holder=?`)
      .run(key, holder, Date.now() + leaseMs, Date.now(), holder).changes > 0;
  }
  renewLease(key, holder, leaseMs) { return this.db.prepare('UPDATE leases SET expires=? WHERE key=? AND holder=?').run(Date.now() + leaseMs, key, holder).changes > 0; }
  releaseLease(key, holder) { this.db.prepare('DELETE FROM leases WHERE key=? AND holder=?').run(key, holder); }
  remove(record) {
    this.db.prepare('DELETE FROM supplements WHERE agent=? AND owner=?').run(record.agentId, record.ownerId);
    this.db.prepare('DELETE FROM agents WHERE id=? AND owner=?').run(record.agentId, record.ownerId);
    this.db.prepare('DELETE FROM leases WHERE key=? OR key=?').run(record.agentId, `worker:${record.agentId}`);
    // Secure-delete overwrites freed database cells; checkpoint removes old WAL copies.
    const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint?.busy) {
      this.insert({ agentId: record.agentId, ownerId: record.ownerId, name: record.name, lifetime: record.lifetime,
        workspace: record.workspace, sessionId: record.sessionId, state: 'cleanup_failed', nativeDestroyed: true,
        updatedAt: new Date().toISOString(), error: 'Database cleanup is waiting for another reader. Delete this name again to finish.' });
      throw new Error('The session was removed; local database cleanup is still pending.');
    }
  }

  async locked(key, action, { waitMs = 10000, leaseMs = 60000 } = {}) {
    const holder = `${process.pid}:${randomUUID()}`;
    const deadline = Date.now() + waitMs;
    while (true) {
      const now = Date.now();
      const result = this.db.prepare(`INSERT INTO leases(key,holder,expires) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET holder=excluded.holder,expires=excluded.expires WHERE leases.expires<?`)
        .run(key, holder, now + leaseMs, now);
      if (result.changes) break;
      if (Date.now() >= deadline) throw Object.assign(new Error('This subagent is processing another operation. Try again shortly.'), { code: 'agent-busy' });
      await pause(40);
    }
    const heartbeat = setInterval(() => {
      this.db.prepare('UPDATE leases SET expires=? WHERE key=? AND holder=?').run(Date.now() + leaseMs, key, holder);
    }, Math.floor(leaseMs / 3));
    heartbeat.unref();
    try { return await action(); }
    finally {
      clearInterval(heartbeat);
      this.db.prepare('DELETE FROM leases WHERE key=? AND holder=?').run(key, holder);
    }
  }
  close() { this.db.close(); }
}
