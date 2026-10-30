import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPeers } from '../src/peers.mjs';

const THREAD = '11111111-1111-4111-8111-111111111111';
const THREAD_TWO = '22222222-2222-4222-8222-222222222222';
const DSH_AGENT = 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DSH_AGENT_TWO = 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CLI_PATH = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function threadPayload(root, overrides = {}) {
  return {
    schemaVersion: 1,
    thread: { id: THREAD, kind: 'codex', hostId: 'local', cwd: root, ...overrides },
    page: { hasMore: false },
    turns: [],
  };
}

const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function fakeCodex(root) {
  const calls = [];
  let read = threadId => textResult(threadPayload(root, { id: threadId }));
  let send = async () => textResult({ accepted: true });
  return {
    calls,
    readResult(implementation) { read = implementation; },
    sendResult(implementation) { send = implementation; },
    async call(threadId, name, args) {
      calls.push({ threadId, name, args });
      if (name === 'read_thread') return read(threadId, args);
      if (name === 'send_message_to_thread') return send(threadId, args);
      throw new Error(`Unexpected Codex operation: ${name}`);
    },
  };
}

function fakeDsh(items) {
  const calls = { list: [], followup: [], wait: [], archive: [] };
  const turns = new Map();
  let counter = 0;
  let latest = null;
  let followup = null;
  return {
    items,
    calls,
    turns,
    get latest() { return latest; },
    setFollowup(implementation) { followup = implementation; },
    complete(requestId, reply) {
      const turn = turns.get(requestId);
      assert.ok(turn, `Unknown native turn ${requestId}`);
      turn.state = 'completed';
      turn.reply = reply;
    },
    end(requestId, state) {
      const turn = turns.get(requestId);
      assert.ok(turn, `Unknown native turn ${requestId}`);
      turn.state = state;
    },
    async list(args) {
      calls.list.push(args);
      return { items };
    },
    async followup(args) {
      calls.followup.push(args);
      if (followup) return followup(args);
      const requestId = `native-${++counter}`;
      latest = requestId;
      turns.set(requestId, { state: 'running', reply: undefined, message: args.message });
      return { accepted: true, state: 'running', requestId };
    },
    async wait(args) {
      calls.wait.push(args);
      const turn = turns.get(args.requestId);
      if (!turn) return { state: 'unknown', requestId: args.requestId };
      return { state: turn.state, reply: turn.reply, requestId: args.requestId };
    },
    async archive(args) {
      calls.archive.push(args);
      return { accepted: true, archive: { state: 'archived' } };
    },
  };
}

