// Local DSH HTTP fixture. The production FutureAideClient, control layer and DSH
// backend adapter are used unchanged; only the host that answers the wire is fake.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DSH_MODELS = Object.freeze([
  { id: 'dsh-default', name: 'DSH Default',
    reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], defaultEffort: 'medium' } },
  { id: 'astra-3.5', name: 'Astra 3.5',
    reasoning: { efforts: [{ id: 'high' }, { id: 'max' }], defaultEffort: 'high' } },
  { id: 'astra-4', name: 'Astra 4',
    reasoning: { efforts: [{ id: 'max' }], defaultEffort: 'max' } },
]);

export const DSH_METHODS = Object.freeze([
  'managedCreate', 'managedBeginTask', 'managedStatus', 'managedSelectModel', 'managedHistory',
  'managedAnswer', 'managedCancel', 'managedDestroy',
]);

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export async function startDshFixture({ root, workspace }) {
  const token = 'assembly-launch-token';
  const cookie = 'dsh-auth-assembly=assembly-session';
  const bridgeToken = 'a'.repeat(64);
  const dshHome = path.join(root, 'dsh-home');
  await mkdir(dshHome, { recursive: true });
  const state = {
    calls: [],
    nativeSelectCalls: 0,
    currentModel: { provider: 'dsh-fixture', model: 'dsh-default', reasoningEffort: 'medium' },
    created: [],
  };

  const reply = (res, value, status = 200, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(value));
  };
  const rpcReply = (res, body, result) => reply(res, {
    type: 'server-response', rpcId: body.rpcId, result,
  });
  const argsOf = body => body?.payload?.args ?? body?.payload ?? {};

  const managedStatus = input => ({
    ownerId: input.ownerId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    workspace: input.workspace,
    workspaceId: 'workspace-assembly',
    taskId: input.taskId ?? null,
    model: state.currentModel,
    currentModel: clone(state.currentModel),
    agentPreset: 'standard',
    running: false,
    status: 'idle',
    activity: 'idle',
    throughSeq: 1,
    questions: [],
    changes: [],
    reports: [],
    coverage: { source: 'agent-file-tool-results', complete: false },
    updatedAt: new Date().toISOString(),
    tree: {
      settled: true,
      running: false,
      nodes: [{ sessionId: input.sessionId, parentSessionId: null, status: 'idle',
        activity: 'idle', changes: [], coverage: { source: 'agent-file-tool-results', complete: false } }],
    },
  });

  const handle = (body) => {
    const method = body.method;
    const args = argsOf(body);
    switch (method) {
      case 'session/list': return { items: [] };
      case 'session/modelCatalog':
        return {
          default: { provider: 'dsh-fixture', model: 'dsh-default', reasoningEffort: 'medium' },
          routableProviders: ['dsh-fixture'],
          groups: [{ id: 'dsh-fixture', models: clone(DSH_MODELS) }],
        };
      case 'session/selectModel': {
        state.nativeSelectCalls += 1;
        const request = args.request ?? {};
        state.currentModel = { provider: request.provider, model: request.model,
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) };
        return { selected: clone(state.currentModel) };
      }
      case 'session/prompt': return { accepted: true, requestId: args.request?.requestId };
      case 'session/page': return { records: [], hasMore: false };
      case 'session/create': {
        const request = args.request ?? {};
        state.created.push({ sessionId: request.sessionId, workspaceId: request.workspaceId });
        return { sessionId: request.sessionId, agentPreset: request.agentPreset };
      }
      case 'workspace/create': {
        const request = args.request ?? {};
        return { created: true, workspace: { workspaceId: 'workspace-assembly', path: request.path,
          title: 'Assembly fixture', sessionIds: state.created.map(item => item.sessionId) } };
      }
      case 'workspace/rename': return { workspace: { workspaceId: 'workspace-assembly', path: workspace,
        title: args.request?.title ?? 'Assembly fixture', sessionIds: [] } };
      case 'ping': return { version: 1, revision: 1, pid: process.pid, methods: [...DSH_METHODS],
        treeProtocol: 1, reportProtocol: 1 };
      case 'historyCursor': return { sessionId: args.sessionId, throughSeq: -1 };
      case 'managedCreate': {
        state.created.push({ sessionId: args.sessionId, workspaceId: 'workspace-assembly' });
        return { sessionId: args.sessionId, modelRequestsStarted: 0 };
      }
      case 'managedBeginTask': return { treeProtocol: 1, reportProtocol: 1, throughSeq: 0,
        currentModel: clone(state.currentModel) };
      case 'managedStatus': return managedStatus(args);
      case 'managedSelectModel': {
        const selection = clone(args.selection ?? {});
        state.currentModel = selection;
        return { accepted: true, sessionId: args.sessionId, selected: clone(selection),
          source: 'managed-session-selectModel',
          defaultModelBehavior: 'Session-only: the app-wide default model is unchanged.',
          modelRequestsStarted: 0 };
      }
      case 'managedHistory': return { events: [], hasMore: false };
      case 'managedAnswer': return { accepted: true };
      case 'managedCancel': return { cancelRequested: true, treeSettled: true };
      case 'managedDestroy': return { destroyed: true };
      default:
        throw Object.assign(new Error(`Unsupported DSH fixture method ${method}`), { code: 'unknown-endpoint' });
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/' && req.method === 'GET') {
        if (url.searchParams.get('token') !== token) { res.writeHead(401); res.end(); return; }
        res.writeHead(303, { location: '/', 'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Strict` });
        res.end();
        return;
      }
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      if (req.headers.cookie !== cookie) { res.writeHead(401); res.end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const args = argsOf(body);
      state.calls.push({ path: url.pathname, method: body.method, args: clone(args), body });
      if (url.pathname === '/futureaide-control/ping' && args.token !== bridgeToken) {
        rpcReply(res, body, { ok: false, error: { code: 'bridge-auth-required' } });
        return;
      }
      let value;
      try { value = handle(body); }
      catch (error) { rpcReply(res, body, { ok: false, error: { code: error.code ?? 'fixture-failure',
        message: error.message } }); return; }
      rpcReply(res, body, { ok: true, value });
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: { code: 'fixture-failure', message: String(error?.message ?? error) } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const instanceFile = path.join(dshHome, 'instance.json');
  const hostBridgeFile = path.join(root, 'host-bridge.json');
  await writeFile(instanceFile, JSON.stringify({
    version: 1, application: 'dsh', pid: process.pid, instanceId: randomUUID(),
    dataRoot: dshHome, launchUrl: `${baseUrl}/?token=${token}`, baseUrl,
  }), 'utf8');
  await writeFile(hostBridgeFile, JSON.stringify({ version: 1, token: bridgeToken }), 'utf8');
  return {
    state, baseUrl, instanceFile, hostBridgeFile, token, cookie,
    calls: () => state.calls,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
