import {open, rename, readdir, writeFile, stat} from 'node:fs/promises';
import path from 'node:path';
const base=path.resolve(process.argv[2]);
const root=path.join(base,'home','sessions');
const names=await readdir(root); const parent=path.join(root,names[0]); const original=path.join(parent,(await readdir(parent))[0]);
const files=await readdir(original); const file=path.join(original,files[0]);
const relocated=original+'.probe'; const result={original, file, before:await stat(file).then(s=>s.size)};
const handle=await open(file,'a');
try { try { await rename(original,relocated); result.rename='succeeded'; } catch(e) {result.rename=e.code;} if(result.rename==='succeeded') {try {await handle.write(''); result.handleWrite='succeeded';}catch(e){result.handleWrite=e.code;} await handle.close(); await rename(relocated,original); result.restored=true;} else await handle.close(); }
finally {await handle.close().catch(()=>{});}
await writeFile(path.join(path.dirname(base),'handle-probe.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
