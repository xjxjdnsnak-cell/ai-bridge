import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const DEFAULT_MAX_ITERATIONS = 3;
const RUN_ID_PATTERN = /^run-[A-Za-z0-9_.-]+$/;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /(api[_-]?key["'\s:=]+)[A-Za-z0-9_\-]{12,}/gi,
  /(authorization["'\s:=]+bearer\s+)[A-Za-z0-9._\-]{12,}/gi,
];

function nowToken() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function randomToken() {
  return Math.random().toString(36).slice(2, 8);
}

function createTaskId() {
  return `task-${nowToken()}-${randomToken()}`;
}

function createClaudeSessionId() {
  return randomUUID();
}

function bridgeRoot() {
  return path.join(os.homedir(), ".ai-bridge");
}

function runsRoot() {
  return path.join(bridgeRoot(), "runs");
}

function runPath(runId) {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("runId must be returned by ai_bridge_preflight and match run-<timestamp>-<token>; do not generate a UUID or call plan handoff before preflight.");
  }
  return path.join(runsRoot(), runId);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readRun(runId) {
  const runDir = runPath(runId);
  const payload = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  return { ...payload, runDir };
}

async function readTask(taskId) {
  const taskPath = path.join(bridgeRoot(), "tasks", `${taskId}.json`);
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const payload = JSON.parse(await readFile(taskPath, "utf8"));
      return { ...payload, taskPath };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

async function writeRun(run) {
  await mkdir(run.runDir, { recursive: true });
  await writeFile(path.join(run.runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
}

async function updateRun(run) {
  await writeRun(run);
}

async function writeTask(task) {
  const taskDir = path.join(bridgeRoot(), "tasks");
  await mkdir(taskDir, { recursive: true });
  const targetPath = path.join(taskDir, `${task.taskId}.json`);
  const tempPath = path.join(taskDir, `${task.taskId}.${process.pid}.${randomToken()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(task, null, 2)}\n`);
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(targetPath, { force: true });
      await rename(tempPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

function normalizeWorkspace(workspacePath) {
  if (typeof workspacePath !== "string" || workspacePath.trim() === "") {
    throw new Error("workspacePath must be a non-empty string.");
  }
  return path.resolve(workspacePath);
}

async function execCommand(command, args, options = {}) {
  const childOptions = {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === "win32",
  };

  try {
    const result = await execFile(command, args, childOptions);
    return {
      exitCode: 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: false,
    };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? String(error),
      timedOut: Boolean(error.killed) || error.signal === "SIGTERM",
    };
  }
}

function spawnCommand(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function requireGitWorkspace(workspace) {
  const result = await execCommand("git", ["rev-parse", "--show-toplevel"], { cwd: workspace });
  if (result.exitCode !== 0) {
    throw new Error("workspacePath must be inside a git repository.");
  }
  return path.resolve(result.stdout.trim());
}

function splitLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function sanitizeClaudeArgs(args) {
  const sanitized = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if (value === "--session-id" || value === "--resume" || value === "-r") {
      index += 1;
      continue;
    }
    if (value.startsWith("--session-id=") || value.startsWith("--resume=")) {
      continue;
    }
    if (value === "--continue" || value === "-c") {
      continue;
    }
    sanitized.push(value);
  }
  return sanitized;
}

function parseStreamJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function unwrapStreamEvent(event) {
  if (event?.type === "stream_event" && event.event && typeof event.event === "object") {
    return event.event;
  }
  return event;
}

function extractUsage(event) {
  const unwrapped = unwrapStreamEvent(event);
  const usage = unwrapped?.usage ?? unwrapped?.message?.usage ?? unwrapped?.delta?.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  return {
    inputTokens: Number(usage.input_tokens ?? 0) || 0,
    outputTokens: Number(usage.output_tokens ?? 0) || 0,
    cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0) || 0,
    cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0) || 0,
  };
}

function addUsage(target, usage) {
  if (!usage) return target;
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  target.cacheReadInputTokens += usage.cacheReadInputTokens;
  return target;
}

function stringifyCompact(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const candidate =
    input.command ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.description ??
    input.query ??
    "";
  return stringifyCompact(candidate).slice(0, 240);
}

function summarizeStreamEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  event = unwrapStreamEvent(event);
  if (event.delta?.type === "thinking_delta" || event.content_block?.type === "thinking") {
    return null;
  }

  const assistantText =
    event.delta?.text ||
    (event.delta?.type === "text_delta" ? event.delta.text : "") ||
    event.delta?.partial_json ||
    event.message?.content ||
    event.content ||
    event.text ||
    "";
  const extractedAssistant = extractTextFromContent(assistantText) || stringifyCompact(assistantText);
  if (
    extractedAssistant &&
    (event.type === "assistant" ||
      event.type === "assistant_message" ||
      event.type === "content_block_delta" ||
      event.type === "message")
  ) {
    return { kind: "assistant", text: `Claude: ${redactSecrets(extractedAssistant)}` };
  }

  const toolName = event.name ?? event.tool_name ?? event.tool?.name;
  if (event.type === "tool_use" || event.type === "tool_call" || event.type === "tool") {
    const detail = summarizeToolInput(event.input ?? event.tool?.input);
    return {
      kind: "tool_use",
      text: redactSecrets(`Tool: ${toolName ?? "unknown"}${detail ? ` ${detail}` : ""}`),
    };
  }
  if (event.type === "tool_result" || event.type === "tool_response") {
    const exitCode = event.exitCode ?? event.exit_code ?? event.result?.exitCode ?? event.result?.exit_code;
    return {
      kind: "tool_result",
      text: redactSecrets(`Tool result: ${toolName ?? "unknown"}${exitCode !== undefined ? ` exit ${exitCode}` : ""}`),
    };
  }
  if (event.type === "error" || event.error) {
    return {
      kind: "error",
      text: redactSecrets(`Error: ${event.message ?? event.error?.message ?? stringifyCompact(event.error)}`),
    };
  }

  return null;
}

async function appendTranscriptEvent(task, summary) {
  if (!summary) return;
  const event = {
    index: task.eventCount,
    at: new Date().toISOString(),
    ...summary,
  };
  task.eventCount += 1;
  await appendFile(task.transcriptLogPath, `${JSON.stringify(event)}\n`);
}

async function finalizeAsyncTask(task, status, details = {}) {
  task.status = status;
  task.finishedAt = new Date().toISOString();
  task.exitCode = details.exitCode ?? task.exitCode ?? null;
  task.timedOut = status === "timed_out";
  task.stderr = redactSecrets(details.stderr ?? task.stderr ?? "");
  await writeTask(task);
  const event = {
    runId: task.runId,
    taskId: task.taskId,
    iteration: task.iteration,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    command: "claude",
    claudeSessionId: task.claudeSessionId,
    args: task.args,
    exitCode: task.exitCode,
    timedOut: task.timedOut,
    stdout: "",
    stderr: task.stderr,
    parsedJson: null,
    streamLogPath: task.streamLogPath,
    transcriptLogPath: task.transcriptLogPath,
  };
  await writeFile(task.finalLogPath, `${JSON.stringify(event, null, 2)}\n`);
}

function handleStreamChunk(task, bufferState, chunk) {
  bufferState.value += chunk.toString("utf8");
  const lines = bufferState.value.split(/\r?\n/);
  bufferState.value = lines.pop() ?? "";
  return lines.filter((line) => line.trim().length > 0);
}

async function ensureClaudeSession(run) {
  if (typeof run.claudeSessionId === "string" && run.claudeSessionId.trim() !== "") {
    return run.claudeSessionId;
  }
  run.claudeSessionId = createClaudeSessionId();
  await writeRun(run);
  return run.claudeSessionId;
}

export function redactSecrets(text) {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, (match, prefix) => {
      if (typeof prefix === "string" && prefix.length > 0 && match.toLowerCase() !== prefix.toLowerCase()) {
        return `${prefix}[REDACTED_SECRET]`;
      }
      return "[REDACTED_SECRET]";
    }),
    text,
  );
}

export async function detectVerificationCommands(workspacePath, explicitCommands) {
  if (Array.isArray(explicitCommands) && explicitCommands.length > 0) {
    return explicitCommands.map((command) => String(command).trim()).filter(Boolean);
  }

  const workspace = normalizeWorkspace(workspacePath);
  const commands = [];
  const packageJsonPath = path.join(workspace, "package.json");
  if (await exists(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      const scripts = packageJson.scripts ?? {};
      if (scripts.test) commands.push("npm test");
      if (scripts.lint) commands.push("npm run lint");
      if (scripts.build) commands.push("npm run build");
    } catch {
      commands.push("npm test");
    }
  }

  if (await exists(path.join(workspace, "pyproject.toml"))) {
    commands.push("uv run pytest");
  } else if (await exists(path.join(workspace, "pytest.ini"))) {
    commands.push("pytest");
  }

  if (await exists(path.join(workspace, "Cargo.toml"))) commands.push("cargo test");
  if (await exists(path.join(workspace, "go.mod"))) commands.push("go test ./...");
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(workspace).catch(() => []));
  if (entries.some((entry) => entry.endsWith(".csproj") || entry.endsWith(".sln"))) {
    commands.push("dotnet test");
  }

  return [...new Set(commands)];
}

export async function preflight({
  workspacePath,
  task,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  verificationCommands,
  env = process.env,
} = {}) {
  const workspace = normalizeWorkspace(workspacePath);
  const gitRoot = await requireGitWorkspace(workspace);
  const statusResult = await execCommand("git", ["status", "--porcelain=v1"], { cwd: gitRoot, env });
  const claudeVersion = await execCommand("claude", ["--version"], { cwd: gitRoot, env });
  if (claudeVersion.exitCode !== 0) {
    throw new Error("Claude Code CLI was not found or could not be executed from PATH.");
  }

  const runId = `run-${nowToken()}-${randomToken()}`;
  const runDir = path.join(runsRoot(), runId);
  const commands = await detectVerificationCommands(gitRoot, verificationCommands);
  const run = {
    runId,
    runDir,
    workspacePath: gitRoot,
    claudeSessionId: createClaudeSessionId(),
    task: String(task ?? ""),
    maxIterations: Number.isInteger(maxIterations) && maxIterations > 0 ? maxIterations : DEFAULT_MAX_ITERATIONS,
    defaultMaxIterations: DEFAULT_MAX_ITERATIONS,
    verificationCommands: commands,
    createdAt: new Date().toISOString(),
  };
  await writeRun(run);

  return {
    runId,
    runDir,
    workspacePath: gitRoot,
    task: run.task,
    maxIterations: run.maxIterations,
    defaultMaxIterations: DEFAULT_MAX_ITERATIONS,
    verificationCommands: commands,
    claude: {
      available: true,
      version: claudeVersion.stdout.trim() || claudeVersion.stderr.trim(),
      sessionId: run.claudeSessionId,
    },
    git: {
      root: gitRoot,
      dirty: statusResult.stdout.trim().length > 0,
      status: statusResult.stdout,
    },
  };
}

export async function preparePlanHandoff({
  runId,
  planText,
  task,
  verificationCommands,
} = {}) {
  const run = await readRun(runId);
  if (typeof planText !== "string" || planText.trim() === "") {
    throw new Error("planText must be a non-empty approved Codex plan.");
  }

  const commands = Array.isArray(verificationCommands) && verificationCommands.length > 0
    ? verificationCommands.map((command) => String(command).trim()).filter(Boolean)
    : run.verificationCommands ?? [];
  const handoffs = Array.isArray(run.planHandoffs) ? run.planHandoffs : [];
  const handoffIndex = handoffs.length + 1;
  const handoffPath = path.join(run.runDir, `plan-handoff-${handoffIndex}.txt`);
  const taskText = typeof task === "string" && task.trim() ? task.trim() : run.task;
  const handoffPrompt = [
    "You are implementing one explicitly approved Codex plan in this git repository.",
    "",
    "Approved Codex Plan:",
    planText.trim(),
    "",
    "Task:",
    taskText || "Implement the approved plan exactly.",
    "",
    "Execution Boundaries:",
    "- Implement only the approved plan.",
    "- Do not modify unrelated files.",
    "- Preserve user changes that are outside the approved plan.",
    "- Do not read, request, store, or modify API keys or credentials.",
    "- Keep the diff focused and reviewable.",
    "",
    "Verification Commands:",
    commands.length ? commands.map((command) => `- ${command}`).join("\n") : "- None provided; infer and run appropriate local checks if safe.",
    "",
    "Completion Report:",
    "- Files changed",
    "- Commands run and results",
    "- Any blockers or deviations from the approved plan",
  ].join("\n");

  await writeFile(handoffPath, handoffPrompt);
  const event = {
    index: handoffIndex,
    handoffPath,
    task: taskText,
    verificationCommands: commands,
    createdAt: new Date().toISOString(),
  };
  run.planHandoffs = handoffs.concat(event);
  await updateRun(run);

  return {
    runId,
    handoffIndex,
    handoffPath,
    handoffPrompt,
    verificationCommands: commands,
  };
}

export async function runClaudeIteration({
  runId,
  prompt,
  iteration,
  timeoutSec = 900,
  claudeArgs = [],
  env = process.env,
} = {}) {
  const run = await readRun(runId);
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error("iteration must be a positive integer.");
  }
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("prompt must be a non-empty string.");
  }

  const claudeSessionId = await ensureClaudeSession(run);
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--session-id",
    claudeSessionId,
    ...sanitizeClaudeArgs(claudeArgs),
    prompt,
  ];
  const startedAt = new Date().toISOString();
  const result = await execCommand("claude", args, {
    cwd: run.workspacePath,
    env,
    timeout: Math.max(1, Number(timeoutSec)) * 1000,
  });
  const sanitizedStdout = redactSecrets(result.stdout);
  const sanitizedStderr = redactSecrets(result.stderr);
  let parsedJson = null;
  try {
    parsedJson = sanitizedStdout.trim() ? JSON.parse(sanitizedStdout) : null;
  } catch {
    parsedJson = null;
  }

  const logPath = path.join(run.runDir, `iteration-${iteration}.json`);
  const event = {
    runId,
    iteration,
    startedAt,
    finishedAt: new Date().toISOString(),
    command: "claude",
    claudeSessionId,
    args: args.slice(0, -1).concat("[PROMPT_REDACTED]"),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: sanitizedStdout,
    stderr: sanitizedStderr,
    parsedJson,
  };
  await writeFile(logPath, `${JSON.stringify(event, null, 2)}\n`);
  return { ...event, logPath };
}

