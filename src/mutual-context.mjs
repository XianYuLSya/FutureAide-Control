import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveCallingContext, callingThread, ownerIdFor } from './calling-context.mjs';
import { resolveFaSwitchBinding } from './runtime-environment.mjs';
import { loadConfig } from './config.mjs';

export const TRUSTED_CONTEXT = Symbol('futureaide-internal-context');
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fail = message => Object.assign(new Error(message), { code: 'calling-context-unavailable' });
const failAgentContext = message => Object.assign(new Error(message), { code: 'desktop-context-invalid' });
const contextRoot = config => path.join(config.cliStateDirectory ?? config.stateDirectory, 'host-contexts', 'claude');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

/** Only process identities are read; command lines, environment blocks and other chats are not. */
export async function processAncestry(start = process.ppid) {
  if (process.platform !== 'win32') return [{ pid: start }];
  const script = `$ErrorActionPreference='Stop'; $nextPid=${Number(start)}; $rows=@(); for($i=0;$i -lt 10 -and $nextPid -gt 0;$i++){ $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$nextPid); if(!$p){break}; $rows+=@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;started=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath}; $nextPid=[int]$p.ParentProcessId }; ConvertTo-Json -InputObject $rows -Compress`;
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', data => output += data.toString('utf8'));
    child.once('error', () => reject(fail('The Claude host process could not be checked.')));
    child.once('close', code => {
      if (code !== 0) return reject(fail('The Claude host process could not be checked.'));
      try { resolve(JSON.parse(output)); } catch { reject(fail('The Claude host returned no process identity.')); }
    });
  });
}

/** SessionStart runs inside the existing Desktop Code account and records identity only. */
export async function registerClaudeHostContext(input, config, env = process.env) {
  const sessionId = input.session_id;
  const hostPid = Number(env.CLAUDE_PID ?? process.ppid);
  if (!UUID.test(sessionId ?? '') || !path.isAbsolute(input.cwd ?? '') || !Number.isSafeInteger(hostPid) || hostPid <= 0) throw fail('Claude did not provide a session identity and project.');
  const workspace = await realpath(input.cwd);
  const binding = await resolveFaSwitchBinding(config, env.FUTUREAIDE_PROFILE_ID ? { profileId: env.FUTUREAIDE_PROFILE_ID } : {});
  const host = (await processAncestry(hostPid))[0];
  if (!host || host.pid !== hostPid || !/claude(?:\.exe)?$/i.test(path.basename(host.executable ?? ''))) throw fail('SessionStart did not originate from the Claude runtime.');
  const hostSessionId = UUID.test(env.CLAUDE_CODE_HOST_SESSION_ID ?? '') ? env.CLAUDE_CODE_HOST_SESSION_ID : sessionId;
  const record = { sessionId, hostSessionId, workspace, hostPid, hostStarted: host.started,
    profileId: binding.profileId, client: 'claude-code', observedAt: new Date().toISOString() };
  await mkdir(contextRoot(config), { recursive: true });
  for (const key of new Set([sessionId, hostSessionId, `pid-${hostPid}`])) {
    const filename = path.join(contextRoot(config), `${key}.json`);
    let value = record;
    if (key.startsWith('pid-')) {
      let previous;
      try { previous = await readJson(filename); } catch { /* First session in this process. */ }
      if (previous?.hostStarted === host.started && (previous.ambiguous || previous.sessionId !== sessionId)) value = { ...record, ambiguous: true };
    }
    await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  }
  return { registered: true };
}

async function resolveClaudeHostContext(extra, config) {
  const meta = extra?._meta ?? {};
  const supplied = [meta['anthropic/conversationUuid'], meta['anthropic/sessionId'], meta['claude/sessionId'],
    process.env.CLAUDE_CODE_SESSION_ID, process.env.CLAUDE_CODE_HOST_SESSION_ID].filter(id => UUID.test(id ?? ''));
  let record;
  for (const id of supplied) {
    try { record = await readJson(path.join(contextRoot(config), `${id}.json`)); break; } catch { /* Try the other host identity. */ }
  }
  let ancestors;
  if (!record) {
    ancestors = await processAncestry();
    for (const host of ancestors) {
      try {
        const candidate = await readJson(path.join(contextRoot(config), `pid-${host.pid}.json`));
        if (candidate.hostStarted === host.started) { record = candidate; break; }
      } catch { /* This process is not a registered Claude session. */ }
    }
  }
  if (!record) throw fail('Claude has not supplied this Code session identity. Start a new Code session after installing the FutureAide SessionStart hook.');
  if (record.ambiguous) throw fail('This Claude process registered multiple sessions without a unique request identity. Reconnect this Code session to obtain a separate MCP connection.');
  const live = ancestors?.find(p => p.pid === record.hostPid) ?? (await processAncestry(record.hostPid))[0];
  if (!live || live.pid !== record.hostPid || live.started !== record.hostStarted) throw fail('The recorded Claude host is no longer running.');
  if (process.env.FUTUREAIDE_PROFILE_ID && process.env.FUTUREAIDE_PROFILE_ID !== record.profileId) throw fail('This Claude session belongs to another FaSwitch profile.');
  return { ownerId: 'owner-' + createHash('sha256').update(`claude:${record.profileId}:${record.sessionId}`).digest('hex').slice(0, 32),
    threadId: record.sessionId, workspace: await realpath(record.workspace), profileId: record.profileId,
    client: 'claude-code', hostPid: record.hostPid, hostStarted: record.hostStarted };
}

