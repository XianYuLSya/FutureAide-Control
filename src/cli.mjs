import { authorizeManagedTool, managedBindingFromEnv, verifyManagedCaller } from './managed-cli-policy.mjs';
import { normalizeQuestionIds } from './cli-question-selection.mjs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createProfile, listProfiles, loadConfig, loadManagedRosterConfig } from './config.mjs';
import { boundedOutput, createControl, errorResult } from './control.mjs';
import { installDesktopHostBridge, installHostBridge, maintenanceConfigPath } from './host-install.mjs';
import { createAgents } from './agents.mjs';
import { createPeers } from './peers.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' }, profile: { type: 'string' }, workspace: { type: 'string' },
    'session-id': { type: 'string' }, 'codex-thread-id': { type: 'string' },
    query: { type: 'string' }, limit: { type: 'string' },
    'max-messages': { type: 'string' }, 'through-seq': { type: 'string' }, view: { type: 'string' },
    message: { type: 'string' }, 'message-file': { type: 'string' },
    'request-id': { type: 'string' }, mode: { type: 'string' }, background: { type: 'boolean' },
    'timeout-seconds': { type: 'string' }, timeout: { type: 'string' }, 'poll-interval-ms': { type: 'string' }, 'after-seq': { type: 'string' },
    conv: { type: 'string' }, conversation: { type: 'string' },
    keys: { type: 'string' }, names: { type: 'string' }, 'task-keys': { type: 'string' },
    raw: { type: 'boolean' },
    barrier: { type: 'string' }, after: { type: 'string' }, target: { type: 'string' }, proxy: { type: 'string' },
    event: { type: 'string' }, summary: { type: 'string' }, evidence: { type: 'string' },
    'agent-preset': { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
    'reasoning-effort': { type: 'string' }, 'tool-name': { type: 'string' }, 'no-activate': { type: 'boolean' },
    'host-profile-directory': { type: 'string' }, refresh: { type: 'boolean' }, rebind: { type: 'boolean' },
    'agent-id': { type: 'string' }, 'task-name': { type: 'string' },
    'project-workspace': { type: 'string' }, 'project-name': { type: 'string' },
    'peer-id': { type: 'string' }, kind: { type: 'string' }, label: { type: 'string' }, state: { type: 'string' },
    'from-peer-id': { type: 'string' }, 'to-peer-id': { type: 'string' }, 'exchange-id': { type: 'string' },
    'parent-exchange-id': { type: 'string' },
    'timeout-minutes': { type: 'string' },
    id: { type: 'string' }, through: { type: 'string' }, todo: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    output: {type:'string'}, manifest: {type:'string'}, decisions: {type:'string'}, approval: {type:'string'}, ticket:{type:'string'}, 'original-id':{type:'string'},
    scopes: {type:'string'}, key: {type:'string'}, name: {type:'string'}, owner: {type:'string'}, from: {type:'string'},
    to: {type:'string'}, 'worktree-review': {type:'string'},
    parent: { type: 'string' }, 'reparent-to': { type: 'string' },
    'kill-tree': { type: 'boolean' }, 'keep-children': { type: 'string' },
    author: { type: 'string' }, urgent: { type: 'boolean' },
    role: { type: 'string' }, lifetime: { type: 'string' }, worktree: { type: 'boolean' },
    'base-sha': { type: 'string' }, 'discard-worktree': { type: 'boolean' },
    'question-id': { type: 'string', multiple: true },
  },
});

const managed = process.env.FUTUREAIDE_MANAGED_CLI === '1' || Boolean(process.env.FUTUREAIDE_PARENT_REQUEST_ID);
const managedBinding = managed ? managedBindingFromEnv() : undefined;
const deny = message => Object.assign(new Error(message), { code: 'permission-denied' });
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

async function loadScopedCliConfig() {
  if (!managed) return loadConfig(values.config, values.profile);
  const roster = process.env.FUTUREAIDE_ROSTER_PATH;
  if (!roster || !path.isAbsolute(roster) || path.basename(roster).toLowerCase() !== 'roster.sqlite') {
    throw deny('The managed caller is missing its bound roster.');
  }
  try {
    const config = await loadManagedRosterConfig(process.env.FUTUREAIDE_CONFIG, roster);
    const expected = path.join(config.stateDirectory, 'roster.sqlite');
    const info = pathKey(roster) === pathKey(expected) && await lstat(expected);
    if (!info?.isFile() || pathKey(await realpath(expected)) !== pathKey(expected)) throw deny('Invalid roster path.');
    // Authenticate before the writable roster can create tables or run migrations.
    const db = new DatabaseSync(expected, { readOnly: true });
    try {
      verifyManagedCaller({
        get(id) {
          const row = db.prepare('SELECT body FROM agents WHERE id=?').get(id);
          return row && JSON.parse(row.body);
        },
        submissions(agentId, taskId) {
          return db.prepare("SELECT kind, final FROM submissions WHERE agent=? AND task=? AND kind='report' AND final=1")
            .all(agentId, taskId);
        },
      }, managedBinding);
    } finally { db.close(); }
    const { antigravityCallerTokenFile: _desktopToken, ...childConfig } = config;
    return { ...childConfig, workspace: managedBinding.workspace ?? config.workspace };
  } catch {
    throw deny('The managed caller has no active dispatch in its configured roster.');
  }
}