export async function startClaudeIteration({
  runId,
  prompt,
  iteration,
  timeoutSec = 900,
  claudeArgs = [],
  env = process.env,
} = {}) {
  const run = await readRun(runId);
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error("iteration must be a positive integer.");
  }
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("prompt must be a non-empty string.");
  }

  const claudeSessionId = await ensureClaudeSession(run);
  const taskId = createTaskId();
  const streamLogPath = path.join(run.runDir, `iteration-${iteration}.stream.jsonl`);
  const transcriptLogPath = path.join(run.runDir, `iteration-${iteration}.transcript.jsonl`);
  const finalLogPath = path.join(run.runDir, `iteration-${iteration}.json`);
  await writeFile(streamLogPath, "");
  await writeFile(transcriptLogPath, "");

  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--permission-mode",
    "acceptEdits",
    "--session-id",
    claudeSessionId,
    ...sanitizeClaudeArgs(claudeArgs),
    prompt,
  ];
  const task = {
    taskId,
    runId,
    iteration,
    status: "running",
    workspacePath: run.workspacePath,
    claudeSessionId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    timeoutSec: Math.max(1, Number(timeoutSec)),
    streamLogPath,
    transcriptLogPath,
    finalLogPath,
    eventCount: 0,
    exitCode: null,
    timedOut: false,
    stderr: "",
    args: args.slice(0, -1).concat("[PROMPT_REDACTED]"),
  };
  await writeTask(task);

  const child = spawnCommand("claude", args, { cwd: run.workspacePath, env });
  const stdoutBuffer = { value: "" };
  const stderrBuffer = { value: "" };
  const timeout = setTimeout(() => {
    if (task.status === "running") {
      void finalizeAsyncTask(task, "timed_out", { exitCode: 1, stderr: task.stderr });
    }
    child.kill();
  }, task.timeoutSec * 1000);

  child.stdout.on("data", (chunk) => {
    void (async () => {
      for (const line of handleStreamChunk(task, stdoutBuffer, chunk)) {
        const sanitized = redactSecrets(line);
        await appendFile(streamLogPath, `${sanitized}\n`);
        await appendTranscriptEvent(task, summarizeStreamEvent(parseStreamJsonLine(sanitized)));
        await writeTask(task);
      }
    })();
  });

  child.stderr.on("data", (chunk) => {
    void (async () => {
      for (const line of handleStreamChunk(task, stderrBuffer, chunk)) {
        task.stderr += `${redactSecrets(line)}\n`;
        await writeTask(task);
      }
    })();
  });

  child.on("error", (error) => {
    clearTimeout(timeout);
    if (task.status !== "running") return;
    void finalizeAsyncTask(task, "failed", { exitCode: 1, stderr: error.message });
  });

  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    if (task.status !== "running") return;
    void (async () => {
      for (const line of handleStreamChunk(task, stdoutBuffer, "\n")) {
        const sanitized = redactSecrets(line);
        await appendFile(streamLogPath, `${sanitized}\n`);
        await appendTranscriptEvent(task, summarizeStreamEvent(parseStreamJsonLine(sanitized)));
      }
      for (const line of handleStreamChunk(task, stderrBuffer, "\n")) {
        task.stderr += `${redactSecrets(line)}\n`;
      }
      const timedOut = signal === "SIGTERM" && task.status === "running";
      const status = timedOut ? "timed_out" : code === 0 ? "completed" : "failed";
      await finalizeAsyncTask(task, status, { exitCode: code ?? 1, stderr: task.stderr });
    })();
  });

  return {
    taskId,
    runId,
    iteration,
    status: "running",
    claudeSessionId,
    streamLogPath,
    transcriptLogPath,
    finalLogPath,
    startedAt: task.startedAt,
  };
}