async function setup(t, { items, now, startWorker } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-peers-'));
  t.after(async () => {
    assert.ok(root.startsWith(tmpdir() + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await realpath(root);
  const codex = fakeCodex(workspace);
  const agents = fakeDsh(items ?? [{ agentId: DSH_AGENT, workspace }]);
  const config = {
    workspace,
    stateDirectory: path.join(workspace, 'state'),
    registryDirectory: path.join(workspace, 'agents'),
  };
  const workers = [];
  const launch = startWorker ?? (async args => { workers.push(args); return process.pid; });
  const peers = createPeers(config, {
    agentsFactory: () => agents,
    codexCall: (...args) => codex.call(...args),
    startWorker: launch,
    ...(now === undefined ? {} : { now }),
  });
  return { root: workspace, config, peers, codex, agents, workers, startWorker: launch };
}

async function registerCodex(peers, root, overrides = {}) {
  return peers.register({
    peerId: 'codex-main',
    kind: 'codex-desktop',
    workspace: root,
    threadId: THREAD,
    label: 'Codex main',
    ...overrides,
  });
}

async function registerDsh(peers, root, overrides = {}) {
  return peers.register({
    peerId: 'dsh-main',
    kind: 'dsh',
    workspace: root,
    agentId: DSH_AGENT,
    label: 'DSH main',
    ...overrides,
  });
}

async function waitForExchange(root) {
  const directory = path.join(root, 'peers', 'exchanges');
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const entries = (await readdir(directory)).filter(name => name.startsWith('exchange-'));
      if (entries.length > 0) return entries[0];
    } catch {
      // The send has not created its receipt yet.
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('The send did not create an exchange receipt.');
}

test('registers both peer kinds only after native verification and lists local state without bridge details', async t => {
  const f = await setup(t);
  const codexPeer = await registerCodex(f.peers, f.root);
  assert.equal(codexPeer.peerId, 'codex-main');
  assert.equal(codexPeer.kind, 'codex-desktop');
  assert.equal(codexPeer.state, 'registered');
  assert.equal(codexPeer.label, 'Codex main');
  assert.match(codexPeer.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(f.codex.calls.length, 1);
  assert.deepEqual(f.codex.calls[0], {
    threadId: THREAD,
    name: 'read_thread',
    args: { threadId: THREAD, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100 },
  });

  const dshPeer = await registerDsh(f.peers, f.root, { label: 'DSH main' });
  assert.equal(dshPeer.kind, 'dsh');
  assert.equal(dshPeer.state, 'registered');
  assert.deepEqual(f.agents.calls.list, [{ workspace: f.root }]);

  const stored = JSON.parse(await readFile(path.join(f.root, 'peers', 'codex-main.json'), 'utf8'));
  assert.equal(stored.threadId, THREAD);
  assert.equal(stored.native.hostId, 'local');
  assert.equal(stored.native.cwd, f.root);
  const storedDsh = JSON.parse(await readFile(path.join(f.root, 'peers', 'dsh-main.json'), 'utf8'));
  assert.equal(storedDsh.agentId, DSH_AGENT);
  assert.equal(storedDsh.native.agentId, DSH_AGENT);

  const listing = await f.peers.list({ workspace: f.root });
  assert.deepEqual(listing.items.map(item => item.peerId), ['codex-main', 'dsh-main']);
  for (const item of listing.items) {
    assert.deepEqual(Object.keys(item).sort(), (item.kind === 'codex-desktop'
      ? ['capabilities', 'checkedAt', 'kind', 'label', 'peerId', 'role', 'state', 'threadId', 'workspace']
      : ['agentId', 'capabilities', 'checkedAt', 'kind', 'label', 'peerId', 'state', 'workspace']));
    assert.equal(item.state, 'registered');
    assert.deepEqual(item.capabilities, { send: true, reply: true, read: true, nativeResult: item.kind === 'dsh' });
  }
  assert.equal(listing.items[0].threadId, THREAD);
  assert.equal(listing.items[1].agentId, DSH_AGENT);
  assert.match(listing.note, /does not claim/);
  assert.doesNotMatch(JSON.stringify(listing), /bridge|pipe|token|credential|secret/i);
});

test('accepts a structuredContent MCP read result and rejects native mismatches', async t => {
  const f = await setup(t);
  f.codex.readResult(threadId => ({ structuredContent: threadPayload(f.root, { id: threadId }) }));
  await registerCodex(f.peers, f.root, { peerId: 'structured' });
  assert.equal((await f.peers.list()).items[0].peerId, 'structured');

  const failures = [
    [() => threadPayload(f.root, { id: THREAD_TWO }), /thread id does not match/],
    [() => threadPayload(f.root, { kind: 'dsh' }), /kind must be codex/],
    [() => threadPayload(f.root, { hostId: 'remote' }), /hostId must be local/],
    [() => threadPayload(f.root, { cwd: path.dirname(f.root) }), /cwd does not match/],
    [() => ({ isError: true, content: [{ type: 'text', text: 'denied' }] }), /read_thread was rejected/],
    [() => ({ content: [{ type: 'text', text: 'not json' }] }), /did not return a thread/],
  ];
  for (const [index, [result, pattern]] of failures.entries()) {
    f.codex.readResult(result);
    await assert.rejects(
      registerCodex(f.peers, f.root, { peerId: `mismatch-${index}` }),
      pattern,
    );
  }
  assert.equal((await f.peers.list()).items.length, 1);
});

test('rejects invalid peer ids, kinds, workspaces, and kind-specific identifiers before binding', async t => {
  const f = await setup(t);
  for (const peerId of ['Codex', 'con', 'PRN', 'com1', 'lpt9', '-leading', 'with.dot', 'a'.repeat(65), '']) {
    await assert.rejects(registerCodex(f.peers, f.root, { peerId }), /peer_id/);
  }
  await assert.rejects(registerCodex(f.peers, f.root, { kind: 'claude-code' }), /kind/);
  await assert.rejects(registerCodex(f.peers, f.root, { workspace: 'relative/path' }), /absolute/);
  await assert.rejects(registerCodex(f.peers, f.root, { threadId: 'not-a-uuid' }), /UUID/);
  await assert.rejects(registerCodex(f.peers, f.root, { agentId: DSH_AGENT }), /not agentId/);
  await assert.rejects(registerDsh(f.peers, f.root, { agentId: DSH_AGENT_TWO }), /not found/);
  await assert.rejects(registerDsh(f.peers, f.root, { threadId: THREAD }), /not threadId/);
  await assert.rejects(registerDsh(f.peers, f.root, { agentId: DSH_AGENT, workspace: f.root, label: ' ' }), /label/);
  await assert.rejects(
    f.peers.register({ peerId: 'missing-agent', kind: 'dsh', workspace: f.root, agentId: '' }),
    /agent_id/);
  assert.deepEqual((await f.peers.list()).items, []);
});

test('refuses to rebind an existing peer name to a different native target', async t => {
  const f = await setup(t);
  const first = await registerCodex(f.peers, f.root);
  await assert.rejects(
    registerCodex(f.peers, f.root, { threadId: THREAD_TWO }),
    /different target/);
  await assert.rejects(
    registerDsh(f.peers, f.root, { peerId: 'codex-main' }),
    /different target/);
  const stored = JSON.parse(await readFile(path.join(f.root, 'peers', 'codex-main.json'), 'utf8'));
  assert.equal(stored.threadId, THREAD);
  assert.equal(stored.checkedAt, first.checkedAt);

  const same = await registerCodex(f.peers, f.root, { label: 'Renamed' });
  assert.equal(same.label, 'Renamed');
  assert.equal(same.state, 'registered');
  assert.ok(same.checkedAt >= first.checkedAt);
});

test('rejects cross-workspace exchanges; unregister keeps history and stops new sends', async t => {
  const f = await setup(t);
  const otherRoot = path.join(f.root, 'other');
  await mkdir(otherRoot);
  f.agents.items.push({ agentId: DSH_AGENT_TWO, workspace: otherRoot });
  await registerCodex(f.peers, f.root);
  await f.peers.register({ peerId: 'other-dsh', kind: 'dsh', workspace: otherRoot, agentId: DSH_AGENT_TWO });
  await assert.rejects(
    f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'other-dsh', message: 'hello', requestId: 'cross-workspace' }),
    /same workspace/);

  const registered = await registerDsh(f.peers, f.root);
  const sent = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'keep me', requestId: 'keep' });
  await f.peers.reply({ exchangeId: sent.exchangeId, peerId: 'dsh-main', message: 'kept' });
  assert.equal((await f.peers.list()).items.find(item => item.peerId === 'dsh-main').state, 'registered');
  assert.ok(await readFile(path.join(f.root, 'peers', 'exchanges', sent.exchangeId, 'exchange.json'), 'utf8'));

  const disabled = await f.peers.unregister({ peerId: 'dsh-main' });
  assert.equal(disabled.state, 'disabled');
  assert.equal(disabled.checkedAt, registered.checkedAt);
  assert.equal((await f.peers.list()).items.find(item => item.peerId === 'dsh-main').state, 'disabled');
  await assert.rejects(
    f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'again', requestId: 'after-disable' }),
    /disabled/);
  const history = await f.peers.read({ exchangeId: sent.exchangeId });
  assert.equal(history.state, 'completed');
  assert.equal(history.reply.message, 'kept');

  const reenabled = await registerDsh(f.peers, f.root, { peerId: 'dsh-main' });
  assert.equal(reenabled.state, 'registered');
  const second = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'again', requestId: 'after-reenable' });
  assert.equal(second.state, 'pending');
});

