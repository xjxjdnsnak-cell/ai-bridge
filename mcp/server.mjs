import readline from "node:readline";

import {
  APP_VERSION,
  attachWorkspaceRun,
  cancelClaudeIteration,
  discoverWorkspaceRuns,
  exportRun,
  getClaudeTranscript,
  inspectRun,
  listRuns,
  pollClaudeIteration,
  pollWorkspaceRun,
  preparePlanHandoff,
  preflight,
  recordReview,
  runVerificationCommands,
  searchChangedFiles,
  searchErrors,
  searchReviews,
  searchRuns,
  searchVerification,
  recoverRunningTasks,
  snapshotChanges,
  showRunDiff,
  showVerification,
  startClaudeIteration,
  summarizeCosts,
  tailRun,
  workspaceMemorySummary,
} from "./core.mjs";

const SERVER_NAME = "AI Bridge MCP";
const SERVER_VERSION = APP_VERSION;
const RUN_ID_SCHEMA = { type: "string", pattern: "^run-\\d{14}-[a-z0-9]{6}$" };
const TASK_ID_SCHEMA = { type: "string", pattern: "^task-\\d{14}-[a-z0-9]{6}$" };
const JsonRpcError = { METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602 };

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(text, structuredContent) {
  return { content: [{ type: "text", text }], structuredContent };
}

const commandArraySchema = {
  type: "array",
  items: { type: "string", minLength: 1 },
  maxItems: 20,
};

const claudeArgsSchema = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 400 },
  maxItems: 20,
};

const pricingBookSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    inputPerMillion: { type: "number", minimum: 0 },
    outputPerMillion: { type: "number", minimum: 0 },
    cacheCreationInputPerMillion: { type: "number", minimum: 0 },
    cacheReadInputPerMillion: { type: "number", minimum: 0 },
  },
  required: ["inputPerMillion", "outputPerMillion", "cacheCreationInputPerMillion", "cacheReadInputPerMillion"],
};

