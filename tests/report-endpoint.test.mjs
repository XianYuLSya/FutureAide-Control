import test from 'node:test';
import assert from 'node:assert/strict';
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
  } finally {
    if (saved === undefined) delete process.env.FUTUREAIDE_REPORT_PORT;
    else process.env.FUTUREAIDE_REPORT_PORT = saved;
  }
});
