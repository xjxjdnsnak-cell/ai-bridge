# AI Bridge

AI Bridge is a personal Codex plugin that lets Codex plan, verify, and review while a confirmed local Claude Code iteration performs implementation work.

The plugin does not manage provider credentials. It uses the `claude` CLI already configured on the machine, including DeepSeek-compatible Claude Code setups.

Version 0.3.5 runs confirmed Claude iterations through a durable worker process. The MCP server starts and observes work, while the worker owns the Claude process, stdout/stderr capture, transcript persistence, timeout deadline, and final task/run state writes. v0.3.5 tightens cross-process file locks, run/task revision updates, terminal finalization recovery, cancel takeover, process identity checks, and durable startup ownership recovery.

## How It Works

The intended loop is:

```text
preflight
-> approved plan handoff
-> confirmed Claude iteration
-> live polling
-> git change isolation
-> verification
-> Codex review
-> pass / needs_fix / blocked
-> next iteration or finish
```

Codex remains responsible for the final decision. Claude's own "tests passed" report is only a transcript event; Codex or the user should run `ai_bridge_run_verification` or independent checks before recording review.

## Installation

From the personal marketplace source:

```powershell
codex plugin add ai-bridge@personal
```

For local development:

```powershell
npm run check
npm test
npm run test:integration
```

## Codex Plugin Configuration

The plugin manifest lives in `.codex-plugin/plugin.json`.

The MCP server is configured by `.mcp.json`:

```json
{
  "mcpServers": {
    "ai-bridge": {
      "command": "node",
      "args": ["./mcp/server.mjs", "--stdio"]
    }
  }
}
```

## Claude CLI Requirements

`claude` must be available on `PATH` for the target repository. During `ai_bridge_preflight`, AI Bridge runs:

- `claude --version`
- `claude --help`

The help output is inspected for:

- `--session-id`
- `--resume`
- `-r`

Iteration 1 starts with `--session-id <uuid>`. Later iterations use `--resume <uuid>` when the installed CLI advertises `--resume`; otherwise AI Bridge falls back to `--session-id <uuid>` and records that mode in run state.

## Windows Notes

Prompt text is sent through stdin, not as a command-line argument. This avoids Windows command-line length and quoting failures for large multi-line plans.

When the resolved Claude executable is `claude.cmd` or `claude.bat`, AI Bridge uses Node's Windows shell wrapper only for that script type. Prompt text still goes through stdin. User-supplied `claudeArgs` are allowlisted and rejected if they contain shell metacharacters such as `&`, `|`, `>`, `<`, `^`, `%`, `!`, `"`, `(`, `)`, or CR/LF. Free-text `--append-system-prompt` is not accepted as a user override.

## Complete Example

1. Run preflight:

```text
ai_bridge_preflight({
  "workspacePath": "C:\\path\\to\\repo",
  "task": "Implement the approved plan",
  "maxIterations": 3
})
```

2. Prepare an approved Plan Mode handoff:

```text
ai_bridge_prepare_plan_handoff({
  "runId": "run-YYYYMMDDhhmmss-token",
  "planText": "<proposed_plan>...</proposed_plan>"
})
```

3. Start the confirmed Claude iteration:

```text
ai_bridge_start_claude_iteration({
  "runId": "run-YYYYMMDDhhmmss-token",
  "prompt": "<handoffPrompt>",
  "iteration": 1
})
```

4. Poll until terminal:

```text
ai_bridge_poll_claude_iteration({
  "taskId": "task-YYYYMMDDhhmmss-token",
  "cursor": 0
})
```

5. Snapshot changes and verify:

```text
ai_bridge_snapshot_changes({ "runId": "run-YYYYMMDDhhmmss-token" })
ai_bridge_run_verification({ "runId": "run-YYYYMMDDhhmmss-token" })
```

6. Record Codex review:

```text
ai_bridge_record_review({
  "runId": "run-YYYYMMDDhhmmss-token",
  "iteration": 1,
  "outcome": "pass"
})
```

Use `needs_fix` to unlock the next iteration. Runs marked `passed`, `blocked`, or `cancelled` cannot continue.

The legacy synchronous MCP tool is no longer exposed. Use `ai_bridge_start_claude_iteration`, `ai_bridge_poll_claude_iteration`, and `ai_bridge_cancel_iteration` so every execution path uses the same state machine.

## State Files

AI Bridge stores state outside target repositories:

```text
~/.ai-bridge/
  runs/<runId>/
    run.json
    plan-handoff-1.txt
    iteration-1.stream.jsonl
    iteration-1.transcript.jsonl
    iteration-1.json
    snapshot.json
    reviews.jsonl
    verification.jsonl
  tasks/<taskId>.json
```

Target repositories are changed only by Claude Code or verification commands. AI Bridge inspects them through git.

## Safety Boundaries

- Target workspace must be inside a git repository.
- `runId` and `taskId` are strictly validated and cannot contain paths.
- Paths derived from IDs are checked to remain inside `~/.ai-bridge`.
- `maxIterations` is enforced server-side.
- Iterations cannot skip, repeat, or overwrite existing logs.
- One run can have at most one active Claude task.
- New iterations after iteration 1 require a `needs_fix` review.
- Prompt text is never placed in argv.
- `claudeArgs` cannot override session, resume, output format, permission mode, MCP config, or prompt input mode.

## Git Change Isolation

