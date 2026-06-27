---
name: ai-bridge
description: Use when the user wants Codex to plan, verify, or review while delegating confirmed implementation work to Claude Code, DeepSeek-backed Claude Code, or an AI Bridge automation loop.
---

# AI Bridge

AI Bridge v0.4.1 coordinates a confirmation-based loop with workspace-level recovery and persisted Run Explorer tools:

1. Codex plans the work.
2. The user explicitly confirms a Claude execution iteration.
3. For a new task, `ai_bridge_preflight` creates a run, records git baseline, checks Claude CLI capabilities, and infers verification commands.
4. `ai_bridge_prepare_plan_handoff` wraps an approved Plan Mode `<proposed_plan>` when applicable.
5. `ai_bridge_start_claude_iteration` starts the local `claude` CLI in a run-scoped session.
6. Codex polls `ai_bridge_poll_claude_iteration` and shows summarized Claude events.
7. Codex snapshots git changes, runs verification, reviews code, records pass/needs_fix/blocked, and summarizes usage.
8. `needs_fix` unlocks the next iteration; terminal run states stop the loop.

## Hard Boundaries

- Do not call `ai_bridge_start_claude_iteration` until the user has confirmed that specific execution.
- Require a git workspace. If `ai_bridge_preflight` rejects the directory, stop and explain that AI Bridge requires git.
- Treat dirty preflight state as user-owned work. Show the baseline and dirty status before letting Claude modify files.
- Do not read, request, store, or modify DeepSeek or Claude API keys.
- Default to at most 3 Claude iterations unless the user explicitly sets another limit. The server enforces `maxIterations`.
- Do not reuse a run id for unrelated work.
- Plan Mode output is not executable approval by itself. Only hand off a `<proposed_plan>` when the user explicitly approves that plan for AI Bridge or Claude Code execution.
- Do not invent model prices. Cost output is token usage plus optional same-token hypothetical estimate from user-supplied pricing.

## State Machine

Runs have explicit states: `ready`, `running`, `awaiting_review`, `needs_fix`, `passed`, `blocked`, `failed`, `timed_out`, and `cancelled`.

Rules enforced by the server:

- Iteration numbers start at 1 and cannot skip or repeat.
- A run can have only one active Claude task.
- Iteration 2+ can start only after a `needs_fix` review.
- `passed`, `blocked`, and `cancelled` runs cannot continue.
- `recordReview` requires the iteration to have completed.

## Workflow

1. When the user asks to continue, reconnect, recover, poll a previous task, or see where AI Bridge stopped, call `ai_bridge_discover_workspace_runs(workspacePath)` first.
2. Attach an unambiguous active run with `ai_bridge_attach_workspace_run`, then use `ai_bridge_poll_workspace_run`; do not ask the user to find a runId or taskId.
3. If discovery returns multiple candidates, show the ranked candidates and require the user to select a runId. Never pick a directory-order winner.
4. Only when discovery has no candidate, or the user explicitly requests a new run, call `ai_bridge_preflight` with absolute `workspacePath`, user task, optional `maxIterations`, and explicit verification commands.
5. If preflight reports an existing active workspace run, attach it or require explicit `allowConcurrentRun=true`; do not silently create a duplicate run.
6. Summarize run id, git root, dirty baseline, inferred verification commands, Claude version, session id, and resume mode.
7. Continue the confirmed plan handoff and iteration workflow below.

For an explicitly new run:

1. Run `ai_bridge_preflight` after workspace discovery has established that a new run is appropriate.
2. Summarize run id, git root, dirty baseline, inferred verification commands, Claude version, session id, and resume mode.
3. If the user approved a recent Plan Mode `<proposed_plan>`, call `ai_bridge_prepare_plan_handoff` using the exact preflight `runId`; never fabricate a UUID.
4. Use the returned `handoffPrompt`, or draft a focused prompt with goal, scope, constraints, and verification commands.
5. Confirm the exact Claude run with the user, then call `ai_bridge_start_claude_iteration`.
6. Poll every 3-5 seconds with `ai_bridge_poll_claude_iteration(taskId, cursor)`, show new summaries, and advance `cursor`.
7. Continue until status is terminal.
8. Call `ai_bridge_snapshot_changes`.
9. Call `ai_bridge_run_verification` when verification commands are available or explicitly requested.
10. Review changed files and classify as `pass`, `needs_fix`, or `blocked`.
11. Call `ai_bridge_record_review`.
12. Call `ai_bridge_summarize_costs`; include pricing only when the user supplied it.

