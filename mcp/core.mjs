import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MAX_ITERATIONS = 3;

const RUN_ID_PATTERN = /^run-\d{14}-[a-z0-9]{6}$/;
const TASK_ID_PATTERN = /^task-\d{14}-[a-z0-9]{6}$/;
const FINAL_RUN_STATES = new Set(["passed", "blocked", "cancelled"]);
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "timed_out", "cancelled"]);
const ALLOWED_CLAUDE_ARGS = new Set(["--model", "--allowedTools", "--disallowedTools"]);
const FORBIDDEN_CLAUDE_ARGS = new Set([
  "--session-id",
  "--resume",
  "-r",
  "--continue",
  "-c",
  "--output-format",
  "--permission-mode",
  "--mcp-config",
  "--strict-mcp-config",
  "--include-partial-messages",
  "--verbose",
  "-p",
  "--print",
]);
const FORBIDDEN_CLAUDE_ARGS_WITH_VALUE = new Set([
  "--session-id",
  "--resume",
  "-r",
  "--output-format",
  "--permission-mode",
  "--mcp-config",
]);
const SHELL_META_PATTERN = /[&|<>^%!"()\r\n]/;
const TOOL_LIST_PATTERN = /^[A-Za-z0-9_.:-]+(,[A-Za-z0-9_.:-]+)*$/;
const MODEL_PATTERN = /^[A-Za-z0-9_.:/@+-]+$/;
const MAX_HASH_FILE_BYTES = 5 * 1024 * 1024;
const MAX_HASH_TOTAL_BYTES = 25 * 1024 * 1024;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /(api[_-]?key["'\s:=]+)[A-Za-z0-9_\-]{12,}/gi,
  /(authorization["'\s:=]+bearer\s+)[A-Za-z0-9._\-]{12,}/gi,
];

const taskQueues = new Map();
const runQueues = new Map();
const activeChildren = new Map();

function nowToken() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0").slice(0, 6);
}

function createRunId() {
  return `run-${nowToken()}-${randomToken()}`;
}

function createTaskId() {
  return `task-${nowToken()}-${randomToken()}`;
}

function createClaudeSessionId() {
  return randomUUID();
}

function bridgeRoot() {
  if (process.env.AI_BRIDGE_HOME && process.env.AI_BRIDGE_HOME.trim()) {
    return path.resolve(process.env.AI_BRIDGE_HOME);
  }
  return path.join(os.homedir(), ".ai-bridge");
}

function runsRoot() {
  return path.join(bridgeRoot(), "runs");
}

function tasksRoot() {
  return path.join(bridgeRoot(), "tasks");
}

function validateRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("runId must be returned by ai_bridge_preflight and match run-YYYYMMDDhhmmss-token; do not generate a UUID or call plan handoff before preflight.");
  }
}

function validateTaskId(taskId) {
  if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
    throw new Error("taskId must match task-YYYYMMDDhhmmss-token and cannot contain path separators or traversal.");
  }
}

function ensureInside(base, target) {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }
  throw new Error(`Resolved path escaped AI Bridge storage root: ${resolvedTarget}`);
}

function runPath(runId) {
  validateRunId(runId);
  return ensureInside(runsRoot(), path.join(runsRoot(), runId));
}

function taskPath(taskId) {
  validateTaskId(taskId);
  return ensureInside(tasksRoot(), path.join(tasksRoot(), `${taskId}.json`));
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomToken()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await renameWithRetry(tempPath, filePath);
}

