import { execFile } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { discoverCodexBridge } from './codex-notify.mjs';
import { readCodexSessionModel, interruptCodexSession, requestCodexNative } from './codex-ipc.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.toNamespacedPath(path.resolve(a)).toLowerCase() === path.toNamespacedPath(path.resolve(b)).toLowerCase();
export const CODEX_FILE_COVERAGE = { source: 'codex-native-file-change', complete: false,
  note: 'Native file-change items are attributed; arbitrary shell writes are not inferred.' };
export const markerLine = (requestId, nonce) => `[FutureAide dispatch ${JSON.stringify([requestId, nonce])}]`;

export function toolPayload(result) {
  if (result?.isError) throw fail('codex-tool-rejected', result.content?.find(item => item.type === 'text')?.text || 'Codex rejected the operation.');
  if (result?.structuredContent) return result.structuredContent;
  for (const item of result?.content ?? []) if (item.type === 'text') {
    try { return JSON.parse(item.text); } catch { /* only structured native results count */ }
  }
  throw fail('codex-invalid-response', 'Codex did not return a structured result.');
}

// Use the desktop's bundled MCP proxy. This proxy forwards to the running app;
// its process is not a model runner and does not start a second app-server.
export function createDesktopToolBridge({ discover = discoverCodexBridge, idleMs = 30000,
  createClient = () => new Client({ name: 'futureaide-control-codex', version: '0.1.0' }),
  createTransport = bridge => new StdioClientTransport({ command: process.execPath, args: [bridge.serverPath],
    env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: bridge.pipePath }, stderr: 'ignore' }) } = {}) {
  let connection, timer, active = 0;
  async function close(target = connection) {
    clearTimeout(timer);
    if (connection === target) connection = undefined;
    if (target) await (await target.promise.catch(() => null))?.close();
  }
  async function connect(target) {
    const client = createClient();
    try {
      await client.connect(createTransport(await discover()));
      client.onclose = () => { if (connection === target) connection = undefined; };
      return client;
    } catch (error) { await client.close().catch(() => {}); throw error; }
  }
  return { close, async invoke(contextThreadId, name, args) {
    if (typeof contextThreadId !== 'string' || !contextThreadId) throw fail('codex-caller-context-required', 'A verified Codex caller or native UI creation entry is required.');
    if (!['create_thread', 'send_message_to_thread', 'read_thread', 'list_projects', 'list_threads'].includes(name)) {
      throw fail('codex-tool-unsupported', `Unsupported desktop tool ${name}.`);
    }
    clearTimeout(timer); active++;
    let target;
    try {
      if (!connection) { connection = {}; connection.promise = connect(connection); }
      target = connection;
      const client = await target.promise;
      // Never replay a failed write. The adapter reconciles its nonce from the
      // native transcript; a subsequent independent call may reconnect.
      let result;
      try { result = await client.callTool({ name, arguments: args,
        _meta: { 'openai/threadId': contextThreadId } }, undefined, { timeout: 30000 }); }
      catch (error) { await close(target); throw error; }
      return toolPayload(result);
    } catch (error) { if (target) target.promise.catch(() => { if (connection === target) connection = undefined; }); throw error; }
    finally {
      active--;
      if (!active) { timer = setTimeout(() => { void close(); }, idleMs); timer.unref?.(); }
    }
  } };
}

// One proxy per monitor/server process, shared by all managed Codex names.
const desktopBridge = createDesktopToolBridge();
export const invokeDesktopTool = (contextThreadId, name, args) => desktopBridge.invoke(contextThreadId, name, args);
export const closeDesktopBridge = () => desktopBridge.close();

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

export function readNativeThread(home, threadId) {
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT id,rollout_path,cwd,source,originator,thread_source,model,reasoning_effort,archived FROM threads WHERE id=?').get(threadId); }
  finally { db.close(); }
}

export function readNativeChildren(home, parentId) {
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'), { readOnly: true });
  try {
    return db.prepare(`SELECT id,rollout_path,cwd,source,originator,thread_source,model,reasoning_effort,archived FROM threads
      WHERE CASE WHEN json_valid(source) THEN json_extract(source, '$.subagent.thread_spawn.parent_thread_id') END = ?`).all(parentId);
  } finally { db.close(); }
}