export function createMutualContextResolver(config, { resolveManaged, resolveDesktop, callCodex } = {}) {
  const known = new Map();
  const claudeHosts = new Map();
  return async extra => {
    if (extra?.[TRUSTED_CONTEXT]) return extra[TRUSTED_CONTEXT];
    if (process.env.FUTUREAIDE_CLI_AGENT_ID) {
      if (!resolveManaged) throw fail('The managed agent identity verifier is unavailable.');
      return resolveManaged(process.env.FUTUREAIDE_CLI_AGENT_ID, process.env.FUTUREAIDE_CLI_TASK_ID, process.env.FUTUREAIDE_CLI_TOKEN);
    }
    const meta = extra?._meta;
    const suppliedAgentContext = typeof extra?.agent_context === 'string' && extra.agent_context.trim() !== '';
    if (meta?.threadId || meta?.['openai/threadId']) {
      const threadId = callingThread(extra);
      const ownerId = ownerIdFor(threadId);
      const native = await resolveCallingContext(extra, { knownOwner: known.get(ownerId), ...(callCodex ? { callCodex } : {}) });
      // Existing DSH installations do not require FaSwitch. Account binding is
      // mandatory when creating a Claude/Codex agent, not for DSH operations.
      let binding;
      try { binding = await resolveFaSwitchBinding(config); } catch { /* Checked on account-agent creation. */ }
      const owner = { ...native, client: 'codex-desktop', ...(binding ? { profileId: binding.profileId } : {}) };
      known.set(ownerId, owner);
      const desktop = resolveDesktop ? await resolveDesktop({ ...owner, client: 'codex-desktop', sessionId: owner.threadId, agentContext: extra?.agent_context }) : undefined;
      if (desktop?.reportContext) return { ...owner, ...desktop, reportContext: desktop.reportContext };
      if (suppliedAgentContext) throw failAgentContext('The supplied agent_context is unknown, expired, or belongs to another host.');
      return owner;
    }
    // A stdio MCP connection belongs to one live host. Verify it once instead
    // of launching a process inspection for every list/send/wait call.
    const key = [meta?.['anthropic/conversationUuid'], meta?.['anthropic/sessionId'], meta?.['claude/sessionId']]
      .filter(id => UUID.test(id ?? '')).join(':') || 'connection';
    if (!claudeHosts.has(key)) {
      const pending = resolveClaudeHostContext(extra, config);
      claudeHosts.set(key, pending);
      pending.catch(() => claudeHosts.delete(key));
    }
    const owner = await claudeHosts.get(key);
    if (key === 'connection') {
      const current = await readJson(path.join(contextRoot(config), `pid-${owner.hostPid}.json`));
      if (current.ambiguous || current.sessionId !== owner.threadId) throw fail('This Claude connection changed sessions without a unique request identity. Reconnect this Code session.');
    }
    const desktop = resolveDesktop ? await resolveDesktop({ ...owner, sessionId: owner.threadId, agentContext: extra?.agent_context }) : undefined;
    if (desktop?.reportContext) return { ...owner, ...desktop, reportContext: desktop.reportContext };
    if (suppliedAgentContext) throw failAgentContext('The supplied agent_context is unknown, expired, or belongs to another host.');
    return owner;
  };
}

export async function resolveMutualContext(extra) {
  if (extra?.[TRUSTED_CONTEXT]) return extra[TRUSTED_CONTEXT];
  const config = await loadConfig();
  const { createCliAgents } = await import('./cli-agents.mjs');
  const service = createCliAgents(config);
  try {
    return await createMutualContextResolver(config, {
      resolveManaged: (...args) => service.resolveManagedContext(...args),
      resolveDesktop: (...args) => service.resolveDesktopContext(...args),
    })(extra);
  } finally { service.close(); }
}
