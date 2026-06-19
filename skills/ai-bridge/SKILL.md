---
name: ai-bridge
description: Use when the user wants Codex to plan or review while delegating implementation to Claude Code, DeepSeek-backed Claude Code, or an AI Bridge automation loop.
---

# AI Bridge

AI Bridge coordinates a confirmation-based loop:

1. Codex plans the work and prepares a Claude Code handoff prompt.
2. The user confirms the iteration.
3. `ai_bridge_start_claude_iteration` starts the local `claude` CLI in a fixed Claude Code session.
4. Codex polls `ai_bridge_poll_claude_iteration` and shows summarized Claude Code events in the current Codex thread.
5. Codex snapshots the git diff, runs or reports verification commands, reviews code, and records an outcome.
6. If the outcome is `needs_fix`, Codex prepares the next Claude prompt and waits for user confirmation.

## Hard Boundaries

- Do not call `ai_bridge_start_claude_iteration` or `ai_bridge_run_claude_iteration` until the user has confirmed that specific execution.
- Require a git workspace. If `ai_bridge_preflight` rejects the directory, stop and explain that v1 does not support non-git directories.
- Treat a dirty git tree as user-owned work. Show the dirty status and ask for confirmation before letting Claude modify files.
- Do not read, request, store, or modify DeepSeek or Claude API keys. This plugin uses whatever `claude` command is already configured on the machine.
- Default to at most 3 Claude iterations unless the user explicitly sets another limit.
- Codex is responsible for final review. Do not trust Claude's success report without checking the diff and verification evidence.
- Claude Code continuity is scoped to one AI Bridge run. Do not reuse a run id for an unrelated task.

## Workflow

1. Run `ai_bridge_preflight` with:
   - `workspacePath`: absolute target repository path.
   - `task`: the user's task.
   - `maxIterations`: default 3 unless overridden.
   - `verificationCommands`: only when the user gives explicit commands.
2. Summarize preflight:
   - run id
   - git root
   - dirty status
   - inferred verification commands
   - Claude Code version
   - Claude Code session id
3. Draft a concise Claude handoff prompt containing:
   - goal and constraints
   - exact implementation scope
   - tests to run
   - instruction to keep changes focused and report files changed
4. Ask for confirmation before calling `ai_bridge_start_claude_iteration`.
5. After start returns, set `cursor` to 0 and poll `ai_bridge_poll_claude_iteration(taskId, cursor)` every 3-5 seconds.
6. After each poll, show the returned event summaries to the user and update `cursor` to `nextCursor`.
7. Continue polling until status is `completed`, `failed`, or `timed_out`.
8. Optionally call `ai_bridge_get_claude_transcript` after completion if you need a single archived transcript for review.
9. Call `ai_bridge_snapshot_changes`.
10. Run the inferred or user-provided verification commands yourself when appropriate.
11. Review changed files and classify the result:
   - `pass`: implementation meets the plan and verification is acceptable.
   - `needs_fix`: issues are actionable and another Claude iteration may fix them.
   - `blocked`: missing context, unsafe changes, repeated failure, or no meaningful progress.
12. Call `ai_bridge_record_review` with the outcome, findings, and verification command results.
13. For `needs_fix`, prepare the next Claude prompt from concrete findings and ask the user before continuing.

Use `ai_bridge_run_claude_iteration` only as a compatibility fallback when async polling is unavailable.

## Claude Code Session Continuity

AI Bridge creates one `claudeSessionId` per `runId` and passes it to Claude Code as `--session-id`.
All implementation iterations for that run use the same Claude Code conversation. This improves
cache locality and keeps Claude's execution context continuous while Codex still controls planning,
review, and confirmation gates.

Even with a continuous Claude Code session, include the important Codex review findings and failed
verification evidence in the next prompt. Do not rely only on Claude's memory of the previous turn.

## Live Transcript Display

AI Bridge stores raw Claude Code stream-json in `iteration-<n>.stream.jsonl` and a summarized transcript
in `iteration-<n>.transcript.jsonl`. Poll returns only transcript events after the cursor.

Display these summaries directly in the Codex thread:

- `Claude: ...` for assistant text.
- `Tool: ...` for tool or command starts.
- `Tool result: ...` for command results.
- `Error: ...` for stream errors.

Default to showing these events as they arrive. If the user asks for quiet mode, poll less often or
only show terminal status plus the final transcript.

## Review Requirements

Every review should mention:

- Changed files and diff stat.
- Verification commands run, skipped, or unavailable.
- Actionable findings with file references when possible.
- Whether another Claude iteration is recommended.

## Claude Prompt Template

```text
You are implementing one confirmed AI Bridge iteration in this git repository.

Goal:
<task>

Scope:
<files or subsystems>

Constraints:
- Keep changes focused.
- Preserve unrelated user changes.
- Do not manage API keys or credentials.
- Run these checks if available: <commands>

After editing, summarize:
- Files changed
- Commands run and results
- Any blockers
```
