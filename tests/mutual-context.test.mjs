import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createMutualContextResolver } from '../src/mutual-context.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const THREAD = '11111111-1111-4111-8111-111111111111';

test('an explicit unknown agent_context is rejected by the central resolver, never downgraded to root', async () => {
  const resolver = createMutualContextResolver({ stateDirectory: path.join(ROOT, 'clean', 'context-test') }, {
    resolveDesktop: async () => undefined,
    callCodex: async (threadId) => ({ thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: ROOT } }),
  });
  await assert.rejects(
    resolver({ _meta: { threadId: THREAD }, agent_context: 'ticket_invalid_validation' }),
    error => error.code === 'desktop-context-invalid',
  );
});
