import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { discoverCodexBridge, notificationText, notifyCodex, parseBridgePipe, parseInspection, probeAppToolsBridge } from '../src/codex-notify.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const windows = process.platform === 'win32';
const entryPoint = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_1.0.0.0_x64__test\app\resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs`;
const secondEntryPoint = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_2.0.0.0_x64__test\app\resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs`;
const bridgePipe = uuid => String.raw`\\.\pipe\codex-browser-use-` + uuid;
const appToolsPipe = uuid => String.raw`\\.\pipe\codex-app-tools-` + uuid;
const inheritedPipe = bridgePipe('01a120c5-09b1-7292-845c-c8297c1bc17a');
const legacyPipe = bridgePipe('7c1520d3-9316-4f8d-8665-bd70f8adde79');
const probedPipe = bridgePipe('e55bf1a8-5d67-42a8-af87-d15718b6dc57');
const secondProbedPipe = bridgePipe('cb804170-9576-4c32-aa27-1c1bfb53ff45');
const currentPipe = appToolsPipe('dbca54af-0c6d-4b29-bd13-bd73f15f6a8c');
const frame = value => {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
};
// A stand-in for the desktop's pipe service: the same length-prefixed JSON-RPC the desktop speaks.
async function servePipe(t, answer) {
  const pipePath = bridgePipe(randomUUID());
  const requests = [];
  const closed = [];
  const server = net.createServer(socket => {
    let received = Buffer.alloc(0);
    socket.on('close', () => closed.push(true));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      while (received.length >= 4) {
        const length = received.readUInt32LE(0);
        if (received.length < length + 4) return;
        requests.push(JSON.parse(received.subarray(4, length + 4).toString('utf8')));
        received = received.subarray(length + 4);
        const reply = answer(requests.length);
        if (reply) socket.write(reply);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { pipePath, requests, closed };
}
async function setup(t) {
  const workspace = await mkdtemp(path.join(testRoot, '.notify-test-'));
  t.after(async () => {
    assert.ok(workspace.startsWith(testRoot + path.sep));
    await rm(workspace, { recursive: true, force: true });
  });
  return { workspace, stateDirectory: path.join(workspace, 'state'), codexThreadId: '11111111-1111-4111-8111-111111111111', futureaideSessionId: 'parent-session' };
}

test('completion is a request for verification, not an acceptance claim', () => {
  const text = notificationText({ workspace: 'another-project' }, { event: 'completed', summary: 'done' });
  assert.match(text, /尚待独立验收/);
  assert.doesNotMatch(text, /Codex监督与接口\/目标\.md/);
});

test('an identical completion is delivered only once, even concurrently', async t => {
  const config = await setup(t);
  await writeFile(path.join(config.workspace, 'evidence.md'), 'verified build');
  let calls = 0;
  const callTool = async (threadId, name, args) => {
    calls++;
    assert.equal(name, 'send_message_to_thread');
    assert.equal(threadId, config.codexThreadId);
    assert.equal(args.threadId, config.codexThreadId);
  };
  const input = { event: 'completed', summary: 'ready', evidence: 'evidence.md' };
  const results = await Promise.all([notifyCodex(config, input, { callTool }), notifyCodex(config, input, { callTool })]);
  assert.equal(calls, 1);
  assert.ok(results.some(result => result.delivered));
  const duplicate = await notifyCodex(config, input, { callTool });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.delivered, true);
});

test('unknown delivery is retained and never silently resent', async t => {
  const config = await setup(t);
  let calls = 0;
  const callTool = async () => { calls++; throw new Error('connection ended'); };
  const input = { event: 'blocked', summary: 'needs repair' };
  await assert.rejects(notifyCodex(config, input, { callTool }), /unconfirmed/);
  const duplicate = await notifyCodex(config, input, { callTool });
  assert.equal(duplicate.status, 'unknown');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(duplicate.receipt, 'utf8')).status, 'unknown');
});