Preflight records:

- HEAD SHA
- branch
- porcelain `-z` status entries
- staged and unstaged name-status entries
- untracked files
- hashes for pre-existing changed files
- SHA-256 hashes for pre-existing untracked regular files, subject to per-file and total hash size limits
- staged index blob SHAs for pre-existing staged changes

Snapshot reports:

- `preExistingChanges`
- `changesCreatedAfterPreflight`
- `modifiedPreExistingChanges`
- `preExistingUntrackedFiles`
- `modifiedPreExistingUntrackedFiles`
- `preExistingStagedChanges`
- `modifiedPreExistingStagedChanges`
- `stagedChanges`
- `unstagedChanges`
- `untrackedFiles`
- `renamedFiles`
- `baselineInvalidated`

This prevents AI Bridge from claiming Claude created user changes that already existed before preflight.

## Usage And Cost Output

`ai_bridge_summarize_costs` reports token usage and cache hit rate from Claude stream-json logs.

If pricing is supplied, the output is a same-token hypothetical estimate. It is not real savings and does not represent actual Codex billing.

Pricing schema:

```json
{
  "source": "user supplied 2026-06-23",
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

Negative, missing, or non-finite pricing values are rejected.

## Troubleshooting And Recovery

- If preflight says Claude is unavailable, check that `claude --version` works in the same shell and repository.
- `ai_bridge_start_claude_iteration` creates a persisted task and starts an AI Bridge worker. The prompt is sent to the worker over stdin, not argv.
- The worker starts Claude Code, captures stdout/stderr, writes stream and transcript logs, maintains heartbeat fields, enforces the persisted absolute `deadlineAt`, and writes terminal task/run/final state.
- If the MCP server exits or restarts while Claude is running, the worker continues independently. A new MCP server instance can poll the original task and read output produced while the server was offline.
- If a task times out, the worker terminates the Claude process tree, poll returns `timed_out`, and the run moves to `timed_out`.
- Use `ai_bridge_cancel_iteration` to terminate the worker and Claude process tree and move the task and run to `cancelled`.
- On MCP server startup, AI Bridge scans persisted running tasks. For v0.3.x worker-owned tasks, startup reservation ownership is classified with the same logic used by polling and cancellation. A live launcher inside its startup deadline is left alone. A reservation worker whose PID, start time, executable, command line, taskId, and worker launch token match can be adopted if the task worker fields were not landed yet. Mismatched or unverifiable worker processes are not killed automatically. Older v0.2.x task files still use the legacy Claude PID compatibility branch.
- If transcript JSON has a corrupted line, poll skips that line and returns `corruptTranscriptLines`.
- If HEAD or branch changes after preflight, snapshot sets `baselineInvalidated: true`.
- If a run is terminal (`passed`, `blocked`, `cancelled`), create a new preflight run for unrelated work.

## Durable State Guarantees

### Proven Guarantees

- A worker-owned task can complete, time out, or be cancelled after the short-lived MCP starter process exits.
- A new MCP server instance can recover persisted running tasks without starting a second worker or second Claude iteration for the same task.
- `pollClaudeIteration()` and startup recovery use one ownership classification path for active reservations, launcher identity, startup deadlines, and worker identity.
- If `startReservation.phase=worker_spawned` and the reservation contains a matching live worker while `task.workerPid` is still missing, recovery can adopt the worker by backfilling task worker fields and keeping the task running.
- Launcher identity is not PID-only. When process metadata is available, AI Bridge compares PID, process start time, executable, and command line.
- stdin write failures are recorded with structured evidence (`stdinErrorObserved`, `stdinErrorCode`, `stdinErrorAt`) when the stdin error listener runs.
- Terminal finalization validates and rebuilds missing, corrupt, or conflicting final logs from task state.

### Validation Snapshot

- Local v0.3.5 validation on 2026-06-26 passed `npm run check`, `npm test` (62/62), `npm run test:integration`, `git diff --check`, skill validation, and plugin validation.
- Final GitHub Actions results are resolved from the pushed commit SHA; do not reuse older workflow run IDs for a new release decision.

### Best-Effort Guarantees

- Fenced state writes verify the current lock owner and `fenceEpoch` before writing and again before rename. This rejects stale owners before their next write and prevents legal live-owner lock stealing.
- On ordinary file systems this is not a formal compare-and-swap across the second fence check and rename. AI Bridge does not claim complete protection against external force-deletion of lock files or arbitrary filesystem adversaries.
- Windows process command line metadata may be unavailable under restricted policy. When that happens, AI Bridge falls back to available PID, start time, executable, and spawn-recorded command line evidence; unverifiable identities are not treated as safe to kill.

### Not Yet Verified

- Full MCP client automatic disconnect/reconnect replay is not validated.
- Missed live stream-json output is not backfilled as a realtime push stream after reconnect.
- Multiple consecutive real Claude Code iterations with v0.3.5 durable startup recovery were not validated against the real Claude API.
- Marketplace/package publication, tags, and GitHub Releases are outside this validation.

## Uninstall And Cleanup

Remove the plugin from Codex through the Codex plugin UI or reinstall another version with:

```powershell
codex plugin add ai-bridge@personal
```

To remove historical run logs:

```powershell
Remove-Item -Recurse -Force "$HOME\\.ai-bridge"
```

Only delete logs after confirming you no longer need audit history.
