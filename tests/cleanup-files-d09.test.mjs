import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createFileCleanup } from '../src/cleanup-files.mjs';
import { RosterStore } from '../src/roster-store.mjs';
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true});
function fixture() {
  const base=mkdtempSync(path.join(os.tmpdir(),'cleanup-file-d09-'));
  const runtime=path.join(base,'runtime'), state=path.join(runtime,'state'), development=path.join(runtime,'development');
  const repo=path.join(runtime,'publish','20261030','FutureAide-Control'),diagnostics=path.join(runtime,'diagnostics');
  for(const dir of [repo,state,development,diagnostics])mkdirSync(dir,{recursive:true});
  const configFile=path.join(runtime,'config.json');writeFileSync(configFile,'{}');
  git(repo,'init','-b','main'); git(repo,'config','user.email','fixture@example.invalid'); git(repo,'config','user.name','Fixture');
  writeFileSync(path.join(repo,'.gitignore'),'ignored.txt\n');writeFileSync(path.join(repo,'tracked.txt'),'base\n');
  git(repo,'add','.');git(repo,'commit','-m','fixture');
  const now=Date.parse('2026-01-10T00:00:00.000Z');
  const engine=createFileCleanup({stateDirectory:state,configFile,diagnosticRetentionMs:7*86400000},{now:()=>now});
  function worktree(name){const dir=path.join(development,name);git(repo,'worktree','add','-b',`branch-${name}`,dir,'main');return dir;}
  return {base,runtime,state,repo,development,diagnostics,engine,now,worktree,close(){rmSync(base,{recursive:true,force:true});}};
}
const inspect=(f,name,kind)=>f.engine.inspect({kind,root:kind==='worktree'?f.development:f.diagnostics,name});
test('7-day diagnostics check deadline, producer, live pid and authorization',async()=>{
  const f=fixture();
  try {
    const stale=`mcp-99999999-1234567890123.jsonl`, active=`mcp-${process.pid}-1234567890123.jsonl`;
    for(const [name,pid] of [[stale,99999999],[active,process.pid]])writeFileSync(path.join(f.diagnostics,name),JSON.stringify({event:'start',pid})+'\n');
    const date=new Date(f.now-7*86400000); utimesSync(path.join(f.diagnostics,stale),date,date); utimesSync(path.join(f.diagnostics,active),date,date);
    const candidate=await inspect(f,stale,'diagnostic');assert.equal(candidate.eligible,true);assert.equal(candidate.running,false);
    const newer='mcp-99999998-1234567890123.jsonl'; writeFileSync(path.join(f.diagnostics,newer),JSON.stringify({event:'start',pid:99999998})+'\n');
    const before=new Date(f.now-7*86400000+1);utimesSync(path.join(f.diagnostics,newer),before,before);
    assert.equal((await inspect(f,newer,'diagnostic')).eligible,false);
    const forged='mcp-99999997-1234567890123.jsonl';writeFileSync(path.join(f.diagnostics,forged),JSON.stringify({event:'start',pid:7})+'\n');utimesSync(path.join(f.diagnostics,forged),date,date);
    assert.equal((await f.engine.remove(await inspect(f,forged,'diagnostic'),{mode:'rules',revalidate:async()=>true})).reason,'unrecognized-log-producer');
    const current=await inspect(f,active,'diagnostic');assert.equal(current.firstEligible,false);
    assert.equal((await f.engine.remove(candidate,{mode:'rules',revalidate:async()=>false})).removed,false);
    const result=await f.engine.remove(candidate,{mode:'rules',revalidate:async()=>true});
    assert.equal(result.removed,true,JSON.stringify(result)); assert.equal(existsSync(path.join(f.diagnostics,stale)),false);
  } finally {f.close();}
});
test('worktrees classify and only approved clean idle worktree is removed; branch remains',async()=>{
  const f=fixture();
  try {
    const clean=f.worktree('clean'), dirty=f.worktree('dirty'), ignored=f.worktree('ignored'), ahead=f.worktree('ahead');
    f.worktree('p1-supplement-steer'); mkdirSync(path.join(f.development,'plain')); writeFileSync(path.join(dirty,'tracked.txt'),'changed');
    writeFileSync(path.join(ignored,'ignored.txt'),'important evidence');
    writeFileSync(path.join(ahead,'new.txt'),'ahead');git(ahead,'add','new.txt');git(ahead,'commit','-m','ahead');
    const [a,b,c,d,e,p]=await Promise.all(['clean','dirty','ignored','ahead','p1-supplement-steer','plain'].map(name=>inspect(f,name,'worktree')));
    assert.equal(a.firstEligible,true,JSON.stringify(a));assert.equal(b.firstEligible,false);assert.equal(d.firstEligible,false);
    assert.equal(e.firstEligible,false);assert.equal(p.firstEligible,false);assert.deepEqual(c.ignored,['ignored.txt']);
    assert.equal((await f.engine.remove(a,{mode:'first',revalidate:async()=>true})).removed,false);
    const evidence=path.join(f.base,'evidence.txt');writeFileSync(evidence,readFileSync(path.join(ignored,'ignored.txt')));
    const sha=createHash('sha256').update(readFileSync(evidence)).digest('hex');
    const review=item=>({[item.id]:{confirmedUnused:true,evidencePreserved:true,activityVersion:item.activityVersion,copies:{'ignored.txt':{path:evidence,sha256:sha}}}});
    const removed=await f.engine.remove(c,{mode:'first',revalidate:async()=>true,worktreeReview:review(c)});
    assert.equal(removed.removed,true,JSON.stringify(removed));assert.equal(existsSync(ignored),false);
    assert.ok(git(f.repo,'branch','--list','branch-ignored').includes('branch-ignored'));
    const cleanReview={[a.id]:{confirmedUnused:true,evidencePreserved:true,activityVersion:a.activityVersion,copies:{}}};
    const becameBusy=await f.engine.remove(a,{mode:'first',revalidate:async()=>true,worktreeReview:cleanReview,
      readWorktreeReview:async()=>({[a.id]:{...cleanReview[a.id],confirmedUnused:false}})});
    assert.equal(becameBusy.reason,'active-project-or-evidence-review-required');
    const store=new RosterStore(path.join(f.state,'roster.sqlite'));
    try {
      store.insert({ownerId:'test-owner',agentId:'active-agent',name:'active',state:'running',workspace:clean});
      const inUse=await f.engine.remove(a,{mode:'first',revalidate:async()=>true,worktreeReview:cleanReview});
      assert.equal(inUse.reason,'currently-used-by-project-or-agent');
    }finally{store.close();}
    writeFileSync(path.join(clean,'tracked.txt'),'new work');
    assert.equal((await f.engine.remove(a,{mode:'first',revalidate:async()=>true,worktreeReview:cleanReview})).removed,false);
    assert.equal(existsSync(clean),true);
  } finally {f.close();}
});