test('evidence cannot escape the project', async t => {
  const config = await setup(t);
  await assert.rejects(notifyCodex(config, { event: 'completed', summary: 'done', evidence: '../outside.md' }), /configured project/);
});

test('only the desktop\'s own pipe name counts as an inherited bridge', () => {
  assert.equal(parseBridgePipe(inheritedPipe), inheritedPipe);
  assert.equal(parseBridgePipe(`  ${inheritedPipe}  `), inheritedPipe);
  assert.equal(parseBridgePipe(currentPipe), currentPipe);
  assert.equal(parseBridgePipe(`  ${currentPipe}  `), currentPipe);
  for (const value of [undefined, null, '', '01a120c5-09b1-7292-845c-c8297c1bc17a',
    String.raw`\\.\pipe\codex-browser-use-not-a-uuid`, String.raw`\\.\pipe\codex-app-tools-not-a-uuid`,
    String.raw`\\.\pipe\another-bridge-01a120c5-09b1-7292-845c-c8297c1bc17a`,
    String.raw`\\pipe\codex-browser-use-01a120c5-09b1-7292-845c-c8297c1bc17a`,
    String.raw`\\pipe\codex-app-tools-01a120c5-09b1-7292-845c-c8297c1bc17a`, 42]) {
    assert.equal(parseBridgePipe(value), null, String(value));
  }
});

test('the current app-tools pipe selects the bundled bridge of its own desktop', { skip: !windows }, async () => {
  const bridge = await discoverCodexBridge({ environment: { CODEX_APP_TOOLS_PIPE_PATH: currentPipe },
    inspect: async () => ({ hosted: [entryPoint], legacy: [] }) });
  assert.deepEqual(bridge, { serverPath: entryPoint, pipePath: currentPipe });
});

test('an inherited pipe selects the bundled bridge of its own desktop', { skip: !windows }, async () => {
  let inspections = 0;
  const inspect = async () => { inspections++; return { hosted: [entryPoint, entryPoint], legacy: [] }; };
  const bridge = await discoverCodexBridge({ environment: { CODEX_APP_TOOLS_PIPE_PATH: inheritedPipe }, inspect });
  assert.deepEqual(bridge, { serverPath: entryPoint, pipePath: inheritedPipe });
  assert.equal(inspections, 1);
});

test('the inherited pipe is read from the process environment by default', { skip: !windows }, async () => {
  const previous = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  process.env.CODEX_APP_TOOLS_PIPE_PATH = inheritedPipe;
  try {
    const bridge = await discoverCodexBridge({ inspect: async () => ({ hosted: [entryPoint], legacy: [] }) });
    assert.deepEqual(bridge, { serverPath: entryPoint, pipePath: inheritedPipe });
  } finally {
    if (previous === undefined) delete process.env.CODEX_APP_TOOLS_PIPE_PATH;
    else process.env.CODEX_APP_TOOLS_PIPE_PATH = previous;
  }
});

test('several running desktops fail instead of being guessed', { skip: !windows }, async () => {
  await assert.rejects(
    discoverCodexBridge({ environment: { CODEX_APP_TOOLS_PIPE_PATH: inheritedPipe }, inspect: async () => ({ hosted: [entryPoint, secondEntryPoint], legacy: [] }) }),
    /refusing to guess/);
  await assert.rejects(
    discoverCodexBridge({ environment: {}, inspect: async () => ({ hosted: [], legacy: [
      { serverPath: entryPoint, pipePath: inheritedPipe }, { serverPath: secondEntryPoint, pipePath: legacyPipe },
    ] }) }),
    /refusing to guess/);
});

