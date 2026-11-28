---
name: futureaide-control
description: Dispatch and coordinate named headless Codex CLI, Claude CLI, Antigravity CLI (agy-cli), and Codex Desktop subagents when cross-client CLI delegation or FutureAide team coordination is requested. Coexists peacefully with existing user workflows and native subagents.
---

# FutureAide Control

Use this plugin's `futureaide_*` MCP tools when the user requests FutureAide, cross-client headless CLI subagents (`codex-cli`, `claude-cli`, `agy-cli`), isolated Git `worktree` parallel fleets, or team board coordination. **Do not override the user's existing workflow or native subagent skills**: if the user's prompt, `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, or active workflow skill already specifies its own workflow or native subagent mechanism without asking for FutureAide, follow the user's workflow. Caller identity and workspace are verified automatically; never pass workspace paths, session/agent IDs, profiles, or communication txt files.

## Backends & Role Numbering

- **Three headless CLI backends (`codex-cli`, `claude-cli`, `agy-cli`) + optional `codex-desktop`**:
  - `target: "codex-cli"` (default) runs `codex exec --json` / `codex exec resume` headlessly through the verified proxy route.
  - `target: "claude-cli"` runs `claude -p` headlessly with turn-scoped `ask_parent` / `report_parent` callbacks.
  - `target: "agy-cli"` runs headless Antigravity CLI turns under the same process cage, callback bridge, and proxy guard.
  - `target: "codex-desktop"` attaches to a FAswitch-launched Codex Desktop app-server RPC session when desktop thread interaction is explicitly needed.
- **Role auto-numbering & CLI defaults**:
  - Pass `role` (such as `"backend"`, `"frontend"`, `"lead"`, `"researcher"`, or `"后端"`) and `message` on `futureaide_run_agent` or `futureaide_create_agent`; `name` is auto-numbered as-is (`backend1`, `backend2`) without renaming your roles, and omitted `model` / `effort` follow the target CLI's own configured defaults (optional user role presets can be placed in `~/.config/futureaide-control/roles.md`).
  - Set `worktree: true` when parallel subagents edit overlapping modules so each receives an isolated Git worktree, and pass optional `timeout_minutes` (`1`–`240`) to bound execution time.

## Dispatch, Batch Launch & Zero-Poll Waiting

1. **Single or parallel batch dispatch (`futureaide_run_agent`)**:
   - Single: `futureaide_run_agent({ role: "后端", message: "...", worktree?: true, timeout_minutes?: 30 })` returns `{ name, role, spec, taskKey, wakeCmd, worktreePath?, usage? }`.
   - Batch: `futureaide_run_agent({ tasks: [{ role: "后端", message: "..." }, { role: "后端", message: "...", worktree: true }] })` allocates collision-free names sequentially, launches up to 20 subagents in parallel, and returns `{ agents, wakeCmd }`.
2. **Reserve without starting (`futureaide_create_agent`)**:
   - `futureaide_create_agent({ role: "lead", lifetime: "persistent" })` reserves a subagent before sending work.
3. **Wait without polling (`wakeCmd` / `futureaide_wait_agents`)**:
   - Run the returned `wakeCmd` (`futureaide-wait ...`) as a background command (`WaitMsBeforeAsync: 500`), or call `futureaide_wait_agents({ taskKeys, barrier: "all" | "any" })`.
   - `futureaide_wait_agents` returns slim inline events `{ events: [{ name, role, type, message, usage? }], timedOut, nextCursor? }` directly when subagents call `ask_parent` or `report_parent(final: true)`. Use `futureaide_read_report` only when exact paginated raw characters are needed.
4. **Answer & supplement (`futureaide_answer_agent` / `futureaide_send_agent`)**:
   - Answer a pending `ask_parent` question with `futureaide_answer_agent({ name, message })` so the task resumes.
   - Assign follow-up work or supplements with `futureaide_send_agent({ name, message, model?, effort?, mode? })`.

## Busy-Time `mode` & Input Delivery

