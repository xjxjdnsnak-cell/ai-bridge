import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  attachWorkspaceRun,
  discoverWorkspaceRuns,
  normalizeWorkspaceIdentity,
  pollWorkspaceRun,
  preflight,
  recordReview,
  startClaudeIteration,
} from "../mcp/core.mjs";
import { registerTempCleanup } from "./temp-cleanup.mjs";

const execFile = promisify(execFileCallback);
const coreUrl = pathToFileURL(path.resolve(import.meta.dirname, "..", "mcp", "core.mjs")).href;

async function makeRepo(t) {
  const repo = await mkdtemp(path.join(tmpdir(), "ai-bridge-workspace-repo-"));
  registerTempCleanup(t, { paths: [repo] });
  await execFile("git", ["init"], { cwd: repo });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFile("git", ["config", "user.name", "AI Bridge Workspace Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# workspace recovery\n");
  await execFile("git", ["add", "README.md"], { cwd: repo });
  await execFile("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

async function makeFakeClaude(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-bridge-workspace-bin-"));
  registerTempCleanup(t, { paths: [dir] });
  const script = path.join(dir, "fake-claude.mjs");
  await writeFile(script, [
    "if (process.argv.includes('--version')) { console.log('2.1.105 (Claude Code fake)'); process.exit(0); }",
    "if (process.argv.includes('--help')) { console.log('Usage: claude -p --session-id <id> --resume <id> -r <id>'); process.exit(0); }",
    "for await (const _chunk of process.stdin) {}",
    "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'before disconnect' }] } }));",
    "await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DELAY_MS || 0)));",
    "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'workspace recovered' }] } }));",
  ].join("\n"));
  const command = path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") await writeFile(command, `@echo off\r\nnode "${script}" %*\r\n`);
  else {
    await writeFile(command, `#!/bin/sh\nnode "${script}" "$@"\n`);
    await chmod(command, 0o755);
  }
  return dir;
}

async function setup(t) {
  const bridgeHome = await mkdtemp(path.join(tmpdir(), "ai-bridge-workspace-home-"));
  registerTempCleanup(t, { bridgeHomes: [bridgeHome] });
  const repo = await makeRepo(t);
  const fakeDir = await makeFakeClaude(t);
  const env = {
    ...process.env,
    AI_BRIDGE_HOME: bridgeHome,
    PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const previous = process.env.AI_BRIDGE_HOME;
  process.env.AI_BRIDGE_HOME = bridgeHome;
  t.after(() => {
    if (previous === undefined) delete process.env.AI_BRIDGE_HOME;
    else process.env.AI_BRIDGE_HOME = previous;
  });
  return { bridgeHome, repo, env };
}

test("workspace normalization produces one key for equivalent paths", async (t) => {
  const { repo } = await setup(t);
  const variants = [
    repo,
    `${repo}${path.sep}`,
    path.join(repo, "."),
    process.platform === "win32" ? repo.replaceAll("\\", "/").toLowerCase() : repo,
  ];
  const identities = await Promise.all(variants.map((workspacePath) => normalizeWorkspaceIdentity(workspacePath)));
  assert.equal(new Set(identities.map((item) => item.workspaceKey)).size, 1);
  assert.equal(new Set(identities.map((item) => item.normalizedPath)).size, 1);
});

test("workspace normalization resolves a symlink or Windows junction to the same key", async (t) => {
  const { repo } = await setup(t);
  const linkRoot = await mkdtemp(path.join(tmpdir(), "ai-bridge-workspace-link-"));
  registerTempCleanup(t, { paths: [linkRoot] });
  const linked = path.join(linkRoot, "repo-link");
  await symlink(repo, linked, process.platform === "win32" ? "junction" : "dir");

  const direct = await normalizeWorkspaceIdentity(repo);
  const throughLink = await normalizeWorkspaceIdentity(linked);

  assert.equal(throughLink.workspaceKey, direct.workspaceKey);
  assert.equal(throughLink.normalizedPath, direct.normalizedPath);
});

test("workspace discover and attach return the existing run without creating another", async (t) => {
  const { bridgeHome, repo, env } = await setup(t);
  const created = await preflight({ workspacePath: repo, task: "discover me", env });
  const before = await readdirRunIds(bridgeHome);

  const discovered = await discoverWorkspaceRuns({ workspacePath: `${repo}${path.sep}` });
  const attached = await attachWorkspaceRun({ workspacePath: repo });
  const after = await readdirRunIds(bridgeHome);

  assert.equal(discovered.candidates[0].runId, created.runId);
  assert.equal(discovered.candidates[0].workspaceMatch, "exact");
  assert.equal(discovered.recommendedAction, "attach");
  assert.equal(attached.attached, true);
  assert.equal(attached.runId, created.runId);
  assert.deepEqual(after, before);
});

test("workspace index corruption falls back to run scanning", async (t) => {
  const { bridgeHome, repo, env } = await setup(t);
  const created = await preflight({ workspacePath: repo, task: "index fallback", env });
  const identity = await normalizeWorkspaceIdentity(repo);
  const indexPath = path.join(bridgeHome, "workspaces", `${identity.workspaceKey}.json`);
  await writeFile(indexPath, "{broken json");

  const discovered = await discoverWorkspaceRuns({ workspacePath: repo });

  assert.equal(discovered.candidates.some((item) => item.runId === created.runId), true);
  assert.equal(discovered.diagnostics.some((item) => item.code === "workspace_index_corrupt"), true);
  assert.equal(JSON.parse(await readFile(indexPath, "utf8")).runIds.includes(created.runId), true);
});

test("moved workspace fingerprint is a candidate that requires explicit confirmation", async (t) => {
  const { repo, env } = await setup(t);
  await execFile("git", ["remote", "add", "origin", "https://example.test/shared/repo.git"], { cwd: repo });
  const created = await preflight({ workspacePath: repo, task: "moved workspace", env });
  const moved = await makeRepo(t);
  await execFile("git", ["remote", "add", "origin", "https://example.test/shared/repo.git"], { cwd: moved });

  const discovered = await discoverWorkspaceRuns({ workspacePath: moved, includeTerminal: true });
  const attached = await attachWorkspaceRun({ workspacePath: moved, runId: created.runId });
  const confirmed = await attachWorkspaceRun({
    workspacePath: moved,
    runId: created.runId,
    confirmMovedWorkspace: true,
  });

  assert.equal(discovered.candidates[0].workspaceMatch, "moved_workspace_candidate");
  assert.equal(discovered.recommendedAction, "select_run");
  assert.equal(attached.attached, false);
  assert.equal(attached.reason, "moved_workspace_confirmation_required");
  assert.equal(confirmed.attached, true);
  assert.equal(confirmed.runId, created.runId);
});

test("legacy v0.3.5 run is discovered and lazily backfilled", async (t) => {
  const { bridgeHome, repo, env } = await setup(t);
  const created = await preflight({ workspacePath: repo, task: "legacy", env });
  const runPath = path.join(created.runDir, "run.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  delete run.workspaceKey;
  delete run.workspacePathNormalized;
  delete run.workspaceIdentity;
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
  await rm(path.join(bridgeHome, "workspaces"), { recursive: true, force: true });

  const discovered = await discoverWorkspaceRuns({ workspacePath: repo });
  const updated = JSON.parse(await readFile(runPath, "utf8"));

  assert.equal(discovered.candidates[0].workspaceMatch, "legacy_path");
  assert.ok(updated.workspaceKey);
  assert.equal(updated.task, "legacy");
});

test("multiple workspace runs require explicit selection and rank running first", async (t) => {
  const { repo, env } = await setup(t);
  const first = await preflight({ workspacePath: repo, task: "first", env });
  const second = await preflight({ workspacePath: repo, task: "second", env, allowConcurrentRun: true });

  const firstPath = path.join(first.runDir, "run.json");
  const firstRun = JSON.parse(await readFile(firstPath, "utf8"));
  firstRun.status = "running";
  firstRun.activeTaskId = null;
  firstRun.updatedAt = new Date(Date.now() + 1000).toISOString();
  await writeFile(firstPath, `${JSON.stringify(firstRun, null, 2)}\n`);

  const discovered = await discoverWorkspaceRuns({ workspacePath: repo });
  const ambiguous = await attachWorkspaceRun({ workspacePath: repo });
  const selected = await attachWorkspaceRun({ workspacePath: repo, runId: second.runId });

  assert.equal(discovered.candidates.length, 2);
  assert.equal(discovered.candidates[0].runId, first.runId);
  assert.equal(discovered.recommendedAction, "select_run");
  assert.equal(ambiguous.attached, false);
  assert.equal(ambiguous.reason, "ambiguous");
  assert.equal(selected.runId, second.runId);
});

test("preflight warns, reuses, or explicitly allows an active workspace run", async (t) => {
  const { repo, env } = await setup(t);
  const first = await preflight({ workspacePath: repo, task: "active", env });
  const readyWarning = await preflight({ workspacePath: repo, task: "duplicate ready", env });
  const runPath = path.join(first.runDir, "run.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  run.status = "running";
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);

  const warned = await preflight({ workspacePath: repo, task: "duplicate", env });
  const reused = await preflight({ workspacePath: repo, task: "reuse", env, reuseExisting: true });
  const concurrent = await preflight({ workspacePath: repo, task: "concurrent", env, allowConcurrentRun: true });
  const concurrentPath = path.join(concurrent.runDir, "run.json");
  const concurrentRun = JSON.parse(await readFile(concurrentPath, "utf8"));
  concurrentRun.status = "running";
  await writeFile(concurrentPath, `${JSON.stringify(concurrentRun, null, 2)}\n`);
  const ambiguousReuse = await preflight({ workspacePath: repo, task: "ambiguous reuse", env, reuseExisting: true });

  assert.equal(warned.created, false);
  assert.equal(readyWarning.created, false);
  assert.equal(readyWarning.runId, first.runId);
  assert.match(warned.warning, /Active AI Bridge run exists/);
  assert.equal(reused.reused, true);
  assert.equal(reused.runId, first.runId);
  assert.notEqual(concurrent.runId, first.runId);
  assert.equal(ambiguousReuse.created, false);
  assert.equal(ambiguousReuse.reason, "ambiguous");
  assert.equal(ambiguousReuse.existingWorkspaceRuns.length, 2);
});

test("workspace poll resolves the task id from the selected run", async (t) => {
  const { repo, env } = await setup(t);
  const created = await preflight({ workspacePath: repo, task: "poll", env });
  const result = await pollWorkspaceRun({ workspacePath: repo, runId: created.runId, cursor: 0 });
  assert.equal(result.runId, created.runId);
  assert.equal(result.taskId, null);
  assert.equal(result.runStatus, "ready");
  assert.deepEqual(result.latestEvents, []);
});

test("new process discovers, attaches, and polls the original durable running task", async (t) => {
  const { bridgeHome, repo, env } = await setup(t);
  const resultPath = path.join(bridgeHome, "process-a.json");
  const scriptPath = path.join(bridgeHome, "process-a.mjs");
  await writeFile(scriptPath, [
    `import { preflight, startClaudeIteration } from ${JSON.stringify(coreUrl)};`,
    "import { writeFile } from 'node:fs/promises';",
    `const run = await preflight({ workspacePath: ${JSON.stringify(repo)}, task: 'cross process', env: process.env });`,
    "const task = await startClaudeIteration({ runId: run.runId, prompt: 'continue while server is gone', iteration: 1, timeoutSec: 20, env: process.env });",
    `await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ runId: run.runId, taskId: task.taskId, sessionId: task.claudeSessionId }));`,
  ].join("\n"));
  await execFile(process.execPath, [scriptPath], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...env, FAKE_DELAY_MS: "3000" },
    timeout: 30_000,
  });
  const started = JSON.parse(await readFile(resultPath, "utf8"));
  const runCountBefore = (await readdirRunIds(bridgeHome)).length;
  const processBPath = path.join(bridgeHome, "process-b.mjs");
  const processBResultPath = path.join(bridgeHome, "process-b.json");
  await writeFile(processBPath, [
    `import { discoverWorkspaceRuns, attachWorkspaceRun, pollWorkspaceRun } from ${JSON.stringify(coreUrl)};`,
    "import { writeFile } from 'node:fs/promises';",
    `const discovered = await discoverWorkspaceRuns({ workspacePath: ${JSON.stringify(repo)} });`,
    `const attached = await attachWorkspaceRun({ workspacePath: ${JSON.stringify(repo)}, runId: ${JSON.stringify(started.runId)} });`,
    `const firstPoll = await pollWorkspaceRun({ workspacePath: ${JSON.stringify(repo)}, runId: ${JSON.stringify(started.runId)}, cursor: 0 });`,
    `await writeFile(${JSON.stringify(processBResultPath)}, JSON.stringify({ discovered, attached, firstPoll }));`,
  ].join("\n"));
  await execFile(process.execPath, [processBPath], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env,
    timeout: 30_000,
  });
  const { discovered, attached, firstPoll } = JSON.parse(await readFile(processBResultPath, "utf8"));
  assert.equal(discovered.candidates[0].runId, started.runId);
  assert.equal(attached.taskId, started.taskId);
  assert.equal(firstPoll.taskId, started.taskId);
  assert.match(firstPoll.latestEvents.map((event) => event.text).join("\n"), /before disconnect/);
  assert.equal((await readdirRunIds(bridgeHome)).length, runCountBefore);

  let completed;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    completed = await pollWorkspaceRun({ workspacePath: repo, runId: started.runId, cursor: 0 });
    if (completed.taskStatus === "completed") break;
  }
  assert.equal(completed.taskStatus, "completed");
  assert.equal(completed.runStatus, "awaiting_review");
  assert.equal(completed.finalizationPhase, "complete");
  assert.match(completed.latestEvents.map((event) => event.text).join("\n"), /workspace recovered/);
  assert.ok(await readFile(completed.finalLogPath, "utf8"));
  assert.equal(completed.finalSummary.status, "completed");
  const runPath = path.join(bridgeHome, "runs", started.runId, "run.json");
  const beforeRepeat = JSON.parse(await readFile(runPath, "utf8"));
  await attachWorkspaceRun({ workspacePath: repo, runId: started.runId });
  await pollWorkspaceRun({ workspacePath: repo, runId: started.runId, cursor: completed.nextCursor });
  const afterRepeat = JSON.parse(await readFile(runPath, "utf8"));
  assert.deepEqual(afterRepeat.completedIterations, beforeRepeat.completedIterations);
  assert.deepEqual(afterRepeat.completedIterationsHistory ?? [], beforeRepeat.completedIterationsHistory ?? []);
});

test("attached needs_fix run continues with the original Claude session in resume mode", async (t) => {
  const { repo, env } = await setup(t);
  const created = await preflight({ workspacePath: repo, task: "resume context", maxIterations: 3, env });
  const first = await startClaudeIteration({
    runId: created.runId,
    prompt: "iteration one",
    iteration: 1,
    timeoutSec: 10,
    env,
  });
  let completed;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    completed = await pollWorkspaceRun({ workspacePath: repo, runId: created.runId, cursor: 0 });
    if (completed.taskStatus === "completed") break;
  }
  assert.equal(completed.taskStatus, "completed");
  await recordReview({ runId: created.runId, iteration: 1, outcome: "needs_fix", findings: [] });

  const attached = await attachWorkspaceRun({ workspacePath: repo, runId: created.runId });
  const second = await startClaudeIteration({
    runId: attached.runId,
    prompt: "iteration two",
    iteration: 2,
    timeoutSec: 10,
    env,
  });

  assert.equal(attached.claudeSessionId, created.claude.sessionId);
  assert.equal(attached.nextIteration, 2);
  assert.equal(second.claudeSessionId, created.claude.sessionId);
  assert.equal(second.sessionInvocationMode, "resume");
  assert.notEqual(second.taskId, first.taskId);
});

async function readdirRunIds(bridgeHome) {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(path.join(bridgeHome, "runs"))).sort();
}
