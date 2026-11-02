// Runtime adapter boundary. Claude CLI is disabled; no Desktop credential
// extraction or independent Claude process may substitute for Desktop dispatch.
import { buildCliInvocation } from './cli-agent-execution.mjs';

/** Return the selectable execution adapter for one runtime. */
export function createRuntimeAdapter(runtime) {
  if (runtime === 'claude') {
    return {
      id: 'claude-disabled',
      build(input) {
        return buildCliInvocation({ ...input, runtime: 'claude', model: input.model ?? 'opus', effort: input.effort ?? 'medium' });
      },
    };
  }
  if (runtime === 'codex') {
    return {
      id: 'codex-cli',
      build(input) {
        return buildCliInvocation({ ...input, runtime: 'codex' });
      },
    };
  }
  throw Object.assign(new Error(`No runtime adapter is available for ${String(runtime)}.`), { code: 'runtime-adapter-unavailable' });
}
