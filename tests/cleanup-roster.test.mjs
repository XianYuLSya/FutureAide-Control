import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRosterCleanup } from '../src/cleanup-roster.mjs';

test('preview reads legacy schema and committed WAL without migrating it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'roster-preview-'));
  const file = path.join(dir, 'roster.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE owners(id TEXT PRIMARY KEY, body TEXT); CREATE TABLE agents(id TEXT PRIMARY KEY, owner TEXT, name TEXT, body TEXT);`);
    db.prepare('INSERT INTO owners VALUES (?,?)').run('o', '{}');
    db.prepare('INSERT INTO agents VALUES (?,?,?,?)').run('a', 'o', 'helper', JSON.stringify({ target: 'codex-desktop', lifetime: 'persistent' }));
    const cleanup = createRosterCleanup({ stateDirectory: dir }, { desktop: { inspect: async () => ({ running: false, treeIds: ['t'], activityVersion: 'v' }), ownerStatus: async () => 'unknown' } });
    const result = await cleanup.inventory();
    assert.equal(result.complete, true);
    assert.equal(result.items[0].agentId, 'a');
    assert.equal(result.items[0].eligible, false);
    assert.equal((await cleanup.remove(result.items[0], { mode: 'first', revalidate: async () => true })).removed, false);
    assert.deepEqual(await cleanup.archives({}), []);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='cleanup_archives'").get().n, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('missing roster is reported without creating it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'roster-missing-'));
  try { assert.equal((await createRosterCleanup({ stateDirectory: dir }).inventory()).complete, false); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
