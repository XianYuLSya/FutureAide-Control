import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const required = ['agents', 'owners'];
const sources = ['agents', 'owners', 'backend_state', 'submissions', 'supplements', 'agent_history'];

function rows(db, table) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) {
    if (required.includes(table)) throw new Error(`missing table: ${table}`);
    return [];
  }
  return db.prepare(`SELECT * FROM ${table}`).all();
}

// Called inside a read transaction or BEGIN IMMEDIATE; the exact serialized rows
// are used so no accepted write can be hidden by a lossy projection.
export function rosterTreeFromSnapshot(data, rootId) {
  const agents = data.agents;
  const root = agents.find(row => row.id === rootId);
  if (!root) throw new Error('tree-root-missing');
  const parents = new Map(agents.map(row => [row.id, JSON.parse(row.body).parentAgentId]));
  const ids = new Set([rootId]);
  let changed;
  do {
    changed = false;
    for (const row of agents) if (!ids.has(row.id) && ids.has(parents.get(row.id))) { ids.add(row.id); changed = true; }
  } while (changed);
  const ownerIds = new Set(agents.filter(row => ids.has(row.id)).map(row => row.owner));
  const records = Object.fromEntries(sources.map(source => [source,
    (source === 'agents' ? agents.filter(row => ids.has(row.id)) : source === 'owners'
      ? data[source].filter(row => ownerIds.has(row.id)) : (data[source] ?? []).filter(row => ids.has(row.agent)))
      .map(row => JSON.stringify(row)).sort().map(text => JSON.parse(text))]));
  return { rootId, treeIds: [...ids].sort(), records, fingerprint: digest(JSON.stringify(records)) };
}

function treeFrom(db, rootId) {
  return rosterTreeFromSnapshot(Object.fromEntries(sources.map(source => [source, rows(db, source)])), rootId);
}

export function readRosterTree(filename, rootId) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { db.exec('BEGIN'); const tree = treeFrom(db, rootId); db.exec('COMMIT'); return tree; }
  finally { db.close(); }
}

function createTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cleanup_roster_tickets (
    id TEXT PRIMARY KEY, root_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    tree_ids TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL,
    claimed_fingerprint TEXT, original_bodies TEXT NOT NULL, archive_manifest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cleanup_archives (
    archive_key TEXT PRIMARY KEY, source TEXT NOT NULL, original_id TEXT NOT NULL,
    owner TEXT, agent TEXT, name TEXT, created TEXT NOT NULL, payload TEXT NOT NULL, sha256 TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS cleanup_archives_lookup ON cleanup_archives(name,owner,agent,created);
    CREATE TABLE IF NOT EXISTS cleanup_roster_ticket_archives (
      ticket_id TEXT NOT NULL, archive_key TEXT NOT NULL, sha256 TEXT NOT NULL,
      PRIMARY KEY(ticket_id,archive_key));
    CREATE TABLE IF NOT EXISTS cleanup_roster_steps (
      ticket_id TEXT NOT NULL, agent TEXT NOT NULL, step TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(ticket_id,agent,step));
    CREATE TABLE IF NOT EXISTS cleanup_roster_byte_reports (
      ticket_id TEXT PRIMARY KEY, known_bytes INTEGER NOT NULL, unknown_steps TEXT NOT NULL);`);
}

function archiveEntries(tree, now, externalArchives = []) {
  const lookup = new Map(tree.records.agents.map(row => [row.id, row]));
  const entries = [];
  function add(source, originalId, agentId, payload, versioned = false, namespace = '', createdAt) {
    const encoded = JSON.stringify(payload);
    const sha256 = digest(encoded);
    const agent = lookup.get(agentId);
    entries.push({ archiveKey: `${source}:${namespace ? namespace + ':' : ''}${originalId}${versioned ? ':' + sha256 : ''}`,
      source, originalId: String(originalId), owner: agent?.owner ?? null, agent: agentId,
      name: agent?.name ?? null, created: createdAt ?? payload.created ?? now, payload: encoded, sha256 });
  }
  function embedded(agentId, value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.id === 'string' && typeof value.message === 'string')
      add('embedded-message', value.id, agentId, { id: value.id, message: value.message }, false, agentId,
        typeof value.createdAt === 'string' ? value.createdAt : undefined);
    for (const child of Object.values(value)) embedded(agentId, child);
  }
  for (const row of tree.records.agents) {
    add('agent-snapshot', row.id, row.id, row, true);
    embedded(row.id, JSON.parse(row.body));
  }
  for (const row of tree.records.backend_state) add('backend-snapshot', row.agent, row.agent, row, true);
  for (const row of tree.records.agent_history) {
    add('history', `${row.agent}:${row.seq}`, row.agent, row);
    embedded(row.agent, JSON.parse(row.body));
  }
  for (const row of tree.records.submissions) add('submission', row.id, row.agent,
    { id: row.id, owner: row.owner, agent: row.agent, task: row.task, kind: row.kind, message: row.message, final: row.final, created: row.created });
  for (const row of tree.records.supplements) add('supplement', row.requestId, row.agent,
    { requestId: row.requestId, owner: row.owner, agent: row.agent, session: row.session, task: row.task, message: row.message, created: row.created });
  for (const item of externalArchives) {
    if (!lookup.has(item.agentId) || typeof item.sourceId !== 'string' || !item.sourceId || typeof item.sessionId !== 'string' || !item.sessionId || !Object.hasOwn(item,'event')) throw new Error('native-history-invalid');
    add(item.sourceType?'dsh-'+item.sourceType:'dsh-history', item.sourceId, item.agentId, {sourceId:item.sourceId,sessionId:item.sessionId,event:item.event}, false, item.sessionId,
      typeof item.event?.createdAt === 'string' ? item.event.createdAt : undefined);
  }
  return entries;
}

/** Claim a previously observed exact tree and archive it in the same short write transaction. */
export function claimRosterTree(filename, { rootId, fingerprint, ticketId = randomUUID(), now = new Date().toISOString(), externalArchives = [] }) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      createTables(db);
      const prior = db.prepare('SELECT * FROM cleanup_roster_tickets WHERE id=?').get(ticketId);
      if (prior) {
        if (prior.root_id !== rootId || prior.fingerprint !== fingerprint) throw new Error('ticket-identity-conflict');
        db.exec('COMMIT'); return prior;
      }
      const tree = treeFrom(db, rootId);
      if (tree.fingerprint !== fingerprint) throw new Error('tree-fingerprint-changed');
      for (const row of tree.records.agents) {
        const body = JSON.parse(row.body);
        if (body.closed || body.cleanupRosterTicket || ['cleaning', 'cleanup_failed'].includes(body.state)) throw new Error('tree-already-closed');
      }
      const hasLeases = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leases'").get();
      if (hasLeases) {
        const held=db.prepare('SELECT 1 FROM leases WHERE (key=? OR key=?) AND expires>? LIMIT 1');
        for (const id of tree.treeIds) if (held.get(id,`worker:${id}`,Date.now())) throw new Error('tree-lease-held');
      }
      const insert = db.prepare(`INSERT OR IGNORE INTO cleanup_archives
        (archive_key,source,original_id,owner,agent,name,created,payload,sha256) VALUES (?,?,?,?,?,?,?,?,?)`);
      const read = db.prepare('SELECT payload,sha256 FROM cleanup_archives WHERE archive_key=?');
      const entries = archiveEntries(tree, now, externalArchives);
      for (const entry of entries) {
        insert.run(entry.archiveKey, entry.source, entry.originalId, entry.owner, entry.agent, entry.name, entry.created, entry.payload, entry.sha256);
        const stored = read.get(entry.archiveKey);
        if (!stored || stored.payload !== entry.payload || stored.sha256 !== entry.sha256 || digest(stored.payload) !== stored.sha256)
          throw new Error(`archive-conflict:${entry.archiveKey}`);
      }
      const manifest = [...new Map(entries.map(entry => [entry.archiveKey, entry.sha256])).entries()].sort(([a], [b]) => a.localeCompare(b));
      db.prepare('INSERT INTO cleanup_roster_tickets(id,root_id,fingerprint,tree_ids,status,created,updated,original_bodies,archive_manifest) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(ticketId, rootId, fingerprint, JSON.stringify(tree.treeIds), 'claimed', now, now,
          JSON.stringify(Object.fromEntries(tree.records.agents.map(row => [row.id, row.body]))), JSON.stringify(manifest));
      const link = db.prepare('INSERT OR IGNORE INTO cleanup_roster_ticket_archives VALUES (?,?,?)');
      for (const entry of entries) link.run(ticketId, entry.archiveKey, entry.sha256);
      const close = db.prepare("UPDATE agents SET body=json_set(body,'$.closed',json('true'),'$.cleanupRosterTicket',?) WHERE id=? AND body=?");
      for (const row of tree.records.agents) if (close.run(ticketId, row.id, row.body).changes !== 1) throw new Error('tree-changed-during-claim');
      db.prepare('UPDATE cleanup_roster_tickets SET claimed_fingerprint=? WHERE id=?').run(treeFrom(db, rootId).fingerprint, ticketId);
      const ticket = db.prepare('SELECT * FROM cleanup_roster_tickets WHERE id=?').get(ticketId);
      db.exec('COMMIT'); return ticket;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

export function readRosterTicket(filename, ticketId) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cleanup_roster_tickets'").get()) return undefined;
    return db.prepare('SELECT * FROM cleanup_roster_tickets WHERE id=?').get(ticketId);
  } finally { db.close(); }
}

export function listRosterTickets(filename, status = 'claimed') {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cleanup_roster_tickets'").get()) return [];
    return db.prepare('SELECT * FROM cleanup_roster_tickets WHERE status=? ORDER BY created,id').all(status);
  } finally { db.close(); }
}

/** Re-read the entire claimed tree and every linked archive before continuing. */
export function verifyRosterTicket(filename, ticketId) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('BEGIN');
    const ticket = db.prepare('SELECT * FROM cleanup_roster_tickets WHERE id=?').get(ticketId);
    if (!ticket || ticket.status !== 'claimed') { db.exec('COMMIT'); return { valid: false, reason: 'ticket-not-claimed' }; }
    const tree = treeFrom(db, ticket.root_id);
    if (tree.fingerprint !== ticket.claimed_fingerprint || JSON.stringify(tree.treeIds) !== ticket.tree_ids) {
      db.exec('COMMIT'); return { valid: false, reason: 'claimed-tree-changed' };
    }
    const links = db.prepare(`SELECT l.archive_key,l.sha256 AS expected,a.payload,a.sha256 AS actual
      FROM cleanup_roster_ticket_archives l LEFT JOIN cleanup_archives a ON a.archive_key=l.archive_key
      WHERE l.ticket_id=?`).all(ticketId);
    const manifest = links.map(row => [row.archive_key, row.expected]).sort(([a], [b]) => a.localeCompare(b));
    if (!links.length || JSON.stringify(manifest) !== ticket.archive_manifest || links.some(row => !row.payload || row.expected !== row.actual || digest(row.payload) !== row.expected)) {
      db.exec('COMMIT'); return { valid: false, reason: 'archive-verification-failed' };
    }
    db.exec('COMMIT'); return { valid: true, ticket };
  } catch (error) { return { valid: false, reason: `ticket-verification-failed:${error.message}` }; }
  finally { db.close(); }
}

function requireClaimedTree(db, ticketId) {
  const ticket = db.prepare('SELECT * FROM cleanup_roster_tickets WHERE id=?').get(ticketId);
  if (!ticket || ticket.status !== 'claimed') throw new Error('ticket-not-claimed');
  const tree = treeFrom(db, ticket.root_id);
  if (tree.fingerprint !== ticket.claimed_fingerprint || JSON.stringify(tree.treeIds) !== ticket.tree_ids) throw new Error('claimed-tree-changed');
  const links = db.prepare(`SELECT l.archive_key,l.sha256 AS expected,a.payload,a.sha256 AS actual FROM cleanup_roster_ticket_archives l
    LEFT JOIN cleanup_archives a ON a.archive_key=l.archive_key WHERE l.ticket_id=?`).all(ticketId);
  const manifest = links.map(row => [row.archive_key, row.expected]).sort(([a], [b]) => a.localeCompare(b));
  if (!links.length || JSON.stringify(manifest) !== ticket.archive_manifest || links.some(row => !row.payload || row.expected !== row.actual || digest(row.payload) !== row.expected)) throw new Error('archive-verification-failed');
  return { ticket, tree };
}

export function voidRosterRecipient(filename, ticketId, ownerId, {ownerProof, nativeQuestions=[]} = {}) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      const { ticket, tree } = requireClaimedTree(db, ticketId);
      if (tree.records.agents.some(row => row.owner !== ownerId)) throw new Error('tree-has-other-recipient');
      if (nativeQuestions.length && (ownerProof?.state !== 'deleted' || typeof ownerProof.domain !== 'string' || !ownerProof.domain || typeof ownerProof.source !== 'string' || !ownerProof.source || !ownerProof.receiptId || !ownerProof.threadId))
        throw new Error('owner-deletion-proof-unavailable');
      const receipts={};
      const getArchive=db.prepare(`SELECT a.payload,a.sha256 FROM cleanup_archives a JOIN cleanup_roster_ticket_archives l ON l.archive_key=a.archive_key
        WHERE l.ticket_id=? AND a.archive_key=? AND l.sha256=a.sha256`);
      for (const question of nativeQuestions) {
        if (!tree.treeIds.includes(question.agentId) || typeof question.id !== 'string' || !question.id || typeof question.message !== 'string' || typeof question.sessionId !== 'string' || !question.sessionId)
          throw new Error('native-question-invalid');
        const archiveKey=`dsh-question:${question.sessionId}:${question.id}`;
        const row=getArchive.get(ticketId,archiveKey);
        if (!row || digest(row.payload)!==row.sha256) throw new Error('native-question-archive-unverified');
        const stored=JSON.parse(row.payload);
        if (stored.sourceId!==question.id || stored.sessionId!==question.sessionId || stored.event?.message!==question.message) throw new Error('native-question-archive-mismatch');
        (receipts[question.agentId] ??= []).push({id:question.id,sessionId:question.sessionId,messageHash:digest(question.message),archiveKey,archiveSha256:row.sha256});
      }
      if (tree.records.supplements.some(row => ['sending','unknown'].includes(row.status))) throw new Error('input-outcome-unknown');
      const setSubmission = db.prepare("UPDATE submissions SET state='consumed', consumed=?, delivery=? WHERE id=? AND owner=?");
      for (const row of tree.records.submissions) {
        const delivery = row.delivery ? JSON.parse(row.delivery) : {};
        if (['sending','unknown'].includes(delivery.state)) throw new Error('delivery-outcome-unknown');
        if (row.kind === 'ask' || row.state === 'pending' || !['delivered','blocked'].includes(delivery.state)) {
          const next = ['delivered','blocked'].includes(delivery.state)
            ? {...delivery,voidReason:'recipient-deleted'} : {...delivery,state:'blocked',reason:'recipient-deleted'};
          setSubmission.run(new Date().toISOString(), JSON.stringify(next), row.id, ownerId);
        }
      }
      const setSupplement = db.prepare("UPDATE supplements SET status='blocked',reason='recipient-deleted' WHERE requestId=? AND owner=? AND status='queued'");
      for (const row of tree.records.supplements) setSupplement.run(row.requestId, ownerId);
      const saveAgent = db.prepare('UPDATE agents SET body=? WHERE id=? AND body=?');
      for (const row of tree.records.agents) {
        const body=JSON.parse(row.body);
        for (const question of body.observation?.questions ?? []) if (question.state === 'pending') { question.state='void'; question.reason='recipient-deleted'; }
        for (const notice of Object.values(body.task?.questionNotices ?? {})) {
          if (['sending','unknown'].includes(notice.state)) throw new Error('delivery-outcome-unknown');
          if (!['delivered','blocked'].includes(notice.state)) { notice.state='blocked'; notice.reason='recipient-deleted'; }
        }
        for (const report of body.task?.reports ?? []) {
          const delivery=report.delivery ?? {};
          if (['sending','unknown'].includes(delivery.state)) throw new Error('delivery-outcome-unknown');
          if (!['delivered','blocked'].includes(delivery.state)) report.delivery={...delivery,state:'blocked',reason:'recipient-deleted'};
        }
        if (saveAgent.run(JSON.stringify(body),row.id,row.body).changes !== 1) throw new Error('claimed-tree-changed');
      }
      const disposition={ownerId,ownerProof:ownerProof ?? null,archiveManifestHash:digest(ticket.archive_manifest),questionReceipts:receipts};
      const encoded=JSON.stringify(disposition);
      const old=db.prepare("SELECT payload FROM cleanup_roster_steps WHERE ticket_id=? AND agent=? AND step='recipient-voided'").get(ticketId,ticket.root_id);
      if (old && old.payload!==encoded) throw new Error('recipient-disposition-conflict');
      if (!old) db.prepare('INSERT INTO cleanup_roster_steps VALUES (?,?,?,?)').run(ticketId,ticket.root_id,'recipient-voided',encoded);
      db.prepare('UPDATE cleanup_roster_tickets SET claimed_fingerprint=? WHERE id=?').run(treeFrom(db, ticket.root_id).fingerprint, ticketId);
      db.exec('COMMIT'); return { voided:true, disposition };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

export function recordRosterStep(filename, ticketId, agentId, step, payload) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      const { tree } = requireClaimedTree(db, ticketId);
      if (!tree.treeIds.includes(agentId)) throw new Error('step-agent-outside-ticket');
      const encoded = JSON.stringify(payload);
      const old = db.prepare('SELECT payload FROM cleanup_roster_steps WHERE ticket_id=? AND agent=? AND step=?').get(ticketId,agentId,step);
      if (old && old.payload !== encoded) throw new Error('step-receipt-conflict');
      if (!old) db.prepare('INSERT INTO cleanup_roster_steps VALUES (?,?,?,?)').run(ticketId,agentId,step,encoded);
      db.exec('COMMIT'); return old ? JSON.parse(old.payload) : payload;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

// The backend explicitly proved it did not submit the native write.
export function forgetUnsentStep(filename,ticketId,agentId) {
  const db=new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    requireClaimedTree(db,ticketId);
    if(db.prepare("SELECT 1 FROM cleanup_roster_steps WHERE ticket_id=? AND agent=? AND step IN ('native-staged','native-complete','private-complete')").get(ticketId,agentId))throw new Error('native-step-already-committed');
    db.prepare("DELETE FROM cleanup_roster_steps WHERE ticket_id=? AND agent=? AND step='native-started'").run(ticketId,agentId);
    db.exec('COMMIT');
  }finally{db.close();}
}
export function markRosterRestored(filename,ticketId,agentId) {
  const db=new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    requireClaimedTree(db,ticketId);
    if(db.prepare("SELECT 1 FROM cleanup_roster_steps WHERE ticket_id=? AND step IN ('private-complete','native-complete')").get(ticketId))throw new Error('tree-already-partially-finalized');
    db.prepare("DELETE FROM cleanup_roster_steps WHERE ticket_id=? AND agent=? AND step IN ('native-started','native-staged')").run(ticketId,agentId);
    db.exec('COMMIT');
  }finally{db.close();}
}
export function rosterSteps(filename, ticketId) {
  const db = new DatabaseSync(filename, { readOnly:true });
  try { return db.prepare('SELECT agent,step,payload FROM cleanup_roster_steps WHERE ticket_id=?').all(ticketId).map(row => ({...row,payload:JSON.parse(row.payload)})); }
  finally { db.close(); }
}

// Report only new confirmed receipts, even if a later retry sees the same steps.
// The step ledger remains the durable cumulative source if a caller loses a reply.
export function takeRosterReleasedBytes(filename,ticketId) {
  const db=new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS cleanup_roster_byte_reports (ticket_id TEXT PRIMARY KEY, known_bytes INTEGER NOT NULL, unknown_steps TEXT NOT NULL)');
      const rows=db.prepare("SELECT agent,step,payload FROM cleanup_roster_steps WHERE ticket_id=? AND step IN ('native-started','native-staged','native-complete','private-started','private-complete')").all(ticketId);
      const present=new Set(rows.map(row=>`${row.agent}:${row.step}`));
      let known=0; const unknown=[];
      for (const row of rows) {
        if (row.step==='native-staged') continue;
        if (row.step==='native-started') {
          if (!present.has(`${row.agent}:native-complete`) && !present.has(`${row.agent}:native-staged`)) unknown.push(`${row.agent}:native-in-flight`);
          continue;
        }
        if (row.step==='private-started') {
          if (!present.has(`${row.agent}:private-complete`)) unknown.push(`${row.agent}:private-in-flight`);
          continue;
        }
        const payload=JSON.parse(row.payload);
        const value=Object.hasOwn(payload,'releasedBytes') ? payload.releasedBytes : row.step==='native-complete'
          ? (payload.alreadyRemoved ? null : payload.nativeSessionRetained || payload.coveredBy ? 0 : payload.bytes) : null;
        if (Number.isSafeInteger(value) && value>=0) known+=value;
        else unknown.push(`${row.agent}:${row.step}`);
      }
      unknown.sort();
      const previous=db.prepare('SELECT known_bytes,unknown_steps FROM cleanup_roster_byte_reports WHERE ticket_id=?').get(ticketId);
      const oldKnown=previous?.known_bytes ?? 0, oldUnknown=new Set(JSON.parse(previous?.unknown_steps ?? '[]'));
      if (known<oldKnown) throw new Error('released-byte-ledger-regressed');
      const newUnknown=unknown.filter(key=>!oldUnknown.has(key));
      db.prepare(`INSERT INTO cleanup_roster_byte_reports VALUES (?,?,?) ON CONFLICT(ticket_id) DO UPDATE
        SET known_bytes=excluded.known_bytes,unknown_steps=excluded.unknown_steps`).run(ticketId,known,JSON.stringify(unknown));
      db.exec('COMMIT');
      return {bytes:newUnknown.length ? null : known-oldKnown,knownBytes:known-oldKnown,totalKnownBytes:known,
        ...(unknown.length ? {bytesUnknown:true,bytesReason:'confirmed-deletion-size-unavailable',unknownSteps:unknown} : {})};
    } catch(error) {db.exec('ROLLBACK');throw error;}
  } finally {db.close();}
}

export function completeRosterTicket(filename, ticketId) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      const ticket = db.prepare('SELECT * FROM cleanup_roster_tickets WHERE id=?').get(ticketId);
      if (ticket?.status === 'completed') { db.exec('COMMIT'); return {completed:true}; }
      const { tree } = requireClaimedTree(db,ticketId);
      const get = db.prepare('SELECT step FROM cleanup_roster_steps WHERE ticket_id=? AND agent=?');
      const held = db.prepare('SELECT 1 FROM leases WHERE (key=? OR key=?) AND expires>? LIMIT 1');
      for (const id of tree.treeIds) {
        if (held.get(id,`worker:${id}`,Date.now())) throw new Error('tree-lease-held');
        const steps = new Set(get.all(ticketId,id).map(row => row.step));
        if (!steps.has('native-complete') || !steps.has('private-complete')) throw new Error('cleanup-steps-incomplete');
      }
      for (const id of tree.treeIds) {
        for (const table of ['submissions','supplements','backend_state','agent_history']) db.prepare(`DELETE FROM ${table} WHERE agent=?`).run(id);
        db.prepare('DELETE FROM leases WHERE key=? OR key=?').run(id,`worker:${id}`);
        db.prepare('DELETE FROM agents WHERE id=?').run(id);
      }
      db.prepare("UPDATE cleanup_roster_tickets SET status='completed',updated=? WHERE id=?").run(new Date().toISOString(),ticketId);
      db.exec('COMMIT'); return {completed:true};
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

/** Release only this ticket's closure; preserve any subsequent business writes. */
export function releaseRosterTicket(filename, ticketId, now = new Date().toISOString(), {restored=false}={}) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      const ticket = db.prepare('SELECT * FROM cleanup_roster_tickets WHERE id=?').get(ticketId);
      if (!ticket) throw new Error('ticket-not-found');
      if (ticket.status === 'released') { db.exec('COMMIT'); return ticket; }
      if (ticket.status !== 'claimed') throw new Error('ticket-not-releasable');
      if (db.prepare("SELECT 1 FROM cleanup_roster_steps WHERE ticket_id=? AND step<>'plan' AND (?=0 OR step<>'recipient-voided') LIMIT 1")
        .get(ticketId,Number(restored))) throw new Error('ticket-already-started');
      const originalBodies = JSON.parse(ticket.original_bodies);
      const get = db.prepare('SELECT body FROM agents WHERE id=?');
      const update = db.prepare('UPDATE agents SET body=? WHERE id=? AND body=?');
      for (const id of JSON.parse(ticket.tree_ids)) {
        const row = get.get(id);
        if (!row) throw new Error('ticket-tree-incomplete');
        const body = JSON.parse(row.body);
        if (body.cleanupRosterTicket !== ticketId) throw new Error('ticket-tree-ownership-changed');
        delete body.cleanupRosterTicket;
        const original = JSON.parse(originalBodies[id]);
        if (Object.hasOwn(original, 'closed')) body.closed = original.closed;
        else delete body.closed;
        if (update.run(JSON.stringify(body), id, row.body).changes !== 1) throw new Error('ticket-tree-changed');
      }
      db.prepare("UPDATE cleanup_roster_tickets SET status='released',updated=? WHERE id=?").run(now, ticketId);
      const result = db.prepare('SELECT * FROM cleanup_roster_tickets WHERE id=?').get(ticketId);
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

export function readRosterArchives(filename, query = {}) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cleanup_archives'").get()) return [];
    const predicates = [], parameters = [];
    for (const [key, column, operator] of [['name','name','='], ['ownerId','owner','='], ['agentId','agent','='], ['originalId','original_id','='], ['from','created','>='], ['to','created','<=']]) {
      if (query[key] != null) { predicates.push(`${column}${operator}?`); parameters.push(query[key]); }
    }
    return db.prepare(`SELECT * FROM cleanup_archives ${predicates.length ? 'WHERE ' + predicates.join(' AND ') : ''} ORDER BY created,archive_key`).all(...parameters)
      .map(row => { if (digest(row.payload) !== row.sha256) throw new Error(`archive-hash-mismatch:${row.archive_key}`); return { ...row, payload: JSON.parse(row.payload) }; });
  } finally { db.close(); }
}
