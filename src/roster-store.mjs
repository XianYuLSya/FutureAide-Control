import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** The id a stored ask or report carries once it is a question or report of its task. */
export const submissionRef = id => `submission:${id}`;
/** The notice a stored ask or report carries; the same id every round has used. */
export const submissionNoticeId = id => `notice-${id}`;
/**
 * One predicate for a parent message this roster still owes a delivery. `state` stays
 * the absorb progress (pending → consumed), so a consumed row whose notice never landed
 * is still debt, and a row from before the notice column has NULL there and counts as
 * not yet delivered.
 */
const submissionDebtSql = (table = 'submissions') => `(${table}.state='pending'
  OR coalesce(json_extract(${table}.delivery,'$.state'),'pending') NOT IN ('delivered','blocked'))`;
export const isCancelledRound = record => record?.task?.cancelRequested === true
  || record?.task?.state === 'cancelled' || record?.state === 'cancelled';

const submissionFromRow = row => ({ id: row.id, ownerId: row.owner, agentId: row.agent, taskId: row.task,
  kind: row.kind, message: row.message, final: row.final === 1, created: row.created,
  // A row from before the notice column reads as a notice that has not been sent yet: its
  // identity is the one every round uses. A caller that writes it back still fences on the
  // null text it actually read.
  delivery: row.delivery ? JSON.parse(row.delivery)
    : { id: submissionNoticeId(row.id), state: 'pending', createdAt: row.created } });

// A final report seals its task, so a helper may not submit one while a question it
// asked is still open: the parent has not answered, or the answer was accepted but has
// not been written into the helper's conversation yet. DSH enforces this in its own
// host; Codex Desktop and the Claude CLI share this entry. Each text is the tool result
// the helper reads, so it says what to do next.
const QUESTION_UNANSWERED = 'Your parent has not answered your question yet, so this final report was not accepted and the task stays open. '
  + 'Finish whatever does not depend on the answer, then end this turn without a final report; a progress report (final omitted) is still accepted. '
  + 'The answer arrives in this conversation as a new message. Submit the final report after you have read it.';
const ANSWER_UNDELIVERED = 'Your parent has answered your question and the answer is on its way into this conversation as a message beginning "Parent answer:", so this final report was not accepted. '
  + 'Read that answer and apply it before you submit the final report. If it has not appeared yet, end this turn without a final report; it arrives as the next message.';

