import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  requestCodexNative, readCodexThreadNative, ensureCodexThreadNative, listCodexTurnsNative,
  sendCodexTextNative,
} from './codex-ipc.mjs';

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.toNamespacedPath(path.resolve(a)).toLowerCase() === path.toNamespacedPath(path.resolve(b)).toLowerCase();
export const CODEX_FILE_COVERAGE = { source: 'codex-native-file-change', complete: false,
  note: 'Native file-change items are attributed; arbitrary shell writes are not inferred.' };
export const markerLine = (requestId, nonce) => `[FutureAide dispatch ${JSON.stringify([requestId, nonce])}]`;

// thread/list defaults to interactive sources. Native descendants are subAgent
// kinds, so a child listing must name every kind explicitly or the tree silently
// loses nodes.
const ALL_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const TURN_PAGE_LIMIT = 20;

export function emptyProjection() {
  return { offset: 0, seq: 0, running: false, messages: [], changes: [], deliveries: {}, turns: {},
    seen: {}, changeSeen: {}, messageIds: {}, children: [] };
}

function itemText(item) {
  if (typeof item.text === 'string') return item.text;
  if (Array.isArray(item.content)) return item.content
    .filter(part => typeof part?.text === 'string').map(part => part.text).join('\n');
  return '';
}

/**
 * Project app-server Turn[] (schema v2) onto the shape the shared state machine
 * already consumes. The projection is incremental: item ids are stable, so a
 * repeated page updates text and never duplicates messages or file changes.
 */
export function projectCodexTurns(previous, turns, requests = {}) {
  const p = structuredClone(previous ?? emptyProjection());
  p.seen ??= {}; p.changeSeen ??= {}; p.messageIds ??= {};
  for (const [index, message] of p.messages.entries()) if (message?.id && p.messageIds[message.id] === undefined) p.messageIds[message.id] = index;
  let seq = p.seq ?? 0;
  const running = [];
  const ordered = [...(turns ?? [])].sort((a, b) => (a?.startedAt ?? 0) - (b?.startedAt ?? 0));
  for (const turn of ordered) {
    if (typeof turn?.id !== 'string') continue;
    const state = turn.status === 'inProgress' ? 'running' : 'ended';
    p.turns[turn.id] = { ...(p.turns[turn.id] ?? {}), state };
    if (state === 'running') {
      p.turns[turn.id].startSeq ??= seq;
      running.push(turn.id);
    } else {
      p.turns[turn.id].endSeq = seq;
      p.turns[turn.id].completionReason = turn.status === 'interrupted' ? 'cancelled'
        : turn.status === 'failed' ? 'failed' : 'completed';
    }
    for (const item of turn.items ?? []) {
      if (typeof item?.id !== 'string') continue;
      const kind = String(item.type).toLowerCase();
      if (kind === 'usermessage' || kind === 'agentmessage') {
        const role = kind === 'usermessage' ? 'user' : 'assistant';
        const text = itemText(item);
        const index = p.messageIds[item.id];
        if (index !== undefined) p.messages[index] = { ...p.messages[index], text };
        else {
          seq++;
          p.messageIds[item.id] = p.messages.length;
          p.messages.push({ id: item.id, role, text, seq, turnId: turn.id });
          if (p.messages.length > 1000) {
            const dropped = p.messages.shift();
            if (dropped?.id) delete p.messageIds[dropped.id];
            p.messagesOmitted = (p.messagesOmitted ?? 0) + 1;
            p.messageIds = {};
            for (const [position, message] of p.messages.entries()) if (message?.id) p.messageIds[message.id] = position;
          }
        }
        if (role === 'user') for (const [id, request] of Object.entries(requests)) {
          if (typeof request?.marker === 'string' && text.includes(request.marker) && !p.deliveries[id]) {
            p.deliveries[id] = { seq, turnId: turn.id };
          }
        }
      } else if (kind === 'filechange' && item.status === 'completed' && !p.changeSeen[item.id]) {
        p.changeSeen[item.id] = true;
        seq++;
        const changes = Array.isArray(item.changes)
          ? item.changes
          : Object.entries(item.changes ?? {}).map(([changePath, change]) => ({ path: changePath, ...change }));
        for (const change of changes) if (typeof change?.path === 'string') {
          p.changes.push({ path: change.path, kind: change.kind?.type ?? change.kind ?? change.type ?? 'modify',
            seq, source: 'codex-native-file-change' });
        }
      }
    }
  }
  p.running = running.length > 0;
  p.seq = seq;
  return p;
}

