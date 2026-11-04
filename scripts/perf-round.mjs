// What one round of the shared monitor costs on a copy of the live roster.
//
//   node scripts/perf-round.mjs --src <src dir> --mode live|sweep|idle --rounds 20 --out out.json
//
// This models the real loop instead of a fixed stub:
//   live  - one round per second: names that owe time-critical work are polled every
//           round, the roster is swept every fifth, and every poll re-observes the name
//           through the same capture rule the poller uses (so a quiet observation really
//           is quiet, and a name whose throughSeq moves really moves).
//   sweep - every round polls every awake name (the old "1s for everything" behaviour).
//   idle  - nothing owes work; only the fixed per-round work runs.
// Per round it reports CPU, wall time, rows changed, real body writes and bytes rewritten.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};

const srcDir = path.resolve(option('src', 'src'));
const mode = option('mode', 'live');
const rounds = Number(option('rounds', 20));
const cadenceMs = Number(option('cadence', 0)) || 1000;
const sourceDb = path.resolve(option('db', ''));
const workDir = path.resolve(option('work', '.perf-work'));
const outFile = option('out', '');
const sweepEvery = Number(option('sweep-every', 5));

if (!existsSync(sourceDb)) throw new Error(`missing --db ${sourceDb}`);
mkdirSync(workDir, { recursive: true });
const dbFile = path.join(workDir, `perf-${mode}-${path.basename(srcDir)}.sqlite`);
for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${dbFile}${suffix}`)) rmSync(`${dbFile}${suffix}`);
copyFileSync(sourceDb, dbFile);
const stateDir = path.join(workDir, 'managed-host');
mkdirSync(stateDir, { recursive: true });

const load = file => import(pathToFileURL(path.join(srcDir, file)).href);
const { RosterStore } = await load('roster-store.mjs');
const { scanSleeping } = await load('idle-monitor.mjs');
const agents = await load('scoped-agents.mjs');

// The rules the poller itself uses. A build from before them keeps its own behaviour
// here, so one script measures "before" and "after" without a second implementation.
const captureObservation = typeof agents.captureObservation === 'function'
  ? agents.captureObservation
  : (previous, payload, at) => ({ ...payload, capturedAt: at });
const owesFastPoll = typeof agents.owesFastPoll === 'function'
  ? agents.owesFastPoll
  : (record, at = Date.now()) => {
    if (!record || record.closed || record.sleep) return false;
    if ((record.task?.reports ?? []).some(report => !['delivered', 'blocked'].includes(report.delivery?.state ?? 'pending'))) return true;
    if ((record.task?.dispatches ?? []).some(dispatch => dispatch.state === 'retrying')) return true;
    if (typeof record.nextAttemptAt === 'number' && record.nextAttemptAt <= at + 2000) return true;
    return record.state === 'delivery_pending';
  };

const store = new RosterStore(dbFile);
const totalChanges = () => store.db.prepare('SELECT total_changes() AS changed').get().changed;
const walBytes = () => { try { return statSync(`${dbFile}-wal`).size; } catch { return 0; } };

const ACTIVE = new Set(['creating', 'running', 'awaiting_input', 'awaiting_report', 'reconnecting', 'delivery_pending', 'cleaning']);

// One host state file per sleeping name, holding the signal the record already agreed on.
const sleeping = store.listSleeping();
for (const record of sleeping) {
  const key = createHash('sha256').update(`${record.ownerId}\n${record.agentId}`).digest('hex');
  const file = path.join(stateDir, `${key}.json`);
  if (existsSync(file)) continue;
  const [taskId, throughSeq, questions, reports] = JSON.parse(record.sleep.signal ?? '[null,-1,[],[]]');
  writeFileSync(file, JSON.stringify({ ownerId: record.ownerId, agentId: record.agentId, sessionId: record.sleep.sessionId,
    taskId, throughSeq, questions: (questions ?? []).map(([id, state]) => ({ id, state })),
    reports: (reports ?? []).map(([id, final]) => ({ id, final })) }));
}

const bodySizes = new Map(store.db.prepare('SELECT id, length(body) AS bytes FROM agents').all()
  .map(row => [row.id, row.bytes]));
const awake = store.listWorkerCandidates().filter(row => !row.sleep && !row.closed && ACTIVE.has(row.state));
// Two of the running names really are running: their throughSeq moves on every poll,
// which is what makes "did this observation change?" a real question.
const growing = new Set(awake.slice(0, 2).map(row => row.agentId));

/** What the host would report for this name on this poll. */
function payloadFor(record) {
  const base = record.observation ?? {};
  const throughSeq = growing.has(record.agentId) ? Number(base.throughSeq ?? 0) + 1 : Number(base.throughSeq ?? 0);
  const { capturedAt: _capturedAt, ...rest } = base;
  return { ...rest, throughSeq, tree: { ...(rest.tree ?? {}), settled: false, running: true },
    questions: rest.questions ?? [], reports: rest.reports ?? [] };
}

store.claimLease('idle-monitor', 'monitor-perf-bench', 600000);
store.claimLease('idle-monitor:ready', 'monitor-perf-bench', 600000);
const sleepCache = new Map();
const fast = new Set();

function pollOne(agentId, tick) {
  const record = store.get(agentId);
  if (!record) return 0;
  // A poll is not just a write: the poller first reads the name's whole tree from the
  // host over HTTP and parses it (that is the readJson line in a live profile). Modelling
  // the round-trip keeps the numbers honest about what a poll actually costs.
  const wire = JSON.parse(JSON.stringify(record.observation ?? {}));
  record.observation = captureObservation(record.observation, { ...wire, ...payloadFor(record) }, new Date().toISOString());
  const before = totalChanges();
  store.save(record);
  const wrote = totalChanges() !== before;
  // What monitorScan does with a record it just loaded and with the one a poll wrote.
  const latest = store.get(agentId) ?? record;
  if (owesFastPoll(latest)) fast.add(agentId); else fast.delete(agentId);
  return wrote ? (bodySizes.get(agentId) ?? 0) : 0;
}

async function round(index) {
  // Fixed per-round work of the listener.
  if (typeof store.leaseHeld === 'function') { store.leaseHeld('idle-monitor', 'monitor-perf-bench'); store.leaseHeld('idle-monitor:ready', 'monitor-perf-bench'); }
  else { store.renewLease('idle-monitor', 'monitor-perf-bench', 60000); store.renewLease('idle-monitor:ready', 'monitor-perf-bench', 60000); }
  store.hasSleeping();
  store.listSleeping();
  store.listClaudeBindings();
  store.hasOpenTarget('claude-desktop');
  await scanSleeping(store, stateDir, () => {}, new Map(), sleepCache);
  // mode poll: the same name over and over, which is what "does an unchanged poll still
  // rewrite the body?" is really about — one big body is the whole measurement.
  if (mode === 'poll') {
    const target = [...bodySizes].sort((left, right) => right[1] - left[1])[0][0];
    return { swept: false, polled: 1, rewriteBytes: pollOne(target, index) };
  }
  const sweep = mode === 'sweep' || (mode === 'live' && index % sweepEvery === 0);
  const candidates = sweep ? store.listWorkerCandidates() : [];
  const targets = new Set();
  if (mode === 'live') for (const agentId of fast) targets.add(agentId);
  if (sweep) for (const row of candidates) if (!row.sleep && !row.closed && ACTIVE.has(row.state)) targets.add(row.agentId);
  let rewriteBytes = 0;
  for (const agentId of targets) rewriteBytes += pollOne(agentId, index);
  return { swept: sweep, polled: targets.size, rewriteBytes };
}

await round(-2);
await round(-1);

const samples = [];
for (let index = 0; index < rounds; index += 1) {
  const cpu0 = process.cpuUsage();
  const changed0 = totalChanges();
  const wall0 = process.hrtime.bigint();
  const detail = await round(index);
  const wall = Number(process.hrtime.bigint() - wall0) / 1e6;
  const cpu = process.cpuUsage(cpu0);
  const rows = totalChanges() - changed0;
  samples.push({ index, ...detail, wrote: rows > 0 ? rows : 0, wallMs: wall,
    cpuMs: (cpu.user + cpu.system) / 1000, rowsChanged: rows });
}

const mean = key => samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
const result = {
  src: srcDir, mode, rounds, cadenceMs, sweepEvery,
  awakeNames: awake.length, sleepingNames: sleeping.length, growingNames: growing.size,
  polledPerRound: Number(mean('polled').toFixed(2)),
  cpuMsPerRound: Number(mean('cpuMs').toFixed(2)),
  wallMsPerRound: Number(mean('wallMs').toFixed(2)),
  rowsChangedPerRound: Number(mean('rowsChanged').toFixed(2)),
  bodyWritesPerRound: Number(mean('wrote').toFixed(2)),
  bodyBytesRewrittenPerRound: Math.round(mean('rewriteBytes')),
  percentOfOneCore: Number((mean('cpuMs') / cadenceMs * 100).toFixed(2)),
};
console.log(JSON.stringify(result, null, 2));
if (outFile) writeFileSync(path.resolve(outFile), JSON.stringify({ result, samples }, null, 2));
store.close();
