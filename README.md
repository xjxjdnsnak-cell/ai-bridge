# AI Bridge

AI Bridge is a personal Codex plugin that lets Codex plan, verify, and review while a confirmed local Claude Code iteration performs implementation work.

The plugin does not manage provider credentials. It uses the `claude` CLI already configured on the machine, including DeepSeek-compatible Claude Code setups.

Version 0.4.3 adds a bounded Fresh Thread Plugin Discovery diagnostic and playbook. It builds on the v0.4.2 local MCP and plugin-layout diagnostics without claiming that Codex thread exposure is fixed. The v0.4.1 Run Explorer remains available for listing and inspecting persisted runs, tailing summarized events, showing baseline-aware diffs and historical verification, and exporting redacted JSON or Markdown reports without starting Claude.

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

## Plugin Exposure Diagnostics

Run these commands from the repository root when a fresh ChatGPT/Codex thread does not expose `ai_bridge_*` tools:

```powershell
npm run smoke:mcp-tools
npm run diagnose:plugin
```

`smoke:mcp-tools` starts `mcp/server.mjs` with an isolated temporary AI Bridge home, sends MCP `initialize` and `tools/list` requests over JSON-RPC stdio, verifies the required AI Bridge tools, and cleans up the child process and temporary directory. It proves that the local MCP server can initialize and list AI Bridge tools without calling Claude or creating a run.

`diagnose:plugin` checks the repository root, package and plugin versions, plugin manifest, `.mcp.json` server configuration, configured skills path, MCP server entry point, README, path warnings, known local Codex-related paths, and the same isolated server smoke. Missing Codex configuration is reported as unknown rather than inferred.

Neither command proves that a fresh ChatGPT/Codex thread will expose the plugin. A passing local smoke only establishes that the AI Bridge MCP server can expose its tools locally. If both commands pass but Codex still does not show `ai_bridge_*` tools, the remaining blocker is in Codex/plugin discovery or installation, outside the MCP server runtime path.

## Fresh Thread Plugin Discovery

v0.4.2 diagnostics prove local MCP server exposure and local plugin-layout consistency. v0.4.3 adds a facts-only diagnostic that records fixed local path hints, explicit environment paths, version alignment, MCP registration, plugin layout, and the existing isolated smoke result:

```powershell
npm run smoke:mcp-tools
npm run diagnose:plugin
npm run diagnose:codex-discovery
```

Use `npm run diagnose:codex-discovery -- --json` when a machine-readable report is needed. The command checks only a bounded list of known local directory hints. It does not scan the user home directory, enumerate all environment variables, read tokens or logs, or infer undocumented Codex installation rules.

The command always reports actual ChatGPT/Codex thread exposure as `unknown`; only a manual observation in a fresh client thread can establish whether `ai_bridge_*` tools are visible. If all local diagnostics pass but a fresh Codex thread still lacks those tools, the remaining blocker is outside the AI Bridge MCP server runtime path.

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

## Workspace Recovery

Use the workspace tools before creating a run when the user wants to continue earlier work:

```text
ai_bridge_discover_workspace_runs(workspacePath)
-> ai_bridge_attach_workspace_run(workspacePath, optional runId)
-> ai_bridge_poll_workspace_run(workspacePath, optional runId, cursor)
```

- Discovery normalizes the real workspace path and uses a SHA-256 `workspaceKey`.
- A persisted workspace index accelerates lookup, but `run.json` remains authoritative. Missing or corrupt indexes fall back to scanning run state.
- One unambiguous candidate can be attached without remembering runId or taskId.
- Multiple candidates return `select_run`; the caller must provide a runId rather than accepting directory scan order.
- Running tasks reuse the original task and transcript. Completed tasks return their transcript, final log summary, and finalization state.
- A reviewed `needs_fix` run continues with the original `claudeSessionId`; iteration 2+ uses `--resume` when supported.
- A moved-workspace fingerprint match is best-effort, is reported as `moved_workspace_candidate`, and requires explicit `confirmMovedWorkspace=true`.
- Start a new run only when discovery finds no suitable candidate or the user explicitly requests one. `allowConcurrentRun=true` is required to create another run while one is running; `reuseExisting=true` attaches the existing run.

Workspace recovery provides persisted-state discovery and attach after reopening Codex. It does not guarantee automatic MCP client reconnect or live push replay.

## Run Explorer

The explorer tools operate on persisted state and do not start a Claude iteration:

```text
ai_bridge_list_runs(optional workspacePath, status, age, limit)
ai_bridge_inspect_run(runId)
ai_bridge_tail_run(runId, cursor, limit)
ai_bridge_show_run_diff(runId, optional bounded patch)
ai_bridge_show_verification(runId, optional bounded output)
ai_bridge_export_run(runId, json or markdown)
```

- Corrupt run, task, transcript, and verification records are reported as diagnostics without preventing healthy runs from being read.
- Run lists rank `running`, `awaiting_review`, `needs_fix`, `ready`, `failed`, `timed_out`, `passed`, `blocked`, and `cancelled` in that order, then use newest `updatedAt` within one status.
- Diff and verification queries are read-only. Patch and command output are excluded by default, bounded when requested, and passed through secret redaction.
- Diff results retain `sensitivePaths` for compatibility and recommend `sensitivePathWarnings`, which adds a reason for environment, private-key, credential, secret, token, and password-like filenames.
- Exports default to the AI Bridge `exports` directory, exclude raw stream-json and patch content by default, and refuse to overwrite existing files.
- Run Explorer reports persisted evidence; it does not claim that verification is current or execute commands on the reader's behalf.

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
- An unverifiable launcher or worker identity is diagnostic uncertainty, not proof of process death. While an active start reservation remains before `startupDeadlineAt` and no identity mismatch is proven, poll, recovery, and cancel leave the task running and return an explicit waiting ownership status.
- Terminal finalization validates and rebuilds missing, corrupt, or conflicting final logs from task state.

### Validation Snapshot

- Historical v0.3.5 validation-gap source SHA `2d260d58659483d5054ab762e2323a1fa5c0e526` passed 66/66 tests in GitHub Actions run `28277243715` on both `ubuntu-latest` and `windows-latest`.
- v0.4.0 workspace recovery is validated with fake Claude fixtures and persisted-state process tests.
- v0.4.1 Run Explorer is validated with isolated temporary repositories and persisted fixture state. Neither validation proves real Claude API behavior.

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
