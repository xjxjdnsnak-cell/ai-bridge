import { spawn, execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { cleanupTrackedBridgeProcesses, removeTempPath } from "./temp-cleanup.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repoRoot, "mcp", "server.mjs");
const tempRoot = await mkdtemp(path.join(tmpdir(), "ai-bridge-integration-"));
const repo = path.join(tempRoot, "repo");
const bin = path.join(tempRoot, "bin");
await mkdir(repo);
await mkdir(bin);
await execFile("git", ["init"], { cwd: repo });
await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo });
await execFile("git", ["config", "user.name", "AI Bridge Integration"], { cwd: repo });
await writeFile(path.join(repo, "README.md"), "# before\n");
await execFile("git", ["add", "README.md"], { cwd: repo });
await execFile("git", ["commit", "-m", "init"], { cwd: repo });

const stdinLog = path.join(tempRoot, "claude-stdin.txt");
const argsLog = path.join(tempRoot, "claude-args.json");
const fakeScript = path.join(bin, "fake-claude.mjs");
await writeFile(fakeScript, `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('2.1.105 (Claude Code fake)'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('Usage: claude -p --session-id <id> --resume <id> -r <id>'); process.exit(0); }
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(stdinLog)}, stdin);
writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2), null, 2));
writeFileSync(join(process.cwd(), 'README.md'), '# after ai bridge integration\\n');
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Implemented from stdin prompt' }] } }));
console.log(JSON.stringify({ type: 'tool_use', name: 'Write', input: { file_path: 'README.md' } }));
console.log(JSON.stringify({ type: 'tool_result', name: 'Write', exitCode: 0, content: 'ok' }));
process.exit(0);
`);
const fakeClaude = path.join(bin, process.platform === "win32" ? "claude.cmd" : "claude");
if (process.platform === "win32") {
  await writeFile(fakeClaude, `@echo off\r\nnode "${fakeScript}" %*\r\n`);
} else {
  await writeFile(fakeClaude, `#!/bin/sh\nnode "${fakeScript}" "$@"\n`);
  await chmod(fakeClaude, 0o755);
}

const env = { ...process.env, AI_BRIDGE_HOME: path.join(tempRoot, "bridge-home"), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
const server = spawn(process.execPath, [serverPath], { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let nextId = 1;
const pending = new Map();
let stdoutBuffer = "";
let stderr = "";
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => {
  stderr += chunk;
});
server.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  for (;;) {
    const index = stdoutBuffer.indexOf("\n");
    if (index < 0) break;
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout for ${method}; stderr=${stderr}`)), 15000);
    pending.set(id, { resolve, reject, timer });
  });
}

function callTool(name, args) {
  return rpc("tools/call", { name, arguments: args }).then((result) => result.structuredContent);
}

try {
  await rpc("initialize", { protocolVersion: "2025-11-25" });
  const listed = await rpc("tools/list", {});
  for (const needed of ["ai_bridge_preflight", "ai_bridge_discover_workspace_runs", "ai_bridge_attach_workspace_run", "ai_bridge_poll_workspace_run", "ai_bridge_prepare_plan_handoff", "ai_bridge_start_claude_iteration", "ai_bridge_poll_claude_iteration", "ai_bridge_snapshot_changes", "ai_bridge_record_review"]) {
    assert.ok(listed.tools.some((tool) => tool.name === needed), `missing tool ${needed}`);
  }
  assert.equal(listed.tools.some((tool) => tool.name === "ai_bridge_run_claude_iteration"), false);
  await assert.rejects(
    () => callTool("ai_bridge_run_claude_iteration", { runId: "run-20990101000000-abcdef", prompt: "x", iteration: 1 }),
    /Unknown tool/,
  );
  const preflight = await callTool("ai_bridge_preflight", { workspacePath: repo, task: "Change README via fake Claude" });
  const discovery = await callTool("ai_bridge_discover_workspace_runs", { workspacePath: repo });
  assert.equal(discovery.candidates.some((candidate) => candidate.runId === preflight.runId), true);
  const handoff = await callTool("ai_bridge_prepare_plan_handoff", { runId: preflight.runId, planText: "<proposed_plan>\nChange README to prove stdin prompt execution.\n</proposed_plan>" });
  const started = await callTool("ai_bridge_start_claude_iteration", { runId: preflight.runId, prompt: handoff.handoffPrompt, iteration: 1, timeoutSec: 20 });
  let poll = { status: "running", nextCursor: 0, events: [] };
  const allEvents = [];
  for (let index = 0; index < 30 && poll.status === "running"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    poll = await callTool("ai_bridge_poll_claude_iteration", { taskId: started.taskId, cursor: poll.nextCursor ?? 0 });
    allEvents.push(...poll.events);
  }
  assert.equal(poll.status, "completed");
  const snapshot = await callTool("ai_bridge_snapshot_changes", { runId: preflight.runId });
  await callTool("ai_bridge_record_review", { runId: preflight.runId, iteration: 1, outcome: "pass" });
  const stdin = await readFile(stdinLog, "utf8");
  const args = JSON.parse(await readFile(argsLog, "utf8"));
  const readme = await readFile(path.join(repo, "README.md"), "utf8");
  assert.match(stdin, /Approved Codex Plan/);
  assert.equal(args.some((arg) => String(arg).includes("Approved Codex Plan")), false);
  assert.match(readme, /after ai bridge integration/);
  assert.ok(snapshot.changedFiles.some((file) => file.path === "README.md"));
  console.log(JSON.stringify({
    ok: true,
    runId: preflight.runId,
    taskId: started.taskId,
    finalStatus: poll.status,
    transcriptEvents: allEvents.map((event) => event.text),
    changedFiles: snapshot.changedFiles,
    promptOnStdin: stdin.includes("Approved Codex Plan"),
    promptInArgv: args.some((arg) => String(arg).includes("Approved Codex Plan")),
  }, null, 2));
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill();
    await new Promise((resolve) => server.once("close", resolve));
  }
  await cleanupTrackedBridgeProcesses(path.join(tempRoot, "bridge-home"));
  await removeTempPath(tempRoot);
}
