import { realpath,stat } from 'node:fs/promises';
import path from 'node:path';

// Capture an identity from the native RPC's own rollout path, not this process's
// CODEX_HOME. The physical directory identity prevents a replaced home from matching.
export async function codexDomainForThread(thread) {
  if (typeof thread?.id !== 'string' || typeof thread?.path !== 'string' || !path.isAbsolute(thread.path)) return undefined;
  const file = path.resolve(thread.path);
  if (!path.basename(file).toLowerCase().includes(thread.id.toLowerCase())) return undefined;
  let dir = path.dirname(file), home;
  for (;;) {
    if (['sessions','archived_sessions'].includes(path.basename(dir).toLowerCase())) { home=path.dirname(dir); break; }
    const parent=path.dirname(dir); if(parent===dir) return undefined; dir=parent;
  }
  try {
    const [physicalHome,physicalFile] = await Promise.all([realpath(home),realpath(file)]);
    const relative = path.relative(physicalHome,physicalFile);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    const details = await stat(physicalHome);
    if (!details.isDirectory() || !details.ino) return undefined;
    return {version:1,home:physicalHome,dev:String(details.dev),ino:String(details.ino)};
  } catch { return undefined; }
}
export function sameCodexDomain(a,b) {
  return a?.version===1 && b?.version===1 && typeof a.home==='string' && typeof b.home==='string'
    && path.resolve(a.home).toLowerCase()===path.resolve(b.home).toLowerCase()
    && a.dev===b.dev && a.ino===b.ino;
}