test('Codex delivery carries correlated reply instructions and no model or thinking options', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  f.agents.calls.followup.length = 0;

  const sent = await f.peers.send({
    fromPeerId: 'dsh-main',
    toPeerId: 'codex-main',
    message: 'Please verify the build.',
    requestId: 'ask-codex-1',
  });
  assert.equal(sent.state, 'pending');
  assert.equal(sent.accepted, true);
  assert.equal(sent.reply, null);
  assert.equal(sent.delivery.state, 'accepted');
  assert.equal(sent.target.threadId, THREAD);
  assert.match(sent.exchangeId, /^exchange-[a-f0-9]{32}$/);

  const call = f.codex.calls.find(item => item.name === 'send_message_to_thread');
  assert.ok(call);
  assert.equal(call.threadId, THREAD);
  assert.deepEqual(Object.keys(call.args).sort(), ['prompt', 'threadId']);
  assert.equal(call.args.threadId, THREAD);
  assert.match(call.args.prompt, /Original source peer: dsh-main/);
  assert.match(call.args.prompt, /Please verify the build\./);
  assert.ok(call.args.prompt.includes(sent.exchangeId));
  assert.match(call.args.prompt, /futureaide_reply_exchange/);
  assert.match(call.args.prompt, /not a new user authorization/i);
  assert.match(call.args.prompt, /must answer through/i);
  assert.ok(call.args.prompt.includes(CLI_PATH));
  assert.ok(call.args.prompt.includes(`--exchange-id ${sent.exchangeId}`));
  assert.ok(call.args.prompt.includes('--peer-id codex-main'));
  assert.ok(call.args.prompt.includes('--request-id reply-'));
  assert.ok(call.args.prompt.includes('--message-file "<answer-file>"'));
  assert.match(call.args.prompt, /--message "<your answer>"/);
  assert.doesNotMatch(call.args.prompt, /--config /);

  const names = f.codex.calls.map(item => item.name);
  const sendIndex = names.indexOf('send_message_to_thread');
  assert.deepEqual(names.slice(0, sendIndex), ['read_thread', 'read_thread']);
  assert.equal(f.codex.calls[sendIndex - 1].args.threadId, THREAD);

  assert.equal((await f.peers.read({ exchangeId: sent.exchangeId })).state, 'pending');
  const replied = await f.peers.reply({
    exchangeId: sent.exchangeId,
    peerId: 'codex-main',
    message: 'Build verified.',
    requestId: 'answer-codex-1',
  });
  assert.equal(replied.state, 'completed');
  assert.equal(replied.reply.peerId, 'codex-main');
  assert.equal(replied.reply.message, 'Build verified.');
  assert.equal(replied.reply.requestId, 'answer-codex-1');
  assert.equal((await f.peers.read({ exchangeId: sent.exchangeId })).reply.message, 'Build verified.');
  assert.equal(f.agents.calls.wait.length, 0, 'Codex exchanges do not poll DSH turns');
});

test('reply instructions pin the custom --config root and prefer message files', async t => {
  const f = await setup(t);
  const configFile = path.join(f.root, 'config root', 'custom-config.json');
  const peers = createPeers({ ...f.config, configFile }, {
    agentsFactory: () => f.agents,
    codexCall: (...args) => f.codex.call(...args),
    startWorker: async () => process.pid,
  });
  await registerCodex(peers, f.root);
  await registerDsh(peers, f.root);

  const sent = await peers.send({
    fromPeerId: 'dsh-main',
    toPeerId: 'codex-main',
    message: 'Use the custom registry.',
    requestId: 'custom-root',
  });
  const call = f.codex.calls.find(item => item.name === 'send_message_to_thread');
  const prompt = call.args.prompt;
  assert.ok(prompt.includes(`--config "${configFile}"`));
  assert.ok(prompt.includes('--message-file "<answer-file>"'));
  assert.match(prompt, /--message "<your answer>"/);
  assert.match(prompt, /Prefer --message-file/);
  assert.match(prompt, /futureaide_reply_exchange/);
  assert.match(prompt, /same configuration|exact configuration file/i);
  assert.ok(prompt.includes(configFile));
  const cliLine = prompt.split('\n').find(line => line.includes('reply-exchange'));
  assert.ok(cliLine.includes(`--config "${configFile}"`));
  assert.ok(cliLine.includes(`--exchange-id ${sent.exchangeId}`));
  assert.ok(cliLine.includes('--peer-id codex-main'));
  assert.ok(cliLine.includes('--message-file "<answer-file>"'));

  await peers.send({
    fromPeerId: 'codex-main',
    toPeerId: 'dsh-main',
    message: 'Use the same custom registry.',
    requestId: 'custom-root-reverse',
  });
  const followup = f.agents.calls.followup.at(-1);
  assert.ok(followup.message.includes(`--config "${configFile}"`));
  assert.ok(followup.message.includes('--message-file "<answer-file>"'));
  assert.match(followup.message, /collected automatically/);
});

