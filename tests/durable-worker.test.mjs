import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { __testing, cancelClaudeIteration, pollClaudeIteration, preflight, recoverRunningTasks } from "../mcp/core.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function makeGitRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "ai-bridge-durable-repo-"));
  await execFile("git", ["init"], { cwd: repo });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFile("git", ["config", "user.name", "AI Bridge Durable Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# durable\n");
  await execFile("git", ["add", "README.md"], { cwd: repo });
  await execFile("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

async function makeDurableFakeClaude({ mode = "complete" } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-bridge-durable-bin-"));
  const script = path.join(dir, "fake-durable-claude.mjs");
  const behavior = {
    complete: [
      "emit('before server exit');",
      "await sleep(650);",
      "emit('during server downtime');",
      "await sleep(650);",
      "emit('natural completion after server exit');",
    ],
    timeout: [
      "emit('timeout task started');",
      "await sleep(10000);",
      "emit('timeout task should not finish');",
    ],
    cancel: [
      "emit('cancel task started');",
      "await sleep(10000);",
      "emit('cancel task should not finish');",
    ],
    immediate0: [
      "process.exit(0);",
    ],
    immediate7: [
      "process.exit(7);",
    ],
    immediateOutput: [
      "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'last line without newline' }] } }));",
      "process.exit(0);",
    ],
  }[mode];
  await writeFile(
    script,
    [
      "if (process.argv.includes('--version')) { console.log('2.1.105 (Claude Code fake)'); process.exit(0); }",
      "if (process.argv.includes('--help')) { console.log('Usage: claude -p --session-id <id> --resume <id> -r <id>'); process.exit(0); }",
      "for await (const _chunk of process.stdin) {}",
      "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
      "function emit(text) { console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })); }",
      ...behavior,
    ].join("\n"),
  );
  const command = path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") {
    await writeFile(command, `@echo off\r\nnode "${script}" %*\r\n`);
  } else {
    await writeFile(command, `#!/bin/sh\nnode "${script}" "$@"\n`);
    await chmod(command, 0o755);
  }
  return { dir };
}

async function waitForStatus(taskId, expected, attempts = 80, delayMs = 100) {
  let polled;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    polled = await pollClaudeIteration({ taskId, cursor: 0 });
    if (polled.status === expected) return polled;
  }
  return polled;
}

