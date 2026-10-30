import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const extra = threadId => ({ _meta: { threadId } });

async function fixture() {
  const base = path.join(workspace, 'clean', 'scoped-tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'run-'));
  const store = new RosterStore(':memory:');
  const sessions = new Map();
  const sends = [], notices = [], removed = [], workers = [];
  let offline = false, notificationMode = 'ok', statusCalls = 0;
  const api = {
    async connectionIdentity() { if (offline) throw new Error('DSH offline'); return { application: 'dsh', dataRoot: path.join(stateDirectory, 'native') }; },
    async hostStatus() { return { methods: ['managedCreate', 'managedBeginTask', 'managedStatus', 'managedAnswer', 'managedCancel', 'managedDestroy'] }; },
    async managedCreate(input) {
      if (!sessions.has(input.sessionId)) sessions.set(input.sessionId, { ...input, model: { provider: 'fixture', model: 'test' }, running: false, seq: 0, questions: [], changes: [], turns: new Map() });
      return { ...sessions.get(input.sessionId), modelRequestsStarted: 0 };
    },
    async managedBeginTask(input) {
      const s = sessions.get(input.sessionId);
      if (s.taskId !== input.taskId) Object.assign(s, { taskId: input.taskId, questions: [], changes: [], cancelled: false });
      return { taskId: s.taskId };
    },
    async managedStatus(input) {
      statusCalls++;
      const s = sessions.get(input.sessionId);
      return { sessionId: s.sessionId, taskId: s.taskId, running: s.running, questions: s.questions,
        changes: s.changes, coverage: 'files written by this agent', activity: s.running ? 'writing' : 'idle', throughSeq: s.seq };
    },
    async historyCursor(sessionId) { return { throughSeq: sessions.get(sessionId).seq }; },
    async readSession(sessionId) {
      const s = sessions.get(sessionId), events = [];
      for (const [requestId, turn] of s.turns) {
        events.push({ seq: turn.afterSeq, type: 'turn/start', data: { turn: requestId } },
          { seq: turn.afterSeq + 1, type: 'user/message', data: { role: 'user', source: { rpcId: requestId }, content: [] } });
        for (const message of turn.messages ?? []) events.push({ seq: message.seq, type: 'assistant/message',
          data: { role: 'assistant', content: [{ type: 'text', text: message.text }] } });
        if (turn.state === 'ended') events.push({ seq: turn.endSeq, type: 'turn/end', data: { turn: requestId, reason: turn.completionReason } });
      }
      return { records: events.map(event => ({ type: 'event', event })), hasMore: false };
    },
    async managedAnswer(input) {
      const s = sessions.get(input.sessionId);
      s.answers ??= new Map();
      if (s.answers.has(input.answerId)) return s.answers.get(input.answerId);
      const pending = s.questions.filter(question => question.state === 'pending');
      pending.forEach(question => { question.state = 'answered'; });
      const result = { consumedQuestionIds: pending.map(question => question.id), continuation: `Answer: ${input.message}` };
      s.answers.set(input.answerId, result);
      return result;
    },
    async managedCancel(input) {
      const s = sessions.get(input.sessionId); s.running = false;
      s.questions.forEach(question => { question.state = 'cancelled'; });
      return { cancelled: true };
    },
    async managedDestroy(input) { sessions.delete(input.sessionId); removed.push(input.sessionId); return { destroyed: true }; },
  };
  const controlFactory = () => ({
    async models() { return { defaultModel: { provider: 'fixture', model: 'test' } }; },
    async selectModel() { return { accepted: true }; },
    async send(input) {
      const s = sessions.get(input.sessionId);
      const afterSeq = s.seq;
      s.running = true; s.seq += 1;
      s.turns.set(input.requestId, { afterSeq, state: 'running' });
      sends.push(input);
      return { accepted: true, afterSeq };
    },
    async wait(input) {
      const s = sessions.get(input.sessionId);
      const turn = s.turns.get(input.requestId);
      return { ...turn, messages: turn.messages?.map(message => ({ ...message, text: message.text.slice(0, 8000), textTruncated: message.text.length > 8000 })), afterSeq: input.afterSeq ?? turn?.afterSeq,
        correlation: 'request-id', sessionId: s.sessionId };
    },
    async read() { return { messages: [] }; },
  });
  const callCodex = async (threadId, tool, args) => {
    if (tool === 'read_thread') return { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace },
      turns: args.includeOutputs ? notices.filter(notice => notice.threadId === threadId) : [] };
    if (notificationMode === 'reject') return { isError: true };
    notices.push({ threadId, prompt: args.prompt });
    if (notificationMode === 'unknown') throw new Error('Lost delivery acknowledgement');
    return { accepted: true };
  };
  const service = createScopedAgents({ stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json') }, {
    store, clientFactory: () => api, controlFactory, callCodex,
    startWorker: (...args) => { workers.push(args); return 99999; }, removeTree: async directory => { removed.push(directory); },
  });
  const record = (name = 'artist', thread = A) => store.named(ownerIdFor(thread), name);
  function finish(name = 'artist', reply = '完成', thread = A) {
    const r = record(name, thread), s = sessions.get(r.sessionId);
    s.running = false; s.seq += 2;
    for (const [id, turn] of s.turns) if (turn.state !== 'ended') s.turns.set(id, { ...turn, state: 'ended', endSeq: s.seq,
      completionReason: { kind: 'completed' }, messages: [{ seq: s.seq - 1, role: 'assistant', text: reply }] });
  }
  return { service, store, sessions, api, sends, notices, removed, workers, stateDirectory, record, finish,
    offline: value => { offline = value; }, notification: value => { notificationMode = value; }, statusCalls: () => statusCalls };
}

