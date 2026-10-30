import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProfile, listProfiles, loadConfig } from '../src/config.mjs';
import { createControl } from '../src/control.mjs';
import { notifyCodex } from '../src/codex-notify.mjs';
import { makeServer } from '../src/mcp-server.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(root, '..', 'src', 'cli.mjs');
const run = promisify(execFile);
const mainThread = '11111111-1111-4111-8111-111111111111';
const alphaThread = '22222222-2222-4222-8222-222222222222';
const betaThread = '33333333-3333-4333-8333-333333333333';

async function fixture(t, overrides = {}) {
  const base = path.join(root, '..', 'clean', 'dsh-only-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'profiles-')); // Retained; no destructive test cleanup.
  const filename = path.join(directory, 'config.json');
  const workspace = path.join(directory, 'main');
  const original = JSON.stringify({
    workspace, futureaideSessionId: 'main-session', codexThreadId: mainThread,
    dataRoot: path.join(directory, 'desktop-data'), instanceFile: path.join(directory, 'unread-private-instance.json'),
    baseUrl: 'http://127.0.0.1:45678', timeoutMs: 1234, privateField: 'must-not-be-inherited-or-listed',
    ...overrides,
  }, null, 2);
  await writeFile(filename, original);
  return { directory, filename, workspace, original };
}

test('named profiles inherit only transport fields and leave the default byte-for-byte intact', async t => {
  const f = await fixture(t);
  const workspace = path.join(f.directory, 'alpha');
  const created = await createProfile({ profile: 'alpha', workspace }, f.filename);
  assert.equal(created.created, true);
  assert.equal(created.futureaideSessionId, null);
  assert.equal(created.codexThreadId, null);
  const config = await loadConfig(f.filename, 'alpha');
  assert.equal(config.workspace, workspace);
  assert.equal(config.dataRoot, path.join(f.directory, 'desktop-data'));
  assert.equal(config.timeoutMs, 1234);
  assert.equal(config.futureaideSessionId, undefined);
  assert.equal(config.codexThreadId, undefined);
  assert.equal(config.privateField, undefined);
  assert.equal(config.stateDirectory, path.join(f.directory, 'state', 'profiles', 'alpha'));
  const stored = JSON.parse(await readFile(path.join(f.directory, 'profiles', 'alpha.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['baseUrl', 'dataRoot', 'dshDataRoot', 'instanceFile', 'target', 'timeoutMs', 'workspace']);
  assert.equal(await readFile(f.filename, 'utf8'), f.original);
  assert.equal((await loadConfig(f.filename)).futureaideSessionId, 'main-session');
  assert.equal((await loadConfig(f.filename)).stateDirectory, path.join(f.directory, 'state'));
});

test('configuration defaults to DSH and rejects the removed host selectors', async t => {
  const f = await fixture(t);
  const missing = path.join(f.directory, 'absent-config.json');
  const defaults = await loadConfig(missing);
  assert.equal(defaults.target, 'dsh');
  assert.equal(defaults.dataRoot, defaults.dshDataRoot);
  assert.ok(!defaults.dataRoot.includes('.futureaide'));
  for (const target of ['auto', 'futureaide']) {
    await writeFile(f.filename, JSON.stringify({ target }));
    await assert.rejects(loadConfig(f.filename), /Only target=dsh/);
    await assert.rejects(createProfile({ profile: 'blocked-' + target, workspace: f.workspace }, f.filename), /Only target=dsh/);
  }
});

test('profile creation rejects traversal, reserved names, relative workspaces, and invalid targets', async t => {
  const f = await fixture(t);
  for (const profile of ['', '../escape', '..\\escape', '/absolute', 'a/b', 'a\\b', 'C:other', 'a.json', 'Alpha', 'con', 'nul', 'lpt1', 'x'.repeat(65)]) {
    await assert.rejects(createProfile({ profile, workspace: f.workspace }, f.filename), /Profile names/);
    await assert.rejects(loadConfig(f.filename, profile), /Profile names/);
  }
  await assert.rejects(createProfile({ profile: 'relative', workspace: 'relative/project' }, f.filename), /absolute path/);
  await assert.rejects(createProfile({ profile: 'invalid-target', workspace: f.workspace, codexThreadId: 'not-a-task-id' }, f.filename), /valid target Codex/);
  await assert.rejects(createProfile({ profile: 'invalid-session', workspace: f.workspace, futureaideSessionId: '' }, f.filename), /session ID/);
  assert.deepEqual(await readdir(f.directory), ['config.json']);
});

test('concurrent creation never overwrites an existing profile or changes the default', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    createProfile({ profile: 'same', workspace: path.join(f.directory, 'one') }, f.filename),
    createProfile({ profile: 'same', workspace: path.join(f.directory, 'two') }, f.filename),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /already exists/);
  const before = await readFile(path.join(f.directory, 'profiles', 'same.json'), 'utf8');
  await assert.rejects(createProfile({ profile: 'same', workspace: f.workspace }, f.filename), /already exists/);
  assert.equal(await readFile(path.join(f.directory, 'profiles', 'same.json'), 'utf8'), before);
  assert.equal(await readFile(f.filename, 'utf8'), f.original);
});

test('profile files cannot be redirected through a linked profiles directory', async t => {
  const f = await fixture(t);
  const redirected = path.join(f.directory, 'unrelated-storage');
  await mkdir(redirected);
  await symlink(redirected, path.join(f.directory, 'profiles'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createProfile({ profile: 'alpha', workspace: f.workspace }, f.filename), /not a link/);
  await assert.rejects(loadConfig(f.filename, 'alpha'), /not a link/);
  await assert.rejects(listProfiles(f.filename), /not a link/);
  assert.deepEqual(await readdir(redirected), []);
});

test('listing returns project targets without transport details and supports an exact profile filter', async t => {
  const f = await fixture(t);
  await createProfile({ profile: 'beta', workspace: path.join(f.directory, 'beta'), futureaideSessionId: 'beta-session', codexThreadId: betaThread }, f.filename);
  await createProfile({ profile: 'alpha', workspace: path.join(f.directory, 'alpha') }, f.filename);
  const result = await listProfiles(f.filename);
  assert.equal(result.defaultProfile.profile, null);
  assert.equal(result.defaultProfile.codexThreadId, mainThread);
  assert.deepEqual(result.items.map(item => item.profile), ['alpha', 'beta']);
  assert.equal(result.items[0].callbacksConfigured, false);
  assert.equal(result.items[1].callbacksConfigured, true);
  const visible = JSON.stringify(result);
  for (const hidden of ['unread-private-instance', 'must-not-be-inherited', '45678', 'timeoutMs', 'dataRoot']) assert.ok(!visible.includes(hidden));
  assert.deepEqual(await listProfiles(f.filename, 'beta'), { items: [result.items[1]] });
  await assert.rejects(listProfiles(f.filename, 'missing'), /does not exist/);
});

test('a missing default config permits independent profiles while invalid profile files fail closed', async t => {
  const f = await fixture(t);
  const filename = path.join(f.directory, 'independent', 'config.json');
  await createProfile({ profile: 'independent', workspace: f.workspace }, filename);
  assert.equal((await loadConfig(filename, 'independent')).workspace, f.workspace);
  assert.equal((await loadConfig(filename, 'independent')).codexThreadId, undefined);
  await assert.rejects(readFile(filename), { code: 'ENOENT' });
  const profileFile = path.join(f.directory, 'independent', 'profiles', 'independent.json');
  await writeFile(profileFile, 'invalid-private-content');
  await assert.rejects(loadConfig(filename, 'independent'), error => /Cannot parse/.test(error.message) && !error.message.includes('private-content'));
  await writeFile(profileFile, JSON.stringify({ futureaideSessionId: 'main-session' }));
  await assert.rejects(loadConfig(filename, 'independent'), /absolute path/);
});

async function mcpFixture(t) {
  const f = await fixture(t);
  const alphaWorkspace = path.join(f.directory, 'alpha');
  const betaWorkspace = path.join(f.directory, 'beta');
  await createProfile({ profile: 'alpha', workspace: alphaWorkspace, futureaideSessionId: 'alpha-session', codexThreadId: alphaThread }, f.filename);
  await createProfile({ profile: 'beta', workspace: betaWorkspace, futureaideSessionId: 'beta-session', codexThreadId: betaThread }, f.filename);
  const rows = [
    { sessionId: 'main-session', cwd: f.workspace, projections: { asOfSeq: 1 } },
    { sessionId: 'alpha-session', cwd: alphaWorkspace, projections: { asOfSeq: 2 } },
    { sessionId: 'beta-session', cwd: betaWorkspace, projections: { asOfSeq: 3 } },
    { sessionId: 'unrelated', cwd: f.directory, projections: { asOfSeq: 4 } },
  ];
  const calls = [];
  const notifications = [];
  const server = makeServer(undefined, { configPath: f.filename, controlFactory: config => createControl(config, {
    client: {
      listSessions: async () => ({ items: rows }), status: async () => ({ connected: true }),
      readSession: async (sessionId, options) => ({ sessionId, ...options, records: [], hasMore: false }),
      sendMessage: async (sessionId, message) => { calls.push({ kind: 'send', sessionId, message }); return { accepted: true }; },
      cancelSession: async sessionId => { calls.push({ kind: 'cancel', sessionId }); return { accepted: true }; },
      modelCatalog: async () => ({ workspace: config.workspace, groups: [] }),
    },
    notify: (selected, input) => notifyCodex(selected, input, { callTool: async (threadId, name, args) => {
      notifications.push({ threadId, name, args }); return { accepted: true };
    } }),
  }) });
  const client = new Client({ name: 'profile-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, value: JSON.parse(result.content[0].text) };
  };
  return { ...f, alphaWorkspace, betaWorkspace, calls, notifications, call, client };
}

test('MCP exposes optional per-call profiles on every existing tool with preserved read-only annotations', async t => {
  const f = await mcpFixture(t);
  const tools = (await f.client.listTools()).tools;
  assert.equal(tools.length, 29);
  for (const tool of tools.filter(tool => !['futureaide_profiles', 'futureaide_profile_create'].includes(tool.name) && !tool.name.endsWith('_agent') && tool.name !== 'futureaide_list_agents' && !/_(peer|peers|exchange|inbox)$/.test(tool.name))) {
    assert.ok(tool.inputSchema.properties.profile);
    assert.ok(!tool.inputSchema.required?.includes('profile'));
  }
  for (const name of ['futureaide_status', 'futureaide_sessions', 'futureaide_read', 'futureaide_wait', 'futureaide_models', 'futureaide_profiles']) {
    assert.equal(tools.find(tool => tool.name === name).annotations.readOnlyHint, true);
  }
  assert.equal(tools.find(tool => tool.name === 'futureaide_profile_create').annotations.readOnlyHint, false);
  const results = await Promise.all([
    f.call('futureaide_sessions', { profile: 'alpha' }), f.call('futureaide_sessions', { profile: 'beta' }), f.call('futureaide_sessions'),
  ]);
  assert.deepEqual(results.map(result => result.value.items.map(item => item.sessionId)), [['alpha-session'], ['beta-session'], ['main-session']]);
  assert.equal((await f.call('futureaide_status', { profile: 'beta' })).value.workspace, f.betaWorkspace);
  assert.equal((await f.call('futureaide_models', { profile: 'alpha' })).value.workspace, f.alphaWorkspace);
  assert.equal((await f.call('futureaide_sessions', { profile: 'missing' })).isError, true);
});

test('MCP reads and writes use only the selected profile with separate request receipts', async t => {
  const f = await mcpFixture(t);
  const read = await f.call('futureaide_read', { profile: 'beta', max_messages: 4 });
  assert.equal(read.value.sessionId, 'beta-session');
  assert.equal(read.value.maxMessages, 4);
  for (const name of ['futureaide_read', 'futureaide_send', 'futureaide_cancel']) {
    const result = await f.call(name, { profile: 'alpha', session_id: 'main-session', message: 'x', request_id: 'rejected' });
    assert.equal(result.isError, true);
    assert.match(result.value.message, /configured project/);
  }
  assert.deepEqual(f.calls, []);
  const results = await Promise.all(['alpha', 'beta'].map(profile => f.call('futureaide_send', { profile, message: 'fixture work', request_id: 'same-id', background: false })));
  assert.deepEqual(results.map(result => result.value.sessionId), ['alpha-session', 'beta-session']);
  assert.ok(results[0].value.receipt.startsWith(path.join(f.directory, 'state', 'profiles', 'alpha') + path.sep));
  assert.ok(results[1].value.receipt.startsWith(path.join(f.directory, 'state', 'profiles', 'beta') + path.sep));
  assert.equal((await f.call('futureaide_send', { profile: 'alpha', message: 'fixture work', request_id: 'same-id', background: false })).value.duplicate, true);
  assert.equal(f.calls.filter(call => call.kind === 'send').length, 2);
  await f.call('futureaide_cancel', { profile: 'beta', request_id: 'cancel-beta' });
  assert.deepEqual(f.calls.at(-1), { kind: 'cancel', sessionId: 'beta-session' });
  assert.equal((await f.call('futureaide_read')).value.sessionId, 'main-session');
});

test('MCP can create an unbound project profile and safely discover its sessions', async t => {
  const f = await mcpFixture(t);
  const result = await f.call('futureaide_profile_create', { profile: 'unbound', workspace: f.alphaWorkspace });
  assert.equal(result.isError, false);
  assert.equal(result.value.futureaideSessionId, null);
  assert.equal(result.value.codexThreadId, null);
  assert.deepEqual((await f.call('futureaide_sessions', { profile: 'unbound' })).value.items.map(item => item.sessionId), ['alpha-session']);
  assert.match((await f.call('futureaide_read', { profile: 'unbound' })).value.message, /Select a FutureAide session/);
  assert.equal((await f.call('futureaide_read', { profile: 'unbound', session_id: 'alpha-session' })).value.sessionId, 'alpha-session');
  const bound = await f.call('futureaide_profile_create', { profile: 'mcp-bound', workspace: f.alphaWorkspace, session_id: 'alpha-session', codex_thread_id: alphaThread });
  assert.equal(bound.value.futureaideSessionId, 'alpha-session');
  assert.equal(bound.value.codexThreadId, alphaThread);
  const profiles = await f.call('futureaide_profiles');
  assert.deepEqual(profiles.value.items.map(item => item.profile), ['alpha', 'beta', 'mcp-bound', 'unbound']);
  assert.equal((await f.call('futureaide_profile_create', { profile: 'unbound', workspace: f.workspace })).isError, true);
  assert.equal((await f.client.callTool({ name: 'futureaide_profile_create', arguments: { profile: '../escape', workspace: f.workspace } })).isError, true);
  assert.equal(await readFile(f.filename, 'utf8'), f.original);
});

test('MCP callback destinations belong to their own profiles and an unbound callback fails before delivery', async t => {
  const f = await mcpFixture(t);
  await createProfile({ profile: 'unbound', workspace: f.alphaWorkspace }, f.filename);
  const result = await f.call('futureaide_notify_codex', { profile: 'unbound', event: 'completed', summary: 'fixture report' });
  assert.equal(result.isError, true);
  assert.match(result.value.message, /No valid Codex target/);
  assert.equal(f.notifications.length, 0);
  const delivered = await Promise.all(['alpha', 'beta'].map(profile => f.call('futureaide_notify_codex', { profile, event: 'completed', summary: 'fixture report' })));
  assert.deepEqual(delivered.map(result => result.value.threadId), [alphaThread, betaThread]);
  assert.deepEqual(f.notifications.map(item => item.threadId).sort(), [alphaThread, betaThread].sort());
  assert.ok(f.notifications.every(item => item.args.threadId === item.threadId && item.threadId !== mainThread));
});

async function runCli(filename, args) {
  const env = { ...process.env };
  delete env.FUTUREAIDE_LAUNCH_URL;
  delete env.FUTUREAIDE_INSTANCE_FILE;
  try {
    const { stdout } = await run(process.execPath, [cli, '--config', filename, ...args], { env, windowsHide: true, timeout: 10000 });
    return { code: 0, value: JSON.parse(stdout) };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, value: JSON.parse(error.stderr || error.stdout) };
  }
}

test('CLI creates and lists profiles without a desktop or callback side effect', async t => {
  const f = await fixture(t);
  const workspace = path.join(f.directory, 'cli-project');
  const created = await runCli(f.filename, ['profile-create', '--profile', 'cli-project', '--workspace', workspace, '--session-id', 'cli-session', '--codex-thread-id', alphaThread]);
  assert.equal(created.code, 0);
  assert.equal(created.value.codexThreadId, alphaThread);
  assert.equal(created.value.futureaideSessionId, 'cli-session');
  const listed = await runCli(f.filename, ['profiles', '--profile', 'cli-project']);
  assert.equal(listed.value.items[0].workspace, workspace);
  assert.equal((await runCli(f.filename, ['profile-create', '--profile', 'cli-project', '--workspace', workspace])).code, 1);
  assert.equal((await runCli(f.filename, ['profile-create', '--profile', '../escape', '--workspace', workspace])).code, 1);
  assert.equal((await runCli(f.filename, ['profiles', '--profile', 'missing'])).code, 1);
  await runCli(f.filename, ['profile-create', '--profile', 'no-callback', '--workspace', workspace]);
  const rejected = await runCli(f.filename, ['notify', '--profile', 'no-callback', '--event', 'completed', '--summary', 'fixture report']);
  assert.equal(rejected.code, 1);
  assert.match(rejected.value.message, /No valid Codex target/);
  assert.equal(await readFile(f.filename, 'utf8'), f.original);
});

test('the runnable CLI selects a profile against a local RPC fixture and retains the default', async t => {
  const f = await fixture(t);
  const workspace = path.join(f.directory, 'cli-project');
  const rpcMethods = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-profile=fixture-cookie; Path=/; HttpOnly' });
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    rpcMethods.push(body.method);
    const value = body.method === 'session/list' ? { items: [
      { sessionId: 'main-session', cwd: f.workspace, projections: { asOfSeq: 1 } },
      { sessionId: 'cli-session', cwd: workspace, projections: { asOfSeq: 2 } },
    ] } : { records: [], hasMore: false };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const instanceFile = path.join(f.directory, 'fixture-instance.json');
  await writeFile(instanceFile, JSON.stringify({ version: 1, application: 'dsh', dataRoot: f.directory, instanceId: mainThread, launchUrl: `${baseUrl}/?token=fixture-token`, pid: process.pid }));
  await writeFile(f.filename, JSON.stringify({ ...JSON.parse(f.original), baseUrl, instanceFile }));
  const created = await runCli(f.filename, ['profile-create', '--profile', 'cli-project', '--workspace', workspace]);
  assert.equal(created.code, 0);
  const selected = await runCli(f.filename, ['sessions', '--profile', 'cli-project']);
  assert.equal(selected.code, 0);
  assert.deepEqual(selected.value.items.map(item => item.sessionId), ['cli-session']);
  const read = await runCli(f.filename, ['read', '--profile', 'cli-project', '--session-id', 'cli-session', '--max-messages', '3']);
  assert.equal(read.code, 0);
  const rejected = await runCli(f.filename, ['read', '--profile', 'cli-project', '--session-id', 'main-session']);
  assert.equal(rejected.code, 1);
  assert.match(rejected.value.message, /configured project/);
  const defaultResult = await runCli(f.filename, ['sessions']);
  assert.deepEqual(defaultResult.value.items.map(item => item.sessionId), ['main-session']);
  assert.ok(rpcMethods.every(method => ['session/list', 'session/page'].includes(method)));
});
