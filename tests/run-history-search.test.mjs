import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  redactSecrets,
  searchChangedFiles,
  searchErrors,
  searchReviews,
  searchRuns,
  searchVerification,
} from "../mcp/core.mjs";
import { registerTempCleanup } from "./temp-cleanup.mjs";

function iso(day, minute = 0) {
  return `2026-06-${String(day).padStart(2, "0")}T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonl(filePath, values) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n")}\n`);
}

async function setup(t) {
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-history-home-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-bridge-history-workspace-"));
  const otherWorkspace = await mkdtemp(path.join(tmpdir(), "ai-bridge-history-other-"));
  registerTempCleanup(t, { bridgeHomes: [bridgeHome], paths: [workspace, otherWorkspace] });
  const previous = process.env.AI_BRIDGE_HOME;
  process.env.AI_BRIDGE_HOME = bridgeHome;
  t.after(() => {
    if (previous === undefined) delete process.env.AI_BRIDGE_HOME;
    else process.env.AI_BRIDGE_HOME = previous;
  });

  const fixtures = [
    {
      runId: "run-20260629090000-passxx",
      taskId: "task-20260629090000-passxx",
      status: "passed",
      taskStatus: "completed",
      task: "Document historian search behavior",
      workspacePath: workspace,
      updatedAt: iso(29, 5),
      review: {
        iteration: 1,
        outcome: "pass",
        findings: ["Historian review passed"],
        recordedAt: iso(29, 6),
      },
      verification: {
        command: "npm test",
        exitCode: 0,
        timedOut: false,
        stdout: "all tests passed",
        stderr: "",
        startedAt: iso(29, 1),
        finishedAt: iso(29, 2),
      },
      snapshot: {
        changedFiles: [{ status: "M", path: "mcp/core.mjs" }],
        stagedChanges: [],
        unstagedChanges: [{ status: "M", path: "mcp/core.mjs" }],
        untrackedFiles: [],
      },
    },
    {
      runId: "run-20260628090000-failxx",
      taskId: "task-20260628090000-failxx",
      status: "needs_fix",
      taskStatus: "failed",
      task: "Repair workspace memory failure",
      workspacePath: workspace,
      updatedAt: iso(28, 5),
      stderr: "authorization: Bearer abcdefghijklmnopqrstuvwxyz token=very-secret-token-value",
      review: {
        iteration: 1,
        outcome: "needs_fix",
        findings: ["Fix token handling before retry"],
        recordedAt: iso(28, 6),
      },
      verification: {
        command: "npm run test:integration",
        exitCode: 1,
        timedOut: false,
        stdout: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
        stderr: "password=hunter2-password-value",
        startedAt: iso(28, 1),
        finishedAt: iso(28, 2),
      },
      transcript: [
        { kind: "assistant", text: "Claude: inspecting failure" },
        { kind: "error", text: "Error: API token abcdefghijklmnopqrstuvwxyz" },
        "{broken transcript line",
      ],
      snapshot: {
        changedFiles: [{ status: "??", path: ".env" }],
        stagedChanges: [],
        unstagedChanges: [],
        untrackedFiles: [".env"],
        patch: `+ANTHROPIC_API_KEY=sk-${"x".repeat(22000)}`,
      },
    },
    {
      runId: "run-20260627090000-timexx",
      taskId: "task-20260627090000-timexx",
      status: "timed_out",
      taskStatus: "timed_out",
      task: "Old timeout",
      workspacePath: workspace,
      updatedAt: iso(27, 5),
    },
    {
      runId: "run-20260626090000-otherx",
      taskId: "task-20260626090000-otherx",
      status: "passed",
      taskStatus: "completed",
      task: "Other workspace",
      workspacePath: otherWorkspace,
      updatedAt: iso(26, 5),
    },
  ];

  for (const fixture of fixtures) {
    const runDir = path.join(bridgeHome, "runs", fixture.runId);
    const run = {
      runId: fixture.runId,
      version: "0.4.3",
      status: fixture.status,
      workspacePath: fixture.workspacePath,
      task: fixture.task,
      currentIteration: 1,
      maxIterations: 3,
      completedIterations: fixture.taskStatus === "completed" ? [1] : [],
      activeTaskId: null,
      lastTaskId: fixture.taskId,
      claudeSessionId: `session-${fixture.runId}`,
      workspaceIdentity: { repoFingerprint: `fingerprint-${fixture.runId}` },
      createdAt: fixture.updatedAt,
      updatedAt: fixture.updatedAt,
    };
    const task = {
      taskId: fixture.taskId,
      runId: fixture.runId,
      iteration: 1,
      status: fixture.taskStatus,
      terminalStatus: fixture.taskStatus,
      prompt: fixture.task,
      stderr: fixture.stderr ?? "",
      startedAt: fixture.updatedAt,
      completedAt: fixture.updatedAt,
    };
    await writeJson(path.join(runDir, "run.json"), run);
    await writeJson(path.join(bridgeHome, "tasks", `${fixture.taskId}.json`), task);
    if (fixture.review) await writeJsonl(path.join(runDir, "reviews.jsonl"), [fixture.review]);
    if (fixture.verification) await writeJsonl(path.join(runDir, "verification.jsonl"), [fixture.verification]);
    if (fixture.transcript) {
      await writeJsonl(path.join(runDir, "iteration-1.transcript.jsonl"), fixture.transcript);
    }
    if (fixture.snapshot) await writeJson(path.join(runDir, "snapshot.json"), fixture.snapshot);
  }

  const corruptRunId = "run-20260625090000-corupt";
  await mkdir(path.join(bridgeHome, "runs", corruptRunId), { recursive: true });
  await writeFile(path.join(bridgeHome, "runs", corruptRunId, "run.json"), "{broken run");
  await writeFile(path.join(bridgeHome, "tasks", "task-20260625090000-corupt.json"), "{broken task");

  return { bridgeHome, workspace, otherWorkspace, fixtures, corruptRunId };
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

test("searchRuns supports identity, text, workspace, status, time, and stable opaque pagination", async (t) => {
  const { workspace, otherWorkspace, fixtures } = await setup(t);
  const exact = await searchRuns({ query: fixtures[0].runId });
  assert.equal(exact.matches[0].runId, fixtures[0].runId);
  assert.equal(exact.matches[0].reasons.includes("exact_run_id"), true);

  const taskText = await searchRuns({ query: "workspace memory failure" });
  assert.equal(taskText.matches[0].runId, fixtures[1].runId);
  assert.equal(taskText.matches[0].snippets.some((item) => item.source === "task" && item.redacted === true), true);

  const filtered = await searchRuns({
    workspacePath: workspace,
    status: ["passed", "needs_fix"],
    since: iso(28),
    until: iso(29, 59),
  });
  assert.deepEqual(filtered.matches.map((item) => item.runId), [fixtures[0].runId, fixtures[1].runId]);
  assert.equal(filtered.matches.every((item) => item.workspacePath !== otherWorkspace), true);

  const first = await searchRuns({ workspacePath: workspace, limit: 1 });
  const second = await searchRuns({ workspacePath: workspace, limit: 1, cursor: first.nextCursor });
  assert.equal(first.hasMore, true);
  assert.notEqual(first.matches[0].runId, second.matches[0].runId);
  await assert.rejects(
    searchRuns({ workspacePath: otherWorkspace, limit: 1, cursor: first.nextCursor }),
    /cursor/i,
  );
});

test("Historian redaction covers provider keys, authorization, tokens, passwords, secrets, and private keys", () => {
  const source = [
    "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
    "ANTHROPIC_API_KEY=anthropic-secret-value",
    "DEEPSEEK_API_KEY=deepseek-secret-value",
    "authorization: Basic abcdefghijklmnopqrstuvwxyz",
    "token=token-secret-value",
    "password=password-secret-value",
    "secret=secret-value",
    "private key: private-key-value",
    "-----BEGIN PRIVATE KEY-----",
    "abcdefghijklmnopqrstuvwxyz",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const redacted = redactSecrets(source);
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz|anthropic-secret-value|deepseek-secret-value|token-secret-value|password-secret-value|secret-value|private-key-value/);
  assert.match(redacted, /REDACTED_SECRET/);
});

test("searchRuns scans transcript only when includeEvents is enabled and reports corruption", async (t) => {
  const { fixtures } = await setup(t);
  const withoutEvents = await searchRuns({ query: "inspecting failure", includeEvents: false });
  assert.equal(withoutEvents.matches.some((item) => item.runId === fixtures[1].runId), false);

  const withEvents = await searchRuns({ query: "inspecting failure", includeEvents: true });
  assert.equal(withEvents.matches[0].runId, fixtures[1].runId);
  assert.equal(withEvents.diagnostics.some((item) => item.code === "transcript_line_corrupt"), true);

  const workspaceScoped = await searchRuns({ workspacePath: fixtures[1].workspacePath, includeEvents: true });
  assert.equal(workspaceScoped.diagnostics.some((item) => item.code === "run_state_corrupt"), false);
});

test("transcript scan limits use one clear non-corruption diagnostic", async (t) => {
  const { bridgeHome, workspace, fixtures } = await setup(t);
  const runDir = path.join(bridgeHome, "runs", fixtures[0].runId);
  await writeJsonl(
    path.join(runDir, "iteration-1.transcript.jsonl"),
    Array.from({ length: 2001 }, (_, index) => ({ kind: "assistant", text: `event ${index}` })),
  );

  const result = await searchRuns({ workspacePath: workspace, includeEvents: true, limit: 100 });
  const diagnostics = result.diagnostics.filter((item) => item.runId === fixtures[0].runId);
  assert.deepEqual(diagnostics.map((item) => item.code), ["transcript_scan_truncated"]);
  assert.equal(diagnostics[0].maxEvents, 2000);
});

test("Historian isolates corrupt run and task records as diagnostics", async (t) => {
  await setup(t);
  const result = await searchRuns({ includeTerminal: true, limit: 100 });
  assert.equal(result.diagnostics.some((item) => item.code === "run_state_corrupt"), true);
  assert.equal(result.diagnostics.some((item) => item.code === "task_state_corrupt"), true);
  assert.equal(result.matches.length > 0, true);
});

test("searchErrors returns task, timeout, verification, review, transcript, and corrupt-state evidence", async (t) => {
  const { workspace, fixtures, corruptRunId } = await setup(t);
  const result = await searchErrors({ workspacePath: workspace, limit: 100 });
  const types = new Set(result.matches.map((item) => item.errorType));
  assert.equal(types.has("failed_task"), true);
  assert.equal(types.has("timed_out_task"), true);
  assert.equal(types.has("verification_failed"), true);
  assert.equal(types.has("needs_fix_review"), true);
  assert.equal(types.has("transcript_error"), true);
  assert.equal(types.has("transcript_corrupt"), true);
  assert.equal(result.diagnostics.some((item) => item.runId === corruptRunId), false);
  const failed = result.matches.find((item) => item.runId === fixtures[1].runId && item.errorType === "failed_task");
  assert.equal(failed.terminal, true);
  assert.equal(failed.retryable, true);
  assert.doesNotMatch(failed.snippet, /very-secret-token-value|abcdefghijklmnopqrstuvwxyz/);
  assert.match(failed.snippet, /REDACTED/);
});

test("searchErrors exposes pass-review limitations without classifying weak pass as a failure", async (t) => {
  const { bridgeHome, workspace, fixtures } = await setup(t);
  const v045 = fixtures[0];
  await writeJsonl(path.join(bridgeHome, "runs", v045.runId, "reviews.jsonl"), [{
    iteration: 1,
    outcome: "pass",
    findings: [
      `Unrelated earlier review detail ${"x".repeat(600)}`,
      "The harmless delay required interactive approval.",
      "v0.4.5 is a partial pass: the in-flight disconnect gate did not validate running-state polling after reconnect.",
    ],
    recordedAt: iso(29, 6),
  }]);

  const limitation = await searchErrors({ workspacePath: workspace, query: "v0.4.5", limit: 10 });
  assert.equal(limitation.matches.length, 1);
  assert.equal(limitation.matches[0].errorType, "review_limitation");
  assert.equal(limitation.matches[0].source, "review");
  assert.equal(limitation.matches[0].terminal, true);
  assert.equal(limitation.matches[0].retryable, false);
  assert.match(limitation.matches[0].snippet, /partial pass/i);

  const weakPass = await searchErrors({ workspacePath: workspace, query: "weak pass", limit: 10 });
  assert.equal(weakPass.matches.some((item) => item.errorType === "review_limitation"), false);
});

test("Historian reports expected review and verification files that are missing without failing the search", async (t) => {
  const { bridgeHome, workspace } = await setup(t);
  const runId = "run-20260624120000-missng";
  const taskId = "task-20260624120000-missng";
  await writeJson(path.join(bridgeHome, "runs", runId, "run.json"), {
    runId,
    version: "0.4.3",
    status: "passed",
    workspacePath: workspace,
    task: "Missing optional history records",
    currentIteration: 1,
    maxIterations: 3,
    completedIterations: [1],
    lastTaskId: taskId,
    verificationCommands: ["npm test"],
    reviews: [{
      iteration: 1,
      outcome: "pass",
      findings: [],
      verificationCommandsRun: ["npm test"],
      recordedAt: iso(24),
    }],
    createdAt: iso(24),
    updatedAt: iso(24),
  });
  await writeJson(path.join(bridgeHome, "tasks", `${taskId}.json`), {
    taskId,
    runId,
    iteration: 1,
    status: "completed",
  });

  const result = await searchRuns({ workspacePath: workspace, query: runId });
  assert.equal(result.matches[0].runId, runId);
  assert.equal(result.diagnostics.some((item) => item.code === "review_file_missing" && item.runId === runId), true);
  assert.equal(result.diagnostics.some((item) => item.code === "verification_file_missing" && item.runId === runId), true);
});

test("searchVerification filters saved records without executing and bounds redacted output", async (t) => {
  const { bridgeHome, workspace, fixtures } = await setup(t);
  const sentinel = path.join(bridgeHome, "verification-executed");
  const before = await hashTree(bridgeHome);
  const result = await searchVerification({
    workspacePath: workspace,
    command: "test:integration",
    exitCode: 1,
    status: "failed",
    query: "OPENAI_API_KEY",
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].runId, fixtures[1].runId);
  assert.equal(result.matches[0].durationMs, 60_000);
  assert.equal(result.matches[0].stdout.length <= 500, true);
  assert.doesNotMatch(result.matches[0].stdout, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(result.matches[0].stdout, /REDACTED/);
  const after = await hashTree(bridgeHome);
  assert.deepEqual(after, before);
  assert.rejects(readFile(sentinel), /ENOENT/);
});

test("searchChangedFiles classifies paths, hides patches by default, and bounds redacted opt-in patches", async (t) => {
  const { workspace, fixtures } = await setup(t);
  const hidden = await searchChangedFiles({ workspacePath: workspace, path: ".env" });
  assert.equal(hidden.matches.length, 1);
  assert.equal(hidden.matches[0].runId, fixtures[1].runId);
  assert.equal(hidden.matches[0].changeType, "untracked");
  assert.equal("patch" in hidden.matches[0], false);
  assert.equal(hidden.matches[0].sensitivePathWarnings[0].reason, "environment file");

  const included = await searchChangedFiles({ workspacePath: workspace, path: ".env", includePatch: true });
  assert.equal(included.matches[0].patch.length <= 20_000, true);
  assert.equal(included.matches[0].patchTruncated, true);
  assert.doesNotMatch(included.matches[0].patch, /sk-x{10}/);
  assert.match(included.matches[0].patch, /REDACTED/);

  const unavailable = await searchChangedFiles({ workspacePath: workspace, path: "mcp/core.mjs", includePatch: true });
  assert.equal(unavailable.matches[0].patch, null);
  assert.equal(unavailable.diagnostics.some((item) => item.code === "patch_unavailable"), true);
});

test("searchReviews filters outcomes and notes and returns iteration continuation state", async (t) => {
  const { workspace, fixtures } = await setup(t);
  const pass = await searchReviews({ workspacePath: workspace, outcome: "pass" });
  assert.equal(pass.matches[0].runId, fixtures[0].runId);
  assert.equal(pass.matches[0].nextIterationAllowed, false);

  const needsFix = await searchReviews({ workspacePath: workspace, outcome: "needs_fix", query: "token handling" });
  assert.equal(needsFix.matches[0].runId, fixtures[1].runId);
  assert.equal(needsFix.matches[0].iteration, 1);
  assert.equal(needsFix.matches[0].nextIterationAllowed, true);
});

test("all Historian searches preserve AI Bridge history and workspace contents", async (t) => {
  const { bridgeHome, workspace } = await setup(t);
  const workspaceFile = path.join(workspace, "source.txt");
  const fakeBin = await mkdtemp(path.join(tmpdir(), "ai-bridge-history-no-exec-"));
  registerTempCleanup(t, { paths: [fakeBin] });
  const executionSentinel = path.join(fakeBin, "external-command-ran");
  for (const command of ["claude", "git", "npm"]) {
    const executable = path.join(fakeBin, process.platform === "win32" ? `${command}.cmd` : command);
    if (process.platform === "win32") {
      await writeFile(executable, `@echo off\r\nbreak > "${executionSentinel}"\r\nexit /b 99\r\n`);
    } else {
      await writeFile(executable, `#!/bin/sh\n: > "${executionSentinel}"\nexit 99\n`);
      await chmod(executable, 0o755);
    }
  }
  await writeFile(workspaceFile, "workspace must remain unchanged\n");
  const beforeBridge = await hashTree(bridgeHome);
  const beforeWorkspace = await hashTree(workspace);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;

  try {
    await searchRuns({ workspacePath: workspace, includeEvents: true });
    await searchErrors({ workspacePath: workspace });
    await searchVerification({ workspacePath: workspace });
    await searchChangedFiles({ workspacePath: workspace, path: "mcp" });
    await searchReviews({ workspacePath: workspace });
  } finally {
    process.env.PATH = previousPath;
  }

  assert.deepEqual(await hashTree(bridgeHome), beforeBridge);
  assert.deepEqual(await hashTree(workspace), beforeWorkspace);
  await assert.rejects(readFile(executionSentinel), /ENOENT/);
});
