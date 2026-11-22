// Answers to a managed Codex Desktop helper.
//
// A Codex helper's ask_parent is one MCP call: its turn does not end, and the helper
// keeps working on whatever does not depend on the answer. These cases run the real
// shared state machine, the real roster and the real Codex adapter, host and RPC
// selection (turn/steer for a running turn, turn/start for an idle thread); only
// the desktop's own RPC endpoint is a local stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';
import { liveThread, liveTurn, livePage } from '../test/live-thread-fixture.mjs';
import { CODEX_MODELS } from '../test/assembly/renderer.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOSS = '11111111-1111-4111-8111-111111111111';
const extra = threadId => ({ _meta: { threadId } });

/** The Codex Desktop RPC, reduced to threads and turns the adapter reads and writes. */
function codexDesktop() {
  const threads = new Map(), calls = [], nativeAnswers = [];
  let created = 0, clock = 1793932679;
  const textOf = input => (input ?? []).map(item => item.text ?? '').join('');
  const userItem = text => ({ id: `item-${++clock}`, type: 'userMessage', content: [{ type: 'text', text }] });
  const running = thread => thread.turns.find(turn => turn.status === 'inProgress');
  const find = id => {
    const thread = threads.get(id);
    if (!thread) throw Object.assign(new Error(`thread not found: ${id}`), { code: 'codex-thread-not-found' });
    return thread;
  };
  async function request(method, params = {}) {
    calls.push({ method, params: structuredClone(params) });
    switch (method) {
      case 'thread/list': return livePage();
      case 'model/list': return livePage(structuredClone(CODEX_MODELS));
      case 'config/read': return { model: 'gpt-6-astra', provider: 'openai', reasoningEffort: 'high', profile: null };
      case 'thread/start': {
        const id = `${String(++created).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
        threads.set(id, { id, cwd: params.cwd, name: null, turns: [], updatedAt: ++clock, model: 'gpt-6-astra', reasoningEffort: 'high' });
        return { thread: liveThread({ id, cwd: params.cwd, updatedAt: clock, model: 'gpt-6-astra', reasoningEffort: 'high' }) };
      }
      case 'thread/read':
      case 'thread/resume': {
        const thread = find(params.threadId);
        return { thread: liveThread({ id: thread.id, cwd: thread.cwd, name: thread.name, updatedAt: thread.updatedAt,
          model: thread.model, reasoningEffort: thread.reasoningEffort,
          status: running(thread) ? { type: 'active', activeFlags: thread.nativeCard ? ['waitingOnUserInput'] : [] }
            : { type: 'idle' } }) };
      }
      case 'thread/name/set': {
        const thread = find(params.threadId);
        thread.name = params.name; thread.updatedAt = ++clock;
        return {};
      }
      case 'thread/turns/list': {
        // Like the desktop, a summary page carries only a turn's first user message
        // and last agent message: input steered into the turn is not on it.
        const items = turn => params.itemsView !== 'summary' ? []
          : [turn.items.find(item => item.type === 'userMessage'), turn.items.findLast(item => item.type === 'agentMessage')].filter(Boolean);
        return livePage(find(params.threadId).turns.toReversed().map(turn => liveTurn({ id: turn.id, rootTurnId: turn.id,
          status: turn.status, startedAt: turn.startedAt, itemsView: params.itemsView, items: items(turn) })));
      }
      case 'turn/start': {
        const thread = find(params.threadId);
        if (running(thread)) throw Object.assign(new Error('a turn is already running on this thread'), { code: 'codex-native-rpc-rejected' });
        // A turn is the only place a selection can change; the thread reports it afterwards.
        if (params.model !== undefined) thread.model = params.model;
        if (params.effort !== undefined) thread.reasoningEffort = params.effort;
        const turn = { id: `turn-${++clock}`, status: 'inProgress', startedAt: ++clock, items: [userItem(textOf(params.input))] };
        thread.turns.push(turn); thread.updatedAt = ++clock;
        return { turn: liveTurn({ id: turn.id, rootTurnId: turn.id, status: 'inProgress', items: [] }) };
      }
      case 'turn/steer': {
        const thread = find(params.threadId), turn = running(thread);
        if (!turn || turn.id !== params.expectedTurnId) throw Object.assign(new Error('no active turn to steer'), { code: 'codex-native-rpc-rejected' });
        turn.items.push(userItem(textOf(params.input))); thread.updatedAt = ++clock;
        return { turnId: turn.id };
      }
      case 'futureaide/userInput/read': {
        const thread = find(params.threadId);
        return { status: 'observed', requests: thread.nativeCard ? [thread.nativeCard] : [] };
      }
      case 'futureaide/userInput/reply': {
        const thread = find(params.card.threadId);
        if (thread.nativeCard?.requestId !== params.card.requestId) return { status: 'not-pending' };
        if (thread.forceInterrupt) return { status: 'unsupported' };
        nativeAnswers.push(params.answers);
        delete thread.nativeCard;
        return { status: 'answered' };
      }
      case 'turn/interrupt': {
        const thread = find(params.threadId), turn = running(thread);
        assert.equal(params.turnId, turn?.id);
        turn.status = 'interrupted';
        delete thread.nativeCard;
        thread.updatedAt = ++clock;
        return {};
      }
      default: throw new Error(`unexpected native method ${method}`);
    }
  }
  return {
    request,
    threadIds: () => [...threads.keys()],
    runningTurn: threadId => running(find(threadId))?.id,
    nativeAnswers,
    interruptCalls: () => calls.filter(call => call.method === 'turn/interrupt'),
    askNative(threadId, { forceInterrupt = false } = {}) {
      const thread = find(threadId);
      thread.forceInterrupt = forceInterrupt;
      thread.nativeCard = { requestId: 91, threadId, turnId: running(thread).id, itemId: 'native-item',
        kind: 'question', isBlocking: true, questions: [{ id: 'location', header: 'First run',
          question: 'Where should the first run start?', isOther: false, isSecret: false,
          options: [{ label: 'Local', description: 'Start it in the current project.' },
            { label: 'Remote', description: 'Start it on the test server.' }] }] };
      thread.updatedAt = ++clock;
    },
    /** Text the helper thread received, optionally by the RPC that carried it. */
    inputs: method => calls.filter(call => ['turn/start', 'turn/steer'].includes(call.method) && (!method || call.method === method))
      .map(call => ({ method: call.method, turnId: call.params.expectedTurnId, text: textOf(call.params.input), params: call.params })),
    /** The helper's turn ends with an ordinary reply, which never reports to the parent. */
    endTurn(threadId, reply) {
      const thread = find(threadId), turn = running(thread);
      assert.ok(turn, 'the helper has a running turn to end');
      turn.items.push({ id: `item-${++clock}`, type: 'agentMessage', text: reply });
      turn.status = 'completed'; thread.updatedAt = ++clock;
    },
  };
}

async function fixture(configuration, configRoot) {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'answer-'));
  const store = new RosterStore(':memory:');
  const codex = codexDesktop();
  const notices = [];
  const configFile = path.join(configRoot, 'config.json');
  await writeFile(configFile, JSON.stringify(configuration));
  const config = await loadConfig(configFile);
  const service = createScopedAgents({ ...config, stateDirectory, workspace }, {
    store,
    clientFactory: () => { throw new Error('no DSH host is needed for these cases'); },
    // The calling chat: what it is told arrives here.
    callCodex: async (threadId, tool, args) => {
      if (tool === 'read_thread') return { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } };
      notices.push(args.prompt);
      return { accepted: true };
    },
    backendAdapters: { 'codex-desktop': (record, deps) => createCodexBackend(record, { ...deps, hostOptions: { nativeRequest: codex.request } }) },
    codexProbeRegistration: async () => ({ ready: true, registered: true, tools: ['ask_parent', 'report_parent'], sessionVerified: false }),
    startSharedMonitor: () => true,
    removeTree: async () => {},
  });
  const record = name => store.named(ownerIdFor(BOSS), name);
  return {
    service, store, codex, notices, record,
    /** Create a persistent Codex helper, hand it a task and let the first turn start. */
    async start(name, task, selection = {}) {
      await service.create({ name, lifetime: 'persistent', target: 'codex-desktop', ...selection }, extra(BOSS));
      const receipt = await service.send({ name, message: task }, extra(BOSS));
      const agentId = record(name).agentId;
      await service.poll(agentId);
      const [threadId] = codex.threadIds();
      const turnId = codex.runningTurn(threadId);
      assert.ok(turnId, 'the task started a turn on the helper thread');
      return { name, agentId, threadId, turnId, receipt };
    },
    poll: helper => service.poll(helper.agentId),
    // What the helper does from inside its own conversation.
    ask: (helper, message) => service.submitToParent({ kind: 'ask', message }, extra(helper.threadId)),
    report: (helper, message, final = false) => service.submitToParent({ kind: 'report', message, final }, extra(helper.threadId)),
    answer: (helper, message) => service.answer({ name: helper.name, message }, extra(BOSS)),
  };
}


// Each case creates a new process-equivalent service after writing the config. Both
// model and business text stay fixed; only one plugin default is changed.
for (const [label, first, second, source] of [
  ['per-model', { defaultEffort: 'max', modelDefaultEfforts: { 'gpt-6-astra': 'max' } }, { defaultEffort: 'max', modelDefaultEfforts: { 'gpt-6-astra': 'high' } }, 'model-default'],
  ['global', { defaultEffort: 'max' }, { defaultEffort: 'high' }, 'global-default'],
]) {
  test('configuration reload changes ' + label + ' default through scoped and Codex adapter', async () => {
    const configRoot = await mkdtemp(path.join(tmpdir(), 'effort-reload-'));
    try {
    for (const [configuration, expected] of [[first, 'max'], [second, 'high']]) {
      const f = await fixture(configuration, configRoot);
      try {
        const helper = await f.start('worker', 'Identical business input.');
        assert.ok(helper.receipt.requestId);
        assert.equal(helper.receipt.requestedEffort, expected);
        assert.equal(helper.receipt.selectedEffort, expected);
        assert.equal(helper.receipt.effortSource, source);
        assert.equal(helper.receipt.actualEffort, null);
        const starts = f.codex.inputs('turn/start');
        assert.equal(starts.length, 1);
        assert.equal(starts[0].params.model, 'gpt-6-astra');
        assert.equal(starts[0].params.effort, expected);
        assert.ok(starts[0].text.startsWith('Identical business input.')); 
        const item = (await f.service.list(extra(BOSS))).items[0];
        assert.equal(item.actualEffort, expected);
        assert.equal(item.effortSource, source);
      } finally { f.store.close(); }
    }
    } finally { await rm(configRoot, { recursive: true, force: true }); }
  });
}
