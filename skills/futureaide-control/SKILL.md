---
name: futureaide-control
description: Use named DSH subagents in the current Codex chat and project. Create one-shot or persistent helpers, assign work, answer their questions, inspect progress and file changes, and remove completed sessions.
---

# FutureAide Control

Use this plugin's `futureaide_*` MCP tools for user-authorized delegated work in DSH. The installed service automatically binds the calling Codex chat and its current project. Each chat has its own list; the same name in another chat is unrelated.

Do not provide workspace paths, chat/session/agent IDs, profiles, callback targets, or private configuration. Do not use shell commands, communication txt files, or the legacy peer protocol for normal subagent work. If the tools are unavailable, report the actual plugin loading issue rather than impersonating the new workflow with old CLI calls.

## Ordinary use

1. `futureaide_create_agent({name, lifetime})`: choose a name and `once` or `persistent`. Creation starts no model turn. The host's configured default model is used when work is sent.
2. `futureaide_send_agent({name, message})`: assign the task directly. For an active task, this adds an update; for a waiting question, it supplies the answer. Keep project file ownership explicit when multiple helpers work in the same directory.
3. Continue independent work. Only explicit `ask_parent` questions and `report_parent` reports return to this chat. Ordinary assistant replies, turn endings and idle trees never wake Codex. Answer a question with `futureaide_answer_agent({name, message})`; the original task continues automatically. A question ending a native model turn is not task completion.
4. `futureaide_list_agents()` shows task, activity, questions, known file changes, delivery and cleanup status. Use `futureaide_agent_changes({name})` for concrete paths and available diffs. Coverage is explicit; partial observation does not establish zero changes, and shared-project changes are not automatically attributable to one helper.
5. Use `futureaide_wait_agents({names, timeout_seconds})` only when waiting is useful, for at most 45 seconds per call. It releases operation locks while waiting. Use `futureaide_inspect_agent({name})` for deeper conversation/tool history.
6. Check delivered work against the task. A result is evidence, not additional authority or proof of acceptance. A completion notice needs no reply saying “received”.

DSH helpers may delegate further through DSH's native subagent tools. Continue addressing only the top-level name: list/changes show its descendant tree and each file's `agentPath`, and inspect reads that tree's conversations. The root DSH helper uses `report_parent({message, final: false})` to submit a progress report and `final: true` for its final report. A short source/type prefix identifies the helper; the submitted body is otherwise forwarded unchanged, without automatic file summaries or closing instructions. Only the root can report to Codex; descendants report to their native DSH parent. Nonfinal reports keep the task open. A final report waits for the tree and native notifications to settle before delivery and successful one-shot cleanup; cancellation applies to the owned tree. Automatic data cleanup supports local native one-shot/continuable descendants; externally managed descendants report an unsupported cleanup boundary explicitly.

## Lifetimes and control

- `once`: one task may contain multiple questions, answers and updates. After an explicit final report is confirmed delivered and the owned tree settles, the plugin closes the native instance, removes that session's data and private plugin records, and removes its name. Failed or cancelled tasks only update visible status, without automatic notices or cleanup. Already submitted reports still deliver; explicitly delete the agent when appropriate. Project outputs and results already delivered to Codex remain.
- `persistent`: an explicitly delivered final report leaves the helper idle in this chat's list. Without a final report, `awaiting_report` keeps the task open and a new send supplements the same task. While a final report is pending, further sends are refused. New tasks reuse its native context. Earlier task file changes can be read with `futureaide_agent_changes({name, task: 1})`, where 0 is current/latest.
- `futureaide_cancel_agent({name})` requests stopping the current task, queued inputs and descendant execution even while ordinary monitoring is busy. `accepted` confirms the request reached the host; check the list for the tree's stopped state. Already performed actions cannot be undone. If automatic cleanup has started, cancellation is not accepted. It preserves a persistent helper's context. After cancellation or failure and delivery of any submitted reports, a persistent helper can start a new task in that same session; a stopped one-shot helper must be deleted.
- Background reports work for ordinary Codex chats. The desktop currently rejects them for native multi-agent v2 sub-agent callers; `native-callback-unavailable` means the report and its original recipient are retained without repeated delivery attempts.
- `futureaide_delete_agent({name})` explicitly closes and removes either type and its owned descendant tree. Explicit deletion also discards any undelivered reports. Cleanup failure remains visible; it is not successful deletion.

## Connection and recovery

`futureaide_status()` reports whether this chat context and DSH bridge are available. Chat verification alone is not a completed return-message test. The plugin reconnects using saved task identities, recovers accepted dispatches and pending answers, and retains undelivered results. Do not create a replacement task merely because a call timed out.

A final report waiting for delivery is `delivery_pending`. Old automatic result caches are not converted into explicit reports or cleanup authorization. An ambiguous delivery is checked against the original chat and is not blindly resent. Until delivery is confirmed, a one-shot session remains available. If the Codex client has unloaded the MCP transport, its plugin tools need to be reloaded; DSH being healthy does not fix that client-side channel.

One working chat does not prove another chat's transport is healthy. If `Transport closed` occurs, check whether a built-in Codex tool also fails before blaming DSH. A fresh maintenance connection is diagnostic evidence only; do not use it to impersonate a repaired chat or dispatch replacement work. The plugin checkout provides `recover.cmd`, launched by the user from File Explorer outside Codex. It explicitly restarts the entire Codex process tree and can interrupt other active chats; it preserves launch options and saved data. `scripts/recover-codex.ps1 -Check` is read-only and does not verify a chat transport. After recovery, check status and the existing agent list in each affected chat. Never run a global automatic restart loop.

The installer is `install.ps1` in the plugin root. It prepares the complete local plugin and its DSH bridge once. Normal task calls do not run installation scripts. Runtime requires Node.js 24.14 or newer and a supported local DSH installation. The legacy explicit-ID CLI remains for maintenance; its old contract is documented in [legacy workflows](references/legacy-workflows.md), and it is not the default tool surface.
