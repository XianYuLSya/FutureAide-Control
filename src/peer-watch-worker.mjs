// Lightweight per-exchange peer watcher. It polls the durable exchange, uses the existing
// agents.wait/followup facade through createPeers.pump, and posts one source notice. It is not a
// model, not a resident daemon, and exits as soon as the notice is terminal or the 6h cap is hit.
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createPeers } from './peers.mjs';

export const PEER_WATCH_MAX_MINUTES = 360;

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function watcherDone(notification) {
  return notification !== undefined
    && ['delivered', 'unknown', 'failed', 'skipped', 'delegated'].includes(notification.state);
}

/** @returns {Map<string,string>} `--flag value` pairs from a worker command line. */
export function peerWorkerArguments(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    const key = String(argv[index]).replace(/^--/, '');
    if (argv[index + 1] === undefined) continue;
    args.set(key, argv[index + 1]);
  }
  return args;
}

/**
 * Poll one exchange. The exchange result is persisted before any notice is attempted; a busy
 * source leaves the notice pending for the next loop, while an unknown notice is never retried.
 * @param {object} options exchangeId, watcher nonce and optional limits.
 * @param {object} deps Injected peers facade, clock and sleep.
 * @returns {Promise<object>} Final watcher state for tests and the detached process.
 */
export async function runPeerWatch({ exchangeId, nonce, maxMinutes = PEER_WATCH_MAX_MINUTES, pollMs = 1000 } = {},
  { peers, sleep = defaultSleep, now = Date.now } = {}) {
  if (!peers) throw new Error('runPeerWatch requires a peers facade.');
  const deadline = now() + Math.max(0, Number(maxMinutes)) * 60000;
  const interval = Math.max(1, Number(pollMs));
  if (nonce !== undefined) {
    const watch = await peers.watcherStatus(exchangeId);
    const superseded = watch !== undefined && watch.state === 'running' && watch.nonce !== nonce;
    if (superseded) {
      return { state: 'superseded', exchangeId, note: 'A newer watcher owns this exchange.' };
    }
  }
  let lastError;
  for (;;) {
    let exchange;
    try {
      exchange = await peers.pump({ exchangeId });
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (exchange?.notification === undefined && exchange !== undefined) {
      const result = { state: 'legacy', exchangeId, exchange,
        note: 'This historical exchange has no notification state, so no notice is created.' };
      if (nonce !== undefined) await peers.finishWatcher({ exchangeId, nonce, state: 'ended', note: result.note }).catch(() => undefined);
      return result;
    }
    if (exchange && watcherDone(exchange.notification) && exchange.archive?.state !== 'pending') {
      const result = { state: 'ended', exchangeId, exchange, notification: exchange.notification };
      if (nonce !== undefined) await peers.finishWatcher({ exchangeId, nonce, state: 'ended', note: 'Notification reached a terminal state.' }).catch(() => undefined);
      return result;
    }
    if (exchange?.state === 'awaiting_input'
      && ['unknown', 'failed'].includes(exchange.continuation?.state)) {
      const note = 'The parent is awaiting input and its continuation delivery is unconfirmed; it is not retried automatically.';
      if (nonce !== undefined) await peers.finishWatcher({ exchangeId, nonce, state: 'ended', note }).catch(() => undefined);
      return { state: 'ended', exchangeId, exchange, note };
    }
    if (now() >= deadline) {
      const note = 'The 6h watch deadline passed; the exchange is still pending, which is not a task failure and nothing was resent.';
      if (nonce !== undefined) await peers.finishWatcher({ exchangeId, nonce, state: 'expired', note }).catch(() => undefined);
      return { state: 'expired', exchangeId, exchange, lastError: lastError?.message, note };
    }
    await sleep(Math.max(1, Math.min(interval, deadline - now())));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = peerWorkerArguments(process.argv);
  const exchangeId = args.get('exchange');
  if (!exchangeId) {
    console.error('peer-watch-worker: --exchange is required.');
    process.exit(2);
  }
  const config = await loadConfig(args.get('config') || undefined);
  const peers = createPeers(config);
  await runPeerWatch({
    exchangeId,
    nonce: args.get('nonce'),
    maxMinutes: Number(args.get('max-minutes') ?? PEER_WATCH_MAX_MINUTES),
    pollMs: Number(args.get('poll') ?? 1000),
  }, { peers });
  process.exit(0);
}
