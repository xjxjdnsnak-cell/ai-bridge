import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { summarizeFailurePatterns } from "../mcp/core.mjs";
import { registerTempCleanup } from "./temp-cleanup.mjs";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonl(filePath, values) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
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
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-pattern-home-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-bridge-pattern-workspace-"));
  registerTempCleanup(t, { bridgeHomes: [bridgeHome], paths: [workspace] });
  const previous = process.env.AI_BRIDGE_HOME;
  process.env.AI_BRIDGE_HOME = bridgeHome;
  t.after(() => {
    if (previous === undefined) delete process.env.AI_BRIDGE_HOME;
    else process.env.AI_BRIDGE_HOME = previous;
  });

  const fixtures = [
    {
      runId: "run-20260629120000-limitx",
      taskId: "task-20260629120000-limitx",
      runStatus: "passed",
      taskStatus: "completed",
      updatedAt: "2026-06-29T12:00:00.000Z",
      reviews: [{
        iteration: 1,
        outcome: "pass",
        findings: [
          "Partial pass: in-flight disconnect completedAt was not compared with Claude completedAt.",
          "Running-state polling and live replay remain unverified; this does not prove automatic reconnect.",
        ],
        recordedAt: "2026-06-29T12:00:00.000Z",
      }],
      verification: [{
        command: "npm test",
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "authorization: Bearer abcdefghijklmnopqrstuvwxyz password=hunter2-secret-value",
        startedAt: "2026-06-29T11:58:00.000Z",
        finishedAt: "2026-06-29T11:59:00.000Z",
      }],
      snapshot: {
        baselineInvalidated: true,
        changedFiles: [
          { status: "M", path: "CONTEXT_HANDOFF.md" },
          { status: "??", path: "hatch-pet-runs/silver-armor-girl/final/validation.json" },
          { status: "??", path: "hatch-pet-runs/silver-armor-girl/qa/review.json" },
          { status: "??", path: "hatch-pet-runs/silver-armor-girl/qa/contact-sheet.png" },
          { status: "M", path: "docs/validation/v0.4.5-in-flight-disconnect-dogfood.md" },
        ],
        preExistingUntrackedFiles: [
          "hatch-pet-runs/silver-armor-girl/final/validation.json",
          "hatch-pet-runs/silver-armor-girl/qa/review.json",
          "hatch-pet-runs/silver-armor-girl/qa/contact-sheet.png",
        ],
        modifiedPreExistingChanges: [{ status: "M", path: "CONTEXT_HANDOFF.md" }],
      },
    },
    {
      runId: "run-20260628120000-timeox",
      taskId: "task-20260628120000-timeox",
      runStatus: "timed_out",
      taskStatus: "timed_out",
      updatedAt: "2026-06-28T12:00:00.000Z",
      verification: [{
        command: "npm test",
        exitCode: null,
        timedOut: true,
        stdout: "",
        stderr: "token=another-secret-token",
        startedAt: "2026-06-28T11:58:00.000Z",
        finishedAt: "2026-06-28T11:59:00.000Z",
      }],
      snapshot: {
        changedFiles: [
          { status: "M", path: "CONTEXT_HANDOFF.md" },
          { status: "M", path: "docs/validation/v0.4.5-in-flight-disconnect-dogfood.md" },
        ],
        modifiedPreExistingChanges: [{ status: "M", path: "CONTEXT_HANDOFF.md" }],
      },
    },
    {
      runId: "run-20260627120000-cancel",
      taskId: "task-20260627120000-cancel",
      runStatus: "cancelled",
      taskStatus: "cancelled",
      updatedAt: "2026-06-27T12:00:00.000Z",
      reviews: [{
        iteration: 1,
        outcome: "pass",
        findings: ["Weak pass: completed-task recovery worked, but in-flight disconnect was not passed."],
        recordedAt: "2026-06-27T12:00:00.000Z",
      }],
      snapshot: { changedFiles: [{ status: "M", path: "CONTEXT_HANDOFF.md" }] },
    },
    {
      runId: "run-20260627110000-failed",
      taskId: "task-20260627110000-failed",
      runStatus: "failed",
      taskStatus: "failed",
      updatedAt: "2026-06-27T11:00:00.000Z",
      snapshot: { changedFiles: [] },
    },
    {
      runId: "run-20260627100000-blockd",
      taskId: "task-20260627100000-blockd",
      runStatus: "blocked",
      taskStatus: "blocked",
      updatedAt: "2026-06-27T10:00:00.000Z",
      snapshot: { changedFiles: [] },
    },
    {
      runId: "run-20260626120000-passxx",
      taskId: "task-20260626120000-passxx",
      runStatus: "passed",
      taskStatus: "completed",
      updatedAt: "2026-06-26T12:00:00.000Z",
      reviews: [{
        iteration: 1,
        outcome: "pass",
        findings: ["All required checks passed."],
        recordedAt: "2026-06-26T12:00:00.000Z",
      }],
      verification: [{
        command: "git diff --check",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "warning: LF will be replaced by CRLF",
        startedAt: "2026-06-26T11:58:00.000Z",
        finishedAt: "2026-06-26T11:59:00.000Z",
      }],
      snapshot: { changedFiles: [] },
    },
  ];

  for (const fixture of fixtures) {
    const runDir = path.join(bridgeHome, "runs", fixture.runId);
    await writeJson(path.join(runDir, "run.json"), {
      runId: fixture.runId,
      version: "0.5.1",
      status: fixture.runStatus,
      workspacePath: workspace,
      task: "Failure pattern fixture",
      maxIterations: 3,
      lastTaskId: fixture.taskId,
      createdAt: fixture.updatedAt,
      updatedAt: fixture.updatedAt,
    });
    await writeJson(path.join(bridgeHome, "tasks", `${fixture.taskId}.json`), {
      taskId: fixture.taskId,
      runId: fixture.runId,
      iteration: 1,
      status: fixture.taskStatus,
      terminalStatus: fixture.taskStatus,
      stderr: fixture.taskStatus === "completed" ? "" : `${fixture.taskStatus} task`,
      completedAt: fixture.updatedAt,
    });
    if (fixture.reviews) await writeJsonl(path.join(runDir, "reviews.jsonl"), fixture.reviews);
    if (fixture.verification) await writeJsonl(path.join(runDir, "verification.jsonl"), fixture.verification);
    await writeJson(path.join(runDir, "snapshot.json"), fixture.snapshot);
  }

  const corruptRunId = "run-20260625120000-corupt";
  await mkdir(path.join(bridgeHome, "runs", corruptRunId), { recursive: true });
  await writeFile(path.join(bridgeHome, "runs", corruptRunId, "run.json"), "{broken");
  await writeFile(path.join(bridgeHome, "tasks", "task-20260625120000-corupt.json"), "{broken");

  await writeFile(path.join(workspace, "source.mjs"), "workspace content must not be read or changed\n");
  return { bridgeHome, workspace };
}