const historianCursorSchema = { type: "string", minLength: 1, maxLength: 1000 };
const historianLimitSchema = { type: "integer", minimum: 1, maximum: 100, default: 20 };
const historianWorkspaceSchema = { type: "string", minLength: 1 };
const historianReadOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const tools = [
  {
    name: "ai_bridge_list_runs",
    title: "List AI Bridge Runs",
    description: "List persisted AI Bridge runs, optionally filtered by workspace or status, while isolating corrupt run state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: { type: "string", minLength: 1 },
        includeTerminal: { type: "boolean", default: true },
        status: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        maxAgeHours: { type: "number", minimum: 0, default: 720 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_inspect_run",
    title: "Inspect AI Bridge Run",
    description: "Inspect one persisted run, its tasks, recent summarized events, verification history, usage, and diagnostics.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: RUN_ID_SCHEMA,
        includeEvents: { type: "boolean", default: true },
        eventLimit: { type: "integer", minimum: 0, maximum: 500, default: 20 },
        includeLogs: { type: "boolean", default: false },
      },
      required: ["runId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_tail_run",
    title: "Tail AI Bridge Run",
    description: "Read summarized run transcript events with a stable cursor without requiring a taskId.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: RUN_ID_SCHEMA,
        cursor: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
      },
      required: ["runId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_show_run_diff",
    title: "Show AI Bridge Run Diff",
    description: "Compare the current workspace with the run baseline and optionally return a bounded redacted patch.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: RUN_ID_SCHEMA,
        includePatch: { type: "boolean", default: false },
        maxPatchBytes: { type: "integer", minimum: 0, maximum: 1000000, default: 20000 },
      },
      required: ["runId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_show_verification",
    title: "Show AI Bridge Verification",
    description: "Read and summarize historical verification records without executing commands.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: RUN_ID_SCHEMA,
        includeOutput: { type: "boolean", default: false },
        maxOutputChars: { type: "integer", minimum: 0, maximum: 100000, default: 4000 },
      },
      required: ["runId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_export_run",
    title: "Export AI Bridge Run",
    description: "Create a redacted JSON or Markdown run report. Existing files are never overwritten.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: RUN_ID_SCHEMA,
        format: { type: "string", enum: ["json", "markdown"], default: "json" },
        outputPath: { type: "string", minLength: 1 },
        includeTranscript: { type: "boolean", default: true },
        includeStreamJson: { type: "boolean", default: false },
        includePatch: { type: "boolean", default: false },
      },
      required: ["runId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ai_bridge_search_runs",
    title: "Search AI Bridge Run History",
    description: "Read-only bounded search across persisted AI Bridge runs, tasks, reviews, verification, diffs, and optionally transcript events.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: historianWorkspaceSchema,
        query: { type: "string" },
        status: {
          oneOf: [
            { type: "string", minLength: 1 },
            { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 20 },
          ],
        },
        since: { type: "string", minLength: 1 },
        until: { type: "string", minLength: 1 },
        limit: historianLimitSchema,
        cursor: historianCursorSchema,
        includeTerminal: { type: "boolean", default: true },
        includeEvents: { type: "boolean", default: false },
      },
    },
    annotations: historianReadOnlyAnnotations,
  },
  {
    name: "ai_bridge_search_errors",
    title: "Search AI Bridge Errors",
    description: "Read-only bounded search for persisted failed, timed out, cancelled, corrupt, verification-failed, and needs-fix evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: historianWorkspaceSchema,
        query: { type: "string" },
        limit: historianLimitSchema,
        cursor: historianCursorSchema,
      },
    },
    annotations: historianReadOnlyAnnotations,
  },
  {
    name: "ai_bridge_search_verification",
    title: "Search AI Bridge Verification History",
    description: "Read-only bounded search over saved verification records; commands are never re-executed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: historianWorkspaceSchema,
        command: { type: "string" },
        query: { type: "string" },
        exitCode: { type: "integer" },
        status: { type: "string", enum: ["passed", "failed", "timed_out"] },
        limit: historianLimitSchema,
        cursor: historianCursorSchema,
      },
    },
    annotations: historianReadOnlyAnnotations,
  },
  {
    name: "ai_bridge_search_changed_files",
    title: "Search AI Bridge Changed Files",
    description: "Read-only bounded search over saved snapshot and diff metadata. Raw patches are omitted unless explicitly requested.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: historianWorkspaceSchema,
        path: { type: "string" },
        query: { type: "string" },
        status: { type: "string", minLength: 1 },
        limit: historianLimitSchema,
        cursor: historianCursorSchema,
        includePatch: { type: "boolean", default: false },
      },
      anyOf: [{ required: ["path"] }, { required: ["query"] }],
    },
    annotations: historianReadOnlyAnnotations,
  },
  {
    name: "ai_bridge_search_reviews",
    title: "Search AI Bridge Reviews",
    description: "Read-only bounded search over persisted pass, needs-fix, and blocked review decisions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: historianWorkspaceSchema,
        outcome: { type: "string", enum: ["pass", "needs_fix", "blocked"] },
        query: { type: "string" },
        limit: historianLimitSchema,
        cursor: historianCursorSchema,
      },
    },
    annotations: historianReadOnlyAnnotations,
  },
  {
    name: "ai_bridge_workspace_memory_summary",
    title: "Summarize AI Bridge Workspace Memory",
    description: "Read-only bounded summary of recent AI Bridge workflow history for one workspace; it does not scan source code or prove current state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: historianWorkspaceSchema,
        includeRecentRuns: { type: "boolean", default: true },
        includeChangedFiles: { type: "boolean", default: true },
        includeVerificationPatterns: { type: "boolean", default: true },
        includeFailurePatterns: { type: "boolean", default: true },
        limit: historianLimitSchema,
      },
      required: ["workspacePath"],
    },
    annotations: historianReadOnlyAnnotations,
  },
  {
    name: "ai_bridge_preflight",
    title: "AI Bridge Preflight",
    description: `Create a v${APP_VERSION} AI Bridge run, capture git baseline, inspect Claude CLI capabilities, and infer verification commands.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: { type: "string", minLength: 1 },
        task: { type: "string", minLength: 1 },
        maxIterations: { type: "integer", minimum: 1, maximum: 20, default: 3 },
        verificationCommands: commandArraySchema,
        reuseExisting: { type: "boolean", default: false },
        allowConcurrentRun: { type: "boolean", default: false },
      },
      required: ["workspacePath", "task"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ai_bridge_discover_workspace_runs",
    title: "Discover Workspace Runs",
    description: "Find persisted AI Bridge runs for a workspace without creating a run or starting Claude.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: { type: "string", minLength: 1 },
        includeTerminal: { type: "boolean", default: false },
        maxAgeHours: { type: "number", exclusiveMinimum: 0, default: 168 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      },
      required: ["workspacePath"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_attach_workspace_run",
    title: "Attach Workspace Run",
    description: "Attach to one persisted workspace run. Ambiguous candidates require an explicit runId.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: { type: "string", minLength: 1 },
        runId: RUN_ID_SCHEMA,
        mode: { type: "string", enum: ["observe"], default: "observe" },
        confirmMovedWorkspace: { type: "boolean", default: false },
      },
      required: ["workspacePath"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_poll_workspace_run",
    title: "Poll Workspace Run",
    description: "Resolve a workspace run and its active or latest task, then return transcript events after the cursor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: { type: "string", minLength: 1 },
        runId: RUN_ID_SCHEMA,
        cursor: { type: "integer", minimum: 0, default: 0 },
        confirmMovedWorkspace: { type: "boolean", default: false },
      },
      required: ["workspacePath"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_prepare_plan_handoff",
    title: "Prepare Approved Plan Handoff",
    description: "Wrap an explicitly approved Codex proposed_plan into a Claude execution prompt. Requires the runId returned by ai_bridge_preflight.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: RUN_ID_SCHEMA,
        planText: { type: "string", minLength: 1 },
        task: { type: "string" },
        verificationCommands: commandArraySchema,
      },
      required: ["runId", "planText"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ai_bridge_start_claude_iteration",
    title: "Start Claude Code Iteration",
    description: "Start one state-machine-validated Claude Code iteration in the background using stream-json output.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: RUN_ID_SCHEMA,
        prompt: { type: "string", minLength: 1 },
        iteration: { type: "integer", minimum: 1 },
        timeoutSec: { type: "integer", minimum: 1, maximum: 86400, default: 900 },
        claudeArgs: claudeArgsSchema,
      },
      required: ["runId", "prompt", "iteration"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ai_bridge_poll_claude_iteration",
    title: "Poll Claude Code Iteration",
    description: "Return summarized Claude transcript events after the cursor plus stable task status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: TASK_ID_SCHEMA,
        cursor: { type: "integer", minimum: 0, default: 0 },
      },
      required: ["taskId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_get_claude_transcript",
    title: "Get Claude Code Transcript",
    description: "Return the archived summarized transcript for a Claude Code iteration task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: TASK_ID_SCHEMA },
      required: ["taskId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_cancel_iteration",
    title: "Cancel Claude Code Iteration",
    description: "Mark a running Claude Code task as cancelled and move its run to a terminal cancelled state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: TASK_ID_SCHEMA },
      required: ["taskId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ai_bridge_snapshot_changes",
    title: "Snapshot AI Bridge Changes",
    description: "Collect structured git baseline comparison including pre-existing, new, staged, unstaged, untracked, and renamed files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { runId: RUN_ID_SCHEMA },
      required: ["runId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_run_verification",
    title: "Run AI Bridge Verification",
    description: "Run inferred or explicit verification commands after Claude finishes and record structured results.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: RUN_ID_SCHEMA,
        commands: commandArraySchema,
        timeoutSec: { type: "integer", minimum: 1, maximum: 86400, default: 300 },
      },
      required: ["runId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ai_bridge_summarize_costs",
    title: "Summarize AI Bridge Usage",
    description: "Aggregate Claude usage, cache hit rate, and optional same-token hypothetical estimate. This does not report real savings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: RUN_ID_SCHEMA,
        pricing: {
          type: "object",
          additionalProperties: false,
          properties: {
            source: { type: "string" },
            deepseek: pricingBookSchema,
            codex: pricingBookSchema,
          },
          required: ["deepseek", "codex"],
        },
      },
      required: ["runId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ai_bridge_record_review",
    title: "Record AI Bridge Review",
    description: "Record Codex's pass, needs_fix, or blocked review result for a completed iteration and update run state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: RUN_ID_SCHEMA,
        iteration: { type: "integer", minimum: 1 },
        outcome: { type: "string", enum: ["pass", "needs_fix", "blocked"] },
        findings: { type: "array" },
        verificationCommandsRun: { type: "array" },
      },
      required: ["runId", "iteration", "outcome"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

async function callTool(name, args) {
  if (name === "ai_bridge_list_runs") {
    const result = await listRuns(args);
    return textResult(`Found ${result.runs.length} persisted run(s); diagnostics: ${result.diagnostics.length}.`, result);
  }
  if (name === "ai_bridge_inspect_run") {
    const result = await inspectRun(args);
    return textResult(`Run ${result.run.runId} is ${result.run.status}; tasks=${result.tasks.length}, diagnostics=${result.diagnostics.length}.`, result);
  }
  if (name === "ai_bridge_tail_run") {
    const result = await tailRun(args);
    return textResult(`Run ${result.runId} returned ${result.events.length} event(s); next cursor ${result.nextCursor}.`, result);
  }
  if (name === "ai_bridge_show_run_diff") {
    const result = await showRunDiff(args);
    return textResult(`Run ${result.runId} workspace changes=${result.changedFiles.length}; sensitive paths=${result.sensitivePaths.length}.`, result);
  }
  if (name === "ai_bridge_show_verification") {
    const result = await showVerification(args);
    return textResult(`Run ${result.runId} verification is ${result.status}; commands=${result.commands.length}.`, result);
  }
  if (name === "ai_bridge_export_run") {
    const result = await exportRun(args);
    return textResult(`Exported run ${result.runId} to ${result.outputPath}.`, result);
  }
  if (name === "ai_bridge_search_runs") {
    const result = await searchRuns(args);
    return textResult(`Historian found ${result.matches.length} run match(es); hasMore=${result.hasMore}; diagnostics=${result.diagnostics.length}.`, result);
  }
  if (name === "ai_bridge_search_errors") {
    const result = await searchErrors(args);
    return textResult(`Historian found ${result.matches.length} error match(es); hasMore=${result.hasMore}; diagnostics=${result.diagnostics.length}.`, result);
  }
  if (name === "ai_bridge_search_verification") {
    const result = await searchVerification(args);
    return textResult(`Historian found ${result.matches.length} verification match(es); hasMore=${result.hasMore}.`, result);
  }
  if (name === "ai_bridge_search_changed_files") {
    const result = await searchChangedFiles(args);
    return textResult(`Historian found ${result.matches.length} changed-file match(es); hasMore=${result.hasMore}.`, result);
  }
  if (name === "ai_bridge_search_reviews") {
    const result = await searchReviews(args);
    return textResult(`Historian found ${result.matches.length} review match(es); hasMore=${result.hasMore}.`, result);
  }
  if (name === "ai_bridge_workspace_memory_summary") {
    const result = await workspaceMemorySummary(args);
    return textResult(`Workspace memory contains ${result.recentRuns.length} recent run(s), ${result.recentFailures.length} failure(s), and ${result.diagnostics.length} diagnostic(s).`, result);
  }
  if (name === "ai_bridge_preflight") {
    const result = await preflight(args);
    if (!result.created) {
      return textResult(result.warning ?? `Existing workspace run ${result.runId} found.`, result);
    }
    return textResult(
      `AI Bridge ${result.runId} is ${result.status}. Claude session ${result.claude.sessionId}; resume mode ${result.claude.capabilities.resumeMode}. Dirty tree: ${result.git.dirty}.`,
      result,
    );
  }
  if (name === "ai_bridge_discover_workspace_runs") {
    const result = await discoverWorkspaceRuns(args);
    return textResult(`Found ${result.candidates.length} workspace run candidate(s). Recommended action: ${result.recommendedAction}.`, result);
  }
  if (name === "ai_bridge_attach_workspace_run") {
    const result = await attachWorkspaceRun(args);
    return textResult(result.attached
      ? `Attached workspace run ${result.runId}; run=${result.runStatus}, task=${result.taskStatus ?? "none"}.`
      : `Workspace run was not attached: ${result.reason}.`, result);
  }
  if (name === "ai_bridge_poll_workspace_run") {
    const result = await pollWorkspaceRun(args);
    const eventText = (result.latestEvents ?? []).map((event) => event.text).join("\n");
    return textResult(result.attached
      ? `Workspace run ${result.runId} is ${result.runStatus}.${eventText ? `\n${eventText}` : " No new events."}`
      : `Workspace run was not resolved: ${result.reason}.`, result);
  }
  if (name === "ai_bridge_prepare_plan_handoff") {
    const result = await preparePlanHandoff(args);
    return textResult(`Prepared approved plan handoff ${result.handoffIndex}. Prompt log: ${result.handoffPath}`, result);
  }
  if (name === "ai_bridge_start_claude_iteration") {
    const result = await startClaudeIteration(args);
    return textResult(`Claude iteration ${result.iteration} started as ${result.taskId} using ${result.sessionInvocationMode}.`, result);
  }
  if (name === "ai_bridge_poll_claude_iteration") {
    const result = await pollClaudeIteration(args);
    const eventText = result.events.map((event) => event.text).join("\n");
    const corruptText = result.corruptTranscriptLines.length ? ` Corrupt transcript lines: ${result.corruptTranscriptLines.length}.` : "";
    return textResult(eventText ? `Claude task ${result.taskId} is ${result.status}.${corruptText}\n${eventText}` : `Claude task ${result.taskId} is ${result.status}.${corruptText} No new events.`, result);
  }
  if (name === "ai_bridge_get_claude_transcript") {
    const result = await getClaudeTranscript(args);
    const eventText = result.events.map((event) => event.text).join("\n");
    return textResult(eventText ? `Claude task ${result.taskId} transcript:\n${eventText}` : `Claude task ${result.taskId} has no transcript events.`, result);
  }
  if (name === "ai_bridge_cancel_iteration") {
    const result = await cancelClaudeIteration(args);
    return textResult(`Claude task ${result.taskId} is ${result.status}. Cancelled: ${result.cancelled}.`, result);
  }
  if (name === "ai_bridge_snapshot_changes") {
    const result = await snapshotChanges(args);
    return textResult(`Snapshot captured. New-after-preflight files: ${result.changesCreatedAfterPreflight.length}; pre-existing files: ${result.preExistingChanges.length}; baseline invalidated: ${result.baselineInvalidated}.`, result);
  }
  if (name === "ai_bridge_run_verification") {
    const result = await runVerificationCommands(args);
    const failures = result.results.filter((item) => item.exitCode !== 0 || item.timedOut).length;
    return textResult(`Verification ran ${result.results.length} command(s); failures/timeouts: ${failures}.`, result);
  }
  if (name === "ai_bridge_record_review") {
    const result = await recordReview(args);
    return textResult(`Review recorded as ${args.outcome}. Run status is ${result.runStatus}.`, result);
  }
  if (name === "ai_bridge_summarize_costs") {
    const result = await summarizeCosts(args);
    const cacheText = result.cacheHitRate === null ? "n/a" : `${Math.round(result.cacheHitRate * 10000) / 100}%`;
    const estimateText = result.sameTokenHypotheticalEstimate
      ? ` Same-token hypothetical difference: ${result.sameTokenHypotheticalEstimate.difference}.`
      : " No pricing supplied; token usage only.";
    return textResult(
      `Usage tokens input=${result.usage.inputTokens}, output=${result.usage.outputTokens}, cacheCreate=${result.usage.cacheCreationInputTokens}, cacheRead=${result.usage.cacheReadInputTokens}. Cache hit rate: ${cacheText}.${estimateText}`,
      result,
    );
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Use AI Bridge tools only after the user confirms each Claude Code execution iteration. Codex remains responsible for planning, verification, and review.",
    });
    return;
  }
  if (method === "ping") return sendResult(id, {});
  if (method === "tools/list") return sendResult(id, { tools });
  if (method === "tools/call") {
    try {
      return sendResult(id, await callTool(params?.name, params?.arguments ?? {}));
    } catch (error) {
      return sendError(id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
    }
  }
  if (id !== undefined) sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
}

try {
  const recovery = await recoverRunningTasks();
  if (recovery.diagnostics.length) {
    process.stderr.write(`[AI Bridge] recovery diagnostics: ${JSON.stringify(recovery.diagnostics)}\n`);
  }
} catch (error) {
  process.stderr.write(`[AI Bridge] recovery scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    void handleRequest(JSON.parse(line));
  } catch {
    // Ignore malformed JSON-RPC input.
  }
});
