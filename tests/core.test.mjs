import { execFile as execFileCallback, spawn } from "node:child_process";
import { appendFile, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_ITERATIONS,
  __testing,
  detectVerificationCommands,
  getClaudeTranscript,
  cancelClaudeIteration,
  pollClaudeIteration,
  preparePlanHandoff,
  preflight,
  recordReview,
  recoverRunningTasks,
  runClaudeIteration,
  runVerificationCommands,
  summarizeCosts,
  snapshotChanges,
  startClaudeIteration,
} from "../mcp/core.mjs";

const execFile = promisify(execFileCallback);

async function makeGitRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "ai-bridge-repo-"));
  await execFile("git", ["init"], { cwd: repo });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFile("git", ["config", "user.name", "AI Bridge Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await execFile("git", ["add", "README.md"], { cwd: repo });
  await execFile("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

async function makeFakeBin(scriptSource) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-bridge-bin-"));
  const command = path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") {
    await writeFile(command, scriptSource);
  } else {
    const output = scriptSource.includes("sk-1234567890abcdef")
      ? '{"result":"ok","token":"sk-1234567890abcdef"}'
      : "2.1.105 (Claude Code)";
    await writeFile(command, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
    await chmod(command, 0o755);
  }
  return { dir, command };
}

function pathWithFakeBin(binDir) {
  return `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function waitForTaskStatus(taskId, status, attempts = 40, delayMs = 50) {
  let polled;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    polled = await pollClaudeIteration({ taskId, cursor: 0 });
    if (polled.status === status) return polled;
  }
  return polled;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function makeCapturingFakeClaude() {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-bridge-bin-"));
  const argsLog = path.join(dir, "args.jsonl");
  const stdinLog = path.join(dir, "stdin.jsonl");
  const script = path.join(dir, "fake-claude.mjs");
  await writeFile(
    script,
    [
      "import { appendFileSync } from 'node:fs';",
      "if (process.argv.includes('--version')) { console.log('2.1.105 (Claude Code)'); process.exit(0); }",
      "if (process.argv.includes('--help')) { console.log('Usage: claude -p --session-id <id> --resume <id> -r <id>'); process.exit(0); }",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "for await (const chunk of process.stdin) stdin += chunk;",
      `appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      `appendFileSync(${JSON.stringify(stdinLog)}, JSON.stringify(stdin) + '\\n');`,
      "console.log(JSON.stringify({ result: 'ok' }));",
    ].join("\n"),
  );
  const command = path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") {
    await writeFile(command, `@echo off\r\nnode "${script}" %*\r\n`);
  } else {
    await writeFile(command, `#!/bin/sh\nnode "${script}" "$@"\n`);
    await chmod(command, 0o755);
  }
  return { dir, argsLog, stdinLog };
}

async function makeStreamingFakeClaude({ exitCode = 0, delayMs = 25 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-bridge-stream-bin-"));
  const argsLog = path.join(dir, "args.jsonl");
  const stdinLog = path.join(dir, "stdin.jsonl");
  const script = path.join(dir, "fake-claude-stream.mjs");
  await writeFile(
    script,
    [
      "import { appendFileSync } from 'node:fs';",
      "if (process.argv.includes('--version')) { console.log('2.1.105 (Claude Code)'); process.exit(0); }",
      "if (process.argv.includes('--help')) { console.log('Usage: claude -p --session-id <id> --resume <id> -r <id>'); process.exit(0); }",
      `appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "for await (const chunk of process.stdin) stdin += chunk;",
      `appendFileSync(${JSON.stringify(stdinLog)}, JSON.stringify(stdin) + '\\n');`,
      "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
      "function emit(value) { console.log(JSON.stringify(value)); }",
      "emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden reasoning' } } });",
      `emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Starting sk-1234567890abcdef' }] } });`,
      `await sleep(${delayMs});`,
      "emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Visible wrapped text' } } });",
      `await sleep(${delayMs});`,
      "emit({ type: 'assistant', delta: { text: 'Working on files' } });",
      `await sleep(${delayMs});`,
      "emit({ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --watch=false' } });",
      `await sleep(${delayMs});`,
      "emit({ type: 'tool_result', name: 'Bash', exitCode: 0, content: 'ok' });",
      `await sleep(${delayMs});`,
      "emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Finished' }] } });",
      `process.exit(${exitCode});`,
    ].join("\n"),
  );
  const command = path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") {
    await writeFile(command, `@echo off\r\nnode "${script}" %*\r\n`);
  } else {
    await writeFile(command, `#!/bin/sh\nnode "${script}" "$@"\n`);
    await chmod(command, 0o755);
  }
  return { dir, argsLog, stdinLog };
}