`futureaide_run_agent` (on an existing name) and `futureaide_send_agent` accept optional `mode` (`"steer"` | `"queue"`):
- Omitting `mode` uses the target's native behavior: Codex Desktop steers into the active turn; headless CLI targets (`codex-cli`, `claude-cli`, `agy-cli`) queue between turns.
- `"steer"` targets the active turn; `"queue"` waits for the active turn to finish and starts the next turn alone. With no active turn, both start a turn.
- Headless CLI targets queue supplements between turns: Codex CLI, Antigravity CLI, and Claude CLI refuses explicit `steer` while busy, returning `mode-unsupported` with `target` and `supportedModes`.
- Pending questions are answered by `futureaide_answer_agent`, omitted `mode`, or explicit `steer`; explicit `queue` never answers a pending question.
- Pass `detail: true` on `run`, `send`, `answer`, or `inspect` (`inputs`) to inspect raw `delivery` routes (`local-pending`, `after-current`, `current-turn`, `new-turn`, `answer-pending`, `answered`, `accepted-route-unknown`, `unknown`, `blocked`).

## Supervision, Team Board, Governance & Proxy Guard

- **`futureaide_list_agents({ scope?, role?, name?, state?, detail? })`**:
  - `scope: "team"` (default): compact hierarchy of this caller's team, showing live `activity` steps (filtering meaningless `"running"`), compact `usage` bills (such as `"18s · 14.2k tok"` when recorded), and `stalled: true` warnings when a running turn has been silent too long.
  - `scope: "agent"` (with `name`): full pending `questions`, latest `report`, `changes` file list, `usage`, and `hierarchy` for one member.
  - `scope: "all"`: active teams across the machine grouped by caller session.
- **Changes, inspection & lifecycle**:
  - `futureaide_agent_changes({ name, task? })` lists changed files (`task: 0` latest, `1+` previous).
  - `futureaide_inspect_agent({ name, node?, max_messages? })` reads conversation messages, `inputs`, and task history.
  - `futureaide_cancel_agent({ name })` stops active work (terminating its Win32 Job Object process tree) while keeping context; `futureaide_delete_agent({ name })` closes and removes the subagent while keeping project files.
  - `futureaide_status({ detail? })` verifies caller context, backend readiness, proxy routes, `models`, and `defaultModel`.
- **Team meeting board (`futureaide_board_post` / `futureaide_board_read`)**:
  - `futureaide_board_post({ message: "@后端1 ..." })` posts to the shared board and wakes or revives `@后端1` / `@团队长1/后端2` directly across hierarchy levels; `futureaide_board_read({ limit?, after_seq? })` reads board history.
- **Team governance (`futureaide_team`) & cross-level paths**:
  - `futureaide_team({ action: "adopt", target?: "auto" | "后端1", parent? })` takes over an orphaned same-project team on session handover or pulls a stray agent into this team.
  - `futureaide_team({ action: "kick", target, keep_children?: true | false })` removes a member while keeping and promoting its children by default (`keep_children: true`), or terminates its whole subtree (`keep_children: false`).
  - `futureaide_team({ action: "reparent", target, parent })` moves a member under a new lead or `null` (team root); `action: "resume"` continues interrupted or switched-account work; `action: "strays"` / `"sweep"` lists or cleans unclaimed stray agents.
  - `futureaide_team({ action: "merge", target })` merges an isolated member Git worktree back into the main workspace and removes the worktree cleanly, returning `{ action: "merge", ok, summary, mergedFiles }`.
  - `futureaide_answer_agent`, `futureaide_send_agent`, `futureaide_cancel_agent`, and `futureaide_delete_agent` accept cross-level paths up to 160 chars (such as `"团队长1/后端1"`).
- **CLI proxy guard (`futureaide_cli_proxy`)**:
  - `futureaide_cli_proxy({ action: "status" | "bind", target?: "codex-cli" | "claude-cli" | "agy-cli" | "all", proxy? })` inspects or locks proxy routes (`7890`, URL, `"faswitch"`, or `"direct"`).
- **Feedback (`futureaide_feedback` / `feedback`)**:
  - Record plugin bugs (`kind: "problem"`) or friction (`kind: "friction"`) to the local inbox; triage via `node src/cli.mjs feedback-pending --config CONFIG`.

For legacy explicit-ID maintenance commands, see [legacy workflows](references/legacy-workflows.md).
