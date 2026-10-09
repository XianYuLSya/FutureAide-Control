// Detached completion watcher: polls one DSH session until the dispatched turn ends,
// then writes the reply to the report file so the main agent never blocks on it.
// Launched by control.send({ background: true }) and intentionally outlives that call.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FutureAideClient } from './futureaide-api.mjs';
import { briefSession, historyMessages } from './control.mjs';
import { readDispatch } from './dispatch.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = String(process.argv[index]).replace(/^--/, '');
  if (process.argv[index + 1] === undefined) continue;
  args.set(key, process.argv[index + 1]);
}

const session = args.get('session');
const workspace = args.get('workspace');
const stateDirectory = args.get('state');
const requestId = args.get('request');
const afterSeq = Number(args.get('after-seq') ?? -1);
const pollMs = Math.max(2000, Number(args.get('poll') ?? 5000));
const maxMinutes = Math.max(1, Number(args.get('max-minutes') ?? 360));

if (!session || !stateDirectory || !requestId || !workspace) {
  console.error('watch-worker: --session, --workspace, --state and --request are required.');
  process.exit(2);
}
const reportFile = path.join(stateDirectory, 'reports', `${session}.${requestId}.json`);
const write = async payload => {
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
};

const client = new FutureAideClient({
  dataHome: args.get('data-root') || undefined,
  dshDataHome: args.get('dsh-data-root') || undefined,
  target: args.get('target') || undefined,
  instanceFile: args.get('instance-file') || undefined,
  preferredInstanceFile: args.get('preferred-instance-file') || undefined,
  hostBridgeFile: args.get('host-bridge-file') || undefined,
  timeoutMs: args.has('timeout-ms') ? Number(args.get('timeout-ms')) : undefined,
  baseUrl: args.get('base-url') || undefined,
});

const deadline = Date.now() + maxMinutes * 60000;
let lastError;

for (;;) {
  try {
    const row = (await client.listSessions()).items.find(item => item.sessionId === session);
    if (!row) throw new Error('The session is not listed by the host.');
    const dispatch = await readDispatch(client, session, { maxMessages: 40, workspace, requestId, afterSeq });
    if (dispatch.ended) {
      const payload = historyMessages(dispatch.page, row);
      const messages = (payload.messages ?? [])
        .filter(message => Number.isSafeInteger(message.seq) && message.seq > afterSeq);
      await write({ state: 'ended', sessionId: session, requestId, afterSeq,
        correlation: dispatch.boundary.correlation, endSeq: dispatch.boundary.endSeq, completionReason: dispatch.boundary.completionReason,
        session: briefSession(row), running: Boolean(row.running), lastEventType: payload.lastEventType,
        messages, storedAt: new Date().toISOString(), source: 'detached-watch' });
      process.exit(0);
    }
  } catch (error) {
    lastError = error;
  }
  if (Date.now() >= deadline) break;
  await new Promise(resolve => setTimeout(resolve, pollMs));
}

await write({ state: 'timeout', sessionId: session, requestId, afterSeq, gaveUpAt: new Date().toISOString(),
  lastError: lastError?.message, source: 'detached-watch' }).catch(() => {});
process.exit(0);