test('re-verifies the Codex thread before sending and fails without delivery when it moved', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  f.codex.readResult(threadId => textResult(threadPayload(f.root, { id: threadId, hostId: 'remote' })));

  const sent = await f.peers.send({
    fromPeerId: 'dsh-main',
    toPeerId: 'codex-main',
    message: 'should not be sent',
    requestId: 'moved-thread',
  });
  assert.equal(sent.state, 'failed');
  assert.equal(sent.accepted, false);
  assert.match(sent.delivery.note, /could not be re-verified before sending/);
  assert.match(sent.delivery.note, /not sent/);
  assert.equal(sent.native.threadId, THREAD);
  assert.equal(f.codex.calls.filter(call => call.name === 'send_message_to_thread').length, 0);
  assert.equal((await f.peers.read({ exchangeId: sent.exchangeId })).state, 'failed');
});

test('DSH delivery stores the returned native request id and reads that exact turn, not the latest', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);

  const first = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'Question A', requestId: 'dsh-a' });
  const second = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'Question B', requestId: 'dsh-b' });
  assert.equal(first.native.requestId, 'native-1');
  assert.equal(second.native.requestId, 'native-2');
  assert.equal(f.agents.latest, 'native-2');

  const firstFollowup = f.agents.calls.followup[0];
  assert.equal(firstFollowup.agentId, DSH_AGENT);
  assert.match(firstFollowup.message, /Question A/);
  assert.ok(firstFollowup.message.includes(first.exchangeId));
  assert.match(firstFollowup.message, /futureaide_reply_exchange/);
  assert.match(firstFollowup.message, /ordinary final answer to this turn is collected automatically/);
  assert.match(firstFollowup.message, /optional/i);
  assert.ok(firstFollowup.message.includes('--message-file "<answer-file>"'));
  assert.match(firstFollowup.requestId, /^peer-[a-f0-9]{40}$/);
  assert.notEqual(firstFollowup.requestId, first.native.requestId);

  f.agents.complete('native-1', 'Answer A');
  f.agents.complete('native-2', 'Answer B');
  const readA = await f.peers.read({ exchangeId: first.exchangeId });
  assert.equal(readA.state, 'completed');
  assert.equal(readA.reply.message, 'Answer A');
  assert.equal(readA.reply.source, 'dsh-native');
  assert.equal(readA.reply.requestId, 'native-1');
  assert.ok(f.agents.calls.wait.every(call => call.requestId === 'native-1'));
  assert.equal(f.agents.calls.wait[0].timeoutSeconds, 0);

  const readB = await f.peers.read({ exchangeId: second.exchangeId });
  assert.equal(readB.reply.message, 'Answer B');
  assert.equal(readB.reply.requestId, 'native-2');
  assert.ok(f.agents.calls.wait.some(call => call.requestId === 'native-2'));
  assert.ok(f.agents.calls.wait.every(call => typeof call.requestId === 'string'));
});

test('duplicate and concurrent sends deliver once; conflicting reuse is rejected', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerCodex(f.peers, f.root, { peerId: 'codex-second', threadId: THREAD_TWO });
  await registerDsh(f.peers, f.root);

  const input = { fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'once', requestId: 'same-request' };
  const results = await Promise.all([f.peers.send(input), f.peers.send(input)]);
  const sends = f.codex.calls.filter(call => call.name === 'send_message_to_thread');
  assert.equal(sends.length, 1);
  assert.equal(new Set(results.map(result => result.exchangeId)).size, 1);
  assert.ok(results.some(result => result.duplicate === true));
  const duplicate = await f.peers.send(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.exchangeId, results[0].exchangeId);
  assert.equal(f.codex.calls.filter(call => call.name === 'send_message_to_thread').length, 1);

  await assert.rejects(
    f.peers.send({ ...input, message: 'changed' }),
    /different peer target or message/);
  await assert.rejects(
    f.peers.send({ ...input, toPeerId: 'codex-second' }),
    /different peer target or message/);
  assert.equal(f.codex.calls.filter(call => call.name === 'send_message_to_thread').length, 1);
});

test('an unconfirmed send stays unknown and is never automatically retried', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  f.codex.sendResult(async () => { throw new Error('bridge connection ended'); });

  const sent = await f.peers.send({ fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'did it land?', requestId: 'lost' });
  assert.equal(sent.state, 'unknown');
  assert.equal(sent.accepted, false);
  assert.equal(sent.delivery.state, 'unknown');
  assert.match(sent.delivery.note, /never be resent/i);
  assert.equal(f.codex.calls.filter(call => call.name === 'send_message_to_thread').length, 1);

  const again = await f.peers.send({ fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'did it land?', requestId: 'lost' });
  assert.equal(again.duplicate, true);
  assert.equal(again.state, 'unknown');
  assert.equal(f.codex.calls.filter(call => call.name === 'send_message_to_thread').length, 1);

  const reopened = createPeers(f.config, {
    agentsFactory: () => { throw new Error('agents must not be needed for a read'); },
    codexCall: async () => { throw new Error('a read must not deliver'); },
    startWorker: async () => process.pid,
  });
  const read = await reopened.read({ exchangeId: sent.exchangeId });
  assert.equal(read.state, 'unknown');
  assert.equal((await reopened.list()).items.length, 2);
});

test('a receipt left sending by a dead process becomes unknown on read without redelivery', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reachedSend = new Promise(resolve => { entered = resolve; });
  f.codex.sendResult(async () => {
    entered();
    await gate;
    return textResult({ accepted: true });
  });

  const input = { fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'orphan', requestId: 'orphan' };
  const sending = f.peers.send(input);
  await reachedSend;
  const exchangeId = await waitForExchange(f.root);
  const file = path.join(f.root, 'peers', 'exchanges', exchangeId, 'exchange.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(record.state, 'sending');
  assert.equal(record.senderPid, process.pid);
  record.senderPid = 2147483647;
  await writeFile(file, JSON.stringify(record, null, 2) + '\n');

  const read = await f.peers.read({ exchangeId });
  assert.equal(read.state, 'unknown');
  assert.equal(read.accepted, false);
  assert.match(read.delivery.note, /sending process ended/);
  const duplicate = await f.peers.send(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state, 'unknown');
  assert.equal(f.codex.calls.filter(call => call.name === 'send_message_to_thread').length, 1);

  release();
  await sending;
});