async function atomicWriteText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomToken()}.tmp`;
  await writeFile(tempPath, value);
  await renameWithRetry(tempPath, filePath);
}

async function renameWithRetry(source, target) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function withQueue(map, key, fn) {
  const previous = map.get(key) ?? Promise.resolve();
  let current;
  current = previous
    .catch(() => {})
    .then(fn)
    .finally(() => {
      if (map.get(key) === current) map.delete(key);
    });
  map.set(key, current);
  try {
    return await current;
  } catch (error) {
    throw error;
  }
}

function normalizeWorkspace(workspacePath) {
  if (typeof workspacePath !== "string" || workspacePath.trim() === "") {
    throw new Error("workspacePath must be a non-empty string.");
  }
  return path.resolve(workspacePath);
}

function parsePathList(text) {
  if (!text) return [];
  return text.split("\0").filter(Boolean);
}

function parsePorcelainZ(text) {
  const parts = parsePathList(text);
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    const status = record.slice(0, 2);
    const rawPath = record.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const originalPath = parts[i + 1] ?? "";
      i += 1;
      entries.push({ status, path: rawPath, originalPath });
    } else {
      entries.push({ status, path: rawPath });
    }
  }
  return entries;
}

function parseNameStatusZ(text) {
  const parts = parsePathList(text);
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i] ?? "";
    const filePath = parts[i + 1] ?? "";
    i += 1;
    if (status.startsWith("R") || status.startsWith("C")) {
      const originalPath = filePath;
      const newPath = parts[i + 1] ?? "";
      i += 1;
      entries.push({ status, path: newPath, originalPath });
    } else if (status && filePath) {
      entries.push({ status, path: filePath });
    }
  }
  return entries;
}

function splitLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function summarizeText(text, limit = 4000) {
  const safe = redactSecrets(String(text ?? ""));
  return safe.length > limit ? `${safe.slice(0, limit)}\n[truncated ${safe.length - limit} chars]` : safe;
}

function quoteCmdPart(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function buildCmdLine(command, args) {
  return `"${[command, ...args].map(quoteCmdPart).join(" ")}"`;
}

function executableCandidates(name, env = process.env) {
  if (path.isAbsolute(name) || name.includes(path.sep) || name.includes("/")) return [name];
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const names = process.platform === "win32" && path.extname(name) === ""
    ? extensions.map((ext) => `${name}${ext.toLowerCase()}`).concat(extensions.map((ext) => `${name}${ext.toUpperCase()}`))
    : [name];
  return pathDirs.flatMap((dir) => names.map((candidate) => path.join(dir, candidate)));
}

async function resolveExecutable(name, env = process.env) {
  for (const candidate of executableCandidates(name, env)) {
    if (await exists(candidate)) return path.resolve(candidate);
  }
  return name;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const commandPath = options.resolvedCommand ?? command;
    const isCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(commandPath);
    const child = spawn(commandPath, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: isCmd,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeout)
      : null;

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ exitCode: 1, stdout, stderr: stderr || error.message, timedOut, pid: child.pid ?? null });
    });
    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({
        exitCode: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        timedOut: timedOut || signal === "SIGTERM",
        pid: child.pid ?? null,
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

async function execCommand(command, args, options = {}) {
  const resolvedCommand = options.resolvedCommand ?? await resolveExecutable(command, options.env);
  return runProcess(command, args, { ...options, resolvedCommand });
}

async function requireGitWorkspace(workspace) {
  const result = await execCommand("git", ["rev-parse", "--show-toplevel"], { cwd: workspace });
  if (result.exitCode !== 0) {
    throw new Error("workspacePath must be inside a git repository.");
  }
  return path.resolve(result.stdout.trim());
}

function sanitizeClaudeArgs(args) {
  if (!Array.isArray(args)) return [];
  const sanitized = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    const flag = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
    if (FORBIDDEN_CLAUDE_ARGS.has(flag) || flag.startsWith("--mcp-")) {
      if (!value.includes("=") && (FORBIDDEN_CLAUDE_ARGS_WITH_VALUE.has(flag) || flag.startsWith("--mcp-")) && index + 1 < args.length) {
        index += 1;
      }
      continue;
    }
    if (!ALLOWED_CLAUDE_ARGS.has(flag)) {
      throw new Error(`claudeArgs contains unsupported option ${flag}. Allowed options: ${[...ALLOWED_CLAUDE_ARGS].join(", ")}.`);
    }
    if (SHELL_META_PATTERN.test(value)) {
      throw new Error(`claudeArgs contains shell metacharacters in ${flag}; refusing unsafe argument.`);
    }
    sanitized.push(value);
    if (!value.includes("=") && index + 1 < args.length) {
      const nextValue = String(args[index + 1]);
      if (SHELL_META_PATTERN.test(nextValue)) {
        throw new Error(`claudeArgs contains shell metacharacters in value for ${flag}; refusing unsafe argument.`);
      }
      validateClaudeArgValue(flag, nextValue);
      sanitized.push(nextValue);
      index += 1;
    } else if (value.includes("=")) {
      validateClaudeArgValue(flag, value.slice(value.indexOf("=") + 1));
    }
  }
  return sanitized;
}

function validateClaudeArgValue(flag, value) {
  if (flag === "--model" && !MODEL_PATTERN.test(value)) {
    throw new Error("--model value contains unsupported characters.");
  }
  if ((flag === "--allowedTools" || flag === "--disallowedTools") && !TOOL_LIST_PATTERN.test(value)) {
    throw new Error(`${flag} must be a comma-separated list of tool identifiers.`);
  }
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
  if (!usage || typeof usage !== "object") return null;
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
  const candidate = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description ?? input.query ?? "";
  return stringifyCompact(candidate).slice(0, 240);
}

function summarizeStreamEvent(event) {
  if (!event || typeof event !== "object") return null;
  event = unwrapStreamEvent(event);
  if (event.delta?.type === "thinking_delta" || event.content_block?.type === "thinking") return null;

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
    return { kind: "tool_use", text: redactSecrets(`Tool: ${toolName ?? "unknown"}${detail ? ` ${detail}` : ""}`) };
  }
  if (event.type === "tool_result" || event.type === "tool_response") {
    const exitCode = event.exitCode ?? event.exit_code ?? event.result?.exitCode ?? event.result?.exit_code;
    return {
      kind: "tool_result",
      text: redactSecrets(`Tool result: ${toolName ?? "unknown"}${exitCode !== undefined ? ` exit ${exitCode}` : ""}`),
    };
  }
  if (event.type === "error" || event.error) {
    return { kind: "error", text: redactSecrets(`Error: ${event.message ?? event.error?.message ?? stringifyCompact(event.error)}`) };
  }
  return null;
}

async function appendTranscriptEvent(task, summary) {
  if (!summary) return;
  const event = { index: task.eventCount, at: nowIso(), ...summary };
  task.eventCount += 1;
  task.lastEventAt = event.at;
  await appendFile(task.transcriptLogPath, `${JSON.stringify(event)}\n`);
}

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

function processExists(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getProcessIdentity(pid) {
  if (!processExists(pid)) return null;
  if (process.platform === "win32") {
    const result = await runProcess("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object -First 1 ProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
    ], { timeout: 5000 });
    if (result.exitCode !== 0 || !result.stdout.trim()) return { pid, available: false };
    try {
      const parsed = JSON.parse(result.stdout);
      return {
        pid,
        processStartTime: parsed.CreationDate ?? null,
        executable: parsed.ExecutablePath ?? null,
        commandLine: parsed.CommandLine ?? null,
        available: true,
      };
    } catch {
      return { pid, available: false };
    }
  }

  const statText = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  if (!statText) return { pid, available: false };
  const afterName = statText.slice(statText.lastIndexOf(")") + 2).trim().split(/\s+/);
  return {
    pid,
    processStartTime: afterName[19] ?? null,
    executable: cmdline.split("\0").filter(Boolean)[0] ?? null,
    commandLine: cmdline.replace(/\0/g, " ").trim() || null,
    available: true,
  };
}

function processIdentityMatches(task, identity) {
  if (!task?.pid || !identity) return false;
  if (identity.available === false) return true;
  if (task.processStartTime && identity.processStartTime && task.processStartTime !== identity.processStartTime) return false;
  if (task.processExecutable && identity.executable) {
    const expected = path.basename(String(task.processExecutable)).toLowerCase();
    const actual = path.basename(String(identity.executable)).toLowerCase();
    if (expected && actual && expected !== actual) return false;
  }
  return true;
}

async function killProcessTree(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return { attempted: false, killed: false, reason: "missing pid" };
  }
  if (!processExists(pid)) {
    return { attempted: false, killed: false, reason: "process not found" };
  }
  if (process.platform === "win32") {
    const result = await runProcess("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 10000 });
    return {
      attempted: true,
      killed: result.exitCode === 0 || !processExists(pid),
      exitCode: result.exitCode,
      stdout: summarizeText(result.stdout, 1000),
      stderr: summarizeText(result.stderr, 1000),
    };
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      return { attempted: true, killed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (processExists(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  return { attempted: true, killed: !processExists(pid) };
}

async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function hashWorkingFiles(workspace, paths, limits = {}) {
  const maxFileBytes = limits.maxFileBytes ?? MAX_HASH_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_HASH_TOTAL_BYTES;
  let totalBytes = 0;
  const hashes = {};
  for (const fileName of paths) {
    const filePath = path.join(workspace, fileName);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        hashes[fileName] = { sha256: null, size: fileStat.size, skippedReason: "not a regular file" };
        continue;
      }
      if (fileStat.size > maxFileBytes) {
        hashes[fileName] = { sha256: null, size: fileStat.size, skippedReason: `file exceeds ${maxFileBytes} bytes` };
        continue;
      }
      if (totalBytes + fileStat.size > maxTotalBytes) {
        hashes[fileName] = { sha256: null, size: fileStat.size, skippedReason: `total hash limit ${maxTotalBytes} bytes exceeded` };
        continue;
      }
      totalBytes += fileStat.size;
      hashes[fileName] = { sha256: await sha256File(filePath), size: fileStat.size };
    } catch {
      hashes[fileName] = { sha256: null, deleted: true };
    }
  }
  return hashes;
}

async function hashGitFiles(workspace, entries) {
  const tracked = entries.filter((entry) => !entry.status.includes("?")).map((entry) => entry.path);
  const details = await hashWorkingFiles(workspace, tracked);
  return Object.fromEntries(Object.entries(details).map(([fileName, detail]) => [fileName, detail.sha256 ?? null]));
}

async function stagedBlobHashes(workspace, stagedChanges) {
  const hashes = {};
  for (const entry of stagedChanges) {
    const result = await execCommand("git", ["ls-files", "-s", "-z", "--", entry.path], { cwd: workspace });
    const record = parsePathList(result.stdout)[0] ?? "";
    const match = record.match(/^(\d+)\s+([0-9a-f]{40,64})\s+(\d)\t(.+)$/i);
    hashes[entry.path] = match
      ? { mode: match[1], blobSha: match[2], stage: match[3], path: entry.path, status: entry.status }
      : { mode: null, blobSha: null, path: entry.path, status: entry.status, deleted: true };
  }
  return hashes;
}

async function gitBaseline(workspace) {
  const [head, branch, porcelain, stagedNames, unstagedNames, untracked] = await Promise.all([
    execCommand("git", ["rev-parse", "HEAD"], { cwd: workspace }),
    execCommand("git", ["branch", "--show-current"], { cwd: workspace }),
    execCommand("git", ["status", "--porcelain=v1", "-z"], { cwd: workspace }),
    execCommand("git", ["diff", "--cached", "--name-status", "-z"], { cwd: workspace }),
    execCommand("git", ["diff", "--name-status", "-z"], { cwd: workspace }),
    execCommand("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: workspace }),
  ]);
  const statusEntries = parsePorcelainZ(porcelain.stdout);
  const stagedChanges = parseNameStatusZ(stagedNames.stdout);
  const untrackedFiles = parsePathList(untracked.stdout);
  return {
    head: head.stdout.trim(),
    branch: branch.stdout.trim(),
    statusEntries,
    stagedChanges,
    unstagedChanges: parseNameStatusZ(unstagedNames.stdout),
    untrackedFiles,
    fileHashes: await hashGitFiles(workspace, statusEntries),
    untrackedFileHashes: await hashWorkingFiles(workspace, untrackedFiles),
    stagedBlobHashes: await stagedBlobHashes(workspace, stagedChanges),
    capturedAt: nowIso(),
  };
}

function pathsOf(entries) {
  return new Set(entries.map((entry) => entry.path));
}

function hashDetailChanged(before, after) {
  if (!before && !after) return false;
  if (!before || !after) return true;
  if (before.skippedReason || after.skippedReason) return before.skippedReason !== after.skippedReason || before.size !== after.size;
  return (before.sha256 ?? null) !== (after.sha256 ?? null) || Boolean(before.deleted) !== Boolean(after.deleted);
}

function classifySnapshot(baseline, current) {
  const baselinePaths = new Set([
    ...baseline.statusEntries.map((entry) => entry.path),
    ...baseline.untrackedFiles,
  ]);
  const currentPaths = new Set([
    ...current.statusEntries.map((entry) => entry.path),
    ...current.untrackedFiles,
  ]);
  const currentByPath = new Map(current.statusEntries.map((entry) => [entry.path, entry]));
  const preExistingChanges = [...baselinePaths].filter((filePath) => currentPaths.has(filePath));
  const changesCreatedAfterPreflight = [...currentPaths].filter((filePath) => !baselinePaths.has(filePath));
  const modifiedPreExistingChanges = current.statusEntries.filter((entry) => {
    if (!baseline.fileHashes || !(entry.path in baseline.fileHashes)) return false;
    if (!current.fileHashes || !(entry.path in current.fileHashes)) return false;
    return baseline.fileHashes[entry.path] !== current.fileHashes[entry.path];
  });
  const preExistingUntrackedFiles = baseline.untrackedFiles ?? [];
  const modifiedPreExistingUntrackedFiles = preExistingUntrackedFiles
    .filter((filePath) => hashDetailChanged(baseline.untrackedFileHashes?.[filePath], current.untrackedFileHashes?.[filePath]))
    .map((filePath) => ({
      path: filePath,
      baseline: baseline.untrackedFileHashes?.[filePath] ?? null,
      current: current.untrackedFileHashes?.[filePath] ?? null,
    }));
  const preExistingStagedChanges = baseline.stagedChanges ?? [];
  const modifiedPreExistingStagedChanges = preExistingStagedChanges
    .filter((entry) => {
      const baselineBlob = baseline.stagedBlobHashes?.[entry.path] ?? null;
      const currentBlob = current.stagedBlobHashes?.[entry.path] ?? null;
      const indexChanged = JSON.stringify(baselineBlob) !== JSON.stringify(currentBlob);
      const worktreeChanged = current.unstagedChanges?.some((unstaged) => unstaged.path === entry.path);
      return indexChanged || worktreeChanged;
    })
    .map((entry) => ({
      ...entry,
      baseline: baseline.stagedBlobHashes?.[entry.path] ?? null,
      current: current.stagedBlobHashes?.[entry.path] ?? null,
      hasUnstagedChanges: current.unstagedChanges?.some((unstaged) => unstaged.path === entry.path) ?? false,
    }));
  const renamedFiles = current.statusEntries.filter((entry) => entry.originalPath);
  return {
    preExistingChanges,
    changesCreatedAfterPreflight,
    modifiedPreExistingChanges,
    preExistingUntrackedFiles,
    modifiedPreExistingUntrackedFiles,
    preExistingStagedChanges,
    modifiedPreExistingStagedChanges,
    currentByPath: [...currentByPath.values()],
    renamedFiles,
  };
}

async function detectClaudeCapabilities(workspace, claudePath, env) {
  const help = await execCommand("claude", ["--help"], { cwd: workspace, env, resolvedCommand: claudePath, timeout: 10000 });
  const text = `${help.stdout}\n${help.stderr}`;
  return {
    helpAvailable: help.exitCode === 0,
    helpTextExcerpt: summarizeText(text, 2000),
    supportsSessionId: /--session-id\b/.test(text),
    supportsResume: /--resume\b/.test(text),
    supportsShortResume: /(^|\s)-r[,=\s]/.test(text) || /\[-r/.test(text),
    resumeMode: /--resume\b/.test(text) ? "resume" : "session-id",
  };
}

function migrateRun(run) {
  const migrated = { ...run };
  migrated.status ??= "ready";
  migrated.currentIteration ??= 0;
  migrated.completedIterations ??= [];
  migrated.activeTaskId ??= null;
  migrated.reviews ??= [];
  migrated.defaultMaxIterations ??= DEFAULT_MAX_ITERATIONS;
  migrated.maxIterations = Number.isInteger(migrated.maxIterations) && migrated.maxIterations > 0
    ? migrated.maxIterations
    : DEFAULT_MAX_ITERATIONS;
  migrated.sessionStartMode ??= "session-id";
  migrated.sessionResumeMode ??= migrated.claudeCapabilities?.resumeMode ?? "session-id";
  migrated.version ??= "0.2.0";
  return migrated;
}

async function readRun(runId) {
  const runDir = runPath(runId);
  const payload = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  const migrated = migrateRun({ ...payload, runDir });
  if (payload.version !== migrated.version || payload.status === undefined || payload.currentIteration === undefined) {
    await writeRun(migrated);
  }
  return migrated;
}

async function writeRun(run) {
  await mkdir(run.runDir, { recursive: true });
  await atomicWriteJson(path.join(run.runDir, "run.json"), run);
}

async function updateRun(run) {
  await writeRun(migrateRun(run));
}

async function readTask(taskId) {
  const filePath = taskPath(taskId);
  const payload = JSON.parse(await readFile(filePath, "utf8"));
  return { ...payload, taskPath: filePath };
}

async function writeTask(task) {
  await atomicWriteJson(taskPath(task.taskId), task);
}

async function updateRunForTask(task, terminalStatus) {
  await withQueue(runQueues, task.runId, async () => {
    const run = await readRun(task.runId);
    if (terminalStatus === "completed") run.status = "awaiting_review";
    if (terminalStatus === "failed") run.status = "failed";
    if (terminalStatus === "timed_out") run.status = "timed_out";
    if (terminalStatus === "cancelled") run.status = "cancelled";
    if (!run.completedIterations.includes(task.iteration)) {
      run.completedIterations.push(task.iteration);
      run.completedIterations.sort((a, b) => a - b);
    }
    if (run.activeTaskId === task.taskId) run.activeTaskId = null;
    run.lastTaskId = task.taskId;
    run.updatedAt = nowIso();
    await updateRun(run);
  });
}

async function finalizeAsyncTask(task, status, details = {}) {
  const latest = await readTask(task.taskId).catch(() => task);
  if (TERMINAL_TASK_STATES.has(latest.status)) return latest;
  const finalTask = { ...latest, ...task };
  finalTask.status = status;
  finalTask.finishedAt = nowIso();
  finalTask.exitCode = details.exitCode ?? finalTask.exitCode ?? null;
  finalTask.timedOut = status === "timed_out";
  finalTask.cancelReason = details.cancelReason ?? finalTask.cancelReason;
  finalTask.killResult = details.killResult ?? finalTask.killResult;
  finalTask.stderr = redactSecrets(details.stderr ?? finalTask.stderr ?? "");
  finalTask.lastEventAt = finalTask.lastEventAt ?? finalTask.finishedAt;
  await writeTask(finalTask);
  const event = {
    runId: finalTask.runId,
    taskId: finalTask.taskId,
    iteration: finalTask.iteration,
    startedAt: finalTask.startedAt,
    finishedAt: finalTask.finishedAt,
    command: "claude",
    claudeSessionId: finalTask.claudeSessionId,
    sessionInvocationMode: finalTask.sessionInvocationMode,
    args: finalTask.args,
    pid: finalTask.pid,
    processStartTime: finalTask.processStartTime ?? null,
    processExecutable: finalTask.processExecutable ?? null,
    exitCode: finalTask.exitCode,
    timedOut: finalTask.timedOut,
    cancelReason: finalTask.cancelReason ?? null,
    killResult: finalTask.killResult ?? null,
    stdout: "",
    stderr: finalTask.stderr,
    parsedJson: null,
    streamLogPath: finalTask.streamLogPath,
    transcriptLogPath: finalTask.transcriptLogPath,
  };
  await atomicWriteJson(finalTask.finalLogPath, event);
  await updateRunForTask(finalTask, status);
  activeChildren.delete(finalTask.taskId);
  return finalTask;
}

function handleStreamChunk(bufferState, chunk) {
  bufferState.value += chunk.toString("utf8");
  const lines = bufferState.value.split(/\r?\n/);
  bufferState.value = lines.pop() ?? "";
  return lines.filter((line) => line.trim().length > 0);
}

async function ensureClaudeSession(run) {
  if (typeof run.claudeSessionId === "string" && run.claudeSessionId.trim() !== "") return run.claudeSessionId;
  run.claudeSessionId = createClaudeSessionId();
  await writeRun(run);
  return run.claudeSessionId;
}

function claudeSessionArgs(run, iteration) {
  if (iteration <= 1 || run.sessionResumeMode !== "resume") {
    return { mode: "session-id", args: ["--session-id", run.claudeSessionId] };
  }
  return { mode: "resume", args: ["--resume", run.claudeSessionId] };
}

async function assertCanStart(run, iteration) {
  if (FINAL_RUN_STATES.has(run.status)) {
    throw new Error(`run ${run.runId} is ${run.status} and cannot start another Claude iteration.`);
  }
  if (run.activeTaskId) {
    throw new Error(`run ${run.runId} already has running task ${run.activeTaskId}.`);
  }
  if (iteration > run.maxIterations) {
    throw new Error(`iteration ${iteration} exceeds maxIterations ${run.maxIterations}.`);
  }
  if (iteration !== run.currentIteration + 1) {
    throw new Error(`iteration must be ${run.currentIteration + 1}; refusing to skip, repeat, or overwrite logs.`);
  }
  if (iteration === 1 && !["ready", "failed", "timed_out"].includes(run.status)) {
    throw new Error(`first iteration requires run status ready; current status is ${run.status}.`);
  }
  if (iteration > 1 && run.status !== "needs_fix") {
    throw new Error(`iteration ${iteration} can start only after a needs_fix review; current status is ${run.status}.`);
  }
  const finalLog = path.join(run.runDir, `iteration-${iteration}.json`);
  if (await exists(finalLog)) {
    throw new Error(`iteration ${iteration} log already exists; refusing to overwrite.`);
  }
}

export function redactSecrets(text) {
  if (typeof text !== "string" || text.length === 0) return "";
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

  const hasPyproject = await exists(path.join(workspace, "pyproject.toml"));
  const hasPytestIni = await exists(path.join(workspace, "pytest.ini"));
  if (await exists(path.join(workspace, "uv.lock"))) commands.push("uv run pytest");
  else if (await exists(path.join(workspace, "poetry.lock"))) commands.push("poetry run pytest");
  else if (hasPytestIni || hasPyproject) commands.push("python -m pytest");

  if (await exists(path.join(workspace, "build.gradle")) || await exists(path.join(workspace, "build.gradle.kts"))) {
    commands.push(process.platform === "win32" && await exists(path.join(workspace, "gradlew.bat")) ? ".\\gradlew.bat test" : "./gradlew test");
  }
  if (await exists(path.join(workspace, "pom.xml"))) commands.push("mvn test");
  if (await exists(path.join(workspace, "Cargo.toml"))) commands.push("cargo test");
  if (await exists(path.join(workspace, "go.mod"))) commands.push("go test ./...");
  const entries = await readdir(workspace).catch(() => []);
  if (entries.some((entry) => entry.endsWith(".csproj") || entry.endsWith(".sln"))) commands.push("dotnet test");

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
  const claudePath = await resolveExecutable("claude", env);
  const claudeVersion = await execCommand("claude", ["--version"], { cwd: gitRoot, env, resolvedCommand: claudePath, timeout: 10000 });
  if (claudeVersion.exitCode !== 0) {
    throw new Error("Claude Code CLI was not found or could not be executed from PATH.");
  }
  const claudeCapabilities = await detectClaudeCapabilities(gitRoot, claudePath, env);
  const baseline = await gitBaseline(gitRoot);
  const runId = createRunId();
  const runDir = path.join(runsRoot(), runId);
  const commands = await detectVerificationCommands(gitRoot, verificationCommands);
  const sessionId = createClaudeSessionId();
  const run = migrateRun({
    runId,
    runDir,
    version: "0.2.0",
    status: "ready",
    workspacePath: gitRoot,
    claudeExecutable: claudePath,
    claudeSessionId: sessionId,
    sessionStartMode: "session-id",
    sessionResumeMode: claudeCapabilities.resumeMode,
    claudeCapabilities,
    task: String(task ?? ""),
    maxIterations: Number.isInteger(maxIterations) && maxIterations > 0 ? maxIterations : DEFAULT_MAX_ITERATIONS,
    defaultMaxIterations: DEFAULT_MAX_ITERATIONS,
    currentIteration: 0,
    completedIterations: [],
    activeTaskId: null,
    verificationCommands: commands,
    gitBaseline: baseline,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  await writeRun(run);

  return {
    runId,
    runDir,
    status: run.status,
    workspacePath: gitRoot,
    task: run.task,
    maxIterations: run.maxIterations,
    defaultMaxIterations: DEFAULT_MAX_ITERATIONS,
    verificationCommands: commands,
    claude: {
      available: true,
      executable: claudePath,
      version: claudeVersion.stdout.trim() || claudeVersion.stderr.trim(),
      sessionId,
      capabilities: claudeCapabilities,
    },
    git: {
      root: gitRoot,
      dirty: baseline.statusEntries.length > 0,
      statusEntries: baseline.statusEntries,
      status: baseline.statusEntries.map((entry) => `${entry.status} ${entry.path}`).join("\n"),
      baseline,
    },
  };
}

export async function preparePlanHandoff({ runId, planText, task, verificationCommands } = {}) {
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
    "Target Repository:",
    run.workspacePath,
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

  await atomicWriteText(handoffPath, handoffPrompt);
  const event = { index: handoffIndex, handoffPath, task: taskText, verificationCommands: commands, createdAt: nowIso() };
  run.planHandoffs = handoffs.concat(event);
  run.updatedAt = nowIso();
  await updateRun(run);
  return { runId, handoffIndex, handoffPath, handoffPrompt, verificationCommands: commands };
}

export async function runClaudeIteration({ runId, prompt, iteration, timeoutSec = 900, claudeArgs = [], env = process.env } = {}) {
  const run = await readRun(runId);
  if (!Number.isInteger(iteration) || iteration < 1) throw new Error("iteration must be a positive integer.");
  if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("prompt must be a non-empty string.");
  await ensureClaudeSession(run);
  const sanitizedArgs = sanitizeClaudeArgs(claudeArgs);
  const session = claudeSessionArgs(run, iteration);
  const args = ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", ...session.args, ...sanitizedArgs];
  const startedAt = nowIso();
  const result = await execCommand("claude", args, {
    cwd: run.workspacePath,
    env,
    resolvedCommand: run.claudeExecutable,
    input: prompt,
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
    finishedAt: nowIso(),
    command: "claude",
    claudeSessionId: run.claudeSessionId,
    sessionInvocationMode: session.mode,
    args: args.concat("[PROMPT_ON_STDIN_REDACTED]"),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: sanitizedStdout,
    stderr: sanitizedStderr,
    parsedJson,
  };
  await atomicWriteJson(logPath, event);
  return { ...event, logPath };
}

export async function startClaudeIteration({ runId, prompt, iteration, timeoutSec = 900, claudeArgs = [], env = process.env } = {}) {
  return await withQueue(runQueues, runId, async () => {
    const run = await readRun(runId);
    if (!Number.isInteger(iteration) || iteration < 1) throw new Error("iteration must be a positive integer.");
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("prompt must be a non-empty string.");
    await assertCanStart(run, iteration);

    await ensureClaudeSession(run);
    const session = claudeSessionArgs(run, iteration);
    const sanitizedArgs = sanitizeClaudeArgs(claudeArgs);
    const taskId = createTaskId();
    const streamLogPath = path.join(run.runDir, `iteration-${iteration}.stream.jsonl`);
    const transcriptLogPath = path.join(run.runDir, `iteration-${iteration}.transcript.jsonl`);
    const finalLogPath = path.join(run.runDir, `iteration-${iteration}.json`);
    await atomicWriteText(streamLogPath, "");
    await atomicWriteText(transcriptLogPath, "");

    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--strict-mcp-config",
      "--permission-mode",
      "acceptEdits",
      ...session.args,
      ...sanitizedArgs,
    ];
    const task = {
      taskId,
      runId,
      iteration,
      status: "running",
      workspacePath: run.workspacePath,
      claudeSessionId: run.claudeSessionId,
      sessionInvocationMode: session.mode,
      startedAt: nowIso(),
      finishedAt: null,
      timeoutSec: Math.max(1, Number(timeoutSec)),
      streamLogPath,
      transcriptLogPath,
      finalLogPath,
      eventCount: 0,
      exitCode: null,
      timedOut: false,
      stderr: "",
      args: args.concat("[PROMPT_ON_STDIN_REDACTED]"),
      pid: null,
      heartbeatAt: nowIso(),
      lastEventAt: null,
    };

    const commandPath = run.claudeExecutable ?? await resolveExecutable("claude", env);
    const isCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(commandPath);
    const child = spawn(commandPath, args, {
      cwd: run.workspacePath,
      env,
      windowsHide: true,
      shell: isCmd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    task.pid = child.pid ?? null;
    task.processIdentity = task.pid ? await getProcessIdentity(task.pid) : null;
    task.processExecutable = task.processIdentity?.executable ?? commandPath;
    task.claudeExecutable = commandPath;
    task.processStartTime = task.processIdentity?.processStartTime ?? null;
    await writeTask(task);
    run.status = "running";
    run.activeTaskId = taskId;
    run.currentIteration = iteration;
    run.updatedAt = nowIso();
    await updateRun(run);
    child.stdin.end(prompt);

    const stdoutBuffer = { value: "" };
    const stderrBuffer = { value: "" };
    let finalized = false;
    let finalPromise = null;
    const pendingWrites = [];
    const enqueue = (work) => {
      const promise = withQueue(taskQueues, taskId, async () => {
        try {
          await work();
        } catch (error) {
          task.stderr += `\n[AI Bridge callback error] ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
        }
      });
      pendingWrites.push(promise);
    };
    const finalize = (status, details = {}) => {
      if (finalPromise) return finalPromise;
      finalized = true;
      const writesToWaitFor = pendingWrites.slice();
      finalPromise = withQueue(taskQueues, taskId, async () => {
        await Promise.allSettled(writesToWaitFor);
        return await finalizeAsyncTask(task, status, details);
      });
      pendingWrites.push(finalPromise);
      return finalPromise;
    };
    activeChildren.set(taskId, { child, task, finalize });
    const timeout = setTimeout(() => {
      const finalPromiseForTimeout = finalize("timed_out", {
        exitCode: 1,
        stderr: task.stderr,
        killResult: { attempted: true, pending: true },
      });
      void killProcessTree(task.pid).then(async (killResult) => {
        await finalPromiseForTimeout;
        const finalTask = await readTask(taskId);
        if (finalTask.status === "timed_out") {
          finalTask.killResult = killResult;
          await writeTask(finalTask);
          const finalLog = JSON.parse(await readFile(finalTask.finalLogPath, "utf8").catch(() => "{}"));
          await atomicWriteJson(finalTask.finalLogPath, { ...finalLog, killResult });
        }
      });
    }, task.timeoutSec * 1000);

    child.stdout.on("data", (chunk) => {
      if (finalized) return;
      enqueue(async () => {
        task.heartbeatAt = nowIso();
        for (const line of handleStreamChunk(stdoutBuffer, chunk)) {
          const sanitized = redactSecrets(line);
          await appendFile(streamLogPath, `${sanitized}\n`);
          await appendTranscriptEvent(task, summarizeStreamEvent(parseStreamJsonLine(sanitized)));
        }
        await writeTask(task);
      });
    });
    child.stderr.on("data", (chunk) => {
      if (finalized) return;
      enqueue(async () => {
        task.heartbeatAt = nowIso();
        for (const line of handleStreamChunk(stderrBuffer, chunk)) {
          task.stderr += `${redactSecrets(line)}\n`;
        }
        await writeTask(task);
      });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      finalize("failed", { exitCode: 1, stderr: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (!finalized) {
        enqueue(async () => {
          for (const line of handleStreamChunk(stdoutBuffer, "\n")) {
            const sanitized = redactSecrets(line);
            await appendFile(streamLogPath, `${sanitized}\n`);
            await appendTranscriptEvent(task, summarizeStreamEvent(parseStreamJsonLine(sanitized)));
          }
          for (const line of handleStreamChunk(stderrBuffer, "\n")) {
            task.stderr += `${redactSecrets(line)}\n`;
          }
        });
      }
      const status = finalized ? task.status : code === 0 ? "completed" : "failed";
      finalize(status, { exitCode: code ?? 1, stderr: task.stderr });
    });

    return { taskId, runId, iteration, status: "running", claudeSessionId: run.claudeSessionId, sessionInvocationMode: session.mode, pid: task.pid, streamLogPath, transcriptLogPath, finalLogPath, startedAt: task.startedAt };
  });
}