/** One small local database serializes overlapping MCP and recovery-worker calls. */
export class RosterStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    // Canonical absolute location. Its hash is this roster's identity — a public
    // name for the database, never a credential.
    this.location = filename === ':memory:' ? ':memory:' : path.resolve(filename);
    this.db = new DatabaseSync(filename);
    // WAL with synchronous=NORMAL: a commit no longer flushes the disk; the WAL is
    // synced at each checkpoint. The roster stays consistent after a crash, and a
    // power loss can only roll back the last commits, which the next poll redoes.
    // FULL flushed on every lease take and release, dozens of times a second.
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,name));
      CREATE INDEX IF NOT EXISTS agents_parent ON agents(json_extract(body,'$.parentAgentId'),name);
      -- Child discovery only needs the identity and recency; the full child record
      -- comes from the per-record cache unless another connection changed it.
      CREATE INDEX IF NOT EXISTS agents_parent_v2 ON agents(
        json_extract(body,'$.parentAgentId'),name,json_extract(body,'$.updatedAt'));
      CREATE INDEX IF NOT EXISTS agents_lifecycle ON agents(
        json_extract(body,'$.sessionId'),json_extract(body,'$.state'),json_extract(body,'$.closed'),
        json_extract(body,'$.callbackBlocked'),json_extract(body,'$.sleep'),json_extract(body,'$.task.taskId'),
        json_extract(body,'$.task.reports'),json_extract(body,'$.task.cancelRequested'),
        json_extract(body,'$.task.cancelVerified'),json_extract(body,'$.task.cancelTreeSettled'),id,owner,name);
      -- The monitor needs the record's own retry time without opening its body.
      -- A separate expression index lets an unchanged deployment add the column in
      -- place; old builds keep using agents_lifecycle and simply ignore this one.
      CREATE INDEX IF NOT EXISTS agents_lifecycle_v2 ON agents(
        json_extract(body,'$.sessionId'),json_extract(body,'$.state'),json_extract(body,'$.closed'),
        json_extract(body,'$.callbackBlocked'),json_extract(body,'$.sleep'),json_extract(body,'$.task.taskId'),
        json_extract(body,'$.task.reports'),json_extract(body,'$.task.cancelRequested'),
        json_extract(body,'$.task.cancelVerified'),json_extract(body,'$.task.cancelTreeSettled'),
        json_extract(body,'$.nextAttemptAt'),id,owner,name);
      -- Finding a Codex child by its thread filters on target; without an index that
      -- reads every body. One small value, maintained on write.
      CREATE INDEX IF NOT EXISTS agents_target ON agents(json_extract(body,'$.target'));
      CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, holder TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS supplements (requestId TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, session TEXT NOT NULL, task TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created TEXT NOT NULL, selection TEXT);
      CREATE TABLE IF NOT EXISTS backend_state (agent TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL,
        task TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, final INTEGER NOT NULL,
        created TEXT NOT NULL, state TEXT NOT NULL, consumed TEXT, delivery TEXT);
      CREATE INDEX IF NOT EXISTS submissions_pending ON submissions(agent,task) WHERE state='pending';
      CREATE TABLE IF NOT EXISTS agent_history (agent TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (agent, seq)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // Single-connection caches. They only ever skip work whose result is already
    // known here; every entry is dropped by any write this connection makes to the
    // same row, and projections are keyed by PRAGMA data_version so a commit from
    // the Codex side (which can hold this roster open at the same time) invalidates
    // them. A fresh process starts with empty caches, so the first save of a record
    // is always a real write.
    this.bodies = new Map();
    this.projections = new Map();
    this.scans = new Map();
    this.woken = new Set();
    this.settled = 0;
    // Rows this connection changed in tables no agent body or sweep reads (leases,
    // submissions). The body cache and the sweep ignore them; see agentChanges().
    this.quiet = 0;
    this.addTextColumn('supplements', 'selection');
    // A roster from an older build carries neither column. Both are plain data, and NULL
    // keeps its rows valid: a row with no notice yet counts as not delivered.
    this.addTextColumn('submissions', 'consumed');
    this.addTextColumn('submissions', 'delivery');
    // Only now can the debt index name the notice column. A roster from an older build
    // gains that column on the line above; a new one created it with the table.
    this.db.exec(`CREATE INDEX IF NOT EXISTS submissions_debt ON submissions(agent, task)
      WHERE state='pending' OR coalesce(json_extract(delivery,'$.state'),'pending') NOT IN ('delivered','blocked')`);
    this.migrateHistory();
  }

  /**
   * Add optional data to an existing roster. NULL keeps old queue rows valid.
   * A submission needs its own delivery state only when its task no longer owns it.
   */
  addTextColumn(table, column) {
    const exists = () => this.db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get(table, column);
    // New rosters already have the column; keep that path free of a write lock.
    if (exists()) return;
    // Claude's worker and a Codex stdio server can open the same roster at once.
    // Both may see the old table; serialize the recheck and ALTER, and recheck
    // inside the lock so the loser does not hit "duplicate column name".
    this.db.exec('PRAGMA busy_timeout=30000');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!exists()) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA busy_timeout=5000');
    }
  }

  /**
   * Task history used to ride inside the agent body, where every poll rewrite also
   * rewrote it: 32MB of a 54MB roster, ~60% of each save. It moves to its own table
   * and the body keeps an empty array, so a build from before this change still
   * opens the migrated roster and simply sees no earlier tasks.
   *
   * Idempotent: the marker is written in the same transaction as the move, so an
   * interrupted run rolls back whole and a finished run never repeats. Rolling back
   * means restoring the array into each body and deleting the marker row.
   */
  migrateHistory() {
    const done = this.db.prepare("SELECT value FROM schema_meta WHERE key='agent-history-table-v1'").get();
    if (done) return;
    // A deployment migration can find another process holding the write lock; it
    // gets 30 seconds instead of the 5 a normal statement waits, and the old limit is
    // restored whatever happens. A migration that still cannot run throws: this store
    // must never serve a body whose history was left behind.
    this.db.exec('PRAGMA busy_timeout=30000');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`SELECT id, json_extract(body,'$.history') AS body FROM agents
        WHERE json_type(json_extract(body,'$.history'))='array'`).all();
      const insert = this.db.prepare('INSERT OR IGNORE INTO agent_history(agent,seq,body) VALUES (?,?,?)');
      const clear = this.db.prepare("UPDATE agents SET body=json_set(body,'$.history',json('[]')) WHERE id=?");
      for (const row of rows) {
        const items = JSON.parse(row.body ?? '[]');
        if (!Array.isArray(items) || !items.length) continue;
        items.forEach((item, index) => insert.run(row.id, index, JSON.stringify(item)));
        clear.run(row.id);
        this.bodies.delete(row.id);
      }
      this.db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('agent-history-table-v1',?)")
        .run(new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA busy_timeout=5000');
    }
  }

  owner(id) { const row = this.db.prepare('SELECT body FROM owners WHERE id=?').get(id); return row ? JSON.parse(row.body) : undefined; }
  saveOwner(owner) {
    this.db.prepare('INSERT OR IGNORE INTO owners(id,body) VALUES (?,?)').run(owner.ownerId, JSON.stringify(owner));
    const saved = this.owner(owner.ownerId);
    // Both sources bind one owner to one chat/session and one project.
    const sameCaller = (saved.threadId ?? null) === (owner.threadId ?? null)
      && (saved.nativeSessionId ?? null) === (owner.nativeSessionId ?? null);
    if (!sameCaller || saved.workspace !== owner.workspace) throw new Error('This chat is already bound to another project.');
    return saved;
  }
  /** A restarted session keeps its owner; only the way to reach it moves. */
  rebindOwner(id, binding) {
    this.db.prepare("UPDATE owners SET body=json_set(body,'$.pid',?,'$.binding',json(?)) WHERE id=?").run(binding.pid, JSON.stringify(binding), id);
  }
  get(id) {
    const version = this.dataVersion();
    const changed = this.agentChanges();
    const cached = this.bodies.get(id);
    // A poll reads the same row several times (parent, delivery, tree and public
    // result). Reuse its exact text until another connection commits, this store
    // touches the row, or a statement bypasses save() on this connection. Lease and
    // submission writes do not count: a poll takes and releases a lease every time.
    if (cached?.version === version && cached.changed === changed) return JSON.parse(cached.text);
    const row = this.db.prepare('SELECT body FROM agents WHERE id=?').get(id);
    if (!row) { this.bodies.delete(id); return undefined; }
    const record = JSON.parse(row.body);
    // Remember the exact text, with its recency stamp neutralised, so save() can tell
    // an unchanged record from a changed one without a second trip through SQLite and
    // without a second serialisation.
    this.bodies.set(id, { text: row.body, version, changed });
    return record;
  }
  /** Earlier tasks of one name, oldest first. Never part of the body any more. */
  historyFor(agentId, { limit = 0, offset = 0 } = {}) {
    const rows = limit > 0
      ? this.db.prepare('SELECT body FROM agent_history WHERE agent=? ORDER BY seq DESC LIMIT ? OFFSET ?').all(agentId, limit, offset).reverse()
      : this.db.prepare('SELECT body FROM agent_history WHERE agent=? ORDER BY seq').all(agentId);
    return rows.map(row => JSON.parse(row.body));
  }
  historyCount(agentId) {
    return this.db.prepare('SELECT count(*) AS count FROM agent_history WHERE agent=?').get(agentId).count;
  }
  /** Append-only: an earlier task is never rewritten by a later poll. */
  appendHistory(agentId, item) {
    const row = this.db.prepare('SELECT coalesce(max(seq),-1)+1 AS seq FROM agent_history WHERE agent=?').get(agentId);
    this.db.prepare('INSERT INTO agent_history(agent,seq,body) VALUES (?,?,?)').run(agentId, row.seq, JSON.stringify(item));
    return row.seq;
  }
  /** A callback can commit without the name lock. Check its inbox in the same
   * write transaction that archives the old task and publishes its successor. */
  replaceTask(record, previous, snapshot) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ready = this.db.prepare(`SELECT 1 FROM agents WHERE id=? AND owner=? AND name=?
        AND coalesce(json_extract(body,'$.closed'),0)=0
        AND json_extract(body,'$.task.taskId') IS ? AND json_extract(body,'$.state')=?
        AND NOT EXISTS (SELECT 1 FROM submissions WHERE agent=agents.id
          AND task=json_extract(agents.body,'$.task.taskId') AND ${submissionDebtSql()})`)
        .get(record.agentId, record.ownerId, record.name, previous.task?.taskId ?? null, previous.state);
      if (ready) {
        if (snapshot) this.appendHistory(record.agentId, snapshot);
        this.save(record);
      }
      this.db.exec('COMMIT');
      return Boolean(ready);
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.touched(record.agentId);
      throw error;
    }
  }
  leaseHeld(key, holder) { const lease = this.lease(key); return lease && lease.holder === holder && lease.expires > Date.now(); }
  /**
   * A projection query is only recomputed when the roster could have moved: another
   * connection committed (PRAGMA data_version) or this database was written by
   * something other than this store (SQLite total_changes moved past the writes we
   * know about). Any write of our own to agents, supplements or backend_state drops
   * every projection instead: a cache that cannot prove it is current must not
   * decide whether a report still has to be polled or delivered.
   */
  changed() { return this.db.prepare('SELECT total_changes() AS changed').get().changed; }
  /**
   * total_changes() without the quiet writes settle() accounted for. Any other write
   * on this connection, including one that bypassed the store, still moves it.
   */
  agentChanges() { return this.changed() - this.quiet; }
  /**
   * Our own write that cannot change any projection (leases, submissions): the
   * caches stay valid and simply start from the new change counter.
   */
  settle(rows = 0) {
    // Only the rows this write changed are accounted for. Pushing the counter to the
    // current total would swallow a write that bypassed the store in the meantime,
    // and a projection would then look current while it is stale.
    this.settled += Math.max(0, Number(rows) || 0);
    this.quiet += Math.max(0, Number(rows) || 0);
    for (const cached of this.projections.values()) cached.settled = this.settled;
    return this.settled;
  }
  /**
   * The team board in one read. Each open name contributes only the fields the board
   * shows, extracted by SQL from its record, its owner, its first task and its Codex
   * thread binding: a whole record body never enters this process. The result is a
   * projection, so it is rebuilt only when the roster actually moved — the board's
   * 36-hour window is applied by the caller, never by this query, so old rows cannot
   * invalidate the cache on every request.
   */
  boardSnapshot() {
    return this.projection('board', () => this.db.prepare(`
      SELECT a.id AS id, a.owner AS owner, a.name AS name,
        json_extract(a.body,'$.updatedAt') AS updatedAt,
        json_extract(a.body,'$.state') AS state,
        json_extract(a.body,'$.target') AS target,
        json_extract(a.body,'$.parentAgentId') AS parent,
        json_extract(a.body,'$.releaseState.state') AS release,
        json_extract(a.body,'$.observation.activity') AS activity,
        json_extract(a.body,'$.task.message') AS task,
        json_extract(a.body,'$.task.modelSelection.model') AS taskModel,
        json_extract(a.body,'$.task.modelSelection.effort') AS taskEffort,
        json_extract(a.body,'$.modelSelection.model') AS selectionModel,
        json_extract(a.body,'$.modelSelection.effort') AS selectionEffort,
        (SELECT count(*) FROM json_each(json_extract(a.body,'$.observation.questions'))
          WHERE json_extract(value,'$.state')='pending') AS pendingQuestions,
        CASE WHEN json_type(json_extract(a.body,'$.observation.tree.nodes'))='array'
          THEN (SELECT count(*) FROM json_each(json_extract(a.body,'$.observation.tree.nodes'))) ELSE 0 END AS treeNodes,
        CASE WHEN json_type(json_extract(a.body,'$.task.result.changes'))='array'
          THEN (SELECT count(*) FROM json_each(json_extract(a.body,'$.task.result.changes'))) ELSE NULL END AS fileCount,
        (SELECT json_extract(j.value,'$.final') FROM json_each(json_extract(a.body,'$.task.reports')) j
          WHERE json_extract(j.value,'$.failure') IS NULL ORDER BY CAST(j.key AS INTEGER) DESC LIMIT 1) AS reportFinal,
        (SELECT json_extract(j.value,'$.message') FROM json_each(json_extract(a.body,'$.task.reports')) j
          WHERE json_extract(j.value,'$.failure') IS NULL ORDER BY CAST(j.key AS INTEGER) DESC LIMIT 1) AS reportSummary,
        (SELECT json_extract(j.value,'$.delivery.state') FROM json_each(json_extract(a.body,'$.task.reports')) j
          WHERE json_extract(j.value,'$.failure') IS NULL ORDER BY CAST(j.key AS INTEGER) DESC LIMIT 1) AS reportDelivery,
        (SELECT json_extract(h.body,'$.message') FROM agent_history h WHERE h.agent=a.id ORDER BY h.seq LIMIT 1) AS firstTaskMessage,
        json_extract(o.body,'$.source') AS ownerSource,
        json_extract(o.body,'$.workspace') AS ownerWorkspace,
        json_extract(o.body,'$.binding.workspace') AS ownerBindingWorkspace,
        json_extract(o.body,'$.nativeSessionId') AS ownerNativeSessionId,
        json_extract(o.body,'$.threadId') AS ownerThread,
        json_extract(s.body,'$.binding.sessionId') AS thread
      FROM agents a
      LEFT JOIN owners o ON o.id = a.owner
      LEFT JOIN backend_state s ON s.agent = a.id
      WHERE coalesce(json_extract(a.body,'$.closed'),0)=0`).all());
  }
  projection(key, build) {
    const version = this.dataVersion();
    const changed = this.changed();
    let cached = this.projections.get(key);
    if (!cached || cached.version !== version || cached.settled !== changed) {
      // The rebuild read the whole table, so every change counted here is seen. Other
      // keys keep their own stamp: rebuilding one key must never vouch for another.
      cached = { version, settled: changed, rows: build() };
      this.projections.set(key, cached);
      this.settled = changed;
    }
    return cached.rows;
  }
  /**
   * A roster sweep is intentionally a few seconds stale. It may not be rebuilt on
   * every small field write (an active poll changes state/error continuously), but
   * an external commit still invalidates it through PRAGMA data_version.
   */
  scanProjection(key, build, ttlMs = 5000) {
    const version = this.dataVersion();
    const changed = this.agentChanges();
    const at = Date.now();
    const cached = this.scans.get(key);
    if (!cached || cached.version !== version || cached.changed !== changed || at - cached.at > ttlMs) {
      const rows = build();
      this.scans.set(key, { version, changed, at, rows });
      return rows;
    }
    return cached.rows;
  }
  /** A saved record updates its cached sweep row without another table scan. */
  syncCandidate(record) {
    const cached = this.scans.get('candidates');
    if (!cached || !Array.isArray(cached.rows)) return;
    const reports = (record.task?.reports ?? []).map(report => ({ delivery: {
      state: report.delivery?.state ?? '',
      ...(report.delivery?.nextAttemptAt ? { nextAttemptAt: report.delivery.nextAttemptAt } : {}),
      ...(report.delivery?.waitingForTree ? { waitingForTree: true } : {}) } }));
    const pendingReports = reports.filter(report => !['delivered', 'blocked'].includes(report.delivery.state));
    // Same rule as the roster sweep: a final waiting for its tree is settled by the sweep
    // reading that tree, so the cached row must not defer the name either.
    const waitingForTree = pendingReports.some(report => report.delivery.waitingForTree === true);
    const previous = cached.rows.find(row => row.agentId === record.agentId);
    const row = {
      agentId: record.agentId, ownerId: record.ownerId, sessionId: record.sessionId, state: record.state,
      ...(record.closed ? { closed: true } : {}),
      ...(record.callbackBlocked ? { callbackBlocked: true } : {}),
      ...(record.sleep == null ? {} : { sleep: structuredClone(record.sleep) }),
      ...(record.nextAttemptAt == null ? {} : { nextAttemptAt: record.nextAttemptAt }),
      ...(pendingReports.length && !waitingForTree ? { noticeNextAt: pendingReports.reduce((min, report) =>
        Math.min(min, report.delivery.nextAttemptAt ?? 0), Infinity) } : {}),
      hasSupplement: previous?.hasSupplement ?? false,
      pendingReports: pendingReports.length,
      ...(record.task?.taskId == null ? {} : { task: { taskId: record.task.taskId, reports,
        ...(record.task.cancelRequested ? { cancelRequested: true } : {}),
        ...(record.task.cancelVerified ? { cancelVerified: true } : {}),
        ...(record.task.cancelTreeSettled ? { cancelTreeSettled: true } : {}) } }),
    };
    const index = cached.rows.findIndex(item => item.agentId === record.agentId);
    if (index >= 0) cached.rows[index] = row; else cached.rows.push(row);
    cached.changed = this.agentChanges();
  }
  dropProjections() { this.projections.clear(); this.settled = this.changed(); }
  /** A row changed outside save(): forget whatever we cached about this name. */
  touched(agentId) { if (agentId) this.bodies.delete(agentId); this.dropProjections(); this.scans.clear(); }
  lease(key) { return this.db.prepare('SELECT holder,expires FROM leases WHERE key=?').get(key); }
  /**
   * The same rows as lease(), for several keys, in one statement: one consistent view of
   * a set of leases that only make sense together. Reading them one by one would let a
   * second connection commit between two reads, and a caller that then compares holders
   * or releases rows would be acting on a set that never existed.
   */
  leases(keys) {
    const list = [...new Set(Array.isArray(keys) ? keys : [])].filter(key => typeof key === 'string');
    if (!list.length) return new Map();
    const rows = this.db.prepare(`SELECT key,holder,expires FROM leases WHERE key IN (${list.map(() => '?').join(',')})`)
      .all(...list);
    return new Map(rows.map(row => [row.key, { holder: row.holder, expires: row.expires }]));
  }
  wake(id, taskId) {
    const changed = this.db.prepare("UPDATE agents SET body=json_remove(body,'$.sleep') WHERE id=? AND json_extract(body,'$.sleep.taskId')=? AND json_extract(body,'$.sessionId')=json_extract(body,'$.sleep.sessionId')").run(id, taskId).changes === 1;
    if (changed) { this.woken.add(id); this.touched(id); }
    return changed;
  }
  markWake(id, taskId) {
    const changed = this.db.prepare("UPDATE agents SET body=json_set(body,'$.sleep.wakePending',json('true')) WHERE id=? AND json_extract(body,'$.sleep.taskId')=?").run(id, taskId).changes === 1;
    if (changed) this.touched(id);
    return changed;
  }
  sleep(record, signal) {
    const taskId = record.task.taskId;
    const changed = this.db.prepare(`UPDATE agents SET body=json_set(body,'$.sleep',json(?)) WHERE id=? AND owner=?
      AND json_extract(body,'$.task.taskId')=? AND json_extract(body,'$.state')=?
      AND (coalesce(json_extract(body,'$.task.cancelRequested'),0)=0 OR (json_extract(body,'$.task.cancelVerified')=1 AND json_extract(body,'$.task.cancelTreeSettled')=1))
      AND EXISTS (SELECT 1 FROM leases a JOIN leases b ON a.holder=b.holder WHERE a.key='idle-monitor' AND b.key='idle-monitor:ready' AND a.expires>? AND b.expires>?)
      AND NOT EXISTS (SELECT 1 FROM supplements WHERE agent=agents.id AND task=? AND status IN ('queued','sending','unknown'))
      AND NOT EXISTS (SELECT 1 FROM submissions WHERE agent=agents.id AND task=? AND state='pending')`)
      .run(JSON.stringify({ taskId, sessionId: record.sessionId, signal }), record.agentId, record.ownerId, taskId,
        record.state, Date.now(), Date.now(), taskId, taskId).changes === 1;
    if (changed) { this.woken.delete(record.agentId); this.touched(record.agentId); }
    return changed;
  }
  restoreSleep(record) {
    const changed = this.db.prepare(`UPDATE agents SET body=json_set(body,'$.sleep',json(?))
      WHERE id=? AND owner=? AND json_extract(body,'$.sessionId')=?
      AND coalesce(json_extract(body,'$.closed'),0)=0`)
      .run(JSON.stringify(record.sleep), record.agentId, record.ownerId, record.sleep.sessionId).changes === 1;
    if (changed) { this.woken.delete(record.agentId); this.touched(record.agentId); }
    return changed;
  }
  named(owner, name) { const row = this.db.prepare('SELECT body FROM agents WHERE owner=? AND name=?').get(owner, name); return row ? JSON.parse(row.body) : undefined; }
  /**
   * Queue one supplement together with the model selection it was accepted with.
   * `selection` is frozen on the row; `usePinnedModel` copies the live pin from the
   * agent row in the same INSERT SELECT, so a supplement accepted without a new
   * model always freezes exactly what the name had at that moment. `saveRecord`
   * commits this record (for example a new explicit pin) in the same transaction:
   * a caller holding the name lock gets an all-or-nothing queue write, and the
   * worker is only woken after both the supplement and the pin are durable.
   */
  enqueueSupplement(record, requestId, message, selection = undefined, { usePinnedModel = false, saveRecord = false } = {}) {
    const body = selection === undefined ? null : JSON.stringify(selection);
    const insert = () => this.db.prepare(`INSERT INTO supplements(requestId,owner,agent,session,task,message,status,created,selection)
      SELECT ?,id.owner,id.id,json_extract(id.body,'$.sessionId'),json_extract(id.body,'$.task.taskId'),?,'queued',?,
        CASE WHEN ?=1 THEN json_extract(id.body,'$.modelPin') ELSE ? END
      FROM agents AS id WHERE id.id=? AND id.owner=? AND id.name=? AND json_extract(id.body,'$.sessionId')=?
      AND json_extract(id.body,'$.task.taskId')=? AND coalesce(json_extract(id.body,'$.closed'),0)=0
      AND coalesce(json_extract(id.body,'$.task.cancelRequested'),0)=0
      AND json_extract(id.body,'$.state') IN ('running','awaiting_input','awaiting_report','reconnecting')
      AND NOT EXISTS (SELECT 1 FROM json_each(id.body,'$.task.reports') WHERE json_extract(value,'$.final')=1)`)
      .run(requestId, message, new Date().toISOString(), usePinnedModel ? 1 : 0, body,
        record.agentId, record.ownerId, record.name, record.sessionId, record.task?.taskId).changes === 1;
    if (!saveRecord) {
      const changed = insert();
      this.dropProjections();
      return changed;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.save(record);
      const changed = insert();
      if (!changed) {
        this.db.exec('ROLLBACK');
        this.bodies.delete(record.agentId);
        this.dropProjections();
        return false;
      }
      this.db.exec('COMMIT');
      this.dropProjections();
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.bodies.delete(record.agentId);
      this.dropProjections();
      throw error;
    }
  }
  supplements(agentId) {
    return this.db.prepare("SELECT * FROM supplements WHERE agent=? AND status IN ('queued','sending','unknown','blocked') ORDER BY rowid")
      .all(agentId).map(row => ({
        ...row,
        selection: row.selection ? JSON.parse(row.selection) : undefined,
      }));
  }
  supplement(requestId) {
    return typeof requestId === 'string'
      ? this.db.prepare('SELECT requestId, agent, task, status, created FROM supplements WHERE requestId=?').get(requestId)
      : undefined;
  }
  setSupplement(requestId, status, reason = null) { this.db.prepare('UPDATE supplements SET status=?,reason=? WHERE requestId=?').run(status, reason, requestId); this.dropProjections(); }
  blockQueued(agentId, taskId, reason) { this.db.prepare("UPDATE supplements SET status='blocked',reason=? WHERE agent=? AND task=? AND status='queued'").run(reason, agentId, taskId); this.dropProjections(); }
  supplementSummary(agentId, taskId) {
    const rows = this.db.prepare('SELECT status,count(*) AS count FROM supplements WHERE agent=? AND task=? GROUP BY status').all(agentId, taskId);
    const counts = { queued: 0, unknown: 0, blocked: 0, accepted: 0 };
    for (const row of rows) counts[row.status === 'sending' ? 'unknown' : row.status] = (counts[row.status === 'sending' ? 'unknown' : row.status] ?? 0) + row.count;
    const latest = this.db.prepare('SELECT status,reason FROM supplements WHERE agent=? AND task=? ORDER BY rowid DESC LIMIT 1').get(agentId, taskId);
    return { ...counts, ...(latest ? { latest: { status: latest.status, ...(latest.reason ? { reason: latest.reason } : {}) } } : {}) };
  }
  // The executing target's own state (native binding, transcript cursor,
  // incremental projection, native write attempts) lives in its own row beside
  // the roster. It must not ride in the agent record: the shared state machine
  // keeps saving records it loaded earlier, and such a save would overwrite an
  // adapter's fresh write. This is state, not a second task or notice machine:
  // dispatch intent, delivery and cleanup stay in the shared tables above.
  backendState(agentId) {
    const row = this.db.prepare('SELECT body FROM backend_state WHERE agent=?').get(agentId);
    return row ? JSON.parse(row.body) : undefined;
  }
  /** Upsert one target-state document. False means the name is already gone. */
  saveBackendState(agentId, value, { keepRelease = false } = {}) {
    // A Codex document that was read before another connection wrote must not carry an
    // older copy of the field that connection replaced. The release attempt is the one
    // such field, so it is merged inside the statement, from the row as it is now, and
    // the caller's copy of it is dropped before the write. Every other target keeps the
    // plain upsert below: this option exists for the one backend that has that field.
    if (keepRelease) {
      const incoming = JSON.stringify(value);
      const body = "CASE WHEN json_type(body,'$.release')='object' "
        + "THEN json_set(json_remove(?1,'$.release'),'$.release',json_extract(body,'$.release')) "
        + "ELSE json_remove(?1,'$.release') END";
      const changed = this.db.prepare(`UPDATE backend_state SET body=${body} WHERE agent=?2 AND body IS NOT ${body}`)
        .run(incoming, agentId).changes === 1;
      if (changed) { this.dropProjections(); return true; }
      const inserted = this.db.prepare(`INSERT INTO backend_state(agent,body)
        SELECT id,json_remove(?1,'$.release') FROM agents WHERE id=?2
        ON CONFLICT(agent) DO NOTHING`).run(incoming, agentId).changes === 1;
      if (inserted) { this.dropProjections(); return true; }
      return this.db.prepare('SELECT 1 AS found FROM agents WHERE id=?').get(agentId) !== undefined;
    }
    // An identical document is not rewritten. A Codex poll saves its state on every
    // refresh, and rewriting an unchanged 100+ KB row (zero-filling the old pages under
    // secure_delete) was most of the monitor's disk writes.
    const changed = this.db.prepare(`INSERT INTO backend_state(agent,body) SELECT id,? FROM agents WHERE id=?
      ON CONFLICT(agent) DO UPDATE SET body=excluded.body WHERE backend_state.body IS NOT excluded.body`)
      .run(JSON.stringify(value), agentId).changes === 1;
    if (changed) { this.dropProjections(); return true; }
    // Nothing written: either the document was identical, or the name is gone.
    return this.db.prepare('SELECT 1 AS found FROM agents WHERE id=?').get(agentId) !== undefined;
  }

  /**
   * Write only the target's release attempt, atomically against the name as it is now.
   * The fence is the shared layer's own ticket on the agent row: a newer re-check
   * replaces it, so an older attempt cannot write even though its own document still
   * names it. A caller that only knows the round — a dispatch that restored its own
   * subscription — fences on the task alone.
   * @param {string} agentId Managed name.
   * @param {object} release Release document to store.
   * @param {{taskId?: string, ticket?: string}} fence Round, and the attempt when known.
   * @returns {boolean} True when it was written.
   */
  saveBackendRelease(agentId, release, { taskId, ticket } = {}) {
    if (typeof taskId !== 'string' || !taskId) return false;
    const attempt = typeof ticket === 'string' && ticket;
    const statement = `UPDATE backend_state SET body=json_set(body,'$.release',json(?1))
      WHERE agent=?2 AND json_extract((SELECT body FROM agents WHERE id=?2),'$.task.taskId')=?3`
      + (attempt ? " AND json_extract((SELECT body FROM agents WHERE id=?2),'$.releaseState.ticket')=?4" : '');
    const parameters = attempt ? [JSON.stringify(release), agentId, taskId, attempt]
      : [JSON.stringify(release), agentId, taskId];
    const changed = this.db.prepare(statement).run(...parameters).changes === 1;
    if (changed) this.dropProjections();
    return changed;
  }
  deleteBackendState(agentId) { this.db.prepare('DELETE FROM backend_state WHERE agent=?').run(agentId); this.dropProjections(); }
  /**
   * The same reverse lookup for a Codex Desktop child: its own chat id is the
   * binding its backend records, and only a live codex-desktop name qualifies.
   */
  agentForCodexThread(threadId, { includeAutoClosed = false } = {}) {
    if (typeof threadId !== 'string' || !threadId) return undefined;
    const wanted = threadId.toLowerCase();
    const row = this.db.prepare(`SELECT a.id AS agentId, a.owner AS ownerId, a.name AS name,
      json_extract(a.body,'$.target') AS target, json_extract(a.body,'$.state') AS state,
      json_extract(a.body,'$.sessionId') AS logicalSessionId, b.body AS body
      FROM backend_state AS b JOIN agents AS a ON a.id=b.agent
      WHERE json_extract(a.body,'$.target')='codex-desktop'
        AND (coalesce(json_extract(a.body,'$.closed'),0)=0
          ${includeAutoClosed ? "OR coalesce(json_extract(a.body,'$.autoCleanupClosed'),0)=1" : ''})`).all()
      .find(candidate => {
        const binding = JSON.parse(candidate.body)?.binding ?? {};
        return [binding.threadId, binding.sessionId, binding.nativeSessionId]
          .filter(value => typeof value === 'string')
          .some(value => value.toLowerCase() === wanted);
      });
    if (!row) return undefined;
    return { agentId: row.agentId, ownerId: row.ownerId, name: row.name, target: row.target,
      state: row.state, logicalSessionId: row.logicalSessionId, binding: JSON.parse(row.body).binding ?? null };
  }
  /**
   * Direct children of a managed record, whatever owner they belong to: a name
   * created from inside another managed session is its child even though that
   * session has its own owner id.
   */
  childrenOf(agentId) {
    if (typeof agentId !== 'string' || !agentId) return [];
    return this.db.prepare(`SELECT id FROM agents INDEXED BY agents_parent_v2
      WHERE json_extract(body,'$.parentAgentId')=? ORDER BY name`).all(agentId)
      .map(row => this.get(row.id)).filter(Boolean);
  }
  /** Whole descendant closure beneath these records, breadth first. */
  descendantsOf(agentIds) {
    const seen = new Set(agentIds);
    const found = [];
    let frontier = [...agentIds];
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        for (const child of this.childrenOf(id)) {
          if (seen.has(child.agentId)) continue;
          seen.add(child.agentId); found.push(child); next.push(child.agentId);
        }
      }
      frontier = next;
    }
    return found;
  }
  /** All managed records, optionally scoped to one owner. */
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
  // The covering expression index stores these fields at write time. Selecting
  // json_extract alone still reparses every large body unless the scan uses it;
  // SQLite maintains it even when another/older connection updates the roster.
  hasSleeping() { return this.listSleeping().length > 0; }
  listSleeping() {
    // Derived from the same cached sweep: one index scan serves sleeping checks,
    // idle-monitor scans and the monitor's own candidate list.
    return this.listWorkerCandidates().filter(row => row.sleep).map(row => ({
      agentId: row.agentId, ownerId: row.ownerId, sessionId: row.sessionId, state: row.state,
      task: row.task, sleep: row.sleep, hasSupplement: row.hasSupplement,
    }));
  }
  /**
   * Hash -> agentId for every name. The managed host writes one state file per name,
   * named sha256(owner + newline + agent), so a file event names exactly one record to
   * poll instead of the whole roster. Only id and owner are selected, never the body:
   * a closed name is kept in the map because a hint for it costs one rejected poll,
   * while filtering it would read every body on every rebuild.
   */
  wakeIndex() {
    return this.projection('wake-index', () => {
      const index = new Map();
      for (const row of this.db.prepare('SELECT id, owner FROM agents').all()) {
        index.set(createHash('sha256').update(`${row.owner}\n${row.id}`).digest('hex'), row.id);
      }
      return index;
    });
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
    return this.scanProjection('candidates', () => {
      // Everything selected here comes from the covering expression index. Two extra
      // correlated subqueries would each read the whole body again for every name, so
      // the supplement flag is a second small query and the report count is folded in
      // from the reports column the scan already has.
      const supplements = new Set(this.db.prepare("SELECT agent, task FROM supplements WHERE status IN ('queued','sending','unknown')")
        .all().map(row => `${row.agent}\n${row.task}`));
      return this.db.prepare(`SELECT id AS agentId, owner AS ownerId, json_extract(body,'$.sessionId') AS sessionId,
        json_extract(body,'$.state') AS state, json_extract(body,'$.closed') AS closed, json_extract(body,'$.callbackBlocked') AS callbackBlocked,
        json_extract(body,'$.sleep') AS sleep, json_extract(body,'$.task.taskId') AS taskId,
        json_extract(body,'$.task.reports') AS reports, json_extract(body,'$.nextAttemptAt') AS nextAttemptAt,
        json_extract(body,'$.task.cancelRequested') AS cancelRequested,
        json_extract(body,'$.task.cancelVerified') AS cancelVerified,
        json_extract(body,'$.task.cancelTreeSettled') AS cancelTreeSettled
        FROM agents INDEXED BY agents_lifecycle_v2
        WHERE id NOT IN (SELECT id FROM agents WHERE json_extract(body,'$.target')='claude-desktop') ORDER BY name`).all().map(row => {
        const reports = (JSON.parse(row.reports ?? '[]') ?? [])
          .map(report => ({ delivery: { state: report.delivery?.state ?? '',
            ...(report.delivery?.nextAttemptAt ? { nextAttemptAt: report.delivery.nextAttemptAt } : {}),
            ...(report.delivery?.waitingForTree ? { waitingForTree: true } : {}) } }));
        const pendingReports = reports.filter(report => !['delivered', 'blocked'].includes(report.delivery.state));
        // A final still waiting for its tree is settled by the ordinary sweep reading that
        // tree, so any such notice makes this name due at once: dropping only its own
        // moment would let another notice's backoff hold the whole observation back.
        const waitingForTree = pendingReports.some(report => report.delivery.waitingForTree === true);
        return {
          agentId: row.agentId, ownerId: row.ownerId, sessionId: row.sessionId, state: row.state,
          ...(row.closed ? { closed: true } : {}),
          ...(row.callbackBlocked ? { callbackBlocked: true } : {}),
          ...(row.sleep == null ? {} : { sleep: JSON.parse(row.sleep) }),
          ...(row.nextAttemptAt == null ? {} : { nextAttemptAt: row.nextAttemptAt }),
          ...(pendingReports.length && !waitingForTree ? { noticeNextAt: pendingReports.reduce((min, report) =>
            Math.min(min, report.delivery.nextAttemptAt ?? 0), Infinity) } : {}),          hasSupplement: supplements.has(`${row.agentId}\n${row.taskId}`),
          pendingReports: pendingReports.length,
          ...(row.taskId == null ? {} : { task: { taskId: row.taskId, reports,
            ...(row.cancelRequested ? { cancelRequested: true } : {}),
            ...(row.cancelVerified ? { cancelVerified: true } : {}),
            ...(row.cancelTreeSettled ? { cancelTreeSettled: true } : {}) } }),
        };
      });
    });
  }
  /**
   * Insert one record. With `requireOpenParent` a child is only written while the parent
   * it names still exists and is open — one statement, so a create that read the parent
   * before an automatic cleanup closed the tree cannot slip a new child in afterwards.
   */
  insert(record, { requireOpenParent = false } = {}) {
    const parentId = record.parentAgentId;
    try {
      if (requireOpenParent && typeof parentId === 'string' && parentId) {
        const inserted = this.db.prepare(`INSERT INTO agents(id,owner,name,body)
          SELECT ?1,?2,?3,?4 FROM agents AS parent
          WHERE parent.id=?5 AND coalesce(json_extract(parent.body,'$.closed'),0)=0`)
          .run(record.agentId, record.ownerId, record.name, JSON.stringify(record), parentId).changes === 1;
        if (!inserted) {
          const parent = this.db.prepare('SELECT 1 AS found FROM agents WHERE id=?').get(parentId);
          throw parent
            ? Object.assign(new Error('The parent session is closed, so this subagent was not created.'), { code: 'parent-closed' })
            : Object.assign(new Error('The parent session no longer exists, so this subagent was not created.'), { code: 'parent-missing' });
        }
      } else this.db.prepare('INSERT INTO agents(id,owner,name,body) VALUES (?,?,?,?)')
        .run(record.agentId, record.ownerId, record.name, JSON.stringify(record));
    } catch (error) {
      if (error.code === 'parent-closed' || error.code === 'parent-missing') throw error;
      if (String(error.message).includes('UNIQUE')) throw Object.assign(new Error('A subagent with this name already exists in this chat.'), { code: 'name-in-use' });
      throw error;
    }
    this.touched(record.agentId);
  }
  /**
   * WAL-aware commit counter for this connection. It changes when another
   * connection commits, and does not change for this connection's own writes, so
   * a listener can tell an external change from the echo of its own poll.
   */
  dataVersion() {
    const row = this.db.prepare('PRAGMA data_version').get();
    return row?.data_version ?? row?.DATA_VERSION;
  }
  /**
   * Stable identity of this roster: sha256 of the canonical absolute database
   * path (case-normalized on Windows). It answers "which database is this service
   * serving" without carrying a credential, so a listener for another roster can
   * never be mistaken for ours.
   */
  identity() {
    const location = this.location === ':memory:'
      ? ':memory:'
      : (process.platform === 'win32' ? this.location.toLowerCase() : this.location);
    return createHash('sha256').update(location).digest('hex');
  }
  /** Does this exact name still own its row? A skip must not hide a removal. */
  stillPresent(record) {
    return this.db.prepare('SELECT 1 AS found FROM agents WHERE id=? AND owner=? AND name=?')
      .get(record.agentId, record.ownerId, record.name) !== undefined;
  }
  save(record, { dispatch = false } = {}) {
    // Nothing durable changed: this record still serialises to exactly the body we
    // read or wrote last, so this save would rewrite megabytes for nothing. The
    // statement below parses the body once per json() argument and rebuilds the
    // expression index, which is the single largest cost of a quiet round.
    const cached = this.bodies.get(record.agentId);
    const candidate = JSON.stringify(record);
    if (!dispatch && cached !== undefined && cached.text === candidate && this.stillPresent(record)) return true;
    record.updatedAt = new Date().toISOString();
    if (this.woken.has(record.agentId)) delete record.sleep;
    // A plain second serialisation: a body can carry a nested updatedAt of its own, and
    // matching the recency stamp as text is not worth the risk of writing the wrong
    // one. Real writes are rare; quiet rounds never reach this line.
    const body = JSON.stringify(record);
    // A watcher or sender can wake without the operation lock. Never restore a
    // sleep marker from an older in-memory poll after that atomic wake.
    const sleeping = "CASE WHEN json_type(body,'$.sleep') IS NULL THEN json_remove(?1,'$.sleep') WHEN json_extract(body,'$.sleep.wakePending')=1 AND json_extract(body,'$.sleep.taskId')=json_extract(?1,'$.sleep.taskId') THEN json_set(?1,'$.sleep.wakePending',json('true')) ELSE ?1 END";
    // Children can finish while their parent holds an older in-memory view.
    // Preserve the atomic handoff for this task when that parent next saves.
    const input = `CASE WHEN json_extract(body,'$.task.taskId')=json_extract(?1,'$.task.taskId') AND json_type(body,'$.task.childSnapshots')='array' THEN json_set(${sleeping},'$.task.childSnapshots',json_extract(body,'$.task.childSnapshots')) ELSE ${sleeping} END`;
    // Everything this connection keeps from the row as it is now: a wake that arrived
    // without the lock, the child snapshot handoff, the cancel evidence and the supplement
    // wake. This is the inner merge; the outer CASE adds one guarantee on top of it.
    const merged = `CASE
      WHEN json_extract(body,'$.state')='cleaning' AND coalesce(json_extract(${input},'$.state'),'') NOT IN ('cleaning','cleanup_failed')
      THEN json_set(${input},'$.state','cleaning','$.closed',json('true'))
      WHEN json_extract(body,'$.task.taskId')=json_extract(${input},'$.task.taskId') AND json_extract(body,'$.task.cancelRequested')=1
      THEN json_set(${input},'$.task.cancelRequested',json('true'),'$.task.cancelAccepted',json(CASE WHEN json_extract(body,'$.task.cancelAccepted')=1 THEN 'true' ELSE 'false' END),'$.task.cancelPending',json(CASE WHEN json_extract(body,'$.task.cancelPending')=1 THEN 'true' ELSE 'false' END),'$.state',CASE WHEN json_extract(${input},'$.task.cancelRequested')=1 THEN json_extract(${input},'$.state') WHEN coalesce(json_extract(${input},'$.task.treeUnavailable'),'')='codex-thread-not-found' THEN 'failed' ELSE 'running' END)
      WHEN json_extract(${input},'$.state')='idle' AND json_extract(body,'$.task.taskId')=json_extract(${input},'$.task.taskId')
        AND EXISTS (SELECT 1 FROM supplements WHERE agent=agents.id AND status IN ('queued','sending','unknown'))
      THEN json_set(${input},'$.state','running')
      ELSE ${input} END`;
    // The commit counter is read before the write. Read after it, a commit another
    // process lands between this UPDATE and that read would be stamped onto the body
    // returned here, and the next get() would serve that body as current.
    const version = this.dataVersion();
    // A row an automatic claim closed stays closed, and keeps the mark that says why,
    // whichever branch above matched and whether or not the caller's copy still knew:
    // the closure is restored from the row, never from the copy.
    // Dispatch preparation and receipts can outlive the name's lease. Check the
    // task and its terminal state in the same write that merges the record.
    const fence = dispatch ? `
      AND json_extract(body,'$.task.taskId')=?5
      AND coalesce(json_extract(body,'$.closed'),0)=0
      AND coalesce(json_extract(body,'$.state'),'') NOT IN ('failed','cancelled','completed')
      AND coalesce(json_extract(body,'$.task.state'),'') NOT IN ('failed','cancelled','completed')
      AND coalesce(json_extract(body,'$.task.treeUnavailable'),'')<>'codex-thread-not-found'
      AND json_type(body,'$.task.legacyAutomaticResult') IS NULL` : '';
    const result = this.db.prepare(`UPDATE agents SET body=CASE
      WHEN coalesce(json_extract(body,'$.autoCleanupClosed'),0)=1
      THEN json_set(${merged},'$.closed',json('true'),'$.autoCleanupClosed',json('true'))
      ELSE ${merged} END
      WHERE id=?2 AND owner=?3 AND name=?4 ${fence} RETURNING body`)
      .get(body, record.agentId, record.ownerId, record.name, ...(dispatch ? [record.task?.taskId ?? null] : []));
    if (dispatch && !result) return false;
    if (!result) throw new Error('This subagent instance has already been removed.');
    this.woken.delete(record.agentId);
    // The SQL may deliberately preserve an atomic wake or child snapshot that the
    // in-memory record did not have; RETURNING gives us that actual body so the next
    // read is a cache hit, not another trip through SQLite.
    this.bodies.set(record.agentId, { text: result.body, version, changed: this.agentChanges() });
    this.syncCandidate(record);
    this.dropProjections();
    return true;
  }
  requestCancel(record) {
    const changed = this.db.prepare(`UPDATE agents SET body=json_remove(json_set(body,'$.task.cancelRequested',json('true'),'$.task.cancelPending',json('true'),'$.task.cancelTreeSettled',json('false'),'$.state','running'),'$.nextAttemptAt')
      WHERE id=? AND owner=? AND name=? AND json_extract(body,'$.sessionId')=? AND json_extract(body,'$.task.taskId')=?
      AND coalesce(json_extract(body,'$.closed'),0)=0 AND coalesce(json_extract(body,'$.state'),'') NOT IN ('cleaning','cleanup_failed')
      -- A round whose thread cannot be found was already marked failed: cancelling it
      -- would only pull it back to running for a tree no read can confirm.
      AND NOT (json_extract(body,'$.state')='failed'
        AND coalesce(json_extract(body,'$.task.treeUnavailable'),'')='codex-thread-not-found')`)
      .run(record.agentId, record.ownerId, record.name, record.sessionId, record.task?.taskId).changes === 1;
    if (changed) this.touched(record.agentId);
    return changed;
  }
  requestCleanup(record) {
    const changed = this.db.prepare(`UPDATE agents SET body=json_remove(json_set(body,'$.state','cleaning','$.closed',json('true')),'$.sleep','$.error','$.nextAttemptAt')
      WHERE id=? AND owner=? AND json_extract(body,'$.sessionId')=?`)
      .run(record.agentId, record.ownerId, record.sessionId).changes === 1;
    if (changed) this.touched(record.agentId);
    return changed;
  }
  /**
   * What this whole tree — the name and every descendant, read from the roster itself —
   * still owes before an automatic cleanup may delete it. `pending` is the one debt
   * predicate every inbox reader uses; `blocked` counts notices whose text can never be
   * sent again and is therefore the only copy left.
   * @param {string} agentId Root of the tree.
   * @returns {{pending: number, blocked: number}} Counts across the tree.
   */
  autoCleanupHold(agentId) {
    if (typeof agentId !== 'string' || !agentId) return { pending: 0, blocked: 0 };
    const row = this.db.prepare(`WITH RECURSIVE tree(id) AS (
        SELECT id FROM agents WHERE id=?1
        UNION
        SELECT child.id FROM agents AS child JOIN tree ON json_extract(child.body,'$.parentAgentId')=tree.id
      )
      SELECT coalesce(sum(CASE WHEN ${submissionDebtSql('s')} THEN 1 ELSE 0 END),0) AS pending,
        coalesce(sum(CASE WHEN json_extract(s.delivery,'$.state')='blocked' THEN 1 ELSE 0 END),0) AS blocked
      FROM tree JOIN submissions AS s ON s.agent=tree.id`).get(agentId);
    // A supplement of any round in this tree is the caller's own text: queued ones are still
    // owed, a blocked one (expired, cancelled, final-submitted) is the only copy left.
    const supplements = this.db.prepare(`WITH RECURSIVE tree(id) AS (
        SELECT id FROM agents WHERE id=?1
        UNION
        SELECT child.id FROM agents AS child JOIN tree ON json_extract(child.body,'$.parentAgentId')=tree.id
      )
      SELECT coalesce(sum(CASE WHEN sup.status IN ('queued','sending','unknown') THEN 1 ELSE 0 END),0) AS pending,
        coalesce(sum(CASE WHEN sup.status='blocked' THEN 1 ELSE 0 END),0) AS blocked
      FROM tree JOIN supplements AS sup ON sup.agent=tree.id`).get(agentId);
    const expired = this.db.prepare(`WITH RECURSIVE tree(id) AS (
        SELECT id FROM agents WHERE id=?1
        UNION
        SELECT child.id FROM agents AS child JOIN tree ON json_extract(child.body,'$.parentAgentId')=tree.id
      )
      SELECT count(*) AS blocked FROM tree JOIN agents ON agents.id=tree.id
      WHERE json_extract(agents.body,'$.expired.retainBody')=1`).get(agentId);
    return { pending: (row?.pending ?? 0) + (supplements?.pending ?? 0),
      blocked: (row?.blocked ?? 0) + (supplements?.blocked ?? 0) + (expired?.blocked ?? 0) };
  }
  claimAutoCleanup(record) {
    // One transaction for the check and the claim: a child that accepts a message while
    // this runs either lands before the hold (and blocks the delete) or after the tree is
    // closed (and is refused). The root keeps its own cancel and supplement gates.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const hold = this.autoCleanupHold(record.agentId);
      if (hold.pending > 0 || hold.blocked > 0) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const changed = this.db.prepare(`UPDATE agents SET body=json_set(body,'$.closed',json('true'),'$.state','cleaning','$.autoCleanupClosed',json('true'))
        WHERE id=? AND owner=? AND json_extract(body,'$.task.taskId')=? AND coalesce(json_extract(body,'$.task.cancelRequested'),0)=0
        AND coalesce(json_extract(body,'$.closed'),0)=0
        AND NOT EXISTS (SELECT 1 FROM supplements WHERE agent=agents.id AND task=json_extract(agents.body,'$.task.taskId') AND status IN ('queued','sending','unknown','blocked'))`)
        .run(record.agentId, record.ownerId, record.task?.taskId).changes === 1;
      if (changed) {
        // Close the rest of the tree so no child can accept a new message while the
        // cleanup walks it. Each child keeps its own state: it is still cleaned up by its
        // own turn, never in parallel as a second cleanup.
        this.db.prepare(`WITH RECURSIVE tree(id) AS (
            SELECT id FROM agents WHERE id=?1
            UNION
            SELECT child.id FROM agents AS child JOIN tree ON json_extract(child.body,'$.parentAgentId')=tree.id
          )
          UPDATE agents SET body=json_set(body,'$.closed',json('true'),'$.autoCleanupClosed',json('true'))
          WHERE id IN (SELECT id FROM tree WHERE id<>?1)`).run(record.agentId);
      }
      this.db.exec('COMMIT');
      if (changed) this.touched(record.agentId);
      return changed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.touched(record.agentId);
      throw error;
    }
  }
  confirmCancel(record, result = {}) {
    const changed = this.db.prepare(`UPDATE agents SET body=json_set(body,'$.task.cancelAccepted',json('true'),'$.task.cancelPending',json(?))
      WHERE id=? AND json_extract(body,'$.task.taskId')=? AND json_extract(body,'$.task.cancelRequested')=1`)
      .run(result.cancelPending === true ? 'true' : 'false', record.agentId, record.task?.taskId).changes === 1;
    if (changed) this.touched(record.agentId);
    return changed;
  }
  // Update only the error, and never overwrite a different error that a later
  // attempt already recorded, so a delayed spawn failure cannot mask new state.
  setError(id, error) {
    const body = JSON.stringify(error);
    const changed = this.db.prepare(`UPDATE agents SET body=json_set(body,'$.error',json(?)) WHERE id=?
      AND (json_type(body,'$.error') IS NULL OR json_extract(body,'$.error.code')=json_extract(?,'$.code'))`)
      .run(body, id, body).changes === 1;
    if (changed) this.touched(id);
  }
  claimLease(key, holder, leaseMs) {
    const result = this.db.prepare(`INSERT INTO leases(key,holder,expires) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET holder=excluded.holder,expires=excluded.expires WHERE leases.expires<? OR leases.holder=?`)
      .run(key, holder, Date.now() + leaseMs, Date.now(), holder);
    this.settle(result.changes);
    return Number(result.changes) > 0;
  }
  /** Replace an auxiliary lease only while the expected owner still holds its lease. */
  claimLeaseWhileHeld(key, holder, leaseMs, ownerKey, ownerHolder) {
    const now = Date.now();
    const result = this.db.prepare(`INSERT INTO leases(key,holder,expires)
      SELECT ?,?,? FROM leases WHERE key=? AND holder=? AND expires>?
      ON CONFLICT(key) DO UPDATE SET holder=excluded.holder,expires=excluded.expires`)
      .run(key, holder, now + leaseMs, ownerKey, ownerHolder, now);
    this.settle(result.changes);
    return Number(result.changes) > 0;
  }
  renewLease(key, holder, leaseMs) {
    const result = this.db.prepare('UPDATE leases SET expires=? WHERE key=? AND holder=?').run(Date.now() + leaseMs, key, holder);
    this.settle(result.changes);
    return Number(result.changes) > 0;
  }
  releaseLease(key, holder) {
    this.settle(this.db.prepare('DELETE FROM leases WHERE key=? AND holder=?').run(key, holder).changes);
  }
  /**
   * Raw submissions an explicit Codex ask_parent/report_parent left behind. They
   * are consumed by the same scoped state machine during a poll — this table is a
   * durable inbox, not a second task or notice machine, and ordinary final text
   * from a native turn is never recorded here.
   */
  enqueueSubmission({ id, ownerId, agentId, taskId, kind, message, final = false, created = new Date().toISOString() }) {
    if (!['ask', 'report'].includes(kind)) throw new Error('A submission must be an ask or a report.');
    // The notice is created with the row: an accepted message owes a delivery from the
    // moment it exists, so no reader has to invent its identity for it later.
    const notice = JSON.stringify({ id: submissionNoticeId(id), state: 'pending', createdAt: created });
    const queued = this.db.prepare(`INSERT OR IGNORE INTO submissions(id,owner,agent,task,kind,message,final,created,state,delivery)
      VALUES (?,?,?,?,?,?,?,?,'pending',?)`)
      .run(id, ownerId, agentId, taskId, kind, message, final ? 1 : 0, created, notice).changes === 1;
    this.settle(queued ? 1 : 0);
    return queued;
  }
  pendingSubmissions(agentId, taskId) {
    if (taskId !== undefined) return this.submissions(agentId, taskId, true);
    return this.db.prepare(`SELECT id, owner, agent, task, kind, message, final, created, delivery
      FROM submissions WHERE agent=? AND state='pending' AND coalesce(json_extract(delivery,'$.nextAttemptAt'),0)<=?
      ORDER BY created, rowid`).all(agentId, Date.now()).map(submissionFromRow);
  }
  /** Is a final for this round already stored and not yet finished delivering? */
  hasFinalNotice(agentId, taskId) {
    if (typeof agentId !== 'string' || !agentId || typeof taskId !== 'string' || !taskId) return false;
    const row = this.db.prepare(`SELECT 1 AS found FROM submissions
      WHERE agent=?1 AND task=?2 AND final=1 AND ${submissionDebtSql('submissions')} LIMIT 1`).get(agentId, taskId);
    return Boolean(row);
  }
  pendingSubmissionAgents() {
    // Earliest notice a name still owes, for whatever round wrote it. A notice of an older
    // round that is waiting for its tree is due at once: that round is over, so an ordinary
    // send may take it now instead of the tree's own six-hour expiry.
    return this.db.prepare(`SELECT s.agent AS agentId,
        min(CASE WHEN s.task<>json_extract(a.body,'$.task.taskId')
              AND json_extract(s.delivery,'$.waitingForTree')=1 THEN 0
            ELSE coalesce(json_extract(s.delivery,'$.nextAttemptAt'),0) END) AS dueAt
      FROM submissions AS s JOIN agents AS a ON a.id=s.agent AND a.owner=s.owner
      WHERE ${submissionDebtSql('s')} AND coalesce(json_extract(a.body,'$.closed'),0)=0
      GROUP BY s.agent`).all();
  }
  /**
   * Every parent message this roster still owes a delivery, in the order it was written.
   * `deliveryVersion` is the raw notice text as stored — null for a row from before the
   * notice column — and is what a caller hands back to take the next step for it.
   */
  submissionWork(agentId, taskId) {
    if (typeof agentId !== 'string' || !agentId) return [];
    const scoped = taskId !== undefined;
    return this.db.prepare(`SELECT id, owner, agent, task, kind, message, final, created, state, delivery
      FROM submissions WHERE agent=? ${scoped ? 'AND task=?' : ''} AND ${submissionDebtSql()}
      ORDER BY created, rowid`).all(...(scoped ? [agentId, taskId] : [agentId]))
      .map(row => ({ ...submissionFromRow(row), state: row.state, deliveryVersion: row.delivery ?? null }));
  }
  /** How many parent messages this name still owes a delivery, optionally for one round. */
  submissionDebt(agentId, taskId) {
    if (typeof agentId !== 'string' || !agentId) return 0;
    const scoped = taskId !== undefined;
    return this.db.prepare(`SELECT count(*) AS count FROM submissions WHERE agent=? ${scoped ? 'AND task=?' : ''}
      AND ${submissionDebtSql()}`).get(...(scoped ? [agentId, taskId] : [agentId])).count;
  }
  /** The archived round a notice still belongs to, when this roster kept it. */
  historyTask(agentId, taskId) {
    if (typeof agentId !== 'string' || !agentId || typeof taskId !== 'string' || !taskId) return undefined;
    // Archiving and the next round's save used to be two transactions, so one task can
    // have more than one snapshot: the newest one is the one that was live longest.
    const row = this.db.prepare(`SELECT body FROM agent_history WHERE agent=? AND json_extract(body,'$.taskId')=?
      ORDER BY seq DESC LIMIT 1`).get(agentId, taskId);
    return row ? JSON.parse(row.body) : undefined;
  }
  /**
   * Record the next step of one message's notice. `expected` is the raw notice text the
   * caller read (null for a row from before the column): the update lands only while the
   * row still holds exactly that, so two connections cannot both claim this notice. A
   * terminal notice is consumed by the same statement and never walked back to a
   * non-terminal one; a legacy row that is already terminal is consumed with its
   * identity normalized and its final state kept. With `record`, the caller's mirror of
   * the name is saved in the same transaction.
   * @returns {boolean} True when this call wrote the notice.
   */
  saveSubmissionDelivery(id, notice, { expected, record } = {}) {
    if (typeof id !== 'string' || !id || !notice || typeof notice !== 'object') return false;
    const shaped = { ...notice, id: typeof notice.id === 'string' && notice.id ? notice.id : submissionNoticeId(id) };
    const terminal = ['delivered', 'blocked'].includes(shaped.state);
    const parameters = [JSON.stringify(shaped)];
    let assignments = 'delivery=?';
    if (terminal) {
      assignments = "delivery=?, state='consumed', consumed=coalesce(consumed, ?)";
      parameters.push(new Date().toISOString());
    }
    parameters.push(id);
    let where = 'id=?';
    if (terminal) {
      // A legacy row — absorb progress still pending — may be finalized here, which is
      // what normalizes its identity, and two proofs may correct blocked to delivered. A
      // row that already recorded a terminal outcome is never rewritten.
      where += " AND (state='pending' OR coalesce(json_extract(delivery,'$.state'),'') NOT IN ('delivered','blocked'))";
    } else where += " AND coalesce(json_extract(delivery,'$.state'),'') NOT IN ('delivered','blocked')";
    if (expected === null) where += ' AND delivery IS NULL';
    else if (expected !== undefined) { where += ' AND delivery=?'; parameters.push(expected); }
    const write = () => {
      const written = this.db.prepare(`UPDATE submissions SET ${assignments} WHERE ${where}`).run(...parameters).changes === 1;
      this.settle(written ? 1 : 0);
      return written;
    };
    if (!record) return write();
    this.db.exec('PRAGMA busy_timeout=30000');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const written = write();
      // The caller's mirror is current only while the row still holds the same task: a
      // worker that was replaced must not write its stale copy over the newer one.
      if (written && this.stillSameTask(record)) this.save(record);
      this.db.exec('COMMIT');
      return written;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally { this.db.exec('PRAGMA busy_timeout=5000'); }
  }
  /** Does the row still hold the exact task this record mirrors? */
  stillSameTask(record) {
    return this.db.prepare(`SELECT 1 AS current FROM agents WHERE id=? AND owner=? AND name=?
      AND json_extract(body,'$.task.taskId') IS ?`)
      .get(record.agentId, record.ownerId, record.name, record.task?.taskId ?? null) !== undefined;
  }
  /** Bind a callback to the current task before the shared monitor delivers it. */
  submitParentMessage(agentId, { kind, message, final = false }, cliDispatch) {
    if (typeof message !== 'string' || !message.trim() || message.length > 100000) {
      throw Object.assign(new Error('A nonblank message of at most 100000 characters is required.'), { code: 'invalid-message' });
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const record = agentId && this.get(agentId);
      const task = record?.task;
      if (!task || record.closed || (cliDispatch && (record.target !== 'claude-cli'
          || task.taskId !== cliDispatch.taskId
          || task.dispatches?.at(-1)?.requestId !== cliDispatch.requestId))) {
        throw Object.assign(new Error('This caller has no active managed task for this dispatch.'), { code: 'submission-not-owned' });
      }
      // Callback correctness applies independently of the session cleanup switch.
      if (isCancelledRound(record)) {
        throw Object.assign(new Error('The task was cancelled. Questions and reports are closed for this round.'), { code: 'task-cancelled' });
      }
      if (cliDispatch && ['idle', 'failed'].includes(record.state)) {
        throw Object.assign(new Error('This caller has no active managed task for this dispatch.'), { code: 'submission-not-owned' });
      }
      if (task.reports?.some(report => report.final) || this.submissions(agentId, task.taskId).some(report => report.final)) {
        throw Object.assign(new Error('This task already submitted its final report.'), { code: 'final-already-submitted' });
      }
      if (kind === 'report' && final) {
        const open = this.openQuestions(record);
        if (open.unanswered) throw Object.assign(new Error(QUESTION_UNANSWERED), { code: 'question-unanswered' });
        if (open.undelivered) throw Object.assign(new Error(ANSWER_UNDELIVERED), { code: 'answer-undelivered' });
      }
      const id = 'submission-' + randomUUID().replaceAll('-', '');
      this.enqueueSubmission({ id, ownerId: record.ownerId, agentId, taskId: task.taskId, kind, message, final });
      if (record.sleep) this.wake(agentId, task.taskId);
      this.db.exec('COMMIT');
      return { accepted: true, name: record.name, taskId: task.taskId, submissionId: id, kind };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /**
   * Questions of the current task whose answer has not reached the helper that asked:
   * `unanswered` have no answer yet, `undelivered` have one that is still on its way
   * into the helper's conversation.
   */
  openQuestions(record) {
    const task = record?.task;
    if (!task) return { unanswered: 0, undelivered: 0 };
    const asked = this.submissions(record.agentId, task.taskId).filter(item => item.kind === 'ask')
      .map(item => submissionRef(item.id));
    const answered = new Set((task.answers ?? []).flatMap(answer => answer.questionIds ?? []));
    // An accepted dispatch delivered its answer. One whose write outcome is unknown is
    // never sent again, so it is not on its way either: its error stays on the name, and
    // waiting for it would hold the task open for ever.
    const settled = new Set((task.dispatches ?? [])
      .filter(dispatch => dispatch.kind === 'answer' && (dispatch.accepted === true || dispatch.state === 'unknown'))
      .flatMap(dispatch => dispatch.answerIds ?? []));
    return { unanswered: asked.filter(id => !answered.has(id)).length,
      undelivered: asked.filter(id => answered.has(id) && !settled.has(id)).length };
  }
  submissions(agentId, taskId, pendingOnly = false) {
    return this.db.prepare(`SELECT id, owner, agent, task, kind, message, final, created, delivery FROM submissions
      WHERE agent=? AND task=? ${pendingOnly ? "AND state='pending'" : ''} ORDER BY created`)
      .all(agentId, taskId).map(submissionFromRow);
  }
  saveAndConsumeSubmissions(record, ids) {
    // A deployment migration can find another process holding the write lock; it
    // gets 30 seconds instead of the 5 a normal statement waits, and the old limit is
    // restored whatever happens. A migration that still cannot run throws: this store
    // must never serve a body whose history was left behind.
    this.db.exec('PRAGMA busy_timeout=30000');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.save(record);
      for (const id of ids) this.consumeSubmission(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveChildSnapshot(parentId, taskId, snapshot) {
    // A deployment migration can find another process holding the write lock; it
    // gets 30 seconds instead of the 5 a normal statement waits, and the old limit is
    // restored whatever happens. A migration that still cannot run throws: this store
    // must never serve a body whose history was left behind.
    this.db.exec('PRAGMA busy_timeout=30000');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const parent = this.get(parentId);
      if (parent?.task?.taskId === taskId) {
        const snapshots = [...(parent.task.childSnapshots ?? []).filter(item => item.agentId !== snapshot.agentId), snapshot];
        this.db.prepare("UPDATE agents SET body=json_set(body,'$.task.childSnapshots',json(?)) WHERE id=?")
          .run(JSON.stringify(snapshots), parentId);
      }
      this.db.exec('COMMIT');
      this.bodies.delete(parentId);
      this.dropProjections();
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Consume once: false means another poll already took it. */
  consumeSubmission(id) {
    const consumed = this.db.prepare(`UPDATE submissions SET state='consumed', consumed=? WHERE id=? AND state='pending'`)
      .run(new Date().toISOString(), id).changes === 1;
    this.settle(consumed ? 1 : 0);
    return consumed;
  }
  remove(record) {
    this.db.prepare('DELETE FROM supplements WHERE agent=? AND owner=?').run(record.agentId, record.ownerId);
    this.db.prepare('DELETE FROM backend_state WHERE agent=?').run(record.agentId);
    this.db.prepare('DELETE FROM submissions WHERE agent=?').run(record.agentId);
    // Task history lives in its own table now: deleting the name has to delete what
    // the tasks said, and it has to happen before the checkpoint below, so the freed
    // cells are overwritten by secure_delete and the old WAL copies are truncated.
    this.db.prepare('DELETE FROM agent_history WHERE agent=?').run(record.agentId);
    this.db.prepare('DELETE FROM agents WHERE id=? AND owner=?').run(record.agentId, record.ownerId);
    // The per-target host lock is shared with other names and is left to its holder.
    this.db.prepare('DELETE FROM leases WHERE key=? OR key=?').run(record.agentId, `worker:${record.agentId}`);
    // Secure-delete overwrites freed database cells; checkpoint removes old WAL copies.
    const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    this.touched(record.agentId);
    if (checkpoint?.busy) {
      // The name comes back only as a marker telling the caller to delete again. Its
      // history is deliberately not restored: the delete has already erased it, and a
      // tombstone must not resurrect the task text this call was asked to remove.
      this.insert({ agentId: record.agentId, ownerId: record.ownerId, name: record.name, lifetime: record.lifetime,
        ...(record.target ? { target: record.target } : {}),
        workspace: record.workspace, sessionId: record.sessionId, state: 'cleanup_failed', nativeDestroyed: true, history: [],
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
      this.settle(result.changes);
      if (result.changes) break;
      if (Date.now() >= deadline) throw Object.assign(new Error('This subagent is processing another operation. Try again shortly.'), { code: 'agent-busy' });
      await pause(40);
    }
    const heartbeat = setInterval(() => {
      const beat = this.db.prepare('UPDATE leases SET expires=? WHERE key=? AND holder=?').run(Date.now() + leaseMs, key, holder);
      this.settle(beat.changes);
    }, Math.floor(leaseMs / 3));
    heartbeat.unref();
    try { return await action(); }
    finally {
      clearInterval(heartbeat);
      this.settle(this.db.prepare('DELETE FROM leases WHERE key=? AND holder=?').run(key, holder).changes);
    }
  }
  close() { this.db.close(); }
}
