import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgents } from '../src/agents.mjs';

const THREAD = '44444444-4444-4444-8444-444444444444';
const catalog = {
  default: { provider: 'wb', model: 'flash', reasoningEffort: 'max' },
  routableProviders: ['wb'],
  groups: [{ id: 'wb', models: [{ id: 'flash', reasoning: { efforts: [{ id: 'max' }] } }] }],
};

test('suppressCallback is scoped to one peer dispatch and the original binding survives', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-agent-suppress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const config = { workspace, stateDirectory: path.join(root, 'state'), registryDirectory: path.join(root, 'agents') };
  const configs = [];
  const sends = [];
  const controlFactory = controlConfig => {
    configs.push(controlConfig);
    return {
      async connect() { return { ready: true }; },
      async connectionIdentity() { return { baseUrl: 'http://127.0.0.1:12345', pid: 123 }; },
      async models() { return catalog; },
      async createSession() { return { accepted: true, sessionId: 'session-1' }; },
      async selectModel() { return { accepted: true }; },
      async send(input) {
        sends.push({ codexThreadId: controlConfig.codexThreadId, input });
        return { accepted: true, afterSeq: 0 };
      },
      async wait() {
        return { state: 'ended', completionReason: { kind: 'completed' }, messages: [] };
      },
      async cancel() { return { accepted: true }; },
    };
  };
  const agents = createAgents(config, { controlFactory });
  const spawned = await agents.spawn({
    workspace,
    message: 'original task',
    requestId: 'spawn-suppress',
    codexThreadId: THREAD,
  });
  assert.equal(spawned.accepted, true);
  assert.equal(sends[0].codexThreadId, THREAD);

  const suppressed = await agents.followup({
    agentId: spawned.agentId,
    message: 'peer question',
    requestId: 'peer-followup',
    suppressCallback: true,
  });
  assert.equal(suppressed.accepted, true);
  assert.equal(suppressed.suppressCallback, true);
  assert.equal(sends[1].codexThreadId, undefined);
  const stored = JSON.parse(await readFile(path.join(root, 'agents', spawned.agentId, 'agent.json'), 'utf8'));
  assert.equal(stored.dispatches['peer-followup'].suppressCallback, true);
  assert.equal(stored.codexThreadId, THREAD);

  const ordinary = await agents.followup({
    agentId: spawned.agentId,
    message: 'ordinary followup',
    requestId: 'ordinary-followup',
  });
  assert.equal(ordinary.accepted, true);
  assert.equal(sends[2].codexThreadId, THREAD);
  assert.equal(ordinary.suppressCallback, undefined);

  await assert.rejects(agents.followup({
    agentId: spawned.agentId,
    message: 'peer question',
    requestId: 'peer-followup',
    suppressCallback: false,
  }), /different callback policy/);
  assert.ok(configs.some(entry => entry.codexThreadId === THREAD));
  assert.ok(configs.some(entry => entry.codexThreadId === undefined));
});

