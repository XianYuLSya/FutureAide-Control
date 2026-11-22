import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {lstat,readdir,realpath,rmdir} from 'node:fs/promises';

const pattern=/^dsh-(spill|subprocess)-[A-Za-z0-9]{6}$/;
const equal=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
export function createTempCleanup(config = {}, {dsh} = {}) {
  const root=path.resolve(config.tempDirectory ?? os.tmpdir());
  async function inspect(candidate) {
    try {
      const target=path.resolve(candidate),name=path.basename(target),match=pattern.exec(name);
      if (!match || !equal(path.dirname(target),root) || !equal(await realpath(root),root)) return {owned:false,inUse:null,reason:'outside-temporary-root-or-invalid-name'};
      if (!equal(await realpath(target),target)) return {owned:false,inUse:null,reason:'redirected-directory'};
      const hash=createHash('sha256');let bytes=0;
      async function visit(file) {
        const s=await lstat(file,{bigint:true});
        if (s.isSymbolicLink() || !s.ino || (!s.isDirectory() && !s.isFile()) || (s.isFile() && s.nlink>1n)) throw new Error('linked-or-unverified-entry');
        hash.update(JSON.stringify([path.relative(target,file),String(s.dev),String(s.ino),String(s.size),String(s.mtimeNs),String(s.birthtimeNs)]));
        if(s.isFile())bytes+=Number(s.size);
        else for(const entry of (await readdir(file)).sort())await visit(path.join(file,entry));
      }
      await visit(target);
      const usage=await dsh?.tempUsage?.(target);
      const owned=usage?.owned===true,inUse=usage?.inUse===false?false:usage?.inUse===true?true:null;
      const empty=(await readdir(target)).length===0;
      return {path:target,kind:match[1],owned,inUse:empty?inUse:(inUse===true?true:null),bytes,empty,activityVersion:hash.digest('hex'),
        reason:usage?.reason ?? (!owned?'temporary-ownership-unverified':inUse===null?'temporary-references-unverified':inUse?'temporary-in-use':'temporary-proven-unused')};
    } catch(error) {return {owned:false,inUse:null,reason:error.code ?? error.message ?? 'temporary-inspection-failed'};}
  }
  async function remove(fresh,ctx={}) {
    const current=await inspect(fresh?.path ?? '');
    if(!current.owned||current.inUse!==false||current.activityVersion!==fresh?.activityVersion) return {removed:false,reason:current.reason ?? 'temporary-changed'};
    if(typeof ctx.revalidate!=='function' || await ctx.revalidate()!==true) return {removed:false,reason:'authorization-changed'};
    const last=await inspect(current.path);
    if(!last.owned||last.inUse!==false||last.activityVersion!==current.activityVersion) return {removed:false,reason:'temporary-changed-or-in-use'};
    // rmdir is non-recursive: any newly written entry makes the operation fail safely.
    if(!last.empty)return {removed:false,reason:'temporary-not-empty'};
    try {await rmdir(last.path);} catch(error) {return {removed:false,reason:error.code??'temporary-rmdir-failed'};}
    return {removed:true,bytes:0};
  }
  return {inspect,remove};
}
