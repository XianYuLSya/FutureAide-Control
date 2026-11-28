import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Integration harness: metadata comes from this Codex process; ordinary tools
// receive it from Codex itself. This is not evidence of UI tool hot-reloading.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = process.env.FUTUREAIDE_VALIDATION_CONFIG || 'D:/Work/.futureaide-control-validation/20261030/config.json';
if (!process.env.CODEX_THREAD_ID) throw new Error('Run from the actual Codex chat environment.');
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'src', 'mcp-server.mjs')],
  env: { ...process.env, DSH_CONTROL_CONFIG: config }, stderr: 'pipe',
});
const client = new Client({ name: 'futureaide-live-check', version: '1.0.0' });
try {
  await client.connect(transport);
  const tool = process.argv[2];
  if (!tool || tool === 'tools') {
    const result = await client.listTools();
    process.stdout.write(JSON.stringify(result.tools.map(value => ({ name: value.name, inputSchema: value.inputSchema })), null, 2) + '\n');
  } else {
    const args = JSON.parse(process.argv[3] || '{}');
    const result = await client.callTool({ name: tool, arguments: args, _meta: { threadId: process.env.CODEX_THREAD_ID } }, undefined, { timeout: 60000 });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.isError) process.exitCode = 1;
  }
} finally { await client.close(); }
