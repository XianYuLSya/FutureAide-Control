// Runtime adapter boundary. The lifecycle/store/report layers never construct a
// Claude CLI command directly. Claude uses the Desktop-provided Code executable
// and the runtime environment's OAuth token; no standalone login step exists.
import { buildCliInvocation } from './cli-agent-execution.mjs';

/** Return the selectable execution adapter for one runtime. */
export function createRuntimeAdapter(runtime) {
  if (runtime === 'claude') {
    return {
      id: 'claude-desktop-code',
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
