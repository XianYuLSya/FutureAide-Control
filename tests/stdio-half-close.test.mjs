// P1 regression: the host half-closes stdin while a request is still being answered.
// Real child processes, real pipes, real entry files, and a loopback tool service that
// this test hosts itself (nothing outside `tests/`).
//   - src/mcp-server.mjs (scoped surface): a gated status handler proves the
//     real MCP request has entered the service before the host closes stdin;
//   - src/claude-report-bootstrap.mjs (Claude-side bridge): the answer comes back over
//     the loopback service, which writes durably and only then answers, on a delay this
//     test owns. That is the case an immediate exit loses.
// The fix must not be "sleep a fixed time": it waits for the SDK's own writes to finish.
// FUTUREAIDE_TEST_SRC points the child at another copy of src for red/green evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RosterStore } from '../src/roster-store.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.FUTUREAIDE_TEST_SRC ? path.resolve(process.env.FUTUREAIDE_TEST_SRC) : path.join(REPO, 'src');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function fixture(label) {
  mkdirSync(path.join(REPO, '.runtime', 'tests'), { recursive: true });
  const root = mkdtempSync(path.join(REPO, '.runtime', 'tests', `half-close-${label}-`));
  for (const dir of ['codex/futureaide-control/state', 'dsh', 'claude', 'workspace']) mkdirSync(path.join(root, dir), { recursive: true });
  const configFile = path.join(root, 'codex', 'futureaide-control', 'config.json');
  const config = { dataRoot: path.join(root, 'dsh'), dshDataRoot: path.join(root, 'dsh'),
    workspace: path.join(root, 'workspace') };
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  const roster = path.join(root, 'codex', 'futureaide-control', 'state', 'roster.sqlite');
  return { root, configFile, config, roster,
    env: { ...process.env, CODEX_HOME: path.join(root, 'codex'), DSH_HOME: path.join(root, 'dsh'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), DSH_CONTROL_CONFIG: configFile },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A durable write: the bytes are on disk before the caller is answered. */
function durableWrite(file, text) {
  const fd = openSync(file, 'a');
  try { writeSync(fd, `${text}\n`); } finally { closeSync(fd); }
}

/**
 * The loopback tool service the Claude bridge talks to. It delays its answer and writes
 * durably first, so the forwarded call is provably mid-flight when stdin closes.
 */
async function startToolService({ rosterIdentity, marker, delayMs }) {
  let lists = 0;
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url.startsWith('/healthz')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, port: server.address().port, roster: rosterIdentity }));
      return;
    }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      let message;
      try { message = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
      const answer = (payload, headers = {}) => {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session', ...headers });
        response.end(JSON.stringify(payload));
      };
      if (message.method === 'initialize') {
        answer({ jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} },
            serverInfo: { name: 'fixture-tool-service', version: '1.0.0' } } });
        return;
      }
      if (message.method === 'notifications/initialized' || message.method?.startsWith('notifications/')) {
        response.writeHead(202).end();
        return;
      }
      if (message.method === 'tools/list') {
        await sleep(delayMs * ++lists);
        durableWrite(marker, `tools/list ${Date.now()}`);
        answer({ jsonrpc: '2.0', id: message.id,
          result: { tools: [{ name: 'fixture_slow', description: 'Answers after writing durably.',
            inputSchema: { type: 'object', properties: {} } }] } });
        return;
      }
      if (message.method === 'tools/call') {
        await sleep(delayMs);
        durableWrite(marker, `tools/call ${Date.now()}`);
        answer({ jsonrpc: '2.0', id: message.id,
          result: { content: [{ type: 'text', text: 'written' }] } });
        return;
      }
      answer({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

/** One MCP child over real pipes, recording which answer arrived before which event. */
function child(script, args, env) {
  const process_ = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const state = { child: process_, events: [], answers: new Map(), stderr: '', exitedAt: undefined, startedAt: Date.now() };
  let buffer = '';
  process_.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        state.answers.set(message.id, { message, at: Date.now() });
        state.events.push(`answer#${message.id}@${Date.now() - state.startedAt}ms`);
      }
    }
  });
  process_.stderr.on('data', chunk => { state.stderr += String(chunk); });
  process_.on('exit', (code, signal) => { state.exitedAt = Date.now(); state.exitCode = code; state.signal = signal;
    state.events.push(`exit(${code})@${Date.now() - state.startedAt}ms`); });
  let nextId = 0;
  state.request = (method, params, timeoutMs = 30000) => {
    const id = ++nextId;
    const promise = new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        if (state.answers.has(id)) { clearInterval(poll); resolve(state.answers.get(id).message); }
        else if (Date.now() > deadline) { clearInterval(poll); reject(new Error(`timeout waiting for ${method} (id ${id})`)); }
      }, 5);
      poll.unref?.();
    });
    process_.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise;
  };
  state.send = (method, params) => {
    const id = ++nextId;
    process_.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    state.events.push(`sent#${id}@${Date.now() - state.startedAt}ms`);
    return id;
  };
  return state;
}

