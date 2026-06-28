import assert from "node:assert/strict";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { APP_VERSION } from "../mcp/core.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repoRoot, "mcp", "server.mjs");

const REQUIRED_TOOLS = [
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
];

async function probeServer() {
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-plugin-exposure-"));
  const server = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, AI_BRIDGE_HOME: bridgeHome },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const responses = new Map();
  let stdoutBuffer = "";
  let stderr = "";
  let settled = false;

  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`MCP probe timed out; stderr=${stderr}`));
    }, 5000);

    const finish = () => {
      if (settled || !responses.has(1) || !responses.has(2)) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ initialize: responses.get(1), toolsList: responses.get(2) });
    };

    server.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 1 || message.id === 2) responses.set(message.id, message);
        finish();
      }
    });
    server.on("error", reject);
    server.on("close", (code) => {
      if (!settled) reject(new Error(`MCP server exited before responding with code ${code}; stderr=${stderr}`));
    });
  });

  server.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "ai-bridge-test", version: "0.0.0" },
    },
  })}\n`);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

  try {
    return await result;
  } finally {
    server.kill();
    if (server.exitCode === null && server.signalCode === null) {
      await new Promise((resolve) => server.once("close", resolve));
    }
    await rm(bridgeHome, { recursive: true, force: true });
  }
}

test("MCP server initializes and lists every required AI Bridge tool", async () => {
  const { initialize, toolsList } = await probeServer();
  assert.equal(initialize.error, undefined);
  assert.equal(initialize.result.serverInfo.version, APP_VERSION);
  assert.equal(toolsList.error, undefined);
  assert.ok(toolsList.result.tools.length >= 10);
  const names = new Set(toolsList.result.tools.map((tool) => tool.name));
  for (const name of REQUIRED_TOOLS) assert.ok(names.has(name), `missing tool ${name}`);
});

test("plugin manifest points to the AI Bridge skill layout", async () => {
  const manifestPath = path.join(repoRoot, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.name, "ai-bridge");
  assert.ok(manifest.version);
  const skillsRoot = path.resolve(repoRoot, manifest.skills);
  assert.equal((await stat(skillsRoot)).isDirectory(), true);
  assert.equal((await stat(path.join(skillsRoot, "ai-bridge", "SKILL.md"))).isFile(), true);
});

test("smoke script CLI reports a passing tools/list probe", async () => {
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-smoke-cli-"));
  try {
    const { stdout } = await execFile(process.execPath, ["scripts/smoke_mcp_tools.mjs"], {
      cwd: repoRoot,
      env: { ...process.env, AI_BRIDGE_HOME: bridgeHome },
      timeout: 10000,
      windowsHide: true,
    });
    assert.match(stdout, /AI Bridge MCP tools\/list smoke passed\./);
  } finally {
    await rm(bridgeHome, { recursive: true, force: true });
  }
});

test("diagnose script CLI reports local checks and Codex discovery as unknown", async () => {
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-diagnose-cli-"));
  try {
    const { stdout } = await execFile(process.execPath, ["scripts/diagnose_plugin_exposure.mjs"], {
      cwd: repoRoot,
      env: { ...process.env, AI_BRIDGE_HOME: bridgeHome },
      timeout: 10000,
      windowsHide: true,
    });
    assert.match(stdout, /AI Bridge Plugin Exposure Diagnostics/);
    assert.match(stdout, /Codex UI\/tool exposure: unknown/);
    const jsonText = stdout.split("--- JSON report ---\n")[1];
    assert.ok(jsonText, "missing JSON report");
    const report = JSON.parse(jsonText);
    assert.equal(report.ok, true);
    assert.equal(report.serverSmoke.ok, true);
    assert.equal(report.manifest.ok, true);
    assert.equal(report.skills.ok, true);
    assert.equal(report.mcpConfig.ok, true);
    assert.equal(report.mcpConfig.path, ".mcp.json");
    assert.equal(report.mcpConfig.serverName, "ai-bridge");
    assert.equal(report.codexDiscovery.status, "unknown");
  } finally {
    await rm(bridgeHome, { recursive: true, force: true });
  }
});
