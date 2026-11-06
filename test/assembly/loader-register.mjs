// Test-only module loader registration. It is passed with `--import` to the
// production entry process (the scoped worker for the Claude surface, and the
// MCP process for the Codex surface). Nothing under src/ is changed.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