export async function pollClaudeIteration({ taskId, cursor = 0 } = {}) {
  const task = await readTask(taskId);
  const transcriptText = (await readFile(task.transcriptLogPath, "utf8").catch(() => "")).trim();
  const allEvents = transcriptText
    ? transcriptText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const numericCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  const events = allEvents.filter((event) => event.index >= numericCursor);
  return {
    taskId,
    runId: task.runId,
    iteration: task.iteration,
    status: task.status,
    cursor: numericCursor,
    nextCursor: allEvents.length,
    events,
    exitCode: task.exitCode,
    timedOut: Boolean(task.timedOut),
    streamLogPath: task.streamLogPath,
    transcriptLogPath: task.transcriptLogPath,
    finalLogPath: task.finalLogPath,
  };
}

export async function getClaudeTranscript({ taskId } = {}) {
  const task = await readTask(taskId);
  const polled = await pollClaudeIteration({ taskId, cursor: 0 });
  return {
    taskId,
    runId: task.runId,
    iteration: task.iteration,
    status: task.status,
    events: polled.events,
    streamLogPath: task.streamLogPath,
    transcriptLogPath: task.transcriptLogPath,
    finalLogPath: task.finalLogPath,
  };
}

async function readStreamUsage(streamPath) {
  const text = await readFile(streamPath, "utf8").catch(() => "");
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    addUsage(usage, extractUsage(parseStreamJsonLine(line)));
  }
  return usage;
}

