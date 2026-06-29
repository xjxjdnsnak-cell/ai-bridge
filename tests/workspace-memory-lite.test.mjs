import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { workspaceMemorySummary } from "../mcp/core.mjs";
import { registerTempCleanup } from "./temp-cleanup.mjs";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonl(filePath, values) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function normalizeWorkspace(filePath) {
  let normalized = path.resolve(filePath).replaceAll("\\", "/");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized.replace(/\/+$/, "");
}

async function hashTree(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else files.push(fullPath);
    }
  }
  await visit(root);
  files.sort();
  const hash = createHash("sha256");
  for (const filePath of files) {
    hash.update(path.relative(root, filePath));
    hash.update(await readFile(filePath));
  }
  return { digest: hash.digest("hex"), files: files.map((item) => path.relative(root, item)) };
}

async function setup(t) {
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-memory-home-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-bridge-memory-workspace-"));
  registerTempCleanup(t, { bridgeHomes: [bridgeHome], paths: [workspace] });
  const previous = process.env.AI_BRIDGE_HOME;
  process.env.AI_BRIDGE_HOME = bridgeHome;
  t.after(() => {
    if (previous === undefined) delete process.env.AI_BRIDGE_HOME;
    else process.env.AI_BRIDGE_HOME = previous;
  });

  const normalized = normalizeWorkspace(workspace);
  const workspaceKey = createHash("sha256").update(normalized).digest("hex");
  const runs = [
    {
      runId: "run-20260629110000-memory",
      taskId: "task-20260629110000-memory",
      status: "needs_fix",
      taskStatus: "failed",
      updatedAt: "2026-06-29T11:00:00.000Z",
      task: "Recent memory failure",
      verification: { command: "npm test", exitCode: 1, timedOut: false, stdout: "", stderr: "failure", startedAt: "2026-06-29T10:58:00.000Z", finishedAt: "2026-06-29T10:59:00.000Z" },
      review: { iteration: 1, outcome: "needs_fix", findings: ["Fix recent failure"], recordedAt: "2026-06-29T11:00:00.000Z" },
      snapshot: { changedFiles: [{ status: "M", path: "mcp/core.mjs" }], untrackedFiles: [] },
    },
    {
      runId: "run-20260628110000-passed",
      taskId: "task-20260628110000-passed",
      status: "passed",
      taskStatus: "completed",
      updatedAt: "2026-06-28T11:00:00.000Z",
      task: "Previous successful run",
      verification: { command: "npm run check", exitCode: 0, timedOut: false, stdout: "ok", stderr: "", startedAt: "2026-06-28T10:58:00.000Z", finishedAt: "2026-06-28T10:59:00.000Z" },
      review: { iteration: 1, outcome: "pass", findings: [], recordedAt: "2026-06-28T11:00:00.000Z" },
      snapshot: { changedFiles: [{ status: "A", path: "README.md" }], untrackedFiles: [] },
    },
  ];

  for (const fixture of runs) {
    const runDir = path.join(bridgeHome, "runs", fixture.runId);
    await writeJson(path.join(runDir, "run.json"), {
      runId: fixture.runId,
      version: "0.4.3",
      status: fixture.status,
      workspacePath: workspace,
      workspacePathNormalized: normalized,
      workspaceKey,
      workspaceIdentity: { repoFingerprint: "repo-fingerprint-123" },
      task: fixture.task,
      currentIteration: 1,
      maxIterations: 3,
      lastTaskId: fixture.taskId,
      claudeSessionId: `session-${fixture.runId}`,
      createdAt: fixture.updatedAt,
      updatedAt: fixture.updatedAt,
    });
    await writeJson(path.join(bridgeHome, "tasks", `${fixture.taskId}.json`), {
      taskId: fixture.taskId,
      runId: fixture.runId,
      iteration: 1,
      status: fixture.taskStatus,
      terminalStatus: fixture.taskStatus,
      stderr: fixture.taskStatus === "failed" ? "recent failure" : "",
    });
    await writeJsonl(path.join(runDir, "verification.jsonl"), [fixture.verification]);
    await writeJsonl(path.join(runDir, "reviews.jsonl"), [fixture.review]);
    await writeJson(path.join(runDir, "snapshot.json"), fixture.snapshot);
  }

  await mkdir(path.join(workspace, ".env"), { recursive: true });
  await writeFile(path.join(workspace, ".env", "secret.txt"), "must-not-be-read\n");
  await writeFile(path.join(workspace, "source.mjs"), "must-not-be-read-or-modified\n");
  return { bridgeHome, workspace, workspaceKey, normalized };
}

