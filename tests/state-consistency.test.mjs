import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  __testing,
  cancelClaudeIteration,
  getClaudeTranscript,
  pollClaudeIteration,
  preflight,
  recoverRunningTasks,
  startClaudeIteration,
} from "../mcp/core.mjs";
import { registerTempCleanup } from "./temp-cleanup.mjs";

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
  registerTempCleanup(t, { bridgeHomes: [bridgeHome] });
  return bridgeHome;
}

async function createRun(t) {
  const bridgeHome = await withBridgeHome(t);
  const repo = await makeGitRepo();
  const fake = await makeFakeClaude({ delayMs: 3000 });
  registerTempCleanup(t, { paths: [repo, fake.dir] });
  const env = { ...process.env, PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}` };
  const run = await preflight({ workspacePath: repo, task: "state consistency", env });
  return { bridgeHome, repo, run };
}

async function writeSyntheticTask(bridgeHome, run, task) {
  const taskDir = path.join(bridgeHome, "tasks");
  await mkdir(taskDir, { recursive: true });
  const complete = {
    appVersion: "0.3.5",
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

async function readTaskJson(bridgeHome, taskId) {
  return JSON.parse(await readFile(path.join(bridgeHome, "tasks", `${taskId}.json`), "utf8"));
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

test("launcher identity detects PID reuse mismatch", async (t) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true });
  t.after(() => child.kill());
  let identity = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    identity = await __testing.getProcessIdentity(child.pid);
    if (identity?.processStartTime) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(identity?.processStartTime, `expected child process identity, got ${JSON.stringify(identity)}`);
  const status = await __testing.getLauncherIdentityStatus({
    reservationId: "reservation-pid-reuse",
    launcherPid: child.pid,
    launcherProcessStartTime: "definitely-not-the-child-start-time",
    launcherIdentity: {
      processStartTime: "definitely-not-the-child-start-time",
      executable: identity.executable,
      commandLine: identity.commandLine,
    },
  });
  assert.equal(status, "mismatched");
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
  registerTempCleanup(t, { paths: [fake.dir] });
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

test("stale writer is rejected before rewriting after fence loss", async (t) => {
  const bridgeHome = await withBridgeHome(t);
  const target = path.join(bridgeHome, "toctou-target.json");
  const lockPath = `${target}.lock`;
  const signalPath = path.join(bridgeHome, "toctou-stolen");
  const donePath = path.join(bridgeHome, "toctou-result.json");

  await writeFile(target, JSON.stringify({ value: 0, fenceEpoch: 0 }));

  const writerScript = path.join(bridgeHome, "toctou-writer.mjs");
  await writeFile(
    writerScript,
    [
      "import { readFile, writeFile } from 'node:fs/promises';",
      "import { __testing } from " + JSON.stringify(pathToFileURL(path.join(repoRoot, "mcp", "core.mjs")).href) + ";",
      "",
      `const target = ${JSON.stringify(target)};`,
      `const signalPath = ${JSON.stringify(signalPath)};`,
      `const donePath = ${JSON.stringify(donePath)};`,
      "",
      "try {",
      "  await __testing.withFileLock(target, async (lease) => {",
      "    await writeFile(signalPath, 'ready');",
      "    // Wait for thief to complete the steal",
      "    for (let i = 0; i < 100; i += 1) {",
      "      const stolen = await readFile(signalPath, 'utf8').catch(() => '');",
      "      if (stolen === 'stolen') break;",
      "      await new Promise((r) => setTimeout(r, 50));",
      "    }",
      "    // Now attempt to write: this should be rejected before rewriting because the lock was stolen",
      "    try {",
      "      await __testing.writeJsonWithFenceForTest(target, { value: 999, fenceEpoch: lease.fenceEpoch }, lease);",
      "      await writeFile(donePath, JSON.stringify({ result: 'unexpected_success' }));",
      "    } catch (error) {",
      "      await writeFile(donePath, JSON.stringify({ result: 'fence_rejected', message: error.message }));",
      "    }",
      "  }, { timeoutMs: 10000 });",
      "} catch (error) {",
      "  await writeFile(donePath, JSON.stringify({ result: 'error', message: error.message }));",
      "}",
    ].join("\n"),
  );

  const env = { ...process.env, AI_BRIDGE_HOME: bridgeHome };
  // Start writer process (it will hold the lock and wait for thief)
  const writer = spawn(process.execPath, [writerScript], { cwd: repoRoot, env, windowsHide: true });

  // Wait for writer to signal readiness
  for (let i = 0; i < 50; i += 1) {
    const signal = await readFile(signalPath, "utf8").catch(() => "");
    if (signal === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Thief: steal the lock and write a higher epoch
  await rm(lockPath, { force: true });
  await __testing.withFileLock(target, async (lease) => {
    await __testing.writeJsonWithFenceForTest(target, { value: 1, fenceEpoch: lease.fenceEpoch }, lease);
  }, { timeoutMs: 5000 });

  // Signal writer to proceed
  await writeFile(signalPath, "stolen");

  // Wait for writer to finish
  await new Promise((resolve) => writer.on("close", resolve));

  const done = JSON.parse(await readFile(donePath, "utf8"));
  const final = JSON.parse(await readFile(target, "utf8"));

  // Final state must be the thief's version (value: 1, epoch: 2), not the stale writer's
  assert.equal(final.value, 1);
  // The stale writer should have been rejected by the fence before rewriting.
  assert.match(done.result, /fence_rejected|error/);
});

test("completedIterationsHistory deduplicates by taskId+terminalTransitionId", async (t) => {
  const { bridgeHome, run } = await createRun(t);
  const runPathFile = path.join(run.runDir, "run.json");

  // Write a run with activeTaskId set to a different task
  const runJson = JSON.parse(await readFile(runPathFile, "utf8"));
  runJson.activeTaskId = "task-20990101010000-otherx";
  runJson.completedIterationsHistory = [
    { taskId: "task-20990101010000-old111", iteration: 1, terminalStatus: "completed", terminalTransitionId: "t1", observedAt: new Date().toISOString() },
  ];
  await writeFile(runPathFile, `${JSON.stringify(runJson, null, 2)}\n`);

  // Now call updateRunForTask via finalizeAsyncTask for a task with the SAME transitionId
  const task = await writeSyntheticTask(bridgeHome, run, {
    taskId: "task-20990101010000-old111",
    iteration: 1,
    status: "completed",
    terminalStatus: "completed",
    terminalTransitionId: "t1",
    finalizationPhase: "task_terminal_written",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
  });

  // The task should be completed but should NOT add a duplicate entry
  await recoverRunningTasks();
  const updated = JSON.parse(await readFile(runPathFile, "utf8"));
  const history = updated.completedIterationsHistory ?? [];
  // Should still have exactly 1 entry for this taskId+transitionId
  const matching = history.filter((e) => e.taskId === "task-20990101010000-old111");
  assert.equal(matching.length, 1);
  // Verify activeTaskId was NOT mutated (ownership invariant)
  assert.equal(updated.activeTaskId, "task-20990101010000-otherx");
});

test("finalLog repair during complete phase rebuilds from task state", async (t) => {
  const { bridgeHome, run } = await createRun(t);
  const taskId = "task-20990101010000-repr11";
  const task = await writeSyntheticTask(bridgeHome, run, {
    taskId,
    iteration: 1,
    status: "completed",
    terminalStatus: "completed",
    terminalTransitionId: "transition-repr1",
    finalizationPhase: "complete",
    finishedAt: new Date().toISOString(),
    exitCode: 0,
  });
  await reserveRun(run, taskId);

  // Delete the final log: completeTerminalFinalization should rebuild it
  await rm(task.finalLogPath, { force: true });

  // Recovery should rebuild the final log even though phase is 'complete'
  await recoverRunningTasks();
  const repaired = await readTaskJson(bridgeHome, taskId);
  const finalLog = JSON.parse(await readFile(task.finalLogPath, "utf8"));

  assert.equal(finalLog.status, "completed");
  assert.equal(finalLog.taskId, taskId);
  assert.equal(finalLog.terminalTransitionId, "transition-repr1");
  // Should have recorded the repair
  assert.ok(repaired.finalLogRepairCount >= 1, `expected repair count, got task: ${JSON.stringify(repaired)}`);
  assert.ok(repaired.lastFinalLogRepairAt);
  assert.equal(repaired.lastFinalLogRepairReason, "final_log_corrupt_or_missing_during_validation");
});

test("startReservation records launcher identity and worker lifecycle fields", async (t) => {
  const { bridgeHome, run } = await createRun(t);
  // Read the run after createRun: preflight doesn't create a startReservation
  // We need a task that goes through startClaudeIteration to populate the fields
  const fake = await makeFakeClaude({ delayMs: 500 });
  registerTempCleanup(t, { paths: [fake.dir] });
  const env = {
    ...process.env,
    AI_BRIDGE_HOME: bridgeHome,
    PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const run2 = await preflight({ workspacePath: run.workspacePath, task: "reservation fields test", env, allowConcurrentRun: true });

  // startClaudeIteration will create the reservation with launcher fields
  // We won't actually run to completion
  await assert.rejects(
    async () => {
      const started = await startClaudeIteration({
        runId: run2.runId,
        prompt: "test",
        iteration: 1,
        timeoutSec: 5,
        env: { ...env, AI_BRIDGE_TEST_FAULT: "after_run_reservation" },
      });
    },
    /injected fault/i,
  );

  const runJson = JSON.parse(await readFile(path.join(run2.runDir, "run.json"), "utf8"));
  const reservation = runJson.startReservation;
  assert.equal(reservation.phase, "reserved");
  assert.equal(reservation.launcherPid, process.pid);
  assert.ok(typeof reservation.launcherToken === "string" && reservation.launcherToken.length > 0);
  assert.ok(reservation.startupDeadlineAt);
  assert.equal(reservation.workerPid, null);
  assert.equal(reservation.workerIdentity, null);
});
