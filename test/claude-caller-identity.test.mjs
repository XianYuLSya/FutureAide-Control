// Unit tests for the caller identity used by the report surface. Everything that
// touches Windows (netstat, process start time, parent process) is injected, so
// these tests check the decision rules, not this machine. The real lookups are
// exercised by scripts/claude-report-probe.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import path from 'node:path';
import {
  createStartTimeCache, parseTcpConnections, resolveSessionOwner, resolveSocketCaller, sessionRecordPath,
  tcpOwnerPid, verifySessionRecord,
} from '../src/claude-caller-identity.mjs';

const domain = `win32:${hostname().toLowerCase()}`;
const sessionId = '6808231c-116c-4fc7-b9b0-4d790e763b0b';
const recordFor = (pid, overrides = {}) => ({
  pid, sessionId, cwd: 'D:\\Work\\xiayuls_workflow', entrypoint: 'claude-desktop',
  pidDomain: domain, procStart: '134381970992798945', name: 'FutureAide 插件生命周期测试',
  messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-abc', ...overrides,
});
const live = () => true;

test('netstat rows are parsed into client and server endpoints', () => {
  const text = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:57361        127.0.0.1:17654        ESTABLISHED     50124',
    '  TCP    127.0.0.1:17654        127.0.0.1:57361        ESTABLISHED     11712',
    '  TCP    127.0.0.1:49207        127.0.0.1:17654        TIME_WAIT       0',
    '  TCP    [::1]:60512            [::1]:17654            ESTABLISHED     42632',
  ].join('\r\n');
  const rows = parseTcpConnections(text);
  assert.deepEqual(rows.map(row => [row.localPort, row.remotePort, row.state, row.pid]), [
    [57361, 17654, 'ESTABLISHED', 50124],
    [17654, 57361, 'ESTABLISHED', 11712],
    [49207, 17654, 'TIME_WAIT', 0],
    [60512, 17654, 'ESTABLISHED', 42632],
  ]);
  assert.equal(rows[3].localAddress, '[::1]');
});

test('the owning PID comes from the client-side established row only', async () => {
  const rows = parseTcpConnections([
    '  TCP    127.0.0.1:50000        127.0.0.1:17654        ESTABLISHED     4242',
    '  TCP    127.0.0.1:50001        127.0.0.1:17654        TIME_WAIT       0',
    '  TCP    127.0.0.1:50001        127.0.0.1:19000        ESTABLISHED     7777',
  ].join('\n'));
  const listConnections = async () => rows;
  assert.equal(await tcpOwnerPid({ clientPort: 50000, serverPort: 17654 }, { listConnections }), 4242);
  assert.equal(await tcpOwnerPid({ clientPort: 50001, serverPort: 17654 }, { listConnections }), null);
  assert.equal(await tcpOwnerPid({ clientPort: 50002, serverPort: 17654 }, { listConnections }), null);
  assert.equal(await tcpOwnerPid({ clientPort: 0, serverPort: 17654 }, { listConnections }), null);
});

test('a valid record verifies only against its own live process', async () => {
  const pid = 50124;
  const record = recordFor(pid);
  const startTime = async () => record.procStart;
  assert.deepEqual(await verifySessionRecord(record, pid, { startTime, isAlive: live }), { ok: true });

  const cases = [
    [recordFor(pid + 1), pid, 'session-record-pid-mismatch'],
    [recordFor(pid, { entrypoint: 'cli' }), pid, 'session-entrypoint-mismatch'],
    [recordFor(pid, { sessionId: 'not-a-uuid' }), pid, 'session-id-invalid'],
    [recordFor(pid, { pidDomain: 'win32:another-host' }), pid, 'session-pid-domain-mismatch'],
    [recordFor(pid, { procStart: '' }), pid, 'session-proc-start-missing'],
    [recordFor(pid, { cwd: 'relative\\dir' }), pid, 'session-cwd-invalid'],
    [null, pid, 'session-record-missing'],
  ];
  for (const [candidate, target, code] of cases) {
    const verdict = await verifySessionRecord(candidate, target, { startTime, isAlive: live });
    assert.equal(verdict.ok, false, code);
    assert.equal(verdict.code, code);
  }

  // A recycled PID keeps the old number but a different start time.
  const replaced = await verifySessionRecord(recordFor(pid), pid, {
    startTime: async () => '134381999999999999', isAlive: live,
  });
  assert.equal(replaced.code, 'session-process-replaced');

  const gone = await verifySessionRecord(recordFor(pid), pid, { startTime, isAlive: () => false });
  assert.equal(gone.code, 'session-process-gone');
});

test('an unreadable start time fails closed instead of assuming the record is right', async () => {
  const verdict = await verifySessionRecord(recordFor(50124), 50124, {
    startTime: async () => { throw new Error('wmi unavailable'); }, isAlive: live,
  });
  assert.equal(verdict.code, 'session-proc-start-unreadable');
});

