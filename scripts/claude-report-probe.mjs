// Real-machine probe for the report surface: does one shared loopback MCP service
// resolve a separate client process to a Claude Desktop session record, and does
// an accepted tool call come back through the MCP protocol?
//
// It never touches the real Claude configuration and never uses a real session:
// a throwaway CLAUDE_CONFIG_DIR holds one synthetic `sessions/<pid>.json` for the
// probe's own child process, written with that process's real Windows start time.
// That makes the whole chain real on this host (netstat -> owning PID -> record ->
// procStart -> accept) while keeping the roster out of it; ownership is a stand-in
// until the shared state machine supplies resolveOwned.
//
//   node scripts/claude-report-probe.mjs                 # HTTP: expect accepted
//   node scripts/claude-report-probe.mjs --tamper        # HTTP control: must be refused
//   node scripts/claude-report-probe.mjs --stdio         # stdio: parent-PID identity
//
// Evidence is written to clean/validation/claude-report-probe/<stamp>/evidence.json
// (this project's clean directory; nothing is deleted anywhere).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createStartTimeCache, processImageName, resolveSessionOwner, tcpOwnerPid } from '../src/claude-caller-identity.mjs';
import { startHttpService } from '../src/claude-report-server.mjs';

const startTimeCache = createStartTimeCache();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

async function liveStartTime(pid) {
  const { stdout } = await new Promise((resolve, reject) => execFile('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr }))));
  return stdout.trim();
}

async function child({ configDir, url, resultFile, tamper }) {
  const sessionId = randomUUID();
  const procStart = await liveStartTime(process.pid);
  const record = {
    pid: process.pid, sessionId, cwd: process.cwd(), entrypoint: 'claude-desktop',
    pidDomain: `win32:${hostname().toLowerCase()}`,
    procStart: tamper ? String(Number(procStart) + 1) : procStart,
    name: 'report surface probe client', status: 'idle', version: 'probe',
  };
  await mkdir(path.join(configDir, 'sessions'), { recursive: true });
  await writeFile(path.join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify(record));
  const result = { pid: process.pid, sessionId, procStart, tamper: Boolean(tamper) };
  const client = new Client({ name: 'claude-report-probe-client', version: '1.0.0' });
  const started = performance.now();
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    result.tools = tools.map(tool => tool.name);
    if (!result.tools.length) {
      // Not an owned session: the service answers with a connected surface that
      // lists nothing, so there is no tool to call and nothing to accept.
      result.accepted = false;
      result.note = 'surface lists no tools';
    } else {
      const call = await client.callTool({ name: 'report_parent', arguments: { message: 'probe final report', final: true } });
      result.accepted = call.isError !== true;
      result.payload = JSON.parse(call.content[0].text);
    }
    result.elapsedMs = Math.round(performance.now() - started);
  } catch (error) {
    result.error = { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 400) };
    result.elapsedMs = Math.round(performance.now() - started);
  } finally {
    await client.close().catch(() => {});
  }
  await writeFile(resultFile, JSON.stringify(result, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  const tamper = argv.includes('--tamper');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(root, 'clean', 'validation', 'claude-report-probe', stamp);
  await mkdir(directory, { recursive: true });
  if (argv.includes('--stdio')) return stdioProbe(directory);

  const configDir = path.join(directory, 'claude-config');
  const resultFile = path.join(directory, 'client.json');
  await mkdir(path.join(configDir, 'sessions'), { recursive: true });

  const identityOptions = { env: { CLAUDE_CONFIG_DIR: configDir }, cache: startTimeCache };
  const calls = [];
  const resolutions = [];
  const service = await startHttpService({
    port: 0,
    resolveOwned: async () => ({
      agentName: 'probe-agent', taskId: 1,
      async ask(input) { calls.push({ kind: 'ask', ...input }); return { accepted: true }; },
      async report(input) { calls.push({ kind: 'report', ...input }); return { accepted: true }; },
    }),
    identity: identityOptions,
    resolveCaller: async ({ socket, serverPort }) => {
      const clientPid = await tcpOwnerPid({ clientPort: socket.remotePort, serverPort });
      const owner = await resolveSessionOwner(clientPid, identityOptions);
      resolutions.push({ clientPort: socket.remotePort, serverPort, clientPid,
        image: clientPid ? await processImageName(clientPid) : null,
        sessionId: owner?.record?.sessionId ?? null, depth: owner?.depth ?? null,
        refusal: owner?.refusal ? { code: owner.refusal.code, chain: owner.refusal.chain } : null });
      if (!owner || owner.refusal) throw Object.assign(new Error(owner?.refusal?.code ?? 'caller-unresolved'), { code: 'caller-unresolved' });
      return { pid: owner.pid, sessionId: owner.record.sessionId, cwd: owner.record.cwd, via: 'pid',
        image: await processImageName(owner.pid) };
    },
    log: message => process.stderr.write(`[probe service] ${message}\n`),
  });

  const childArgv = [fileURLToPath(import.meta.url), '--child', configDir, service.url, resultFile];
  if (tamper) childArgv.push('--tamper');
  const exit = await new Promise(resolve => {
    const spawned = spawn(process.execPath, childArgv, { stdio: 'inherit' });
    spawned.once('exit', code => resolve(code));
  });
  await service.close();

  const clientResult = JSON.parse(await readFile(resultFile, 'utf8'));
  const resolution = resolutions.at(-1) ?? null;
  const evidence = {
    probe: 'claude-report-shared-http-identity', mode: tamper ? 'tamper-control' : 'accepted',
    at: new Date().toISOString(), url: service.url, stats: service.stats,
    child: { pid: clientResult.pid, sessionId: clientResult.sessionId, exitCode: exit },
    resolution,
    identityMatchesChild: resolution?.clientPid === clientResult.pid && resolution?.sessionId === clientResult.sessionId,
    accepted: clientResult.accepted === true,
    calls, client: clientResult,
  };
  const evidenceFile = path.join(directory, 'evidence.json');
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ evidenceFile, mode: evidence.mode, childPid: clientResult.pid,
    resolvedPid: resolution?.clientPid ?? null, sessionId: resolution?.sessionId ?? null,
    refusal: resolution?.refusal?.code ?? null, accepted: evidence.accepted,
    tools: clientResult.tools ?? [], calls: calls.length,
    clientError: clientResult.error ?? null }, null, 2));
  const ok = tamper
    ? !evidence.accepted && Boolean(resolution?.refusal) && (clientResult.tools?.length ?? 0) === 0
    : evidence.accepted && evidence.identityMatchesChild && (clientResult.tools?.length ?? 0) === 2;
  process.exitCode = ok ? 0 : 1;
}

