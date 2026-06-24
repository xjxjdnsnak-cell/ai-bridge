# AI Bridge Context Handoff

## Project Status

- Project: AI Bridge
- Repository: `C:\Users\xsjhxs\Desktop\ai_bridge`
- Branch: `master`
- Validated code baseline: `ad47b46157217477de678dcc8f738b5a33301f7e`
- Repository HEAD is intentionally not hardcoded in this document because committing a handoff update changes HEAD.
- At the start of every new conversation, resolve the live repository HEAD with `git rev-parse HEAD` and compare it with the validated code baseline.
- All commits after the validated code baseline must be inspected before assuming they are documentation-only.
- npm package version: `0.2.1`
- Codex plugin version: `0.2.1+codex.20260624120000`
- Node: `v22.22.1`
- Python: `3.12.7`
- Claude Code: `2.1.105`

AI Bridge v0.2.1 is a personal Codex plugin that coordinates a confirmation-based loop where Codex plans, verifies, and reviews while local Claude Code performs explicitly approved implementation iterations. The plugin uses the local `claude` CLI and does not manage Claude, DeepSeek, or other provider credentials.

The current v0.2.1 implementation includes:

- Asynchronous Claude execution through `ai_bridge_start_claude_iteration`, `ai_bridge_poll_claude_iteration`, and `ai_bridge_cancel_iteration`.
- Run-scoped Claude session continuity through `claudeSessionId`, using `--session-id` for iteration 1 and `--resume` when supported for later iterations.
- State machine enforcement for iteration order, active task ownership, terminal run states, and max iteration limits.
- Process-tree cancellation and once-only finalization for cancel, timeout, error, and close paths.
- MCP server startup recovery for persisted running tasks.
- Git baseline capture that separates pre-existing workspace state from changes created after preflight.
- Prompt delivery through stdin, with strict user `claudeArgs` validation for Windows argument safety.
- Token usage aggregation and optional user-supplied pricing comparison.

The public MCP tool set intentionally does not expose the legacy synchronous `ai_bridge_run_claude_iteration` entry point.

## Recently Completed Validation

On 2026-06-24, AI Bridge v0.2.1 passed a real Claude Code long-task recovery/cancel validation. The detailed validation record is in `docs/validation/real-claude-recovery-cancel.md`.

Validated object:

- `runId`: `run-20260624082321-bjd0ej`
- `taskId`: `task-20260624082700-u4pqc8`
- iteration: `1`
- Claude sessionId: `c6272563-3c92-4d70-b6bd-24f41e91d5f7`
- temporary workspace: `C:\Users\xsjhxs\AppData\Local\Temp\ai-bridge-real-claude-recovery-20260624162307`

Conclusion:

> AI Bridge v0.2.1 已通过真实 Claude Code 长任务的持久化状态恢复、任务身份保持和进程树取消验收。新的 MCP server 实例启动并加载持久化状态后，系统能够通过原 runId 和 taskId 找回原任务，并可靠取消 Claude 主进程及其子进程。

After a new MCP server instance started and loaded persisted state, the original run and task remained recoverable and cancellable.

Important scope limit:

> MCP 连接中断期间的 stream-json 不会在恢复后补录。本次验收证明的是任务状态和取消能力可以恢复，不代表客户端能够补回断线期间的全部实时输出。

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
- `npm test`: passed, 27/27
- `npm run test:integration`: passed
- `python C:\Users\xsjhxs\.codex\skills\.system\skill-creator\scripts\quick_validate.py skills\ai-bridge`: passed
- `python C:\Users\xsjhxs\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py .`: passed
- Installed plugin cache `npm run test:integration`: passed

Latest known successful CI:

- GitHub Actions run: `28083284122`
- URL: `https://github.com/xjxjdnsnak-cell/ai-bridge/actions/runs/28083284122`
- Commit: `ad47b46157217477de678dcc8f738b5a33301f7e`
- Conclusion: success
- `ubuntu-latest`: success
- `windows-latest`: success

Real Claude Code validation:

- Real long-running foreground Bash command was started by Claude Code.
- A new MCP server instance was started while the task was still running and loaded persisted state.
- Recovery preserved the original running task identity.
- Cancellation terminated Claude and the long-running Bash process tree.
- Final state was `cancelled`, not success.

## Known Issues And Risks

No current release-blocking issue is known for v0.2.1 based on the latest local tests, CI, and real Claude Code recovery/cancel validation.

Known non-blocking limitations:

- MCP connection interruptions do not backfill missed stream-json output after reconnection. Current recovery covers task state and cancellation capability, not complete live-output replay.
- Full MCP client disconnect and automatic reconnect behavior was not validated.
- Windows `.cmd` and `.bat` execution still relies on a constrained shell wrapper where required by the platform. Existing strict argument validation remains part of the safety boundary.
- Windows `taskkill.exe` output can appear as mojibake in logs on Chinese Windows environments. This affects readability of `killResult.stdout`, not the cancellation status or independent process checks.
- PID identity checks are best-effort and rely on available cross-platform process identity fields.
- Git baseline hashing skips files beyond configured size limits and reports skipped hash reasons instead of reading large files.

## Key File Map

- `mcp/core.mjs`: running state, Claude lifecycle, persistence, cancellation, and recovery core logic.
- `mcp/server.mjs`: MCP stdio server and public tool registration.
- `.mcp.json`: MCP server configuration used by Codex.
- `.codex-plugin/plugin.json`: Codex plugin manifest and version metadata.
- `tests/*.test.mjs`: unit and behavior tests.
- `tests/integration.mjs`: MCP integration test.
- `README.md`: workflow, installation, commands, safety boundaries, state files, and recovery documentation.
- `docs/validation/real-claude-recovery-cancel.md`: real Claude recovery/cancel validation evidence.

## Next Tasks

1. Treat v0.2.1 as release-candidate validation complete.
2. Decide whether to create a version tag or GitHub Release.
3. Consider stream-json reconnect/backfill in a later version.
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
- Validated code baseline: `ad47b46157217477de678dcc8f738b5a33301f7e`
- Live repository HEAD must be resolved with `git rev-parse HEAD`.
- The latest known documentation-only commit before this handoff adjustment was `01c7ebf50fcc44382f526ff86f6f336c5ee4a316`, but this is historical context rather than an assertion about the current HEAD.
- Source worktree was clean after validation.
- Temporary validation repository was clean after validation.
- package version: `0.2.1`
- plugin version: `0.2.1+codex.20260624120000`
- Claude Code version: `2.1.105`
- Claude CLI supports `--session-id` and `--resume`.
- Real Claude recovery/cancel validation passed on 2026-06-24.

Not claimed by the latest validation:

- Recovery does not backfill stream-json output that was missed while disconnected.
- The validation did not test full MCP client disconnect and automatic reconnect behavior.
- The validation did not test multiple consecutive real Claude iterations.
- The validation did not test a public marketplace release or GitHub Release creation.
- The validation did not verify real DeepSeek billing or real pricing savings.