const usage = `futureaide-control <connect|status|sessions|read|send|wait|watch|cancel|models|notify|codex-status|profiles|profile-create|create-session|select-model|capabilities|host-install|host-status>
  team run --role ROLE --message TEXT [--worktree --base-sha SHA]
  team create --role ROLE [--worktree --base-sha SHA]
  team answer NAME --message TEXT [--question-id ID ...]
  team delete NAME [--discard-worktree]
  team kick NAME [--discard-worktree]
  board post MESSAGE [--urgent --conv CONVERSATION_ID]
  feedback-pending
  feedback-organize --id ID --through N --todo KEY --message-file FILE
  feedback-todos
  spawn-agent --workspace ABSOLUTE_PATH --message TEXT [--task-name NAME] [--request-id ID]
              [--project-workspace PROJECT_ROOT] [--project-name TITLE]
              [--codex-thread-id UUID]   Bind THIS agent's completion notice to that chat; omit for report-only
  followup-agent --agent-id ID --message TEXT [--request-id ID]   Keeps the agent's own callback binding
  wait-agent --agent-id ID [--request-id ID] [--timeout-seconds 0..45]
  cancel-agent --agent-id ID [--request-id ID]
  list-agents [--workspace ABSOLUTE_PATH]
  register-peer --peer-id NAME --kind codex-desktop --workspace ABS --codex-thread-id UUID
  register-peer --peer-id NAME --kind dsh --workspace ABS --agent-id AGENT_ID
  register-peer --peer-id NAME --kind mailbox --workspace ABS [--label TEXT]
  list-peers [--workspace ABS]
  inbox [--peer-id MAILBOX_NAME] [--state pending|completed|failed]
                            Lists durable mailbox items other peers sent to this inbox
  unregister-peer --peer-id NAME
  archive-peer --peer-id CODEX_TASK_NAME [--archived true|false]
                            Archive a finished Codex task chat; seed peers are refused
  send-peer --from-peer-id NAME --to-peer-id NAME --message-file PATH --request-id ID [--parent-exchange-id ID]
  read-exchange --exchange-id ID [--timeout-seconds 0..45] [--peer-id SOURCE_NAME]
                            --peer-id acknowledges consuming the answer in this turn
  await-exchange --exchange-id ID [--timeout-minutes 30]
                            Background waiter: exits only at a terminal state; the exit wakes the caller
  await-agent --agent-id ID [--timeout-minutes 30]
                            Background waiter for one dispatch; exits only at a terminal state
  await-inbox --peer-id MAILBOX_NAME [--timeout-minutes 30]
                            Background waiter: exits when another peer sends this mailbox new work
  reply-exchange --exchange-id ID --peer-id TARGET_NAME --message-file PATH --request-id ID
                            Reuses existing desktop chats; no new Codex CLI or proxy changes
  desktop-host-install --host-profile-directory ABSOLUTE_PATH [--refresh] [--rebind]
  desktop-config            Print the selected DSH data directory for the desktop connector
  --config PATH             Optional local connection configuration
  --profile NAME            Named connection for this call; omission keeps the default
  --session-id ID           Default: configured execution mother session
  connect --request-id ID   Prepare the bridge without starting a model or restarting the app
  cleanup preview --output FILE [--scopes roster,dsh,files]
  cleanup approve --manifest FILE --decisions FILE
  cleanup enable|disable|status
  cleanup apply --manifest FILE --approval DIGEST [--worktree-review FILE] [--output FILE]
  cleanup archive [--name NAME] [--owner ID] [--original-id ID] [--from UTC] [--to UTC] [--output FILE]
  cleanup restore --ticket STAGING_TICKET
  cleanup revoke --key INVENTORY_KEY
  cleanup vacuum --decisions FILE --approval DIGEST --output BACKUP_PATH
  profiles [--profile NAME]
  profile-create --profile NAME --workspace ABSOLUTE_PATH [--session-id ID] [--codex-thread-id ID]
  sessions --query TEXT --limit 20
  read --max-messages 8 [--through-seq N] [--view messages|events]
  send --message-file PATH --request-id UNIQUE-ID [--mode queue|steer]
  wait --conv CONV-ID [--keys k1,k2] [--names a,b] [--barrier any|all] [--timeout 3600]
  wait --request-id SEND-REQUEST-ID [--timeout-seconds 45] [--poll-interval-ms 1500] [--max-messages 8]
                            Block until that dispatched turn ends and print its reply; re-run while state is running
  proxy status [codex-cli|claude-cli|agy-cli|all]
  proxy bind <codex-cli|claude-cli|agy-cli|all> <port|url|faswitch|direct>
  team <adopt|kick|merge|reparent|resume|strays|sweep> [target] [--conv ID|--owner OWNER-ID] [--parent NAME] [--kill-tree] [--message TEXT]
  board <post|read> [message] [--conv ID|--owner OWNER-ID] [--author NAME] [--limit 50] [--after-seq 0]
  watch --request-id SEND-REQUEST-ID [--timeout-seconds 900] [--poll-interval-ms 5000]
                            Blocking watch with a saved report; automatic chat wakeup depends on the client
  cancel --request-id UNIQUE-ID
  create-session --request-id UNIQUE-ID [--agent-preset PRESET]
  attach-session --session-id ID --request-id UNIQUE-ID   Account an existing session to its native project
  select-model --session-id ID --provider PROVIDER --model MODEL [--reasoning-effort EFFORT] --request-id UNIQUE-ID
  capabilities --session-id ID [--tool-name NAME] [--no-activate]
  host-install              Install the owned bootstrap preset; does not restart FutureAide
  host-status               Check the loaded host bridge
  notify --event completed|blocked --summary TEXT --evidence PROJECT-FILE
Writes are never automatically retried after an uncertain response.`;