// stdio identity: the server resolves its own parent process. The probe process
// plays the Claude session, writes its own synthetic registry record, and runs the
// real server as a child through the SDK's stdio client transport.
async function stdioProbe(directory) {
  const configDir = path.join(directory, 'claude-config');
  const receiptFile = path.join(directory, 'ownership-calls.jsonl');
  const sessionId = randomUUID();
  const procStart = await liveStartTime(process.pid);
  await mkdir(path.join(configDir, 'sessions'), { recursive: true });
  await writeFile(path.join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd: process.cwd(), entrypoint: 'claude-desktop',
    pidDomain: `win32:${hostname().toLowerCase()}`, procStart, name: 'stdio probe session', status: 'idle',
  }));
  // A stand-in ownership module: the shared state machine replaces it. It records
  // every call so the probe can prove which caller reached it.
  const ownershipFile = path.join(directory, 'ownership.mjs');
  await writeFile(ownershipFile, `import { appendFile } from 'node:fs/promises';
const record = async value => appendFile(process.env.PROBE_RECEIPT, JSON.stringify(value) + '\\n');
export async function resolveOwned(caller) {
  await record({ event: 'resolve', caller });
  return {
    agentName: 'probe-agent', taskId: 1,
    async ask({ message }) { await record({ event: 'ask', message }); return { accepted: true }; },
    async report({ message, final }) { await record({ event: 'report', message, final }); return { accepted: true }; },
  };
}
`);

  const client = new Client({ name: 'claude-report-probe-stdio', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src', 'claude-report-server.mjs'), '--stdio', '--ownership', ownershipFile],
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, PROBE_RECEIPT: receiptFile },
    stderr: 'inherit',
  });
  const result = { pid: process.pid, sessionId };
  const started = performance.now();
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const call = await client.callTool({ name: 'report_parent', arguments: { message: 'stdio probe report', final: true } });
    result.tools = tools.map(tool => tool.name);
    result.accepted = call.isError !== true;
    result.payload = JSON.parse(call.content[0].text);
  } catch (error) {
    result.error = { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 400) };
  } finally {
    result.elapsedMs = Math.round(performance.now() - started);
    await client.close().catch(() => {});
  }
  let ownershipCalls = [];
  try {
    ownershipCalls = (await readFile(receiptFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { ownershipCalls = []; }
  const resolvedCaller = ownershipCalls.find(entry => entry.event === 'resolve')?.caller ?? null;
  const evidence = { probe: 'claude-report-stdio-identity', mode: 'stdio', at: new Date().toISOString(),
    session: { pid: process.pid, sessionId }, resolvedCaller, ownershipCalls, accepted: result.accepted === true, client: result };
  const evidenceFile = path.join(directory, 'evidence.json');
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ evidenceFile, mode: 'stdio', probePid: process.pid,
    resolvedPid: resolvedCaller?.pid ?? null, resolvedSessionId: resolvedCaller?.sessionId ?? null,
    accepted: evidence.accepted, ownershipCalls: ownershipCalls.map(entry => entry.event),
    clientError: result.error ?? null }, null, 2));
  process.exitCode = evidence.accepted && resolvedCaller?.pid === process.pid && resolvedCaller?.sessionId === sessionId ? 0 : 1;
}

if (process.argv[2] === '--child') {
  const [, , , configDir, url, resultFile] = process.argv;
  await child({ configDir, url, resultFile, tamper: process.argv.includes('--tamper') });
} else {
  await main();
}
