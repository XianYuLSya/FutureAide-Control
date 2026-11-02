import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.mjs';
import { boundedOutput } from './control.mjs';
import { createScopedAgents } from './scoped-agents.mjs';
import { createCliAgents } from './cli-agents.mjs';
import { createMutualContextResolver, registerClaudeHostContext, TRUSTED_CONTEXT } from './mutual-context.mjs';
import { notifyParent } from './mutual-notify.mjs';
import { createMcpDiagnostics } from './mcp-diagnostics.mjs';
import { summarizeAgentList } from './agent-list-summary.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One public tool vocabulary; names and their runtime are scoped to the calling chat. */
export async function createMutualService(config, { cliFactory = createCliAgents, dshFactory = createScopedAgents, contextResolver } = {}) {
  let cli;
  const resolveContext = contextResolver ?? createMutualContextResolver(config, {
    resolveManaged: (...args) => cli.resolveManagedContext(...args),
    resolveDesktop: (...args) => cli.resolveDesktopContext(...args),
  });
  cli = cliFactory(config, { resolveContext, notify: notice => notifyParent(notice, config) });
  let dsh;
  const dshService = () => dsh ??= dshFactory(config);
  const trusted = (extra, context) => ({ ...extra, [TRUSTED_CONTEXT]: context });
  const permitsDsh = owner => owner.client === 'codex-desktop';
  const refuseDesktopTarget = (runtime, record) => {
    if (runtime === 'claude' && record?.desktopMode !== 'native') throw fail('claude-desktop-required', 'Claude Desktop native host binding is required; independent CLI execution and credential reuse are prohibited.');
    if (runtime === 'codex' && record?.desktopMode !== 'native') throw fail('codex-desktop-required', 'Codex Desktop native host binding is required; independent CLI execution and credential reuse are prohibited.');
  };

  async function target(name, extra) {
    const owner = await resolveContext(extra);
    const record = cli.store.named(owner.ownerId, name);
    if (record) return { service: cli, record, owner, extra: trusted(extra, owner) };
    if (permitsDsh(owner) && dshService().store.named(owner.ownerId, name)) return { service: dshService(), owner, extra };
    throw fail('agent-not-found', `No subagent named “${name}” exists in this chat.`);
  }

  const service = {
    cli, resolveContext,
    async status(extra) {
      const owner = await resolveContext(extra);
      const local = await cli.status(trusted(extra, owner));
      const hostStatus = owner.profileId ? await cli.desktopHostStatus(trusted(extra, owner), { targetRuntime: 'claude', targetClient: 'claude-code' }) : { ready: false };
      const codexHostStatus = owner.profileId ? await cli.desktopHostStatus(trusted(extra, owner), { targetRuntime: 'codex', targetClient: 'codex-desktop' }) : { ready: false };
      const dshState = permitsDsh(owner) ? await dshService().status(extra) : undefined;
      return { ...dshState, ...local, agents: (local.agents ?? 0) + (dshState?.agents ?? 0), version: '0.7.0', profileBound: Boolean(owner.profileId),
        runtimes: { dsh: permitsDsh(owner), claude: hostStatus.ready, codex: codexHostStatus.ready },
        runtimeErrors: { ...(hostStatus.ready ? {} : { claude: 'desktop-host-not-registered' }), ...(codexHostStatus.ready ? {} : { codex: 'codex-host-not-registered' }) },
        ...(dshState ? { dsh: dshState } : {}) };
    },
    async create(args, extra) {
      const owner = await resolveContext(extra);
      if (cli.store.named(owner.ownerId, args.name) || (permitsDsh(owner) && dshService().store.named(owner.ownerId, args.name))) {
        throw fail('agent-name-exists', 'This subagent name is already in use in this chat.');
      }
      const runtime = args.runtime ?? (permitsDsh(owner) ? 'dsh' : 'codex');
      if (runtime !== 'dsh') {
        const host = await cli.desktopHostStatus(trusted(extra, owner), {
          targetRuntime: runtime, targetClient: runtime === 'claude' ? 'claude-code' : 'codex-desktop',
        });
        if (!host.ready) throw fail(`${runtime}-host-not-registered`, `The ${runtime} native dispatcher is not registered for this profile and workspace.`);
      }
      if (runtime === 'dsh') {
        if (!permitsDsh(owner)) throw fail('dsh-parent-unsupported', 'DSH dispatch is available only to Codex Desktop callers. Claude Desktop does not support direct DSH dispatch; use its registered native target.');
        return dshService().create(args, extra);
      }
      return cli.create({ ...args, runtime }, trusted(extra, owner));
    },
    async list(extra) {
      const owner = await resolveContext(extra);
      const cliList = await cli.list(trusted(extra, owner));
      const dshList = permitsDsh(owner) ? await dshService().list(extra) : { items: [] };
      const items = [...dshList.items.map(item => ({ runtime: 'dsh', ...item })), ...cliList.items];
      return summarizeAgentList({ items, total: items.length });
    },
    async wait({ names, timeoutSeconds = 0 }, extra) {
      const owner = await resolveContext(extra);
      const deadline = Date.now() + timeoutSeconds * 1000;
      const dshNames = permitsDsh(owner) ? dshService().store.list(owner.ownerId).map(a => a.name) : [];
      const cliNames = cli.store.list(owner.ownerId).map(a => a.name);
      const wanted = names ?? [...dshNames, ...cliNames];
      const missing = wanted.filter(name => !dshNames.includes(name) && !cliNames.includes(name));
      let items = [], reports = [], questions = [];
      do {
        const selections = [
          ...(wanted.some(name => cliNames.includes(name)) ? [cli.wait({ names: wanted.filter(name => cliNames.includes(name)), timeoutSeconds: 0 }, trusted(extra, owner))] : []),
          ...(wanted.some(name => dshNames.includes(name)) ? [dshService().wait({ names: wanted.filter(name => dshNames.includes(name)), timeoutSeconds: 0 }, extra)] : []),
        ];
        const results = await Promise.all(selections);
        for (const name of results.flatMap(result => result.notListed ?? [])) if (!missing.includes(name)) missing.push(name);
        items = results.flatMap(result => result.items ?? []);
        reports = results.flatMap(result => result.reports ?? []);
        questions = results.flatMap(result => result.questions ?? []);
        if (missing.length || reports.length || questions.length || items.some(item => !['running', 'creating', 'reconnecting'].includes(item.state)) || Date.now() >= deadline) break;
        await sleep(Math.min(500, deadline - Date.now()));
      } while (true);
      return { items, ...(reports.length ? { reports } : {}), ...(questions.length ? { questions } : {}),
        notListed: missing, timedOut: Date.now() >= deadline && items.some(item => item.state === 'running') };
    },
    async report(args, extra) {
      const managed = await resolveContext(extra);
      if (!managed.reportContext) throw fail('managed-parent-required', 'report_parent is available only inside a managed subagent.');
      return cli.report(args, trusted(extra, managed.reportContext));
    },
    async ask(args, extra) {
      const managed = await resolveContext(extra);
      if (!managed.reportContext) throw fail('managed-parent-required', 'ask_parent is available only inside a managed subagent.');
      return cli.ask(args, trusted(extra, managed.reportContext));
    },
    close() { cli.close(); dsh?.store.close(); },
  };
  service.hostRegister = async (args, extra) => cli.registerDesktopHost(extra ?? args, {
    replace: args?.replace === true,
  });
  service.hostReceive = async (args, extra) => cli.receiveDesktopRequest(extra, {
    timeoutMs: Math.max(0, Number(args.timeout_seconds ?? 3600)) * 1000,
  });
  service.hostAck = async (args, extra) => cli.ackDesktopRequest(extra, {
    requestId: args.request_id,
    deliveryReceipt: args.delivery_receipt,
    status: args.status,
    nativeHandle: args.native_handle,
    nativeAgentId: args.native_agent_id,
  });
  service.hostAttach = async (args, extra) => cli.attachDesktopRequest(extra, args.ticket);
  service.hostDeliveryAck = async (args, extra) => cli.deliveryAck(extra, {
    notificationId: args.notification_id,
    status: args.status,
  });
  for (const method of ['send', 'answer', 'changes', 'inspect', 'cancel', 'delete']) service[method] = async (args, extra) => {
    const selected = await target(args.name, extra);
    if (method === 'send' || method === 'answer') refuseDesktopTarget(selected.record?.runtime, selected.record);
    return selected.service[method](args, selected.extra);
  };
  return service;
}

