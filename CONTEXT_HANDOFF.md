# AI Bridge Context Handoff

## Project Status

- Project: AI Bridge
- Repository: `C:\Users\xsjhxs\Desktop\ai_bridge`
- Branch: `master`
- Validated code baseline: `ad47b46157217477de678dcc8f738b5a33301f7e`
- Repository HEAD is intentionally not hardcoded in this document because committing a handoff update changes HEAD.
- At the start of every new conversation, resolve the live repository HEAD with `git rev-parse HEAD` and compare it with the validated code baseline.
- All commits after the validated code baseline must be inspected before assuming they are documentation-only.
- npm package version: `0.3.3`
- Codex plugin version: `0.3.3+codex.20260624120000`
- Node: `v22.22.1`
- Python: `3.12.7`
- Claude Code: `2.1.105`

AI Bridge v0.3.3 is a personal Codex plugin that coordinates a confirmation-based loop where Codex plans, verifies, and reviews while local Claude Code performs explicitly approved implementation iterations. The plugin uses the local `claude` CLI and does not manage Claude, DeepSeek, or other provider credentials.

The current v0.3.3 implementation includes:

- Asynchronous Claude execution through `ai_bridge_start_claude_iteration`, `ai_bridge_poll_claude_iteration`, and `ai_bridge_cancel_iteration`.
- A durable worker process (`mcp/worker.mjs`) that owns Claude stdout/stderr, stream/transcript persistence, heartbeat updates, timeout deadlines, and terminal task/run/final writes independently of the MCP server process.
- Exclusive cross-process state locks and monotonically increasing `revision` fields for lifecycle task/run mutations.
- Worker-owned v0.3 cancel requests through persisted `cancelRequestedAt`, `cancelRequestId`, and `cancelReason`; the server no longer directly finalizes a live worker-owned task.
- Three-state process identity handling: `matched`, `mismatched`, and `unverifiable`. Unknown or unverifiable Claude processes are not killed automatically.
- Run-scoped Claude session continuity through `claudeSessionId`, using `--session-id` for iteration 1 and `--resume` when supported for later iterations.
- State machine enforcement for iteration order, active task ownership, terminal run states, and max iteration limits.
- Process-tree cancellation, terminal-owner conflict diagnostics, and once-only finalization for cancel, timeout, error, close, and worker-orphan paths.
- MCP server startup recovery for persisted worker-owned running tasks and incomplete terminal finalization phases, with worker identity checks for v0.3.x tasks and legacy Claude PID compatibility for v0.2.x task files.
- Git baseline capture that separates pre-existing workspace state from changes created after preflight.
- Prompt delivery through stdin, with strict user `claudeArgs` validation for Windows argument safety.
- Token usage aggregation and optional user-supplied pricing comparison.

The public MCP tool set intentionally does not expose the legacy synchronous `ai_bridge_run_claude_iteration` entry point.

## Recently Completed Validation

Durable runner validation for v0.3.3 is covered by automated fixture tests and a controlled local recovery validation recorded in `docs/validation/durable-runner-fixture.md`. This validation uses a fake Claude CLI that emits stream-json and long-running child-process behavior; it does not call the real Claude API.

On 2026-06-24, AI Bridge v0.2.1 passed a real Claude Code long-task recovery/cancel validation. The detailed validation record is in `docs/validation/real-claude-recovery-cancel.md`.

Validated object:

- `runId`: `run-20260624082321-bjd0ej`
- `taskId`: `task-20260624082700-u4pqc8`
- iteration: `1`
- Claude sessionId: `c6272563-3c92-4d70-b6bd-24f41e91d5f7`
- temporary workspace: `C:\Users\xsjhxs\AppData\Local\Temp\ai-bridge-real-claude-recovery-20260624162307`

Conclusion:

> AI Bridge v0.2.1 宸查€氳繃鐪熷疄 Claude Code 闀夸换鍔＄殑鎸佷箙鍖栫姸鎬佹仮澶嶃€佷换鍔¤韩浠戒繚鎸佸拰杩涚▼鏍戝彇娑堥獙鏀躲€傛柊鐨?MCP server 瀹炰緥鍚姩骞跺姞杞芥寔涔呭寲鐘舵€佸悗锛岀郴缁熻兘澶熼€氳繃鍘?runId 鍜?taskId 鎵惧洖鍘熶换鍔★紝骞跺彲闈犲彇娑?Claude 涓昏繘绋嬪強鍏跺瓙杩涚▼銆?
After a new MCP server instance started and loaded persisted state, the original run and task remained recoverable and cancellable.

