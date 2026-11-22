import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function directoryIdentity(directory) {
  const canonical = await realpath(directory);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory() || !info.ino) throw new Error('Directory identity unavailable: ' + directory);
  return [info.dev.toString(), info.ino.toString(), process.platform === 'win32' ? canonical.toLowerCase() : canonical];
}

async function coordinates(config, shared) {
  const base = await realpath(config.configFile);
  const owner = JSON.stringify([process.platform === 'win32' ? base.toLowerCase() : base, config.profile ?? null]);
  const root = await directoryIdentity(shared ? config.dshDataRoot : config.stateDirectory);
  const directory = shared ? path.join(root[2], '.futureaide-control') : root[2];
  return { owner, root: JSON.stringify(root), directory, filename: path.join(directory, 'cleanup-authority.sqlite') };
}

function matching(info, expected, binding) {
  if (!info || info.root !== expected.root || info.owner !== expected.owner || (binding && info.id !== binding)) {
    throw new Error('Cleanup authority belongs to a different root, configuration or profile; explicit handover is not supported.');
  }
}

const schema = `
  CREATE TABLE authority (only INTEGER PRIMARY KEY CHECK(only=1),id TEXT NOT NULL,root TEXT NOT NULL,owner TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0, activated INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1, manifest TEXT NOT NULL);
  CREATE TABLE inventory (key TEXT PRIMARY KEY, decision TEXT NOT NULL, fingerprint TEXT NOT NULL);
  CREATE TABLE retained_members (member TEXT NOT NULL, selection TEXT NOT NULL, PRIMARY KEY(member,selection));
  CREATE TABLE operations (key TEXT PRIMARY KEY, token TEXT NOT NULL, holder INTEGER NOT NULL, mode TEXT NOT NULL,
    generation INTEGER NOT NULL, state TEXT NOT NULL, detail TEXT, updated TEXT NOT NULL, plan TEXT NOT NULL);
  CREATE TABLE observations (key TEXT PRIMARY KEY, version TEXT NOT NULL, since INTEGER NOT NULL);
  CREATE INDEX first_items ON inventory(decision);
  CREATE TABLE monitor (only INTEGER PRIMARY KEY CHECK(only=1),generation INTEGER NOT NULL,pid INTEGER NOT NULL,checked TEXT NOT NULL);
  CREATE TABLE maintenance (approval TEXT PRIMARY KEY, backup TEXT NOT NULL, outcome TEXT);
`;

function saveEntries(db, entries) {
  const insert = db.prepare('INSERT INTO inventory VALUES(?,?,?)');
  const protect = db.prepare('INSERT OR IGNORE INTO retained_members VALUES(?,?)');
  for (const entry of entries) {
    insert.run(entry.key, entry.decision, entry.fingerprint);
    for (const member of entry.protects ?? []) protect.run(member, entry.key);
  }
}

export async function createAuthority(config, shared, manifest, entries) {
  const at = await coordinates(config, shared);
  if (shared) await mkdir(at.directory, { recursive: true, mode: 0o700 });
  if ((await lstat(at.directory)).isSymbolicLink() || (await realpath(at.directory)).toLowerCase() !== at.directory.toLowerCase()) {
    throw new Error('Cleanup authority directory is redirected.');
  }
  // Exclusive creation is the only operation allowed to introduce a new ledger. A
  // failed bootstrap is visible; ordinary monitors never re-create or replace it.
  const marker=at.filename+'.identity';
  try {
    const reservation=await open(marker,'wx',0o600);
    try { await reservation.writeFile(JSON.stringify({root:at.root,owner:at.owner}));await reservation.sync(); }
    finally {await reservation.close();}
  } catch(e) {
    if(e.code!=='EEXIST') throw e;
    // Never bootstrap over a lost ledger, even under another approved configuration.
    try {await lstat(at.filename);} catch {throw new Error('Reserved cleanup authority is missing. Restore the original ledger.');}
    throw e;
  }
  const fd = await open(at.filename, 'wx', 0o600);
  await fd.close();
  const db = new DatabaseSync(at.filename);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(schema);
    const id = randomUUID();
    db.prepare('INSERT INTO authority(only,id,root,owner,manifest) VALUES(1,?,?,?,?)').run(id, at.root, at.owner, manifest);
    saveEntries(db, entries);
    db.exec('COMMIT');
    return id;
  } finally { db.close(); }
}

