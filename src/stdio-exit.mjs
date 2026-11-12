// Shared by the two stdio entry points: when the host closes the input pipe, end the
// process only once every request that already arrived has its answer on stdout.
//
// Why this is not "close on EOF": the SDK 1.30.0 stdio transport has no 'end' handler,
// so a pipe that closes leaves the server running with whatever the event loop still
// holds. Closing at once instead loses work that is already finished or about to be:
// a tool call can write durable state and only then produce its answer, and the caller
// would never see it. Waiting for the handler to return is not enough either, because
// the answer is written by a later transport.send; so this tracks the writes themselves,
// and the wait ends when the last of them has been flushed to stdout.
//
// The wait is bounded: a handler that never answers must not keep a dead thread's
// process alive. A failed write (EPIPE) means the host is gone, so nothing waits.

const isRequest = message => Boolean(message) && typeof message === 'object'
  && message.id !== undefined && typeof message.method === 'string';

const isAnswer = message => Boolean(message) && typeof message === 'object'
  && message.id !== undefined && (message.result !== undefined || message.error !== undefined);

/**
 * Install the two behaviours on one transport. Call it BEFORE connect(): the protocol
 * assigns its own onmessage during connect(), so the wrapper is installed as the
 * property setter and every handler the SDK assigns ends up inside it. That way the
 * first message that arrives is already tracked.
 * @param {object} options
 * @param {{send: Function}} options.transport Server transport, connected or about to be.
 * @param {Function} [options.close] Releases the server or bridge; awaited before exit.
 * @param {number} [options.graceMs] Longest wait for answers already received. The
 *   plugin's own DSH probes answer within a few seconds even when the host is
 *   unreachable, so this bounds a dead handler rather than a slow one; it is not a
 *   fixed delay, and the wait ends as soon as the last answer is written.
 */
export function exitWhenInputCloses({ transport, close = async () => {}, graceMs = 10000 } = {}) {
  const unanswered = new Set();
  let writing = 0;
  let closed = false;
  let wake;

  const settled = () => unanswered.size === 0 && writing === 0;
  const notify = () => {
    if (!settled() || !wake) return;
    const resolve = wake;
    wake = undefined;
    resolve();
  };

  // Keep callbacks already installed by diagnostics when the SDK connects.
  const wrap = handler => typeof handler === 'function' ? function (message, extra) {
    if (isRequest(message)) unanswered.add(message.id);
    // The SDK aborts the handler for this notification and suppresses its reply.
    // Ignore the same empty ids as the SDK. Any write already begun still drains.
    if (message?.method === 'notifications/cancelled' && message.params?.requestId) {
      unanswered.delete(message.params.requestId);
      notify();
    }
    return handler.call(this, message, extra);
  } : handler;
  let onmessage = wrap(transport.onmessage);
  Object.defineProperty(transport, 'onmessage', {
    configurable: true, enumerable: true,
    get: () => onmessage,
    set: handler => { onmessage = wrap(handler); },
  });

  // Every answer and notification leaves through send(); the counter is what makes
  // "the answer is actually written" observable instead of assumed.
  const send = transport.send.bind(transport);
  transport.send = message => {
    writing += 1;
    const release = () => {
      writing -= 1;
      if (isAnswer(message)) unanswered.delete(message.id);
      notify();
    };
    return send(message).then(value => { release(); return value; }, error => { release(); throw error; });
  };

  /** Waits until nothing is outstanding, or the bound is reached. No polling. */
  const waitForAnswers = () => new Promise(resolve => {
    if (settled()) { resolve(); return; }
    const timer = setTimeout(() => { wake = undefined; resolve(); }, graceMs);
    wake = () => { clearTimeout(timer); resolve(); };
  });

  /** stdout is flushed when this callback, ordered after every queued write, runs. */
  const flushStdout = () => new Promise(resolve => {
    try { process.stdout.write('', () => resolve()); } catch { resolve(); }
  });

  /** One exit even if the pipe emits both end and close. */
  const shutdown = async ({ wait = true } = {}) => {
    if (closed) return;
    closed = true;
    // Backstop for a close() that waits, or a handler that never answers.
    setTimeout(() => process.exit(0), (wait ? graceMs : 0) + 2000).unref();
    if (wait) await waitForAnswers();
    await flushStdout();
    try { await close(); } catch { /* the exit below is what matters */ }
    process.exit(0);
  };

  const onInputClosed = () => { void shutdown(); };
  process.stdin.on('end', onInputClosed);
  process.stdin.on('close', onInputClosed);
  // A host that dies without closing the pipe surfaces as a failed write instead.
  process.stdout.on('error', error => {
    if (error?.code === 'EPIPE') void shutdown({ wait: false });
    else throw error;
  });
}