test('a read timeout leaves the exchange pending and a later reply completes it', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const sent = await f.peers.send({ fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'slow?', requestId: 'wait' });

  const started = Date.now();
  const timedOut = await f.peers.read({ exchangeId: sent.exchangeId, timeoutSeconds: 0.08 });
  assert.ok(Date.now() - started >= 60);
  assert.equal(timedOut.state, 'pending');
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.reply, null);
  assert.equal((await f.peers.read({ exchangeId: sent.exchangeId })).state, 'pending');
  assert.equal((await f.peers.read({ exchangeId: sent.exchangeId })).timedOut, undefined);

  await assert.rejects(f.peers.read({ exchangeId: sent.exchangeId, timeoutSeconds: 46 }), /between 0 and 45/);
  await assert.rejects(f.peers.read({ exchangeId: sent.exchangeId, timeoutSeconds: -1 }), /between 0 and 45/);
  await assert.rejects(f.peers.read({ exchangeId: 'not-an-exchange' }), /Invalid exchange/);
  await assert.rejects(f.peers.read({ exchangeId: 'exchange-' + '0'.repeat(32) }), /Unknown exchange/);

  await f.peers.reply({ exchangeId: sent.exchangeId, peerId: 'codex-main', message: 'eventually' });
  const completed = await f.peers.read({ exchangeId: sent.exchangeId, timeoutSeconds: 0.1 });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.reply.message, 'eventually');
});

test('only the target peer can reply; duplicate replies are idempotent and changed content is refused', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const sent = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'question', requestId: 'reply-rules' });

  await assert.rejects(
    f.peers.reply({ exchangeId: sent.exchangeId, peerId: 'codex-main', message: 'wrong side' }),
    /Only the target peer/);
  const first = await f.peers.reply({ exchangeId: sent.exchangeId, peerId: 'dsh-main', message: 'answer', requestId: 'reply-1' });
  assert.equal(first.state, 'completed');
  assert.equal(first.reply.message, 'answer');
  const again = await f.peers.reply({ exchangeId: sent.exchangeId, peerId: 'dsh-main', message: 'answer', requestId: 'reply-2' });
  assert.equal(again.duplicate, true);
  assert.equal(again.reply.requestId, 'reply-1');
  assert.equal(again.reply.at, first.reply.at);
  await assert.rejects(
    f.peers.reply({ exchangeId: sent.exchangeId, peerId: 'dsh-main', message: 'different' }),
    /different reply/);
  await assert.rejects(
    f.peers.reply({ exchangeId: 'exchange-' + 'f'.repeat(32), peerId: 'dsh-main', message: 'x' }),
    /Unknown exchange/);
});

test('a reply that arrives while send is in flight survives the late send finalization', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reachedSend = new Promise(resolve => { entered = resolve; });
  f.codex.sendResult(async () => {
    entered();
    await gate;
    return textResult({ accepted: true });
  });

  const sending = f.peers.send({ fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'fast answer', requestId: 'race' });
  await reachedSend;
  const exchangeId = await waitForExchange(f.root);
  const early = await f.peers.reply({ exchangeId, peerId: 'codex-main', message: 'answered early' });
  assert.equal(early.state, 'completed');
  release();
  const sent = await sending;
  assert.equal(sent.state, 'completed');
  assert.equal(sent.reply.message, 'answered early');
  assert.equal(sent.delivery.accepted, true);
  const stored = JSON.parse(await readFile(path.join(f.root, 'peers', 'exchanges', exchangeId, 'exchange.json'), 'utf8'));
  assert.equal(stored.state, 'completed');
  assert.equal(stored.reply.message, 'answered early');
});

test('a new createPeers instance recovers peers, exchanges, and disabled state from disk', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const completed = await f.peers.send({ fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'persisted', requestId: 'persist-1' });
  await f.peers.reply({ exchangeId: completed.exchangeId, peerId: 'codex-main', message: 'persisted answer' });
  const pending = await f.peers.send({ fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'still pending', requestId: 'persist-2' });
  await f.peers.unregister({ peerId: 'dsh-main' });

  let codexCalls = 0;
  const reopened = createPeers(f.config, {
    agentsFactory: () => { throw new Error('no native DSH call expected'); },
    codexCall: async () => { codexCalls++; throw new Error('no bridge call expected'); },
    startWorker: async () => process.pid,
  });
  const listing = await reopened.list({ workspace: f.root });
  assert.deepEqual(listing.items.map(item => [item.peerId, item.state]), [
    ['codex-main', 'registered'],
    ['dsh-main', 'disabled'],
  ]);
  const recovered = await reopened.read({ exchangeId: completed.exchangeId });
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.reply.message, 'persisted answer');
  const stillPending = await reopened.read({ exchangeId: pending.exchangeId, timeoutSeconds: 0.05 });
  assert.equal(stillPending.state, 'pending');
  assert.equal(stillPending.timedOut, true);
  await assert.rejects(
    reopened.send({ fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'new', requestId: 'persist-3' }),
    /disabled/);
  assert.equal(codexCalls, 0);
});

test('DSH completed maps a reply while failed and cancelled remain terminal', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const failed = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'fail me', requestId: 'dsh-fail' });
  const cancelled = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'cancel me', requestId: 'dsh-cancel' });
  f.agents.end(failed.native.requestId, 'failed');
  f.agents.end(cancelled.native.requestId, 'cancelled');
  const failedRead = await f.peers.read({ exchangeId: failed.exchangeId });
  assert.equal(failedRead.state, 'failed');
  assert.equal(failedRead.reply, null);
  const cancelledRead = await f.peers.read({ exchangeId: cancelled.exchangeId });
  assert.equal(cancelledRead.state, 'cancelled');
  f.agents.complete(failed.native.requestId, 'too late');
  assert.equal((await f.peers.read({ exchangeId: failed.exchangeId })).state, 'failed');
});