export async function cancelClaudeIteration({ taskId } = {}) {
  const task = await readTask(taskId);
  if (TERMINAL_TASK_STATES.has(task.status)) {
    return { taskId, runId: task.runId, status: task.status, cancelled: false };
  }
  const runtime = activeChildren.get(taskId);
  const details = {
    exitCode: 1,
    stderr: `${task.stderr ?? ""}\nCancelled by AI Bridge.`,
    cancelReason: "Cancelled by AI Bridge.",
    killResult: runtime ? { attempted: true, pending: true } : null,
  };
  let finalPromise = null;
  if (runtime?.finalize) {
    finalPromise = runtime.finalize("cancelled", details);
  }
  const identity = task.pid ? await getProcessIdentity(task.pid) : null;
  const identityMatches = task.pid ? processIdentityMatches(task, identity) : false;
  const killResult = runtime?.child
    ? await killProcessTree(runtime.child.pid ?? task.pid)
    : identityMatches
      ? await killProcessTree(task.pid)
      : { attempted: false, killed: false, reason: task.pid ? "process identity mismatch or unavailable" : "missing pid" };
  if (finalPromise) {
    await finalPromise;
    const finalTask = await readTask(taskId);
    finalTask.killResult = killResult;
    await writeTask(finalTask);
    const finalLog = JSON.parse(await readFile(finalTask.finalLogPath, "utf8").catch(() => "{}"));
    await atomicWriteJson(finalTask.finalLogPath, { ...finalLog, killResult });
  } else {
    await finalizeAsyncTask(task, "cancelled", { ...details, killResult });
  }
  const current = await readTask(taskId);
  return { taskId, runId: current.runId, status: current.status, cancelled: current.status === "cancelled", killResult };
}

