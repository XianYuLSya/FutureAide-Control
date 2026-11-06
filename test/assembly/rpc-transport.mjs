// Lowest-layer renderer transport used by the test loader. The real
// src/codex-ipc.mjs remains in place: its helper exports and its JSON-RPC
// envelope/normalization code are the production code under test. Only the
// `createCodexNativeRpc()` singleton's transport is replaced with this HTTP call.
const endpoint = () => {
  const value = process.env.FUTUREAIDE_ASSEMBLY_RENDERER_URL;
  if (!value) throw Object.assign(new Error('The assembly renderer fixture is not configured.'),
    { code: 'codex-native-rpc-unavailable' });
  return value.replace(/\/$/, '') + '/rpc';
};

export async function assemblyRequest(method, params) {
  let response;
  try {
    response = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
  } catch {
    throw Object.assign(new Error('The assembly renderer fixture is unreachable.'),
      { code: 'codex-native-rpc-unavailable' });
  }
  let body;
  try { body = await response.json(); }
  catch {
    throw Object.assign(new Error('The assembly renderer returned invalid JSON.'),
      { code: 'codex-native-rpc-invalid-response' });
  }
  if (!response.ok || body?.error) {
    const error = body?.error ?? {};
    throw Object.assign(new Error(error.message ?? 'The assembly renderer rejected the request.'), {
      code: error.code ?? 'codex-native-rpc-rejected',
      rpcCode: error.code,
      rpcMessage: error.message,
      terminal: error.terminal === true,
      nativeSessionId: error.nativeSessionId,
    });
  }
  return body?.result;
}