test('a completed original DSH task archives only its own agent session', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const sent = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'do the work', requestId: 'archive-original' });
  f.agents.complete(sent.native.requestId, 'work finished');
  const pumped = await f.peers.pump({ exchangeId: sent.exchangeId });
  assert.equal(pumped.state, 'completed');
  assert.equal(pumped.reply.message, 'work finished');
  assert.equal(f.agents.calls.archive.length, 1);
  assert.deepEqual(f.agents.calls.archive[0], { agentId: DSH_AGENT });
  assert.equal(pumped.archive.state, 'archived');
  assert.equal(pumped.archive.agentId, DSH_AGENT);
  // A second pump is idempotent and does not archive again.
  await f.peers.pump({ exchangeId: sent.exchangeId });
  assert.equal(f.agents.calls.archive.length, 1);
});

test('a reverse child exchange answering a question never archives the agent working its parent', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const parent = await f.peers.send({ fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'ask the boss', requestId: 'reverse-parent' });
  f.codex.sendResult(async () => textResult({ accepted: true }));
  const child = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'answer for the parent', requestId: 'reverse-child',
    parentExchangeId: parent.exchangeId });
  f.agents.complete(child.native.requestId, 'child answer');
  const pumped = await f.peers.pump({ exchangeId: child.exchangeId });
  assert.equal(pumped.state, 'completed');
  assert.equal(pumped.parentExchangeId, parent.exchangeId);
  assert.equal(pumped.archive, undefined);
  assert.equal(f.agents.calls.archive.length, 0);
});

test('a Codex target keeps its existing manual archive lifecycle', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const sent = await f.peers.send({ fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'answer me', requestId: 'codex-manual' });
  await f.peers.reply({ exchangeId: sent.exchangeId, peerId: 'codex-main', message: 'answered' });
  const pumped = await f.peers.pump({ exchangeId: sent.exchangeId });
  assert.equal(pumped.state, 'completed');
  assert.equal(pumped.archive.state, 'skipped');
  assert.equal(f.codex.calls.filter(call => call.name === 'set_thread_archived').length, 0);
});

test('a failed DSH archive leaves the completed exchange result and reports the failure', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const sent = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'work', requestId: 'archive-failure' });
  f.agents.complete(sent.native.requestId, 'done anyway');
  f.agents.archive = async () => ({ accepted: false, error: { message: 'workspace/session-active' } });
  const pumped = await f.peers.pump({ exchangeId: sent.exchangeId });
  assert.equal(pumped.state, 'completed');
  assert.equal(pumped.reply.message, 'done anyway');
  assert.equal(pumped.archive.state, 'failed');
  assert.match(pumped.archive.error, /session-active/);
});

test('failed and cancelled original DSH exchanges also close their own agent session', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const failed = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'fail', requestId: 'archive-failed' });
  f.agents.end(failed.native.requestId, 'failed');
  const pumpedFailed = await f.peers.pump({ exchangeId: failed.exchangeId });
  assert.equal(pumpedFailed.state, 'failed');
  assert.equal(pumpedFailed.archive.state, 'archived');

  const cancelled = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'cancel', requestId: 'archive-cancelled' });
  f.agents.end(cancelled.native.requestId, 'cancelled');
  const pumpedCancelled = await f.peers.pump({ exchangeId: cancelled.exchangeId });
  assert.equal(pumpedCancelled.state, 'cancelled');
  assert.equal(pumpedCancelled.archive.state, 'archived');
  assert.equal(f.agents.calls.archive.length, 2);
});

test('an explicit reply does not archive before the native turn ends; the watcher retries until it does', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const sent = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'work then answer', requestId: 'archive-pending' });
  await f.peers.reply({ exchangeId: sent.exchangeId, peerId: 'dsh-main', message: 'answer is in' });
  let archiveCalls = 0;
  f.agents.archive = async () => {
    archiveCalls += 1;
    return archiveCalls === 1 ? { accepted: false, state: 'running' } : { accepted: true };
  };
  const first = await f.peers.pump({ exchangeId: sent.exchangeId });
  assert.equal(first.state, 'completed');
  assert.equal(first.reply.message, 'answer is in');
  assert.equal(first.archive.state, 'pending');
  // The native turn was still running when the answer was recorded. Once it really ends, the
  // next pump archives the same exchange without losing the terminal result.
  f.agents.complete(sent.native.requestId, 'native answer');
  const second = await f.peers.pump({ exchangeId: sent.exchangeId });
  assert.equal(second.state, 'completed');
  assert.equal(second.reply.message, 'answer is in');
  assert.equal(second.archive.state, 'archived');
  assert.equal(archiveCalls, 2);
});