export function makeMutualServer({ configPath, diagnostics, serviceFactory = createMutualService } = {}) {
  const server = new McpServer({ name: 'futureaide-control', version: '0.7.0' });
  let promise;
  const service = () => promise ??= loadConfig(configPath).then(serviceFactory);
  const name = z.string().min(1).max(80).describe('Subagent name in this calling chat.');
  const message = z.string().min(1).max(100000).describe('Task, update or answer text. No communication file is needed.');
  const progress = async (extra, progressState, text) => {
    const token = extra?._meta?.progressToken;
    if (token === undefined || token === null) return;
    try {
      await server.server.notification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: progressState, message: text },
      });
    } catch { /* Progress is advisory; the pending call remains valid. */ }
  };
  const register = (tool, description, inputSchema, action, readOnlyHint = false, { allowAgentContext = true } = {}) => server.registerTool(tool, {
    description, inputSchema: allowAgentContext ? { ...inputSchema, agent_context: z.string().min(1).optional() } : inputSchema,
    annotations: { readOnlyHint, destructiveHint: tool === 'futureaide_delete_agent', openWorldHint: !readOnlyHint },
    _meta: { 'anthropic/sessionIdKinds': ['cse', 'conversation'] },
  }, async (args, extra) => {
    const callExtra = allowAgentContext && args?.agent_context ? { ...extra, agent_context: args.agent_context } : extra;
    const finished = diagnostics?.tool(tool, callExtra);
    try {
      const result = await action(await service(), args, callExtra);
      return { content: [{ type: 'text', text: tool === 'futureaide_wait_agents' ? JSON.stringify(result) : boundedOutput(result) }],
        ...(result?.error || result?.created === false || result?.deleted === false ? { isError: true } : {}) };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code ?? 'operation-failed', message: error.message } }) }] };
    } finally { finished?.(); }
  });
  register('futureaide_status', 'Check the calling chat/project and available runtimes. DSH and native Claude/Codex Desktop dispatch use the bound host registry; unavailable native targets report a binding error, never an independent CLI or credential fallback.', {}, (s, _a, e) => s.status(e), true);
  register('futureaide_create_agent', 'Create a named subagent in this project. runtime defaults to dsh in Codex Desktop and codex in Claude Desktop; Claude native must be requested explicitly with runtime=claude. A native runtime requires its matching host registration. Creation starts no model; once is refused for native Desktop runtimes until native cleanup is safe; persistent is reusable.', {
    name, lifetime: z.enum(['once', 'persistent']), runtime: z.enum(['dsh', 'claude', 'codex']).optional(),
  }, (s, a, e) => s.create(a, e));
  register('futureaide_send_agent', 'Assign work or send an update by name. Native work returns queued:true, accepted:false until the host acknowledges a real native handle; running agents queue updates. Only explicit reports and questions notify the parent.', { name, message }, (s, a, e) => s.send(a, e));
  register('futureaide_answer_agent', 'Answer this named subagent’s question and resume its original task.', { name, message }, (s, a, e) => s.answer(a, e));
  register('futureaide_list_agents', 'Show this chat’s named agents, current task, activity and observed file changes. Use inspect only for deeper supervision.', {}, (s, _a, e) => s.list(e), true);
  register('futureaide_wait_agents', 'Receive explicit reports and questions from selected agents. Claude callers should use this while their children work. A timeout leaves work running.', {
    names: z.array(name).min(1).max(50).optional(), timeout_seconds: z.number().int().min(0).max(45).optional(),
  }, (s, a, e) => s.wait({ names: a.names, timeoutSeconds: a.timeout_seconds ?? 0 }, e));
  register('futureaide_agent_changes', 'Read a named agent’s attributed file changes without reading its conversation.', { name, task: z.number().int().min(0).optional() }, (s, a, e) => s.changes(a, e), true);
  register('futureaide_inspect_agent', 'Read this agent’s recent messages and tools when detailed supervision is needed.', { name, max_messages: z.number().int().min(1).max(100).optional() }, (s, a, e) => s.inspect({ name: a.name, maxMessages: a.max_messages ?? 20 }, e), true);
  register('futureaide_cancel_agent', 'Stop this agent’s current task and owned processes, preserving reusable context. Native Claude cancellation is explicitly unsupported until a real native cancel handle is available.', { name }, (s, a, e) => s.cancel(a, e));
  register('futureaide_delete_agent', 'Retire this named agent and its private session data after its owned processes stop. Project files remain.', { name }, (s, a, e) => s.delete(a, e));
  register('host_register', 'Register the current native Desktop session as the single dispatcher for its target runtime/client, profile and workspace. No name is accepted; the host remains outside the caller subagent roster. A different binding is refused unless the verified native host explicitly sets replace:true.', {
    replace: z.boolean().optional(),
  }, (s, a, e) => s.hostRegister(a, e), false, { allowAgentContext: false });
  register('host_receive', 'Long-pending receive for the registered native dispatcher. Returns one queued task envelope with delivery=received, or one explicit report/question notification with delivery=notification. Queue/notification retrieval is never native acceptance or delivery. Progress keeps a stdio wait alive.', {
    timeout_seconds: z.number().int().min(0).max(86400).optional(),
  }, async (s, a, e) => {
    const token = e?._meta?.progressToken;
    const started = Date.now();
    const timer = token === undefined || token === null ? undefined : setInterval(() => {
      void progress(e, Math.floor((Date.now() - started) / 1000), 'waiting for Desktop dispatcher inbox');
    }, 60000);
    try {
      return await s.hostReceive({ timeout_seconds: a.timeout_seconds ?? 3600 }, e);
    } finally { if (timer) clearInterval(timer); }
  }, false, { allowAgentContext: false });
  register('host_ack', 'Acknowledge a received Desktop envelope only after a real native Agent/SendMessage handle exists. accepted is never inferred from queue delivery; lost acknowledgements use unknown/reconcile.', {
    request_id: z.string().min(1), delivery_receipt: z.string().min(1),
    status: z.enum(['accepted', 'rejected', 'unknown']), native_handle: z.string().min(1).max(512).optional(),
    native_agent_id: z.string().min(1).max(512).optional(),
  }, (s, a, e) => s.hostAck(a, e), false, { allowAgentContext: false });
  register('host_attach', 'Bind the native child identity to the one-time request ticket. The child calls this from its real MCP context; the ticket is internal and never typed by the user.', {
    ticket: z.string().regex(/^ticket_[A-Za-z0-9._-]+$/).optional(),
    agent_context: z.string().regex(/^ticket_[A-Za-z0-9._-]+$/).optional(),
  }, (s, a, e) => s.hostAttach({ ...a, ticket: a.ticket ?? a.agent_context }, e), false, { allowAgentContext: false });
  register('host_delivery_ack', 'Confirm that the registered dispatcher already forwarded a host_receive notification with native followup_task/SendMessage to its managed parent. Only delivered marks the underlying report/question delivered; a root wake is never delivery. blocked/unknown remain explicit and are not reported as delivered.', {
    notification_id: z.string().min(1),
    status: z.enum(['delivered', 'blocked', 'unknown']),
  }, (s, a, e) => s.hostDeliveryAck(a, e), false, { allowAgentContext: false });
  register('report_parent', 'Submit an explicit report to your immediate parent. Use final=true only when your assigned work and children are finished; ordinary turn completion sends no report.', { message, final: z.boolean().optional() }, (s, a, e) => s.report(a, e));
  register('ask_parent', 'Ask your immediate parent a question needed to continue, then end the turn. The parent answers by your name and the same task resumes.', { message }, (s, a, e) => s.ask(a, e));
  const close = server.close.bind(server);
  server.close = async () => { if (promise) (await promise.catch(() => undefined))?.close(); await close(); };
  return server;
}

async function main() {
  const index = process.argv.indexOf('--config');
  const configPath = index >= 0 ? process.argv[index + 1] : undefined;
  if (configPath) process.env.FUTUREAIDE_CONTROL_CONFIG = configPath;
  if (process.argv.includes('--register-claude-context')) {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 100000) throw new Error('SessionStart payload is too large.'); }
    await registerClaudeHostContext(JSON.parse(input), await loadConfig(configPath));
    return;
  }
  const diagnostics = createMcpDiagnostics(configPath ?? process.env.FUTUREAIDE_CONTROL_CONFIG);
  const server = makeMutualServer({ configPath, diagnostics });
  const transport = new StdioServerTransport();
  diagnostics?.attach(transport);
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  process.stderr.write(`futureaide-control: ${error.code ?? 'startup-failed'}\n`);
  process.exitCode = 1;
});