Important scope limit:

> MCP 杩炴帴涓柇鏈熼棿鐨?stream-json 涓嶄細鍦ㄦ仮澶嶅悗琛ュ綍銆傛湰娆￠獙鏀惰瘉鏄庣殑鏄换鍔＄姸鎬佸拰鍙栨秷鑳藉姏鍙互鎭㈠锛屼笉浠ｈ〃瀹㈡埛绔兘澶熻ˉ鍥炴柇绾挎湡闂寸殑鍏ㄩ儴瀹炴椂杈撳嚭銆?
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
- `npm test`: passed, 52/52
- `npm run test:integration`: passed
- `python C:\Users\xsjhxs\.codex\skills\.system\skill-creator\scripts\quick_validate.py skills\ai-bridge`: passed
- `python C:\Users\xsjhxs\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py .`: passed
- Installed plugin cache `npm run test:integration`: passed

CI check guidance:

- Resolve live CI with `gh run list --branch master --limit 5` and `gh run view <runId> --json status,conclusion,jobs,url,headSha`.
- The latest observed successful CI before this handoff adjustment was run `28145255794` for commit `b069f36b0adbda5d21b5a9e371fdda1fd6da0bea`.
- That run reported `success` for both `test (ubuntu-latest)` and `test (windows-latest)`, including `npm run check`, `npm test`, and `npm run test:integration`.

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
- Natural completion, timeout, recovery cancel, worker-orphan diagnosis, fenced lock contention, recoverable start reservations, stream-log/task creation crash recovery, worker spawn/stdin/early-exit faults, concurrent run/task revision writes, incomplete terminal finalization recovery, stale terminal conflicts, strict process identity, corrupt/conflicting final-log rebuilds, cancellation races, and concurrent start reservation are covered by `tests/durable-worker.test.mjs`, `tests/state-consistency.test.mjs`, and `tests/durable-faults.test.mjs`.
- The fixture validation does not call the real Claude API.

## Known Issues And Risks

No current release-blocking issue is known for v0.3.3 based on the latest local tests and durable runner fixture validation.

Known non-blocking limitations:

- MCP connection interruptions do not provide real-time replay after reconnection. In v0.3.3, output received by the worker while the MCP server is offline is persisted to files and can be read on later poll, but the client still does not receive a retroactive live push stream.
- Full MCP client disconnect and automatic reconnect behavior was not validated.
- Windows `.cmd` and `.bat` execution still relies on a constrained shell wrapper where required by the platform. Existing strict argument validation remains part of the safety boundary.
- Windows `taskkill.exe` output can appear as mojibake in logs on Chinese Windows environments. This affects readability of `killResult.stdout`; v0.3.3 keeps this as a non-blocking diagnostics/readability limitation.
- PID identity checks are best-effort and rely on available cross-platform process identity fields.
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

## Next Tasks

1. Decide whether to create a version tag or GitHub Release.
2. Consider full MCP client reconnect automation testing in a later version.
3. Consider Windows shell-wrapper hardening and taskkill output encoding cleanup in a later version.

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
- package version: `0.3.3`
- plugin version: `0.3.3+codex.20260624120000`
- Claude Code version: `2.1.105`
- Claude CLI supports `--session-id` and `--resume`.
- Real Claude recovery/cancel validation for the v0.2.1 code baseline passed on 2026-06-24.
- Durable runner fixture validation for v0.3.3 passed locally on 2026-06-25.

Not claimed by the latest validation:

- Recovery does not backfill stream-json output that was missed while disconnected.
- The validation did not test full MCP client disconnect and automatic reconnect behavior.
- The validation did not test multiple consecutive real Claude iterations with the v0.3.3 durable runner.
- The validation did not test a public marketplace release or GitHub Release creation.
- The validation did not verify real DeepSeek billing or real pricing savings.
