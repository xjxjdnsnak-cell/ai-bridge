# AI Bridge Context Handoff

## Project Status

- Project: AI Bridge
- Repository: `C:\Users\xsjhxs\Desktop\ai_bridge`
- Branch: `master`
- Final validated v0.3.5 source baseline: `2d260d58659483d5054ab762e2323a1fa5c0e526`
- This is the last validated SHA, not a guarantee that future repository HEAD remains identical.
- Repository HEAD is intentionally not hardcoded in this document because committing a handoff update changes HEAD.
- At the start of every new conversation, resolve the live repository HEAD with `git rev-parse HEAD` and compare it with the final validated source baseline.
- All later commits must be inspected before assuming they are documentation-only.
- npm package version: `0.4.0`
- Codex plugin version: `0.4.0+codex.20260627120000`
- Node: `v22.22.1`
- Python: `3.12.7`
- Claude Code: `2.1.105`

AI Bridge v0.4.0 is a personal Codex plugin that coordinates a confirmation-based loop where Codex plans, verifies, and reviews while local Claude Code performs explicitly approved implementation iterations. It adds workspace-level persisted run discovery and attach after Codex or the MCP server is reopened.

The retained v0.3.5 durable foundation includes:

- Asynchronous Claude execution through `ai_bridge_start_claude_iteration`, `ai_bridge_poll_claude_iteration`, and `ai_bridge_cancel_iteration`.
- A durable worker process (`mcp/worker.mjs`) that owns Claude stdout/stderr, stream/transcript persistence, heartbeat updates, timeout deadlines, and terminal task/run/final writes independently of the MCP server process.
- Exclusive cross-process state locks and monotonically increasing `revision` fields for lifecycle task/run mutations.
- Worker-owned v0.3 cancel requests through persisted `cancelRequestedAt`, `cancelRequestId`, and `cancelReason`; the server no longer directly finalizes a live worker-owned task.
- Three-state process identity handling: `matched`, `mismatched`, and `unverifiable`. Unknown or unverifiable Claude processes are not killed automatically.
- Run-scoped Claude session continuity through `claudeSessionId`, using `--session-id` for iteration 1 and `--resume` when supported for later iterations.
- State machine enforcement for iteration order, active task ownership, terminal run states, and max iteration limits.
- Process-tree cancellation, terminal-owner conflict diagnostics, and once-only finalization for cancel, timeout, error, close, and worker-orphan paths.
- MCP server startup recovery for persisted worker-owned running tasks and incomplete terminal finalization phases, with unified startup ownership classification for poll/recovery/cancel, worker adoption from `worker_spawned` reservations, worker identity checks for v0.3.x tasks, and legacy Claude PID compatibility for v0.2.x task files.
- Launcher identity checks that compare PID, process start time, executable, and command line when available, rather than treating a live PID alone as ownership proof.
- Structured stdin error evidence fields (`stdinErrorObserved`, `stdinErrorCode`, `stdinErrorAt`) when stdin error listeners run.
- Git baseline capture that separates pre-existing workspace state from changes created after preflight.
- Prompt delivery through stdin, with strict user `claudeArgs` validation for Windows argument safety.
- Token usage aggregation and optional user-supplied pricing comparison.

The v0.4.0 workspace recovery layer adds:

- `ai_bridge_discover_workspace_runs` for ranked persisted run candidates by workspace path.
- `ai_bridge_attach_workspace_run` for observing one unambiguous or explicitly selected run without starting Claude.
- `ai_bridge_poll_workspace_run` for polling by workspace/run without requiring taskId.
- realpath-based workspace normalization, SHA-256 workspace keys, and best-effort moved-workspace fingerprints.
- a fenced workspace index that accelerates lookup while retaining authoritative `run.json` scanning fallback.
- legacy v0.3.5 path discovery and fenced lazy identity backfill.
- preflight duplicate protection with `reuseExisting` and explicit `allowConcurrentRun`.

The public MCP tool set intentionally does not expose the legacy synchronous `ai_bridge_run_claude_iteration` entry point.

## Recently Completed Validation

Durable runner validation for v0.3.5 is covered by automated fixture tests and a controlled local recovery validation recorded in `docs/validation/durable-runner-fixture.md`. This validation uses a fake Claude CLI that emits stream-json and long-running child-process behavior; it does not call the real Claude API.

On 2026-06-24, AI Bridge v0.2.1 passed a real Claude Code long-task recovery/cancel validation. The detailed validation record is in `docs/validation/real-claude-recovery-cancel.md`.

Validated object:

- `runId`: `run-20260624082321-bjd0ej`
- `taskId`: `task-20260624082700-u4pqc8`
- iteration: `1`
- Claude sessionId: `c6272563-3c92-4d70-b6bd-24f41e91d5f7`
- temporary workspace: `C:\Users\xsjhxs\AppData\Local\Temp\ai-bridge-real-claude-recovery-20260624162307`

Conclusion:

After a new MCP server instance started and loaded persisted state, the original run and task remained recoverable and cancellable.

Important scope limit:

MCP connection interruption does not imply realtime stream-json backfill after reconnect. The validation proves persisted task recovery and cancellation, not replay of all disconnected live output.
The validation confirmed:

- No new run was created.
- No second iteration was started.
- After a new MCP server instance started and loaded persisted state, the original task was still recognized as `running`.
- The original `runId`, `taskId`, iteration, PID, and Claude sessionId remained consistent.
- Cancel reached the original task.
- Claude PID `31004` and Bash child PIDs `62580` and `55772` were terminated.
- The task and run reached stable `cancelled` state.
- `CLAUDE_RECOVERY_MARKER.txt` was not created.
- The temporary repository and AI Bridge source repository both had empty `git status --short` output.

## Test And Verification Status

Latest verified local commands:

- `npm run check`: passed
- `npm test`: passed, 77/77 tests, 0 failed, 0 skipped, duration 413.254s
- `node --test tests/workspace-recovery.test.mjs`: passed repeatedly, 11/11 focused workspace tests
- `npm run test:integration`: passed, final fake-Claude task completed
- `python C:\Users\xsjhxs\.codex\skills\.system\skill-creator\scripts\quick_validate.py skills\ai-bridge`: passed
- `python C:\Users\xsjhxs\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py .`: passed
- `git diff --check`: passed, with Windows LF-to-CRLF checkout warnings only
- Installed plugin cache validation is not claimed for v0.4.0 in this source-tree run. Source-level plugin validation is required before commit.

CI check guidance:

- Resolve live CI with `gh run list --branch master --limit 5` and `gh run view <runId> --json status,conclusion,jobs,url,headSha`.
- v0.4.0 final source SHA and CI run are pending the implementation commit and must replace this pending note after push.
- Initial v0.4.0 CI run `28279137039` exposed a workspace terminal attach race on Windows: task state was `completed` while the earlier run snapshot still read `running`. Attach now completes idempotent terminal finalization and rereads the run before returning.
- Follow-up run `28279432880` showed the same test could transition from running to terminal inside attach's poll branch. The terminal reconciliation is now a common post-poll step, covering both initially-terminal and poll-became-terminal tasks.
- Historical v0.3.5 validation:
- Final v0.3.5 validation-gap SHA: `2d260d58659483d5054ab762e2323a1fa5c0e526`
- GitHub Actions run: `28277243715`
- `test (ubuntu-latest)`: success
- `test (windows-latest)`: success
- `npm test`: 66/66
- Both jobs ran `npm run check`, `npm test`, and `npm run test:integration`.
- The previous SHA `2c69843f3603fcbb50f0b630a50a9c3b44edcc6a` and run `28234599534` are historical v0.3.5 baseline validation, not the final validation-gap commit; that historical run passed 62/62 tests.

Real Claude Code validation:

- Real long-running foreground Bash command was started by Claude Code.
- A new MCP server instance was started while the task was still running and loaded persisted state.
- Recovery preserved the original running task identity.
- Cancellation terminated Claude and the long-running Bash process tree.
- Final state was `cancelled`, not success.

Durable runner fixture validation:

- Server-owned lifecycle was replaced with a worker-owned lifecycle.
- Worker remains alive after the short-lived starter process exits.
- Output produced while the starter/server process is gone is preserved in transcript files.
- Natural completion, timeout, recovery cancel, worker-orphan diagnosis, fenced lock contention, recoverable start reservations, worker adoption from `worker_spawned`, poll protection for live `task_created` startup reservations, launcher PID reuse mismatch detection, structured stdin error listener evidence, stream-log/task creation crash recovery, worker spawn/stdin/early-exit faults, concurrent run/task revision writes, incomplete terminal finalization recovery, stale terminal conflicts, strict process identity, corrupt/conflicting final-log rebuilds, cancellation races, and concurrent start reservation are covered by `tests/durable-worker.test.mjs`, `tests/state-consistency.test.mjs`, and `tests/durable-faults.test.mjs`.
- Before `startupDeadlineAt`, unverifiable launcher or worker identity now remains a structured waiting state unless a definite identity mismatch is observed. Poll, recovery, and cancel share this classification and do not prematurely finalize or kill an unknown process.
- Fixture-created bridge homes, repositories, fake Claude directories, and stale lock files are registered for awaited cleanup. Cleanup first terminates only PIDs recorded by the isolated test bridge home, then removes the temporary roots with bounded Windows retry handling.
- The fixture validation does not call the real Claude API.

## Known Issues And Risks

No current release-blocking issue is known for the historical v0.3.5 release candidate. v0.4.0 remains under validation until its final source SHA passes local and dual-platform CI checks.

Known non-blocking limitations:

- MCP connection interruptions do not provide real-time replay after reconnection. Output received by the worker while the MCP server is offline is persisted to files and can be read after workspace attach, but the client does not receive a retroactive live push stream.
- Full MCP client disconnect and automatic reconnect behavior was not validated.
- Windows `.cmd` and `.bat` execution still relies on a constrained shell wrapper where required by the platform. Existing strict argument validation remains part of the safety boundary.
- Windows `taskkill.exe` output can appear as mojibake in logs on Chinese Windows environments. This affects readability of `killResult.stdout`; v0.3.5 keeps this as a non-blocking diagnostics/readability limitation.
- PID identity checks are best-effort and rely on available cross-platform process identity fields. A live PID alone is not treated as proof of launcher or worker ownership.
- Fenced writes reject stale owners before their next write, but do not claim a formal filesystem CAS guarantee across the second fence check and rename if an external actor force-deletes lock files.
- Git baseline hashing skips files beyond configured size limits and reports skipped hash reasons instead of reading large files.

## Key File Map

- `mcp/core.mjs`: running state, Claude lifecycle, persistence, cancellation, and recovery core logic.
- `mcp/worker.mjs`: durable task worker that owns Claude execution, logs, heartbeat, deadline, and finalization.
- `mcp/server.mjs`: MCP stdio server and public tool registration.
- `.mcp.json`: MCP server configuration used by Codex.
- `.codex-plugin/plugin.json`: Codex plugin manifest and version metadata.
- `tests/*.test.mjs`: unit and behavior tests.
- `tests/integration.mjs`: MCP integration test.
- `README.md`: workflow, installation, commands, safety boundaries, state files, and recovery documentation.
- `docs/validation/real-claude-recovery-cancel.md`: real Claude recovery/cancel validation evidence for the v0.2.1 code baseline.
- `docs/validation/durable-runner-fixture.md`: controlled fixture validation evidence for v0.3.x durable worker behavior.
- `docs/validation/v0.4.0-workspace-recovery.md`: v0.4.0 workspace discovery, attach, poll, identity, index, and compatibility validation.

## Next Tasks

1. Complete final-SHA dual-platform CI for v0.4.0 workspace recovery.
2. Decide separately whether to create a version tag or GitHub Release.
3. Consider full MCP client reconnect automation testing in a later version.
4. Consider Windows shell-wrapper hardening and taskkill output encoding cleanup in a later version.

Current publication state:

- No tag has been created.
- No GitHub Release has been created.
- No marketplace, package, or plugin publication has been performed.

Avoid combining lifecycle/finalization changes with Windows process-launch changes in the same work item, because both affect task lifetime and failure diagnosis.

## New Conversation Startup Checklist

1. Read `CONTEXT_HANDOFF.md`.
2. Read `README.md`.
3. Run `git status --short`.
4. Run `git log -3 --oneline`.
5. Run `git rev-parse HEAD`, inspect every commit after the validated code baseline, and report whether any code changed.
6. Run `npm run check`, `npm test`, and `npm run test:integration`.
7. Read `mcp/core.mjs` and `mcp/server.mjs` before making code changes.
8. If documentation and code conflict, treat code and tests as authoritative and report the difference explicitly.

## Information Completeness Check

Confirmed:

- Repository path: `C:\Users\xsjhxs\Desktop\ai_bridge`
- Branch: `master`
- Final validated v0.3.5 source baseline: `2d260d58659483d5054ab762e2323a1fa5c0e526`
- This is the last validated SHA, not an assertion that future repository HEAD remains identical.
- Live repository HEAD must be resolved with `git rev-parse HEAD`.
- The latest known documentation-only commit before this handoff adjustment was `01c7ebf50fcc44382f526ff86f6f336c5ee4a316`, but this is historical context rather than an assertion about the current HEAD.
- Source worktree cleanliness must be rechecked with `git status --short` after final commit/push.
- Historical `%TEMP%` artifacts from runs before the cleanup hardening may still exist and are not removed automatically. Current fixtures register their own temporary roots and recorded processes for awaited cleanup.
- package version: `0.4.0`
- plugin version: `0.4.0+codex.20260627120000`
- Claude Code version: `2.1.105`
- Claude CLI supports `--session-id` and `--resume`.
- Real Claude recovery/cancel validation for the v0.2.1 code baseline passed on 2026-06-24.
- Final v0.3.5 validation-gap commit `2d260d58659483d5054ab762e2323a1fa5c0e526` passed 66/66 tests and both GitHub Actions platforms in run `28277243715`.
- Historical baseline SHA `2c69843f3603fcbb50f0b630a50a9c3b44edcc6a` passed run `28234599534` with 62/62 tests before the validation-gap supplement.

Not claimed by the latest validation:

- Recovery does not backfill stream-json output that was missed while disconnected.
- The validation did not test full MCP client disconnect and automatic reconnect behavior.
- The validation did not test multiple consecutive real Claude iterations with the v0.3.5 durable runner.
- The validation did not test a public marketplace release or GitHub Release creation.
- The validation did not verify real DeepSeek billing or real pricing savings.
- v0.4.0 validation uses fake Claude fixtures and persisted-state process tests. It does not prove real Claude API behavior.
- v0.4.0 provides workspace-level discovery and attach after reopening Codex. It does not guarantee automatic MCP client reconnect or live push replay.
- Moved workspace matching is best-effort and requires explicit confirmation.