test("summarizeFailurePatterns aggregates verification and terminal task failures", async (t) => {
  const { workspace } = await setup(t);
  const result = await summarizeFailurePatterns({ workspacePath: workspace });
  const verification = result.patterns.find((item) => item.type === "verification_failure" && item.command === "npm test");
  assert.equal(verification.severity, "high");
  assert.equal(verification.confidence, "high");
  assert.equal(verification.failureCount, 2);
  assert.equal(verification.evidenceRuns.length, 2);
  assert.equal(verification.summary.includes("hunter2"), false);
  assert.equal(verification.summary.length <= 500, true);
  assert.equal(result.patterns.some((item) => item.type === "verification_failure" && item.command === "git diff --check"), false);

  const taskTypes = result.patterns.filter((item) => item.type === "failed_or_cancelled_task").map((item) => item.taskStatus);
  assert.deepEqual(taskTypes.sort(), ["blocked", "cancelled", "failed", "timed_out"]);
  assert.equal(result.patterns.find((item) => item.taskStatus === "cancelled").retryable, false);
  assert.equal(result.patterns.find((item) => item.taskStatus === "blocked").retryable, false);
});

test("summarizeFailurePatterns distinguishes pass limitations and validation overclaims", async (t) => {
  const { workspace } = await setup(t);
  const result = await summarizeFailurePatterns({ workspacePath: workspace });
  const limitation = result.patterns.find((item) => item.patternId === "review_limitation:in_flight_disconnect");
  assert.equal(limitation.reviewOutcome, "pass");
  assert.equal(limitation.severity, "medium");
  assert.match(limitation.suggestedReviewCheck, /persisted pass/i);
  assert.equal(limitation.evidenceRuns.length, 2);

  const overclaim = result.patterns.find((item) => item.type === "validation_overclaim_risk");
  assert.match(overclaim.suggestedReviewCheck, /timestamp/i);
  assert.match(overclaim.summary, /completed-task recovery/i);
  assert.match(overclaim.summary, /running-state polling/i);
  assert.match(overclaim.summary, /live replay/i);
  assert.equal(result.patterns.some((item) => item.summary === "All required checks passed."), false);
});