test('without an inherited pipe the older command-line bridge is used', { skip: !windows }, async () => {
  const legacy = [{ serverPath: entryPoint, pipePath: legacyPipe }];
  assert.deepEqual(await discoverCodexBridge({ environment: {}, inspect: async () => ({ hosted: [], legacy }) }), legacy[0]);
  assert.deepEqual(
    await discoverCodexBridge({ environment: {}, inspect: async () => ({ hosted: [], legacy: [{ serverPath: entryPoint, pipePath: currentPipe }] }) }),
    { serverPath: entryPoint, pipePath: currentPipe });
  assert.deepEqual(
    await discoverCodexBridge({ environment: { CODEX_APP_TOOLS_PIPE_PATH: inheritedPipe }, inspect: async () => ({ hosted: [], legacy }) }),
    legacy[0], 'a missing local entry point still falls back to the legacy pair');
});

test('a foreign inherited pipe fails instead of falling back to another desktop', { skip: !windows }, async () => {
  let inspections = 0;
  await assert.rejects(
    discoverCodexBridge({ environment: { CODEX_APP_TOOLS_PIPE_PATH: String.raw`\\.\pipe\some-other-bridge` },
      inspect: async () => { inspections++; return { hosted: [entryPoint], legacy: [] }; } }),
    /CODEX_APP_TOOLS_PIPE_PATH/);
  assert.equal(inspections, 0);
});

test('unusable candidates and an unavailable inspector report no bridge', { skip: !windows }, async () => {
  await assert.rejects(
    discoverCodexBridge({ environment: {}, inspect: async () => ({ hosted: [], legacy: [{ serverPath: entryPoint, pipePath: 'codex-browser-use-01a120c5-09b1-7292-845c-c8297c1bc17a' }] }) }),
    /bridge is unavailable/);
  await assert.rejects(
    discoverCodexBridge({ environment: {}, inspect: async () => { throw new Error('powershell.exe is missing'); } }),
    /bridge is unavailable/);
});

test('the inspected payload keeps the owner candidates the selection needs', () => {
  const candidates = [{ serverPath: entryPoint, pipePath: probedPipe }];
  assert.deepEqual(
    parseInspection(JSON.stringify({ hosted: [entryPoint], legacy: [], candidates })),
    { hosted: [entryPoint], legacy: [], candidates });
  assert.deepEqual(parseInspection('{}'), { hosted: [], legacy: [], candidates: [] });
});