function currentModelFromThread(thread) {
  if (!thread?.model) return undefined;
  return { provider: thread.modelProvider ?? 'openai', model: thread.model,
    ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}) };
}

// Python's standard TOML parser handles quoted profile keys and TOML escaping.
// Only the effective model fields leave this subprocess; credentials never do.
// Current profile format and layer order:
// https://learn.chatgpt.com/docs/config-file/config-advanced#profiles
const CONFIG_SCRIPT = String.raw`import json,sys,pathlib,tomllib,re
p=json.load(sys.stdin)
home=pathlib.Path(p['home']); cwd=pathlib.Path(p['workspace']).resolve()
def read(f):
 return tomllib.loads(f.read_text(encoding='utf-8-sig')) if f.is_file() else {}
c=read(home/'config.toml'); sources=[str(home/'config.toml')]
if c.get('profile'): raise ValueError('Legacy top-level profile selection is unsupported by current Codex')
matches=[]
for k,v in c.get('projects',{}).items():
 try:
  root=pathlib.Path(k).resolve()
  if cwd==root or root in cwd.parents: matches.append((len(root.parts),root,v.get('trust_level')))
 except (OSError,ValueError): pass
match=max(matches,key=lambda x:x[0]) if matches else None
trusted=match is not None and match[2]=='trusted'
markers=c.get('project_root_markers',['.git'])
project_root=next((d for d in [cwd,*cwd.parents] if any((d/m).exists() for m in markers)),match[1] if match else cwd)
profile=p.get('profile')
if profile:
 if re.fullmatch(r'[A-Za-z0-9_-]+',profile) is None: raise ValueError('Invalid Codex profile name')
 f=home/(profile+'.config.toml')
 if not f.is_file(): raise ValueError('Selected Codex profile does not exist')
 c={**c,**read(f)}; sources.append(str(f))
if trusted:
 dirs=[]
 for d in [cwd,*cwd.parents]:
  dirs.append(d)
  if d==project_root: break
 for d in reversed(dirs):
  f=d/'.codex'/'config.toml'
  if f.is_file() and f.resolve()!=(home/'config.toml').resolve():
   n=read(f)
   for key in ['model','model_reasoning_effort']:
    if key in n: c[key]=n[key]
   sources.append(str(f))
print(json.dumps({'model':c.get('model'),'provider':c.get('model_provider','openai'),'reasoningEffort':c.get('model_reasoning_effort'),'sources':sources,'profile':profile}))
`;

export async function readDefaultModel({ home, workspace, python, profile, readEffectiveConfig } = {}) {
  const bundledPython = path.join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  python ??= process.env.FUTUREAIDE_PYTHON ?? (process.platform === 'win32' && existsSync(bundledPython)
    ? bundledPython : process.platform === 'win32' ? 'py' : 'python3');
  const value = readEffectiveConfig ? await readEffectiveConfig({ workspace }) : await new Promise((resolve, reject) => {
    const child = execFile(python, [...(/^py(?:\.exe)?$/i.test(path.basename(python)) ? ['-3'] : []), '-X', 'utf8', '-c', CONFIG_SCRIPT], { windowsHide: true, timeout: 10000, maxBuffer: 65536 }, (error, stdout) => {
      if (error) return reject(fail('codex-default-model-unresolved', 'Could not parse the current Codex configuration.'));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ home, workspace, profile }));
  });
  if (!value?.model || typeof value.reasoningEffort !== 'string') throw fail('codex-default-model-unresolved',
    'Codex model and reasoning defaults must both be resolved; an effective-config reader is required when either is implicit.');
  return { ...value, verified: true, resolved: true };
}