function roundMoney(value) {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function calculateCost(usage, price = {}) {
  const inputPrice = Number(price.inputPerMillion ?? 0) || 0;
  const outputPrice = Number(price.outputPerMillion ?? 0) || 0;
  const cacheCreationPrice = Number(price.cacheCreationInputPerMillion ?? inputPrice) || 0;
  const cacheReadPrice = Number(price.cacheReadInputPerMillion ?? inputPrice) || 0;
  const input = usage.inputTokens / 1_000_000 * inputPrice;
  const output = usage.outputTokens / 1_000_000 * outputPrice;
  const cacheCreation = usage.cacheCreationInputTokens / 1_000_000 * cacheCreationPrice;
  const cacheRead = usage.cacheReadInputTokens / 1_000_000 * cacheReadPrice;
  return {
    input: roundMoney(input),
    output: roundMoney(output),
    cacheCreation: roundMoney(cacheCreation),
    cacheRead: roundMoney(cacheRead),
    total: roundMoney(input + output + cacheCreation + cacheRead),
  };
}

export async function summarizeCosts({ runId, pricing } = {}) {
  const run = await readRun(runId);
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(run.runDir).catch(() => []));
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  for (const entry of entries.filter((name) => /^iteration-\d+\.stream\.jsonl$/.test(name)).sort()) {
    addUsage(usage, await readStreamUsage(path.join(run.runDir, entry)));
  }
  const cacheDenominator = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  const cacheHitRate = cacheDenominator > 0
    ? Math.round((usage.cacheReadInputTokens / cacheDenominator) * 1_000_000) / 1_000_000
    : null;

  let costs = null;
  if (pricing?.deepseek || pricing?.codex) {
    const deepseek = calculateCost(usage, pricing.deepseek);
    const codex = calculateCost(usage, pricing.codex);
    const amount = roundMoney(codex.total - deepseek.total);
    costs = {
      deepseek,
      codex,
      savings: {
        amount,
        ratio: codex.total > 0 ? Math.round((amount / codex.total) * 1_000_000) / 1_000_000 : null,
      },
    };
  }

  return {
    runId,
    usage,
    cacheHitRate,
    costs,
  };
}