test('the owner is found at the starting PID without touching its parents', async () => {
  const record = recordFor(50124);
  const owners = [];
  const owner = await resolveSessionOwner(50124, {
    readRecord: async pid => (pid === 50124 ? record : null),
    parentOf: async pid => { owners.push(pid); return 1; },
    startTime: async () => record.procStart, isAlive: live,
  });
  assert.equal(owner.pid, 50124);
  assert.equal(owner.depth, 0);
  assert.deepEqual(owner.chain, [50124]);
  assert.deepEqual(owners, []);
});

test('a wrapper process is resolved through its parent, within the depth limit', async () => {
  const record = recordFor(50124);
  const parentOf = async pid => (pid === 60000 ? 50124 : null);
  const owner = await resolveSessionOwner(60000, {
    readRecord: async pid => (pid === 50124 ? record : null), parentOf,
    startTime: async () => record.procStart, isAlive: live,
  });
  assert.equal(owner.pid, 50124);
  assert.equal(owner.depth, 1);
  assert.deepEqual(owner.chain, [60000, 50124]);

  const bounded = await resolveSessionOwner(60000, {
    readRecord: async () => null, parentOf, startTime: async () => record.procStart,
    isAlive: live, maxDepth: 1,
  });
  assert.equal(bounded, null);
});

test('a record that exists but does not verify stops the walk instead of borrowing a parent identity', async () => {
  const stale = recordFor(60000, { entrypoint: 'claude-cli' });
  const valid = recordFor(50124);
  const parents = [];
  const result = await resolveSessionOwner(60000, {
    readRecord: async pid => (pid === 60000 ? stale : valid),
    parentOf: async pid => { parents.push(pid); return 50124; },
    startTime: async () => '134381970992798945', isAlive: live,
  });
  assert.equal(result.refusal.code, 'session-entrypoint-mismatch');
  assert.equal(result.refusal.pid, 60000);
  assert.deepEqual(parents, []);
});

test('the start-time check is cached so a tool call does not pay it twice', async () => {
  let lookups = 0;
  const cache = createStartTimeCache({ ttlMs: 60000 });
  const startTime = async () => { lookups += 1; return '134381970992798945'; };
  assert.equal(await cache.verify(50124, '134381970992798945', startTime), true);
  assert.equal(await cache.verify(50124, '134381970992798945', startTime), true);
  assert.equal(lookups, 1);
  assert.equal(await cache.verify(50124, '134381970992798946', startTime), false);
  assert.equal(lookups, 2);
});

test('a socket caller resolves through the TCP peer and reports how it was found', async () => {
  const record = recordFor(50124, { hostSessionId: 'local_abc' });
  const caller = await resolveSocketCaller({ remotePort: 57361, localPort: 17654 }, {
    tcpOwner: async ({ clientPort, serverPort }) => {
      assert.deepEqual({ clientPort, serverPort }, { clientPort: 57361, serverPort: 17654 });
      return 50124;
    },
    env: { CLAUDE_CONFIG_DIR: 'D:\\tmp\\claude-config' },
    readRecord: async pid => (pid === 50124 ? record : null),
    startTime: async () => record.procStart, isAlive: live,
    // The image name is diagnosis only; it is read once per connection and never
    // part of the decision.
    image: async pid => (pid === 50124 ? 'claude.exe' : null),
  });
  assert.deepEqual(caller, { pid: 50124, sessionId, cwd: 'D:\\Work\\xiayuls_workflow',
    name: 'FutureAide 插件生命周期测试', procStart: '134381970992798945', via: 'pid',
    pidDomain: domain, recordFile: 'D:\\tmp\\claude-config\\sessions\\50124.json',
    directory: 'D:\\tmp\\claude-config\\sessions', socketPath: '\\\\.\\pipe\\local\\cc-msg-abc',
    hostSessionId: 'local_abc', image: 'claude.exe' });
  // A binding carries the verified fields and never a peer token.
  assert.ok(!('peerToken' in caller));
});

test('an unmappable peer is refused with a code and no fallback identity', async () => {
  await assert.rejects(resolveSocketCaller({ remotePort: 0 }, { tcpOwner: async () => null }), error => {
    assert.equal(error.code, 'caller-unresolved');
    assert.match(error.message, /only available to plugin-owned sessions/);
    return true;
  });
  await assert.rejects(resolveSocketCaller({ remotePort: 51000 }, {
    tcpOwner: async () => 999999, readRecord: async () => null, parentOf: async () => null,
    startTime: async () => null,
  }), error => error.code === 'caller-unresolved');
});

test('session records are read from the Claude configuration root and never from key files', () => {
  const file = sessionRecordPath(50124, { env: { CLAUDE_CONFIG_DIR: 'D:\\tmp\\claude-config' } });
  assert.equal(file, path.join('D:\\tmp\\claude-config', 'sessions', '50124.json'));
  assert.ok(!/\.key$/.test(file));
});
