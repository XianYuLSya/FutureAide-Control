import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function submitFeedback(input, context, {configFile, deadline = Date.now() + 2000} = {}) {
  const end = Math.min(deadline, Date.now() + 2000);
  if (!path.isAbsolute(configFile || '') || !Number.isFinite(end) || end <= Date.now()) return {saved:false,code:'feedback-unavailable'};
  let payload; try { payload=JSON.stringify({input,context}); } catch { return {saved:false,code:'feedback-unavailable'}; }
  return new Promise(resolve => {
    let child, handed = false, done = false, output = '';
    const finish = result => { if (done) return; done=true; clearTimeout(timer); if (child && !child.killed) child.kill(); resolve(result); };
    const unknown = () => ({saved:null,code:'feedback-outcome-unknown'});
    const timer=setTimeout(() => finish(handed ? unknown() : {saved:false,code:'feedback-unavailable'}), Math.max(0,end-Date.now()));
    try {
      child=spawn(process.execPath,[fileURLToPath(new URL('./feedback-inbox.mjs',import.meta.url)),'--write','--config',configFile],{stdio:['pipe','pipe','ignore'],windowsHide:true});
      child.on('error', () => finish(handed ? unknown() : {saved:false,code:'feedback-unavailable'}));
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {output+=chunk; if(output.length>10000) finish(unknown());});
      child.on('close', () => { try { const r=JSON.parse(output); if (![true,false].includes(r.saved)) throw Error(); finish(r); } catch { finish(handed ? unknown() : {saved:false,code:'feedback-unavailable'}); } });
      child.stdin.on('error', () => finish(handed ? unknown() : {saved:false,code:'feedback-unavailable'}));
      handed=true; child.stdin.end(payload);
    } catch { finish(handed ? unknown() : {saved:false,code:'feedback-unavailable'}); }
  });
}