test('names and all operations are scoped by native chat metadata; create uses no model turn', async () => {
  const f = await fixture();
  await assert.rejects(f.service.create({ name: 'artist', lifetime: 'persistent' }, {}), /calling chat identity/);
  for (const thread of [A, B]) {
    const value = await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(thread));
    assert.equal(value.modelRequestsStarted, 0);
  }
  assert.equal(f.sends.length, 0);
  assert.notEqual(f.record('artist', A).sessionId, f.record('artist', B).sessionId);
  assert.equal((await f.service.list(extra(A))).items.length, 1);
  await f.service.delete({ name: 'artist' }, extra(A));
  assert.equal((await f.service.list(extra(A))).items.length, 0);
  assert.equal((await f.service.list(extra(B))).items.length, 1);
  assert.deepEqual((await f.service.wait({ names: ['artist'], timeoutSeconds: 0 }, extra(A))).notListed, ['artist']);
  f.service.close();
});

test('one-shot asks directly, resumes once, and clears only after confirmed result delivery', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: '画图\n“中文”' }, extra(A));
  const r = f.record(), s = f.sessions.get(r.sessionId);
  s.questions = [{ id: 'question-1', message: '使用什么颜色？', state: 'pending' }];
  f.finish('artist', '等待回答');
  await f.service.poll(r.agentId);
  assert.equal(f.record().state, 'awaiting_input');
  assert.equal(f.removed.length, 0);
  await f.service.answer({ name: 'artist', message: '蓝色' }, extra(A));
  await f.service.poll(r.agentId);
  assert.equal(f.sends.length, 2);
  await f.service.poll(r.agentId);
  assert.equal(f.sends.length, 2);
  s.changes = [{ path: 'art.svg', operation: 'create' }];
  f.finish('artist', '已画好 art.svg');
  await f.service.poll(r.agentId);
  assert.equal(f.record(), undefined);
  assert.equal(f.removed[0], r.sessionId);
  assert.match(f.notices.at(-1).prompt, /已画好 art.svg/);
  assert.match(f.notices.at(-1).prompt, /art.svg/);
  f.service.close();
});

test('persistent agents reuse one session and retain earlier task changes', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  const id = f.record().sessionId;
  await f.service.send({ name: 'artist', message: 'first' }, extra(A));
  f.sessions.get(id).changes = [{ path: 'first.svg', operation: 'write' }];
  f.finish(); await f.service.poll(f.record().agentId);
  assert.equal(f.record().state, 'idle');
  await f.service.send({ name: 'artist', message: 'second' }, extra(A));
  assert.equal(f.record().sessionId, id);
  assert.deepEqual((await f.service.changes({ name: 'artist', task: 1 }, extra(A))).changes, [{ path: 'first.svg', operation: 'write' }]);
  assert.equal(f.removed.length, 0);
  f.service.close();
});

