import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from './config.mjs';
import { createCleanupService, defaultAdapters } from './cleanup-service.mjs';
import { RosterStore } from './roster-store.mjs';
import { ensureSharedMonitor } from './shared-monitor.mjs';
import { offlineVacuum } from './cleanup-vacuum.mjs';
import { readManifest,writeManifest } from './cleanup-manifest.mjs';

const read = async file => JSON.parse(await readFile(path.resolve(file),'utf8'));
export async function cleanupCommand(action,values) {
  const config=await loadConfig(values.config,values.profile);
  const service=createCleanupService(config,await defaultAdapters(config));
  const live=async item=> {
    const c=await loadConfig(config.configFile,config.profile??undefined);
    return c.agentAutoCleanup===true && !c.cleanupConfigurationError && c.stateDirectory===config.stateDirectory && c.dshDataRoot===config.dshDataRoot;
  };
  switch (action) {
    case 'preview': {
      if (!values.output) throw new Error('cleanup preview requires --output FILE');
      const result=await service.preview(values.scopes?.split(','));
      await writeManifest(path.resolve(values.output),result);
      return {output:values.output,hash:result.hash,coverage:result.coverage,summary:result.summary};
    }
    case 'approve': return service.approve(await readManifest(path.resolve(values.manifest)),await read(values.decisions));
    case 'status': return service.status();
    case 'enable': {
      const enabled=await service.switchEnabled(true);
      const store=new RosterStore(path.join(config.stateDirectory,'roster.sqlite'));
      try {
        store.claimLease('cleanup:reload','settings',60000);
        if(!await ensureSharedMonitor(config,store)) throw new Error('The cleanup monitor did not start.');
      } catch(e) { await service.switchEnabled(false);throw e; }
      finally { store.close(); }
      return enabled;
    }
    case 'disable': return service.switchEnabled(false);
    case 'apply': {
      const result=await service.execute('first',{snapshot:await readManifest(path.resolve(values.manifest)),review:values.approval,
        readWorktreeReview:()=>values['worktree-review']?read(values['worktree-review']):{},authorized:live});
      if(values.output)await writeFile(path.resolve(values.output),JSON.stringify(result),{flag:'wx',mode:0o600});
      return values.output?{output:values.output,count:result.items.length}:result;
    }
    case 'restore': return service.restore(values.ticket);
    case 'revoke': return service.revoke([values.key]);
    case 'archive': {
      const entries=await service.archives({name:values.name,from:values.from,to:values.to,agentId:values['agent-id'],originalId:values['original-id'],ownerId:values.owner});
      if(values.output) {
        await writeFile(path.resolve(values.output),JSON.stringify(entries,null,2),{flag:'wx',mode:0o600});
        return {output:values.output,count:entries.length};
      }
      return entries;
    }
    case 'vacuum': return offlineVacuum(config,await read(values.decisions),values.approval,values.output);
    default: throw new Error('cleanup actions: preview, approve, enable, disable, apply, revoke, archive, status, vacuum');
  }
}

// Keep heavy disk and host reads outside the normal monitor round. The ledger is
// checked again by the service before every action, including after a slow scan.
export function cleanupMonitor(config,ownsLease) {
  let next=0,pending=null,enabled=config.agentAutoCleanup===true,lastError='',lastCheck=0,moreDiagnostics=false;
  async function live(item) {
    const c=await loadConfig(config.configFile,config.profile??undefined);
    return c.agentAutoCleanup===true && !c.cleanupConfigurationError
      && (c.codexAutoCleanup!==false || !(item?.target==='codex-desktop' || item?.records?.some(r=>r.target==='codex-desktop')))
      && c.dshDataRoot===config.dshDataRoot && c.stateDirectory===config.stateDirectory && ownsLease();
  }
  async function check() {
    const current=await loadConfig(config.configFile,config.profile??undefined);
    const sameIdentity=current.stateDirectory===config.stateDirectory && current.dshDataRoot===config.dshDataRoot;
    enabled=sameIdentity && current.agentAutoCleanup===true && !current.cleanupConfigurationError;
    const bound=sameIdentity?current:config;
    const service=createCleanupService(bound,await defaultAdapters(bound));
    if(!enabled) await service.switchEnabled(false);
    const states=await service.monitorState();
    enabled=enabled && Object.values(states).some(value=>value===true);
    if(!enabled || (next>Date.now() && !moreDiagnostics)) return;
    const diagnosticsOnly=next>Date.now();
    if(!diagnosticsOnly)next=Date.now()+current.agentCleanupIntervalMs;
    const batch=await service.execute('rules',{authorized:live,diagnosticsOnly});
    moreDiagnostics=batch.moreDiagnostics===true;
    lastError='';
  }
  return {
    tick() {
      if(!pending && Date.now()-lastCheck>=1000) {
        lastCheck=Date.now();
        pending=check().catch(e=>{
          enabled=false;moreDiagnostics=false;
          if(e.message!==lastError)process.stderr.write('[cleanup] '+e.message+'\n');
          lastError=e.message;
        }).finally(()=>{pending=null;});
      }
      return enabled;
    },
    async drain(){await pending;},
  };
}
