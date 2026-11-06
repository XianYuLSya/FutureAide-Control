#!/usr/bin/env node
// Stand-in for the Claude Code CLI, for tests and for dry runs that must not touch a
// real model. It speaks the same print-mode contract the runner uses: argv in, prompt on
// stdin, one JSON object per line on stdout.
//
// Run it by hand, exactly like the real thing:
//   node fixtures/claude-cli.mjs -p --output-format stream-json --verbose \
//     --session-id 11111111-2222-4333-8444-555555555555 --permission-mode auto \
//     --permission-prompts none --mcp-config <file> --allowedTools <tools> < prompt.txt
//
// It is also used as a CLI stub through the runner's `cli` seam:
//   startClaudeTurn({ cli: { command: process.execPath, prefixArgs: [thisFile] }, ... })
//
// Scenarios (env FAKE_CLAUDE_SCENARIO, default "ok"):
//   ok            init, question via ask_parent, final text, successful result
//   denied        a tool call refused by permissions, denials in history and result
//   mcp-failed    --mcp-config entry rejected, required server absent
//   no-result     exits 0 without ever printing a result event
//   crash         exits non-zero with stderr only, before init
//   permission-rejected  exits non-zero saying --permission-mode auto is invalid
//   hang          init only, then stays alive until killed (cancel tests)
//   echo          reports the exact argv, stdin and mcp config it received
//   no-init       never prints system/init, only an assistant message and a result
//   no-newline    ends with a result line that has no trailing newline
//   large         one assistant message bigger than a 4 MB read, then a result
//   permission-downgraded   init reports a permission mode other than auto
//   auto-unavailable-json   the auto flag refusal arrives as a JSON result, exit 0
//   result-error  an error result with errors[] and a non-zero exit code
//
// Optional env:
//   FAKE_CLAUDE_RECEIPT_DIR  directory for fake-claude-receipt.json (what it saw) and
//                            fake-claude-spawns.log (one line per CLI start)
//   FAKE_CLAUDE_DELAY_MS     delay between emitted lines (default 5)
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 5);
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'ok';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));

function flagValue(...names) {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index >= 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) return argv[index + 1];
    const inline = argv.find(value => value.startsWith(name + '='));
    if (inline) return inline.slice(name.length + 1);
  }
  return undefined;
}

const sessionId = flagValue('--session-id') ?? flagValue('--resume') ?? '00000000-0000-4000-8000-000000000000';
const resume = argv.includes('--resume') || argv.some(value => value.startsWith('--resume='));
const model = flagValue('--model') ?? 'claude-fixture-default';
const effort = flagValue('--effort');
const permissionMode = flagValue('--permission-mode') ?? 'default';
const permissionPrompts = flagValue('--permission-prompts') ?? 'host';
const systemPrompt = flagValue('--append-system-prompt') ?? '';
const allowedTools = flagValue('--allowedTools', '--allowed-tools') ?? '';
const mcpFile = flagValue('--mcp-config');
const displayName = flagValue('--name', '-n') ?? null;

// The prompt arrives on stdin; a real turn cannot start until the input closes.
const prompt = await new Promise(resolve => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', () => resolve(data));
});

let mcpConfig;
if (mcpFile) {
  try { mcpConfig = JSON.parse(await readFile(mcpFile, 'utf8')); }
  catch (error) { mcpConfig = { error: String(error?.message ?? error) }; }
}
const mcpServerNames = Object.keys(mcpConfig?.mcpServers ?? {});

const receipt = { argv, sessionId, resume, model, effort: effort ?? null, permissionMode, permissionPrompts,
  allowedTools, systemPrompt, prompt, mcpFile: mcpFile ?? null, mcpServerNames, displayName, scenario };
if (process.env.FAKE_CLAUDE_RECEIPT_DIR) {
  await mkdir(process.env.FAKE_CLAUDE_RECEIPT_DIR, { recursive: true });
  await writeFile(path.join(process.env.FAKE_CLAUDE_RECEIPT_DIR, 'fake-claude-receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n');
  // One line per CLI start, so a test can prove a duplicate dispatch really did not spawn twice.
  await appendFile(path.join(process.env.FAKE_CLAUDE_RECEIPT_DIR, 'fake-claude-spawns.log'),
    process.pid + ' ' + new Date().toISOString() + ' ' + scenario + '\n');
}

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
// One non-JSON line, like the progress output the real CLI prints before its events.
const noise = () => process.stdout.write('starting up\n');

function init({ mcpServers = mcpServerNames.map(name => ({ name, status: 'connected' })), mcpServerErrors,
  mode = permissionMode } = {}) {
  emit({
    type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId,
    tools: ['Read', 'Bash', 'Edit'], model, permissionMode: mode,
    ...(mcpServers ? { mcp_servers: mcpServers } : {}),
    ...(mcpServerErrors ? { mcp_server_errors: mcpServerErrors } : {}),
  });
}

function assistantText(text) {
  emit({ type: 'assistant', session_id: sessionId,
    message: { id: 'msg_' + Math.random().toString(36).slice(2), role: 'assistant', model,
      content: [{ type: 'text', text }] } });
}

function toolUse(name, id, input = {}) {
  emit({ type: 'assistant', session_id: sessionId,
    message: { id: 'msg_' + Math.random().toString(36).slice(2), role: 'assistant', model,
      content: [{ type: 'tool_use', id, name, input }] } });
}

function toolResult(toolUseId, content, isError = false) {
  emit({ type: 'user', session_id: sessionId,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId,
      content: isError ? [{ type: 'text', text: content }] : content, ...(isError ? { is_error: true } : {}) }] } });
}