export async function snapshotChanges({ runId } = {}) {
  const run = await readRun(runId);
  const [status, diffStat, nameStatus] = await Promise.all([
    execCommand("git", ["status", "--porcelain=v1"], { cwd: run.workspacePath }),
    execCommand("git", ["diff", "--stat"], { cwd: run.workspacePath }),
    execCommand("git", ["diff", "--name-status"], { cwd: run.workspacePath }),
  ]);
  const statusLines = splitLines(status.stdout);
  const changedFiles = splitLines(nameStatus.stdout).map((line) => {
    const [statusCode, ...rest] = line.split(/\s+/);
    return { status: statusCode, path: rest.join(" ") };
  });
  const untrackedFiles = statusLines
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3));

  const payload = {
    runId,
    workspacePath: run.workspacePath,
    hasChanges: statusLines.length > 0,
    gitStatus: status.stdout,
    diffStat: diffStat.stdout,
    changedFiles,
    untrackedFiles,
    logDir: run.runDir,
  };
  await writeFile(path.join(run.runDir, "snapshot.json"), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export async function recordReview({
  runId,
  iteration,
  outcome,
  findings = [],
  verificationCommandsRun = [],
} = {}) {
  await readRun(runId);
  if (!["pass", "needs_fix", "blocked"].includes(outcome)) {
    throw new Error("outcome must be pass, needs_fix, or blocked.");
  }
  const runDir = runPath(runId);
  const event = {
    runId,
    iteration,
    outcome,
    findings,
    verificationCommandsRun,
    recordedAt: new Date().toISOString(),
  };
  const reviewLogPath = path.join(runDir, "reviews.jsonl");
  await appendFile(reviewLogPath, `${JSON.stringify(event)}\n`);
  return {
    status: "recorded",
    runId,
    reviewLogPath,
    nextIterationAllowed: outcome === "needs_fix",
  };
}
