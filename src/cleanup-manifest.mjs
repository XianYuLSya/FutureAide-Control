import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {open,readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';

export function snapshotDigest(snapshot) {
  const {items,hash:ignored,...meta}=snapshot;
  if(!Array.isArray(items))throw new Error('Invalid snapshot items.');
  const hash=createHash('sha256').update(JSON.stringify(meta)).update('\n');
  // Hash rows separately so an inventory with hundreds of thousands of logs never needs a single huge string.
  for(const row of items) hash.update(JSON.stringify(row)).update('\n');
  return hash.digest('hex');
}
export async function writeManifest(filename,snapshot) {
  const {items,...meta}=snapshot;
  const handle=await open(filename,'wx',0o600);
  try {
    await handle.writeFile(JSON.stringify(meta).slice(0,-1)+',"items":[\n');
    let buffer='';
    for(const [index,row] of items.entries()) {
      buffer+=JSON.stringify(row)+(index===items.length-1?'\n':',\n');
      if(buffer.length>=131072){await handle.writeFile(buffer);buffer='';}
    }
    await handle.writeFile(buffer+']}\n');await handle.sync();
  }finally{await handle.close();}
}
export async function readManifest(filename) {
  const input=createReadStream(filename,{encoding:'utf8'}),lines=createInterface({input,crlfDelay:Infinity});
  try {
    let snapshot,ended=false;
    for await(const line of lines) {
      if(!snapshot) {
        if(!line.endsWith(',"items":['))return JSON.parse(await readFile(filename,'utf8'));
        snapshot={...JSON.parse(line.slice(0,-',"items":['.length)+'}'),items:[]};
      }else if(line===']}'){ended=true;}
      else if(line.trim()) {
        if(ended)throw new Error('Unexpected trailing snapshot data.');
        snapshot.items.push(JSON.parse(line.endsWith(',')?line.slice(0,-1):line));
      }
    }
    if(!ended)throw new Error('Incomplete snapshot file.');
    return snapshot;
  }finally{lines.close();input.destroy();}
}
