import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDshFixture } from './assembly/dsh.mjs';
import {
  makeFixtureRoot, freePort, writeControlConfig, writeClaudeSession, writeCodexHome,
  assemblyEnv, startWorker, waitForHealth, connectHttpMcp, callTool, devRoot,
} from './assembly/fixture.mjs';
import { inboxPath, pendingFeedback } from '../src/feedback-inbox.mjs';

const workerScript = `
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1]);
  db.exec('PRAGMA busy_timeout=100; BEGIN IMMEDIATE');
  console.log('locked ' + Date.now());
  setTimeout(() => {
    db.exec('ROLLBACK');
    console.log('released ' + Date.now());
    db.close();
  }, 5000);
`;
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

async function measure(client, tool, args) {
  const start = performance.now();
  const result = await callTool(client, tool, args);
  const ms = performance.now() - start;
  assert.equal(result.isError, false, JSON.stringify(result.value));
  return { ms, value: result.value, finishedAt: Date.now() };
}

test('isolated monitor continues dispatch and report while feedback SQLite is locked', { timeout: 120000 }, async t => {
  const { root, workspace } = await makeFixtureRoot(t, 'feedback-lock');
  const dsh = await startDshFixture({ root, workspace });
  const reportPort = await freePort();
  const configPath = await writeControlConfig({ root, workspace, dsh, reportPort });
  const claudeHome = await writeClaudeSession({ root, workspace });
  // The existing assembly identity belongs to this test PID. Give that identity
  // a unique real local pipe and matching key, and mirror received frames into
  // the isolated transcript just as the existing Claude assembly fixture does.
  const recordFile = path.join(claudeHome, 'sessions', `${process.pid}.json`);
  const claudeRecord = JSON.parse(await readFile(recordFile, 'utf8'));
  const socketPath = '\\\\.\\pipe\\feedback-lock-' + randomUUID();
  claudeRecord.messagingSocketPath = socketPath;
  await writeFile(recordFile, JSON.stringify(claudeRecord));
  const keyName = `${process.pid}.${createHash('sha256').update(socketPath).digest('hex')}.key`;
  await writeFile(path.join(claudeHome, 'sessions', keyName), JSON.stringify({
    peerToken: '0'.repeat(32), procStart: claudeRecord.procStart, pidDomain: claudeRecord.pidDomain,
  }));
  const transcript = path.join(claudeHome, 'projects', 'assembly-project', `${claudeRecord.sessionId}.jsonl`);
  const receivedFrames = [];
  const sockets = new Set();
  const inbox = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let incoming = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { incoming += chunk; });
    socket.on('end', async () => {
      const [auth, frame] = incoming.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(auth.token, '0'.repeat(32));
      receivedFrames.push({ frame, receivedAt: Date.now() });
      await appendFile(transcript, JSON.stringify({ ...frame, sessionId: frame.session_id }) + '\n');
      socket.end();
    });
  });
  await new Promise((resolve, reject) => { inbox.once('error', reject); inbox.listen(socketPath, resolve); });
  t.after(() => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    inbox.close(resolve);
  }));
  const codexHome = await writeCodexHome({ root, configPath });
  const env = assemblyEnv({ claudeHome, codexHome, fakeClaude: true });
  env.FUTUREAIDE_ASSEMBLY_CLAUDE_WORKSPACE = workspace;
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.ok(path.isAbsolute(root) && path.dirname(configPath) === root && config.workspace === workspace);
  assert.ok(config.dshDataRoot === path.join(root, 'dsh-home'));
  assert.equal(config.instanceFile, dsh.instanceFile);
  assert.equal(config.hostBridgeFile, dsh.hostBridgeFile);
  assert.equal(new URL(dsh.baseUrl).hostname, '127.0.0.1');
  assert.equal(config.reportPort, reportPort);
  assert.equal(env.CODEX_HOME, codexHome);
  assert.ok((await readFile(dsh.instanceFile, 'utf8')).includes(dsh.baseUrl));

  const worker = await startWorker({ configPath, env });
  t.after(async () => { await worker.close(); await dsh.close(); });
  await waitForHealth(reportPort, { timeoutMs: 20000 });
  const mcp = await connectHttpMcp(reportPort);
  t.after(() => mcp.close());
  const created = await callTool(mcp.client, 'futureaide_create_agent', {
    name: 'lock-benchmark', lifetime: 'persistent',
  });
  assert.equal(created.isError, false, JSON.stringify(created.value));
  const existing = worker.store.list().find(item => item.name === 'lock-benchmark');
  assert.ok(existing);
  for (const phase of ['baseline', 'locked']) {
    for (let i = 0; i < 10; i++) {
      const result = await callTool(mcp.client, 'futureaide_create_agent', {
        name: `${phase}-${i}`, lifetime: 'persistent',
      });
      assert.equal(result.isError, false, JSON.stringify(result.value));
    }
  }

  // Separate already-bound private CLI tasks for each group and batch.
  // Otherwise a fixture-only failed Claude inbox delivery keeps the one task's
  // monitor poll busy retrying earlier reports while later samples queue behind it.
  const reportClients = new Map();
  for (const phase of ['baseline', 'locked']) {
    for (let batch = 0; batch < 2; batch++) {
      const agentId = `report-${phase}-${batch}`;
      const taskId = `task-${phase}-${batch}`;
      const requestId = `request-${phase}-${batch}`;
      worker.store.insert({
        ...existing, agentId, name: agentId, target: 'claude-cli', state: 'working',
        task: { taskId, dispatches: [{ requestId }], reports: [], answers: [] },
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(devRoot, 'src', 'mcp-server.mjs'), '--claude-cli-reports',
          worker.store.location, agentId, taskId, requestId, configPath],
        env, stderr: 'pipe',
      });
      const client = new Client({ name: `fixture-${phase}-${batch}`, version: '1' });
      await client.connect(transport);
      reportClients.set(`${phase}-${batch}`, client);
      t.after(() => client.close());
    }
  }
  pendingFeedback(configPath);
  const metrics = {
    configPath, root, reportPort, dshBaseUrl: dsh.baseUrl, codexHome,
    monitorPid: worker.child.pid,
    baseline: { dispatch: [], report: [], feedback: [] },
    locked: { dispatch: [], report: [], feedback: [] },
    lock: [], monitorProgress: [], receivedFrames,
  };
  let iteration = 0;
  let baselineIteration = 0;
  while (iteration < 10) {
    // Alternate batches to balance roster growth and machine load. Both arms
    // submit feedback and run dispatch/report concurrently, with equal timing.
    const batchEnd = Math.min(10, iteration + 5);
    while (baselineIteration < batchEnd) {
      const n = baselineIteration++;
      const feedbackStart = performance.now();
      let baselineFinished = false;
      const feedback = callTool(mcp.client, 'futureaide_feedback', {
        kind: 'problem', message: `baseline sample ${n}`,
      }).then(result => {
        baselineFinished = true;
        return { ms: performance.now() - feedbackStart, finishedAt: Date.now(),
          value: result.value, isError: result.isError };
      });
      await tick();
      assert.equal(baselineFinished, false, 'baseline feedback must overlap the operations');
      const [dispatch, report, fb] = await Promise.all([
        measure(mcp.client, 'futureaide_send_agent', { name: `baseline-${n}`, message: `baseline ${n}` }),
        measure(reportClients.get(`baseline-${Math.floor(n / 5)}`), 'report_parent', { message: `baseline ${n}`, final: false }),
        feedback,
      ]);
      assert.equal(dispatch.value.accepted, true, JSON.stringify(dispatch.value));
      assert.equal(report.value.accepted, true);
      metrics.baseline.dispatch.push(dispatch.ms);
      metrics.baseline.report.push(report.ms);
      metrics.baseline.feedback.push(fb);
    }
    const lock = spawn(process.execPath, ['-e', workerScript, inboxPath(configPath)], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    lock.stdout.setEncoding('utf8');
    lock.stdout.on('data', chunk => { output += chunk; });
    const started = Date.now();
    while (!/locked \d+/.test(output)) {
      if (lock.exitCode !== null || Date.now() - started > 5000) throw Error('isolated lock failed');
      await tick();
    }
    const lockedAt = Number(output.match(/locked (\d+)/)[1]);
    const lockInfo = { lockedAt, releasedAt: null };
    metrics.lock.push(lockInfo);
    const watchedReports = [];
    while (iteration < batchEnd && Date.now() - lockedAt < 3000) {
      const n = iteration++;
      const start = performance.now();
      let finished = false;
      const feedback = callTool(mcp.client, 'futureaide_feedback', {
        kind: 'problem', message: `lock sample ${n}`,
      }).then(result => {
        finished = true;
        return { ms: performance.now() - start, finishedAt: Date.now(), value: result.value, isError: result.isError };
      });
      await tick();
      assert.equal(finished, false, 'feedback must still be waiting when operations begin');
      const [dispatch, report, fb] = await Promise.all([
        measure(mcp.client, 'futureaide_send_agent', { name: `locked-${n}`, message: `locked ${n}` }),
        measure(reportClients.get(`locked-${Math.floor(n / 5)}`), 'report_parent', { message: `locked ${n}`, final: false }),
        feedback,
      ]);
      assert.equal(dispatch.value.accepted, true, JSON.stringify(dispatch.value));
      assert.equal(report.value.accepted, true);
      metrics.locked.dispatch.push(dispatch);
      metrics.locked.report.push(report);
      metrics.locked.feedback.push(fb);
      watchedReports.push(report.value.submissionId);
    }
    // Only the spawned scoped-worker consumes these rows. Observe its committed
    // state while the independent lock holder still owns the feedback DB.
    while (!/released \d+/.test(output)) {
      for (const id of watchedReports) {
        if (metrics.monitorProgress.some(item => item.id === id)) continue;
        const row = worker.store.db.prepare(
          'SELECT id, state, created, consumed, delivery FROM submissions WHERE id=?',
        ).get(id);
        if (row?.state === 'consumed') {
          metrics.monitorProgress.push({ ...row, observedAt: Date.now(), lockedAt });
        }
      }
      if (lock.exitCode !== null) throw Error(`lock exited early: ${output}`);
      await tick();
    }
    lockInfo.releasedAt = Number(output.match(/released (\d+)/)[1]);
  }

  for (const item of [...metrics.locked.dispatch, ...metrics.locked.report]) {
    assert.ok(metrics.lock.some(lock => item.finishedAt >= lock.lockedAt && item.finishedAt < lock.releasedAt));
  }
  const pending = pendingFeedback(configPath);
  metrics.savedCount = pending.reduce((sum, item) => sum + item.count, 0);
  metrics.p95 = {
    baselineDispatch: p95(metrics.baseline.dispatch),
    lockedDispatch: p95(metrics.locked.dispatch.map(item => item.ms)),
    baselineReport: p95(metrics.baseline.report),
    lockedReport: p95(metrics.locked.report.map(item => item.ms)),
  };
  metrics.p95.dispatchIncrease = metrics.p95.lockedDispatch - metrics.p95.baselineDispatch;
  metrics.p95.reportIncrease = metrics.p95.lockedReport - metrics.p95.baselineReport;
  await writeFile(path.join(root, 'feedback-lock-results.json'), JSON.stringify(metrics, null, 2));
  console.log(`feedback lock evidence: ${path.join(root, 'feedback-lock-results.json')}`);
  assert.equal(metrics.savedCount, 10);
  assert.equal(metrics.baseline.feedback.length, 10);
  assert.equal(metrics.locked.feedback.length, 10);
  for (const item of metrics.baseline.feedback) {
    assert.equal(item.value?.saved, true, JSON.stringify(item));
    assert.ok(item.ms <= 2100, JSON.stringify(item));
  }
  for (const item of metrics.locked.feedback) {
    assert.ok(item.ms <= 2100, JSON.stringify(item));
    assert.equal(item.value?.saved, false, JSON.stringify(item));
    assert.equal(item.value?.code, 'feedback-busy', JSON.stringify(item));
  }
  assert.ok(metrics.monitorProgress.some(item => metrics.lock.some(lock =>
    item.lockedAt === lock.lockedAt && Date.parse(item.consumed) >= lock.lockedAt
      && Date.parse(item.consumed) < lock.releasedAt && item.observedAt < lock.releasedAt)),
  'shared monitor must consume a locked-interval report before release');
  assert.ok(receivedFrames.some(item => metrics.lock.some(lock =>
    item.receivedAt >= lock.lockedAt && item.receivedAt < lock.releasedAt
      && /locked \d+/.test(item.frame.message?.content ?? ''))),
  'the isolated Claude inbox must receive a locked-interval report before release');
  assert.ok(metrics.p95.dispatchIncrease <= 250, JSON.stringify(metrics.p95));
  assert.ok(metrics.p95.reportIncrease <= 250, JSON.stringify(metrics.p95));
});
