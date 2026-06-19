import readline from "node:readline";

import {
  getClaudeTranscript,
  pollClaudeIteration,
  preflight,
  recordReview,
  runClaudeIteration,
  snapshotChanges,
  startClaudeIteration,
} from "./core.mjs";

const SERVER_NAME = "AI Bridge MCP";
const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
};

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
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

const tools = [
  {
    name: "ai_bridge_preflight",
    title: "AI Bridge Preflight",
    description:
      "Check git workspace safety, Claude Code availability, dirty status, and verification command inference before starting an AI Bridge run.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        task: { type: "string" },
        maxIterations: { type: "integer", minimum: 1, default: 3 },
        verificationCommands: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["workspacePath", "task"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "ai_bridge_run_claude_iteration",
    title: "Run Claude Code Iteration",
    description:
      "Run one confirmed Claude Code implementation iteration in the target git workspace and capture sanitized logs.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        prompt: { type: "string" },
        iteration: { type: "integer", minimum: 1 },
        timeoutSec: { type: "integer", minimum: 1, default: 900 },
        claudeArgs: { type: "array", items: { type: "string" } },
      },
      required: ["runId", "prompt", "iteration"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "ai_bridge_start_claude_iteration",
    title: "Start Claude Code Iteration",
    description:
      "Start one confirmed Claude Code iteration in the background using stream-json output so Codex can poll and display progress.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        prompt: { type: "string" },
        iteration: { type: "integer", minimum: 1 },
        timeoutSec: { type: "integer", minimum: 1, default: 900 },
        claudeArgs: { type: "array", items: { type: "string" } },
      },
      required: ["runId", "prompt", "iteration"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "ai_bridge_poll_claude_iteration",
    title: "Poll Claude Code Iteration",
    description:
      "Return summarized Claude Code transcript events after the provided cursor and the current async iteration status.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        cursor: { type: "integer", minimum: 0, default: 0 },
      },
      required: ["taskId"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ai_bridge_get_claude_transcript",
    title: "Get Claude Code Transcript",
    description:
      "Return the archived summarized transcript for a Claude Code iteration task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ai_bridge_snapshot_changes",
    title: "Snapshot AI Bridge Changes",
    description:
      "Collect git status, diff stat, changed files, untracked files, and run log location after a Claude Code iteration.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ai_bridge_record_review",
    title: "Record AI Bridge Review",
    description:
      "Append Codex's pass, needs_fix, or blocked review result for one AI Bridge iteration.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        iteration: { type: "integer", minimum: 1 },
        outcome: { type: "string", enum: ["pass", "needs_fix", "blocked"] },
        findings: { type: "array" },
        verificationCommandsRun: { type: "array" },
      },
      required: ["runId", "iteration", "outcome"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

async function callTool(name, args) {
  if (name === "ai_bridge_preflight") {
    const result = await preflight(args);
    return textResult(
      `AI Bridge preflight created ${result.runId} with Claude session ${result.claude.sessionId}. Dirty tree: ${result.git.dirty}. Verification commands: ${result.verificationCommands.join(", ") || "none inferred"}.`,
      result,
    );
  }
  if (name === "ai_bridge_run_claude_iteration") {
    const result = await runClaudeIteration(args);
    return textResult(
      `Claude iteration ${result.iteration} finished with exit code ${result.exitCode}. Log: ${result.logPath}`,
      result,
    );
  }
  if (name === "ai_bridge_start_claude_iteration") {
    const result = await startClaudeIteration(args);
    return textResult(
      `Claude iteration ${result.iteration} started as ${result.taskId}. Poll ai_bridge_poll_claude_iteration with cursor 0 for live transcript events.`,
      result,
    );
  }
  if (name === "ai_bridge_poll_claude_iteration") {
    const result = await pollClaudeIteration(args);
    const eventText = result.events.map((event) => event.text).join("\n");
    return textResult(
      eventText
        ? `Claude task ${result.taskId} is ${result.status}. New events:\n${eventText}`
        : `Claude task ${result.taskId} is ${result.status}. No new events.`,
      result,
    );
  }
  if (name === "ai_bridge_get_claude_transcript") {
    const result = await getClaudeTranscript(args);
    const eventText = result.events.map((event) => event.text).join("\n");
    return textResult(
      eventText
        ? `Claude task ${result.taskId} transcript:\n${eventText}`
        : `Claude task ${result.taskId} has no transcript events.`,
      result,
    );
  }
  if (name === "ai_bridge_snapshot_changes") {
    const result = await snapshotChanges(args);
    return textResult(
      `Snapshot captured. Changed files: ${result.changedFiles.length}; untracked files: ${result.untrackedFiles.length}.`,
      result,
    );
  }
  if (name === "ai_bridge_record_review") {
    const result = await recordReview(args);
    return textResult(`Review recorded as ${args.outcome}.`, result);
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: "0.1.0" },
      instructions:
        "Use AI Bridge tools only after the user confirms each Claude Code execution iteration. Codex remains responsible for planning and review.",
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools });
    return;
  }
  if (method === "tools/call") {
    try {
      sendResult(id, await callTool(params?.name, params?.arguments ?? {}));
    } catch (error) {
      sendError(id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (id !== undefined) {
    sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    void handleRequest(JSON.parse(line));
  } catch {
    // Ignore malformed JSON-RPC input.
  }
});
