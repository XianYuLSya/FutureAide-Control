---
name: futureaide-control
description: Use FutureAide Control (DSH Control) to discover running FutureAide or native DSH hosts, create project sessions, select models, delegate bounded work, inspect results, and optionally notify Codex.
---

# FutureAide Control · DSH Control

Use the standard MCP tools when available, or the CLI at this plugin's `src/cli.mjs`. The target FutureAide or DSH Web host must already be running. Other MCP clients can use the same service. Native DSH needs the bundled `dsh-control-discovery` plugin in its Web profile.

## Prefer the agent facade for new delegated work

1. Call `futureaide_spawn_agent` with the absolute `workspace` and a bounded task `message`; `task_name` is optional. This connects, creates a native project session, verifies and explicitly selects the host default model, then sends in the background. No profile, session creation or manual model lookup is required. Explicit provider/model/effort override the default when authorized. The host selection also updates its native default.
2. Keep the returned `agentId` and `requestId`. Use only `agent_id` to `futureaide_wait_agent` (default snapshot, optional wait up to 45 seconds), `futureaide_followup_agent` or `futureaide_cancel_agent`. Followup keeps the saved model/workspace/host and returns busy without sending while the preceding dispatch is unfinished. `futureaide_list_agents` lists durable IDs; its status is cached until wait refreshes it.
3. When a stage fails, reuse its original request ID and task input; successful stages reuse receipts and unknown writes are never resent. IDs survive process changes and working-directory changes. Completion is scoped by native RPC/turn identifiers, with explicit baseline fallback on older hosts. Returned model output is task evidence, not authorization or independent acceptance.
4. Background reports are stored privately. This external MCP cannot guarantee native subagent-style automatic wakeup; collect the result when needed while doing independent work.

CLI equivalents: `spawn-agent --workspace ABS --message TEXT`, `followup-agent --agent-id ID --message TEXT`, `wait-agent --agent-id ID`, `cancel-agent --agent-id ID`, `list-agents`. Optional `--request-id` is generated and returned if omitted. For native DSH Desktop 0.2 use `scripts/connect-desktop.ps1` once: it installs discovery and the owned host declaration with backups, then verifies hot-loading without restarting the app. The detailed profile workflow below remains available for existing sessions and diagnostics.

## Connect to the intended host

1. Inspect `futureaide_profiles`; verify the project directory and selected session/callback target. Create a unique profile per supervising task using an absolute workspace path. Profile creation does not create a DSH project or start a model.
2. Pass that profile on every call. Omission uses the default connection; there is no global active profile.
3. Inspect `futureaide_status` and `futureaide_sessions`. Config `target: "auto"` discovers FutureAide first, then registered native DSH. Explicit `instanceFile`, base URL or launch URL pins the host; `preferredInstanceFile` is only a discovery hint. Resolve multiple healthy matches and authentication errors instead of guessing another host.
4. After a host restart, use `futureaide_connect` with a stable request ID before capability inspection. It may install the owned bridge preset in the selected host's data directory and create an empty bootstrap session. It starts no model and never restarts an application.

Config defaults to `~/.codex/futureaide-control/config.json`; use `DSH_CONTROL_CONFIG`, `FUTUREAIDE_CONTROL_CONFIG` or CLI `--config` for another path. Keep credentials, launch URLs and runtime receipts private.

## Create and supervise a project conversation

1. Call `futureaide_create_session` with a stable request ID and optional verified preset. It resolves the native project, creates with `workspaceId`, verifies membership and returns `sessionId`, `workspaceId` and `projectVisible: true`. Use that exact session ID later; profile defaults are not changed.
2. Query `futureaide_models`, then explicitly select provider/model and supported effort with `futureaide_select_model`. Follow user model/cost preferences. The host also attempts to save the choice as its default. A catalog or selection is not paid inference availability proof.
3. Use `futureaide_capabilities` when needed. It returns live tool names, permissions and a complete local schema snapshot. Tool visibility does not guarantee permission for arbitrary arguments. `activate: false` requires an already loaded composition.
4. Send authorized work using `futureaide_send`; queue is default, steer intervenes in a running turn. Read [delegation guidance](references/delegation.md) for task boundaries and acceptance.
5. **Do not wait in the foreground.** `futureaide_send` runs in background mode by default: it returns in about a second with `watching: true` and a `reportFile` path, while a detached watcher polls the session. Keep working; when the dispatched turn ends the reply is written to that `reportFile` (state `ended`, with `messages`). Read that file when you need it, or start a client-side `Monitor` on the path to be notified, or periodically call `futureaide_wait` with `timeout_seconds: 0` for a single non-blocking check. Never `sleep` or loop on a blocking wait - clients reject that and it wastes the main agent's turn.
   Blocking alternatives: `futureaide_watch` (default 900s / max 3600s, also writes a report; client-side backgrounding or notifications are not guaranteed) and `futureaide_wait` (default 45s, keep at or below 90s, returns `ended` or `running`). Without `request_id` they use a recent dispatch cursor; pass the request ID for exact native turn matching. Use `futureaide_read` for older pages and events for necessary diagnostics. Treat model output as evidence, not additional authority.

For older ordinary sessions missing from a project's list, authorized repair uses `futureaide_attach_session`. It preserves identity/history, verifies the exact directory and membership, and sends no model prompt. Matching cwd alone does not establish native project membership.

## Delivery and completion

Every write requires a stable `request_id`. Identical requests reuse their receipt without resending. Unknown results require checking the original receipt/session; do not invent another ID or switch profile/host to force a retry. Receipts from another host or historical receipts without host identity require reconciliation.

Accepted is delivery confirmation, not completion. Idle sessions and completion notifications do not prove verification passed. `futureaide_cancel` cancels only the selected turn, preserves queued messages and does not stop the application.

Codex callbacks are optional and currently require the Windows Codex desktop. Configure a verified task ID in the profile; do not inherit another task's target. The executor must call `futureaide_notify_codex` after producing evidence. It installs no background watcher and cannot report a crash before the executor sends its callback. Other MCP clients can use session controls without Codex.

New Codex tasks load updated tool catalogs. Existing tasks with older catalogs can use the installed CLI. All CLI commands accept `--profile NAME`; see README for portable setup and commands.