const waitExit = async (state, limitMs) => {
  for (let waited = 0; waited <= limitMs; waited += 25) {
    if (state.exitedAt !== undefined) return true;
    await sleep(25);
  }
  return false;
};

const waitForFile = async (run, file) => {
  const deadline = Date.now() + 5000;
  while (!existsSync(file) && run.exitedAt === undefined && Date.now() < deadline) await sleep(25);
  assert.ok(existsSync(file), `the child did not reach ${path.basename(file)}: ${run.stderr}`);
};

test('mcp-server: an answer that is in flight when stdin closes is written before the process ends', async () => {
  const fx = fixture('mcp');
  const loader = path.join(fx.root, 'gated-status.mjs');
  const started = path.join(fx.root, 'status-started');
  const gate = path.join(fx.root, 'status-continue');
  const serviceUrl = pathToFileURL(path.join(SRC, 'scoped-agents.mjs')).href;
  const source = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    export function createScopedAgents() {
      return { async status() {
        writeFileSync(${JSON.stringify(started)}, '');
        while (!existsSync(${JSON.stringify(gate)})) await delay(15);
        return { ready: true, contextVerified: true };
      } };
    }
  `;
  writeFileSync(loader, `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      if (url === ${JSON.stringify(serviceUrl)}) {
        return { format: 'module', shortCircuit: true, source: ${JSON.stringify(source)} };
      }
      return next(url, context);
    } });
  `);
  const run = child(path.join(SRC, 'mcp-server.mjs'), [], {
    ...fx.env, NODE_OPTIONS: `--import=${pathToFileURL(loader).href}`,
  });
  try {
    await run.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'half-close', version: '1' } });
    run.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await run.request('tools/list', {});

    const inFlightId = run.send('tools/call', { name: 'futureaide_status', arguments: {} });
    await waitForFile(run, started);
    const closedAt = Date.now();
    run.child.stdin.end();
    await sleep(200);
    writeFileSync(gate, '');

    const exited = await waitExit(run, 40000);
    assert.ok(exited, `the process ends by itself after its answer; events=${run.events.join(' ')} stderr=${run.stderr.slice(-300)}`);
    assert.equal(run.exitCode, 0, 'normal exit code');

    const answer = run.answers.get(inFlightId);
    assert.ok(answer, `the in-flight call was answered after stdin closed; events=${run.events.join(' ')}`);
    assert.ok(answer.at - closedAt >= 150, 'the call was still in flight after the pipe closed');
    assert.ok(answer.at <= run.exitedAt + 5, `the answer was written before the exit; events=${run.events.join(' ')}`);
    assert.ok(answer.message.result?.content?.length > 0, 'the answer carries a tool result');
  } finally {
    if (run.exitedAt === undefined) run.child.kill();
    fx.cleanup();
  }
});

test('claude report bootstrap: all forwarded answers in flight survive stdin closing', async () => {
  const fx = fixture('bridge');
  const marker = path.join(fx.root, 'service-durable.log');
  let rosterIdentity;
  try {
    const store = new RosterStore(fx.roster);
    rosterIdentity = store.identity();
    store.close();
  } catch { rosterIdentity = undefined; }

  const service = await startToolService({ rosterIdentity, marker, delayMs: 400 });
  writeFileSync(fx.configFile, JSON.stringify({ ...fx.config, reportPort: service.port }, null, 2));
  const run = child(path.join(SRC, 'claude-report-bootstrap.mjs'), ['--config', fx.configFile], fx.env);
  try {
    await run.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bridge-half-close', version: '1' } });
    run.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const sentAt = Date.now();
    const inFlightIds = [run.send('tools/list', {}), run.send('tools/list', {})];
    run.child.stdin.end();

    const exited = await waitExit(run, 40000);
    assert.ok(exited, `the bridge ends by itself after its answer; events=${run.events.join(' ')} stderr=${run.stderr.slice(-300)}`);
    assert.equal(run.exitCode, 0, 'normal exit code');
    for (const id of inFlightIds) {
      const answer = run.answers.get(id);
      assert.ok(answer, `the forwarded list ${id} was answered after stdin closed; events=${run.events.join(' ')}`);
      assert.ok(answer.at - sentAt >= 150, `the forwarded call was still in flight (${answer.at - sentAt}ms)`);
      assert.ok(answer.at <= run.exitedAt + 5, `the answer was written before the exit; events=${run.events.join(' ')}`);
    }
    // The service wrote durably before it answered, and the answer still reached the host.
    assert.ok(existsSync(marker), 'the service wrote durably before answering');
    assert.match(readFileSync(marker, 'utf8'), /tools\/list/);
  } finally {
    if (run.exitedAt === undefined) run.child.kill();
    await service.close();
    fx.cleanup();
  }
});

test('a cancelled SDK ping leaves the EOF wait without a reply', async () => {
  const fx = fixture('cancelled');
  const run = child(path.join(SRC, 'mcp-server.mjs'), [], fx.env);
  try {
    await run.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'half-close', version: '1' } });
    await run.request('ping', {});
    // One chunk guarantees the SDK sees the cancellation before the ping handler
    // can run its microtask and respond.
    run.child.stdin.end([
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3, reason: 'fixture' } },
    ].map(message => JSON.stringify(message) + '\n').join(''));
    assert.ok(await waitExit(run, 3500), 'a cancelled ping cannot hold EOF for the ten-second response deadline');
    assert.equal(run.answers.has(3), false, 'the SDK actually cancelled the request');
    assert.equal(run.exitCode, 0);
  } finally {
    if (run.exitedAt === undefined) {
      const closed = new Promise(resolve => run.child.once('close', resolve));
      run.child.kill();
      await closed;
    }
    fx.cleanup();
  }
});

test('the MCP entry honours a disabled switch when EOF arrives during configuration read', async () => {
  const fx = fixture('switch');
  const loading = path.join(fx.root, 'config-loading');
  const gate = path.join(fx.root, 'config-continue');
  const loaded = path.join(fx.root, 'config-loaded');
  const loader = path.join(fx.root, 'delay-config.mjs');
  writeFileSync(fx.configFile, JSON.stringify({ ...fx.config, idleSessionCleanup: false }));
  const configUrl = pathToFileURL(path.join(SRC, 'config.mjs')).href;
  const delayConfig = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    export async function loadConfig(...args) {
      writeFileSync(${JSON.stringify(loading)}, '');
      while (!existsSync(${JSON.stringify(gate)})) await delay(15);
      const config = await originalLoadConfig(...args);
      writeFileSync(${JSON.stringify(loaded)}, String(config.idleSessionCleanup));
      return config;
    }
  `;
  writeFileSync(loader, `import { registerHooks } from 'node:module';
    setInterval(() => {}, 1000);
    registerHooks({
      load(url, context, next) {
        const actual = next(url, context);
        if (url !== ${JSON.stringify(configUrl)}) return actual;
        const source = String(actual.source).replace('export async function loadConfig(', 'async function originalLoadConfig(');
        return { ...actual, source: source + ${JSON.stringify(delayConfig)} };
      },
    });
  `);
  const run = child(path.join(SRC, 'mcp-server.mjs'), [], {
    ...fx.env, NODE_OPTIONS: `--import=${pathToFileURL(loader).href}`,
  });
  try {
    await waitForFile(run, loading);
    run.child.stdin.end();
    assert.equal(await waitExit(run, 500), false, 'EOF cannot exit before the switch is known');
    writeFileSync(gate, '');
    await waitForFile(run, loaded);
    assert.equal(readFileSync(loaded, 'utf8'), 'false');
    assert.equal(await waitExit(run, 500), false, 'disabled cleanup leaves the old stdio lifetime');
  } finally {
    if (run.exitedAt === undefined) {
      const closed = new Promise(resolve => run.child.once('close', resolve));
      run.child.kill();
      await closed;
    }
    fx.cleanup();
  }
});

test('both entries still end promptly when nothing is in flight', async () => {
  const fx = fixture('idle');
  const run = child(path.join(SRC, 'mcp-server.mjs'), [], fx.env);
  try {
    await run.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'idle', version: '1' } });
    const closedAt = Date.now();
    run.child.stdin.end();
    const exited = await waitExit(run, 20000);
    assert.ok(exited, `idle connection ends after stdin closes; events=${run.events.join(' ')}`);
    assert.ok(Date.now() - closedAt < 5000, `idle exit is prompt, not a grace wait (${Date.now() - closedAt}ms)`);
  } finally {
    if (run.exitedAt === undefined) run.child.kill();
    fx.cleanup();
  }
});

