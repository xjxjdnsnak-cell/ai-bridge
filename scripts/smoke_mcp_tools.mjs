import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_AI_BRIDGE_TOOLS = [
  "ai_bridge_preflight",
  "ai_bridge_discover_workspace_runs",
  "ai_bridge_attach_workspace_run",
  "ai_bridge_poll_workspace_run",
  "ai_bridge_prepare_plan_handoff",
  "ai_bridge_start_claude_iteration",
  "ai_bridge_poll_claude_iteration",
  "ai_bridge_cancel_iteration",
  "ai_bridge_snapshot_changes",
  "ai_bridge_run_verification",
  "ai_bridge_record_review",
  "ai_bridge_summarize_costs",
  "ai_bridge_list_runs",
  "ai_bridge_inspect_run",
  "ai_bridge_tail_run",
  "ai_bridge_show_run_diff",
  "ai_bridge_show_verification",
  "ai_bridge_export_run",
  "ai_bridge_search_runs",
  "ai_bridge_search_errors",
  "ai_bridge_search_verification",
  "ai_bridge_search_changed_files",
  "ai_bridge_search_reviews",
  "ai_bridge_workspace_memory_summary",
  "ai_bridge_failure_pattern_summary",
];

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");

function appendBounded(current, chunk, maxLength = 12000) {
  return `${current}${chunk}`.slice(-maxLength);
}

async function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("close", onClose);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  if (await waitForClose(child, 1000)) return;
  child.kill("SIGKILL");
  await waitForClose(child, 1000);
}

export async function runMcpToolsSmoke({ repoRoot = defaultRepoRoot, timeoutMs = 5000 } = {}) {
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-mcp-smoke-"));
  const serverPath = path.join(repoRoot, "mcp", "server.mjs");
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, AI_BRIDGE_HOME: bridgeHome },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const pending = new Map();
  let stdoutBuffer = "";
  let rawStdout = "";
  let stderr = "";
  let exitCode = null;
  let fatalError = null;

  const rejectPending = (error) => {
    fatalError = fatalError ?? error;
    for (const { reject } of pending.values()) reject(fatalError);
    pending.clear();
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.stdout.on("data", (chunk) => {
    rawStdout = appendBounded(rawStdout, chunk);
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        waiter.resolve(message);
      } catch (error) {
        rejectPending(new Error(`Invalid JSON line from MCP server: ${error.message}`));
      }
    }
  });
  child.on("error", rejectPending);
  child.on("close", (code) => {
    exitCode = code;
    rejectPending(new Error(`MCP server exited before smoke completion with code ${code}`));
  });

  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  };

  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`MCP smoke timed out after ${timeoutMs} ms`)), timeoutMs);
  });

  let initializeResponse = null;
  let toolsListResponse = null;
  try {
    initializeResponse = await Promise.race([
      request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "ai-bridge-smoke", version: "0.0.0" },
      }),
      deadline,
    ]);
    toolsListResponse = await Promise.race([request("tools/list", {}), deadline]);

    const tools = toolsListResponse?.result?.tools ?? [];
    const names = new Set(tools.map((tool) => tool.name));
    const missingRequiredTools = REQUIRED_AI_BRIDGE_TOOLS.filter((name) => !names.has(name));
    const protocolErrors = [
      initializeResponse?.error ? `initialize: ${initializeResponse.error.message ?? "unknown error"}` : null,
      toolsListResponse?.error ? `tools/list: ${toolsListResponse.error.message ?? "unknown error"}` : null,
      initializeResponse?.result?.serverInfo?.version ? null : "initialize response omitted serverInfo.version",
      Array.isArray(toolsListResponse?.result?.tools) ? null : "tools/list response omitted tools",
    ].filter(Boolean);

    return {
      ok: protocolErrors.length === 0 && missingRequiredTools.length === 0,
      serverVersion: initializeResponse?.result?.serverInfo?.version ?? null,
      toolCount: tools.length,
      requiredToolsPresent: missingRequiredTools.length === 0,
      missingRequiredTools,
      protocolErrors,
      initializeResponse,
      toolsListResponse,
      stderr,
      exitCode,
    };
  } catch (error) {
    return {
      ok: false,
      serverVersion: initializeResponse?.result?.serverInfo?.version ?? null,
      toolCount: toolsListResponse?.result?.tools?.length ?? 0,
      requiredToolsPresent: false,
      missingRequiredTools: [...REQUIRED_AI_BRIDGE_TOOLS],
      protocolErrors: [error instanceof Error ? error.message : String(error)],
      initializeResponse,
      toolsListResponse,
      rawStdout,
      stderr,
      exitCode,
    };
  } finally {
    clearTimeout(timeout);
    await stopChild(child);
    await rm(bridgeHome, { recursive: true, force: true });
  }
}

function printable(value) {
  return value === null || value === undefined ? "<none>" : JSON.stringify(value);
}

export function formatSmokeResult(result) {
  if (result.ok) {
    return [
      "AI Bridge MCP tools/list smoke passed.",
      `Server version: ${result.serverVersion}`,
      `Tool count: ${result.toolCount}`,
      "Required tools present: yes",
    ].join("\n");
  }
  return [
    "AI Bridge MCP tools/list smoke failed.",
    `Missing tools: ${JSON.stringify(result.missingRequiredTools)}`,
    `Protocol errors: ${JSON.stringify(result.protocolErrors)}`,
    `Raw initialize response: ${printable(result.initializeResponse)}`,
    `Raw tools/list response: ${printable(result.toolsListResponse)}`,
    `Server stderr: ${result.stderr || "<empty>"}`,
    `Exit code: ${result.exitCode ?? "<not exited before cleanup>"}`,
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const result = await runMcpToolsSmoke();
  process.stdout.write(`${formatSmokeResult(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