test('cached results can return while DSH is offline; ambiguous delivery is read back without resending', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  f.finish(); f.notification('unknown');
  await f.service.poll(f.record().agentId);
  const r = f.record();
  assert.equal(r.task.delivery.state, 'unknown');
  r.task.delivery.nextAttemptAt = 0; f.store.save(r);
  const observed = f.statusCalls();
  f.offline(true);
  await f.service.poll(r.agentId);
  assert.equal(f.record().state, 'idle');
  assert.equal(f.statusCalls(), observed);
  assert.equal(f.notices.length, 1);
  f.service.close();
});

test('failed return does not clear a one-shot session', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  f.finish(); f.notification('reject');
  await f.service.poll(f.record().agentId);
  assert.equal(f.record().state, 'delivery_pending');
  assert.equal(f.removed.length, 0);
  f.service.close();
});

test('cancel closes pending questions and returns cancellation before one-shot cleanup', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  const r = f.record();
  f.sessions.get(r.sessionId).questions = [{ id: 'q', message: 'question', state: 'pending' }];
  await f.service.cancel({ name: 'artist' }, extra(A));
  await f.service.poll(r.agentId);
  assert.equal(f.record(), undefined);
  assert.match(f.notices.at(-1).prompt, /已取消/);
  f.service.close();
});

test('a crash before writeOnce starts reuses the original request, without minting another task', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  const r = f.record();
  r.state = 'running';
  r.task = { taskId: 'task-existing', message: 'task', state: 'running', dispatches: [{ requestId: 'request-existing', message: 'task', state: 'sending', afterSeq: 0 }], answers: [] };
  f.sessions.get(r.sessionId).taskId = r.task.taskId; f.store.save(r);
  await f.service.poll(r.agentId);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].requestId, 'request-existing');
  assert.equal(f.record().task.dispatches.length, 1);
  f.service.close();
});

test('accepted dispatch receipt restores a lost acknowledgement without another send', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  const r = f.record(), dispatch = r.task.dispatches[0];
  const key = createHash('sha256').update(JSON.stringify(['send', r.sessionId, dispatch.requestId])).digest('hex');
  const directory = path.join(f.stateDirectory, 'scoped', r.ownerId, r.agentId, 'requests');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${key}.json`), JSON.stringify({ status: 'accepted', afterSeq: dispatch.afterSeq }));
  dispatch.accepted = false; dispatch.state = 'sending'; dispatch.afterSeq = undefined; f.store.save(r);
  f.finish(); await f.service.poll(r.agentId);
  assert.equal(f.sends.length, 1);
  assert.equal(f.record().state, 'idle');
  f.service.close();
});

test('worker lease expiry restarts monitoring and list does not overwrite task state', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  const r = f.record();
  assert.equal(f.workers.length, 1);
  await f.service.list(extra(A)); assert.equal(f.workers.length, 1);
  f.store.db.prepare('UPDATE leases SET expires=0 WHERE key=?').run(`worker:${r.agentId}`);
  await f.service.list(extra(A));
  assert.equal(f.workers.length, 2);
  assert.equal(f.record().task.dispatches[0].requestId, r.task.dispatches[0].requestId);
  f.service.close();
});

test('one-shot returns full native text rather than the truncated inspection view', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: 'long answer' }, extra(A));
  const r = f.record(), reply = '中'.repeat(9000) + '完整结尾';
  f.finish('artist', reply);
  await f.service.poll(r.agentId);
  assert.ok(f.notices.at(-1).prompt.includes(reply));
  assert.equal(f.record(), undefined);
  f.service.close();
});

test('list and automatic result notices include file summaries, never file bodies', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'draw a diagram' }, extra(A));
  f.sessions.get(f.record().sessionId).changes = [{ path: 'diagram.svg', operation: 'create', before: '', after: '<svg>private full file body</svg>' }];
  f.finish('artist', 'Saved diagram.svg'); await f.service.poll(f.record().agentId);
  const list = await f.service.list(extra(A));
  assert.ok(!JSON.stringify(list).includes('private full file body'));
  assert.ok(!f.notices.at(-1).prompt.includes('private full file body'));
  assert.equal((await f.service.changes({ name: 'artist' }, extra(A))).changes[0].after, '<svg>private full file body</svg>');
  f.service.close();
});