test("workspaceMemorySummary returns bounded recent workflow memory and stored identity", async (t) => {
  const { workspace, workspaceKey, normalized } = await setup(t);
  const result = await workspaceMemorySummary({ workspacePath: workspace, limit: 1 });
  assert.equal(result.workspacePathNormalized, normalized);
  assert.equal(result.workspaceKey, workspaceKey);
  assert.equal(result.repoFingerprint, "repo-fingerprint-123");
  assert.equal(result.recentRuns.length, 1);
  assert.equal(result.recentChangedFiles.length, 1);
  assert.equal(result.recentVerificationCommands.length, 1);
  assert.equal(result.recentFailures.length, 1);
  assert.equal(result.recentReviews.length, 1);
  assert.equal(result.suggestedContext.some((item) => /histor/i.test(item)), true);
});

test("workspaceMemorySummary include flags omit disabled collections", async (t) => {
  const { workspace } = await setup(t);
  const result = await workspaceMemorySummary({
    workspacePath: workspace,
    includeRecentRuns: false,
    includeChangedFiles: false,
    includeVerificationPatterns: false,
    includeFailurePatterns: false,
    limit: 20,
  });
  assert.deepEqual(result.recentRuns, []);
  assert.deepEqual(result.recentChangedFiles, []);
  assert.deepEqual(result.recentVerificationCommands, []);
  assert.deepEqual(result.recentFailures, []);
  assert.equal(result.recentReviews.length > 0, true);
});

test("workspaceMemorySummary tolerates corrupt history and reports missing fingerprint", async (t) => {
  const { bridgeHome } = await setup(t);
  const otherWorkspace = await mkdtemp(path.join(tmpdir(), "ai-bridge-memory-empty-"));
  registerTempCleanup(t, { paths: [otherWorkspace] });
  const corruptRunId = "run-20260627110000-corupt";
  const corruptRunDir = path.join(bridgeHome, "runs", corruptRunId);
  await writeJson(path.join(corruptRunDir, "run.json"), {
    runId: corruptRunId,
    version: "0.4.3",
    status: "ready",
    workspacePath: otherWorkspace,
    task: "Corrupt snapshot in selected workspace",
    currentIteration: 0,
    maxIterations: 3,
    createdAt: "2026-06-27T11:00:00.000Z",
    updatedAt: "2026-06-27T11:00:00.000Z",
  });
  await writeFile(path.join(corruptRunDir, "snapshot.json"), "{broken");
  const result = await workspaceMemorySummary({ workspacePath: otherWorkspace });
  assert.equal(result.repoFingerprint, null);
  assert.equal(result.diagnostics.some((item) => item.code === "repo_fingerprint_unavailable"), true);
  assert.equal(result.diagnostics.some((item) => item.code === "snapshot_state_corrupt"), true);
});

test("workspaceMemorySummary does not scan or mutate workspace or history", async (t) => {
  const { bridgeHome, workspace } = await setup(t);
  const beforeBridge = await hashTree(bridgeHome);
  const beforeWorkspace = await hashTree(workspace);
  await workspaceMemorySummary({ workspacePath: workspace, limit: 20 });
  assert.deepEqual(await hashTree(bridgeHome), beforeBridge);
  assert.deepEqual(await hashTree(workspace), beforeWorkspace);
});
