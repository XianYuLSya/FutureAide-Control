// A local, in-process fake of the Codex renderer's app-server RPC. The production
// codex-host/codex-backend still run; only codex-ipc is redirected here by the
// test loader. The HTTP boundary lets a detached test monitor and the test process
// observe the same renderer state.
import http from 'node:http';

const now = () => Date.now();

export const CODEX_MODELS = Object.freeze([
  {
    id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6 Astra',
    description: 'Assembly fixture Astra', hidden: false, isDefault: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Medium' },
      { reasoningEffort: 'high', description: 'High' },
      { reasoningEffort: 'max', description: 'Max' },
    ],
  },
  {
    id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6 Luna',
    description: 'Assembly fixture Luna', hidden: false, isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Low' },
      { reasoningEffort: 'medium', description: 'Medium' },
    ],
  },
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export async function startRendererFixture({ workspace, callerThreadId }) {
  const state = { calls: [], threads: new Map(), turns: new Map(), nextThread: 0, nextTurn: 0 };
  const addThread = (id, cwd, model = 'gpt-6-astra', reasoningEffort = 'high') => {
    const thread = {
      id, cwd, model, modelProvider: 'openai', reasoningEffort,
      name: null, status: { type: 'idle' }, updatedAt: now(),
    };
    state.threads.set(id, thread);
    state.turns.set(id, []);
    return thread;
  };
  addThread(callerThreadId, workspace);
  addThread('thread-cold', workspace);

  const reply = (res, value) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const error = (res, code, message, extra = {}) =>
    reply(res, { error: { code, message, ...extra } });

  const rpc = (method, params = {}) => {
    state.calls.push({ method, params: clone(params), at: now() });
    switch (method) {
      case 'config/read':
        return { model: 'gpt-6-astra', provider: 'openai', reasoningEffort: 'high', profile: null };
      case 'model/list':
        return { data: clone(CODEX_MODELS), nextCursor: null };
      case 'thread/list':
        return { data: [], nextCursor: null };
      case 'thread/read': {
        const thread = state.threads.get(params.threadId);
        if (!thread) throw Object.assign(new Error('thread not found'), { code: 'codex-thread-not-found' });
        return { thread: clone(thread) };
      }
      case 'thread/start': {
        const id = `thread-fixture-${++state.nextThread}`;
        const thread = addThread(id, params.cwd ?? workspace);
        return { thread: clone(thread) };
      }
      case 'thread/resume': {
        const thread = state.threads.get(params.threadId);
        if (!thread) throw Object.assign(new Error('thread not found'), { code: 'codex-thread-not-found' });
        return { thread: clone(thread) };
      }
      case 'thread/name/set': {
        const thread = state.threads.get(params.threadId);
        if (thread) { thread.name = params.name; thread.updatedAt = now(); }
        return { ok: true };
      }
      case 'thread/delete': {
        state.threads.delete(params.threadId);
        state.turns.delete(params.threadId);
        return { ok: true };
      }
      case 'thread/turns/list': {
        const thread = state.threads.get(params.threadId);
        if (!thread) throw Object.assign(new Error('thread not found'), { code: 'codex-thread-not-found' });
        return { data: clone(state.turns.get(params.threadId) ?? []), nextCursor: null };
      }
      case 'turn/start': {
        const thread = state.threads.get(params.threadId);
        if (!thread) throw Object.assign(new Error('thread not found'), { code: 'codex-thread-not-found' });
        // Apply the same model/effort fields a real turn/start accepts. An unknown
        // model or unsupported effort is rejected here, so a wrong wire value from
        // the adapter cannot pass as a successful turn.
        const nextModel = CODEX_MODELS.find(model => params.model === undefined
          ? model.model === thread.model
          : (model.model === params.model || model.id === params.model));
        if (!nextModel) throw Object.assign(new Error(`Unknown model ${params.model}`), { code: 'codex-model-not-found' });
        if (params.effort !== undefined
            && !nextModel.supportedReasoningEfforts.some(effort => effort.reasoningEffort === params.effort)) {
          throw Object.assign(new Error(`Unsupported effort ${params.effort} for ${nextModel.model}`), { code: 'codex-effort-not-supported' });
        }
        thread.model = nextModel.model;
        thread.reasoningEffort = params.effort ?? (params.model === undefined
          ? thread.reasoningEffort : nextModel.defaultReasoningEffort);
        const id = `turn-fixture-${++state.nextTurn}`;
        const text = (params.input ?? []).map(item => item.text ?? '').join('');
        const turn = {
          id, status: 'inProgress', startedAt: now(), model: thread.model,
          reasoningEffort: thread.reasoningEffort, items: [
            { id: `item-user-${id}`, type: 'userMessage', text },
          ],
        };
        state.turns.get(params.threadId).push(turn);
        thread.status = { type: 'active' };
        thread.updatedAt = now();
        return { turn: { id, status: 'inProgress' } };
      }
      case 'turn/steer': {
        const thread = state.threads.get(params.threadId);
        if (!thread) throw Object.assign(new Error('thread not found'), { code: 'codex-thread-not-found' });
        return { turnId: params.expectedTurnId };
      }
      case 'turn/interrupt': {
        const turns = state.turns.get(params.threadId) ?? [];
        const turn = turns.find(item => item.id === params.turnId);
        if (turn) turn.status = 'interrupted';
        const thread = state.threads.get(params.threadId);
        if (thread) { thread.status = { type: 'idle' }; thread.updatedAt = now(); }
        return { ok: true };
      }
      case 'thread/status': {
        const thread = state.threads.get(params.threadId);
        if (!thread) throw Object.assign(new Error('thread not found'), { code: 'codex-thread-not-found' });
        return { status: clone(thread.status) };
      }
      default:
        throw Object.assign(new Error(`Unsupported assembly renderer method ${method}`), { code: 'unsupported-method' });
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/calls' && req.method === 'GET') {
        reply(res, { calls: state.calls, threads: [...state.threads.values()] });
        return;
      }
      if (url.pathname !== '/rpc' || req.method !== 'POST') {
        res.writeHead(404); res.end(); return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let result;
      try { result = rpc(body.method, body.params ?? {}); }
      catch (errorValue) {
        error(res, errorValue.code ?? 'codex-native-rpc-rejected', errorValue.message ?? 'failed',
          { terminal: errorValue.terminal === true });
        return;
      }
      reply(res, { result });
    } catch (errorValue) {
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: { code: 'fixture-failure', message: String(errorValue?.message ?? errorValue) } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state, server, rpc,
    calls: () => state.calls,
    thread: id => state.threads.get(id),
    close: async () => {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
