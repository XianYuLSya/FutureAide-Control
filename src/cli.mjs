import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createProfile, listProfiles, loadConfig } from './config.mjs';
import { boundedOutput, createControl, errorResult } from './control.mjs';
import { installDesktopHostBridge, installHostBridge } from './host-install.mjs';
import { createAgents } from './agents.mjs';

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
    'host-profile-directory': { type: 'string' },
    'agent-id': { type: 'string' }, 'task-name': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const usage = `futureaide-control <connect|status|sessions|read|send|wait|watch|cancel|models|notify|codex-status|profiles|profile-create|create-session|select-model|capabilities|host-install|host-status>
  spawn-agent --workspace ABSOLUTE_PATH --message TEXT [--task-name NAME] [--request-id ID]
  followup-agent --agent-id ID --message TEXT [--request-id ID]
  wait-agent --agent-id ID [--request-id ID] [--timeout-seconds 0..45]
  cancel-agent --agent-id ID [--request-id ID]
  list-agents [--workspace ABSOLUTE_PATH]
  desktop-host-install --host-profile-directory ABSOLUTE_PATH
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
    switch (command) {
      case 'spawn-agent': result = await (await agents()).spawn({ workspace: values.workspace, message: values['message-file'] ? await readFile(values['message-file'], 'utf8') : values.message,
        taskName: values['task-name'], requestId: values['request-id'], provider: values.provider, model: values.model, reasoningEffort: values['reasoning-effort'], agentPreset: values['agent-preset'] }); break;
      case 'followup-agent': result = await (await agents()).followup({ agentId: values['agent-id'], message: values['message-file'] ? await readFile(values['message-file'], 'utf8') : values.message, requestId: values['request-id'] }); break;
      case 'wait-agent': result = await (await agents()).wait({ agentId: values['agent-id'], requestId: values['request-id'], timeoutSeconds: number('timeout-seconds') ?? 0, maxMessages: number('max-messages') }); break;
      case 'cancel-agent': result = await (await agents()).cancel({ agentId: values['agent-id'], requestId: values['request-id'] }); break;
      case 'list-agents': result = await (await agents()).list({ workspace: values.workspace }); break;
      case 'profiles': result = await listProfiles(values.config, values.profile); break;
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
      case 'desktop-host-install': result = await installDesktopHostBridge(await loadConfig(values.config, values.profile), values['host-profile-directory']); break;
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