if (values.help || !positionals.length) {
  console.log(usage);
} else {
  try {
    const command = positionals[0];
    const isScopedWait = command === 'wait'
      && Boolean(
        values.conv || values.conversation || values.keys || values['task-keys'] || values.names || values.barrier
        || (!values['request-id'] && !values['session-id'] && process.env.ANTIGRAVITY_CONVERSATION_ID),
      );
    const feedback = command.startsWith('feedback-') ? await import('./feedback-inbox.mjs') : null;
    values.config = await maintenanceConfigPath(values.config || process.env.FUTUREAIDE_CONFIG, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const control = feedback || isScopedWait || ['profiles', 'profile-create', 'cleanup', 'proxy', 'team', 'board'].includes(command)
      ? undefined : createControl(await loadConfig(values.config, values.profile));
    const sessionId = values['session-id'];
    const number = name => {
      if (values[name] === undefined) return undefined;
      const value = Number(values[name]);
      if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer.`);
      return value;
    };
    let result;
    const agents = () => loadConfig(values.config).then(config => createAgents(config));
    const peers = () => loadConfig(values.config).then(config => createPeers(config));
    const messageText = () => values['message-file'] ? readFile(values['message-file'], 'utf8') : values.message;
    // A detached waiter is the push substitute: run this command with run_in_background, and the
    // process exits only when the exchange or agent reaches a terminal state. The calling session is
    // woken by that exit, so nobody has to poll the session itself. Waiting stays inside this process.
    const awaitDeadline = () => {
      const minutes = values['timeout-minutes'] === undefined ? 30 : Number(values['timeout-minutes']);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('timeout-minutes must be a positive number.');
      return Date.now() + minutes * 60000;
    };
    const awaitExchange = async () => {
      const id = values['exchange-id'];
      if (!id) throw new Error('await-exchange needs --exchange-id.');
      const deadline = awaitDeadline();
      for (;;) {
        const record = await (await peers()).read({ exchangeId: id, timeoutSeconds: 45 });
        if (['completed', 'failed', 'cancelled'].includes(record.state)) {
          // Terminal is not the same as success: the caller must read the state, not just the exit.
          return { ...record, awaiting: record.state };
        }
        if (record.state === 'awaiting_input') {
          // The target paused to ask a question. Waiting for the parent to complete would deadlock:
          // wake the caller so it can answer the child exchange, then it re-attaches this waiter.
          return { ...record, awaiting: 'input_required', note: 'The exchange is waiting for an answer before it can continue.' };
        }
        if (Date.now() >= deadline) {
          return { ...record, awaiting: 'timeout', note: 'await-exchange reached its deadline; the exchange is still not terminal. This is not a task failure.' };
        }
      }
    };
    const awaitAgent = async () => {
      const id = values['agent-id'];
      if (!id) throw new Error('await-agent needs --agent-id.');
      const deadline = awaitDeadline();
      for (;;) {
        const record = await (await agents()).wait({ agentId: id, requestId: values['request-id'], timeoutSeconds: 45 });
        if (['completed', 'failed', 'cancelled'].includes(record.state)) return { ...record, awaiting: record.state };
        if (Date.now() >= deadline) {
          return { ...record, awaiting: 'timeout', note: 'await-agent reached its deadline; the dispatch is still running. A watch deadline is not a task failure.' };
        }
      }
    };
    /**
     * Wake the caller when another peer addresses this mailbox. This is the inbound half of the push
     * substitute: nothing is sent by a peer can wake a Claude session, so a detached process watches
     * the mailbox directory and exits as soon as an unanswered item appears. The watcher observes its
     * own filesystem; it never marks items consumed and never replies for the owner.
     */
    const awaitInbox = async () => {
      const peerId = values['peer-id'];
      if (!peerId) throw new Error('await-inbox needs --peer-id.');
      const config = await loadConfig(values.config);
      const root = config.registryDirectory
        ? path.dirname(path.resolve(config.registryDirectory))
        : path.dirname(path.resolve(config.stateDirectory));
      const directory = path.join(root, 'peers', 'mailbox', peerId, 'inbox');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const deadline = awaitDeadline();
      const pendingItems = async () => {
        const found = [];
        for (const name of await readdir(directory).catch(() => [])) {
          if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
          try {
            const item = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
            if (item.state === 'pending') found.push({ exchangeId: item.exchangeId, fromPeerId: item.fromPeerId, createdAt: item.createdAt, requestId: item.requestId });
          } catch {
            // A partially written or foreign file is not an answer; keep watching.
          }
        }
        return found;
      };
      // Items already pending when the waiter starts are the owner's existing backlog, not a new
      // event; only work that arrives afterwards wakes the caller.
      const baseline = new Set((await pendingItems()).map(item => item.exchangeId));
      for (;;) {
        const fresh = (await pendingItems()).filter(item => !baseline.has(item.exchangeId));
        if (fresh.length > 0) return { awaiting: 'input_required', mailboxPeerId: peerId, items: fresh, note: 'New mailbox work arrived; answer it before continuing.' };
        if (Date.now() >= deadline) return { awaiting: 'timeout', mailboxPeerId: peerId, note: 'await-inbox reached its deadline; no new item arrived. This is not a failure.' };
        await new Promise(resolve => {
          const timer = setTimeout(() => { watcher.close(); resolve(); }, Math.min(10000, Math.max(0, deadline - Date.now())));
          const watcher = watch(directory, () => { clearTimeout(timer); watcher.close(); resolve(); });
          watcher.on('error', () => { clearTimeout(timer); watcher.close(); resolve(); });
        });
      }
    };
    switch (command) {
      case 'feedback-pending':
        result = feedback.pendingFeedback((await loadConfig(values.config)).configFile);
        break;
      case 'feedback-organize':
        result = feedback.organizeFeedback((await loadConfig(values.config)).configFile, {
          id: values.id, through: number('through'), todo: values.todo,
          message: values['message-file'] ? await readFile(values['message-file'], 'utf8') : undefined,
        });
        break;
      case 'feedback-todos':
        result = feedback.feedbackTodos((await loadConfig(values.config)).configFile);
        break;
      case 'cleanup': result = await (await import('./cleanup-command.mjs')).cleanupCommand(positionals[1],values); break;
      case 'register-peer': result = await (await peers()).register({ peerId: values['peer-id'], kind: values.kind, workspace: values.workspace, threadId: values['codex-thread-id'], agentId: values['agent-id'], label: values.label }); break;
      case 'list-peers': result = await (await peers()).list({ workspace: values.workspace }); break;
      case 'inbox': result = await (await peers()).inbox({ peerId: values['peer-id'], state: values.state }); break;
      case 'unregister-peer': result = await (await peers()).unregister({ peerId: values['peer-id'] }); break;
      case 'archive-peer': result = await (await peers()).archive({ peerId: values['peer-id'], archived: values.archived === undefined ? true : values.archived !== 'false' }); break;
      case 'send-peer': result = await (await peers()).send({ fromPeerId: values['from-peer-id'], toPeerId: values['to-peer-id'], message: await messageText(), requestId: values['request-id'], parentExchangeId: values['parent-exchange-id'] }); break;
      case 'read-exchange': result = await (await peers()).read({ exchangeId: values['exchange-id'], timeoutSeconds: number('timeout-seconds') ?? 0, peerId: values['peer-id'] }); break;
      case 'await-exchange': result = await awaitExchange(); break;
      case 'await-agent': result = await awaitAgent(); break;
      case 'await-inbox': result = await awaitInbox(); break;
      case 'reply-exchange': result = await (await peers()).reply({ exchangeId: values['exchange-id'], peerId: values['peer-id'], message: await messageText(), requestId: values['request-id'] }); break;
      case 'spawn-agent': result = await (await agents()).spawn({ workspace: values.workspace, projectWorkspace: values['project-workspace'],
        projectName: values['project-name'], message: values['message-file'] ? await readFile(values['message-file'], 'utf8') : values.message,
        taskName: values['task-name'], requestId: values['request-id'], provider: values.provider, model: values.model, reasoningEffort: values['reasoning-effort'],
        agentPreset: values['agent-preset'], codexThreadId: values['codex-thread-id'] }); break;
      case 'followup-agent': result = await (await agents()).followup({ agentId: values['agent-id'], message: values['message-file'] ? await readFile(values['message-file'], 'utf8') : values.message, requestId: values['request-id'] }); break;
      case 'wait-agent': result = await (await agents()).wait({ agentId: values['agent-id'], requestId: values['request-id'], timeoutSeconds: number('timeout-seconds') ?? 0, maxMessages: number('max-messages') }); break;
      case 'cancel-agent': result = await (await agents()).cancel({ agentId: values['agent-id'], requestId: values['request-id'] }); break;
      case 'list-agents': result = await (await agents()).list({ workspace: values.workspace }); break;
      case 'profiles': result = await listProfiles(values.config, values.profile); break;
      case 'desktop-config': { const config = await loadConfig(values.config, values.profile); result = { dataRoot: config.dshDataRoot }; break; }
      case 'profile-create': result = await createProfile({ profile: values.profile, workspace: values.workspace, futureaideSessionId: values['session-id'], codexThreadId: values['codex-thread-id'] }, values.config); break;
      case 'status': result = await control.status(); break;
      case 'connect': result = await control.connect({ requestId: values['request-id'] }); break;
      case 'sessions': result = await control.sessions({ query: values.query, limit: number('limit') }); break;
      case 'read': result = await control.read({ sessionId, maxMessages: number('max-messages'), throughSeq: number('through-seq'), view: values.view }); break;
      case 'send': {
        const message = values['message-file'] ? await readFile(values['message-file'], 'utf8') : values.message;
        result = await control.send({ sessionId, message, requestId: values['request-id'], mode: values.mode, background: values.background === true });
        break;
      }
      case 'wait': {
        if (isScopedWait) {
          const [{ createScopedAgents }, { TRUSTED_CALLER, ownerIdFor }] = await Promise.all([
            import('./scoped-agents.mjs'),
            import('./calling-context.mjs'),
          ]);
          const config = await loadScopedCliConfig();
          const roleOptions = { teamConfigPath: (managed && process.env.FUTUREAIDE_ROLES_CONFIG?.trim()) || config.teamConfigPath };
          const scoped = createScopedAgents(config, roleOptions);
          const keepAlive = setInterval(() => {}, 30000);
          try {
            const convId = (values.conv || values.conversation || process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
            if (!managed && !convId) throw new Error('wait needs --conv <convId> (or --conversation / ANTIGRAVITY_CONVERSATION_ID).');
            const names = values.names ? values.names.split(',').map(s => s.trim()).filter(Boolean) : undefined;
            const rawKeys = values.keys ?? values['task-keys'];
            const taskKeys = rawKeys ? rawKeys.split(',').map(s => s.trim()).filter(Boolean) : undefined;
            const multiTarget = (taskKeys?.length ?? 0) > 1 || (names?.length ?? 0) > 1;
            const effectiveBarrier = values.barrier ?? (multiTarget ? 'all' : 'any');
            const timeoutSec = values.timeout !== undefined ? number('timeout') : (number('timeout-seconds') ?? 3600);
            const callerExtra = managed
              ? { [TRUSTED_CALLER]: authorizeManagedTool(scoped.store, verifyManagedCaller(scoped.store, managedBinding),
                'futureaide_wait_agents', { names, taskKeys }, roleOptions) }
              : convId.startsWith('owner-')
              ? {
                [TRUSTED_CALLER]: {
                  source: 'managed-cli',
                  ownerId: convId,
                  workspace: values.workspace || config.workspace,
                },
              }
              : (/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(convId) && scoped.store.owner(ownerIdFor(convId)))
                ? { _meta: { threadId: convId } }
                : {
                  [TRUSTED_CALLER]: {
                    source: 'antigravity',
                    conversationId: convId,
                    workspace: values.workspace || config.workspace,
                  },
                };
            const rawWait = await scoped.wait({
              ...(names?.length ? { names } : {}),
              ...(taskKeys?.length ? { taskKeys } : {}),
              ...(values.after ? { after: values.after } : {}),
              barrier: effectiveBarrier,
              timeoutSeconds: timeoutSec,
              allowExtendedTimeout: true,
            }, callerExtra);
            await scoped.flushSettlements();
            if (values.raw) {
              result = rawWait;
            } else {
              const events = Array.isArray(rawWait.events) ? rawWait.events : [];
              const questions = [];
              const results = [];
              const seenResultKeys = new Set();
              for (const evt of events) {
                if (!evt) continue;
                if (evt.type === 'question') {
                  questions.push({
                    ...(evt.name ? { name: evt.name } : {}),
                    ...(evt.role ? { role: evt.role } : {}),
                    ...(evt.taskKey ? { taskKey: evt.taskKey } : {}),
                    message: evt.message ?? '',
                    ...((evt.questionId ?? evt.submissionId) ? { questionId: evt.questionId ?? evt.submissionId } : {}),
                  });
                } else if (evt.type === 'final' || evt.type === 'delivered' || evt.type === 'report') {
                  results.push({
                    ...(evt.name ? { name: evt.name } : {}),
                    ...(evt.role ? { role: evt.role } : {}),
                    ...(evt.taskKey ? { taskKey: evt.taskKey } : {}),
                    type: evt.type,
                    final: evt.final === true,
                    message: evt.message ?? '',
                  });
                  if (evt.taskKey) seenResultKeys.add(evt.taskKey);
                  if (evt.name) seenResultKeys.add(`name:${evt.name}`);
                } else if (evt.type === 'failed' || evt.type === 'cancelled') {
                  const dup = (evt.taskKey && seenResultKeys.has(evt.taskKey))
                    || (evt.name && seenResultKeys.has(`name:${evt.name}`));
                  if (!dup) {
                    results.push({
                      ...(evt.name ? { name: evt.name } : {}),
                      ...(evt.taskKey ? { taskKey: evt.taskKey } : {}),
                      type: evt.type,
                      final: true,
                      ...(evt.reason ? { error: evt.reason } : {}),
                    });
                  }
                }
              }
              if (!questions.length) {
                for (const item of rawWait.items ?? []) {
                  for (const q of item.questions ?? []) {
                    if (q?.message) {
                      questions.push({
                        name: item.name,
                        ...(item.role ? { role: item.role } : {}),
                        message: q.message,
                        ...(q.id ? { questionId: q.id } : {}),
                      });
                    }
                  }
                }
              }
              if (!results.length && !questions.length) {
                for (const item of rawWait.items ?? []) {
                  results.push({
                    name: item.name,
                    ...(item.role ? { role: item.role } : {}),
                    state: item.state,
                    ...(item.state === 'running' && item.activity ? { activity: item.activity } : {}),
                    ...(item.stalled ? { stalled: true } : {}),
                    ...(item.error ? { error: item.error } : {}),
                  });
                }
              }
              const timedOut = rawWait.timedOut === true;
              const notListed = Array.isArray(rawWait.notListed) && rawWait.notListed.length ? rawWait.notListed : undefined;
              const anyStillRunning = (rawWait.items ?? []).some(item => item.state === 'running')
                && !results.some(r => r.final === true) && !events.length;
              const allResultsFinal = results.length > 0 && results.every(r => r.final === true);
              const done = !timedOut && questions.length === 0 && !notListed && !anyStillRunning
                && (effectiveBarrier === 'all' ? rawWait.reason === 'event' || allResultsFinal : allResultsFinal);
              const legacyVerboseFlags = Boolean((values.conversation || values['task-keys']) && !values.conv && !values.keys);
              result = {
                done,
                results,
                ...(questions.length ? { questions } : {}),
                ...(notListed ? { notListed } : {}),
                timedOut,
                ...(legacyVerboseFlags ? {
                  reason: rawWait.reason,
                  events,
                  ...(rawWait.nextCursor ? { nextCursor: rawWait.nextCursor } : {}),
                } : {}),
              };
            }
          } finally {
            clearInterval(keepAlive);
            scoped.close();
          }
        } else {
          result = await control.wait({ sessionId, requestId: values['request-id'], afterSeq: number('after-seq'),
            timeoutSeconds: number('timeout-seconds'), pollIntervalMs: number('poll-interval-ms'), maxMessages: number('max-messages') });
        }
        break;
      }
      case 'proxy': {
        const { createScopedAgents } = await import('./scoped-agents.mjs');
        const config = await loadConfig(values.config, values.profile);
        const scoped = createScopedAgents(config);
        try {
          const sub = positionals[1] || 'status';
          if (sub === 'status') {
            const target = values.target || positionals[2] || 'all';
            result = await scoped.manageCliProxy({ action: 'status', target });
          } else if (sub === 'bind') {
            const target = values.target || positionals[2];
            const proxyVal = values.proxy ?? positionals[3];
            if (!target || proxyVal === undefined) {
              throw new Error('Usage: proxy bind <codex-cli|claude-cli|agy-cli|all> <port|url|faswitch|direct>');
            }
            result = await scoped.manageCliProxy({ action: 'bind', target, proxy: proxyVal });
          } else {
            throw new Error('Unknown proxy action. Use: proxy status | proxy bind <target> <value>');
          }
        } finally {
          scoped.close();
        }
        break;
      }
      case 'board-post':
      case 'team':
      case 'board': {
        const [{ createScopedAgents }, { TRUSTED_CALLER, ownerIdFor }] = await Promise.all([
          import('./scoped-agents.mjs'),
          import('./calling-context.mjs'),
        ]);
        const config = await loadScopedCliConfig();
        const roleOptions = { teamConfigPath: (managed && process.env.FUTUREAIDE_ROLES_CONFIG?.trim()) || config.teamConfigPath };
        const scoped = createScopedAgents(config, roleOptions);
        const keepAlive = setInterval(() => {}, 30000);
        try {
          const ws = path.resolve(values.workspace || config.workspace || process.cwd());
          const normWs = process.platform === 'win32' ? ws.toLowerCase() : ws;
          const sameWs = candidate => {
            if (typeof candidate !== 'string' || !candidate) return false;
            const resolved = path.resolve(candidate);
            return (process.platform === 'win32' ? resolved.toLowerCase() : resolved) === normWs;
          };
          const extraFromOwnerId = targetOwnerId => {
            const existingOwner = scoped.store.owner(targetOwnerId);
            if (existingOwner?.source === 'antigravity' && existingOwner.conversationId) {
              return {
                [TRUSTED_CALLER]: {
                  source: 'antigravity',
                  conversationId: existingOwner.conversationId,
                  workspace: existingOwner.workspace || ws,
                },
              };
            }
            if (existingOwner?.source === 'codex-desktop' && existingOwner.threadId) {
              return { _meta: { threadId: existingOwner.threadId } };
            }
            return {
              [TRUSTED_CALLER]: {
                source: 'managed-cli',
                ownerId: targetOwnerId,
                workspace: existingOwner?.workspace || ws,
              },
            };
          };
          const resolveCanvasCallerExtra = () => {
            const explicitOwner = (values.owner || '').trim();
            if (explicitOwner) {
              return explicitOwner.startsWith('owner-')
                ? extraFromOwnerId(explicitOwner)
                : { [TRUSTED_CALLER]: { source: 'antigravity', conversationId: explicitOwner, workspace: ws } };
            }
            const explicitConv = (values.conv || values.conversation || process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
            if (explicitConv) {
              if (explicitConv.startsWith('managed-cli:')) throw deny('Managed callers must supply their active dispatch binding.');
              if (explicitConv.startsWith('owner-')) return extraFromOwnerId(explicitConv);
              if (/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(explicitConv)
                  && scoped.store.owner(ownerIdFor(explicitConv))) {
                return { _meta: { threadId: explicitConv } };
              }
              return { [TRUSTED_CALLER]: { source: 'antigravity', conversationId: explicitConv, workspace: ws } };
            }
            // Auto-detect latest active owner in this workspace so Canvas UI buttons work out-of-the-box
            const openRecords = scoped.store.list().filter(r => r && !r.closed && sameWs(r.rootWorkspace ?? r.workspace ?? ''));
            if (openRecords.length > 0) {
              const rank = r => (['running', 'awaiting_input', 'awaiting_report', 'idle'].includes(r.state) ? 1 : 0);
              openRecords.sort((a, b) => rank(b) - rank(a)
                || (Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0) - (Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0));
              let top = openRecords[0];
              const seen = new Set();
              while (top?.parentAgentId && !seen.has(top.agentId)) {
                seen.add(top.agentId);
                const p = scoped.store.get(top.parentAgentId);
                if (!p) break;
                top = p;
              }
              if (top?.ownerId) return extraFromOwnerId(top.ownerId);
            }
            const wsOwners = scoped.store.listOwners()
              .filter(o => o?.ownerId && sameWs(o.workspace ?? ''))
              .sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0));
            if (wsOwners[0]?.ownerId) return extraFromOwnerId(wsOwners[0].ownerId);
            const canvasConvId = 'canvas-' + createHash('sha256').update(normWs).digest('hex').slice(0, 12);
            return {
              [TRUSTED_CALLER]: {
                source: 'antigravity',
                conversationId: canvasConvId,
                workspace: ws,
              },
            };
          };

          const managedCaller = managed ? verifyManagedCaller(scoped.store, managedBinding) : undefined;
          const callerExtra = managedCaller ? { [TRUSTED_CALLER]: managedCaller } : resolveCanvasCallerExtra();
          const forTool = (tool, args) => managedCaller
            ? { [TRUSTED_CALLER]: authorizeManagedTool(scoped.store, managedCaller, tool, args, roleOptions) } : callerExtra;
          if (!managedCaller && ['board', 'board-post'].includes(command) && values.urgent === true) {
            const conversation = (values.conv || values.conversation || process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
            if (values.owner || !conversation || conversation.startsWith('managed-cli:')
                || !(scoped.store.owner(ownerIdFor(conversation)) || scoped.store.owner(ownerIdForSource('antigravity', conversation)))) {
              throw deny('An urgent CLI board post requires the current team conversation.');
            }
          }
          if (command === 'team') {
            const subAction = positionals[1];
            if (!subAction) {
              throw new Error('Usage: team <adopt|kick|merge|reparent|resume|strays|sweep> [target] [--parent <p>] [--kill-tree] [--message <msg>]');
            }
            const positionalTarget = positionals[2];
            const effectiveTarget = values.target ?? values.name ?? positionalTarget;
            const rawParent = values.parent ?? values['reparent-to'];
            const parsedParent = rawParent === undefined
              ? undefined
              : (['null', 'none', 'root'].includes(rawParent.trim().toLowerCase()) ? null : rawParent.trim());
            const keepChildren = values['kill-tree'] === true
              ? false
              : (values['keep-children'] !== undefined ? values['keep-children'] !== 'false' : undefined);
            const msg = await messageText();
            if (subAction === 'answer') {
              if (!effectiveTarget || !msg) throw new Error('team answer requires --target <name> and --message <text>.');
              const questionIds = normalizeQuestionIds({ questionIds: values['question-id'] });
              const args = { name: effectiveTarget, message: msg, ...(questionIds ? { questionIds } : {}) };
              result = { ok: true, action: 'answer', ...(await scoped.answer(args, forTool('futureaide_answer_agent', args))) };
            } else if (subAction === 'run' || subAction === 'create') {
              const args = {
                name: values.name ?? positionalTarget, role: values.role, target: values.target,
                lifetime: values.lifetime ?? (subAction === 'create' ? 'once' : undefined),
                ...(subAction === 'run' && msg !== undefined ? { message: msg } : {}),
                ...(values.worktree !== undefined ? { worktree: values.worktree } : {}),
                ...(values['base-sha'] !== undefined ? { baseSha: values['base-sha'] } : {}),
              };
              result = await scoped[subAction](args, forTool('futureaide_' + subAction + '_agent', args));
            } else if (subAction === 'delete') {
              const args = { name: effectiveTarget, discardWorktree: values['discard-worktree'] };
              result = await scoped.delete(args, forTool('futureaide_delete_agent', args));
            } else {
              const args = {
                action: subAction,
                ...(effectiveTarget !== undefined ? { target: effectiveTarget } : {}),
                ...(parsedParent !== undefined ? { parent: parsedParent } : {}),
                ...(keepChildren !== undefined ? { keepChildren } : {}),
                ...(msg !== undefined ? { message: msg } : {}),
                ...(values['discard-worktree'] !== undefined ? { discardWorktree: values['discard-worktree'] } : {}),
              };
              result = await scoped.manageTeam(args, forTool('futureaide_team', args));
            }
          } else {
            const subAction = command === 'board-post' ? 'post' : (positionals[1] || 'read').toLowerCase();
            if (subAction === 'post') {
              const msg = (await messageText()) ?? positionals.slice(command === 'board-post' ? 1 : 2).join(' ').trim();
              if (!msg) throw new Error('board post requires a message (via positional argument or --message).');
              const args = {
                message: msg,
                ...(!managedCaller && values.author ? { author: values.author } : {}),
                ...(values.urgent === true ? { urgent: true } : {}),
              };
              result = await scoped.postBoard(args, forTool('futureaide_board_post', args));
            } else if (subAction === 'read') {
              result = await scoped.readBoard({
                ...(values.limit !== undefined ? { limit: number('limit') } : {}),
                ...(values['after-seq'] !== undefined ? { afterSeq: number('after-seq') } : {}),
              }, forTool('futureaide_board_read', {}));
            } else {
              throw new Error('Unknown board action. Use: board post <message> | board read');
            }
          }
          await scoped.flushSettlements();
        } finally {
          clearInterval(keepAlive);
          scoped.close();
        }
        break;
      }
      case 'watch': result = await control.watch({ sessionId, requestId: values['request-id'], afterSeq: number('after-seq'),
        timeoutSeconds: number('timeout-seconds'), pollIntervalMs: number('poll-interval-ms'), maxMessages: number('max-messages') }); break;
      case 'cancel': result = await control.cancel({ sessionId, requestId: values['request-id'] }); break;
      case 'models': result = await control.models(); break;
      case 'create-session': result = await control.createSession({ requestId: values['request-id'], agentPreset: values['agent-preset'] }); break;
      case 'attach-session': result = await control.attachSession({ sessionId, requestId: values['request-id'] }); break;
      case 'select-model': result = await control.selectModel({ sessionId, provider: values.provider, model: values.model, reasoningEffort: values['reasoning-effort'], requestId: values['request-id'] }); break;
      case 'capabilities': result = await control.capabilities({ sessionId, toolName: values['tool-name'], activate: !values['no-activate'] }); break;
      case 'host-install': result = await installHostBridge(await loadConfig(values.config, values.profile)); break;
      case 'desktop-host-install': result = await installDesktopHostBridge(await loadConfig(values.config, values.profile), values['host-profile-directory'], { refresh: values.refresh === true, rebind: values.rebind === true }); break;
      case 'host-status': result = await control.hostStatus(); break;
      case 'notify': result = await control.notify({ event: values.event, summary: values.summary, evidence: values.evidence }); break;
      case 'codex-status': result = await control.codexStatus(); break;
      default: throw new Error('Unknown command. Use --help.');
    }
    console.log(command.startsWith('feedback-') ? JSON.stringify(result, null, 2) : boundedOutput(result));
    if (result?.error || result?.connected === false || result?.ready === false || result?.available === false || (result?.duplicate && !result?.delivered && !result?.accepted)) process.exitCode = 1;
  } catch (error) {
    const feedbackError = positionals[0]?.startsWith('feedback-');
    console.error(JSON.stringify(feedbackError ? { code: 'feedback-command-failed',
      message: 'Check the feedback ID, reviewed count, todo key, summary file and local inbox access.' } : { ...errorResult(error),
      ...(typeof error.code === 'string' ? { code: error.code } : {}) }, null, 2));
    process.exitCode = 1;
  }
}