Use `ai_bridge_cancel_iteration` if a running Claude task should be cancelled.
The legacy synchronous Claude iteration tool is not exposed; start/poll/cancel is the only supported execution path.

## Run Explorer

Use these tools to inspect persisted work without starting Claude:

- `ai_bridge_list_runs`: list runs globally or for one workspace, ranked by workflow status then update time, with status/age filters and corrupt-state diagnostics.
- `ai_bridge_inspect_run`: summarize one run, its tasks, recent transcript events, verification history, and usage.
- `ai_bridge_tail_run`: read summarized transcript events by runId and cursor.
- `ai_bridge_show_run_diff`: compare the workspace with the preflight baseline; raw patches are opt-in, bounded, and redacted. Use `sensitivePathWarnings` for reasoned warnings; `sensitivePaths` remains compatible.
- `ai_bridge_show_verification`: read historical verification results without executing commands.
- `ai_bridge_export_run`: write a redacted JSON or Markdown report; it refuses to overwrite an existing file.

Prefer the Run Explorer for historical diagnosis and reporting. It is not an execution path and does not replace explicit confirmation before a Claude iteration.

## Workspace Recovery

Trigger workspace recovery when the user says things such as "continue the previous task", "reconnect Claude", "recover this project", "poll the earlier task", or "show where AI Bridge stopped".

1. Call `ai_bridge_discover_workspace_runs` with the current git workspace.
2. If one candidate is returned, call `ai_bridge_attach_workspace_run`.
3. If multiple candidates are returned, ask the user to select from the ranked list and attach with that runId.
4. Call `ai_bridge_poll_workspace_run` without requiring a taskId.
5. For a running task, continue polling the same task and cursor. For a terminal task, read the transcript/final summary and do not present it as running.
6. For a `needs_fix` run, prepare and explicitly confirm the next iteration on the same run. The stored `claudeSessionId`, iteration ordering, resume mode, and maxIterations remain authoritative.

The workspace index is an accelerator only. Discovery scans authoritative run state if the index is missing or corrupt. A moved-workspace fingerprint match is best-effort and requires explicit `confirmMovedWorkspace=true`; never treat it as an exact path match.

Workspace recovery does not guarantee automatic MCP client reconnection or retroactive live push replay. It discovers and attaches persisted state after Codex is reopened.

## Claude Session Continuity

AI Bridge creates one `claudeSessionId` per run. Iteration 1 uses `--session-id <id>`.
If `claude --help` advertises `--resume`, later iterations use `--resume <id>`; otherwise AI Bridge records and uses a `--session-id` fallback.

Prompt text is sent through stdin, never as a command-line argument.
User-supplied `claudeArgs` are allowlisted and cannot override session, resume, output format, permission mode, MCP config, or prompt input mode.
Free-text `--append-system-prompt` is rejected as a user override. Tool allowlists and model names are structurally validated, and Windows shell metacharacters are refused.

Even with session continuity, include critical review findings and failed verification evidence in the next prompt.

## Git Review Requirements

Every review should mention:

- `baselineInvalidated`
- pre-existing changes
- changes created after preflight
- modified pre-existing changes
- pre-existing untracked files and modified pre-existing untracked files
- pre-existing staged changes and modified pre-existing staged changes
- staged, unstaged, untracked, and renamed files
- verification commands run and results
- actionable findings with file references when possible

Do not claim Claude created a file or modification that existed before preflight.

## Live Transcript Display

AI Bridge stores raw Claude stream-json as `iteration-<n>.stream.jsonl` and summarized transcript as `iteration-<n>.transcript.jsonl`.

Display:

- `Claude: ...` for assistant text
- `Tool: ...` for tool starts
- `Tool result: ...` for tool results
- `Error: ...` for stream errors

If poll reports `corruptTranscriptLines`, mention that the transcript had recoverable damaged lines.

## Cancellation And Recovery

`ai_bridge_cancel_iteration` terminates the Claude process tree, writes the final iteration log, sets the task and run to `cancelled`, and clears `activeTaskId`.

On MCP server startup, AI Bridge scans persisted running tasks. Orphaned or mismatched processes are marked failed and detached from the run; still-live matching processes can be polled or cancelled.

## Usage Summary

`ai_bridge_summarize_costs` reports:

- input tokens
- output tokens
- cache creation input tokens
- cache read input tokens
- cache hit rate

With pricing, report it as a same-token hypothetical estimate only. Do not call it real savings.