test("summarizeFailurePatterns aggregates changed-file and preflight baseline risks", async (t) => {
  const { workspace } = await setup(t);
  const result = await summarizeFailurePatterns({ workspacePath: workspace });
  const handoff = result.topChangedFileRisks.find((item) => item.path === "CONTEXT_HANDOFF.md");
  assert.equal(handoff.count, 3);
  assert.deepEqual(handoff.changeOrigins, ["modified_pre_existing", "unknown"]);
  assert.match(handoff.riskReason, /follow-up documentation/i);

  const validationDoc = result.topChangedFileRisks.find((item) => item.path.includes("docs/validation/"));
  assert.match(validationDoc.riskReason, /validation evidence/i);
  assert.doesNotMatch(validationDoc.riskReason, /source-code bug/i);

  const hatch = result.patterns.find((item) => item.patternId === "preflight_baseline_risk:pre_existing_untracked");
  assert.equal(hatch.severity, "medium");
  assert.match(hatch.summary, /baseline noise/i);
  assert.equal(hatch.evidenceRuns[0].snippet.includes("workspace content"), false);

  const invalidated = result.patterns.find((item) => item.patternId === "preflight_baseline_risk:baseline_invalidated");
  assert.equal(invalidated.severity, "high");
  assert.equal(result.topChangedFileRisks.filter((item) => item.path.startsWith("hatch-pet-runs/")).length, 1);
  assert.equal(result.patterns.some((item) => item.type === "validation_overclaim_risk"), true);
});

test("summarizeFailurePatterns enforces include flags, time window, limit, ranking, and boundaries", async (t) => {
  const { workspace } = await setup(t);
  const result = await summarizeFailurePatterns({
    workspacePath: workspace,
    since: "2026-06-28T00:00:00.000Z",
    until: "2026-06-30T00:00:00.000Z",
    limit: 1,
    includePassedLimitations: false,
    includeVerificationFailures: true,
    includeReviewLimitations: false,
    includeChangedFileRisks: false,
    includePreflightRisks: false,
  });
  assert.equal(result.patterns.length, 1);
  assert.equal(result.patterns[0].type, "verification_failure");
  assert.deepEqual(result.topChangedFileRisks, []);
  assert.deepEqual(result.preflightReminders.length > 0, true);
  assert.equal(result.historical_only, true);
  assert.equal(result.current_workspace_state_not_checked, true);
  assert.deepEqual(result.window, {
    since: "2026-06-28T00:00:00.000Z",
    until: "2026-06-30T00:00:00.000Z",
  });
});

test("summarizeFailurePatterns is read-only, redacted, and corruption tolerant", async (t) => {
  const { bridgeHome, workspace } = await setup(t);
  const beforeHistory = await hashTree(bridgeHome);
  const beforeWorkspace = await hashTree(workspace);
  const result = await summarizeFailurePatterns({ workspacePath: workspace, limit: 1000 });
  assert.deepEqual(await hashTree(bridgeHome), beforeHistory);
  assert.deepEqual(await hashTree(workspace), beforeWorkspace);
  assert.equal(result.patterns.length <= 100, true);
  assert.equal(result.diagnostics.some((item) => item.code === "run_state_corrupt"), true);
  assert.equal(result.diagnostics.some((item) => item.code === "task_state_corrupt"), true);
  assert.equal(JSON.stringify(result).includes("another-secret-token"), false);
  assert.equal(JSON.stringify(result).includes("hunter2-secret-value"), false);
});