async function startFromShortLivedProcess({ repo, fake, bridgeHome, timeoutSec = 10, prompt = "durable prompt" }) {
  const startedPath = path.join(bridgeHome, `started-${Math.random().toString(36).slice(2)}.json`);
  await mkdir(bridgeHome, { recursive: true });
  const starterPath = path.join(bridgeHome, `start-task-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(
    starterPath,
    [
      "import { writeFile } from 'node:fs/promises';",
      "import { preflight, startClaudeIteration } from " + JSON.stringify(pathToFileURL(path.join(repoRoot, "mcp", "core.mjs")).href) + ";",
      `const run = await preflight({ workspacePath: ${JSON.stringify(repo)}, task: 'durable runner', env: process.env });`,
      `const started = await startClaudeIteration({ runId: run.runId, prompt: ${JSON.stringify(prompt)}, iteration: 1, timeoutSec: ${timeoutSec}, env: process.env });`,
      `await writeFile(${JSON.stringify(startedPath)}, JSON.stringify({ runId: run.runId, taskId: started.taskId, runDir: run.runDir, transcriptLogPath: started.transcriptLogPath, finalLogPath: started.finalLogPath, workerPid: started.workerPid }, null, 2));`,
      "process.exit(0);",
    ].join("\n"),
  );

  const env = {
    ...process.env,
    AI_BRIDGE_HOME: bridgeHome,
    PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const starter = spawn(process.execPath, [starterPath], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  starter.stderr.setEncoding("utf8");
  starter.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve) => starter.on("close", resolve));
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(await readFile(startedPath, "utf8"));
}

async function withBridgeHome(t) {
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-durable-home-"));
  const originalBridgeHome = process.env.AI_BRIDGE_HOME;
  process.env.AI_BRIDGE_HOME = bridgeHome;
  t.after(() => {
    if (originalBridgeHome === undefined) delete process.env.AI_BRIDGE_HOME;
    else process.env.AI_BRIDGE_HOME = originalBridgeHome;
  });
  return bridgeHome;
}

test("durable worker completes and preserves output after starter process exits", async (t) => {
  const repo = await makeGitRepo();
  const fake = await makeDurableFakeClaude();
  const bridgeHome = await withBridgeHome(t);
  const started = await startFromShortLivedProcess({ repo, fake, bridgeHome });
  const polled = await waitForStatus(started.taskId, "completed");

  assert.equal(polled.status, "completed");
  assert.match(polled.events.map((event) => event.text).join("\n"), /during server downtime/);
  const finalLog = JSON.parse(await readFile(started.finalLogPath, "utf8"));
  assert.equal(finalLog.exitCode, 0);
  assert.equal(finalLog.timedOut, false);
});

test("durable worker handles immediate exit and final unterminated stdout", async (t) => {
  const repo = await makeGitRepo();
  const bridgeHome = await withBridgeHome(t);

  const immediateSuccess = await startFromShortLivedProcess({
    repo,
    fake: await makeDurableFakeClaude({ mode: "immediate0" }),
    bridgeHome,
  });
  assert.equal((await waitForStatus(immediateSuccess.taskId, "completed")).status, "completed");

  const failedRunRepo = await makeGitRepo();
  const immediateFailure = await startFromShortLivedProcess({
    repo: failedRunRepo,
    fake: await makeDurableFakeClaude({ mode: "immediate7" }),
    bridgeHome: await withBridgeHome(t),
  });
  assert.equal((await waitForStatus(immediateFailure.taskId, "failed")).status, "failed");

  const outputRepo = await makeGitRepo();
  const immediateOutput = await startFromShortLivedProcess({
    repo: outputRepo,
    fake: await makeDurableFakeClaude({ mode: "immediateOutput" }),
    bridgeHome: await withBridgeHome(t),
  });
  const polled = await waitForStatus(immediateOutput.taskId, "completed");
  assert.match(polled.events.map((event) => event.text).join("\n"), /last line without newline/);
});

test("terminal task is not overwritten by stale running object", async (t) => {
  const repo = await makeGitRepo();
  const fake = await makeDurableFakeClaude();
  const bridgeHome = await withBridgeHome(t);
  const started = await startFromShortLivedProcess({ repo, fake, bridgeHome });
  const completed = await waitForStatus(started.taskId, "completed");
  assert.equal(completed.status, "completed");

  const taskPath = path.join(bridgeHome, "tasks", `${started.taskId}.json`);
  const terminalTask = JSON.parse(await readFile(taskPath, "utf8"));
  const accepted = await __testing.writeTaskIfNonTerminal({ ...terminalTask, status: "running", finishedAt: null });
  const after = JSON.parse(await readFile(taskPath, "utf8"));

  assert.equal(accepted, false);
  assert.equal(after.status, "completed");
  assert.ok(after.revision >= terminalTask.revision);
});

test("durable worker enforces timeout after starter process exits", async (t) => {
  const repo = await makeGitRepo();
  const fake = await makeDurableFakeClaude({ mode: "timeout" });
  const bridgeHome = await withBridgeHome(t);
  const started = await startFromShortLivedProcess({ repo, fake, bridgeHome, timeoutSec: 1 });

  const polled = await waitForStatus(started.taskId, "timed_out", 80, 100);

  const finalLog = JSON.parse(await readFile(started.finalLogPath, "utf8"));
  assert.equal(polled.status, "timed_out", JSON.stringify(finalLog));
  assert.equal(polled.timedOut, true);
  if (polled.pid) assert.equal(await __testing.processExists(polled.pid), false);
  assert.equal(finalLog.timedOut, true);
  assert.equal(finalLog.exitCode, 1);
});

test("durable worker can be cancelled after starter process exits", async (t) => {
  const repo = await makeGitRepo();
  const fake = await makeDurableFakeClaude({ mode: "cancel" });
  const bridgeHome = await withBridgeHome(t);
  const started = await startFromShortLivedProcess({ repo, fake, bridgeHome, timeoutSec: 30 });
  let running;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    running = await pollClaudeIteration({ taskId: started.taskId, cursor: 0 });
    if (running.status === "running" && running.pid) break;
  }
  assert.equal(running.status, "running");
  assert.ok(running.pid);

  const recovery = await recoverRunningTasks();
  assert.ok(
    recovery.recovered.some((item) => item.taskId === started.taskId && item.action === "left_running" && item.workerPid === started.workerPid),
    JSON.stringify(recovery),
  );

  const cancelled = await cancelClaudeIteration({ taskId: started.taskId });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelRequested, true);
  const polled = await waitForStatus(started.taskId, "cancelled", 40, 100);

  const finalLog = JSON.parse(await readFile(started.finalLogPath, "utf8"));
  assert.equal(polled.status, "cancelled", JSON.stringify(finalLog));
  assert.ok(polled.cancelRequestedAt);
  assert.equal(await __testing.processExists(running.pid), false);
  assert.equal(await __testing.processExists(started.workerPid), false);
  assert.equal(finalLog.cancelReason, "Cancelled by AI Bridge.");
});

test("recovery marks schema v2 task failed when worker is gone even if Claude pid is live", async (t) => {
  const repo = await makeGitRepo();
  const fake = await makeDurableFakeClaude({ mode: "cancel" });
  const bridgeHome = await withBridgeHome(t);
  const run = await preflight({
    workspacePath: repo,
    task: "orphaned worker",
    env: { ...process.env, PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  const childNeedle = `ai-bridge-orphan-${Date.now()}`;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", childNeedle], { windowsHide: true });
  t.after(() => {
    if (child.pid && __testing.processExists(child.pid)) child.kill();
  });
  const taskId = "task-20990101000000-abcd12";
  const childIdentity = await __testing.getProcessIdentity(child.pid);
  const taskDir = path.join(bridgeHome, "tasks");
  await mkdir(taskDir, { recursive: true });
  const task = {
    appVersion: "0.3.0",
    schemaVersion: 2,
    taskId,
    runId: run.runId,
    iteration: 1,
    status: "running",
    workerPid: 99999999,
    workerIdentity: null,
    workspacePath: repo,
    claudeSessionId: run.claude.sessionId,
    sessionInvocationMode: "session-id",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    timeoutSec: 30,
    deadlineAt: new Date(Date.now() + 30000).toISOString(),
    streamLogPath: path.join(run.runDir, "iteration-1.stream.jsonl"),
    transcriptLogPath: path.join(run.runDir, "iteration-1.transcript.jsonl"),
    finalLogPath: path.join(run.runDir, "iteration-1.json"),
    eventCount: 0,
    exitCode: null,
    timedOut: false,
    stderr: "",
    args: ["[PROMPT_ON_STDIN_REDACTED]"],
    pid: child.pid,
    processIdentity: childIdentity,
    processExecutable: childIdentity?.executable,
    processStartTime: childIdentity?.processStartTime,
    processCommandLineNeedle: childNeedle,
    heartbeatAt: new Date().toISOString(),
    lastEventAt: null,
  };
  await writeFile(task.streamLogPath, "");
  await writeFile(task.transcriptLogPath, "");
  await writeFile(path.join(taskDir, `${taskId}.json`), `${JSON.stringify(task, null, 2)}\n`);
  const runPath = path.join(run.runDir, "run.json");
  const runJson = JSON.parse(await readFile(runPath, "utf8"));
  runJson.status = "running";
  runJson.activeTaskId = taskId;
  runJson.currentIteration = 1;
  await writeFile(runPath, `${JSON.stringify(runJson, null, 2)}\n`);

  const recovery = await recoverRunningTasks();
  const polled = await pollClaudeIteration({ taskId, cursor: 0 });
  const updatedRun = JSON.parse(await readFile(runPath, "utf8"));

  assert.ok(recovery.recovered.some((item) => item.taskId === taskId && item.action === "killed_orphaned_claude"), JSON.stringify(recovery));
  assert.equal(polled.status, "failed");
  assert.equal(updatedRun.activeTaskId, null);
  assert.equal(await __testing.processExists(child.pid), false);
});

test("poll marks schema v2 task failed when worker exits before writing Claude pid", async (t) => {
  const repo = await makeGitRepo();
  const fake = await makeDurableFakeClaude({ mode: "cancel" });
  const bridgeHome = await withBridgeHome(t);
  const run = await preflight({
    workspacePath: repo,
    task: "worker vanished before pid",
    env: { ...process.env, PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  const taskId = "task-20990101000001-abcd12";
  const taskDir = path.join(bridgeHome, "tasks");
  await mkdir(taskDir, { recursive: true });
  const task = {
    appVersion: "0.3.0",
    schemaVersion: 2,
    taskId,
    runId: run.runId,
    iteration: 1,
    status: "running",
    workerPid: 99999999,
    workerIdentity: null,
    workspacePath: repo,
    claudeSessionId: run.claude.sessionId,
    sessionInvocationMode: "session-id",
    startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: null,
    timeoutSec: 30,
    deadlineAt: new Date(Date.now() + 30000).toISOString(),
    streamLogPath: path.join(run.runDir, "iteration-1.stream.jsonl"),
    transcriptLogPath: path.join(run.runDir, "iteration-1.transcript.jsonl"),
    finalLogPath: path.join(run.runDir, "iteration-1.json"),
    eventCount: 0,
    exitCode: null,
    timedOut: false,
    stderr: "",
    args: ["[PROMPT_ON_STDIN_REDACTED]"],
    pid: null,
    heartbeatAt: new Date().toISOString(),
    lastEventAt: null,
  };
  await writeFile(task.streamLogPath, "");
  await writeFile(task.transcriptLogPath, "");
  await writeFile(path.join(taskDir, `${taskId}.json`), `${JSON.stringify(task, null, 2)}\n`);
  const runPath = path.join(run.runDir, "run.json");
  const runJson = JSON.parse(await readFile(runPath, "utf8"));
  runJson.status = "running";
  runJson.activeTaskId = taskId;
  runJson.currentIteration = 1;
  await writeFile(runPath, `${JSON.stringify(runJson, null, 2)}\n`);

  const polled = await pollClaudeIteration({ taskId, cursor: 0 });
  const updatedRun = JSON.parse(await readFile(runPath, "utf8"));

  assert.equal(polled.status, "orphaned_unverifiable");
  assert.equal(updatedRun.activeTaskId, null);
});
