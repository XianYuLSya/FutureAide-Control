import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sameCodexDomain } from './codex-domain.mjs';

// Only a confirmed native delete followed by both live and archived list checks writes a receipt.
export function rememberDeleted(config,domain,ids) {
  if(!config.stateDirectory || !domain || !ids.length)return;
  const db=new DatabaseSync(path.join(config.stateDirectory,'cleanup-native-receipts.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS receipts(id TEXT, domain TEXT, removedAt TEXT NOT NULL, PRIMARY KEY(id,domain))');
    const put=db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?)');
    for(const id of ids)put.run(id,JSON.stringify(domain),new Date().toISOString());
    db.exec('COMMIT');
  }finally{db.close();}
}
export function deletionReceipt(config,owner) {
  if(!config.stateDirectory)return null;
  let db;
  try {
    db=new DatabaseSync(path.join(config.stateDirectory,'cleanup-native-receipts.sqlite'),{readOnly:true});
    return db.prepare('SELECT domain,removedAt FROM receipts WHERE id=?').all(owner.threadId)
      .find(r=>sameCodexDomain(JSON.parse(r.domain),owner.codexDomain))??null;
  }catch{return null;}finally{db?.close();}
}