test('DSH followup busy is a failed non-delivery while unknown stays unknown', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const before = f.agents.calls.followup.length;
  f.agents.setFollowup(async () => ({ accepted: false, state: 'busy', requestId: 'previous-turn' }));
  const busy = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'busy', requestId: 'busy' });
  assert.equal(busy.state, 'failed');
  assert.match(busy.delivery.note, /not sent/);
  assert.match(busy.native.requestId, /^peer-[a-f0-9]{40}$/);
  assert.equal(f.agents.calls.followup.length, before + 1);
  assert.equal(f.agents.calls.wait.length, 0);

  f.agents.setFollowup(async () => { throw new Error('socket reset'); });
  const unknown = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'unknown', requestId: 'unknown' });
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.native.requestId, /^peer-[a-f0-9]{40}$/);
  assert.notEqual(unknown.native.requestId, busy.native.requestId);
  await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'unknown', requestId: 'unknown' });
  assert.equal(f.agents.calls.followup.length, before + 2);
  const readUnknown = await f.peers.read({ exchangeId: unknown.exchangeId });
  assert.equal(readUnknown.state, 'unknown');
  assert.equal(f.agents.calls.wait.at(-1).requestId, unknown.native.requestId);

  f.agents.setFollowup(async () => ({ accepted: false, state: 'unknown' }));
  const reported = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'reported unknown', requestId: 'reported-unknown' });
  assert.equal(reported.state, 'unknown');

  f.agents.setFollowup(async () => { throw Object.assign(new Error('nothing queued'), { uncertain: false }); });
  const explicit = await f.peers.send({ fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'definitely not sent', requestId: 'explicit' });
  assert.equal(explicit.state, 'failed');
});

test('a DSH relay that cannot fit the followup limit fails before any native call', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  await registerDsh(f.peers, f.root);
  const before = f.agents.calls.followup.length;
  const sent = await f.peers.send({
    fromPeerId: 'codex-main',
    toPeerId: 'dsh-main',
    message: 'x'.repeat(100000),
    requestId: 'too-long',
  });
  assert.equal(sent.state, 'failed');
  assert.match(sent.delivery.note, /too long/);
  assert.equal(f.agents.calls.followup.length, before);
});

test('stale locks recover under an exclusive guard and corrupt locks are left for inspection', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  const lock = path.join(f.root, 'peers', 'locks', 'peer-codex-main.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, JSON.stringify({ pid: 2147483647, nonce: 'dead-owner' }));

  const results = await Promise.all([
    f.peers.unregister({ peerId: 'codex-main' }),
    f.peers.unregister({ peerId: 'codex-main' }),
  ]);
  assert.deepEqual(results.map(result => result.state), ['disabled', 'disabled']);
  await assert.rejects(readFile(lock), error => error.code === 'ENOENT');

  await writeFile(lock, '{broken');
  await assert.rejects(f.peers.unregister({ peerId: 'codex-main' }), /incomplete peer store lock/);
  assert.equal(await readFile(lock, 'utf8'), '{broken');
});

