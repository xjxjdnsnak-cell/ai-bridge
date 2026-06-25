import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  __testing,
  getClaudeTranscript,
  pollClaudeIteration,
  preflight,
  recoverRunningTasks,
} from "../mcp/core.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function makeGitRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "ai-bridge-state-repo-"));
  await execFile("git", ["init"], { cwd: repo });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFile("git", ["config", "user.name", "AI Bridge State Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# state\n");
  await execFile("git", ["add", "README.md"], { cwd: repo });
  await execFile("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

async function makeFakeClaude({ delayMs = 0 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-bridge-state-bin-"));
  const script = path.join(dir, "fake-claude.mjs");
  await writeFile(
    script,
    [
      "if (process.argv.includes('--version')) { console.log('2.1.105 (Claude Code fake)'); process.exit(0); }",
      "if (process.argv.includes('--help')) { console.log('Usage: claude -p --session-id <id> --resume <id> -r <id>'); process.exit(0); }",
      "for await (const _chunk of process.stdin) {}",
      `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));",
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

async function withBridgeHome(t) {
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-state-home-"));
  const originalBridgeHome = process.env.AI_BRIDGE_HOME;
  process.env.AI_BRIDGE_HOME = bridgeHome;
  t.after(() => {
    if (originalBridgeHome === undefined) delete process.env.AI_BRIDGE_HOME;
    else process.env.AI_BRIDGE_HOME = originalBridgeHome;
  });
  return bridgeHome;
}

async function createRun(t) {
  const bridgeHome = await withBridgeHome(t);
  const repo = await makeGitRepo();
  const fake = await makeFakeClaude({ delayMs: 3000 });
  const env = { ...process.env, PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}` };
  const run = await preflight({ workspacePath: repo, task: "state consistency", env });
  return { bridgeHome, repo, run };
}

async function writeSyntheticTask(bridgeHome, run, task) {
  const taskDir = path.join(bridgeHome, "tasks");
  await mkdir(taskDir, { recursive: true });
  const complete = {
    appVersion: "0.3.2",
    schemaVersion: 2,
    revision: 0,
    runId: run.runId,
    workspacePath: run.workspacePath,
    claudeSessionId: run.claude.sessionId,
    sessionInvocationMode: "session-id",
    startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: null,
    timeoutSec: 30,
    deadlineAt: new Date(Date.now() + 30000).toISOString(),
    streamLogPath: path.join(run.runDir, `iteration-${task.iteration}.stream.jsonl`),
    transcriptLogPath: path.join(run.runDir, `iteration-${task.iteration}.transcript.jsonl`),
    finalLogPath: path.join(run.runDir, `iteration-${task.iteration}.json`),
    workerLogPath: path.join(run.runDir, `iteration-${task.iteration}.worker.log`),
    eventCount: 0,
    exitCode: null,
    timedOut: false,
    stderr: "",
    args: ["[PROMPT_ON_STDIN_REDACTED]"],
    pid: null,
    workerPid: null,
    workerLaunchToken: "synthetic-worker-token",
    workerIdentity: null,
    heartbeatAt: new Date().toISOString(),
    lastEventAt: null,
    ...task,
  };
  await writeFile(complete.streamLogPath, "");
  await writeFile(complete.transcriptLogPath, "");
  await writeFile(path.join(taskDir, `${complete.taskId}.json`), `${JSON.stringify(complete, null, 2)}\n`);
  return complete;
}

async function reserveRun(run, taskId, iteration = 1) {
  const runPath = path.join(run.runDir, "run.json");
  const runJson = JSON.parse(await readFile(runPath, "utf8"));
  runJson.status = "running";
  runJson.activeTaskId = taskId;
  runJson.currentIteration = iteration;
  runJson.updatedAt = new Date().toISOString();
  await writeFile(runPath, `${JSON.stringify(runJson, null, 2)}\n`);
}

test("file lock serializes two independent Node processes", async (t) => {
  const bridgeHome = await withBridgeHome(t);
  const lockTarget = path.join(bridgeHome, "counter.json");
  const workerScript = path.join(bridgeHome, "lock-worker.mjs");
  await writeFile(lockTarget, JSON.stringify({ value: 0 }));
  await writeFile(
    workerScript,
    [
      "import { readFile, writeFile } from 'node:fs/promises';",
      "import { __testing } from " + JSON.stringify(pathToFileURL(path.join(repoRoot, "mcp", "core.mjs")).href) + ";",
      `const target = ${JSON.stringify(lockTarget)};`,
      "for (let i = 0; i < 25; i += 1) {",
      "  await __testing.withFileLock(target, async () => {",
      "    const current = JSON.parse(await readFile(target, 'utf8'));",
      "    await new Promise((resolve) => setTimeout(resolve, 3));",
      "    await writeFile(target, JSON.stringify({ value: current.value + 1 }));",
      "  });",
      "}",
    ].join("\n"),
  );
  const env = { ...process.env, AI_BRIDGE_HOME: bridgeHome };
  const first = spawn(process.execPath, [workerScript], { cwd: repoRoot, env, windowsHide: true });
  const second = spawn(process.execPath, [workerScript], { cwd: repoRoot, env, windowsHide: true });
  const exits = await Promise.all([
    new Promise((resolve) => first.on("close", resolve)),
    new Promise((resolve) => second.on("close", resolve)),
  ]);
  assert.deepEqual(exits, [0, 0]);
  assert.equal(JSON.parse(await readFile(lockTarget, "utf8")).value, 50);
});

test("recovery completes terminal finalization phases idempotently", async (t) => {
  const { bridgeHome, run } = await createRun(t);
  const taskId = "task-20990101010000-abcd12";
  await writeSyntheticTask(bridgeHome, run, {
    taskId,
    iteration: 1,
    status: "completed",
    terminalStatus: "completed",
    finalizationPhase: "task_terminal_written",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
  });
  await reserveRun(run, taskId);

  await recoverRunningTasks();
  await recoverRunningTasks();

  const task = await pollClaudeIteration({ taskId, cursor: 0 });
  const finalLog = JSON.parse(await readFile(path.join(run.runDir, "iteration-1.json"), "utf8"));
  const runJson = JSON.parse(await readFile(path.join(run.runDir, "run.json"), "utf8"));
  assert.equal(task.status, "completed");
  assert.equal(task.finalizationPhase, "complete");
  assert.equal(finalLog.status, "completed");
  assert.equal(runJson.status, "awaiting_review");
  assert.deepEqual(runJson.completedIterations, [1]);
  assert.equal(runJson.activeTaskId, null);
});

test("late terminal finalizer uses landed terminal status for run and final log", async (t) => {
  const { bridgeHome, run } = await createRun(t);
  const taskId = "task-20990101010001-abcd12";
  const task = await writeSyntheticTask(bridgeHome, run, {
    taskId,
    iteration: 1,
    status: "completed",
    terminalStatus: "completed",
    finalizationPhase: "task_terminal_written",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
  });
  await reserveRun(run, taskId);

  await __testing.finalizeAsyncTask({ ...task, status: "running" }, "failed", { exitCode: 1, stderr: "stale failure" });

  const finalLog = JSON.parse(await readFile(path.join(run.runDir, "iteration-1.json"), "utf8"));
  const runJson = JSON.parse(await readFile(path.join(run.runDir, "run.json"), "utf8"));
  assert.equal(finalLog.status, "completed");
  assert.equal(runJson.status, "awaiting_review");
  assert.deepEqual(runJson.completedIterations, [1]);
});

test("process identity with required command line but no command line is unverifiable", async () => {
  assert.equal(
    __testing.processIdentityStatus(
      { pid: 123, processCommandLineNeedle: "required-needle" },
      { pid: 123, available: true, commandLine: null },
    ),
    "unverifiable",
  );
});

test("getClaudeTranscript reports status after polling recovery", async (t) => {
  const { bridgeHome, run } = await createRun(t);
  const taskId = "task-20990101010002-abcd12";
  await writeSyntheticTask(bridgeHome, run, {
    taskId,
    iteration: 1,
    status: "running",
    workerPid: 99999999,
    workerIdentity: null,
  });
  await reserveRun(run, taskId);

  const transcript = await getClaudeTranscript({ taskId });

  assert.equal(transcript.status, "orphaned_unverifiable");
});

test("two independent servers cannot start the same run iteration twice", async (t) => {
  const { bridgeHome, run } = await createRun(t);
  const starterScript = path.join(bridgeHome, "concurrent-start.mjs");
  const resultA = path.join(bridgeHome, "start-a.json");
  const resultB = path.join(bridgeHome, "start-b.json");
  await writeFile(
    starterScript,
    [
      "import { writeFile } from 'node:fs/promises';",
      "import { startClaudeIteration } from " + JSON.stringify(pathToFileURL(path.join(repoRoot, "mcp", "core.mjs")).href) + ";",
      "const [runId, outPath] = process.argv.slice(2);",
      "try {",
      "  const started = await startClaudeIteration({ runId, prompt: 'concurrent start', iteration: 1, timeoutSec: 20, env: process.env });",
      "  await writeFile(outPath, JSON.stringify({ ok: true, started }, null, 2));",
      "} catch (error) {",
      "  await writeFile(outPath, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));",
      "}",
    ].join("\n"),
  );
  const fake = await makeFakeClaude();
  const env = {
    ...process.env,
    AI_BRIDGE_HOME: bridgeHome,
    PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const first = spawn(process.execPath, [starterScript, run.runId, resultA], { cwd: repoRoot, env, windowsHide: true });
  const second = spawn(process.execPath, [starterScript, run.runId, resultB], { cwd: repoRoot, env, windowsHide: true });
  await Promise.all([
    new Promise((resolve) => first.on("close", resolve)),
    new Promise((resolve) => second.on("close", resolve)),
  ]);
  const results = [
    JSON.parse(await readFile(resultA, "utf8")),
    JSON.parse(await readFile(resultB, "utf8")),
  ];
  const successes = results.filter((item) => item.ok);
  const failures = results.filter((item) => !item.ok);
  assert.equal(successes.length, 1, JSON.stringify(results));
  assert.equal(failures.length, 1, JSON.stringify(results));
  assert.match(failures[0].error, /already has running task/);

  const runJson = JSON.parse(await readFile(path.join(run.runDir, "run.json"), "utf8"));
  assert.equal(runJson.activeTaskId, successes[0].started.taskId);
  assert.equal(runJson.currentIteration, 1);
});
