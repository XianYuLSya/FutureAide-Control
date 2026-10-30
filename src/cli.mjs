import { mkdir, readFile, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createProfile, listProfiles, loadConfig } from './config.mjs';
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
    'timeout-seconds': { type: 'string' }, 'poll-interval-ms': { type: 'string' }, 'after-seq': { type: 'string' },
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
    help: { type: 'boolean', short: 'h' },
  },
});

const usage = `futureaide-control <connect|status|sessions|read|send|wait|watch|cancel|models|notify|codex-status|profiles|profile-create|create-session|select-model|capabilities|host-install|host-status>
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
  profiles [--profile NAME]
  profile-create --profile NAME --workspace ABSOLUTE_PATH [--session-id ID] [--codex-thread-id ID]
  sessions --query TEXT --limit 20
  read --max-messages 8 [--through-seq N] [--view messages|events]
  send --message-file PATH --request-id UNIQUE-ID [--mode queue|steer]
  wait --request-id SEND-REQUEST-ID [--timeout-seconds 45] [--poll-interval-ms 1500] [--max-messages 8]
                            Block until that dispatched turn ends and print its reply; re-run while state is running
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
    values.config = await maintenanceConfigPath(values.config, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const control = ['profiles', 'profile-create'].includes(command) ? undefined : createControl(await loadConfig(values.config, values.profile));
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
      case 'wait': result = await control.wait({ sessionId, requestId: values['request-id'], afterSeq: number('after-seq'),
        timeoutSeconds: number('timeout-seconds'), pollIntervalMs: number('poll-interval-ms'), maxMessages: number('max-messages') }); break;
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
    console.log(boundedOutput(result));
    if (result?.error || result?.connected === false || result?.ready === false || result?.available === false || (result?.duplicate && !result?.delivered && !result?.accepted)) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify(errorResult(error), null, 2));
    process.exitCode = 1;
  }
}
