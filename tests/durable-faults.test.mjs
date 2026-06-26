import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  __testing,
  cancelClaudeIteration,
  pollClaudeIteration,
  preflight,
  recoverRunningTasks,
  startClaudeIteration,
} from "../mcp/core.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, "..");
const coreUrl = pathToFileURL(path.join(repoRoot, "mcp", "core.mjs")).href;

async function makeGitRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "ai-bridge-fault-repo-"));
  await execFile("git", ["init"], { cwd: repo });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFile("git", ["config", "user.name", "AI Bridge Fault Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# fault\n");
  await execFile("git", ["add", "README.md"], { cwd: repo });
  await execFile("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

async function makeFakeClaude({ mode = "complete", delayMs = 0 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-bridge-fault-bin-"));
  const script = path.join(dir, "fake-claude.mjs");
  const behavior = {
    complete: [
      `await sleep(${delayMs});`,
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));",
    ],
    slow: [
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'started' }] } }));",
      "await sleep(5000);",
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }));",
    ],
    neverReads: [
      "await sleep(5000);",
    ],
  }[mode];
  await writeFile(
    script,
    [
      "if (process.argv.includes('--version')) { console.log('2.1.105 (Claude Code fake)'); process.exit(0); }",
      "if (process.argv.includes('--help')) { console.log('Usage: claude -p --session-id <id> --resume <id> -r <id>'); process.exit(0); }",
      "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
      "for await (const _chunk of process.stdin) {}",
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

async function withBridgeHome(t) {
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-fault-home-"));
  const original = process.env.AI_BRIDGE_HOME;
  process.env.AI_BRIDGE_HOME = bridgeHome;
  t.after(() => {
    if (original === undefined) delete process.env.AI_BRIDGE_HOME;
    else process.env.AI_BRIDGE_HOME = original;
  });
  return bridgeHome;
}

async function createRun(t, fakeOptions = {}) {
  const bridgeHome = await withBridgeHome(t);
  const repo = await makeGitRepo();
  const fake = await makeFakeClaude(fakeOptions);
  const env = { ...process.env, AI_BRIDGE_HOME: bridgeHome, PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}` };
  const run = await preflight({ workspacePath: repo, task: "durable fault", env });
  return { bridgeHome, repo, fake, env, run };
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

async function readRunJson(run) {
  return JSON.parse(await readFile(path.join(run.runDir, "run.json"), "utf8"));
}

async function readTaskJson(bridgeHome, taskId) {
  return JSON.parse(await readFile(path.join(bridgeHome, "tasks", `${taskId}.json`), "utf8"));
}

async function listLockFiles(root) {
  const found = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...await listLockFiles(entryPath));
    } else if (entry.name.endsWith(".lock")) {
      found.push(entryPath);
    }
  }
  return found;
}

async function writeSyntheticTask(bridgeHome, run, task) {
  const taskDir = path.join(bridgeHome, "tasks");
  await mkdir(taskDir, { recursive: true });
  const payload = {
    appVersion: "0.3.3",
    schemaVersion: 2,
    revision: 0,
    taskId: task.taskId,
    runId: run.runId,
    iteration: task.iteration,
    status: task.status,
    terminalStatus: task.terminalStatus ?? task.status,
    terminalTransitionId: task.terminalTransitionId ?? `transition-${task.taskId}`,
    finalizationPhase: task.finalizationPhase ?? "task_terminal_written",
    workspacePath: run.workspacePath,
    claudeSessionId: run.claude.sessionId,
    sessionInvocationMode: "session-id",
    startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: task.finishedAt ?? new Date().toISOString(),
    timeoutSec: 30,
    deadlineAt: new Date(Date.now() + 30000).toISOString(),
    streamLogPath: path.join(run.runDir, `iteration-${task.iteration}.stream.jsonl`),
    transcriptLogPath: path.join(run.runDir, `iteration-${task.iteration}.transcript.jsonl`),
    finalLogPath: path.join(run.runDir, `iteration-${task.iteration}.json`),
    workerLogPath: path.join(run.runDir, `iteration-${task.iteration}.worker.log`),
    eventCount: 0,
    exitCode: task.exitCode ?? 0,
    timedOut: task.status === "timed_out",
    stderr: "",
    args: ["[PROMPT_ON_STDIN_REDACTED]"],
    pid: null,
    workerPid: null,
    workerLaunchToken: "synthetic-token",
    workerIdentity: null,
    heartbeatAt: new Date().toISOString(),
    lastEventAt: null,
    ...task,
  };
  await writeFile(payload.streamLogPath, "");
  await writeFile(payload.transcriptLogPath, "");
  await writeFile(path.join(taskDir, `${payload.taskId}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

async function setRunActive(run, taskId, iteration = 1) {
  const runPath = path.join(run.runDir, "run.json");
  const runJson = JSON.parse(await readFile(runPath, "utf8"));
  runJson.status = "running";
  runJson.activeTaskId = taskId;
  runJson.currentIteration = iteration;
  runJson.updatedAt = new Date().toISOString();
  await writeFile(runPath, `${JSON.stringify(runJson, null, 2)}\n`);
}

test("fenced locks recover empty and corrupt dead-owner locks but do not steal live owners", async (t) => {
  const bridgeHome = await withBridgeHome(t);
  const target = path.join(bridgeHome, "state.json");
  await writeFile(target, "{}");

  const lockPath = `${target}.lock`;
  await writeFile(lockPath, "");
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  await __testing.withFileLock(target, async () => {
    await writeFile(target, JSON.stringify({ emptyRecovered: true }));
  }, { timeoutMs: 2000, staleMs: 50 });
  assert.equal(JSON.parse(await readFile(target, "utf8")).emptyRecovered, true);

  await writeFile(lockPath, "{bad json");
  await utimes(lockPath, old, old);
  await __testing.withFileLock(target, async () => {
    await writeFile(target, JSON.stringify({ corruptRecovered: true }));
  }, { timeoutMs: 2000, staleMs: 50 });
  assert.equal(JSON.parse(await readFile(target, "utf8")).corruptRecovered, true);

  const holderScript = path.join(bridgeHome, "hold-lock.mjs");
  const readyPath = path.join(bridgeHome, "holder-ready");
  await writeFile(
    holderScript,
    [
      "import { writeFile } from 'node:fs/promises';",
      "import { __testing } from " + JSON.stringify(coreUrl) + ";",
      `await __testing.withFileLock(${JSON.stringify(target)}, async () => {`,
      `  await writeFile(${JSON.stringify(readyPath)}, 'ready');`,
      "  await new Promise((resolve) => setTimeout(resolve, 2000));",
      "});",
    ].join("\n"),
  );
  const holder = spawn(process.execPath, [holderScript], { cwd: repoRoot, env: { ...process.env, AI_BRIDGE_HOME: bridgeHome }, windowsHide: true });
  t.after(() => holder.kill());
  for (let i = 0; i < 50 && !await readFile(readyPath, "utf8").then(() => true, () => false); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await assert.rejects(
    __testing.withFileLock(target, async () => {}, { timeoutMs: 250, staleMs: 50 }),
    /Timed out waiting/,
  );
});

test("stale lock holder cannot write after its fence is lost", async (t) => {
  const bridgeHome = await withBridgeHome(t);
  const target = path.join(bridgeHome, "fenced.json");
  await writeFile(target, JSON.stringify({ value: 0, fenceEpoch: 0 }));
  const staleWrite = await __testing.withFileLock(target, async (lease) => {
    await rm(`${target}.lock`, { force: true });
    await __testing.withFileLock(target, async () => {
      await writeFile(target, JSON.stringify({ value: 1, fenceEpoch: 1 }));
    }, { timeoutMs: 2000, staleMs: 50 });
    await assert.rejects(
      __testing.writeJsonWithFenceForTest(target, { value: 2, fenceEpoch: lease.fenceEpoch }, lease),
      /fence/i,
    );
    return "rejected";
  }, { timeoutMs: 2000, staleMs: 50 });
  assert.equal(staleWrite, "rejected");
  assert.equal(JSON.parse(await readFile(target, "utf8")).value, 1);
});

test("start reservation recovers crash after run reservation before task creation", async (t) => {
  const { bridgeHome, run, env } = await createRun(t);
  await assert.rejects(
    startClaudeIteration({ runId: run.runId, prompt: "fault", iteration: 1, timeoutSec: 5, env: { ...env, AI_BRIDGE_TEST_FAULT: "after_run_reservation" } }),
    /injected fault/i,
  );
  let runJson = await readRunJson(run);
  assert.equal(runJson.activeTaskId !== null, true);
  assert.equal(runJson.startReservation.phase, "reserved");

  const recovery = await recoverRunningTasks();
  runJson = await readRunJson(run);
  assert.equal(runJson.status, "ready", JSON.stringify(recovery));
  assert.equal(runJson.activeTaskId, null);
  assert.equal(runJson.startReservation.phase, "rolled_back");
});

test("start reservation recovers task created before worker spawn", async (t) => {
  const { bridgeHome, run, env } = await createRun(t);
  await assert.rejects(
    startClaudeIteration({ runId: run.runId, prompt: "fault", iteration: 1, timeoutSec: 5, env: { ...env, AI_BRIDGE_TEST_FAULT: "after_task_created" } }),
    /injected fault/i,
  );
  let runJson = await readRunJson(run);
  assert.equal(runJson.startReservation.phase, "task_created");
  const task = await readTaskJson(bridgeHome, runJson.activeTaskId);
  assert.equal(task.workerPid, null);

  await recoverRunningTasks();
  runJson = await readRunJson(run);
  const recoveredTask = await readTaskJson(bridgeHome, task.taskId);
  const finalLog = JSON.parse(await readFile(recoveredTask.finalLogPath, "utf8"));
  assert.equal(recoveredTask.status, "failed");
  assert.equal(recoveredTask.finalizationPhase, "complete");
  assert.equal(runJson.activeTaskId, null);
  assert.equal(finalLog.status, "failed");
});

test("start reservation recovers logs created before task creation", async (t) => {
  const { run, env } = await createRun(t);
  await assert.rejects(
    startClaudeIteration({ runId: run.runId, prompt: "fault", iteration: 1, timeoutSec: 5, env: { ...env, AI_BRIDGE_TEST_FAULT: "after_logs_created" } }),
    /injected fault/i,
  );
  let runJson = await readRunJson(run);
  assert.equal(runJson.startReservation.phase, "reserved");
  assert.equal(runJson.activeTaskId !== null, true);

  await recoverRunningTasks();
  runJson = await readRunJson(run);
  assert.equal(runJson.status, "ready");
  assert.equal(runJson.activeTaskId, null);
  assert.equal(runJson.startReservation.phase, "rolled_back");
});

test("independent processes mutate the same run and task without lost revisions", async (t) => {
  const { bridgeHome, run } = await createRun(t);
  const task = await writeSyntheticTask(bridgeHome, run, {
    taskId: "task-20990102000004-mut111",
    iteration: 1,
    status: "starting",
    terminalStatus: undefined,
    finalizationPhase: undefined,
    finishedAt: null,
  });
  const mutator = path.join(bridgeHome, "mutate.mjs");
  await writeFile(
    mutator,
    [
      "import { __testing } from " + JSON.stringify(coreUrl) + ";",
      "const [kind, id, marker] = process.argv.slice(2);",
      "if (kind === 'run') await __testing.mutateRunForTest(id, marker);",
      "else await __testing.mutateTaskForTest(id, marker);",
    ].join("\n"),
  );
  const env = { ...process.env, AI_BRIDGE_HOME: bridgeHome };
  const spawnMutator = (kind, id, marker) => spawn(process.execPath, [mutator, kind, id, marker], { cwd: repoRoot, env, windowsHide: true });
  const procs = [
    spawnMutator("run", run.runId, "run-a"),
    spawnMutator("run", run.runId, "run-b"),
    spawnMutator("task", task.taskId, "task-a"),
    spawnMutator("task", task.taskId, "task-b"),
  ];
  const exits = await Promise.all(procs.map((proc) => new Promise((resolve) => proc.on("close", resolve))));
  assert.deepEqual(exits, [0, 0, 0, 0]);
  const runJson = await readRunJson(run);
  const taskJson = await readTaskJson(bridgeHome, task.taskId);
  assert.deepEqual(runJson.testMarkers.sort(), ["run-a", "run-b"]);
  assert.deepEqual(taskJson.testMarkers.sort(), ["task-a", "task-b"]);
  assert.ok(runJson.revision >= 2);
  assert.ok(taskJson.revision >= 2);
});

test("worker async spawn failure and stdin EPIPE finalize without stale active task", async (t) => {
  const { bridgeHome, run, env } = await createRun(t);
  const started = await startClaudeIteration({
    runId: run.runId,
    prompt: "fault",
    iteration: 1,
    timeoutSec: 5,
    env: { ...env, AI_BRIDGE_TEST_FAULT: "worker_async_error" },
  });
  const polled = await waitForStatus(started.taskId, "failed", 80, 100);
  const task = await readTaskJson(bridgeHome, started.taskId);
  const runJson = await readRunJson(run);
  const finalLog = JSON.parse(await readFile(task.finalLogPath, "utf8"));
  assert.equal(polled.status, "failed");
  assert.equal(task.finalizationPhase, "complete");
  assert.equal(runJson.activeTaskId, null);
  assert.equal(finalLog.status, "failed");

  const run2 = await preflight({ workspacePath: run.workspacePath, task: "stdin fault", env });
  const started2 = await startClaudeIteration({
    runId: run2.runId,
    prompt: "fault",
    iteration: 1,
    timeoutSec: 5,
    env: { ...env, AI_BRIDGE_TEST_FAULT: "worker_stdin_epipe" },
  });
  const polled2 = await waitForStatus(started2.taskId, "failed", 80, 100);
  const task2 = await readTaskJson(bridgeHome, started2.taskId);
  const finalLog2 = JSON.parse(await readFile(task2.finalLogPath, "utf8"));
  assert.equal(polled2.status, "failed");
  assert.match(task2.stderr, /stdin/i);
  assert.equal(finalLog2.status, "failed");

  const run3 = await preflight({ workspacePath: run.workspacePath, task: "early worker exit", env });
  const started3 = await startClaudeIteration({
    runId: run3.runId,
    prompt: "fault",
    iteration: 1,
    timeoutSec: 5,
    env: { ...env, AI_BRIDGE_TEST_FAULT: "worker_exit_before_ready" },
  });
  const polled3 = await waitForStatus(started3.taskId, "failed", 80, 100);
  const task3 = await readTaskJson(bridgeHome, started3.taskId);
  const finalLog3 = JSON.parse(await readFile(task3.finalLogPath, "utf8"));
  assert.equal(polled3.status, "failed");
  assert.equal(task3.finalizationPhase, "complete");
  assert.equal(finalLog3.status, "failed");

  const run4 = await preflight({ workspacePath: run.workspacePath, task: "claude spawn error", env });
  const started4 = await startClaudeIteration({
    runId: run4.runId,
    prompt: "fault",
    iteration: 1,
    timeoutSec: 5,
    env: { ...env, AI_BRIDGE_TEST_FAULT: "claude_spawn_error" },
  });
  const polled4 = await waitForStatus(started4.taskId, "failed", 80, 100);
  const task4 = await readTaskJson(bridgeHome, started4.taskId);
  const finalLog4 = JSON.parse(await readFile(task4.finalLogPath, "utf8"));
  assert.equal(polled4.status, "failed");
  assert.equal(task4.finalizationPhase, "complete");
  assert.equal(finalLog4.status, "failed");
  assert.match(task4.stderr, /missing-claude-executable|ENOENT|spawn/i);
});

test("old terminal task finalization cannot overwrite a newer active task", async (t) => {
  const { bridgeHome, run } = await createRun(t);
  const oldTask = await writeSyntheticTask(bridgeHome, run, {
    taskId: "task-20990102000000-old111",
    iteration: 1,
    status: "completed",
    finalizationPhase: "task_terminal_written",
  });
  const newTask = await writeSyntheticTask(bridgeHome, run, {
    taskId: "task-20990102000001-new111",
    iteration: 2,
    status: "starting",
    terminalStatus: undefined,
    finalizationPhase: undefined,
    finishedAt: null,
  });
  await setRunActive(run, newTask.taskId, 2);

  await recoverRunningTasks();
  const runJson = await readRunJson(run);
  const recoveredOld = await readTaskJson(bridgeHome, oldTask.taskId);
  const finalLog = JSON.parse(await readFile(oldTask.finalLogPath, "utf8"));
  assert.equal(recoveredOld.finalizationPhase, "complete");
  assert.equal(finalLog.status, "completed");
  assert.equal(runJson.status, "running");
  assert.equal(runJson.activeTaskId, newTask.taskId);
  assert.equal(runJson.lastTaskId ?? null, null);
});

test("terminal recovery rebuilds corrupt or conflicting final logs from task state", async (t) => {
  const { bridgeHome, run, env } = await createRun(t);
  const task = await writeSyntheticTask(bridgeHome, run, {
    taskId: "task-20990102000002-log111",
    iteration: 1,
    status: "completed",
    terminalStatus: "completed",
    terminalTransitionId: "transition-log111",
    finalizationPhase: "final_log_written",
  });
  await setRunActive(run, task.taskId);
  await writeFile(task.finalLogPath, JSON.stringify({ taskId: task.taskId, runId: run.runId, iteration: 1, status: "failed", terminalTransitionId: "wrong" }));

  await recoverRunningTasks();
  const recovered = await readTaskJson(bridgeHome, task.taskId);
  const finalLog = JSON.parse(await readFile(task.finalLogPath, "utf8"));
  const runJson = await readRunJson(run);
  assert.equal(recovered.finalizationPhase, "complete");
  assert.equal(finalLog.status, "completed");
  assert.equal(finalLog.terminalStatus, "completed");
  assert.equal(finalLog.terminalTransitionId, "transition-log111");
  assert.equal(runJson.status, "awaiting_review");

  const run2 = await preflight({ workspacePath: run.workspacePath, task: "corrupt final log", env });
  const task2 = await writeSyntheticTask(bridgeHome, run2, {
    taskId: "task-20990102000005-badlog",
    iteration: 1,
    status: "completed",
    terminalStatus: "completed",
    terminalTransitionId: "transition-badlog",
    finalizationPhase: "final_log_written",
  });
  await setRunActive(run2, task2.taskId);
  await writeFile(task2.finalLogPath, "{bad json");
  await recoverRunningTasks();
  const recovered2 = await readTaskJson(bridgeHome, task2.taskId);
  const finalLog2 = JSON.parse(await readFile(task2.finalLogPath, "utf8"));
  assert.equal(recovered2.finalizationPhase, "complete");
  assert.equal(finalLog2.status, "completed");
  assert.equal(finalLog2.taskId, task2.taskId);
  assert.equal(finalLog2.terminalTransitionId, "transition-badlog");
});

test("cancel races with timeout and natural close keep one terminal status", async (t) => {
  const slow = await createRun(t, { mode: "slow" });
  const started = await startClaudeIteration({ runId: slow.run.runId, prompt: "slow", iteration: 1, timeoutSec: 1, env: slow.env });
  const cancelPromise = new Promise((resolve) => setTimeout(resolve, 900)).then(() => cancelClaudeIteration({ taskId: started.taskId }));
  const terminal = await waitForStatus(started.taskId, "cancelled", 80, 100);
  await cancelPromise.catch(() => null);
  const task = await readTaskJson(slow.bridgeHome, started.taskId);
  const finalLog = JSON.parse(await readFile(task.finalLogPath, "utf8"));
  assert.ok(["cancelled", "timed_out", "cancel_failed", "failed"].includes(task.status));
  assert.equal(finalLog.status, task.terminalStatus ?? task.status);
  assert.equal(task.finalizationPhase, "complete");
  assert.ok(task.revision >= 1);
  assert.ok(terminal.status);

  const fast = await createRun(t, { mode: "complete", delayMs: 10 });
  const fastStarted = await startClaudeIteration({ runId: fast.run.runId, prompt: "fast", iteration: 1, timeoutSec: 5, env: fast.env });
  await Promise.allSettled([
    cancelClaudeIteration({ taskId: fastStarted.taskId }),
    waitForStatus(fastStarted.taskId, "completed", 80, 50),
  ]);
  const fastTask = await readTaskJson(fast.bridgeHome, fastStarted.taskId);
  const fastFinalLog = JSON.parse(await readFile(fastTask.finalLogPath, "utf8"));
  assert.ok(["completed", "cancelled", "cancel_failed", "failed"].includes(fastTask.status));
  assert.equal(fastFinalLog.status, fastTask.terminalStatus ?? fastTask.status);
  assert.equal(fastTask.finalizationPhase, "complete");
});

test("unverifiable orphan identity does not kill an unknown live process", async (t) => {
  const { bridgeHome, run } = await createRun(t);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true });
  t.after(() => {
    if (child.pid) child.kill();
  });
  const task = await writeSyntheticTask(bridgeHome, run, {
    taskId: "task-20990102000006-live11",
    iteration: 1,
    status: "running",
    terminalStatus: undefined,
    finalizationPhase: undefined,
    finishedAt: null,
    pid: child.pid,
    processIdentity: null,
    processExecutable: null,
    processStartTime: null,
    workerPid: 99999999,
    startedAt: new Date(Date.now() - 5000).toISOString(),
  });
  await setRunActive(run, task.taskId);
  const polled = await pollClaudeIteration({ taskId: task.taskId, cursor: 0 });
  const runJson = await readRunJson(run);
  assert.equal(polled.status, "orphaned_unverifiable");
  assert.equal(runJson.activeTaskId, task.taskId);
  assert.equal(await __testing.processExists(child.pid), true);
});

test("concurrent recovery, cancel/timeout races, and rapid exits leave stable state and no locks", async (t) => {
  const { bridgeHome, run } = await createRun(t);
  const task = await writeSyntheticTask(bridgeHome, run, {
    taskId: "task-20990102000003-race11",
    iteration: 1,
    status: "completed",
    finalizationPhase: "task_terminal_written",
  });
  await setRunActive(run, task.taskId);
  const recoveryScript = path.join(bridgeHome, "recover.mjs");
  await writeFile(recoveryScript, `import { recoverRunningTasks } from ${JSON.stringify(coreUrl)};\nawait recoverRunningTasks();\n`);
  const env = { ...process.env, AI_BRIDGE_HOME: bridgeHome };
  const a = spawn(process.execPath, [recoveryScript], { cwd: repoRoot, env, windowsHide: true });
  const b = spawn(process.execPath, [recoveryScript], { cwd: repoRoot, env, windowsHide: true });
  assert.deepEqual(await Promise.all([new Promise((resolve) => a.on("close", resolve)), new Promise((resolve) => b.on("close", resolve))]), [0, 0]);
  const recovered = await readTaskJson(bridgeHome, task.taskId);
  const finalLog = JSON.parse(await readFile(task.finalLogPath, "utf8"));
  assert.equal(recovered.finalizationPhase, "complete");
  assert.equal(finalLog.status, "completed");

  const rapid = await createRun(t, { mode: "complete" });
  for (let i = 0; i < 100; i += 1) {
    const started = await startClaudeIteration({ runId: rapid.run.runId, prompt: `rapid ${i}`, iteration: 1, timeoutSec: 5, env: rapid.env });
    const done = await waitForStatus(started.taskId, "completed", 80, 50);
    assert.equal(done.status, "completed");
    let runJson = await readRunJson(rapid.run);
    for (let attempt = 0; attempt < 40 && runJson.activeTaskId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      runJson = await readRunJson(rapid.run);
    }
    assert.equal(runJson.activeTaskId, null);
    assert.equal(runJson.startReservation.phase, "complete");
    if (i < 99) {
      await __testing.resetRunForRapidStart(rapid.run.runId);
      await rm(path.join(rapid.run.runDir, "iteration-1.json"), { force: true });
    }
  }
  const lockFiles = await listLockFiles(bridgeHome);
  assert.deepEqual(lockFiles, []);
});
