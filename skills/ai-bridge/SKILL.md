---
name: ai-bridge
description: Use when the user wants Codex to plan or review while delegating implementation to Claude Code, DeepSeek-backed Claude Code, or an AI Bridge automation loop.
---

# AI Bridge

AI Bridge coordinates a confirmation-based loop:

1. Codex plans the work and prepares a Claude Code handoff prompt.
2. The user confirms the iteration.
3. If the input is an approved Plan Mode `<proposed_plan>`, `ai_bridge_prepare_plan_handoff` wraps it into a Claude execution prompt.
4. `ai_bridge_start_claude_iteration` starts the local `claude` CLI in a fixed Claude Code session.
5. Codex polls `ai_bridge_poll_claude_iteration` and shows summarized Claude Code events in the current Codex thread.
6. Codex snapshots the git diff, runs or reports verification commands, reviews code, records an outcome, and summarizes usage/costs.
7. If the outcome is `needs_fix`, Codex prepares the next Claude prompt and waits for user confirmation.

## Hard Boundaries

- Do not call `ai_bridge_start_claude_iteration` or `ai_bridge_run_claude_iteration` until the user has confirmed that specific execution.
- Require a git workspace. If `ai_bridge_preflight` rejects the directory, stop and explain that v1 does not support non-git directories.
- Treat a dirty git tree as user-owned work. Show the dirty status and ask for confirmation before letting Claude modify files.
- Do not read, request, store, or modify DeepSeek or Claude API keys. This plugin uses whatever `claude` command is already configured on the machine.
- Default to at most 3 Claude iterations unless the user explicitly sets another limit.
- Codex is responsible for final review. Do not trust Claude's success report without checking the diff and verification evidence.
- Claude Code continuity is scoped to one AI Bridge run. Do not reuse a run id for an unrelated task.
- Plan Mode output is not executable approval by itself. Only hand off a `<proposed_plan>` when the user explicitly says to approve that plan and use AI Bridge or Claude Code to execute it.
- Do not invent current model prices. Cost calculations require user-supplied `pricing`; without pricing, only report token usage and cache hit rate.

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
3. If the user explicitly approved a recent Plan Mode `<proposed_plan>` for Claude execution, call `ai_bridge_prepare_plan_handoff` with:
   - `runId`: the preflight run id.
   - `planText`: the exact approved plan text.
   - `task`: the user's task when useful.
   - `verificationCommands`: explicit or inferred commands when useful.
4. Use the returned `handoffPrompt` as the Claude prompt. If there is no approved Plan Mode handoff, draft a concise Claude handoff prompt containing:
   - goal and constraints
   - exact implementation scope
   - tests to run
   - instruction to keep changes focused and report files changed
5. Ask for confirmation before calling `ai_bridge_start_claude_iteration`.
6. After start returns, set `cursor` to 0 and poll `ai_bridge_poll_claude_iteration(taskId, cursor)` every 3-5 seconds.
7. After each poll, show the returned event summaries to the user and update `cursor` to `nextCursor`.
8. Continue polling until status is `completed`, `failed`, or `timed_out`.
9. Optionally call `ai_bridge_get_claude_transcript` after completion if you need a single archived transcript for review.
10. Call `ai_bridge_snapshot_changes`.
11. Run the inferred or user-provided verification commands yourself when appropriate.
12. Review changed files and classify the result:
   - `pass`: implementation meets the plan and verification is acceptable.
   - `needs_fix`: issues are actionable and another Claude iteration may fix them.
   - `blocked`: missing context, unsafe changes, repeated failure, or no meaningful progress.
13. Call `ai_bridge_record_review` with the outcome, findings, and verification command results.
14. Call `ai_bridge_summarize_costs` before the final user summary. Pass `pricing` only when the user supplied DeepSeek and Codex prices. Otherwise report usage and cache hit rate only.
15. For `needs_fix`, prepare the next Claude prompt from concrete findings and ask the user before continuing.

Use `ai_bridge_run_claude_iteration` only as a compatibility fallback when async polling is unavailable.

## Plan Mode Handoff

When Codex is in Plan Mode, the `<proposed_plan>` is a Codex-side proposal. It should not be sent
to Claude merely because it exists. A valid trigger is an explicit user approval such as
"approve this plan and run it through AI Bridge" or "approved; hand this plan to Claude Code".

After that approval:

1. Run preflight if there is no active `runId`.
2. Call `ai_bridge_prepare_plan_handoff`.
3. Show the generated handoff summary and ask for the execution confirmation if the user has not already confirmed this exact Claude run.
4. Start Claude with `ai_bridge_start_claude_iteration` using the returned `handoffPrompt`.

The handoff prompt must include the approved plan, target repo, execution boundaries, verification
commands, a warning not to modify unrelated files, and required completion reporting.

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

## Usage And Cost Summary

Claude stream-json usage is summarized per run. At the end of a review, call
`ai_bridge_summarize_costs`.

Report:

- input tokens
- output tokens
- cache creation input tokens
- cache read input tokens
- cache hit rate

If the user supplied `pricing`, also report DeepSeek cost, estimated Codex cost, savings amount, and
savings ratio. Pricing keys are per-million-token numbers:

```json
{
  "deepseek": {
    "inputPerMillion": 0,
    "outputPerMillion": 0,
    "cacheCreationInputPerMillion": 0,
    "cacheReadInputPerMillion": 0
  },
  "codex": {
    "inputPerMillion": 0,
    "outputPerMillion": 0,
    "cacheCreationInputPerMillion": 0,
    "cacheReadInputPerMillion": 0
  }
}
```

If prices were not supplied, say that only token and cache statistics are available.

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
