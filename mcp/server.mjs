import readline from "node:readline";

import {
  cancelClaudeIteration,
  getClaudeTranscript,
  pollClaudeIteration,
  preparePlanHandoff,
  preflight,
  recordReview,
  runClaudeIteration,
  runVerificationCommands,
  snapshotChanges,
  startClaudeIteration,
  summarizeCosts,
} from "./core.mjs";

const SERVER_NAME = "AI Bridge MCP";
const SERVER_VERSION = "0.2.0";
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

const tools = [
  {
    name: "ai_bridge_preflight",
    title: "AI Bridge Preflight",
    description: "Create a v0.2.0 AI Bridge run, capture git baseline, inspect Claude CLI capabilities, and infer verification commands.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: { type: "string", minLength: 1 },
        task: { type: "string", minLength: 1 },
        maxIterations: { type: "integer", minimum: 1, maximum: 20, default: 3 },
        verificationCommands: commandArraySchema,
      },
      required: ["workspacePath", "task"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    name: "ai_bridge_run_claude_iteration",
    title: "Run Claude Code Iteration",
    description: "Compatibility synchronous Claude Code iteration using stdin prompt and sanitized logs. Prefer async start/poll.",
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
  if (name === "ai_bridge_preflight") {
    const result = await preflight(args);
    return textResult(
      `AI Bridge ${result.runId} is ${result.status}. Claude session ${result.claude.sessionId}; resume mode ${result.claude.capabilities.resumeMode}. Dirty tree: ${result.git.dirty}.`,
      result,
    );
  }
  if (name === "ai_bridge_prepare_plan_handoff") {
    const result = await preparePlanHandoff(args);
    return textResult(`Prepared approved plan handoff ${result.handoffIndex}. Prompt log: ${result.handoffPath}`, result);
  }
  if (name === "ai_bridge_run_claude_iteration") {
    const result = await runClaudeIteration(args);
    return textResult(`Claude iteration ${result.iteration} finished with exit code ${result.exitCode}. Log: ${result.logPath}`, result);
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

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    void handleRequest(JSON.parse(line));
  } catch {
    // Ignore malformed JSON-RPC input.
  }
});
