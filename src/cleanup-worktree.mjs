import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';

const portable=text=>text.replaceAll('\\','/').toLowerCase();
function below(root,file) {
  const rel=path.relative(root,file);
  return !!rel && !rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel);
}
export async function worktreeReferences(docs,name) {
  const references=[];
  async function visit(dir) {
    let entries;
    try {entries=await readdir(dir,{withFileTypes:true});} catch(e) {if(e.code==='ENOENT')return;throw e;}
    for(const entry of entries) {
      const filename=path.join(dir,entry.name);
      if(entry.isDirectory()) await visit(filename);
      else if(entry.isFile() && entry.name.endsWith('.md')) {
        const lines=(await readFile(filename,'utf8')).split(/\r?\n/);
        for(let index=0;index<lines.length;index++) {
          if(portable(lines[index]).includes(portable(name))) references.push({file:path.relative(docs,filename),line:index+1,text:lines[index].trim().slice(0,1500)});
        }
      }
    }
  }
  await visit(docs);
  return references;
}
export async function activeTaskUse(runtime,tree,references) {
  const canonical=portable(path.resolve(tree));
  if(references.some(ref=>portable(ref.file).startsWith('doing/') && /(?:开发树|工作树|worktree|workdir).{0,60}(?:development[/\\]|位于|使用)/iu.test(ref.text)))return true;
  const root=path.join(runtime,'state');
  const locations=[root];
  try {
    for(const p of await readdir(path.join(root,'profiles'),{withFileTypes:true})) {
      if(p.isSymbolicLink())throw new Error('unverified-profile-directory');
      if(p.isDirectory())locations.push(path.join(root,'profiles',p.name));
    }
  }catch(e){if(e.code!=='ENOENT')throw e;}
  function usesTree(value) {
    if(typeof value==='string') {
      const text=portable(value);return text===canonical || text.startsWith(canonical+'/');
    }
    return value && typeof value==='object' && Object.values(value).some(usesTree);
  }
  for(const location of locations) {
    const filename=path.join(location,'roster.sqlite');
    try{await lstat(filename);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    const db=new DatabaseSync(filename,{readOnly:true});
    try {
      for(const row of db.prepare('SELECT body FROM agents').iterate()) {
        if(usesTree(JSON.parse(row.body)))return true;
      }
    }finally{db.close();}
  }
  return false;
}
async function sha(file) {
  const h=createHash('sha256');
  for await(const chunk of createReadStream(file))h.update(chunk);
  return h.digest('hex');
}
// The maintenance review is refreshed from its on-disk file immediately before Git acts.
export async function verifyWorktreeReview(item,ctx) {
  const reviews=ctx.readWorktreeReview?await ctx.readWorktreeReview():ctx.worktreeReview;
  const review=reviews?.[item.id];
  if(ctx.mode!=='first' || !review?.confirmedUnused || !review.evidencePreserved || review.activityVersion!==item.activityVersion)
    return 'active-project-or-evidence-review-required';
  if(item.references.some(ref=>portable(ref.text).includes(portable(item.name)+'/') && /(?:verification|evidence)[/\\]/i.test(ref.text)))
    return 'update-document-evidence-reference-first';
  for(const file of item.ignored) {
    const original=path.resolve(item.path,file);
    const copy=review.copies?.[file];
    if(!below(item.path,original) || !copy?.path || !path.isAbsolute(copy.path) || !/^[a-f0-9]{64}$/.test(copy.sha256)) return 'ignored-file-needs-verified-copy';
    const dest=await realpath(copy.path);
    if(below(item.root,dest) || !(await lstat(original)).isFile() || !(await lstat(dest)).isFile()
      || await sha(original)!==copy.sha256 || await sha(dest)!==copy.sha256) return 'evidence-copy-mismatch';
  }
  return null;
}
