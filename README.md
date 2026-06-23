# AI Bridge

AI Bridge is a personal Codex plugin that lets Codex plan, verify, and review while a confirmed local Claude Code iteration performs implementation work.

The plugin does not manage provider credentials. It uses the `claude` CLI already configured on the machine, including DeepSeek-compatible Claude Code setups.

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

When the resolved Claude executable is `claude.cmd` or `claude.bat`, AI Bridge uses Node's Windows shell wrapper only for that script type. User-supplied `claudeArgs` are allowlisted and rejected if they contain shell metacharacters such as `&`, `|`, `>`, `<`, `^`, or newlines.

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

Snapshot reports:

- `preExistingChanges`
- `changesCreatedAfterPreflight`
- `modifiedPreExistingChanges`
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
- If a task times out, poll returns `timed_out`, and the run moves to `timed_out`.
- Use `ai_bridge_cancel_iteration` to mark a running task cancelled.
- If transcript JSON has a corrupted line, poll skips that line and returns `corruptTranscriptLines`.
- If HEAD or branch changes after preflight, snapshot sets `baselineInvalidated: true`.
- If a run is terminal (`passed`, `blocked`, `cancelled`), create a new preflight run for unrelated work.

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