test("detectVerificationCommands uses explicit commands first", async () => {
  const repo = await makeGitRepo();
  const commands = await detectVerificationCommands(repo, ["custom test"]);
  assert.deepEqual(commands, ["custom test"]);
});

test("detectVerificationCommands infers common project commands", async () => {
  const repo = await makeGitRepo();
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node --test",
        lint: "eslint .",
        build: "vite build",
      },
    }),
  );
  await writeFile(path.join(repo, "pyproject.toml"), "[project]\nname = 'x'\n");
  await writeFile(path.join(repo, "Cargo.toml"), "[package]\nname='x'\nversion='0.1.0'\n");
  await writeFile(path.join(repo, "go.mod"), "module example.com/x\n");
  await writeFile(path.join(repo, "x.csproj"), "<Project />\n");

  const commands = await detectVerificationCommands(repo);

  assert.deepEqual(commands, [
    "npm test",
    "npm run lint",
    "npm run build",
    "python -m pytest",
    "cargo test",
    "go test ./...",
    "dotnet test",
  ]);
});

test("preflight rejects non-git workspaces", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-bridge-not-git-"));

  await assert.rejects(
    () => preflight({ workspacePath: workspace, task: "change code", env: process.env }),
    /git repository/,
  );
});

test("preflight records dirty tree and creates run directory", async () => {
  const repo = await makeGitRepo();
  await writeFile(path.join(repo, "README.md"), "# changed\n");
  const fake = await makeFakeBin("@echo off\r\necho 2.1.105 (Claude Code)\r\n");

  const result = await preflight({
    workspacePath: repo,
    task: "change code",
    maxIterations: 9,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  assert.equal(result.maxIterations, 9);
  assert.equal(result.defaultMaxIterations, DEFAULT_MAX_ITERATIONS);
  assert.equal(result.claude.available, true);
  assert.match(result.claude.version, /Claude Code/);
  assert.match(result.claude.sessionId, UUID_PATTERN);
  assert.match(result.git.status, /README\.md/);
  assert.equal(result.git.dirty, true);
  assert.match(result.runId, /^run-/);
  assert.match(result.runDir, /ai-bridge[\\/]runs[\\/]run-/);
  const runJson = JSON.parse(await readFile(path.join(result.runDir, "run.json"), "utf8"));
  assert.equal(runJson.claudeSessionId, result.claude.sessionId);
});

test("runClaudeIteration reuses one Claude session id across iterations", async () => {
  const repo = await makeGitRepo();
  const fake = await makeCapturingFakeClaude();
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  const first = await runClaudeIteration({
    runId: run.runId,
    prompt: "first",
    iteration: 1,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const second = await runClaudeIteration({
    runId: run.runId,
    prompt: "second",
    iteration: 2,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  const captured = (await readFile(fake.argsLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const stdin = (await readFile(fake.stdinLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(first.claudeSessionId, run.claude.sessionId);
  assert.equal(second.claudeSessionId, run.claude.sessionId);
  assert.equal(captured[0][captured[0].indexOf("--session-id") + 1], run.claude.sessionId);
  assert.equal(captured[1][captured[1].indexOf("--resume") + 1], run.claude.sessionId);
  assert.equal(captured[0].includes("first"), false);
  assert.equal(captured[1].includes("second"), false);
  assert.equal(stdin[0], "first");
  assert.equal(stdin[1], "second");
});

test("runClaudeIteration backfills session id for legacy runs", async () => {
  const repo = await makeGitRepo();
  const fake = await makeCapturingFakeClaude();
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const runJsonPath = path.join(run.runDir, "run.json");
  const legacyRun = JSON.parse(await readFile(runJsonPath, "utf8"));
  delete legacyRun.claudeSessionId;
  await writeFile(runJsonPath, `${JSON.stringify(legacyRun, null, 2)}\n`);

  const result = await runClaudeIteration({
    runId: run.runId,
    prompt: "legacy",
    iteration: 1,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  assert.match(result.claudeSessionId, UUID_PATTERN);
  const updatedRun = JSON.parse(await readFile(runJsonPath, "utf8"));
  assert.equal(updatedRun.claudeSessionId, result.claudeSessionId);
});

test("runClaudeIteration ignores caller supplied session override arguments", async () => {
  const repo = await makeGitRepo();
  const fake = await makeCapturingFakeClaude();
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const override = "00000000-0000-4000-8000-000000000000";

  await runClaudeIteration({
    runId: run.runId,
    prompt: "implement",
    iteration: 1,
    claudeArgs: ["--session-id", override, "--continue", "--resume", override],
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  const captured = (await readFile(fake.argsLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const stdin = (await readFile(fake.stdinLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const iterationArgs = captured[0];
  assert.equal(iterationArgs.filter((arg) => arg === "--session-id").length, 1);
  assert.equal(iterationArgs[iterationArgs.indexOf("--session-id") + 1], run.claude.sessionId);
  assert.equal(iterationArgs.includes(override), false);
  assert.equal(iterationArgs.includes("--continue"), false);
  assert.equal(iterationArgs.includes("--resume"), false);
  assert.equal(iterationArgs.includes("implement"), false);
  assert.equal(stdin[0], "implement");
});

test("startClaudeIteration returns immediately and poll streams summarized events", async () => {
  const repo = await makeGitRepo();
  const fake = await makeStreamingFakeClaude({ delayMs: 100 });
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  const started = await startClaudeIteration({
    runId: run.runId,
    prompt: "implement",
    iteration: 1,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  assert.match(started.taskId, /^task-/);
  assert.equal(started.status, "running");
  assert.equal(started.claudeSessionId, run.claude.sessionId);
  assert.match(started.streamLogPath, /iteration-1\.stream\.jsonl$/);
  assert.match(started.transcriptLogPath, /iteration-1\.transcript\.jsonl$/);

  let cursor = 0;
  let status = "running";
  let combinedText = "";
  for (let attempt = 0; attempt < 20 && status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const polled = await pollClaudeIteration({ taskId: started.taskId, cursor });
    assert.ok(polled.nextCursor >= cursor);
    cursor = polled.nextCursor;
    status = polled.status;
    combinedText += polled.events.map((event) => event.text).join("\n");
  }

  assert.equal(status, "completed");
  assert.match(combinedText, /Claude: Starting \[REDACTED_SECRET\]/);
  assert.match(combinedText, /Claude: Visible wrapped text/);
  assert.match(combinedText, /Claude: Working on files/);
  assert.doesNotMatch(combinedText, /hidden reasoning/);
  assert.match(combinedText, /Tool: Bash npm test -- --watch=false/);
  assert.match(combinedText, /Tool result: Bash exit 0/);
  assert.doesNotMatch(combinedText, /sk-1234567890abcdef/);

  const captured = (await readFile(fake.argsLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const stdin = (await readFile(fake.stdinLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const iterationArgs = captured[0];
  assert.equal(iterationArgs.includes("--output-format"), true);
  assert.equal(iterationArgs[iterationArgs.indexOf("--output-format") + 1], "stream-json");
  assert.equal(iterationArgs.includes("--verbose"), true);
  assert.equal(iterationArgs.includes("--include-partial-messages"), true);
  assert.equal(iterationArgs[iterationArgs.indexOf("--session-id") + 1], run.claude.sessionId);
  assert.equal(iterationArgs.includes("implement"), false);
  assert.equal(stdin[0], "implement");
});

test("pollClaudeIteration returns only events after cursor and get transcript returns archive", async () => {
  const repo = await makeGitRepo();
  const fake = await makeStreamingFakeClaude({ delayMs: 5 });
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const started = await startClaudeIteration({
    runId: run.runId,
    prompt: "implement",
    iteration: 1,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  let first;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    first = await pollClaudeIteration({ taskId: started.taskId, cursor: 0 });
    if (first.status === "completed") break;
  }
  assert.equal(first.status, "completed");
  assert.ok(first.events.length >= 4);

  const second = await pollClaudeIteration({ taskId: started.taskId, cursor: first.nextCursor });
  assert.equal(second.events.length, 0);
  assert.equal(second.nextCursor, first.nextCursor);

  const transcript = await getClaudeTranscript({ taskId: started.taskId });
  assert.equal(transcript.status, "completed");
  assert.deepEqual(transcript.events, first.events);
});

test("startClaudeIteration records failed and timed_out terminal states", async () => {
  const failedRepo = await makeGitRepo();
  const failingFake = await makeStreamingFakeClaude({ exitCode: 7, delayMs: 5 });
  const failedRun = await preflight({
    workspacePath: failedRepo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(failingFake.dir) },
  });
  const failedTask = await startClaudeIteration({
    runId: failedRun.runId,
    prompt: "fail",
    iteration: 1,
    env: { ...process.env, PATH: pathWithFakeBin(failingFake.dir) },
  });
  let failedPoll;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    failedPoll = await pollClaudeIteration({ taskId: failedTask.taskId, cursor: 0 });
    if (failedPoll.status === "failed") break;
  }
  assert.equal(failedPoll.status, "failed");

  const timeoutRepo = await makeGitRepo();
  const slowFake = await makeStreamingFakeClaude({ delayMs: 1000 });
  const timeoutRun = await preflight({
    workspacePath: timeoutRepo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(slowFake.dir) },
  });
  const timeoutTask = await startClaudeIteration({
    runId: timeoutRun.runId,
    prompt: "timeout",
    iteration: 1,
    timeoutSec: 1,
    env: { ...process.env, PATH: pathWithFakeBin(slowFake.dir) },
  });
  let timeoutPoll;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    timeoutPoll = await pollClaudeIteration({ taskId: timeoutTask.taskId, cursor: 0 });
    if (timeoutPoll.status === "timed_out") break;
  }
  assert.equal(timeoutPoll.status, "timed_out");
});

test("state machine rejects repeated, skipped, concurrent, and over-limit iterations", async () => {
  const repo = await makeGitRepo();
  const fake = await makeStreamingFakeClaude({ delayMs: 200 });
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    maxIterations: 3,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  await assert.rejects(
    () => startClaudeIteration({
      runId: run.runId,
      prompt: "skip",
      iteration: 2,
      env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
    }),
    /iteration must be 1/,
  );

  const started = await startClaudeIteration({
    runId: run.runId,
    prompt: "first",
    iteration: 1,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  await assert.rejects(
    () => startClaudeIteration({
      runId: run.runId,
      prompt: "concurrent",
      iteration: 1,
      env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
    }),
    /already has running task/,
  );

  assert.equal((await waitForTaskStatus(started.taskId, "completed", 80, 50)).status, "completed");
  await recordReview({ runId: run.runId, iteration: 1, outcome: "needs_fix" });

  const limitedRun = await preflight({
    workspacePath: repo,
    task: "limited",
    maxIterations: 1,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const limitedTask = await startClaudeIteration({
    runId: limitedRun.runId,
    prompt: "first",
    iteration: 1,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  assert.equal((await waitForTaskStatus(limitedTask.taskId, "completed", 80, 50)).status, "completed");
  await recordReview({ runId: limitedRun.runId, iteration: 1, outcome: "needs_fix" });
  await assert.rejects(
    () => startClaudeIteration({
      runId: limitedRun.runId,
      prompt: "too many",
      iteration: 2,
      env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
    }),
    /exceeds maxIterations/,
  );
});

test("queue maps are cleaned after many keys and failures do not block later work", async () => {
  const failures = [];
  for (let index = 0; index < 50; index += 1) {
    failures.push(assert.rejects(() => __testing.runQueuedWork("run", `run-key-${index}`, true), /queued failure/));
  }
  await Promise.all(failures);
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) => __testing.runQueuedWork(index % 2 ? "task" : "run", `queue-key-${index}`)),
  );
  assert.equal(results.every((item) => item === "ok"), true);
  assert.deepEqual(__testing.queueSizes(), { taskQueues: 0, runQueues: 0, activeChildren: 0 });
});

test("task id traversal is rejected and corrupt transcript lines are skipped", async () => {
  await assert.rejects(
    () => pollClaudeIteration({ taskId: "../task-20260101000000-abcdef", cursor: 0 }),
    /taskId/,
  );

  const repo = await makeGitRepo();
  const fake = await makeStreamingFakeClaude({ delayMs: 5 });
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const started = await startClaudeIteration({
    runId: run.runId,
    prompt: "implement",
    iteration: 1,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const polled = await pollClaudeIteration({ taskId: started.taskId, cursor: 0 });
    if (polled.status === "completed") break;
  }
  await appendFile(started.transcriptLogPath, "not-json\n");
  const polled = await pollClaudeIteration({ taskId: started.taskId, cursor: 0 });
  assert.ok(polled.events.length > 0);
  assert.equal(polled.corruptTranscriptLines.length, 1);
});

test("claude arg allowlist rejects shell metacharacters and forbidden prompt/session options", async () => {
  const repo = await makeGitRepo();
  const fake = await makeCapturingFakeClaude();
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  await assert.rejects(
    () => runClaudeIteration({
      runId: run.runId,
      prompt: "safe",
      iteration: 1,
      claudeArgs: ["--model", "deepseek&calc"],
      env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
    }),
    /shell metacharacters/,
  );
  for (const bad of ["deepseek|calc", "deepseek<in", "deepseek>out", "deepseek^x", "deepseek%x", "deepseek!x", 'deepseek"x', "deepseek(x)", "deepseek\r\nx"]) {
    await assert.rejects(
      () => startClaudeIteration({
        runId: run.runId,
        prompt: "safe",
        iteration: 1,
        claudeArgs: ["--model", bad],
        env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
      }),
      /shell metacharacters|unsupported characters/,
    );
  }
  await assert.rejects(
    () => startClaudeIteration({
      runId: run.runId,
      prompt: "safe",
      iteration: 1,
      claudeArgs: ["--append-system-prompt", "free text"],
      env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
    }),
    /unsupported option --append-system-prompt/,
  );
  await assert.rejects(
    () => startClaudeIteration({
      runId: run.runId,
      prompt: "safe",
      iteration: 1,
      claudeArgs: ["--allowedTools", "Bash,Read;bad"],
      env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
    }),
    /comma-separated list/,
  );

  const result = await runClaudeIteration({
    runId: run.runId,
    prompt: "safe",
    iteration: 1,
    claudeArgs: ["--output-format", "text", "--model", "deepseek-chat"],
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  assert.equal(result.args.includes("text"), false);
  assert.equal(result.args.includes("--model"), true);
});

test("cancelClaudeIteration creates a stable cancelled terminal state", async () => {
  const repo = await makeGitRepo();
  const fake = await makeStreamingFakeClaude({ delayMs: 2000 });
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const started = await startClaudeIteration({
    runId: run.runId,
    prompt: "cancel",
    iteration: 1,
    timeoutSec: 30,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const cancelled = await cancelClaudeIteration({ taskId: started.taskId });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelled, true);
  assert.ok(cancelled.killResult.attempted || cancelled.killResult.reason);
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (started.pid) assert.equal(await __testing.processExists(started.pid), false);
  const polled = await pollClaudeIteration({ taskId: started.taskId, cursor: 0 });
  assert.equal(polled.status, "cancelled");
  assert.equal(polled.exitCode, 1);
  const runJson = await readJson(path.join(run.runDir, "run.json"));
  assert.equal(runJson.status, "cancelled");
  assert.equal(runJson.activeTaskId, null);
  const finalLog = await readJson(started.finalLogPath);
  assert.equal(finalLog.taskId, started.taskId);
  assert.equal(finalLog.cancelReason, "Cancelled by AI Bridge.");
  const again = await cancelClaudeIteration({ taskId: started.taskId });
  assert.equal(again.cancelled, false);
  assert.equal(again.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterClose = await pollClaudeIteration({ taskId: started.taskId, cursor: 0 });
  assert.equal(afterClose.status, "cancelled");
});

test("recoverRunningTasks preserves live restarted tasks and orphaned tasks are finalized", async () => {
  const repo = await makeGitRepo();
  const fake = await makeFakeBin("@echo off\r\necho 2.1.105 (Claude Code)\r\n");
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const taskId = `task-20990101000001-${Math.random().toString(36).slice(2, 8).padEnd(6, "0").slice(0, 6)}`;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true });
  const taskFile = path.join(homedir(), ".ai-bridge", "tasks", `${taskId}.json`);
  const task = {
    taskId,
    runId: run.runId,
    iteration: 1,
    status: "running",
    workspacePath: repo,
    claudeSessionId: run.claude.sessionId,
    sessionInvocationMode: "session-id",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    timeoutSec: 30,
    streamLogPath: path.join(run.runDir, "iteration-1.stream.jsonl"),
    transcriptLogPath: path.join(run.runDir, "iteration-1.transcript.jsonl"),
    finalLogPath: path.join(run.runDir, "iteration-1.json"),
    eventCount: 0,
    exitCode: null,
    timedOut: false,
    stderr: "",
    args: ["[PROMPT_ON_STDIN_REDACTED]"],
    pid: child.pid,
    heartbeatAt: new Date().toISOString(),
    lastEventAt: null,
  };
  await writeFile(task.streamLogPath, "");
  await writeFile(task.transcriptLogPath, "");
  await writeFile(taskFile, `${JSON.stringify(task, null, 2)}\n`);
  const recovery = await recoverRunningTasks();
  assert.ok(recovery.recovered.some((item) => item.taskId === taskId && item.action === "left_running"));
  const cancelled = await cancelClaudeIteration({ taskId });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(await __testing.processExists(child.pid), false);

  const orphanTask = await readJson(taskFile);
  orphanTask.taskId = `task-20990101000000-${Math.random().toString(36).slice(2, 8).padEnd(6, "0").slice(0, 6)}`;
  orphanTask.status = "running";
  orphanTask.pid = 99999999;
  orphanTask.finalLogPath = path.join(run.runDir, "iteration-99.json");
  orphanTask.iteration = 99;
  await writeFile(path.join(homedir(), ".ai-bridge", "tasks", `${orphanTask.taskId}.json`), `${JSON.stringify(orphanTask, null, 2)}\n`);
  const orphanRecovery = await recoverRunningTasks();
  assert.ok(orphanRecovery.recovered.some((item) => item.taskId === orphanTask.taskId && item.action === "marked_orphaned"));
  const orphanPolled = await pollClaudeIteration({ taskId: orphanTask.taskId, cursor: 0 });
  assert.equal(orphanPolled.status, "failed");
});

test("preparePlanHandoff wraps an approved proposed plan for Claude execution", async () => {
  const repo = await makeGitRepo();
  const fake = await makeFakeBin("@echo off\r\necho 2.1.105 (Claude Code)\r\n");
  const run = await preflight({
    workspacePath: repo,
    task: "implement approved plan",
    verificationCommands: ["npm test"],
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const planText = [
    "<proposed_plan>",
    "# Add Feature",
    "- Change the CLI output.",
    "- Add regression tests.",
    "</proposed_plan>",
  ].join("\n");

  const handoff = await preparePlanHandoff({
    runId: run.runId,
    planText,
    task: "Ship the approved plan.",
    verificationCommands: ["npm test"],
  });

  assert.match(handoff.handoffPrompt, /Approved Codex Plan/);
  assert.match(handoff.handoffPrompt, /# Add Feature/);
  assert.match(handoff.handoffPrompt, /Do not modify unrelated files/);
  assert.match(handoff.handoffPrompt, /npm test/);
  assert.match(handoff.handoffPath, /plan-handoff-1\.txt$/);
  const saved = await readFile(handoff.handoffPath, "utf8");
  assert.equal(saved, handoff.handoffPrompt);
});

test("preparePlanHandoff rejects empty plans", async () => {
  const repo = await makeGitRepo();
  const fake = await makeFakeBin("@echo off\r\necho 2.1.105 (Claude Code)\r\n");
  const run = await preflight({
    workspacePath: repo,
    task: "implement approved plan",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  await assert.rejects(
    () => preparePlanHandoff({ runId: run.runId, planText: "   " }),
    /planText/,
  );
});

test("preparePlanHandoff explains that run id must come from preflight", async () => {
  await assert.rejects(
    () => preparePlanHandoff({
      runId: "00000000-0000-4000-8000-000000000000",
      planText: "<proposed_plan>\nDo work\n</proposed_plan>",
    }),
    /ai_bridge_preflight/,
  );
});

test("summarizeCosts aggregates usage and computes optional pricing comparison", async () => {
  const repo = await makeGitRepo();
  const fake = await makeFakeBin("@echo off\r\necho 2.1.105 (Claude Code)\r\n");
  const run = await preflight({
    workspacePath: repo,
    task: "summarize usage",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  await writeFile(
    path.join(run.runDir, "iteration-1.stream.jsonl"),
    [
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 850,
            },
          },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_delta",
          usage: {
            input_tokens: 0,
            output_tokens: 200,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    ].join("\n") + "\n",
  );

  const usageOnly = await summarizeCosts({ runId: run.runId });
  assert.deepEqual(usageOnly.usage, {
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationInputTokens: 50,
    cacheReadInputTokens: 850,
  });
  assert.equal(usageOnly.cacheHitRate, 0.85);
  assert.equal(usageOnly.costs, null);

  const priced = await summarizeCosts({
    runId: run.runId,
    pricing: {
      deepseek: {
        inputPerMillion: 1,
        outputPerMillion: 2,
        cacheCreationInputPerMillion: 0.5,
        cacheReadInputPerMillion: 0.1,
      },
      codex: {
        inputPerMillion: 10,
        outputPerMillion: 20,
        cacheCreationInputPerMillion: 5,
        cacheReadInputPerMillion: 1,
      },
    },
  });

  assert.equal(priced.costs.deepseek.total, 0.00061);
  assert.equal(priced.costs.codex.total, 0.0061);
  assert.equal(priced.sameTokenHypotheticalEstimate.difference, 0.00549);
  assert.equal(priced.sameTokenHypotheticalEstimate.ratio, 0.9);
});

test("summarizeCosts returns null cache hit rate when no cacheable tokens exist", async () => {
  const repo = await makeGitRepo();
  const fake = await makeFakeBin("@echo off\r\necho 2.1.105 (Claude Code)\r\n");
  const run = await preflight({
    workspacePath: repo,
    task: "summarize empty usage",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  const summary = await summarizeCosts({ runId: run.runId });
  assert.equal(summary.cacheHitRate, null);
  assert.deepEqual(summary.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
});

test("runClaudeIteration captures output and redacts common secrets", async () => {
  const repo = await makeGitRepo();
  const fake = await makeFakeBin(
    "@echo off\r\necho {\"result\":\"ok\",\"token\":\"sk-1234567890abcdef\"}\r\n",
  );
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  const result = await runClaudeIteration({
    runId: run.runId,
    prompt: "implement",
    iteration: 1,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(result.stdout, /sk-1234567890abcdef/);
  assert.equal(result.parsedJson.result, "ok");
  const log = await readFile(result.logPath, "utf8");
  assert.match(log, /\[REDACTED_SECRET\]/);
});

test("snapshotChanges returns changed files, untracked files, and diff stat", async () => {
  const repo = await makeGitRepo();
  const fake = await makeFakeBin("@echo off\r\necho 2.1.105 (Claude Code)\r\n");
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  await writeFile(path.join(repo, "README.md"), "# changed\n");
  await writeFile(path.join(repo, "new.txt"), "new\n");

  const result = await snapshotChanges({ runId: run.runId });

  assert.equal(result.hasChanges, true);
  assert.ok(result.changedFiles.some((entry) => entry.path === "README.md"));
  assert.ok(result.untrackedFiles.includes("new.txt"));
  assert.match(result.diffStat, /README\.md/);
});

test("snapshotChanges separates pre-existing and new changes with spaces unicode staged and renames", async () => {
  const repo = await makeGitRepo();
  await writeFile(path.join(repo, "space name.txt"), "before\n");
  await writeFile(path.join(repo, "中文.txt"), "tracked\n");
  await execFile("git", ["add", "space name.txt", "中文.txt"], { cwd: repo });
  await execFile("git", ["commit", "-m", "add named files"], { cwd: repo });
  await writeFile(path.join(repo, "space name.txt"), "user dirty before preflight\n");
  await writeFile(path.join(repo, "预先存在.txt"), "user untracked\n");
  await execFile("git", ["mv", "中文.txt", "中文 renamed.txt"], { cwd: repo });
  await writeFile(path.join(repo, "staged.txt"), "staged\n");
  await execFile("git", ["add", "staged.txt"], { cwd: repo });
  const fake = await makeFakeBin("@echo off\r\necho 2.1.105 (Claude Code)\r\n");
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  await writeFile(path.join(repo, "space name.txt"), "modified again after preflight\n");
  await writeFile(path.join(repo, "棰勫厛瀛樺湪.txt"), "user untracked modified after preflight\n");
  await writeFile(path.join(repo, "staged.txt"), "staged changed after preflight\n");
  await execFile("git", ["add", "staged.txt"], { cwd: repo });
  await writeFile(path.join(repo, "staged.txt"), "staged changed after preflight plus unstaged\n");
  await writeFile(path.join(repo, "new after.txt"), "new\n");

  const result = await snapshotChanges({ runId: run.runId });

  assert.ok(result.preExistingChanges.includes("space name.txt"));
  assert.ok(result.preExistingChanges.includes("预先存在.txt"));
  assert.ok(result.changesCreatedAfterPreflight.includes("new after.txt"));
  assert.ok(result.modifiedPreExistingChanges.some((entry) => entry.path === "space name.txt"));
  assert.ok(result.stagedChanges.some((entry) => entry.path === "staged.txt"));
  assert.ok(result.preExistingUntrackedFiles.length > 0);
  assert.ok(Array.isArray(result.modifiedPreExistingUntrackedFiles));
  assert.ok(result.preExistingStagedChanges.some((entry) => entry.path === "staged.txt"));
  assert.ok(result.modifiedPreExistingStagedChanges.some((entry) => entry.path === "staged.txt" && entry.hasUnstagedChanges));
  assert.ok(result.renamedFiles.some((entry) => entry.path === "中文 renamed.txt" || entry.originalPath === "中文.txt"));
});

test("snapshotChanges detects modified pre-existing untracked unicode files", async () => {
  const repo = await makeGitRepo();
  const unicodeUntracked = "用户 草稿.txt";
  await writeFile(path.join(repo, unicodeUntracked), "before\n");
  const fake = await makeFakeBin("@echo off\r\necho 2.1.105 (Claude Code)\r\n");
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  await writeFile(path.join(repo, unicodeUntracked), "after\n");

  const result = await snapshotChanges({ runId: run.runId });

  assert.ok(result.preExistingUntrackedFiles.includes(unicodeUntracked));
  assert.ok(result.modifiedPreExistingUntrackedFiles.some((entry) => entry.path === unicodeUntracked));
});

test("runVerificationCommands records structured command results", async () => {
  const repo = await makeGitRepo();
  const fake = await makeFakeBin("@echo off\r\necho 2.1.105 (Claude Code)\r\n");
  const run = await preflight({
    workspacePath: repo,
    task: "verify",
    verificationCommands: ["node --version"],
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  const result = await runVerificationCommands({
    runId: run.runId,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].exitCode, 0);
  assert.equal(path.basename(result.results[0].cwd), path.basename(repo));
  assert.match(result.results[0].stdout, /v\d+\./);
  const log = await readFile(result.verificationLogPath, "utf8");
  assert.match(log, /node --version/);
});

test("recordReview appends structured review events", async () => {
  const repo = await makeGitRepo();
  const fake = await makeStreamingFakeClaude({ delayMs: 5 });
  const run = await preflight({
    workspacePath: repo,
    task: "change code",
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const task = await startClaudeIteration({
    runId: run.runId,
    prompt: "implement",
    iteration: 1,
    env: { ...process.env, PATH: pathWithFakeBin(fake.dir) },
  });
  const completed = await waitForTaskStatus(task.taskId, "completed", 80, 50);
  assert.equal(completed.status, "completed");

  const result = await recordReview({
    runId: run.runId,
    iteration: 1,
    outcome: "needs_fix",
    findings: [{ severity: "high", message: "missing test" }],
    verificationCommandsRun: [{ command: "npm test", exitCode: 1 }],
  });

  assert.equal(result.status, "recorded");
  const log = await readFile(result.reviewLogPath, "utf8");
  const event = JSON.parse(log.trim());
  assert.equal(event.outcome, "needs_fix");
  assert.equal(event.findings[0].message, "missing test");
});
