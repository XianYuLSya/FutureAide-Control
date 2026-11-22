import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, opendir, open, realpath, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { digest } from './cleanup-authority.mjs';
import { activeTaskUse, verifyWorktreeReview, worktreeReferences } from './cleanup-worktree.mjs';
import { createTempCleanup } from './cleanup-temp.mjs';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const same = (a,b) => path.relative(a,b) === '';
const logPattern = /^mcp-([1-9]\d*)-(\d{13})\.jsonl$/;
const tempPattern = /^dsh-(spill|subprocess)-[a-zA-Z0-9]{6}$/;
// Per-worker cursor. A restart safely revisits the first page. A full inventory never uses it.
const cursors=new Map();
async function nextDiagnosticPage(root) {
  let scan=cursors.get(root);
  if(!scan) {
    scan=await children(root);
    if(!scan.read)return [];
    cursors.set(root,scan);
  }
  const page=[];
  for(let index=0;index<128;index++) {
    const entry=await scan.read();
    if(!entry){await scan.close();cursors.delete(root);break;}
    page.push(entry);
  }
  return page;
}

async function children(directory) {
  try { return await opendir(directory); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

async function metadata(filename) {
  const s = await lstat(filename, { bigint: true });
  if (s.isSymbolicLink() || !s.ino || !(s.isDirectory() || s.isFile())) throw new Error('unverified file identity');
  return { identity: [s.dev.toString(), s.ino.toString(), s.birthtimeNs.toString()].join('/'), directory: s.isDirectory(),
    bytes: Number(s.size), modified: Number(s.mtimeMs), stamp: s.mtimeNs.toString() };
}

async function plainRoot(root) {
  if (!same(await realpath(root),path.resolve(root))) throw new Error('redirected directory: ' + root);
}

async function walk(root) {
  const hash = createHash('sha256');
  let bytes = 0, links = 0;
  async function visit(dir) {
    const entries = [];
    for await (const entry of await children(dir)) entries.push(entry);
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      const target = path.join(dir,entry.name);
      const s = await lstat(target,{bigint:true});
      hash.update(JSON.stringify([path.relative(root,target),String(s.dev),String(s.ino),String(s.size),String(s.mtimeNs)]));
      if (s.isSymbolicLink()) links++;
      else if (s.isDirectory()) await visit(target);
      else if (s.isFile()) bytes += Number(s.size);
    }
  }
  await visit(root);
  return { bytes, links, snapshot: hash.digest('hex') };
}

async function git(cwd, ...args) {
  return (await exec('git',['--no-optional-locks','-C',cwd,...args], { windowsHide:true, encoding:'utf8',maxBuffer:32*1024*1024 })).stdout;
}

function processGone(pid) {
  try { process.kill(pid,0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

export function createFileCleanup(config, { dsh, now = Date.now } = {}) {
  const runtime = path.dirname(config.configFile);
  const diagnostic = path.join(runtime,'diagnostics'), temporary = os.tmpdir(), development = path.join(runtime,'development');
  const tempCleanup=createTempCleanup({...config,tempDirectory:temporary},{dsh});
  const repo = path.join(runtime,'publish','20261030','FutureAide-Control');
  async function itemAt(root,name,type,rootChecked=false,writerState) {
    if(!rootChecked) await plainRoot(root);
    if (name !== path.basename(name) || name === '.' || name === '..') throw new Error('Invalid file name');
    const filename = path.join(root,name), meta = await metadata(filename);
    const item = {id:meta.identity,kind:type,root,path:filename,name,bytes:meta.bytes,running:null,treeIds:[],
      lastActivityAt:meta.modified,activityVersion:digest([meta.identity,meta.bytes,meta.stamp]),eligible:false,firstEligible:false};
    if (type === 'diagnostic') {
      const match = logPattern.exec(name);
      if (meta.directory || !match) throw new Error('Unrecognized diagnostic file');
      const pid=Number(match[1]);
      if(writerState && !writerState.has(pid))writerState.set(pid,!processGone(pid));
      item.running=writerState?writerState.get(pid):!processGone(pid);
      item.firstEligible = !item.running;
      item.eligible = item.firstEligible && now()-meta.modified >= config.diagnosticRetentionMs;
      item.reason = item.running ? 'writer-present-or-pid-reused' : item.eligible ? 'expired-diagnostic' : 'retained-diagnostic';
    } else if (type === 'empty-owner') {
      if (!meta.directory || !/^owner-[a-f0-9]{32}$/.test(name)) throw new Error('Unknown scoped owner directory');
      for await (const _ of await children(filename)) { item.reason = 'not-empty'; return item; }
      item.bytes=0;item.maintenanceOnly=true;
      let db;
      try {
        db=new DatabaseSync(path.join(config.stateDirectory,'roster.sqlite'),{readOnly:true});
        item.running=!!db.prepare('SELECT 1 FROM agents WHERE owner=? LIMIT 1').get(name);
        item.firstEligible=!item.running;
        item.reason=item.running?'owner-has-registered-agents':'empty-directory';
      } catch {item.reason='owner-roster-unverified';} finally {db?.close();}
    } else if (type === 'worktree') {
      if (!meta.directory) throw new Error('Not a development directory');
      const info = await walk(filename);
      Object.assign(item,{bytes:info.bytes,activityVersion:digest([meta.identity,info.snapshot]),maintenanceOnly:true});
      const protectedTree = same(filename,path.resolve(source)) || ['p1-supplement-steer','interrupt-queue-20261122','agent-auto-cleanup-20261122'].includes(name);
      try {
        await plainRoot(filename);
        if (!same((await git(filename,'rev-parse','--show-toplevel')).trim(),filename)) throw new Error('ordinary-directory');
        const branch = (await git(filename,'symbolic-ref','--short','HEAD')).trim();
        const head = (await git(filename,'rev-parse','HEAD')).trim();
        const changes = (await git(filename,'-c','core.quotepath=false','status','--porcelain=v1','--untracked-files=all')).trimEnd().split(/\r?\n/).filter(Boolean);
        const commits = (await git(filename,'log','--oneline','main..HEAD')).trim().split(/\r?\n/).filter(Boolean);
        const ignored = (await git(filename,'ls-files','-z','--others','--ignored','--exclude-standard')).split('\0').filter(Boolean);
        item.references=await worktreeReferences(path.join(path.dirname(runtime),'docs'),name);
        const registered = (await git(repo,'worktree','list','--porcelain')).split(/\r?\n/).some(line=>line.startsWith('worktree ') && same(line.slice(9),filename));
        Object.assign(item,{branch,head,changes,commits,ignored});
        item.activityVersion=digest([item.activityVersion,branch,head,changes,commits,ignored]);
        item.running=false;
        item.firstEligible=registered && !protectedTree && !changes.length && !commits.length && !info.links;
        item.reason=protectedTree?'active-project':changes.length?'uncommitted-retain-for-user':commits.length?'not-merged':!registered?'not-registered':info.links?'contains-links':'requires-current-project-and-evidence-review';
      } catch(e) { item.reason='ordinary-or-unreadable-directory'; item.detail=e.message; }
    } else {
      if (!meta.directory || !tempPattern.test(name)) throw new Error('Unrecognized temporary root');
      const usage=await tempCleanup.inspect(filename);
      item.bytes=usage.bytes??null;
      item.activityVersion=usage.activityVersion??item.activityVersion;
      item.running=usage?.inUse ?? null;
      item.reason=usage?.reason ?? 'temporary-ownership-and-references-unverified';
      item.firstEligible=!!usage.activityVersion && usage.owned === true && usage.inUse === false;
      item.eligible=item.firstEligible;
    }
    return item;
  }
  async function inventory({ maintenance = true,diagnosticsOnly=false } = {}) {
    const items=[], errors=[];
    const locations=[[diagnostic,'diagnostic',n=>logPattern.test(n)],[temporary,'temporary',n=>tempPattern.test(n)],
      [path.join(config.stateDirectory,'scoped'),'empty-owner',n=>/^owner-[a-f0-9]{32}$/.test(n)]];
    if (maintenance) locations.push([development,'worktree',()=>true]);
    let moreDiagnostics=false;
    for (const [root,type,accept] of locations) {
      if(diagnosticsOnly && type!=='diagnostic')continue;
      try {
        const entries=!maintenance && type==='diagnostic'?await nextDiagnosticPage(root):await children(root);
        if(!maintenance && type==='diagnostic')moreDiagnostics=entries.length===128;
        if(Array.isArray(entries) && entries.length===0) continue;
        await plainRoot(root);
        const writers=new Map(),pending=[];
        async function readEntry(entry) {
          try {
            const item=await itemAt(root,entry.name,type,true,writers);
            if(item.reason!=='not-empty')items.push(item);
          }catch(e){if(e.code!=='ENOENT')errors.push(entry.name+': '+e.message);}
        }
        for await(const entry of entries) {
          if(!accept(entry.name))continue;
          if(type!=='diagnostic'){await readEntry(entry);continue;}
          pending.push(readEntry(entry));
          if(pending.length===32){await Promise.all(pending);pending.length=0;}
        }
        await Promise.all(pending);
      } catch(e) { errors.push(root+': '+e.message); }
    }
    return {items,complete:!errors.length,moreDiagnostics,reason:errors.slice(0,10).join('; ')};
  }
  function inspect(item) {
    const roots={diagnostic,temporary,worktree:development,'empty-owner':path.join(config.stateDirectory,'scoped')};
    if (!roots[item.kind] || !same(item.root,roots[item.kind])) throw new Error('Unrecognized cleanup location');
    return itemAt(roots[item.kind],item.name,item.kind);
  }
  async function remove(item,ctx) {
    const fresh=await inspect(item);
    if (fresh.id!==item.id || fresh.activityVersion!==item.activityVersion || !fresh.firstEligible) return {removed:false,reason:'file-changed-or-in-use'};
    if (!await ctx.revalidate()) return {removed:false,reason:'authorization-changed'};
    if (item.kind==='diagnostic') {
      const handle=await open(fresh.path,'r');
      try {
        const first=Buffer.alloc(1024);
        const {bytesRead}=await handle.read(first,0,first.length,0);
        const row=JSON.parse(first.subarray(0,bytesRead).toString('utf8').split('\n')[0]);
        if(row.pid!==Number(logPattern.exec(item.name)[1]) || row.event!=='start') return {removed:false,reason:'unrecognized-log-producer'};
        if((await metadata(fresh.path)).identity!==fresh.id) return {removed:false,reason:'file-replaced'};
        await unlink(fresh.path);
      } finally { await handle.close(); }
    } else if (item.kind==='worktree') {
      const reason=await verifyWorktreeReview(fresh,ctx);
      if(reason) return {removed:false,reason};
      if(await activeTaskUse(runtime,fresh.path,fresh.references)) return {removed:false,reason:'currently-used-by-project-or-agent'};
      if(!await ctx.revalidate())return {removed:false,reason:'authorization-changed'};
      await git(repo,'worktree','remove','--',fresh.path);
    } else if (item.kind==='temporary') {
      // The host can release only the exact files it has proved unused, including at commit time.
      return tempCleanup.remove(fresh,ctx);
    } else if(item.kind==='empty-owner') {
      if(ctx.mode!=='first')return {removed:false,reason:'maintenance-only'};
      const db=new DatabaseSync(path.join(config.stateDirectory,'roster.sqlite'));
      try {
        db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
        const s=lstatSync(fresh.path,{bigint:true});
        if(!s.isDirectory() || s.isSymbolicLink() || !same(realpathSync.native(fresh.path),fresh.path)
          || [s.dev,s.ino,s.birthtimeNs].join('/')!==fresh.id || readdirSync(fresh.path).length
          || db.prepare('SELECT 1 FROM agents WHERE owner=? LIMIT 1').get(item.name))return {removed:false,reason:'owner-no-longer-empty'};
        rmdirSync(fresh.path);
        db.exec('COMMIT');
      }finally{db.close();}
    }else return {removed:false,reason:'unrecognized-file-kind'};
    return {removed:true,bytes:fresh.bytes};
  }
  return { inventory, inspect, remove };
}
