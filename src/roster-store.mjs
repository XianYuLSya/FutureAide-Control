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
      CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, holder TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }

  owner(id) { const row = this.db.prepare('SELECT body FROM owners WHERE id=?').get(id); return row ? JSON.parse(row.body) : undefined; }
  saveOwner(owner) {
    this.db.prepare('INSERT OR IGNORE INTO owners(id,body) VALUES (?,?)').run(owner.ownerId, JSON.stringify(owner));
    const saved = this.owner(owner.ownerId);
    if (saved.threadId !== owner.threadId || saved.workspace !== owner.workspace) throw new Error('This chat is already bound to another project.');
    return saved;
  }
  get(id) { const row = this.db.prepare('SELECT body FROM agents WHERE id=?').get(id); return row ? JSON.parse(row.body) : undefined; }
  named(owner, name) { const row = this.db.prepare('SELECT body FROM agents WHERE owner=? AND name=?').get(owner, name); return row ? JSON.parse(row.body) : undefined; }
  list(owner) {
    const rows = owner === undefined
      ? this.db.prepare('SELECT body FROM agents ORDER BY name').all()
      : this.db.prepare('SELECT body FROM agents WHERE owner=? ORDER BY name').all(owner);
    return rows.map(row => JSON.parse(row.body));
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
    const result = this.db.prepare('UPDATE agents SET body=? WHERE id=? AND owner=? AND name=?')
      .run(JSON.stringify(record), record.agentId, record.ownerId, record.name);
    if (!result.changes) throw new Error('This subagent instance has already been removed.');
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
