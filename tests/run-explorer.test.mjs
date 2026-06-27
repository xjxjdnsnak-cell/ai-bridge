import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import {
  exportRun,
  inspectRun,
  listRuns,
  normalizeWorkspaceIdentity,
  preflight,
  showRunDiff,
  showVerification,
  tailRun,
} from "../mcp/core.mjs";
import { registerTempCleanup } from "./temp-cleanup.mjs";

const execFile = promisify(execFileCallback);

async function makeFakeClaude(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-bridge-explorer-smoke-bin-"));
  registerTempCleanup(t, { paths: [dir] });
  const script = path.join(dir, "fake-claude.mjs");
  await writeFile(script, [
    "if (process.argv.includes('--version')) { console.log('2.1.105 (Claude Code fake)'); process.exit(0); }",
    "if (process.argv.includes('--help')) { console.log('Usage: claude -p --session-id <id> --resume <id>'); process.exit(0); }",
    "process.exit(2);",
  ].join("\n"));
  const command = path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") await writeFile(command, `@echo off\r\nnode "${script}" %*\r\n`);
  else {
    await writeFile(command, `#!/bin/sh\nnode "${script}" "$@"\n`);
    await chmod(command, 0o755);
  }
  return dir;
}

async function writeRunFixture(bridgeHome, baseRun, {
  suffix,
  status,
  updatedAt,
  lastTaskStatus = null,
  corruptLastTask = false,
} = {}) {
  const runId = `run-2026062700000${suffix}-${String(suffix).padEnd(6, "x").slice(0, 6)}`;
  const runDir = path.join(bridgeHome, "runs", runId);
  const taskId = lastTaskStatus || corruptLastTask
    ? `task-2026062700000${suffix}-${String(suffix).padEnd(6, "t").slice(0, 6)}`
    : null;
  const run = {
    ...baseRun,
    runId,
    runDir,
    status,
    task: `${status} task`,
    activeTaskId: status === "running" ? taskId : null,
    lastTaskId: taskId,
    claudeSessionId: `session-${suffix}`,
    updatedAt,
  };
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  if (taskId) {
    await mkdir(path.join(bridgeHome, "tasks"), { recursive: true });
    await writeFile(
      path.join(bridgeHome, "tasks", `${taskId}.json`),
      corruptLastTask ? `{"runId":"${runId}", broken` : `${JSON.stringify({ taskId, runId, iteration: 1, status: lastTaskStatus })}\n`,
    );
  }
  return { runId, taskId };
}