test('a pipe that answers a real app-tools list is recognised and closed again', { skip: !windows }, async t => {
  const tools = { tools: [{ name: 'read_thread' }, { name: 'send_message_to_thread' }] };
  const bridge = await servePipe(t, count => frame({ id: count, jsonrpc: '2.0', result: tools }));
  assert.equal(await probeAppToolsBridge(bridge.pipePath), true);
  assert.deepEqual(bridge.requests, [{ id: 1, jsonrpc: '2.0', method: 'tools/list' }]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(bridge.closed.length, 1);
});

test('anything else on the pipe is not a bridge', { skip: !windows }, async t => {
  const refusal = await servePipe(t, count => frame({ id: count, jsonrpc: '2.0', error: { code: -1, message: 'No handler registered for method: tools/list' } }));
  assert.equal(await probeAppToolsBridge(refusal.pipePath), false);
  const empty = await servePipe(t, count => frame({ id: count, jsonrpc: '2.0', result: { tools: [] } }));
  assert.equal(await probeAppToolsBridge(empty.pipePath), false);
  const silent = await servePipe(t, () => null);
  assert.equal(await probeAppToolsBridge(silent.pipePath, { timeout: 150 }), false);
  assert.equal(await probeAppToolsBridge(bridgePipe(randomUUID()), { timeout: 150 }), false);
});

test('without an inherited pipe the probed bridge of this desktop is selected', { skip: !windows }, async () => {
  const probed = [];
  const bridge = await discoverCodexBridge({ environment: {},
    probe: async pipePath => { probed.push(pipePath); return pipePath === secondProbedPipe; },
    inspect: async () => ({ hosted: [entryPoint], legacy: [], candidates: [
      { serverPath: entryPoint, pipePath: probedPipe },
      { serverPath: entryPoint, pipePath: secondProbedPipe }] }) });
  assert.deepEqual(bridge, { serverPath: entryPoint, pipePath: secondProbedPipe });
  assert.deepEqual(probed.sort(), [probedPipe, secondProbedPipe].sort());
});

test('without an inherited pipe a probed app-tools bridge is selected', { skip: !windows }, async () => {
  const otherPipe = appToolsPipe('e55bf1a8-5d67-42a8-af87-d15718b6dc57');
  const probed = [];
  const bridge = await discoverCodexBridge({ environment: {},
    probe: async pipePath => { probed.push(pipePath); return pipePath === currentPipe; },
    inspect: async () => ({ hosted: [entryPoint], legacy: [], candidates: [
      { serverPath: entryPoint, pipePath: otherPipe },
      { serverPath: entryPoint, pipePath: currentPipe }] }) });
  assert.deepEqual(bridge, { serverPath: entryPoint, pipePath: currentPipe });
  assert.deepEqual(probed.sort(), [otherPipe, currentPipe].sort());
});

test('an inherited pipe is used without probing anything', { skip: !windows }, async () => {
  let probes = 0;
  const bridge = await discoverCodexBridge({ environment: { CODEX_APP_TOOLS_PIPE_PATH: inheritedPipe },
    probe: async () => { probes++; return true; },
    inspect: async () => ({ hosted: [entryPoint], legacy: [], candidates: [{ serverPath: entryPoint, pipePath: probedPipe }] }) });
  assert.deepEqual(bridge, { serverPath: entryPoint, pipePath: inheritedPipe });
  assert.equal(probes, 0);
});

test('two bridges that answer for this desktop are refused instead of guessed', { skip: !windows }, async () => {
  await assert.rejects(
    discoverCodexBridge({ environment: {}, probe: async () => true,
      inspect: async () => ({ hosted: [entryPoint], legacy: [{ serverPath: entryPoint, pipePath: legacyPipe }], candidates: [
        { serverPath: entryPoint, pipePath: probedPipe },
        { serverPath: entryPoint, pipePath: secondProbedPipe }] }) }),
    /refusing to guess/);
});

test('an unanswered probe falls back to the older command-line bridge, and fails without one', { skip: !windows }, async () => {
  const candidates = [{ serverPath: entryPoint, pipePath: probedPipe }];
  const silent = async () => false;
  assert.deepEqual(
    await discoverCodexBridge({ environment: {}, probe: silent, inspect: async () => ({ hosted: [entryPoint], legacy: [{ serverPath: entryPoint, pipePath: legacyPipe }], candidates }) }),
    { serverPath: entryPoint, pipePath: legacyPipe });
  await assert.rejects(
    discoverCodexBridge({ environment: {}, probe: silent, inspect: async () => ({ hosted: [entryPoint], legacy: [], candidates }) }),
    /bridge is unavailable/);
});

test('a probe that fails on one candidate never hides another', { skip: !windows }, async () => {
  const bridge = await discoverCodexBridge({ environment: {},
    probe: async pipePath => { if (pipePath === probedPipe) throw new Error('pipe closed'); return true; },
    inspect: async () => ({ hosted: [entryPoint], legacy: [], candidates: [
      { serverPath: entryPoint, pipePath: probedPipe },
      { serverPath: entryPoint, pipePath: secondProbedPipe }] }) });
  assert.deepEqual(bridge, { serverPath: entryPoint, pipePath: secondProbedPipe });
});

test('candidates outside this desktop are never probed or selected', { skip: !windows }, async () => {
  let probes = 0;
  await assert.rejects(
    discoverCodexBridge({ environment: {}, probe: async () => { probes++; return true; },
      inspect: async () => ({ hosted: [entryPoint], legacy: [], candidates: [
        { serverPath: entryPoint, pipePath: String.raw`\\.\pipe\some-other-bridge` },
        { serverPath: secondEntryPoint, pipePath: 'codex-browser-use-01a120c5-09b1-7292-845c-c8297c1bc17a' }] }) }),
    /bridge is unavailable/);
  assert.equal(probes, 0);
});