export function emptyProjection() {
  return { offset: 0, seq: 0, running: false, messages: [], changes: [], deliveries: {}, turns: {}, seen: {}, children: [] };
}
const textContent = item => typeof item.text === 'string' ? item.text
  : typeof item.output === 'string' ? item.output
  : (Array.isArray(item.content) ? item.content : []).filter(x => typeof x.text === 'string').map(x => x.text).join('\n');

export function projectCodexEvent(projection, event, requests = {}) {
  const p = event.payload ?? {}, seq = ++projection.seq;
  if (event.type === 'turn_context') projection.currentModel = { provider: p.model_provider ?? 'openai', model: p.model, reasoningEffort: p.effort };
  if (event.type === 'event_msg' && p.type === 'task_started') {
    projection.running = true; projection.turnId = p.turn_id;
    projection.turns[p.turn_id] = { state: 'running', startSeq: seq };
  }
  if (event.type === 'event_msg' && ['task_complete', 'task_completed', 'turn_aborted'].includes(p.type)) {
    const id = p.turn_id ?? projection.turnId;
    projection.turns[id] = { ...projection.turns[id], state: 'ended', endSeq: seq,
      completionReason: p.type === 'turn_aborted' ? 'cancelled' : 'completed' };
    if (id === projection.turnId) projection.running = false;
  }
  const delegated = item => item?.namespace === 'codex_app'
    && ['create_thread', 'send_message_to_thread'].includes(item.name)
    && ['function_call_output', 'FunctionCallOutput', 'functionCallOutput'].includes(item.type);
  const item = event.type === 'event_msg' && p.type === 'item_completed' ? p.item
    : event.type === 'response_item' && ((p.type === 'message' && p.role === 'user') || delegated(p)) ? p : null;
  if (!item) return;
  const kind = String(item.type).toLowerCase();
  if (['usermessage', 'agentmessage', 'message'].includes(kind) || delegated(item)) {
    const role = kind === 'usermessage' || item.role === 'user' || delegated(item) ? 'user' : 'assistant';
    const text = textContent(item);
    const key = item.id ?? `${role}:${event.timestamp}:${text}`;
    if (!projection.seen[key]) {
      projection.seen[key] = true;
      projection.messages.push({ role, text, seq, turnId: p.turn_id ?? projection.turnId });
      if (projection.messages.length > 1000) { projection.messages.shift(); projection.messagesOmitted = (projection.messagesOmitted ?? 0) + 1; }
    }
    if (role === 'user') for (const [id, request] of Object.entries(requests)) if (text.includes(request.marker)) {
      projection.deliveries[id] = { seq, turnId: p.turn_id ?? projection.turnId };
    }
  }
  if (kind === 'filechange' && item.status === 'completed') {
    const changes = Array.isArray(item.changes) ? item.changes : Object.entries(item.changes ?? {}).map(([path, change]) => ({ path, ...change }));
    for (const change of changes) if (typeof change.path === 'string') {
      projection.changes.push({ path: change.path, kind: change.kind?.type ?? change.kind ?? change.type ?? 'modify', seq,
        source: 'codex-native-file-change' });
    }
  }
  // An ordinary final AgentMessage is deliberately never an explicit report.
}

