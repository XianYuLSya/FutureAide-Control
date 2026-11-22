// Cross-entry cleanup and input delivery against a disk-backed roster.
// The native Codex endpoint is a controllable local fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { createRosterCleanup } from '../src/cleanup-roster.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREAD = '11111111-1111-4111-8111-111111111111';
const extra = threadId => ({ _meta: { threadId } });
const MODEL = { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' };

async function fixture({ adapters = {}, clientFactory, controlFactory, idleSessionCleanup = true } = {}) {
  const base = path.join(os.tmpdir(), 'cleanup-interleave-tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'input-mode-'));
  const store = new RosterStore(path.join(stateDirectory, 'roster.sqlite'));
  const notices = [];
  const service = createScopedAgents({ stateDirectory, workspace,
    configFile: path.join(stateDirectory, 'config.json'), target: 'dsh', idleSessionCleanup }, {
    store,
    clientFactory: clientFactory ?? (() => { throw new Error('no DSH host is needed for this case'); }),
    ...(controlFactory ? { controlFactory } : {}),
    callCodex: async (threadId, tool, args) => (tool === 'read_thread'
      ? { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } }
      : (notices.push({threadId,tool,args}), { accepted: true })),
    backendAdapters: adapters,
    codexProbeRegistration: async () => ({ ready: true, registered: true,
      tools: ['ask_parent', 'report_parent'], sessionVerified: false }),
    startSharedMonitor: () => true,
    removeTree: async () => {},
  });
  const record = name => store.named(ownerIdFor(THREAD), name);
  return { service, store, stateDirectory, record, notices };
}

const inputsOf = inspected => inspected.inputs ?? [];
const inputFor = (inspected, requestId) => {
  const found = inputsOf(inspected).find(input => input.requestId === requestId);
  assert.ok(found, `inspect must carry the input ${requestId}; got ${inputsOf(inspected).map(input => input.requestId).join(', ') || 'none'}`);
  return found;
};
const entryCall = (service, entry, args) => entry === 'send'
  ? service.send(args, extra(THREAD))
  : service.run(args, extra(THREAD));

function fakeCodex() {
  const state = { running: false, descendantRunning: false, turnId: undefined, turnSeq: 0, question: undefined };
  const calls = { deliver: [], answer: [], root: 0, destroy: 0 };
  const factory = record => ({
    labels: { host: 'Codex Desktop', bridge: 'Codex Desktop fixture' },
    probe: async () => ({ identity: { workspace }, methods: [], treeProtocol: 1, reportProtocol: 1 }),
    create: async () => ({ sessionId: record.sessionId, modelRequestsStarted: 0 }),
    beginTask: async () => ({ treeProtocol: 1, reportProtocol: 1, throughSeq: 0 }),
    observe: async () => ({ sessionId: record.sessionId, taskId: record.task?.taskId,
      running: state.running || state.descendantRunning,
      questions: state.question ? [{ ...state.question }] : [], reports: state.reports, changes: [], throughSeq: 0,
      tree: { settled: !state.running && !state.descendantRunning, running: state.running || state.descendantRunning,
        nodes: [{ sessionId: record.sessionId, parentSessionId: null, name: record.name,
          status: state.running ? 'running' : 'idle', activity: state.running ? 'running' : 'idle',
          changes: [], coverage: 'root' },
        ...(state.descendantRunning ? [{ sessionId: 'child-thread', parentSessionId: record.sessionId,
          name: 'helper child', status: 'running', activity: 'running', changes: [], coverage: 'child' }] : [])] } }),
    history: async () => ({ messages: [], hasMore: false }),
    answer: async ({ answerId, message }) => {
      calls.answer.push({ answerId, message });
      if (state.question?.state !== 'pending') throw Object.assign(new Error('no pending question'), { code: 'question-not-pending' });
      state.question = { ...state.question, state: 'answered' };
      return { consumedQuestionIds: [state.question.id], continuation: `Parent answer:\n${message}` };
    },
    deliver: async input => {
      calls.deliver.push({ ...input });
      if (state.gate && input.message === state.gate.message) { state.gate.entered(); await state.gate.wait; }
      if (state.running) return { accepted: true, delivery: 'current-turn', turnId: state.turnId };
      state.running = true; state.turnId = `turn-${++state.turnSeq}`;
      return { accepted: true, delivery: 'new-turn', turnId: state.turnId };
    },
    receipt: async () => undefined,
    turn: async () => (state.running ? { state: 'running' } : { state: 'ended', completionReason: { kind: 'completed' } }),
    models: async () => ({ default: MODEL, routableProviders: [MODEL.provider], groups: [{ id: MODEL.provider, models: [{ id: MODEL.model, reasoningEfforts: ['high'] }] }] }),
    model: async () => MODEL,
    selectModel: async () => ({ accepted: true }),
    cancel: async () => { state.running = false; return { cancelRequested: true }; },
    destroy: async () => { calls.destroy++; return { destroyed: true }; },
    cursor: async () => ({ throughSeq: 0 }),
    rootTurn: async () => { calls.root++; return { running: state.running, ...(state.turnId ? { turnId: state.turnId } : {}) }; },
  });
  factory.calls = calls;
  factory.state = state;
  return factory;
}

async function codexFixture(idleSessionCleanup = true) {
  const codex = fakeCodex();
  const f = await fixture({ adapters: { 'codex-desktop': codex }, idleSessionCleanup });
  return { ...f, codex };
}

async function startCodex(f, name = 'codex-agent') {
  await f.service.create({ name, lifetime: 'persistent', target: 'codex-desktop' }, extra(THREAD));
  await f.service.send({ name, message: 'start the task' }, extra(THREAD));
  await f.service.poll(f.record(name).agentId);
  assert.equal(f.codex.state.running, true, 'the first Codex turn is running');
  return { name, agentId: f.record(name).agentId, turnId: f.codex.state.turnId };
}


for (const enabled of [true, false]) {
  test(`cleanup inventory cannot retire an active same-name steer or next-turn queue (switch ${enabled})`, async () => {
    const f = await codexFixture(enabled);
    const engine = createRosterCleanup({stateDirectory:f.stateDirectory, onceTerminalRetentionMs:0, agentIdleRetentionMs:0}, {
      desktop:{inspect:async()=>({running:false,treeIds:['fixture'],activityVersion:'v',historyPresent:false}),ownerStatus:async()=>({state:'unknown'})}
    });
    try {
      const h = await startCodex(f);
      const qText = '下一轮原文\nqueue 甲';
      const sText = '当前轮原文\nsteer 乙';
      const q = await f.service.send({name:h.name,message:qText,mode:'queue'},extra(THREAD));
      assert.equal(q.queued,true);
      assert.equal(f.store.supplement(q.requestId).status,'queued');
      assert.equal(f.store.supplement(q.requestId).message,qText);
      const pending = (await engine.inventory()).items.find(x=>x.id===h.agentId);
      assert.equal(pending.firstEligible,false,JSON.stringify(pending));
      assert.equal((await engine.remove(pending,{mode:'first',revalidate:async()=>true})).removed,false);
      const s = await f.service.run({name:h.name,message:sText,mode:'steer'},extra(THREAD));
      await f.service.poll(h.agentId);
      let candidate = (await engine.inventory()).items.find(x=>x.id===h.agentId);
      assert.ok(candidate); assert.equal(candidate.firstEligible,false,JSON.stringify(candidate));
      assert.equal((await engine.remove(candidate,{mode:'first',revalidate:async()=>true})).removed,false);
      assert.ok(f.record(h.name));
      assert.equal(f.codex.calls.deliver.filter(x=>x.message===sText).length,1);
      assert.equal(f.codex.calls.deliver.filter(x=>x.message===qText).length,0);
      assert.equal(f.store.supplement(q.requestId).message,qText);
      assert.equal(f.store.supplement(s.requestId).message,sText);
      f.codex.state.running=false;
      await f.service.poll(h.agentId);
      assert.equal(f.codex.calls.deliver.filter(x=>x.message===qText).length,1);
      candidate = (await engine.inventory()).items.find(x=>x.id===h.agentId);
      assert.ok(candidate); assert.equal(candidate.firstEligible,false,JSON.stringify(candidate));
      await f.service.poll(h.agentId);
      assert.equal(f.codex.calls.deliver.filter(x=>x.message===qText).length,1);
    } finally { f.service.close(); await rm(f.stateDirectory,{recursive:true,force:true}); }
  });


  test(`once final delivered through normal poll immediately removes the agent (switch ${enabled})`, async () => {
    const f = await codexFixture(enabled);
    try {
      const name='once-final';
      await f.service.create({name,lifetime:'once',target:'codex-desktop'},extra(THREAD));
      await f.service.send({name,message:'启动原文'},extra(THREAD));
      const id=f.record(name).agentId;
      await f.service.poll(id);
      const final='最终交付原文\n中文第二行';
      f.codex.state.running=false;
      f.codex.state.reports=[{id:'final-1',taskId:f.record(name).task.taskId,message:final,final:true,createdAt:new Date().toISOString()}];
      await f.service.poll(id);
      assert.equal(f.record(name),undefined);
      assert.equal(f.codex.calls.destroy,1);
      assert.equal(f.notices.filter(n=>JSON.stringify(n.args).includes(JSON.stringify(final).slice(1,-1))).length,1);
      assert.equal(f.codex.calls.deliver.filter(x=>x.message==='启动原文').length,1);
    } finally { f.service.close(); await rm(f.stateDirectory,{recursive:true,force:true}); }
  });



  test(`cleanup cannot retire or redeliver an input while native delivery is blocked (switch ${enabled})`, async () => {
    const f=await codexFixture(enabled);
    const engine=createRosterCleanup({stateDirectory:f.stateDirectory,onceTerminalRetentionMs:0,agentIdleRetentionMs:0}, {
      desktop:{inspect:async()=>({running:false,treeIds:['fixture'],activityVersion:'v',historyPresent:false}),ownerStatus:async()=>({state:'unknown'})}
    });
    let release;
    try {
      const h=await startCodex(f);
      const message='派送中原文\n保持完整';
      const q=await f.service.send({name:h.name,message,mode:'queue'},extra(THREAD));
      assert.equal(f.store.supplement(q.requestId).message,message);
      assert.equal(f.store.supplement(q.requestId).status,'queued');
      await f.service.poll(h.agentId);
      let entered;
      const reached=new Promise(resolve=>{entered=resolve;});
      const wait=new Promise(resolve=>{release=resolve;});
      f.codex.state.gate={message,entered,wait};
      f.codex.state.running=false;
      let polling;
      for (let i=0;i<8;i++) {
        polling=f.service.poll(h.agentId);
        if (await Promise.race([reached.then(()=>true),polling.then(()=>false)])) break;
        polling=undefined;
      }
      assert.ok(polling,'the queued delivery reached the native endpoint');
      assert.equal(f.codex.calls.deliver.filter(x=>x.message===message).length,1);
      const candidate=(await engine.inventory()).items.find(x=>x.id===h.agentId);
      assert.ok(candidate); assert.equal(candidate.firstEligible,false,JSON.stringify(candidate));
      assert.equal((await engine.remove(candidate,{mode:'first',revalidate:async()=>true})).removed,false);
      assert.ok(f.record(h.name));
      const second=f.service.poll(h.agentId);
      release(); await Promise.all([polling,second]);
      assert.equal(f.codex.calls.deliver.filter(x=>x.message===message).length,1);
      const input=inputFor(await f.service.inspect({name:h.name},extra(THREAD)),q.requestId);
      assert.equal(input.delivery,'new-turn');
      assert.equal(f.codex.calls.destroy,0);
    } finally { if (release) release(); f.service.close(); await rm(f.stateDirectory,{recursive:true,force:true}); }
  });

}

async function answerCleanupFixture({answer, dispatch, rowTask='round', rowMessage='回答原文\n甲', lifetime='persistent'}={}) {
  const stateDirectory=await mkdtemp(path.join(os.tmpdir(),'cleanup-answer-'));
  const store=new RosterStore(path.join(stateDirectory,'roster.sqlite'));
  store.saveOwner({ownerId:'owner',workspace:stateDirectory,source:'codex-desktop',threadId:'caller'});
  const record={agentId:'answer-agent',ownerId:'owner',name:'answer-helper',sessionId:'session',target:'codex-desktop',lifetime,state:'idle',
    task:{taskId:'round',state:'completed',finishedAt:'2020-01-01T00:00:00Z',answers:[answer],dispatches:dispatch?[dispatch]:[],
      reports:[{id:'final',message:'final',final:true,delivery:{state:'delivered',deliveredAt:'2020-01-01T00:00:00Z'}}]}};
  store.insert(record);
  store.db.prepare('INSERT INTO supplements(requestId,owner,agent,session,task,message,status,created,receipt) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('r','owner','answer-agent','session',rowTask,rowMessage,'accepted','2020-01-01T00:00:00Z',JSON.stringify({delivery:'answer-pending'}));
  const engine=createRosterCleanup({stateDirectory,agentIdleRetentionMs:0,onceTerminalRetentionMs:0},
    {desktop:{inspect:async()=>({running:false,treeIds:['session'],activityVersion:'v',historyPresent:false}),ownerStatus:async()=>({state:'unknown'})}});
  return {store,engine,record,async close(){store.close();await rm(stateDirectory,{recursive:true,force:true});}};
}

test('later native answer receipt supersedes only its exact queued answer', async () => {
  const message='回答原文\n甲';
  const accepted={answerId:'r',message,dispatched:true,accepted:true,delivery:'answered'};
  const dispatch={kind:'answer',requestId:'r',accepted:true,delivery:'current-turn',state:'running'};
  for (const [label,changes,expected] of [
    ['matching',{},true],
    ['different round',{rowTask:'other'},false],
    ['different body',{rowMessage:'其他正文'},false],
    ['different request',{answer:{...accepted,answerId:'different'}},false],
    ['native outcome unknown',{dispatch:{...dispatch,accepted:false,delivery:'unknown'}},false],
    ['unwritten',{answer:{...accepted,dispatched:false,accepted:false,delivery:'answer-pending'},dispatch:undefined},false],
    ['missing dispatch',{dispatch:undefined},false],
  ]) {
    const f=await answerCleanupFixture({answer:accepted,dispatch,...changes});
    try {
      const candidate=(await f.engine.inventory()).items[0];
      assert.equal(candidate.firstEligible,expected,`${label}: ${JSON.stringify(candidate)}`);
      assert.equal(f.store.supplement('r').message,changes.rowMessage??message);
    } finally {await f.close();}
  }
});

test('answer outcome recognises merged and legacy native dispatch only for matching identities', async () => {
  const {answerOutcome}=await import('../src/cleanup-input-receipts.mjs');
  const answer={answerId:'first',questionIds:['q1'],message:'第一份回答',dispatched:true};
  const merged={kind:'answer',requestId:'last',answerIds:['q1','q2'],accepted:true,state:'running'};
  assert.equal(answerOutcome({dispatches:[merged]},answer),'accepted');
  assert.equal(answerOutcome({dispatches:[{...merged,answerIds:['unrelated']}]},answer),'unknown');
  assert.equal(answerOutcome({dispatches:[{...merged,delivery:'unknown'}]},answer),'unknown');
  assert.equal(answerOutcome({dispatches:[]},{...answer,undelivered:'final-submitted'}),'blocked');
  assert.equal(answerOutcome({dispatches:[{...merged,accepted:false,delivery:'unknown'}]},{...answer,undelivered:'final-submitted'}),'unknown');
});

test('a sealed once answer enters the cleanup archive path', async () => {
  const answer={answerId:'r',message:'未送达原文\n保存我',dispatched:true,undelivered:'final-submitted'};
  const f=await answerCleanupFixture({answer,dispatch:undefined,rowMessage:answer.message,lifetime:'once'});
  try {
    f.store.db.prepare("UPDATE supplements SET status='blocked', receipt=? WHERE requestId='r'")
      .run(JSON.stringify({delivery:'blocked'}));
    const candidate=(await f.engine.inventory()).items[0];
    assert.equal(candidate.firstEligible,true,JSON.stringify(candidate));
    assert.equal(candidate.reason,'delivered-once-with-sealed-body');
  } finally {await f.close();}
});

test('expired unsent placeholder may archive; uncertain attempted write and missing identity may not', async () => {
  const {answerOutcome,unsentExpiredAnswer}=await import('../src/cleanup-input-receipts.mjs');
  const answer={answerId:'expired',message:'未发出',dispatched:true,undelivered:'dispatch-expired',delivery:'unknown'};
  const placeholder={kind:'answer',requestId:'expired',state:'unknown',accepted:false,expired:'dispatch-expired',
    error:{code:'dispatch-expired',message:'This input expired after six hours without being sent. Its body is kept.'}};
  assert.equal(unsentExpiredAnswer(placeholder),true);
  assert.equal(answerOutcome({dispatches:[placeholder]},answer),'blocked');
  assert.equal(answerOutcome({dispatches:[{...placeholder,attempted:true}]},answer),'unknown');
  assert.equal(answerOutcome({dispatches:[{...placeholder,error:{...placeholder.error,message:'This input expired after six hours with no confirmed receipt. Its body is kept.'}}]},answer),'unknown');
  assert.equal(answerOutcome({dispatches:[{kind:'answer',accepted:true}]},{dispatched:true}),'unknown');
});

test('unsent expired answer placeholder reaches once archive eligibility', async () => {
  const message='六小时后未发出的原文';
  const answer={answerId:'r',message,dispatched:true,undelivered:'dispatch-expired',delivery:'unknown'};
  const dispatch={kind:'answer',requestId:'r',state:'unknown',accepted:false,expired:'dispatch-expired',
    error:{code:'dispatch-expired',message:'This input expired after six hours without being sent. Its body is kept.'}};
  const f=await answerCleanupFixture({answer,dispatch,rowMessage:message,lifetime:'once'});
  try {
    const candidate=(await f.engine.inventory()).items[0];
    assert.equal(candidate.firstEligible,true,JSON.stringify(candidate));
    assert.equal(candidate.reason,'delivered-once-with-sealed-body');
    dispatch.attempted=true;
    f.record.task.dispatches=[dispatch]; f.store.save(f.record);
    assert.equal((await f.engine.inventory()).items[0].firstEligible,false);
  } finally {await f.close();}
});

test('old queued answer uses its own persisted round, including legacy history', async () => {
  const message='历史轮回答\n原文';
  const answer={answerId:'r',message,dispatched:true,accepted:true,delivery:'answered'};
  const dispatch={kind:'answer',requestId:'r',accepted:true,delivery:'current-turn',state:'running'};
  for (const storage of ['table','legacy']) {
    const f=await answerCleanupFixture({answer,dispatch,rowMessage:message});
    try {
      const old=structuredClone(f.record.task);
      f.record.task={taskId:'new-round',state:'completed',finishedAt:'2020-01-02T00:00:00Z',answers:[],dispatches:[],reports:[]};
      if (storage==='table') f.store.appendHistory(f.record.agentId,old);
      else f.record.history=[old];
      f.store.save(f.record);
      assert.equal((await f.engine.inventory()).items[0].firstEligible,true,storage);
      // A conflicting duplicate of the same task is insufficient proof.
      f.record.history=[{...old,answers:[{...answer,message:'不同正文'}]}]; f.store.save(f.record);
      assert.equal((await f.engine.inventory()).items[0].firstEligible,false,storage);
    } finally {await f.close();}
  }
});