function result({ subtype = 'success', isError = false, text = 'done', denials, errors, turns = 2 } = {}) {
  emit({ type: 'result', subtype, is_error: isError, session_id: sessionId, duration_ms: 42,
    duration_api_ms: 30, num_turns: turns, result: text, total_cost_usd: 0.0123,
    stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 },
    ...(denials ? { permission_denials: denials } : {}),
    ...(errors ? { errors } : {}) });
}

switch (scenario) {
  case 'ok': {
    init();
    await sleep(delayMs);
    noise();
    assistantText('Working on it.');
    await sleep(delayMs);
    toolUse('mcp__futureaide__ask_parent', 'toolu_ask_1', { question: 'Which branch?' });
    await sleep(delayMs);
    toolResult('toolu_ask_1', [{ type: 'text', text: 'Use main.' }]);
    await sleep(delayMs);
    assistantText('Finished the task.');
    await sleep(delayMs);
    result({ text: 'Finished the task.' });
    break;
  }
  case 'denied': {
    init();
    await sleep(delayMs);
    toolUse('Bash', 'toolu_bash_1', { command: 'rm -rf /' });
    await sleep(delayMs);
    toolResult('toolu_bash_1', 'Permission to use Bash has been denied.', true);
    await sleep(delayMs);
    assistantText('I could not run the shell command, so I stopped.');
    await sleep(delayMs);
    result({ text: 'I could not run the shell command, so I stopped.',
      denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_bash_1', tool_input: { command: 'rm -rf /' } }] });
    break;
  }
  case 'mcp-failed': {
    init({ mcpServers: [], mcpServerErrors: [{ name: 'futureaide', type: 'invalid_config', message: 'missing command' }] });
    await sleep(delayMs);
    assistantText('Working without callbacks.');
    await sleep(delayMs);
    result({ text: 'Working without callbacks.' });
    break;
  }
  case 'no-result': {
    init();
    await sleep(delayMs);
    assistantText('I forgot to report.');
    break;
  }
  case 'crash': {
    process.stderr.write('boom: the CLI could not start\n');
    process.exitCode = 3;
    break;
  }
  case 'permission-rejected': {
    process.stderr.write("error: option '--permission-mode <mode>' argument 'auto' is invalid\n");
    process.exitCode = 2;
    break;
  }
  case 'hang': {
    init();
    await sleep(delayMs);
    assistantText('Waiting forever.');
    // Stays alive until the test kills the tree.
    setInterval(() => {}, 1000);
    await sleep(120000);
    break;
  }
  case 'echo': {
    init();
    await sleep(delayMs);
    assistantText(JSON.stringify(receipt));
    await sleep(delayMs);
    result({ text: 'echoed' });
    break;
  }
  case 'no-init': {
    // No system/init at all: the runner must not report a requested model as if it ran.
    assistantText('No init event was printed.');
    await sleep(delayMs);
    result({ text: 'no init' });
    break;
  }
  case 'no-newline': {
    init();
    await sleep(delayMs);
    assistantText('almost done');
    await sleep(delayMs);
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      session_id: sessionId, num_turns: 1, result: 'unterminated result line' }));
    break;
  }
  case 'large': {
    init();
    await sleep(delayMs);
    assistantText('x'.repeat(5 * 1024 * 1024));
    await sleep(delayMs);
    result({ text: 'large done' });
    break;
  }
  case 'permission-downgraded': {
    // The CLI starts in a wider-less mode than the auto mode that was requested.
    init({ mode: 'acceptEdits' });
    await sleep(delayMs);
    assistantText('Running with a different permission mode.');
    await sleep(delayMs);
    result({ text: 'ran anyway' });
    break;
  }
  case 'auto-unavailable-json': {
    // The refusal arrives as ordinary JSON on stdout with a zero exit, not on stderr.
    init();
    await sleep(delayMs);
    result({ subtype: 'error_during_execution', isError: true,
      text: "error: option '--permission-mode <mode>' argument 'auto' is not supported by this build" });
    break;
  }
  case 'result-error': {
    init();
    await sleep(delayMs);
    assistantText('The command failed.');
    await sleep(delayMs);
    result({ subtype: 'error_during_execution', isError: true, text: 'the workspace could not be written',
      errors: ['EACCES: permission denied, open D:\\\\w\\\\a.txt'] });
    process.exitCode = 4;
    break;
  }
  default: {
    process.stderr.write('unknown FAKE_CLAUDE_SCENARIO ' + JSON.stringify(scenario) + '\n');
    process.exitCode = 2;
  }
}