export async function readTranscript(row, previous, requests) {
  const projection = structuredClone(previous ?? emptyProjection());
  const handle = await open(row.rollout_path, 'r');
  try {
    const info = await handle.stat();
    if (info.size < projection.offset) throw fail('codex-history-replaced', 'Codex history shrank; retained cursor needs reconciliation.');
    const buffer = Buffer.alloc(Math.min(info.size - projection.offset, 8 * 1024 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, projection.offset);
    const complete = buffer.subarray(0, bytesRead).lastIndexOf(10);
    if (complete >= 0) {
      for (const line of buffer.subarray(0, complete).toString('utf8').split('\n')) {
        if (line.trim()) projectCodexEvent(projection, JSON.parse(line), requests);
      }
      projection.offset += complete + 1;
    }
    return { projection, hasMore: projection.offset < info.size };
  } finally { await handle.close(); }
}

export function createCodexHost(options = {}) {
  const home = options.home ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  const invoke = options.invoke ?? invokeDesktopTool;
  const read = options.readNativeThread ?? (id => readNativeThread(home, id));
  const children = options.readNativeChildren ?? (id => readNativeChildren(home, id));
  const nativeRequest = options.nativeRequest ?? requestCodexNative;
  return {
    async probe() {
      await (options.discover ?? discoverCodexBridge)();
      await stat(path.join(home, 'state_5.sqlite'));
      const missing = [];
      if (!options.contextThreadId && !options.anchorResolver && !options.createViaUi) missing.push('native-first-create-without-codex-anchor');
      try { await nativeRequest('config/read', { includeLayers: false, cwd: options.workspace ?? process.cwd() }); }
      catch { if (!options.destroyViaUi) missing.push('native-owned-tree-delete'); }
      return { identity: { application: 'codex-desktop', home }, missing };
    },
    readDefaultModel: input => readDefaultModel({ home, ...input, readEffectiveConfig: options.readEffectiveConfig
      ?? (({ workspace }) => nativeRequest('config/read', { includeLayers: false, cwd: workspace })),
      python: options.python, profile: options.profile }),
    readCurrentModel: id => (options.readSessionModel ?? readCodexSessionModel)(id),
    async createFirstTurn(input) {
      const anchor = options.contextThreadId ?? await options.anchorResolver?.({ workspace: input.workspace });
      const contextThreadId = typeof anchor === 'string' ? anchor : anchor?.threadId;
      if (!contextThreadId) {
        if (!options.createViaUi) throw fail('codex-caller-context-required', 'A Claude caller needs native Desktop creation; no Codex anchor was supplied.');
        return options.createViaUi(input);
      }
      const catalog = await invoke(contextThreadId, 'list_projects', {});
      const candidates = (catalog.projects ?? []).filter(project => samePath(project.path ?? project.cwd, input.workspace)
        && (project.hostId === undefined || project.hostId === 'local') && project.projectKind !== 'chatgpt');
      if (candidates.length !== 1) throw fail('codex-project-unresolved', 'The workspace must match exactly one saved local Codex project.');
      const result = await invoke(contextThreadId, 'create_thread', { prompt: input.message,
        title: input.title, model: input.model.model, thinking: input.model.reasoningEffort,
        target: { type: 'project', projectId: candidates[0].projectId ?? candidates[0].id, environment: { type: 'local' } } });
      const id = result.threadId ?? result.conversationId;
      if (!id || (result.status && result.status !== 'created')) return { created: false, uncertain: true };
      return { created: true, nativeSessionId: id };
    },
    async send({ nativeSessionId, message, model }) {
      const result = await invoke(nativeSessionId, 'send_message_to_thread', { threadId: nativeSessionId,
        prompt: message, model: model.model, thinking: model.reasoningEffort });
      return { result }; // transcript marker, not a guessed response field, confirms admission
    },
    async observe({ nativeSessionId, workspace, projections = {}, requests = {} }) {
      const root = read(nativeSessionId);
      if (!root || root.originator !== 'Codex Desktop' || !samePath(root.cwd, workspace)) {
        throw fail('codex-native-binding-invalid', 'The managed thread no longer matches its desktop and workspace.');
      }
      const rows = [], visited = new Set();
      const visit = (row, parentId = null) => {
        if (visited.has(row.id)) return;
        visited.add(row.id); rows.push({ ...row, parentId });
        for (const child of children(row.id)) {
          if (child.originator !== 'Codex Desktop') throw fail('codex-tree-owner-mismatch', 'Native descendant has a different originator.');
          visit(child, row.id);
        }
      };
      visit(root);
      const nodes = [], next = {}, histories = {};
      let hasMore = false;
      for (const row of rows) {
        const result = await (options.readTranscript ?? readTranscript)(row, projections[row.id], requests);
        next[row.id] = result.projection; hasMore ||= result.hasMore;
        nodes.push({ sessionId: row.id, parentSessionId: row.parentId, status: result.projection.running ? 'running' : 'idle',
          activity: result.projection.running ? 'running' : 'idle', changes: result.projection.changes, coverage: CODEX_FILE_COVERAGE });
        histories[row.id] = { messages: result.projection.messages, hasMore: !!result.projection.messagesOmitted || result.hasMore };
      }
      return { projections: next, histories, hasMore, tree: { nodes, running: nodes.some(n => n.status === 'running'),
        settled: !hasMore && nodes.every(n => n.status === 'idle') } };
    },
    async interrupt({ nativeSessionId, ownedNodeIds }) {
      // Desktop's root interrupt traverses native descendants. Explicit ids stay
      // available to the UI driver for a cold, unloaded root owner.
      try { return await (options.interruptSession ?? interruptCodexSession)(nativeSessionId); }
      catch (error) { if (!options.interruptViaUi) throw error; return options.interruptViaUi({ nativeSessionId, ownedNodeIds }); }
    },
    async destroy(input) {
      if (options.destroyViaUi) return options.destroyViaUi(input);
      const { nativeSessionId, workspace, ownedNodeIds = [] } = input;
      if (!ownedNodeIds.includes(nativeSessionId)) throw fail('codex-delete-owner-mismatch', 'Native deletion requires the shared managed root binding.');
      const root = read(nativeSessionId);
      if (!root) return { destroyed: ownedNodeIds.every(id => !read(id)) };
      if (root.originator !== 'Codex Desktop' || root.thread_source !== 'agent_created_thread' || !samePath(root.cwd, workspace)) {
        throw fail('codex-delete-owner-mismatch', 'The deletion target is not the independently created managed Desktop chat.');
      }
      const rows = [], visited = new Set();
      function visit(row) {
        if (visited.has(row.id)) return;
        visited.add(row.id);
        if (!ownedNodeIds.includes(row.id) || row.originator !== 'Codex Desktop') throw fail('codex-delete-owner-mismatch', 'The native tree changed after its managed ownership snapshot.');
        for (const child of children(row.id)) visit(child);
        rows.push(row); // descendants before root; a partial failure retains the root binding
      }
      visit(root);
      if (ownedNodeIds.some(id => !visited.has(id) && read(id))) throw fail('codex-delete-owner-mismatch', 'An owned node is no longer a native descendant.');
      for (const row of rows) {
        await nativeRequest('thread/delete', { threadId: row.id });
        if (read(row.id)) return { destroyed: false, message: 'Native deletion did not remove the thread record.' };
      }
      return { destroyed: true };
    },
    async findCreatedSession(input) {
      if (options.findCreatedSession) return options.findCreatedSession(input);
      const db = new DatabaseSync(path.join(home, 'state_5.sqlite'), { readOnly: true });
      try {
        const rows = db.prepare('SELECT id,first_user_message,cwd,originator,rollout_path FROM threads WHERE created_at >= ?').all(Math.floor(Date.parse(input.startedAt) / 1000) - 5);
        const hits = [];
        for (const row of rows.filter(row => row.originator === 'Codex Desktop' && samePath(row.cwd, input.workspace))) {
          if (row.first_user_message?.includes(input.marker)) { hits.push(row); continue; }
          // Delegated input is a native tool output on current Desktop builds,
          // so first_user_message may be empty. Confirm its exact nonce in the
          // original rollout, never by a matching title or newest-thread guess.
          const observed = await (options.readTranscript ?? readTranscript)(row, emptyProjection(), {
            recovery: { marker: input.marker },
          });
          if (observed.projection.deliveries.recovery) hits.push(row);
        }
        if (hits.length > 1) throw fail('codex-binding-ambiguous', 'More than one native thread carries this dispatch marker.');
        return hits.length ? { nativeSessionId: hits[0].id } : undefined;
      } finally { db.close(); }
    },
  };
}
