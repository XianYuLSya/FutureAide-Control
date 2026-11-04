import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RosterStore } from '../src/roster-store.mjs';
import { closeReportService, ensureReportService, readReportStatus, reportPort } from '../src/report-endpoint.mjs';
import { DEFAULT_PORT } from '../src/claude-report-server.mjs';

test('the loopback tool service starts on demand and answers its health check', async () => {
  const store = new RosterStore(':memory:');
  try {
    const idle = await readReportStatus({ port: 0 });
    assert.equal(idle.ready, false, 'nothing is listening before the first real call');

    const started = await ensureReportService({ store, port: 0, timeoutMs: 3000 });
    assert.equal(started.ready, true);
    assert.equal(started.started, true);
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const status = await readReportStatus({ port: started.port });
    assert.equal(status.ready, true);
    assert.equal(status.hosting, 'this-process');
    assert.equal(status.health.server, 'futureaide-report');
    assert.equal(typeof status.health.stats?.requests, 'number');

    const again = await ensureReportService({ store, port: started.port, timeoutMs: 1000 });
    assert.equal(again.ready, true);
    assert.equal(again.started, false, 'a later call reuses the running service instead of starting another');
  } finally {
    await closeReportService();
    store.close();
  }
});

test('the health document names its roster, and a foreign roster is never reused', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'identity-'));
  const ours = new RosterStore(path.join(root, 'ours', 'roster.sqlite'));
  const other = new RosterStore(path.join(root, 'other', 'roster.sqlite'));
  try {
    assert.notEqual(ours.identity(), other.identity(), 'a different database path is a different roster');
    assert.equal(new RosterStore(path.join(root, 'ours', 'roster.sqlite')).identity(), ours.identity(), 'the identity is stable for one database');

    const started = await ensureReportService({ store: ours, port: 0, timeoutMs: 3000 });
    assert.equal(started.ready, true);
    const port = started.port;

    const mine = await readReportStatus({ port, expectedRoster: ours.identity() });
    assert.equal(mine.ready, true);
    assert.equal(mine.health.roster, ours.identity(), 'health names the roster it serves');

    const foreign = await readReportStatus({ port, expectedRoster: other.identity() });
    assert.equal(foreign.ready, false, 'another roster is not ready');
    assert.equal(foreign.reason.code, 'report-service-foreign-roster');

    const refused = await ensureReportService({ store: other, port, timeoutMs: 300 });
    assert.equal(refused.ready, false, 'the other roster never reuses this service');
    assert.equal(refused.reason.code, 'report-service-foreign-roster');
    assert.equal((await readReportStatus({ port, expectedRoster: ours.identity() })).ready, true, 'our service is untouched');
  } finally {
    await closeReportService();
    ours.close(); other.close();
  }
});

test('the report port is internal configuration with a safe default', () => {
  const saved = process.env.FUTUREAIDE_REPORT_PORT;
  try {
    delete process.env.FUTUREAIDE_REPORT_PORT;
    assert.equal(reportPort(), DEFAULT_PORT);
    process.env.FUTUREAIDE_REPORT_PORT = '17655';
    assert.equal(reportPort(), 17655);
    process.env.FUTUREAIDE_REPORT_PORT = '0';
    assert.equal(reportPort(), 0, 'an ephemeral port is allowed');
    process.env.FUTUREAIDE_REPORT_PORT = 'not-a-port';
    assert.equal(reportPort(), DEFAULT_PORT, 'an invalid value never guesses');
    // config.json wins over the environment, and an invalid config falls through.
    process.env.FUTUREAIDE_REPORT_PORT = '17655';
    assert.equal(reportPort({ reportPort: 17656 }), 17656, 'the configured port wins');
    assert.equal(reportPort({ reportPort: 70000 }), 17655, 'an out-of-range config falls back to the environment');
    assert.equal(reportPort({ reportPort: '17656' }), 17655, 'a non-integer config is ignored');
  } finally {
    if (saved === undefined) delete process.env.FUTUREAIDE_REPORT_PORT;
    else process.env.FUTUREAIDE_REPORT_PORT = saved;
  }
});

