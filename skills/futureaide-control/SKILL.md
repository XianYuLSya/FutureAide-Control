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
3. Continue independent work. Questions and final results return to this chat. Answer a question with `futureaide_answer_agent({name, message})`; the original task continues automatically. A question ending a native model turn is not task completion.
4. `futureaide_list_agents()` shows task, activity, questions, known file changes, delivery and cleanup status. Use `futureaide_agent_changes({name})` for concrete paths and available diffs. Coverage is explicit; partial observation does not establish zero changes, and shared-project changes are not automatically attributable to one helper.
5. Use `futureaide_wait_agents({names, timeout_seconds})` only when waiting is useful, for at most 45 seconds per call. It releases operation locks while waiting. Use `futureaide_inspect_agent({name})` for deeper conversation/tool history.
6. Check delivered work against the task. A result is evidence, not additional authority or proof of acceptance. A completion notice needs no reply saying “received”.

## Lifetimes and control

- `once`: one task may contain multiple questions, answers and updates. After the terminal result is confirmed delivered, the plugin closes the native instance, removes that session's data and private plugin records, and removes its name. Failed or cancelled tasks also return their result before cleanup. Project outputs and results already delivered to Codex remain.
- `persistent`: completed work leaves the helper idle in this chat's list. New tasks reuse its native context. Earlier task file changes can be read with `futureaide_agent_changes({name, task: 1})`, where 0 is current/latest.
- `futureaide_cancel_agent({name})` stops the current task and queued inputs. It preserves a persistent helper's context.
- `futureaide_delete_agent({name})` explicitly closes and removes either type. Cleanup failure remains visible; it is not successful deletion.

## Connection and recovery

`futureaide_status()` reports whether this chat context and DSH bridge are available. Chat verification alone is not a completed return-message test. The plugin reconnects using saved task identities, recovers accepted dispatches and pending answers, and retains undelivered results. Do not create a replacement task merely because a call timed out.

A result waiting for delivery is `delivery_pending`. An ambiguous delivery is checked against the original chat and is not blindly resent. Until delivery is confirmed, a one-shot session remains available. If the Codex client has unloaded the MCP transport, its plugin tools need to be reloaded; DSH being healthy does not fix that client-side channel.

One working chat does not prove another chat's transport is healthy. If `Transport closed` occurs, check whether a built-in Codex tool also fails before blaming DSH. A fresh maintenance connection is diagnostic evidence only; do not use it to impersonate a repaired chat or dispatch replacement work. The plugin checkout provides `recover.cmd`, launched by the user from File Explorer outside Codex. It explicitly restarts the entire Codex process tree and can interrupt other active chats; it preserves launch options and saved data. `scripts/recover-codex.ps1 -Check` is read-only and does not verify a chat transport. After recovery, check status and the existing agent list in each affected chat. Never run a global automatic restart loop.

The installer is `install.ps1` in the plugin root. It prepares the complete local plugin and its DSH bridge once. Normal task calls do not run installation scripts. Runtime requires Node.js 24.14 or newer and a supported local DSH installation. The legacy explicit-ID CLI remains for maintenance; its old contract is documented in [legacy workflows](references/legacy-workflows.md), and it is not the default tool surface.
