import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgents } from '../src/agents.mjs';
import { createControl } from '../src/control.mjs';
import { loadConfig } from '../src/config.mjs';
import { makeServer } from '../src/mcp-server.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const BASE_THREAD = '22222222-2222-4222-8222-222222222222';
const BOUND_THREAD = '33333333-3333-4333-8333-333333333333';
const event = (seq, type, data = {}) => ({ type: 'event', event: { seq, type, data } });
const catalog = { default: { provider: 'wb', model: 'flash', reasoningEffort: 'max' }, routableProviders: ['wb'],
  groups: [{ id: 'wb', models: [{ id: 'flash', reasoning: { efforts: [{ id: 'max' }] } }] }] };

/** A local host fixture plus the real MCP entry point over an in-memory transport. */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-callback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ workspace: root, futureaideSessionId: 'parent', codexThreadId: BASE_THREAD }));
  const rows = [], pages = new Map();
  const client = {
    status: async () => ({ connected: true, pid: 123 }),
    hostStatus: async () => ({ version: 1, methods: ['capabilities', 'historyCursor'], pid: 123 }),
    connectionIdentity: async () => ({ baseUrl: 'http://127.0.0.1:12345', pid: 123, instanceFile: path.join(root, 'instance.json') }),
    modelCatalog: async () => catalog,
    listSessions: async () => ({ items: rows }),
    createProjectSession: async input => {
      rows.push({ sessionId: input.sessionId, cwd: input.cwd, running: false, projections: { asOfSeq: 0 } });
      pages.set(input.sessionId, []);
      return { accepted: true, sessionId: input.sessionId };
    },
    selectModel: async () => ({ accepted: true }),
    sendMessage: async (id, message, { requestId }) => {
      const page = pages.get(id), turn = page.length + 1, first = page.length + 1;
      page.push(event(first, 'turn/start', { turn }),
        event(first + 1, 'user/message', { source: { rpcId: requestId }, content: [{ type: 'text', text: message }] }),
        event(first + 2, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'reply:' + message }] } }),
        event(first + 3, 'turn/end', { turn, reason: { kind: 'completed' } }));
      rows.find(row => row.sessionId === id).projections.asOfSeq = page.at(-1).event.seq;
      return { accepted: true };
    },
    readSession: async id => ({ records: pages.get(id), hasMore: false }),
  };
  const spawned = [], configs = [];
  // startWorker is injected so no detached watcher and no Codex notification ever runs in tests.
  const controlFactory = config => {
    configs.push(config);
    return createControl(config, { client, startWorker: args => { spawned.push(args); return { pid: 4242 }; } });
  };
  const server = makeServer(undefined, { configPath, controlFactory });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'futureaide-control-test', version: '0.0.0' });
  await mcp.connect(clientTransport);
  t.after(async () => { await mcp.close(); await server.close(); });
  const call = async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args })
      .catch(error => ({ isError: true, content: [{ type: 'text', text: String(error.message) }] }));
    let value;
    try { value = JSON.parse(result.content[0].text); } catch { value = { message: result.content[0].text }; }
    return { isError: Boolean(result.isError), value };
  };
  const agents = createAgents(await loadConfig(configPath), { controlFactory });
  const flag = name => {
    const index = spawned.at(-1).indexOf(name);
    return index === -1 ? undefined : spawned.at(-1)[index + 1];
  };
  const record = async agentId => JSON.parse(await readFile(path.join(root, 'agents', agentId, 'agent.json'), 'utf8'));
  return { root, configPath, call, agents, spawned, configs, flag, record };
}

test('spawn binds an explicitly named chat to this agent and carries it to the watcher', async t => {
  const f = await fixture(t);
  const spawned = await f.call('futureaide_spawn_agent', { workspace: f.root, message: 'work', request_id: 'spawn-bound', codex_thread_id: BOUND_THREAD });
  assert.equal(spawned.isError, false);
  assert.equal(spawned.value.accepted, true);
  assert.equal(spawned.value.callbackConfigured, true);
  assert.equal(spawned.value.callbackTarget, BOUND_THREAD);
  assert.equal(f.flag('--codex-thread-id'), BOUND_THREAD);
  assert.equal(f.flag('--agent-id'), spawned.value.agentId);
  assert.equal(f.configs.at(-1).codexThreadId, BOUND_THREAD);
  assert.equal(f.configs.at(-1).agentId, spawned.value.agentId);
  assert.equal((await f.record(spawned.value.agentId)).codexThreadId, BOUND_THREAD);
});

test('a chat target from the profile or an invalid value never binds a new agent', async t => {
  const f = await fixture(t);
  const plain = await f.call('futureaide_spawn_agent', { workspace: f.root, message: 'work', request_id: 'spawn-plain' });
  assert.equal(plain.isError, false);
  assert.equal(plain.value.callbackConfigured, false);
  assert.equal(plain.value.callbackStatus, 'not_configured');
  assert.equal(plain.value.callbackTarget, undefined);
  assert.equal(f.flag('--codex-thread-id'), undefined);
  assert.equal(f.configs.at(-1).codexThreadId, undefined);
  assert.equal((await f.record(plain.value.agentId)).codexThreadId, undefined);

  const invalid = await f.call('futureaide_spawn_agent', { workspace: f.root, message: 'work', request_id: 'spawn-invalid', codex_thread_id: 'not-a-uuid' });
  assert.equal(invalid.isError, true);
  assert.equal(f.spawned.length, 1);
  assert.equal(invalid.value.agentId, undefined);
  await assert.rejects(f.agents.spawn({ workspace: f.root, message: 'work', requestId: 'spawn-invalid-direct', codexThreadId: 'not-a-uuid' }), /Codex task UUID/);
});

test('followup keeps the agent\'s own binding and cannot inherit the profile target', async t => {
  const f = await fixture(t);
  const bound = await f.call('futureaide_spawn_agent', { workspace: f.root, message: 'first', request_id: 'spawn-bound', codex_thread_id: BOUND_THREAD });
  const follow = await f.call('futureaide_followup_agent', { agent_id: bound.value.agentId, message: 'second', request_id: 'follow-bound' });
  assert.equal(follow.isError, false);
  assert.equal(follow.value.callbackConfigured, true);
  assert.equal(follow.value.callbackTarget, BOUND_THREAD);
  assert.equal(f.flag('--codex-thread-id'), BOUND_THREAD);
  assert.equal(f.flag('--agent-id'), bound.value.agentId);
  assert.equal((await f.record(bound.value.agentId)).codexThreadId, BOUND_THREAD);

  const plain = await f.call('futureaide_spawn_agent', { workspace: f.root, message: 'first', request_id: 'spawn-plain' });
  const plainFollow = await f.call('futureaide_followup_agent', { agent_id: plain.value.agentId, message: 'second', request_id: 'follow-plain' });
  assert.equal(plainFollow.value.callbackConfigured, false);
  assert.equal(f.flag('--codex-thread-id'), undefined);
  assert.equal((await f.record(plain.value.agentId)).codexThreadId, undefined);
});

test('the CLI forwards the optional target and rejects a non-UUID before any write', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-cli-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ workspace: root }));
  const rejected = await run(process.execPath, [cli, 'spawn-agent', '--config', configPath, '--workspace', root,
    '--message', 'work', '--request-id', 'cli-invalid', '--codex-thread-id', 'not-a-uuid'], { cwd: root })
    .then(() => undefined, error => error);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /codex_thread_id must be a Codex task UUID/);
  // Nothing was registered, so the invalid target never reached the host or the registry.
  assert.equal(await readdir(path.join(root, 'agents')).then(() => true, () => false), false);
});