test('checkedAt uses the injected clock and list filters by real workspace', async t => {
  const checkedAt = '2026-10-19T12:00:00.000Z';
  const f = await setup(t, { now: () => checkedAt });
  const registered = await registerCodex(f.peers, f.root);
  assert.equal(registered.checkedAt, checkedAt);
  await registerDsh(f.peers, f.root);
  assert.equal((await f.peers.list()).items.length, 2);
  assert.equal((await f.peers.list({ workspace: path.dirname(f.root) })).items.length, 0);
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('registers a mailbox peer with a stable mailboxId and no live-session identifiers', async t => {
  const f = await setup(t);
  const first = await f.peers.register({
    peerId: 'claude-main',
    kind: 'mailbox',
    workspace: f.root,
    label: 'Claude inbox',
  });
  assert.equal(first.peerId, 'claude-main');
  assert.equal(first.kind, 'mailbox');
  assert.equal(first.state, 'registered');
  assert.equal(first.label, 'Claude inbox');
  assert.match(first.mailboxId, UUID);
  assert.equal('agentId' in first, false);
  assert.equal('threadId' in first, false);
  assert.deepEqual(first.capabilities, { send: true, reply: true, read: true, nativeResult: false });
  assert.equal(f.codex.calls.length, 0, 'a mailbox registration needs no Codex bridge call');
  assert.equal(f.agents.calls.list.length, 0, 'a mailbox registration needs no DSH call');

  const stored = JSON.parse(await readFile(path.join(f.root, 'peers', 'claude-main.json'), 'utf8'));
  assert.equal(stored.mailboxId, first.mailboxId);
  assert.equal('agentId' in stored, false);
  assert.deepEqual(stored.native, { kind: 'mailbox', mailboxId: first.mailboxId });

  const again = await f.peers.register({ peerId: 'claude-main', kind: 'mailbox', workspace: f.root });
  assert.equal(again.mailboxId, first.mailboxId, 'the mailboxId is stable across registrations');
  assert.equal(again.label, 'Claude inbox');
  assert.equal(again.state, 'registered');
  assert.ok(again.checkedAt >= first.checkedAt);

  const listing = await f.peers.list({ workspace: f.root });
  assert.deepEqual(listing.items.map(item => item.peerId), ['claude-main']);
  assert.equal(listing.items[0].mailboxId, first.mailboxId);
  assert.equal('agentId' in listing.items[0], false);
  assert.deepEqual(listing.items[0].capabilities, { send: true, reply: true, read: true, nativeResult: false });
});

test('a mailbox peer rejects threadId and agentId instead of binding a native session', async t => {
  const f = await setup(t);
  const base = { peerId: 'claude-main', kind: 'mailbox', workspace: f.root };
  await assert.rejects(
    f.peers.register({ ...base, agentId: DSH_AGENT }),
    /mailbox peers have no session.*agentId is not used/);
  await assert.rejects(
    f.peers.register({ ...base, threadId: THREAD }),
    /mailbox peers have no session.*threadId is not used/);
  assert.deepEqual((await f.peers.list()).items, []);

  await f.peers.register(base);
  await assert.rejects(
    f.peers.register({ peerId: 'claude-main', kind: 'dsh', workspace: f.root, agentId: DSH_AGENT }),
    /different target/);
  await assert.rejects(
    registerCodex(f.peers, f.root, { peerId: 'claude-main' }),
    /different target/);
  const stored = JSON.parse(await readFile(path.join(f.root, 'peers', 'claude-main.json'), 'utf8'));
  assert.equal(stored.kind, 'mailbox');
});

test('a mailbox source gets its completion notice as a durable file and never as a followup', async t => {
  const f = await setup(t);
  const mailbox = await f.peers.register({ peerId: 'claude-main', kind: 'mailbox', workspace: f.root });
  await registerCodex(f.peers, f.root);

  const sent = await f.peers.send({
    fromPeerId: 'claude-main',
    toPeerId: 'codex-main',
    message: 'Please review the migration plan.',
    requestId: 'mailbox-out',
  });
  assert.equal(sent.state, 'pending');
  assert.equal(sent.source.kind, 'mailbox');
  assert.equal(sent.source.mailboxId, mailbox.mailboxId);
  assert.equal('agentId' in sent.source, false, 'a mailbox snapshot never carries an undefined agentId');
  assert.equal(f.agents.calls.followup.length, 0);
  await f.peers.reply({ exchangeId: sent.exchangeId, peerId: 'codex-main', message: 'PLAN_REVIEWED' });

  const pumped = await f.peers.pump({ exchangeId: sent.exchangeId });
  assert.equal(pumped.state, 'completed');
  assert.equal(pumped.notification.state, 'delivered');
  assert.match(pumped.notification.note, /source mailbox/);
  assert.match(pumped.notification.note, /must read that file/);
  assert.match(pumped.notification.deliveredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(f.agents.calls.followup.length, 0, 'a mailbox notice must never call agents().followup');
  assert.equal(f.agents.calls.list.length, 0);
  assert.equal(f.agents.calls.wait.length, 0);
  assert.equal(f.codex.calls.filter(call => call.name === 'send_message_to_thread').length, 1,
    'no chat message is pushed to a mailbox source');

  const file = path.join(f.root, 'peers', 'mailbox', 'claude-main', `${sent.exchangeId}.json`);
  const notice = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(notice.exchangeId, sent.exchangeId);
  assert.equal(notice.targetPeerId, 'claude-main');
  assert.equal(notice.mailboxId, mailbox.mailboxId);
  assert.equal(notice.state, 'completed');
  assert.match(notice.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(notice.text.includes(sent.exchangeId), 'the on-disk notice carries its own exchange id');
  assert.match(notice.text, /PLAN_REVIEWED/);
  assert.match(notice.text, /one-way completion notice/);

  const second = await f.peers.pump({ exchangeId: sent.exchangeId });
  assert.equal(second.notification.state, 'delivered');
  assert.equal(f.agents.calls.followup.length, 0);
  assert.equal((await readdir(path.join(f.root, 'peers', 'mailbox', 'claude-main'))).length, 1,
    'a delivered notice leaves exactly one file and no temporary artifact');
});

test('a mailbox peer accepts inbound work as a durable inbox item, never as an agent call', async t => {
  const f = await setup(t);
  await registerCodex(f.peers, f.root);
  const mailbox = await f.peers.register({ peerId: 'claude-main', kind: 'mailbox', workspace: f.root });

  const sent = await f.peers.send({
    fromPeerId: 'codex-main',
    toPeerId: 'claude-main',
    message: 'work for the inbox',
    requestId: 'mailbox-target',
  });
  assert.equal(sent.state, 'pending');
  assert.equal(sent.accepted, true);
  assert.equal(sent.delivery.adapter, 'mailbox');
  assert.equal(sent.delivery.state, 'accepted');
  assert.match(sent.delivery.note, /inbox/);
  assert.match(sent.delivery.note, /must read that file and reply/);
  assert.deepEqual(sent.native, { kind: 'mailbox', mailboxId: mailbox.mailboxId });
  assert.equal('agentId' in sent.native, false);
  assert.equal(f.agents.calls.followup.length, 0, 'a mailbox delivery must never call agents().followup');
  assert.equal(f.agents.calls.list.length, 0);
  assert.equal(f.codex.calls.filter(call => call.name === 'send_message_to_thread').length, 0);

  const itemPath = path.join(f.root, 'peers', 'mailbox', 'claude-main', 'inbox', `${sent.exchangeId}.json`);
  const item = JSON.parse(await readFile(itemPath, 'utf8'));
  assert.equal(item.exchangeId, sent.exchangeId);
  assert.equal(item.targetPeerId, 'claude-main');
  assert.equal(item.mailboxId, mailbox.mailboxId);
  assert.equal(item.kind, 'inbox');
  assert.equal(item.state, 'pending');
  assert.equal(item.fromPeerId, 'codex-main');
  assert.equal(item.requestId, 'mailbox-target');
  assert.equal(item.workspace, path.resolve(f.root));
  assert.match(item.text, /work for the inbox/);
  assert.ok(item.text.includes(sent.exchangeId), 'the inbox item carries its reply instructions');
  assert.match(item.replyWith.tool, /futureaide_reply_exchange/);
  assert.match(item.replyWith.cli, /reply-exchange/);
  assert.deepEqual((await readdir(path.dirname(itemPath))), [`${sent.exchangeId}.json`],
    'an accepted item leaves exactly one file and no temporary artifact');

  const stored = JSON.parse(await readFile(path.join(f.root, 'peers', 'exchanges', sent.exchangeId, 'exchange.json'), 'utf8'));
  assert.equal(stored.state, 'pending');
  assert.equal('agentId' in stored.native, false);
  assert.deepEqual(stored.native, { kind: 'mailbox', mailboxId: mailbox.mailboxId });

  const replied = await f.peers.reply({ exchangeId: sent.exchangeId, peerId: 'claude-main', message: 'INBOX_DONE' });
  assert.equal(replied.state, 'completed');
  assert.equal(replied.reply.message, 'INBOX_DONE');
  const pumped = await f.peers.pump({ exchangeId: sent.exchangeId });
  assert.equal(pumped.state, 'completed');
  assert.equal(f.agents.calls.followup.length, 0, 'the sender still learns the answer through its own channel');
  assert.equal(pumped.notification.state, 'delivered');
});