const REGISTRATION_SCRIPT = String.raw`import json,sys,pathlib,tomllib
p=json.load(sys.stdin); cwd=pathlib.Path(p['workspace']).resolve(); home=pathlib.Path(p['home'])
def read(f):
 return tomllib.loads(f.read_text(encoding='utf-8-sig')) if f.is_file() else {}
c=read(home/'config.toml'); matches=[]
for k,v in c.get('projects',{}).items():
 r=pathlib.Path(k).resolve()
 if cwd==r or r in cwd.parents: matches.append((len(r.parts),r,v.get('trust_level')))
match=max(matches,key=lambda x:x[0]) if matches else None
root=next((d for d in [cwd,*cwd.parents] if any((d/m).exists() for m in c.get('project_root_markers',['.git']))),match[1] if match else cwd)
servers=c.get('mcp_servers',{}); sources={name:str(home/'config.toml') for name in servers}; dirs=[]
for d in [cwd,*cwd.parents]:
 dirs.append(d)
 if d==root: break
if match and match[2]=='trusted':
 for d in reversed(dirs):
  f=d/'.codex'/'config.toml'
  for name,entry in read(f).get('mcp_servers',{}).items():
   old=servers.get(name,{})
   servers[name]={**old,**entry,'env':{**old.get('env',{}),**entry.get('env',{})}}; sources[name]=str(f)
def same(a,b):
 return isinstance(a,str) and isinstance(b,str) and pathlib.Path(a).resolve()==pathlib.Path(b).resolve()
found=[]
for name,server in servers.items():
 if p.get('name') and name!=p['name']: continue
 env=server.get('env',{}); config=env.get('DSH_CONTROL_CONFIG') or env.get('FUTUREAIDE_CONTROL_CONFIG')
 args=server.get('args',[])
 if server.get('enabled') is False or not same(server.get('command'),p['command']) or len(args)!=1 or not same(args[0],p['serverPath']) or not same(config,p['configPath']): continue
 found.append({k:server.get(k) for k in ['command','args','cwd','enabled','enabled_tools','disabled_tools']}|{'source':sources[name],'configPath':config,'serverName':name})
print(json.dumps(found))
`;
const registrations = new Map();