test('an unknown dispatch is confirmed only by an exact native request-id turn', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-agent-unknown-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const config = { workspace, stateDirectory: path.join(root, 'state'), registryDirectory: path.join(root, 'agents') };
  let unknown = undefined;
  const sends = [];
  const controlFactory = () => ({
    async connect() { return { ready: true }; },
    async connectionIdentity() { return { baseUrl: 'http://127.0.0.1:12345', pid: 123 }; },
    async models() { return catalog; },
    async createSession() { return { accepted: true, sessionId: 'session-1' }; },
    async selectModel() { return { accepted: true }; },
    async send({ requestId }) {
      sends.push(requestId);
      if (requestId === unknown) throw Object.assign(new Error('send response lost'), { uncertain: true, afterSeq: 5 });
      return { accepted: true, afterSeq: 0 };
    },
    async wait({ requestId }) {
      if (requestId === 'unknown-exact') {
        return { state: 'ended', correlation: 'request-id', completionReason: { kind: 'completed' },
          messages: [{ role: 'assistant', text: 'EXACT_NATIVE_RECOVERY' }], afterSeq: 5, endSeq: 6 };
      }
      if (requestId === 'unknown-baseline') {
        return { state: 'ended', correlation: 'baseline', completionReason: { kind: 'completed' },
          messages: [{ role: 'assistant', text: 'MUST_NOT_BE_ADOPTED' }], afterSeq: 9, endSeq: 10 };
      }
      return { state: 'ended', correlation: 'request-id', completionReason: { kind: 'completed' }, messages: [] };
    },
    async cancel() { return { accepted: true }; },
  });
  const agents = createAgents(config, { controlFactory });
  const spawned = await agents.spawn({ workspace, message: 'work', requestId: 'unknown-spawn' });

  unknown = 'unknown-exact';
  const lost = await agents.followup({ agentId: spawned.agentId, message: 'exact recovery', requestId: 'unknown-exact' });
  assert.equal(lost.accepted, false);
  const before = sends.filter(id => id === 'unknown-exact').length;
  const recovered = await agents.wait({ agentId: spawned.agentId, requestId: 'unknown-exact' });
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.reply, 'EXACT_NATIVE_RECOVERY');
  assert.equal(recovered.recoveredFrom, 'native-read-only');
  assert.equal(sends.filter(id => id === 'unknown-exact').length, before, 'the read-only check must not resend');
  const stored = JSON.parse(await readFile(path.join(root, 'agents', spawned.agentId, 'agent.json'), 'utf8'));
  assert.equal(stored.dispatches['unknown-exact'].accepted, true);
  assert.equal(stored.dispatches['unknown-exact'].state, 'completed');
  assert.equal(stored.dispatches['unknown-exact'].recoveredFrom, 'native-read-only');

  unknown = 'unknown-baseline';
  const baselineLost = await agents.followup({
    agentId: spawned.agentId, message: 'baseline only', requestId: 'unknown-baseline',
  });
  assert.equal(baselineLost.accepted, false);
  const notConfirmed = await agents.wait({ agentId: spawned.agentId, requestId: 'unknown-baseline' });
  assert.equal(notConfirmed.state, 'unknown');
  assert.equal(notConfirmed.reply, undefined);
  const storedAgain = JSON.parse(await readFile(path.join(root, 'agents', spawned.agentId, 'agent.json'), 'utf8'));
  assert.equal(storedAgain.dispatches['unknown-baseline'].accepted, false);
  assert.equal(storedAgain.dispatches['unknown-baseline'].state, 'unknown');
});

test('suppressCallback must be boolean and does not alter the agent record binding', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-agent-suppress-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const config = { workspace, stateDirectory: path.join(root, 'state'), registryDirectory: path.join(root, 'agents') };
  const control = {
    async connect() { return { ready: true }; },
    async connectionIdentity() { return { baseUrl: 'http://127.0.0.1:12345', pid: 123 }; },
    async models() { return catalog; },
    async createSession() { return { accepted: true, sessionId: 'session-1' }; },
    async selectModel() { return { accepted: true }; },
    async send() { return { accepted: true, afterSeq: 0 }; },
    async wait() { return { state: 'ended', completionReason: { kind: 'completed' }, messages: [] }; },
    async cancel() { return { accepted: true }; },
  };
  const agents = createAgents(config, { controlFactory: () => control });
  const spawned = await agents.spawn({ workspace, message: 'work', requestId: 'spawn', codexThreadId: THREAD });
  await assert.rejects(agents.followup({
    agentId: spawned.agentId, message: 'x', requestId: 'bad', suppressCallback: 'yes',
  }), /must be a boolean/);
  const stored = JSON.parse(await readFile(path.join(root, 'agents', spawned.agentId, 'agent.json'), 'utf8'));
  assert.equal(stored.codexThreadId, THREAD);
});