export async function pollClaudeIteration({ taskId, cursor = 0 } = {}) {
  const task = await readTask(taskId);
  const runningAgeMs = Date.now() - Date.parse(task.startedAt ?? nowIso());
  if (task.status === "running" && task.pid && runningAgeMs > 3000 && !activeChildren.has(taskId)) {
    const identity = await getProcessIdentity(task.pid);
    if (!identity || !processIdentityMatches(task, identity)) {
      await finalizeAsyncTask(task, "failed", {
        exitCode: 1,
        stderr: `${task.stderr ?? ""}\nAI Bridge detected an orphaned running task after MCP restart; pid ${task.pid} is missing or no longer matches the recorded Claude process.`,
      });
    }
  }
  const currentTask = await readTask(taskId);
  const transcriptText = (await readFile(task.transcriptLogPath, "utf8").catch(() => "")).trim();
  const allEvents = [];
  const corruptLines = [];
  if (transcriptText) {
    transcriptText.split(/\r?\n/).filter(Boolean).forEach((line, lineIndex) => {
      try {
        allEvents.push(JSON.parse(line));
      } catch (error) {
        corruptLines.push({ line: lineIndex + 1, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
  const numericCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  const events = allEvents.filter((event) => event.index >= numericCursor);
  return {
    taskId,
    runId: currentTask.runId,
    iteration: currentTask.iteration,
    status: currentTask.status,
    cursor: numericCursor,
    nextCursor: allEvents.length,
    events,
    corruptTranscriptLines: corruptLines,
    exitCode: currentTask.exitCode,
    timedOut: Boolean(currentTask.timedOut),
    pid: currentTask.pid,
    heartbeatAt: currentTask.heartbeatAt,
    lastEventAt: currentTask.lastEventAt,
    streamLogPath: currentTask.streamLogPath,
    transcriptLogPath: currentTask.transcriptLogPath,
    finalLogPath: currentTask.finalLogPath,
  };
}

export async function recoverRunningTasks() {
  const recovered = [];
  const diagnostics = [];
  const root = tasksRoot();
  const entries = await readdir(root).catch(() => []);
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    try {
      const taskId = entry.slice(0, -".json".length);
      if (!TASK_ID_PATTERN.test(taskId)) continue;
      const task = await readTask(taskId);
      if (task.status !== "running") continue;
      const identity = task.pid ? await getProcessIdentity(task.pid) : null;
      if (!task.pid || !identity || !processIdentityMatches(task, identity)) {
        await finalizeAsyncTask(task, "failed", {
          exitCode: 1,
          stderr: `${task.stderr ?? ""}\nAI Bridge server restarted and marked this running task failed/orphaned because its recorded process was not found or did not match.`,
        });
        recovered.push({ taskId, runId: task.runId, status: "failed", action: "marked_orphaned" });
      } else {
        recovered.push({ taskId, runId: task.runId, status: "running", action: "left_running", pid: task.pid });
      }
    } catch (error) {
      diagnostics.push({ taskFile: entry, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { recovered, diagnostics };
}

export async function getClaudeTranscript({ taskId } = {}) {
  const task = await readTask(taskId);
  const polled = await pollClaudeIteration({ taskId, cursor: 0 });
  return { taskId, runId: task.runId, iteration: task.iteration, status: task.status, events: polled.events, corruptTranscriptLines: polled.corruptTranscriptLines, streamLogPath: task.streamLogPath, transcriptLogPath: task.transcriptLogPath, finalLogPath: task.finalLogPath };
}

async function readStreamUsage(streamPath) {
  const text = await readFile(streamPath, "utf8").catch(() => "");
  const usage = zeroUsage();
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = parseStreamJsonLine(line);
    const unwrapped = unwrapStreamEvent(event);
    const usageEvent = extractUsage(event);
    if (!usageEvent) continue;
    const key = unwrapped?.message?.id ?? unwrapped?.id ?? `${unwrapped?.type ?? "unknown"}:${JSON.stringify(usageEvent)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    addUsage(usage, usageEvent);
  }
  return usage;
}

function validatePriceBook(name, price) {
  const required = ["inputPerMillion", "outputPerMillion", "cacheCreationInputPerMillion", "cacheReadInputPerMillion"];
  if (!price || typeof price !== "object") throw new Error(`${name} pricing must be an object.`);
  for (const key of required) {
    const value = Number(price[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name}.${key} must be a non-negative finite number.`);
  }
}

function roundMoney(value) {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function calculateCost(usage, price) {
  validatePriceBook("pricing", price);
  const input = usage.inputTokens / 1_000_000 * Number(price.inputPerMillion);
  const output = usage.outputTokens / 1_000_000 * Number(price.outputPerMillion);
  const cacheCreation = usage.cacheCreationInputTokens / 1_000_000 * Number(price.cacheCreationInputPerMillion);
  const cacheRead = usage.cacheReadInputTokens / 1_000_000 * Number(price.cacheReadInputPerMillion);
  return { input: roundMoney(input), output: roundMoney(output), cacheCreation: roundMoney(cacheCreation), cacheRead: roundMoney(cacheRead), total: roundMoney(input + output + cacheCreation + cacheRead) };
}

export async function summarizeCosts({ runId, pricing } = {}) {
  const run = await readRun(runId);
  const entries = await readdir(run.runDir).catch(() => []);
  const usage = zeroUsage();
  for (const entry of entries.filter((name) => /^iteration-\d+\.stream\.jsonl$/.test(name)).sort()) {
    addUsage(usage, await readStreamUsage(path.join(run.runDir, entry)));
  }
  const cacheDenominator = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  const cacheHitRate = cacheDenominator > 0 ? Math.round((usage.cacheReadInputTokens / cacheDenominator) * 1_000_000) / 1_000_000 : null;

  let sameTokenHypotheticalEstimate = null;
  if (pricing) {
    validatePriceBook("pricing.deepseek", pricing.deepseek);
    validatePriceBook("pricing.codex", pricing.codex);
    const deepseek = calculateCost(usage, pricing.deepseek);
    const codex = calculateCost(usage, pricing.codex);
    const difference = roundMoney(codex.total - deepseek.total);
    sameTokenHypotheticalEstimate = {
      deepseek,
      codex,
      difference,
      ratio: codex.total > 0 ? Math.round((difference / codex.total) * 1_000_000) / 1_000_000 : null,
      note: "Same-token hypothetical estimate only. This is not actual savings and does not represent real Codex billing.",
      pricingSource: pricing.source ?? "user-supplied",
    };
  }

  return { runId, usage, cacheHitRate, sameTokenHypotheticalEstimate, costs: sameTokenHypotheticalEstimate };
}

export async function snapshotChanges({ runId } = {}) {
  const run = await readRun(runId);
  const current = await gitBaseline(run.workspacePath);
  const classified = classifySnapshot(run.gitBaseline ?? { statusEntries: [], untrackedFiles: [], fileHashes: {} }, current);
  const baselineInvalidated = (run.gitBaseline?.head && run.gitBaseline.head !== current.head) || (run.gitBaseline?.branch !== current.branch);
  const [diffStat, nameStatus, cachedNameStatus] = await Promise.all([
    execCommand("git", ["diff", "--stat"], { cwd: run.workspacePath }),
    execCommand("git", ["diff", "--name-status", "-z"], { cwd: run.workspacePath }),
    execCommand("git", ["diff", "--cached", "--name-status", "-z"], { cwd: run.workspacePath }),
  ]);
  const payload = {
    runId,
    workspacePath: run.workspacePath,
    hasChanges: current.statusEntries.length > 0,
    baselineInvalidated,
    baseline: run.gitBaseline,
    current,
    preExistingChanges: classified.preExistingChanges,
    changesCreatedAfterPreflight: classified.changesCreatedAfterPreflight,
    modifiedPreExistingChanges: classified.modifiedPreExistingChanges,
    preExistingUntrackedFiles: classified.preExistingUntrackedFiles,
    modifiedPreExistingUntrackedFiles: classified.modifiedPreExistingUntrackedFiles,
    preExistingStagedChanges: classified.preExistingStagedChanges,
    modifiedPreExistingStagedChanges: classified.modifiedPreExistingStagedChanges,
    stagedChanges: parseNameStatusZ(cachedNameStatus.stdout),
    unstagedChanges: parseNameStatusZ(nameStatus.stdout),
    untrackedFiles: current.untrackedFiles,
    renamedFiles: classified.renamedFiles,
    gitStatus: current.statusEntries.map((entry) => `${entry.status} ${entry.path}`).join("\n"),
    diffStat: diffStat.stdout,
    changedFiles: current.statusEntries,
    logDir: run.runDir,
  };
  await atomicWriteJson(path.join(run.runDir, "snapshot.json"), payload);
  return payload;
}

export async function runVerificationCommands({ runId, commands, timeoutSec = 300, env = process.env } = {}) {
  const run = await readRun(runId);
  const selected = Array.isArray(commands) && commands.length > 0 ? commands : run.verificationCommands;
  const results = [];
  for (const commandLine of selected) {
    const startedAt = nowIso();
    const result = await runProcess(process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "sh",
      process.platform === "win32" ? ["/d", "/s", "/c", String(commandLine)] : ["-lc", String(commandLine)],
      { cwd: run.workspacePath, env, timeout: Math.max(1, Number(timeoutSec)) * 1000 });
    results.push({ command: String(commandLine), cwd: run.workspacePath, startedAt, finishedAt: nowIso(), exitCode: result.exitCode, timedOut: result.timedOut, stdout: summarizeText(result.stdout), stderr: summarizeText(result.stderr) });
  }
  const logPath = path.join(run.runDir, "verification.jsonl");
  for (const item of results) await appendFile(logPath, `${JSON.stringify(item)}\n`);
  return { runId, verificationLogPath: logPath, results };
}

export async function recordReview({ runId, iteration, outcome, findings = [], verificationCommandsRun = [] } = {}) {
  const run = await readRun(runId);
  if (!["pass", "needs_fix", "blocked"].includes(outcome)) throw new Error("outcome must be pass, needs_fix, or blocked.");
  if (!Number.isInteger(iteration) || !run.completedIterations.includes(iteration)) {
    throw new Error(`Cannot record review for iteration ${iteration}; that iteration has not completed.`);
  }
  if (run.status !== "awaiting_review" && !["failed", "timed_out"].includes(run.status)) {
    throw new Error(`Cannot record review while run status is ${run.status}.`);
  }
  const event = { runId, iteration, outcome, findings, verificationCommandsRun, recordedAt: nowIso() };
  const reviewLogPath = path.join(run.runDir, "reviews.jsonl");
  await appendFile(reviewLogPath, `${JSON.stringify(event)}\n`);
  run.reviews = [...(run.reviews ?? []), event];
  run.status = outcome === "pass" ? "passed" : outcome === "needs_fix" ? "needs_fix" : "blocked";
  run.updatedAt = nowIso();
  await updateRun(run);
  return { status: "recorded", runId, runStatus: run.status, reviewLogPath, nextIterationAllowed: outcome === "needs_fix" };
}

export const __testing = {
  queueSizes() {
    return { taskQueues: taskQueues.size, runQueues: runQueues.size, activeChildren: activeChildren.size };
  },
  async runQueuedWork(kind, key, shouldThrow = false) {
    return await withQueue(kind === "task" ? taskQueues : runQueues, key, async () => {
      if (shouldThrow) throw new Error("queued failure");
      return "ok";
    });
  },
  clearActiveChildren() {
    activeChildren.clear();
  },
  async processExists(pid) {
    return processExists(pid);
  },
};