/** Match the current build AND roster, not a development-only registration name. */
export async function readCodexMcpRegistration({ workspace, configPath, serverPath, serverName,
  home = process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), python } = {}) {
  const bundled = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
  python ??= process.env.FUTUREAIDE_PYTHON ?? (process.platform === 'win32' && existsSync(bundled) ? bundled : process.platform === 'win32' ? 'py' : 'python3');
  const matches = await new Promise((resolve, reject) => {
    const child = execFile(python, [...(/^py(?:\.exe)?$/i.test(path.basename(python)) ? ['-3'] : []), '-X', 'utf8', '-c', REGISTRATION_SCRIPT],
      { windowsHide: true, timeout: 10000, maxBuffer: 65536 }, (error, stdout) => {
        if (error) return reject(fail('codex-registration-unresolved', 'Could not resolve the effective MCP registration.'));
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
    child.stdin.end(JSON.stringify({ home, workspace, name: serverName, configPath, serverPath, command: process.execPath }));
  });
  if (matches.length !== 1) throw fail('codex-registration-mismatch', matches.length
    ? 'Multiple MCP entries use this build and roster; specify the registered server name.'
    : 'No enabled MCP entry uses this build and the same FutureAide state configuration.');
  return matches[0];
}

/** Configuration plus a real tools/list handshake. This does not start a model
 * or claim a new native session has already loaded the registration. */
export async function probeCodexReportRegistration({ workspace, configPath, serverName,
  home = process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), python } = {}) {
  const serverPath = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
  const files = [path.join(home, 'config.toml'), serverPath, configPath];
  for (let dir = path.resolve(workspace);;) {
    files.push(path.join(dir, '.codex', 'config.toml'));
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  const fingerprint = JSON.stringify([workspace, configPath, serverName,
    await Promise.all(files.map(async file => file ? [file, await stat(file).then(s => `${s.mtimeMs}:${s.size}`, () => null)] : null))]);
  const cached = registrations.get(fingerprint);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const entry = { expires: Infinity };
  entry.promise = (async () => {
    const registration = await readCodexMcpRegistration({ workspace, configPath, serverName, serverPath, home, python });
    const client = new Client({ name: 'futureaide-registration-check', version: '0.1.0' });
    try {
      await client.connect(new StdioClientTransport({ command: registration.command, args: registration.args,
        cwd: registration.cwd ?? workspace, env: { ...process.env, DSH_CONTROL_CONFIG: configPath, FUTUREAIDE_CONTROL_CONFIG: configPath }, stderr: 'ignore' }));
      const catalog = await client.listTools();
      const tools = catalog.tools.filter(tool => (!registration.enabled_tools || registration.enabled_tools.includes(tool.name))
        && !registration.disabled_tools?.includes(tool.name));
      if (!['ask_parent', 'report_parent'].every(name => tools.some(tool => tool.name === name
        && tool.inputSchema?.properties?.message?.type === 'string'))
        || tools.find(tool => tool.name === 'report_parent')?.inputSchema?.properties?.final?.type !== 'boolean') {
        throw fail('codex-report-tools-missing', 'The configured MCP server must expose the actual ask_parent and report_parent schemas.');
      }
      return { ready: true, registered: true, configured: true, sessionVerified: false,
        tools: tools.map(tool => tool.name), source: registration.source, serverName: registration.serverName };
    } finally { await client.close(); }
  })().catch(error => {
    entry.expires = Date.now() + 5000;
    return { ready: false, registered: false, sessionVerified: false,
      reason: { code: error.code ?? 'codex-registration-unavailable', message: error.message } };
  });
  registrations.clear(); registrations.set(fingerprint, entry);
  return entry.promise;
}

// Status checks reuse short-lived capability observations across adapter instances.
// This cache never supplies a model selection or admits a dispatch.
const capabilityProbes = new Map();

export function createCodexHost(options = {}) {
  const home = options.home ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  const nativeRequest = options.nativeRequest ?? requestCodexNative;
  const probes = options.nativeRequest ? new Map() : capabilityProbes;
  const observeCache = new Map();
  const childrenOf = async parentThreadId => {
    const data = [];
    let cursor;
    do {
      const page = await nativeRequest('thread/list', { parentThreadId, limit: 100,
        ...(cursor ? { cursor } : {}), archived: false, useStateDbOnly: true, sourceKinds: ALL_SOURCE_KINDS });
      if (!Array.isArray(page?.data)) throw fail('codex-native-rpc-invalid-response', 'Codex returned no child list.');
      data.push(...page.data);
      cursor = typeof page?.nextCursor === 'string' ? page.nextCursor : undefined;
    } while (cursor && data.length < 1000);
    return data;
  };
  async function probeCapabilities() {
    const workspace = options.workspace ?? process.cwd();
    const key = JSON.stringify([home, workspace]);
    const cached = probes.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const entry = { expires: Infinity };
    entry.promise = nativeRequest('thread/list', { limit: 1, useStateDbOnly: true }).then(result => {
      if (!Array.isArray(result?.data)) throw fail('codex-native-rpc-invalid-response', 'Codex returned no thread list.');
      entry.expires = Date.now() + (options.probeCacheMs ?? 30000);
      return { nativeAvailable: true };
    }).catch(error => {
      entry.expires = Date.now() + 5000;
      return { nativeAvailable: false, reason: error };
    });
    probes.set(key, entry);
    return entry.promise;
  }
  return {
    async probe() {
      const { nativeAvailable, reason } = await probeCapabilities();
      if (!nativeAvailable) {
        const code = reason?.code ?? 'codex-native-rpc-unavailable';
        if (code === 'codex-native-rpc-unavailable' || code === 'codex-native-rpc-timeout') {
          throw fail(code, 'Codex Desktop is not reachable over its local debug port. Open Codex from FAswitch, then retry.'
            + (reason?.message ? ` (${reason.message})` : ''));
        }
        throw fail(code, reason?.message ?? 'The Codex Desktop readiness read failed.');
      }
      return { identity: { application: 'codex-desktop', home }, missing: [] };
    },
    readDefaultModel: input => readDefaultModel({ home, ...input, readEffectiveConfig: options.readEffectiveConfig
      ?? (({ workspace }) => nativeRequest('config/read', { includeLayers: false, cwd: workspace })),
      python: options.python, profile: options.profile }),
    async readCurrentModel(id) {
      const thread = await ensureCodexThreadNative(id, { request: nativeRequest });
      const model = currentModelFromThread(thread);
      if (!model?.model) throw fail('codex-model-unavailable', 'Codex Desktop has no live model selection for this thread.');
      return { ...model, verified: true, resolved: true };
    },
    async createFirstTurn(input) {
      // thread/start is the same entry the UI uses. Omitting model, effort,
      // approval, reviewer, sandbox, permissions and config leaves every one of
      // them to the user's Codex defaults.
      const started = await nativeRequest('thread/start', { cwd: path.resolve(input.workspace), threadSource: 'user' });
      const threadId = started?.thread?.id;
      if (typeof threadId !== 'string') throw fail('codex-native-rpc-invalid-response', 'Codex did not return a new thread id.');
      let turn;
      try {
        turn = await nativeRequest('turn/start', { threadId, clientUserMessageId: randomUUID(),
          input: [{ type: 'text', text: input.message, text_elements: [] }] });
        if (typeof turn?.turn?.id !== 'string') throw fail('codex-native-rpc-invalid-response', 'Codex accepted the thread but returned no turn.');
      } catch (error) {
        // The thread exists even when the first turn was not confirmed. Keep the
        // binding so a later read can reconcile instead of creating a second chat.
        throw fail(error.code ?? 'codex-first-turn-unconfirmed', error.message,
          { uncertain: true, nativeSessionId: threadId });
      }
      // The title is deliberately not set here: immediately after thread/start the
      // rollout is empty and thread/name/set is rejected. The backend retries it
      // once a projection has a message.
      return { created: true, nativeSessionId: threadId, turnId: turn.turn.id };
    },
    async setTitle({ nativeSessionId, name }) {
      await nativeRequest('thread/name/set', { threadId: nativeSessionId, name });
      return { renamed: true };
    },
    async send({ nativeSessionId, message }) {
      const result = await sendCodexTextNative(nativeSessionId, message, { request: nativeRequest });
      return { sent: true, turnId: result?.turn?.id ?? result?.turnId };
    },
    async observe({ nativeSessionId, workspace, projections = {}, requests = {} }) {
      let root;
      try { root = await ensureCodexThreadNative(nativeSessionId, { request: nativeRequest }); }
      catch (error) {
        if (error.code === 'codex-empty-rollout') {
          // thread/start succeeded but the first rollout has not been written.
          // The thread exists; report it as running without a transient error.
          const prior = projections[nativeSessionId];
          return { projections: prior ? { [nativeSessionId]: prior } : {},
            histories: prior ? { [nativeSessionId]: { messages: prior.messages ?? [], hasMore: false } } : {},
            hasMore: false,
            tree: { running: true, settled: false, nodes: [{ sessionId: nativeSessionId, parentSessionId: null,
              status: 'running', activity: 'running', changes: prior?.changes ?? [], coverage: CODEX_FILE_COVERAGE }] } };
        }
        throw error;
      }
      if (!samePath(root.cwd, workspace)) {
        throw fail('codex-native-binding-invalid', 'The managed thread no longer matches its desktop and workspace.');
      }
      // A poll is often a no-op. A cheap thread/read is enough to decide that:
      // reusing the previous projection avoids re-reading a long turn page and
      // walking the child tree. Active threads and unconfirmed writes always refresh.
      const cached = observeCache.get(nativeSessionId);
      const pending = Object.entries(requests).some(([, request]) => {
        if (!request) return false;
        if (request.status !== 'accepted') return true;
        // An accepted turn whose thread still has no messages needs one read to
        // establish the transcript; after that the turn id is enough.
        return (cached?.result?.histories?.[nativeSessionId]?.messages?.length ?? 0) === 0;
      });
      const fresh = cached && typeof root.updatedAt === 'number'
        && cached.updatedAt === root.updatedAt && cached.statusType === root.status?.type
        && root.status?.type !== 'active' && !pending && !cached.result.tree?.running
        && Date.now() - cached.at < (options.observeCacheMs ?? 3000);
      if (fresh) return cached.result;
      const nodes = [], next = {}, histories = {};
      const visited = new Set();
      let hasMore = false;
      const visit = async (thread, parentId) => {
        if (visited.has(thread.id)) return;
        visited.add(thread.id);
        const page = await listCodexTurnsNative(thread.id, { limit: TURN_PAGE_LIMIT, request: nativeRequest });
        const projection = projectCodexTurns(projections[thread.id], page.data, requests);
        const model = currentModelFromThread(thread);
        if (model) projection.currentModel = model;
        next[thread.id] = projection;
        const running = projection.running || thread.status?.type === 'active';
        nodes.push({ sessionId: thread.id, parentSessionId: parentId || null,
          ...(typeof thread.name === 'string' ? { name: thread.name } : {}),
          status: running ? 'running' : 'idle', activity: running ? 'running' : 'idle',
          changes: projection.changes, coverage: CODEX_FILE_COVERAGE });
        histories[thread.id] = { messages: projection.messages,
          hasMore: Boolean(page.nextCursor) || Boolean(projection.messagesOmitted) };
        hasMore ||= Boolean(page.nextCursor);
        const children = await childrenOf(thread.id);
        for (const child of children) if (typeof child?.id === 'string') await visit(child, thread.id);
      };
      await visit(root, null);
      const result = { projections: next, histories, hasMore,
        tree: { nodes, running: nodes.some(node => node.status === 'running'),
          settled: nodes.every(node => node.status === 'idle') } };
      observeCache.set(nativeSessionId, { updatedAt: root.updatedAt, statusType: root.status?.type,
        at: Date.now(), result });
      return result;
    },
    async interrupt({ nativeSessionId, ownedNodeIds = [] }) {
      await ensureCodexThreadNative(nativeSessionId, { request: nativeRequest });
      const allowed = new Set(ownedNodeIds.length ? ownedNodeIds : [nativeSessionId]);
      const visited = new Set(), interruptedTurns = [];
      const visit = async id => {
        if (visited.has(id) || !allowed.has(id)) return;
        visited.add(id);
        try {
          const page = await listCodexTurnsNative(id, { limit: 10, request: nativeRequest });
          const active = (page.data ?? []).find(turn => turn?.status === 'inProgress' && typeof turn.id === 'string');
          if (active) {
            try {
              await nativeRequest('turn/interrupt', { threadId: id, turnId: active.id });
              interruptedTurns.push({ threadId: id, turnId: active.id });
            } catch (error) {
              if (!/no active turn|not running|no turn/i.test(String(error?.rpcMessage ?? error?.message ?? ''))) throw error;
            }
          }
        } catch (error) {
          if (error.code !== 'codex-thread-not-found') throw error;
        }
        for (const child of await childrenOf(id)) if (typeof child?.id === 'string') await visit(child.id);
      };
      await visit(nativeSessionId);
      // A root turn interrupt reaches native descendants on the desktop, but a
      // descendant can still be running after the root turn ended, so every
      // owned node with an in-progress turn is interrupted explicitly.
      return { interrupted: true, interruptedTurns };
    },
    async destroy(input) {
      const { nativeSessionId, workspace, ownedNodeIds = [] } = input;
      if (!ownedNodeIds.includes(nativeSessionId)) {
        throw fail('codex-delete-owner-mismatch', 'Native deletion requires the shared managed root binding.');
      }
      let root;
      try { root = await readCodexThreadNative(nativeSessionId, { request: nativeRequest }); }
      catch (error) {
        if (error.code === 'codex-thread-not-found') return { destroyed: true };
        throw error;
      }
      // The roster binding plus the thread's cwd are the ownership evidence. The
      // old thread_source/agent_created_thread marker is gone from this path.
      if (!samePath(root.cwd, workspace)) {
        throw fail('codex-delete-owner-mismatch', 'The deletion target no longer matches the managed workspace.');
      }
      const rows = [], visited = new Set();
      const visit = async id => {
        if (visited.has(id)) return;
        visited.add(id);
        if (!ownedNodeIds.includes(id)) {
          throw fail('codex-delete-owner-mismatch', 'A native descendant is no longer in the managed ownership snapshot.');
        }
        const children = await childrenOf(id);
        for (const child of children) if (typeof child?.id === 'string') await visit(child.id);
        rows.push(id); // descendants before root; a partial failure retains the root binding
      };
      await visit(nativeSessionId);
      if (ownedNodeIds.some(id => !visited.has(id))) {
        throw fail('codex-delete-owner-mismatch', 'An owned node is no longer a native descendant.');
      }
      const exists = async id => {
        try { await readCodexThreadNative(id, { request: nativeRequest }); return true; }
        catch (error) {
          // Only this post-delete check treats "thread not loaded" as gone: a normal
          // cold read succeeds with status notLoaded instead of rejecting.
          if (error.code === 'codex-thread-not-found'
              || /thread not loaded|thread not found|does not exist/i.test(String(error?.rpcMessage ?? error?.message ?? ''))) return false;
          throw error;
        }
      };
      for (const id of rows) {
        await nativeRequest('thread/delete', { threadId: id });
        if (await exists(id)) return { destroyed: false, message: 'Native deletion did not remove the thread record.' };
      }
      return { destroyed: true };
    },
    async findCreatedSession(input) {
      // Recovery must never resume a user's thread. thread/read with includeTurns
      // is metadata/history-only; one unreadable candidate is skipped, not fatal.
      const list = await nativeRequest('thread/list', { limit: 100,
        sortKey: 'created_at', sortDirection: 'desc', archived: false,
        useStateDbOnly: true, sourceKinds: ALL_SOURCE_KINDS });
      if (!Array.isArray(list?.data)) throw fail('codex-native-rpc-invalid-response', 'Codex returned no thread list.');
      const cutoff = Math.floor(Date.parse(input.startedAt) / 1000) - 5;
      const hits = [];
      for (const thread of list.data) {
        if (typeof thread?.id !== 'string' || (thread.createdAt ?? 0) < cutoff) continue;
        let turns;
        try {
          const read = await readCodexThreadNative(thread.id, { request: nativeRequest, includeTurns: true });
          turns = Array.isArray(read.turns) ? read.turns : [];
        } catch { continue; }
        const observed = projectCodexTurns(emptyProjection(), turns, { recovery: { marker: input.marker } });
        if (observed.deliveries.recovery) hits.push(thread);
      }
      if (hits.length > 1) throw fail('codex-binding-ambiguous', 'More than one native thread carries this dispatch marker.');
      return hits.length ? { nativeSessionId: hits[0].id } : undefined;
    },
  };
}
