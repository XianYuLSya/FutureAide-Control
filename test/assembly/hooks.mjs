// The outermost boundaries of the two production paths are the only pieces this
// loader replaces:
//   - Claude Desktop's native process/TCP identity lookup (the worker owns the
//     loopback report service and asks who opened the socket);
//   - Codex Desktop's renderer transport (the real codex-ipc singleton is kept,
//     and only its lowest-level request transport is redirected).
// Everything else is the real production module graph.
const claudeIdentity = `
const caller = () => ({
  sessionId: process.env.FUTUREAIDE_ASSEMBLY_CLAUDE_SESSION_ID,
  cwd: process.env.FUTUREAIDE_ASSEMBLY_CLAUDE_WORKSPACE,
  pid: Number(process.env.FUTUREAIDE_ASSEMBLY_CLAUDE_PID || process.pid),
  via: 'assembly-loader'
});
export async function resolveSocketCaller() { return caller(); }
export async function resolveStdioCaller() { return caller(); }
`;

export async function load(url, context, nextLoad) {
  if (process.env.FUTUREAIDE_ASSEMBLY_FAKE_CLAUDE === '1'
      && /\/src\/claude-caller-identity\.mjs$/.test(url)) {
    // Only replace the caller binding. The worker still verifies its real PID.
    const original = JSON.stringify(`${url}?assembly-original`);
    return { format: 'module', shortCircuit: true, source: `${claudeIdentity}\nexport * from ${original};` };
  }
  if (process.env.FUTUREAIDE_ASSEMBLY_RENDERER_URL
      && /\/src\/codex-ipc\.mjs$/.test(url)) {
    const actual = await nextLoad(url, context);
    const text = Buffer.from(actual.source ?? '').toString('utf8');
    const marker = 'const nativeRpc = createCodexNativeRpc();';
    if (!text.includes(marker)) {
      throw new Error('Assembly test loader: the codex-ipc transport seam `const nativeRpc = createCodexNativeRpc();` was not found. Update the loader only after inspecting the production module.');
    }
    const transport = new URL('./rpc-transport.mjs', import.meta.url).href;
    const source = `import { assemblyRequest } from ${JSON.stringify(transport)};\n`
      + text.replace(marker, 'const nativeRpc = { request: assemblyRequest, close: () => {} };');
    return { ...actual, format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