export async function openAuthority(config, shared, { write = false, binding } = {}) {
  const at = await coordinates(config, shared);
  for (const name of [at.directory, at.filename]) {
    if ((await lstat(name)).isSymbolicLink() || (await realpath(name)).toLowerCase() !== name.toLowerCase()) {
      throw new Error('Cleanup authority path is redirected.');
    }
  }
  // mode=rw also refuses a missing ledger if it disappears after lstat.
  const { pathToFileURL } = await import('node:url');
  const url = pathToFileURL(at.filename);
  url.searchParams.set('mode', write ? 'rw' : 'ro');
  const db = new DatabaseSync(url.href, { readOnly: !write });
  try {
    const original=lstatSync(at.filename,{bigint:true});
    function originalPath() {
      try {
        const fresh=lstatSync(at.filename,{bigint:true});
        return fresh.dev===original.dev && fresh.ino===original.ino && !fresh.isSymbolicLink()
          && path.relative(realpathSync.native(at.filename),at.filename)==='';
      } catch {return false;}
    }
    const readInfo = () => db.prepare('SELECT * FROM authority WHERE only=1').get();
    const info = readInfo();
    matching(info, at, binding);
    const getEntry = db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM retained_members m JOIN inventory root ON root.key=m.selection
      WHERE m.member=i.key AND root.decision='C'
    ) THEN 'C' ELSE i.decision END AS decision, i.fingerprint FROM inventory i WHERE i.key=?`);
    const getOp = db.prepare('SELECT * FROM operations WHERE key=?');
    function allowed(key, mode, fingerprint, members) {
      const state = readInfo();
      if (!state.enabled || state.generation !== info.generation || !originalPath()) return false;
      const entry = getEntry.get(key);
      if (members.some(member => getEntry.get(member)?.decision === 'C')) return false;
      return mode === 'first' ? entry?.decision === 'A' && entry.fingerprint === fingerprint
        : (!entry || entry.decision === 'B');
    }
    const now = () => new Date().toISOString();
    return {
      info, close: () => db.close(), lookup: key => getEntry.get(key), operation: key => getOp.get(key),
      reserveVacuum(approval, backup) {
        if (readInfo().manifest !== approval || !originalPath()) throw new Error('Maintenance approval changed.');
        return db.prepare('INSERT OR IGNORE INTO maintenance(approval,backup) VALUES(?,?)').run(approval,backup).changes === 1;
      },
      recordVacuum(approval, outcome) {
        db.prepare('UPDATE maintenance SET outcome=? WHERE approval=?').run(JSON.stringify(outcome),approval);
      },
      permitsNativeTree(keys,mode) {
        const current=readInfo();
        if(!current.enabled || current.generation!==info.generation || !originalPath())return false;
        return keys.every(key=>{
          const choice=getEntry.get(key)?.decision;
          return !choice || choice==='B' || (choice==='A' && mode==='first');
        });
      },
      acknowledgement: () => db.prepare('SELECT * FROM monitor WHERE only=1').get() ?? null,
      acknowledge() {
        db.prepare('INSERT OR REPLACE INTO monitor VALUES(1,?,?,?)').run(info.generation,process.pid,now());
      },
      inventoryKeys() { return db.prepare('SELECT key FROM inventory ORDER BY key').all().map(row=>row.key); },
      replaceBeforeActivation(manifest,entries) {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (readInfo().activated) throw new Error('An activated authority requires a separate explicit review.');
          db.exec('DELETE FROM inventory');
          db.exec('DELETE FROM retained_members');
          saveEntries(db, entries);
          db.prepare('UPDATE authority SET manifest=?,generation=generation+1').run(manifest);
          db.exec('COMMIT');
        } catch(e) {db.exec('ROLLBACK');throw e;}
      },
      toggle(value) { db.prepare('UPDATE authority SET enabled=?,activated=MAX(activated,?),generation=generation+1 WHERE only=1 AND enabled<>?').run(Number(value),Number(value),Number(value)); },
      revoke(key) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const count = db.prepare("UPDATE inventory SET decision='B' WHERE key=? AND decision='C'").run(key).changes;
          if (count) db.prepare("DELETE FROM operations WHERE key=? AND state='restored'").run(key);
          db.exec('COMMIT');
          return count;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      retain(key,fingerprint,members=[]) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare("INSERT INTO inventory VALUES(?,'C',?) ON CONFLICT(key) DO UPDATE SET decision='C'").run(key,fingerprint);
          const row=db.prepare("INSERT OR IGNORE INTO inventory VALUES(?,'B',?)");
          const link=db.prepare('INSERT OR IGNORE INTO retained_members VALUES(?,?)');
          for(const member of members) {
            row.run(member,fingerprint);
            link.run(member,key);
          }
          db.exec('COMMIT');
        } catch(error) {db.exec('ROLLBACK');throw error;}
      },
      observe(key, version, time) {
        db.prepare('INSERT INTO observations VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET version=excluded.version,since=excluded.since WHERE version<>excluded.version').run(key,version,time);
        return db.prepare('SELECT since FROM observations WHERE key=?').get(key).since;
      },
      claim(key, mode, fingerprint, members, plan={}) {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!allowed(key, mode, fingerprint, members)) { db.exec('ROLLBACK'); return; }
          const old = getOp.get(key);
          if (old?.state === 'running') {
            // A reused PID can delay recovery. Only a definitively exited holder can lose its ticket.
            try { process.kill(old.holder,0); db.exec('ROLLBACK'); return; }
            catch (error) { if (error.code!=='ESRCH') {db.exec('ROLLBACK');return;} }
          }
          if (old?.state === 'removed' || old?.state==='restoring') { db.exec('ROLLBACK'); return; }
          const token = randomUUID();
          const original=old && ['held','running','needs-verification','staged'].includes(old.state) ? JSON.parse(old.plan) : null;
          const savedPlan=original && original.fingerprint===fingerprint ? original : {...plan,members,fingerprint,ticketToken:token};
          db.prepare('INSERT OR REPLACE INTO operations VALUES(?,?,?,?,?,?,?,?,?)')
            .run(key, token, process.pid, mode, info.generation, 'running',old?.detail??null,now(),JSON.stringify(savedPlan));
          db.exec('COMMIT');
          return token;
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      },
      valid(key, token, mode, fingerprint, members) {
        return allowed(key, mode, fingerprint, members) && getOp.get(key)?.token === token && getOp.get(key)?.state === 'running';
      },
      finish(key, token, state, detail) {
        db.prepare('UPDATE operations SET state=?,detail=?,updated=? WHERE key=? AND token=?').run(state,JSON.stringify(detail),now(),key,token);
      },
      pending() {return db.prepare("SELECT * FROM operations WHERE state IN ('running','staged','restoring','held','needs-verification') ORDER BY updated").all();},
      beginRestore(key,token) {
        const row=getOp.get(key);
        if(row?.state==='restoring') {
          try {process.kill(row.holder,0);return false;}catch(e){if(e.code!=='ESRCH')return false;}
        }
        return db.prepare("UPDATE operations SET state='restoring',holder=?,updated=? WHERE key=? AND token=? AND state=? AND holder=?")
          .run(process.pid,now(),key,token,row?.state==='restoring'?'restoring':'staged',row?.holder??0).changes===1;
      },
      operations() { return db.prepare('SELECT key,mode,state,detail,updated FROM operations ORDER BY updated DESC LIMIT 500').all(); },
    };
  } catch (e) { db.close(); throw e; }
}
