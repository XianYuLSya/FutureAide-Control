// Prove the history migration is lossless, idempotent, and readable by the code
// from before the move. Everything runs on a copy.
//
//   node scripts/perf-verify-migration.mjs --db <copy.sqlite> --work <dir> [--old <old-src>]
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};
const sourceDb = path.resolve(option('db', ''));
const workDir = path.resolve(option('work', '.perf-work'));
const oldSrc = path.resolve(option('old', ''));
if (!existsSync(sourceDb)) throw new Error(`missing --db ${sourceDb}`);
mkdirSync(workDir, { recursive: true });
const target = path.join(workDir, 'migration-check.sqlite');
for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${target}${suffix}`)) rmSync(`${target}${suffix}`);
copyFileSync(sourceDb, target);

const { RosterStore } = await import(pathToFileURL(path.join(path.resolve('src'), 'roster-store.mjs')).href);

// Expected histories, straight out of the untouched copy.
const raw = new DatabaseSync(sourceDb, { readOnly: true });
const expected = new Map();
for (const row of raw.prepare('SELECT id, body FROM agents').all()) {
  const history = JSON.parse(row.body)?.history;
  expected.set(row.id, Array.isArray(history) ? history : []);
}
raw.close();
const expectedItems = [...expected.values()].reduce((sum, items) => sum + items.length, 0);

const store = new RosterStore(target);
const migrated = new Map();
for (const agentId of expected.keys()) migrated.set(agentId, store.historyFor(agentId));
const bodiesStillCarryHistory = store.db.prepare(`SELECT count(*) AS count FROM agents
  WHERE json_type(json_extract(body,'$.history'))='array' AND json_array_length(json_extract(body,'$.history'))>0`).get().count;
const migratedItems = [...migrated.values()].reduce((sum, items) => sum + items.length, 0);
const mismatched = [...expected].filter(([agentId, items]) => JSON.stringify(items) !== JSON.stringify(migrated.get(agentId)))
  .map(([agentId]) => agentId);
const marker = store.db.prepare("SELECT value FROM schema_meta WHERE key='agent-history-table-v1'").get();
store.close();

// Second open: the marker must stop a second move, and opening must write nothing.
const before = new DatabaseSync(target, { readOnly: true });
const beforeChanges = before.prepare('SELECT total_changes() AS changed').get().changed;
const beforeRows = before.prepare('SELECT count(*) AS count FROM agent_history').get().count;
before.close();
const second = new RosterStore(target);
const secondRows = second.db.prepare('SELECT count(*) AS count FROM agent_history').get().count;
const secondChanges = second.db.prepare('SELECT total_changes() AS changed').get().changed;
const secondMarker = second.db.prepare("SELECT value FROM schema_meta WHERE key='agent-history-table-v1'").get();
// The old code must still open and save a migrated record.
let oldCodeWrite = 'not checked';
if (oldSrc) {
  const old = await import(pathToFileURL(path.join(oldSrc, 'roster-store.mjs')).href);
  const legacy = new old.RosterStore(target);
  const one = legacy.list()[0];
  one.probeMarker = 'old-code-still-writes';
  legacy.save(one);
  const readBack = legacy.get(one.agentId);
  oldCodeWrite = readBack?.probeMarker === 'old-code-still-writes' ? 'ok' : 'failed';
  legacy.close();
}
second.close();

const result = {
  agents: expected.size,
  expectedItems, migratedItems,
  mismatchedAgents: mismatched.slice(0, 5),
  bodiesStillCarryHistory,
  markerBefore: marker?.value ?? null,
  secondOpenRows: secondRows, rowsBeforeSecondOpen: beforeRows,
  secondOpenWrites: secondChanges - beforeChanges,
  markerAfterSecondOpen: secondMarker?.value ?? null,
  oldCodeWrite,
};
console.log(JSON.stringify(result, null, 2));
const ok = migratedItems === expectedItems && !mismatched.length && bodiesStillCarryHistory === 0
  && Boolean(marker) && beforeRows === expectedItems && secondRows === expectedItems
  && secondChanges === beforeChanges && oldCodeWrite !== 'failed';
if (!ok) process.exitCode = 1;