async function setup(t) {
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-explorer-home-"));
  const repo = await mkdtemp(path.join(tmpdir(), "ai-bridge-explorer-repo-"));
  registerTempCleanup(t, { bridgeHomes: [bridgeHome], paths: [repo] });
  await execFile("git", ["init"], { cwd: repo });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFile("git", ["config", "user.name", "AI Bridge Explorer Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# explorer\n");
  await execFile("git", ["add", "README.md"], { cwd: repo });
  await execFile("git", ["commit", "-m", "init"], { cwd: repo });

  const previous = process.env.AI_BRIDGE_HOME;
  process.env.AI_BRIDGE_HOME = bridgeHome;
  t.after(() => {
    if (previous === undefined) delete process.env.AI_BRIDGE_HOME;
    else process.env.AI_BRIDGE_HOME = previous;
  });

  const runId = "run-20260627000000-explor";
  const runDir = path.join(bridgeHome, "runs", runId);
  const [{ stdout: head }, { stdout: branch }] = await Promise.all([
    execFile("git", ["rev-parse", "HEAD"], { cwd: repo }),
    execFile("git", ["branch", "--show-current"], { cwd: repo }),
  ]);
  const timestamp = new Date().toISOString();
  const identity = await normalizeWorkspaceIdentity(repo);
  const run = {
    runId,
    version: "0.4.1",
    status: "ready",
    workspacePath: repo,
    workspaceKey: identity.workspaceKey,
    workspacePathNormalized: identity.normalizedPath,
    task: "explore durable state",
    currentIteration: 0,
    completedIterations: [],
    activeTaskId: null,
    lastTaskId: null,
    verificationCommands: [],
    gitBaseline: {
      head: head.trim(),
      branch: branch.trim(),
      statusEntries: [],
      stagedChanges: [],
      unstagedChanges: [],
      untrackedFiles: [],
      fileHashes: {},
      untrackedFileHashes: {},
      stagedBlobHashes: {},
      capturedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  const created = { runId, runDir };
  return { bridgeHome, repo, created, identity };
}

test("listRuns isolates corrupt run state and filters by workspace", async (t) => {
  const { bridgeHome, repo, created } = await setup(t);
  const corruptDir = path.join(bridgeHome, "runs", "run-corrupt");
  await mkdir(corruptDir, { recursive: true });
  await writeFile(path.join(corruptDir, "run.json"), "{broken");

  const result = await listRuns({ workspacePath: repo, includeTerminal: true });

  assert.equal(result.runs.some((run) => run.runId === created.runId), true);
  assert.equal(result.diagnostics.some((item) => item.runId === "run-corrupt"), true);
});

test("listRuns ranks workflow states and returns product-ready summaries", async (t) => {
  const { bridgeHome, repo, created } = await setup(t);
  const baseRun = JSON.parse(await readFile(path.join(created.runDir, "run.json"), "utf8"));
  const states = ["passed", "failed", "ready", "needs_fix", "awaiting_review", "running"];
  for (const [index, status] of states.entries()) {
    await writeRunFixture(bridgeHome, baseRun, {
      suffix: index + 1,
      status,
      updatedAt: new Date(Date.parse("2026-06-27T10:00:00.000Z") + index * 1000).toISOString(),
      lastTaskStatus: status === "ready" ? null : status === "running" ? "running" : "completed",
    });
  }
  const olderRunning = await writeRunFixture(bridgeHome, baseRun, {
    suffix: 8,
    status: "running",
    updatedAt: "2026-06-27T09:00:00.000Z",
    lastTaskStatus: "running",
  });

  const result = await listRuns({ workspacePath: repo, includeTerminal: true, limit: 20, maxAgeHours: 100000 });
  const ranked = result.runs.filter((run) => run.runId !== created.runId && states.includes(run.status));

  assert.deepEqual(ranked.map((run) => run.status), [
    "running",
    "running",
    "awaiting_review",
    "needs_fix",
    "ready",
    "failed",
    "passed",
  ]);
  const running = ranked[0];
  assert.notEqual(running.runId, olderRunning.runId);
  assert.equal(running.workspaceKey, baseRun.workspaceKey);
  assert.equal(running.workspacePathNormalized, baseRun.workspacePathNormalized);
  assert.equal(running.lastTaskStatus, "running");
  assert.equal(running.claudeSessionId, "session-6");
  assert.equal(running.maxIterations, 3);
  assert.equal(running.workspaceMatch, "exact");
  assert.match(running.rankReason, /running/i);
});

test("listRuns isolates a corrupt last task and remains read-only", async (t) => {
  const { bridgeHome, repo, created } = await setup(t);
  const runPath = path.join(created.runDir, "run.json");
  const baseRun = JSON.parse(await readFile(runPath, "utf8"));
  const corrupt = await writeRunFixture(bridgeHome, baseRun, {
    suffix: 7,
    status: "running",
    updatedAt: new Date().toISOString(),
    corruptLastTask: true,
  });
  const corruptRunPath = path.join(bridgeHome, "runs", corrupt.runId, "run.json");
  const taskPath = path.join(bridgeHome, "tasks", `${corrupt.taskId}.json`);
  const before = {
    run: await readFile(corruptRunPath, "utf8"),
    task: await readFile(taskPath, "utf8"),
  };

  const result = await listRuns({ workspacePath: repo, includeTerminal: true });
  const summary = result.runs.find((run) => run.runId === corrupt.runId);

  assert.equal(summary.lastTaskStatus, null);
  assert.equal(result.diagnostics.some((item) => item.code === "last_task_state_corrupt" && item.runId === corrupt.runId), true);
  assert.equal(await readFile(corruptRunPath, "utf8"), before.run);
  assert.equal(await readFile(taskPath, "utf8"), before.task);
});

test("preflight-created run is visible to Run Explorer", async (t) => {
  const { bridgeHome, repo } = await setup(t);
  const fakeDir = await makeFakeClaude(t);
  const env = { ...process.env, PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}` };
  const before = (await readdir(path.join(bridgeHome, "runs"))).length;

  const created = await preflight({ workspacePath: repo, task: "real preflight shape", env, allowConcurrentRun: true });
  const listed = await listRuns({ workspacePath: repo, includeTerminal: true });
  const inspected = await inspectRun({ runId: created.runId });
  const exported = await exportRun({ runId: created.runId, format: "json" });
  const payload = JSON.parse(await readFile(exported.outputPath, "utf8"));
  const after = (await readdir(path.join(bridgeHome, "runs"))).length;
  const summary = listed.runs.find((run) => run.runId === created.runId);

  assert.ok(summary);
  assert.equal(inspected.run.runId, created.runId);
  assert.ok(summary.workspaceKey);
  assert.ok(summary.workspacePathNormalized);
  assert.ok(summary.claudeSessionId);
  assert.equal(summary.maxIterations, 3);
  assert.ok(Array.isArray(inspected.run.verificationCommands));
  assert.equal(payload.run.runId, created.runId);
  assert.equal(after, before + 1);
  assert.equal(inspected.tasks.length, 0);
});

test("inspectRun and tailRun tolerate corrupt transcript lines", async (t) => {
  const { bridgeHome, created } = await setup(t);
  const taskId = "task-20260627000000-explor";
  const task = {
    taskId,
    runId: created.runId,
    iteration: 1,
    status: "running",
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(path.join(bridgeHome, "tasks"), { recursive: true });
  await writeFile(path.join(bridgeHome, "tasks", `${taskId}.json`), `${JSON.stringify(task)}\n`);
  const runPath = path.join(created.runDir, "run.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  run.status = "running";
  run.activeTaskId = taskId;
  run.lastTaskId = taskId;
  run.currentIteration = 1;
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(path.join(created.runDir, "transcript.jsonl"), [
    JSON.stringify({ index: 0, type: "assistant", text: "first" }),
    "{broken",
    JSON.stringify({ index: 1, type: "assistant", text: "second" }),
    "",
  ].join("\n"));
  const runBefore = await readFile(runPath, "utf8");
  const taskPath = path.join(bridgeHome, "tasks", `${taskId}.json`);
  const taskBefore = await readFile(taskPath, "utf8");

  const inspected = await inspectRun({ runId: created.runId, eventLimit: 1 });
  const tailed = await tailRun({ runId: created.runId, cursor: 1, limit: 10 });

  assert.equal(inspected.run.runId, created.runId);
  assert.equal(inspected.events.length, 1);
  assert.equal(inspected.diagnostics.some((item) => item.code === "transcript_line_corrupt"), true);
  assert.deepEqual(tailed.events.map((event) => event.text), ["second"]);
  assert.equal(tailed.nextCursor, 2);
  assert.equal(await readFile(runPath, "utf8"), runBefore);
  assert.equal(await readFile(taskPath, "utf8"), taskBefore);
});

test("showRunDiff is read-only and redacts bounded patches", async (t) => {
  const { repo, created } = await setup(t);
  await writeFile(path.join(repo, ".env"), "API_TOKEN=super-secret-value\n");
  await writeFile(path.join(repo, "private.key"), "private-key-value\n");
  await writeFile(path.join(repo, "config.secret.json"), "{}\n");
  await writeFile(path.join(repo, "token.txt"), "token-value\n");
  await writeFile(path.join(repo, "README.md"), "token=super-secret-value\n");
  const runBefore = await readFile(path.join(created.runDir, "run.json"), "utf8");
  const statusBefore = (await execFile("git", ["status", "--short"], { cwd: repo })).stdout;

  const result = await showRunDiff({ runId: created.runId, includePatch: true, maxPatchBytes: 200 });

  assert.equal(result.hasChanges, true);
  assert.equal(result.sensitivePaths.includes(".env"), true);
  assert.deepEqual(
    result.sensitivePathWarnings.map((warning) => warning.path).sort(),
    [".env", "config.secret.json", "private.key", "token.txt"],
  );
  assert.equal(result.sensitivePathWarnings.every((warning) => warning.path && warning.reason), true);
  assert.equal(result.patch.includes("super-secret-value"), false);
  assert.equal(await readFile(path.join(created.runDir, "run.json"), "utf8"), runBefore);
  assert.equal((await execFile("git", ["status", "--short"], { cwd: repo })).stdout, statusBefore);

  const emptyPatch = await showRunDiff({ runId: created.runId, includePatch: true, maxPatchBytes: 0 });
  assert.equal(emptyPatch.patch, "");
  assert.equal(emptyPatch.patchTruncated, true);
});

test("showVerification summarizes historical records without executing commands", async (t) => {
  const { created } = await setup(t);
  const verificationPath = path.join(created.runDir, "verification.jsonl");
  const runPath = path.join(created.runDir, "run.json");
  await writeFile(verificationPath, [
    JSON.stringify({
      command: "npm test",
      startedAt: "2026-06-27T00:00:00.000Z",
      finishedAt: "2026-06-27T00:00:02.000Z",
      exitCode: 0,
      timedOut: false,
      stdout: "token=secret-value",
      stderr: "",
    }),
    "",
  ].join("\n"));
  const runBefore = await readFile(runPath, "utf8");
  const verificationBefore = await readFile(verificationPath, "utf8");

  const result = await showVerification({ runId: created.runId, includeOutput: true });

  assert.equal(result.status, "passed");
  assert.equal(result.commands[0].durationMs, 2000);
  assert.equal(result.commands[0].stdout.includes("secret-value"), false);
  assert.equal(await readFile(runPath, "utf8"), runBefore);
  assert.equal(await readFile(verificationPath, "utf8"), verificationBefore);
});

test("showVerification reports partial history and inspectRun isolates a corrupt task", async (t) => {
  const { bridgeHome, created } = await setup(t);
  await mkdir(path.join(bridgeHome, "tasks"), { recursive: true });
  await writeFile(
    path.join(bridgeHome, "tasks", "task-20260627000000-broken.json"),
    `{"runId":"${created.runId}", broken`,
  );
  await writeFile(path.join(created.runDir, "verification.jsonl"), [
    JSON.stringify({
      command: "npm test",
      startedAt: "2026-06-27T00:00:00.000Z",
      finishedAt: "2026-06-27T00:00:01.000Z",
      exitCode: 0,
      timedOut: false,
    }),
    "{broken",
    "",
  ].join("\n"));

  const inspected = await inspectRun({ runId: created.runId });

  assert.equal(inspected.verification.status, "partial");
  assert.equal(inspected.diagnostics.some((item) => item.code === "task_state_corrupt"), true);
  assert.equal(inspected.diagnostics.some((item) => item.code === "verification_line_corrupt"), true);
});

test("inspectRun repairs a corrupt terminal final log from authoritative task state", async (t) => {
  const { bridgeHome, created } = await setup(t);
  const taskId = "task-20260627000000-finalx";
  const finalLogPath = path.join(created.runDir, "iteration-1.json");
  const task = {
    taskId,
    runId: created.runId,
    iteration: 1,
    status: "completed",
    terminalStatus: "completed",
    terminalTransitionId: "transition-final",
    finalizationPhase: "complete",
    revision: 1,
    startedAt: "2026-06-27T00:00:00.000Z",
    finishedAt: "2026-06-27T00:00:01.000Z",
    exitCode: 0,
    timedOut: false,
    finalLogPath,
    stderr: "",
  };
  await mkdir(path.join(bridgeHome, "tasks"), { recursive: true });
  await writeFile(path.join(bridgeHome, "tasks", `${taskId}.json`), `${JSON.stringify(task)}\n`);
  await writeFile(finalLogPath, "{broken");
  const runPath = path.join(created.runDir, "run.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  run.status = "awaiting_review";
  run.lastTaskId = taskId;
  run.currentIteration = 1;
  run.completedIterations = [1];
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);

  const inspected = await inspectRun({ runId: created.runId });
  const repaired = JSON.parse(await readFile(finalLogPath, "utf8"));

  assert.equal(inspected.diagnostics.some((item) => item.code === "final_log_repaired"), true);
  assert.equal(repaired.taskId, taskId);
  assert.equal(repaired.status, "completed");
});

test("exportRun creates redacted JSON and refuses overwrite", async (t) => {
  const { bridgeHome, created } = await setup(t);

  const result = await exportRun({ runId: created.runId, format: "json" });
  const exported = await readFile(result.outputPath, "utf8");

  assert.equal(result.outputPath.startsWith(path.join(bridgeHome, "exports")), true);
  assert.equal(JSON.parse(exported).run.runId, created.runId);
  await assert.rejects(
    exportRun({ runId: created.runId, format: "json", outputPath: result.outputPath }),
    /already exists/i,
  );

  const markdown = await exportRun({ runId: created.runId, format: "markdown" });
  assert.match(await readFile(markdown.outputPath, "utf8"), new RegExp(`# AI Bridge Run ${created.runId}`));

  await assert.rejects(
    exportRun({ runId: created.runId, outputPath: path.join(bridgeHome, "..", "escaped.json") }),
    /escaped AI Bridge storage root/i,
  );
});
