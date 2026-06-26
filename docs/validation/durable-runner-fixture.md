# Durable Runner Fixture Validation

Date: 2026-06-25

## Scope

This validation covers the AI Bridge v0.3.x durable worker architecture using a controlled fake Claude CLI. It does not call the real Claude API and does not replace the earlier real Claude Code recovery/cancel validation for the v0.2.1 baseline.

Validated behavior:

- A worker-owned Claude task continues after the MCP server process exits.
- Output produced while the MCP server is offline is persisted to transcript files.
- A new MCP server instance can load persisted state and read the final state.
- Timeout is enforced by the worker from persisted deadline state.
- Cancel after recovery terminates Claude and worker-owned process trees.
- Worker/Claude process checks show no residual target processes after terminal states.
- v0.3.3 validates worker-owned cancel requests, terminal-state overwrite protection, quick Claude exit handling, final unterminated stdout flushing, matched orphan Claude cleanup, cross-process lock contention, fenced writes, recoverable start reservations, stream-log/task creation crash recovery, worker spawn/stdin/early-exit faults, corrupt final-log rebuilds, incomplete terminal finalization recovery, stale terminal-status conflicts, stricter process identity checks, cancellation races, and concurrent start reservation.

## Environment

- Repository: `C:\Users\xsjhxs\Desktop\ai_bridge`
- Branch: `master`
- Package version under validation: `0.3.3`
- Plugin version under validation: `0.3.3+codex.20260624120000`
- Node: `v22.22.1`
- Fake Claude CLI: local temporary fixture emitting Claude-style stream-json

## Procedure

The validation used a temporary git repository, temporary `AI_BRIDGE_HOME`, and temporary fake `claude` command for each scenario.

For each scenario:

1. Started `node mcp/server.mjs` as a real stdio MCP server process.
2. Called `ai_bridge_preflight`.
3. Called `ai_bridge_start_claude_iteration`.
4. Stopped the original MCP server process while the worker/Claude task was active.
5. Waited while the worker continued independently.
6. Started a new `node mcp/server.mjs` instance.
7. Polled or cancelled the original task by the original `taskId`.
8. Checked terminal state and target process liveness.

## Evidence

Natural completion while server was offline:

```text
runId=run-20260624112839-oh731t
taskId=task-20260624112839-xlvbgr
workerPid=25532
finalStatus=completed
finalExitCode=0
workerAlive=false
offline transcript text verified: "complete: output while server offline"
```

Timeout while server was offline:

```text
runId=run-20260624112844-x1hwmu
taskId=task-20260624112844-ueqhkz
workerPid=62824
claudePid=42616
finalStatus=timed_out
timedOut=true
finalExitCode=1
workerAlive=false
claudeAlive=false
```

Cancel after recovery:

```text
runId=run-20260624112849-5dsyv6
taskId=task-20260624112849-ycl4a5
workerPid=31296
claudePid=14744
cancelStatus=cancelled
finalStatus=cancelled
workerAlive=false
claudeAlive=false
killResult.attempted=true
killResult.killed=true
```

The Windows `taskkill.exe` stdout contained console encoding mojibake. This is a known readability limitation and was not treated as a durable runner failure because independent process checks showed no residual target processes.

## Result

AI Bridge v0.3.3 durable runner fixture validation passed for controlled natural completion, timeout, recovery cancel, immediate exit, final unterminated stdout, terminal overwrite protection, worker-orphan scenarios, cross-process lock contention, fenced writes, recoverable start reservations, stream-log/task creation crash recovery, worker spawn/stdin/early-exit faults, corrupt final-log rebuilds, incomplete terminal finalization recovery, stale terminal-status conflicts, stricter process identity checks, cancellation races, and concurrent start reservation. The worker process, not the MCP server process, owned Claude stdout/stderr capture, transcript persistence, timeout deadline enforcement, cancel finalization, and terminal task/run/final state writes.

After a new MCP server instance started and loaded persisted state, the original run and task remained recoverable. The validation did not start a second worker or a second Claude iteration for the original task.

## Limits

- This was a controlled fixture validation, not a real Claude API validation.
- This did not validate full MCP client automatic reconnect behavior.
- This did not validate multiple consecutive real Claude iterations.
- This did not create a tag, GitHub Release, marketplace release, package release, or plugin publication.
