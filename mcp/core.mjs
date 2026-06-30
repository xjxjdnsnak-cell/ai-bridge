import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_ITERATIONS = 3;
export const APP_VERSION = "0.5.2";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(repoRoot, "mcp", "worker.mjs");

const RUN_ID_PATTERN = /^run-\d{14}-[a-z0-9]{6}$/;
const TASK_ID_PATTERN = /^task-\d{14}-[a-z0-9]{6}$/;
const FINAL_RUN_STATES = new Set(["passed", "blocked", "cancelled"]);
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "timed_out", "cancelled", "cancel_failed", "orphaned_identity_mismatch", "orphaned_unverifiable"]);
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
  /sk-[A-Za-z0-9_-]{10,}/gi,
  /((?:OPENAI_API_KEY|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|api[_-]?key)["'\s:=]+)[^\s"',;]{8,}/gi,
  /((?:access[_-]?token|auth[_-]?token|token|secret|password)["'\s:=]+)[^\s"',;]{4,}/gi,
  /((?:authorization["'\s:=]+)?bearer\s+)[A-Za-z0-9._\-]{8,}/gi,
  /(authorization["'\s:=]+(?:basic\s+)?)[A-Za-z0-9+/._\-]{8,}={0,2}/gi,
  /((?:private[_\s-]?key)["'\s:=]+)[^\r\n]{8,}/gi,
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
];

const taskQueues = new Map();
const runQueues = new Map();
const activeChildren = new Map();
const activeStartReservations = new Set();
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 1_000;

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

async function getCurrentProcessIdentity() {
  try {
    return await waitForProcessIdentity(process.pid);
  } catch {
    return { pid: process.pid, available: false };
  }
}

async function waitForProcessIdentity(pid, attempts = 20, delayMs = 50) {
  let latest = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await getProcessIdentity(pid);
    if (!latest) return null;
    if (latest.available !== false && (latest.processStartTime || latest.executable || latest.commandLine)) return latest;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return latest;
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

function workspacesRoot() {
  return path.join(bridgeRoot(), "workspaces");
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

function lockPathFor(filePath) {
  return `${filePath}.lock`;
}

async function rmWithRetry(targetPath, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(targetPath, options);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES", "ENOENT"].includes(error?.code)) throw error;
      if (error?.code === "ENOENT") return;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function readLockOwner(lockPath) {
  const text = await readFile(lockPath, "utf8").catch(() => null);
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function isLockOwnerStale(lockPath, owner, staleMs) {
  if (!owner) {
    const lockStat = await stat(lockPath).catch(() => null);
    return Boolean(lockStat && Date.now() - lockStat.mtimeMs > staleMs);
  }
  const acquiredAt = Date.parse(owner.acquiredAt ?? "");
  const heartbeatAt = Date.parse(owner.heartbeatAt ?? owner.acquiredAt ?? "");
  if (!Number.isFinite(acquiredAt) || !Number.isFinite(heartbeatAt)) return false;
  const pid = Number(owner.pid);
  const oldEnough = Date.now() - acquiredAt > staleMs;
  const pidGone = Number.isInteger(pid) && pid > 0 && !processExists(pid);
  return oldEnough && pidGone;
}

async function readFenceEpoch(filePath) {
  const text = await readFile(filePath, "utf8").catch(() => "");
  if (!text.trim()) return 0;
  try {
    const parsed = JSON.parse(text);
    return Number.isInteger(parsed.fenceEpoch) && parsed.fenceEpoch >= 0 ? parsed.fenceEpoch : 0;
  } catch {
    return 0;
  }
}

async function assertFence(filePath, lease) {
  const owner = await readLockOwner(lockPathFor(filePath));
  if (owner?.lockId !== lease?.lockId || owner?.fenceEpoch !== lease?.fenceEpoch) {
    throw new Error(`AI Bridge state fence lost for ${filePath}`);
  }
}

async function writeJsonWithFence(filePath, value, lease) {
  await assertFence(filePath, lease);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomToken()}.tmp`;
  const data = { ...value, fenceEpoch: lease.fenceEpoch };
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`);
  // Re-check before rename. This rejects stale owners before their next write,
  // but does not claim a formal CAS guarantee against external lock deletion.
  const toctouDelayMs = Number(process.env.AI_BRIDGE_TEST_TOCTOU_DELAY_MS);
  if (toctouDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, toctouDelayMs));
  await assertFence(filePath, lease);
  await renameWithRetry(tempPath, filePath);
  // Post-rename verification detects if a higher-epoch writer overwrote us.
  const written = JSON.parse(await readFile(filePath, "utf8"));
  if (written.fenceEpoch !== lease.fenceEpoch) {
    throw new Error(`AI Bridge state fence lost for ${filePath}`);
  }
}

async function withFileLock(filePath, fn, { timeoutMs = 10_000, staleMs = LOCK_STALE_MS } = {}) {
  const lockPath = lockPathFor(filePath);
  const started = Date.now();
  let attempt = 0;
  while (true) {
    const lockId = randomUUID();
    let handle = null;
    let heartbeatTimer = null;
    let stopped = false;
    let heartbeatInFlight = 0;
    try {
      await mkdir(path.dirname(lockPath), { recursive: true });
      const acquiredAt = nowIso();
      const fenceEpoch = await readFenceEpoch(filePath) + 1;
      const lease = { lockId, fenceEpoch, pid: process.pid, acquiredAt, heartbeatAt: acquiredAt, filePath };
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(lease)}\n`);
      await handle.close();
      handle = null;
      heartbeatTimer = setInterval(() => {
        if (stopped) return;
        heartbeatInFlight += 1;
        void (async () => {
          try {
            const heartbeatAt = nowIso();
            // Re-read and update through the same handle so a heartbeat never
            // replaces a newer lock owner at the path.
            const rHandle = await open(lockPath, "r+");
            let owner = null;
            try {
              const content = await rHandle.readFile("utf8");
              try { owner = JSON.parse(content); } catch { /* corrupt */ }
              if (owner?.lockId !== lockId || owner?.fenceEpoch !== fenceEpoch) return;
              const next = `${JSON.stringify({ ...lease, heartbeatAt })}\n`;
              const buffer = Buffer.from(next, "utf8");
              await rHandle.write(buffer, 0, buffer.length, 0);
              await rHandle.truncate(buffer.length);
            } finally {
              await rHandle.close().catch(() => {});
            }
          } catch {
            // silently ignore heartbeat I/O errors
          } finally {
            heartbeatInFlight -= 1;
          }
        })().catch(() => {});
      }, LOCK_HEARTBEAT_MS);
      try {
        return await fn(lease);
      } finally {
        stopped = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        while (heartbeatInFlight > 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (handle) await handle.close().catch(() => {});
        const owner = await readLockOwner(lockPath);
        if (owner?.lockId === lockId && owner?.fenceEpoch === fenceEpoch) {
          await rmWithRetry(lockPath, { force: true }).catch(() => {});
        }
      }
    } catch (error) {
      stopped = true;
      if (handle) await handle.close().catch(() => {});
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
      const owner = await readLockOwner(lockPath);
      if (await isLockOwnerStale(lockPath, owner, staleMs)) {
        await rmWithRetry(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for AI Bridge state lock: ${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, 20 * (attempt + 1))));
      attempt += 1;
    }
  }
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

function normalizePathForComparison(filePath) {
  const normalized = path.normalize(filePath).replace(/[\\/]+$/, "") || path.parse(filePath).root;
  return process.platform === "win32"
    ? normalized.replaceAll("\\", "/").toLowerCase()
    : normalized;
}

async function gitRemote(workspacePath) {
  const result = await execCommand("git", ["config", "--get", "remote.origin.url"], {
    cwd: workspacePath,
    timeout: 10_000,
  }).catch(() => null);
  return result?.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

export async function normalizeWorkspaceIdentity(workspacePath) {
  const originalPath = normalizeWorkspace(workspacePath);
  const resolvedRealPath = await realpath(originalPath).catch(() => originalPath);
  const normalizedPath = normalizePathForComparison(resolvedRealPath);
  const gitRoot = await requireGitWorkspace(resolvedRealPath).catch(() => null);
  const remote = gitRoot ? await gitRemote(gitRoot) : null;
  const repoFingerprint = remote
    ? createHash("sha256").update(remote.trim().toLowerCase()).digest("hex")
    : null;
  return {
    originalPath,
    realPath: resolvedRealPath,
    normalizedPath,
    workspaceKey: createHash("sha256").update(normalizedPath).digest("hex"),
    gitRoot,
    gitRemote: remote,
    repoFingerprint,
  };
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
    child.stdin?.on("error", (error) => {
      stderr += `${stderr ? "\n" : ""}[AI Bridge stdin error] ${error instanceof Error ? error.message : String(error)}`;
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
    if (options.input !== undefined) {
      try {
        child.stdin.end(options.input);
      } catch (error) {
        stderr += `${stderr ? "\n" : ""}[AI Bridge stdin error] ${error instanceof Error ? error.message : String(error)}`;
      }
    }
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
    if (result.exitCode === 0 && result.stdout.trim()) {
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
        // Fall through to Get-Process below.
      }
    }
    const fallback = await runProcess("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ ProcessId = $p.Id; StartTime = $p.StartTime.ToUniversalTime().ToString('o'); Path = $p.Path } | ConvertTo-Json -Compress }`,
    ], { timeout: 5000 });
    if (fallback.exitCode !== 0 || !fallback.stdout.trim()) return { pid, available: false };
    try {
      const parsed = JSON.parse(fallback.stdout);
      return {
        pid,
        processStartTime: parsed.StartTime ?? null,
        executable: parsed.Path ?? null,
        commandLine: null,
        available: true,
        commandLineAvailable: false,
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

function processIdentityStatus(recorded, identity) {
  if (!recorded?.pid || !identity) return "unverifiable";
  if (recorded.processCommandLineNeedle && processExists(recorded.pid)) {
    if (!identity.commandLine) return "unverifiable";
    return identity.commandLine.includes(recorded.processCommandLineNeedle) ? "matched" : "mismatched";
  }
  if (identity.available === false) return "unverifiable";
  if (recorded.processStartTime && identity.processStartTime && recorded.processStartTime !== identity.processStartTime) return "mismatched";
  if (recorded.processExecutable && identity.executable) {
    const expected = path.basename(String(recorded.processExecutable)).toLowerCase();
    const actual = path.basename(String(identity.executable)).toLowerCase();
    if (expected && actual && expected !== actual) return "mismatched";
  }
  if (!recorded.processStartTime && !recorded.processExecutable) return "unverifiable";
  return "matched";
}

function processIdentityMatches(task, identity) {
  return processIdentityStatus(task, identity) === "matched";
}

function workerIdentityStatus(task, identity) {
  if (!task?.workerPid || !identity) return "unverifiable";
  if (identity.available === false) return "unverifiable";
  if (task.workerIdentity?.processStartTime && identity.processStartTime && task.workerIdentity.processStartTime !== identity.processStartTime) return "mismatched";
  if (task.workerIdentity?.executable && identity.executable) {
    const expected = path.basename(String(task.workerIdentity.executable)).toLowerCase();
    const actual = path.basename(String(identity.executable)).toLowerCase();
    if (expected && actual && expected !== actual) return "mismatched";
  }
  const commandLine = identity.commandLine ?? (identity.commandLineAvailable === false ? task.workerIdentity?.commandLine : null);
  if (!commandLine) return "unverifiable";
  const commandLineText = String(commandLine);
  if (task.workerLaunchToken && !commandLineText.includes(task.workerLaunchToken)) return "mismatched";
  if (task.taskId && !commandLineText.includes(task.taskId)) return "mismatched";
  if (!commandLineText.includes(path.basename(workerPath))) return "mismatched";
  return "matched";
}

async function getWorkerIdentityStatus(task) {
  if (!task?.workerPid) return "unverifiable";
  const identity = await getProcessIdentity(task.workerPid);
  return workerIdentityStatus(task, identity);
}

async function workerIdentityMatches(task) {
  return await getWorkerIdentityStatus(task) === "matched";
}

function executableBasename(value) {
  return value ? path.basename(String(value)).toLowerCase() : null;
}

function compareProcessIdentityFields(recorded, identity) {
  if (!identity) return "dead";
  if (identity.available === false) return "unverifiable";
  if (recorded.processStartTime && identity.processStartTime && recorded.processStartTime !== identity.processStartTime) return "mismatched";
  if (recorded.executable && identity.executable) {
    const expected = executableBasename(recorded.executable);
    const actual = executableBasename(identity.executable);
    if (expected && actual && expected !== actual) return "mismatched";
  }
  if (recorded.commandLine && identity.commandLine && recorded.commandLine !== identity.commandLine) return "mismatched";
  if (!recorded.processStartTime && !recorded.executable && !recorded.commandLine) return "unverifiable";
  if ((recorded.processStartTime && !identity.processStartTime) || (recorded.executable && !identity.executable)) return "unverifiable";
  return "matched";
}

async function getLauncherIdentityStatus(reservation) {
  const pid = Number(reservation?.launcherPid);
  if (!Number.isInteger(pid) || pid <= 0) return "unverifiable";
  if (pid === process.pid) {
    return activeStartReservations.has(reservation?.reservationId) ? "matched" : "dead";
  }
  const identity = await getProcessIdentity(pid);
  return compareProcessIdentityFields({
    processStartTime: reservation?.launcherProcessStartTime ?? reservation?.launcherIdentity?.processStartTime ?? null,
    executable: reservation?.launcherIdentity?.executable ?? null,
    commandLine: reservation?.launcherIdentity?.commandLine ?? null,
  }, identity);
}

async function getReservationWorkerIdentityStatus(task, reservation) {
  if (!reservation?.workerPid) return "unverifiable";
  const identity = await getProcessIdentity(reservation.workerPid);
  return workerIdentityStatus({
    ...task,
    workerPid: reservation.workerPid,
    workerIdentity: reservation.workerIdentity ?? null,
  }, identity);
}

async function classifyRunningTaskOwnership(task, run) {
  if (TERMINAL_TASK_STATES.has(task?.status)) {
    return { status: "terminal", terminal: true };
  }
  const reservation = run?.startReservation ?? null;
  const reservationActive = Boolean(
    reservation
      && !["complete", "rolled_back"].includes(reservation.phase)
      && reservation.taskId === task?.taskId,
  );
  const startupDeadlineMs = reservation?.startupDeadlineAt ? Date.parse(reservation.startupDeadlineAt) : NaN;
  const withinStartupDeadline = Number.isFinite(startupDeadlineMs) && Date.now() < startupDeadlineMs;
  const startupTimedOut = reservationActive && Number.isFinite(startupDeadlineMs) && Date.now() >= startupDeadlineMs;
  const launcherStatus = reservationActive ? await getLauncherIdentityStatus(reservation) : null;

  if (reservationActive && !task.workerPid && reservation.workerPid) {
    const reservationWorkerStatus = await getReservationWorkerIdentityStatus(task, reservation);
    if (launcherStatus === "matched" && withinStartupDeadline) {
      return { status: "startup_in_progress", reservation, launcherStatus, reservationWorkerStatus, withinStartupDeadline };
    }
    if (reservationWorkerStatus === "matched") {
      return { status: "worker_adoptable", reservation, launcherStatus, reservationWorkerStatus, withinStartupDeadline };
    }
    if (reservationWorkerStatus === "mismatched") {
      return { status: "worker_mismatched", reservation, launcherStatus, reservationWorkerStatus, withinStartupDeadline };
    }
    if (withinStartupDeadline) {
      return { status: "worker_identity_unverifiable_waiting", reservation, launcherStatus, reservationWorkerStatus, withinStartupDeadline };
    }
    return { status: "worker_unverifiable", reservation, launcherStatus, reservationWorkerStatus, withinStartupDeadline };
  }

  if (reservationActive && !task.workerPid) {
    if (launcherStatus === "matched" && withinStartupDeadline) {
      return { status: "startup_in_progress", reservation, launcherStatus, withinStartupDeadline };
    }
    if (launcherStatus === "unverifiable" && withinStartupDeadline) {
      return { status: "startup_in_progress_unverifiable", reservation, launcherStatus, withinStartupDeadline };
    }
    return {
      status: startupTimedOut ? "startup_timed_out" : "launcher_dead_no_worker",
      reservation,
      launcherStatus,
      withinStartupDeadline,
    };
  }

  if (task.workerPid) {
    const workerStatus = await getWorkerIdentityStatus(task);
    if (workerStatus === "matched") {
      return { status: "worker_matched", reservation: reservationActive ? reservation : null, launcherStatus, workerStatus, withinStartupDeadline };
    }
    if (workerStatus === "mismatched") {
      return { status: "worker_mismatched", reservation: reservationActive ? reservation : null, launcherStatus, workerStatus, withinStartupDeadline };
    }
    if (reservationActive && launcherStatus === "matched" && withinStartupDeadline) {
      return { status: "startup_in_progress", reservation, launcherStatus, workerStatus, withinStartupDeadline };
    }
    if (reservationActive && workerStatus === "unverifiable" && withinStartupDeadline) {
      return { status: "worker_identity_unverifiable_waiting", reservation, launcherStatus, workerStatus, withinStartupDeadline };
    }
    return { status: "worker_unverifiable", reservation: reservationActive ? reservation : null, launcherStatus, workerStatus, withinStartupDeadline };
  }

  if (reservationActive && launcherStatus === "matched" && withinStartupDeadline) {
    return { status: "startup_in_progress", reservation, launcherStatus, withinStartupDeadline };
  }
  if (task.schemaVersion >= 2) {
    return { status: "launcher_dead_no_worker", reservation: reservationActive ? reservation : null, launcherStatus, withinStartupDeadline };
  }
  return { status: "legacy", reservation: null, launcherStatus: null, withinStartupDeadline: false };
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
    if (result.exitCode !== 0 && processExists(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      await waitForProcessExit(pid, 1000);
    }
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

async function waitForProcessExit(pid, timeoutMs = 2000) {
  if (!pid) return true;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processExists(pid);
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
  migrated.revision ??= 0;
  return migrated;
}

async function readRun(runId) {
  const runDir = runPath(runId);
  const payload = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  return migrateRun({ ...payload, runDir });
}

async function writeRun(run) {
  await mkdir(run.runDir, { recursive: true });
  await atomicWriteJson(path.join(run.runDir, "run.json"), run);
}

async function readTask(taskId) {
  const filePath = taskPath(taskId);
  const payload = JSON.parse(await readFile(filePath, "utf8"));
  return { revision: 0, ...payload, taskPath: filePath };
}

async function writeTask(task) {
  await atomicWriteJson(taskPath(task.taskId), task);
}

async function mutateTask(taskId, mutator) {
  return await withFileLock(taskPath(taskId), async (lease) => {
    const latest = await readTask(taskId);
    const beforeRevision = Number(latest.revision ?? 0);
    const next = await mutator({ ...latest });
    if (!next) return latest;
    next.revision = beforeRevision + 1;
    await writeJsonWithFence(taskPath(taskId), next, lease);
    return next;
  });
}

async function mutateRun(runId, mutator) {
  const runDir = runPath(runId);
  const filePath = path.join(runDir, "run.json");
  return await withFileLock(filePath, async (lease) => {
    const latest = await readRun(runId);
    const beforeRevision = Number(latest.revision ?? 0);
    const next = await mutator({ ...latest });
    if (!next) return latest;
    next.revision = beforeRevision + 1;
    await writeJsonWithFence(filePath, next, lease);
    return next;
  });
}

function workspaceIndexPath(workspaceKey) {
  if (typeof workspaceKey !== "string" || !/^[a-f0-9]{64}$/.test(workspaceKey)) {
    throw new Error("workspaceKey must be a SHA-256 hex digest.");
  }
  return ensureInside(workspacesRoot(), path.join(workspacesRoot(), `${workspaceKey}.json`));
}

async function updateWorkspaceIndex(identity, runId) {
  const filePath = workspaceIndexPath(identity.workspaceKey);
  return await withFileLock(filePath, async (lease) => {
    const existing = await readFile(filePath, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    const runIds = [...new Set([...(Array.isArray(existing?.runIds) ? existing.runIds : []), runId])]
      .filter((candidate) => RUN_ID_PATTERN.test(candidate));
    const index = {
      schemaVersion: 1,
      workspaceKey: identity.workspaceKey,
      workspacePathNormalized: identity.normalizedPath,
      runIds,
      lastUpdatedAt: nowIso(),
    };
    await writeJsonWithFence(filePath, index, lease);
    return index;
  });
}

async function updateRunWorkspaceIndex(run) {
  try {
    const identity = run.workspaceKey && run.workspacePathNormalized
      ? {
          workspaceKey: run.workspaceKey,
          normalizedPath: run.workspacePathNormalized,
        }
      : await normalizeWorkspaceIdentity(run.workspacePath);
    await updateWorkspaceIndex(identity, run.runId);
    return null;
  } catch (error) {
    return {
      code: "workspace_index_update_failed",
      runId: run.runId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeTaskIfNonTerminal(task) {
  const updated = await mutateTask(task.taskId, async (latest) => {
    if (TERMINAL_TASK_STATES.has(latest.status)) return null;
    return { ...latest, ...task, revision: latest.revision };
  }).catch(() => null);
  return Boolean(updated && !TERMINAL_TASK_STATES.has(updated.status));
}

async function updateRunForTask(task, terminalStatus) {
  await withQueue(runQueues, task.runId, async () => {
    await mutateRun(task.runId, async (run) => {
      // Ownership invariant: if the run has moved on to a different task,
      // only record a safe historical entry and do not mutate run state.
      if (run.activeTaskId !== task.taskId) {
        const history = run.completedIterationsHistory ?? [];
        const transitionId = task.terminalTransitionId ?? null;
        // Dedupe by taskId+terminalTransitionId; for legacy entries
        // without transitionId use taskId+iteration+terminalStatus.
        const alreadyRecorded = history.some((entry) => {
          if (transitionId && entry.terminalTransitionId) {
            return entry.taskId === task.taskId && entry.terminalTransitionId === transitionId;
          }
          return entry.taskId === task.taskId && entry.iteration === task.iteration && entry.terminalStatus === terminalStatus;
        });
        if (!alreadyRecorded) {
          run.completedIterationsHistory = [
            ...history,
            { taskId: task.taskId, iteration: task.iteration, terminalStatus, terminalTransitionId: transitionId, observedAt: nowIso() },
          ];
        } else {
          return null; // no real change, avoid unnecessary revision bump
        }
        return run;
      }
      if (terminalStatus === "completed") run.status = "awaiting_review";
      if (terminalStatus === "failed") run.status = "failed";
      if (terminalStatus === "timed_out") run.status = "timed_out";
      if (terminalStatus === "cancelled") run.status = "cancelled";
      if (terminalStatus === "cancel_failed") run.status = "failed";
      if (terminalStatus === "orphaned_identity_mismatch" || terminalStatus === "orphaned_unverifiable") run.status = "failed";
      if (!run.completedIterations.includes(task.iteration)) {
        run.completedIterations.push(task.iteration);
        run.completedIterations.sort((a, b) => a - b);
      }
      if (["completed", "failed", "timed_out", "cancelled"].includes(terminalStatus)) {
        run.activeTaskId = null;
      }
      if (run.startReservation?.taskId === task.taskId && !["complete", "rolled_back"].includes(run.startReservation.phase)) {
        run.startReservation = { ...run.startReservation, phase: "complete", completedAt: nowIso(), updatedAt: nowIso() };
      }
      run.lastTaskId = task.taskId;
      run.updatedAt = nowIso();
      return run;
    });
  });
  const latestRun = await readRun(task.runId).catch(() => null);
  if (latestRun) await updateRunWorkspaceIndex(latestRun);
}

function terminalStatusOf(task) {
  return TERMINAL_TASK_STATES.has(task?.terminalStatus) ? task.terminalStatus : task?.status;
}

function finalLogMatchesTask(finalLog, task, terminalStatus) {
  if (!finalLog || typeof finalLog !== "object") return false;
  if (finalLog.taskId !== task.taskId) return false;
  if (finalLog.runId !== task.runId) return false;
  if (finalLog.iteration !== task.iteration) return false;
  if (finalLog.status !== terminalStatus) return false;
  if ((finalLog.terminalStatus ?? finalLog.status) !== terminalStatus) return false;
  if (task.terminalTransitionId && finalLog.terminalTransitionId !== task.terminalTransitionId) return false;
  if (!finalLog.finishedAt) return false;
  // Reject contradictory combinations
  if (finalLog.status === "completed" && finalLog.timedOut === true) return false;
  if (finalLog.status === "completed" && typeof finalLog.exitCode === "number" && finalLog.exitCode !== 0) return false;
  if (finalLog.status === "timed_out" && finalLog.timedOut !== true) return false;
  if (finalLog.status === "cancelled" && !finalLog.cancelReason) return false;
  // Verify exitCode matches task when available
  if (task.exitCode !== null && task.exitCode !== undefined && finalLog.exitCode !== task.exitCode) return false;
  // Verify timedOut matches task
  if (Boolean(finalLog.timedOut) !== Boolean(task.timedOut)) return false;
  return true;
}

async function shouldRewriteFinalLog(task, terminalStatus) {
  const text = await readFile(task.finalLogPath, "utf8").catch(() => null);
  if (!text) return true;
  try {
    return !finalLogMatchesTask(JSON.parse(text), task, terminalStatus);
  } catch {
    return true;
  }
}

function buildFinalLogEvent(task, terminalStatus) {
  return {
    status: terminalStatus,
    terminalStatus,
    terminalTransitionId: task.terminalTransitionId ?? null,
    runId: task.runId,
    taskId: task.taskId,
    iteration: task.iteration,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    command: "claude",
    claudeSessionId: task.claudeSessionId,
    sessionInvocationMode: task.sessionInvocationMode,
    args: task.args,
    pid: task.pid,
    processStartTime: task.processStartTime ?? null,
    processExecutable: task.processExecutable ?? null,
    exitCode: task.exitCode,
    timedOut: task.timedOut,
    cancelReason: task.cancelReason ?? null,
    killResult: task.killResult ?? null,
    stdout: "",
    stderr: task.stderr,
    parsedJson: null,
    streamLogPath: task.streamLogPath,
    transcriptLogPath: task.transcriptLogPath,
  };
}

async function completeTerminalFinalization(task) {
  let finalTask = await readTask(task.taskId);
  const terminalStatus = terminalStatusOf(finalTask);
  if (!TERMINAL_TASK_STATES.has(terminalStatus)) return finalTask;

  // Lightweight final-log validation even when finalizationPhase is 'complete'
  if (finalTask.finalizationPhase === "complete") {
    if (await shouldRewriteFinalLog(finalTask, terminalStatus)) {
      const event = buildFinalLogEvent(finalTask, terminalStatus);
      await atomicWriteJson(finalTask.finalLogPath, event);
      finalTask = await mutateTask(finalTask.taskId, async (latest) => {
        if (!TERMINAL_TASK_STATES.has(latest.status)) return null;
        latest.finalLogRepairCount = (latest.finalLogRepairCount ?? 0) + 1;
        latest.lastFinalLogRepairAt = nowIso();
        latest.lastFinalLogRepairReason = "final_log_corrupt_or_missing_during_validation";
        return latest;
      });
    }
    activeChildren.delete(finalTask.taskId);
    return finalTask;
  }

  const event = buildFinalLogEvent(finalTask, terminalStatus);
  if (finalTask.finalizationPhase !== "final_log_written" || await shouldRewriteFinalLog(finalTask, terminalStatus)) {
    await atomicWriteJson(finalTask.finalLogPath, event);
    finalTask = await mutateTask(finalTask.taskId, async (latest) => TERMINAL_TASK_STATES.has(latest.status) ? { ...latest, terminalStatus, finalizationPhase: "final_log_written" } : latest);
  }
  await updateRunForTask(finalTask, terminalStatus);
  const completed = await mutateTask(finalTask.taskId, async (latest) => TERMINAL_TASK_STATES.has(latest.status) ? { ...latest, terminalStatus, finalizationPhase: "complete" } : latest);
  activeChildren.delete(completed.taskId);
  return completed;
}

async function finalizeAsyncTask(task, status, details = {}) {
  const transitionId = randomUUID();
  const terminalOwner = `${process.pid}`;
  const landedTask = await mutateTask(task.taskId, async (latest) => {
    if (TERMINAL_TASK_STATES.has(latest.status)) {
      const landedStatus = terminalStatusOf(latest);
      if (landedStatus !== status) {
        latest.terminalConflicts = [
          ...(latest.terminalConflicts ?? []),
          { at: nowIso(), requestedStatus: status, landedStatus, transitionId, terminalOwner },
        ];
      }
      latest.terminalStatus ??= landedStatus;
      latest.finalizationPhase ??= "task_terminal_written";
      return latest;
    }
    const merged = { ...latest, ...task };
    merged.status = status;
    merged.terminalStatus = status;
    merged.terminalTransitionId = transitionId;
    merged.terminalOwner = terminalOwner;
    merged.finalizationPhase = "task_terminal_written";
    merged.finishedAt = nowIso();
    merged.exitCode = details.exitCode ?? merged.exitCode ?? null;
    merged.timedOut = status === "timed_out";
    merged.cancelReason = details.cancelReason ?? merged.cancelReason;
    merged.killResult = details.killResult ?? merged.killResult;
    merged.stderr = redactSecrets(details.stderr ?? merged.stderr ?? "");
    merged.lastEventAt = merged.lastEventAt ?? merged.finishedAt;
    return merged;
  });
  return await completeTerminalFinalization(landedTask);
}

function handleStreamChunk(bufferState, chunk) {
  bufferState.value += chunk.toString("utf8");
  const lines = bufferState.value.split(/\r?\n/);
  bufferState.value = lines.pop() ?? "";
  return lines.filter((line) => line.trim().length > 0);
}

async function ensureClaudeSession(run) {
  if (typeof run.claudeSessionId === "string" && run.claudeSessionId.trim() !== "") return run.claudeSessionId;
  const updated = await mutateRun(run.runId, async (latest) => {
    if (typeof latest.claudeSessionId === "string" && latest.claudeSessionId.trim() !== "") return latest;
    latest.claudeSessionId = createClaudeSessionId();
    latest.updatedAt = nowIso();
    return latest;
  });
  run.claudeSessionId = updated.claudeSessionId;
  return updated.claudeSessionId;
}

function claudeSessionArgs(run, iteration) {
  if (iteration <= 1 || run.sessionResumeMode !== "resume") {
    return { mode: "session-id", args: ["--session-id", run.claudeSessionId] };
  }
  return { mode: "resume", args: ["--resume", run.claudeSessionId] };
}

function workerLogPath(task) {
  return path.join(path.dirname(task.finalLogPath), `iteration-${task.iteration}.worker.log`);
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

const WORKSPACE_RUN_PRIORITY = new Map([
  ["running", 0],
  ["awaiting_review", 1],
  ["needs_fix", 2],
  ["ready", 3],
  ["failed", 4],
  ["timed_out", 5],
  ["passed", 6],
  ["blocked", 7],
  ["cancelled", 8],
]);
const ACTIVE_WORKSPACE_RUN_STATES = new Set(["ready", "running", "awaiting_review", "needs_fix"]);

function workspaceRunRank(run) {
  return WORKSPACE_RUN_PRIORITY.get(run.status) ?? 9;
}

function isWorkspaceRunTerminal(status) {
  return FINAL_RUN_STATES.has(status);
}

async function workspaceCandidate(run, identity, workspaceMatch) {
  const taskId = run.activeTaskId ?? run.lastTaskId ?? null;
  const task = taskId ? await readTask(taskId).catch(() => null) : null;
  const iteration = task?.iteration ?? run.currentIteration ?? 0;
  return {
    runId: run.runId,
    status: run.status,
    activeTaskId: run.activeTaskId ?? null,
    lastTaskId: run.lastTaskId ?? null,
    activeTaskStatus: task?.status ?? null,
    iteration,
    claudeSessionId: run.claudeSessionId ?? null,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? run.createdAt ?? null,
    workspaceMatch,
    rankReason: run.status === "running"
      ? "active running run"
      : `${workspaceMatch} match; run status ${run.status}`,
    needsSelection: false,
    sessionResumeMode: run.sessionResumeMode ?? "session-id",
    workspaceKey: run.workspaceKey ?? identity.workspaceKey,
  };
}

export async function discoverWorkspaceRuns({
  workspacePath,
  includeTerminal = false,
  maxAgeHours = 168,
  limit = 10,
} = {}) {
  const identity = await normalizeWorkspaceIdentity(workspacePath);
  const diagnostics = [];
  const indexedRunIds = new Set();
  const indexPath = workspaceIndexPath(identity.workspaceKey);
  const indexText = await readFile(indexPath, "utf8").catch(() => null);
  if (indexText !== null) {
    try {
      const index = JSON.parse(indexText);
      for (const runId of Array.isArray(index.runIds) ? index.runIds : []) {
        if (RUN_ID_PATTERN.test(runId)) indexedRunIds.add(runId);
      }
    } catch (error) {
      diagnostics.push({
        code: "workspace_index_corrupt",
        path: indexPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    diagnostics.push({ code: "workspace_index_missing", path: indexPath });
  }

  const runIds = new Set(indexedRunIds);
  const entries = await readdir(runsRoot()).catch(() => []);
  for (const entry of entries) {
    if (RUN_ID_PATTERN.test(entry)) runIds.add(entry);
  }

  const candidates = [];
  const maximumAgeMs = Number.isFinite(Number(maxAgeHours)) && Number(maxAgeHours) > 0
    ? Number(maxAgeHours) * 60 * 60 * 1000
    : Infinity;
  for (const runId of runIds) {
    let run;
    try {
      run = await readRun(runId);
    } catch (error) {
      diagnostics.push({
        code: "run_state_corrupt",
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const updatedMs = Date.parse(run.updatedAt ?? run.createdAt ?? "");
    if (Number.isFinite(updatedMs) && Date.now() - updatedMs > maximumAgeMs) continue;
    if (!includeTerminal && isWorkspaceRunTerminal(run.status)) continue;

    let workspaceMatch = null;
    if (run.workspaceKey === identity.workspaceKey) {
      workspaceMatch = "exact";
    } else if (run.workspacePathNormalized === identity.normalizedPath) {
      workspaceMatch = "normalized_path";
    } else if (!run.workspaceKey && normalizePathForComparison(run.workspacePath) === identity.normalizedPath) {
      workspaceMatch = "legacy_path";
    } else if (
      identity.repoFingerprint
      && run.workspaceIdentity?.repoFingerprint
      && identity.repoFingerprint === run.workspaceIdentity.repoFingerprint
    ) {
      workspaceMatch = "moved_workspace_candidate";
    }
    if (!workspaceMatch) continue;

    if (workspaceMatch === "legacy_path") {
      run = await mutateRun(runId, async (latest) => {
        if (!latest.workspaceKey) latest.workspaceKey = identity.workspaceKey;
        if (!latest.workspacePathNormalized) latest.workspacePathNormalized = identity.normalizedPath;
        if (!latest.workspaceIdentity) {
          latest.workspaceIdentity = {
            originalPath: latest.workspacePath,
            normalizedPath: identity.normalizedPath,
            gitRoot: identity.gitRoot,
            gitRemote: identity.gitRemote,
            repoFingerprint: identity.repoFingerprint,
            createdAt: latest.createdAt ?? nowIso(),
          };
        }
        latest.updatedAt = nowIso();
        return latest;
      });
    }
    candidates.push(await workspaceCandidate(run, identity, workspaceMatch));
  }

  candidates.sort((left, right) => {
    const rankDifference = workspaceRunRank(left) - workspaceRunRank(right);
    if (rankDifference !== 0) return rankDifference;
    return Date.parse(right.updatedAt ?? 0) - Date.parse(left.updatedAt ?? 0)
      || left.runId.localeCompare(right.runId);
  });
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
  const selected = candidates.slice(0, boundedLimit);
  const needsSelection = selected.length > 1 || selected.some((item) => item.workspaceMatch === "moved_workspace_candidate");
  for (const candidate of selected) candidate.needsSelection = needsSelection;

  try {
    const validRunIds = candidates
      .filter((item) => item.workspaceMatch !== "moved_workspace_candidate")
      .map((item) => item.runId);
    if (validRunIds.length) {
      for (const runId of validRunIds) await updateWorkspaceIndex(identity, runId);
    }
  } catch (error) {
    diagnostics.push({
      code: "workspace_index_rebuild_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    workspacePath: identity.originalPath,
    normalizedWorkspacePath: identity.normalizedPath,
    workspaceKey: identity.workspaceKey,
    candidates: selected,
    diagnostics,
    recommendedAction: selected.length === 0
      ? "no_runs_found"
      : needsSelection
        ? "select_run"
        : "attach",
  };
}

async function resolveWorkspaceCandidate(args) {
  const discovered = await discoverWorkspaceRuns({
    ...args,
    maxAgeHours: args?.runId ? 0 : args?.maxAgeHours,
    limit: args?.runId ? 100 : args?.limit,
  });
  if (args?.runId) {
    validateRunId(args.runId);
    const candidate = discovered.candidates.find((item) => item.runId === args.runId);
    if (!candidate) {
      return { discovered, candidate: null, reason: "run_not_found_for_workspace" };
    }
    if (candidate.workspaceMatch === "moved_workspace_candidate" && !args.confirmMovedWorkspace) {
      return { discovered, candidate: null, reason: "moved_workspace_confirmation_required" };
    }
    return { discovered, candidate, reason: null };
  }
  if (discovered.candidates.length === 0) return { discovered, candidate: null, reason: "no_runs_found" };
  if (discovered.candidates.length > 1 || discovered.candidates[0].workspaceMatch === "moved_workspace_candidate") {
    return { discovered, candidate: null, reason: "ambiguous" };
  }
  return { discovered, candidate: discovered.candidates[0], reason: null };
}

export async function attachWorkspaceRun({ workspacePath, runId, mode = "observe", confirmMovedWorkspace = false } = {}) {
  const resolved = await resolveWorkspaceCandidate({ workspacePath, runId, includeTerminal: true, confirmMovedWorkspace });
  if (!resolved.candidate) {
    return {
      attached: false,
      reason: resolved.reason,
      candidates: resolved.discovered.candidates,
      diagnostics: resolved.discovered.diagnostics,
    };
  }
  let run = await readRun(resolved.candidate.runId);
  if (resolved.candidate.workspaceMatch === "moved_workspace_candidate" && confirmMovedWorkspace) {
    const identity = await normalizeWorkspaceIdentity(workspacePath);
    run = await mutateRun(run.runId, async (latest) => {
      latest.workspacePath = identity.gitRoot ?? identity.realPath;
      latest.workspaceKey = identity.workspaceKey;
      latest.workspacePathNormalized = identity.normalizedPath;
      latest.workspaceIdentity = {
        originalPath: workspacePath,
        normalizedPath: identity.normalizedPath,
        gitRoot: identity.gitRoot,
        gitRemote: identity.gitRemote,
        repoFingerprint: identity.repoFingerprint,
        movedAt: nowIso(),
        createdAt: latest.workspaceIdentity?.createdAt ?? latest.createdAt ?? nowIso(),
      };
      latest.updatedAt = nowIso();
      return latest;
    });
  }
  const taskId = run.activeTaskId ?? run.lastTaskId ?? null;
  let task = taskId ? await readTask(taskId).catch(() => null) : null;
  let latestEvents = [];
  if (task?.status === "running") {
    const polled = await pollClaudeIteration({ taskId, cursor: 0 });
    task = await readTask(taskId).catch(() => task);
    latestEvents = polled.events;
  } else if (taskId) {
    latestEvents = (await getClaudeTranscript({ taskId }).catch(() => ({ events: [] }))).events;
  }
  if (task && TERMINAL_TASK_STATES.has(task.status)) {
    task = await completeTerminalFinalization(task);
    run = await readRun(run.runId);
  }
  const finalSummary = task?.finalLogPath
    ? await readFile(task.finalLogPath, "utf8").then((text) => JSON.parse(text)).catch(() => null)
    : null;
  const indexDiagnostic = await updateRunWorkspaceIndex(run);
  const nextIteration = run.currentIteration + 1;
  const nextActions = task?.status === "running"
    ? ["poll", "get_transcript"]
    : ["get_transcript", ...(run.status === "needs_fix" ? ["prepare_next_iteration"] : [])];
  return {
    attached: true,
    mode,
    runId: run.runId,
    taskId,
    status: task?.status ?? run.status,
    runStatus: run.status,
    taskStatus: task?.status ?? null,
    claudeSessionId: run.claudeSessionId ?? null,
    sessionResumeAvailable: run.sessionResumeMode === "resume",
    sessionResumeMode: run.sessionResumeMode ?? "session-id",
    nextIteration,
    nextActions: [
      ...nextActions,
      ...(run.status === "awaiting_review" ? ["record_review"] : []),
    ],
    pollCursor: latestEvents.length,
    latestEvents,
    finalLogPath: task?.finalLogPath ?? null,
    finalSummary,
    transcriptLogPath: task?.transcriptLogPath ?? null,
    finalizationPhase: task?.finalizationPhase ?? null,
    diagnostics: [...resolved.discovered.diagnostics, ...(indexDiagnostic ? [indexDiagnostic] : [])],
  };
}

export async function pollWorkspaceRun({ workspacePath, runId, cursor = 0, confirmMovedWorkspace = false } = {}) {
  const attached = await attachWorkspaceRun({ workspacePath, runId, mode: "observe", confirmMovedWorkspace });
  if (!attached.attached) return attached;
  if (!attached.taskId) {
    return { ...attached, runStatus: attached.runStatus, taskId: null, latestEvents: [], cursor, nextCursor: 0 };
  }
  const task = await readTask(attached.taskId);
  if (task.status === "running") {
    const polled = await pollClaudeIteration({ taskId: task.taskId, cursor });
    return { ...attached, ...polled, runStatus: attached.runStatus, latestEvents: polled.events };
  }
  const transcript = await getClaudeTranscript({ taskId: task.taskId });
  const numericCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  return {
    ...attached,
    status: task.status,
    taskStatus: task.status,
    cursor: numericCursor,
    nextCursor: transcript.events.length,
    latestEvents: transcript.events.slice(numericCursor),
    finalLogPath: task.finalLogPath,
    transcriptLogPath: task.transcriptLogPath,
    finalizationPhase: task.finalizationPhase ?? null,
  };
}

export async function preflight({
  workspacePath,
  task,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  verificationCommands,
  reuseExisting = false,
  allowConcurrentRun = false,
  env = process.env,
} = {}) {
  const workspace = normalizeWorkspace(workspacePath);
  const gitRoot = await requireGitWorkspace(workspace);
  const existing = await discoverWorkspaceRuns({
    workspacePath: gitRoot,
    includeTerminal: false,
    maxAgeHours: 24 * 365,
    limit: 100,
  });
  const activeRuns = existing.candidates.filter((candidate) => ACTIVE_WORKSPACE_RUN_STATES.has(candidate.status));
  if (activeRuns.length && !allowConcurrentRun) {
    if (reuseExisting) {
      if (activeRuns.length > 1) {
        return {
          created: false,
          reused: false,
          reason: "ambiguous",
          status: "ambiguous",
          workspacePath: gitRoot,
          existingWorkspaceRuns: activeRuns,
          warning: "Multiple active AI Bridge runs exist for this workspace. Select a runId with attach; no run was reused or created.",
        };
      }
      const attached = await attachWorkspaceRun({ workspacePath: gitRoot, runId: activeRuns[0].runId });
      return {
        ...attached,
        reused: true,
        created: false,
        warning: "Active AI Bridge run exists for this workspace; reused the existing run.",
        existingWorkspaceRuns: activeRuns,
      };
    }
    return {
      created: false,
      reused: false,
      runId: activeRuns[0].runId,
      status: activeRuns[0].status,
      workspacePath: gitRoot,
      existingWorkspaceRuns: activeRuns,
      warning: "Active AI Bridge run exists for this workspace. Use discover/attach or pass allowConcurrentRun=true.",
    };
  }
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
  const identity = await normalizeWorkspaceIdentity(gitRoot);
  const run = migrateRun({
    runId,
    runDir,
    version: APP_VERSION,
    status: "ready",
    workspacePath: gitRoot,
    workspaceKey: identity.workspaceKey,
    workspacePathNormalized: identity.normalizedPath,
    workspaceIdentity: {
      originalPath: workspacePath,
      normalizedPath: identity.normalizedPath,
      gitRoot,
      gitRemote: identity.gitRemote,
      repoFingerprint: identity.repoFingerprint,
      createdAt: nowIso(),
    },
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
  const workspaceIndexDiagnostic = await updateRunWorkspaceIndex(run);

  return {
    created: true,
    reused: false,
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
    existingWorkspaceRuns: existing.candidates,
    diagnostics: workspaceIndexDiagnostic ? [workspaceIndexDiagnostic] : [],
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
  await mutateRun(runId, async (latest) => {
    latest.planHandoffs = [...(Array.isArray(latest.planHandoffs) ? latest.planHandoffs : []), event];
    latest.updatedAt = nowIso();
    return latest;
  });
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
    if (!Number.isInteger(iteration) || iteration < 1) throw new Error("iteration must be a positive integer.");
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("prompt must be a non-empty string.");
    const sanitizedArgs = sanitizeClaudeArgs(claudeArgs);
    const taskId = createTaskId();
    const reservationId = randomUUID();
    const fault = (name) => {
      if (env.AI_BRIDGE_TEST_FAULT === name) throw new Error(`Injected fault: ${name}`);
    };
    activeStartReservations.add(reservationId);
    try {
    const reservedRun = await mutateRun(runId, async (latest) => {
      await assertCanStart(latest, iteration);
      if (typeof latest.claudeSessionId !== "string" || latest.claudeSessionId.trim() === "") {
        latest.claudeSessionId = createClaudeSessionId();
      }
      const launcherIdentity = await getCurrentProcessIdentity();
      latest.status = "running";
      latest.activeTaskId = taskId;
      latest.currentIteration = iteration;
      latest.startReservation = {
        taskId,
        iteration,
        reservationId,
        phase: "reserved",
        reservedAt: nowIso(),
        updatedAt: nowIso(),
        launcherPid: process.pid,
        launcherProcessStartTime: launcherIdentity?.processStartTime ?? null,
        launcherIdentity,
        launcherToken: randomUUID(),
        startupDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
        workerPid: null,
        workerIdentity: null,
      };
      latest.updatedAt = nowIso();
      return latest;
    });
    await updateRunWorkspaceIndex(reservedRun);
    fault("after_run_reservation");
    const advanceReservation = async (phase, extra = {}) => {
      await mutateRun(runId, async (latest) => {
        if (latest.startReservation?.reservationId !== reservationId) return latest;
        latest.startReservation = { ...latest.startReservation, ...extra, phase, updatedAt: nowIso() };
        latest.updatedAt = nowIso();
        return latest;
      });
    };
    const session = claudeSessionArgs(reservedRun, iteration);
    const streamLogPath = path.join(reservedRun.runDir, `iteration-${iteration}.stream.jsonl`);
    const transcriptLogPath = path.join(reservedRun.runDir, `iteration-${iteration}.transcript.jsonl`);
    const finalLogPath = path.join(reservedRun.runDir, `iteration-${iteration}.json`);
    await atomicWriteText(streamLogPath, "");
    await atomicWriteText(transcriptLogPath, "");
    fault("after_logs_created");

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
    const deadlineAt = new Date(Date.now() + Math.max(1, Number(timeoutSec)) * 1000).toISOString();
    const workerLaunchToken = randomUUID();
    const task = {
      appVersion: APP_VERSION,
      schemaVersion: 2,
      revision: 0,
      taskId,
      runId,
      iteration,
      status: "running",
      workerStatus: "starting",
      workerPid: null,
      stdinErrorObserved: false,
      stdinErrorCode: null,
      stdinErrorAt: null,
      startReservationId: reservationId,
      workerLaunchToken,
      ownerEpoch: workerLaunchToken,
      workspacePath: reservedRun.workspacePath,
      claudeSessionId: reservedRun.claudeSessionId,
      sessionInvocationMode: session.mode,
      startedAt: nowIso(),
      finishedAt: null,
      timeoutSec: Math.max(1, Number(timeoutSec)),
      deadlineAt,
      streamLogPath,
      transcriptLogPath,
      finalLogPath,
      workerLogPath: path.join(reservedRun.runDir, `iteration-${iteration}.worker.log`),
      eventCount: 0,
      exitCode: null,
      timedOut: false,
      stderr: "",
      args: args.concat("[PROMPT_ON_STDIN_REDACTED]"),
      claudeProcessArgs: args,
      pid: null,
      heartbeatAt: nowIso(),
      lastEventAt: null,
      processIdentity: null,
      processExecutable: null,
      claudeExecutable: env.AI_BRIDGE_TEST_FAULT === "claude_spawn_error"
        ? path.join(reservedRun.runDir, "missing-claude-executable")
        : reservedRun.claudeExecutable ?? await resolveExecutable("claude", env),
      processStartTime: null,
    };
    const rollbackReservation = async () => {
      await mutateRun(runId, async (latest) => {
        if (latest.activeTaskId !== taskId) return latest;
        latest.activeTaskId = null;
        latest.currentIteration = Math.max(0, iteration - 1);
        latest.status = iteration === 1 ? "ready" : "needs_fix";
        latest.startReservation = { ...(latest.startReservation ?? {}), taskId, iteration, reservationId, phase: "rolled_back", updatedAt: nowIso(), workerPid: latest.startReservation?.workerPid ?? null, workerIdentity: latest.startReservation?.workerIdentity ?? null };
        latest.updatedAt = nowIso();
        return latest;
      }).catch(() => {});
    };
    try {
      await writeTask(task);
      await advanceReservation("task_created");
    } catch (error) {
      await rollbackReservation();
      throw error;
    }
    fault("after_task_created");
    if (env.AI_BRIDGE_TEST_PAUSE_AFTER_TASK_CREATED_READY && env.AI_BRIDGE_TEST_PAUSE_AFTER_TASK_CREATED_RELEASE) {
      await writeFile(env.AI_BRIDGE_TEST_PAUSE_AFTER_TASK_CREATED_READY, "ready");
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (await access(env.AI_BRIDGE_TEST_PAUSE_AFTER_TASK_CREATED_RELEASE).then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    let worker;
    let workerCommand;
    let workerArgs;
    let workerAsyncFailure = null;
    try {
      workerCommand = env.AI_BRIDGE_TEST_WORKER_EXECUTABLE
        ? env.AI_BRIDGE_TEST_WORKER_EXECUTABLE
        : process.execPath;
      workerArgs = env.AI_BRIDGE_TEST_FAULT === "worker_exit_before_ready"
        ? ["-e", "process.exit(9)"]
        : env.AI_BRIDGE_TEST_FAULT === "worker_close_stdin_before_ready"
          ? ["-e", "process.stdin.destroy(); setTimeout(() => process.exit(9), 200);"]
        : [workerPath, taskId, workerLaunchToken];
      worker = spawn(workerCommand, workerArgs, {
        cwd: repoRoot,
        env,
        windowsHide: true,
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
      worker.once("error", (error) => {
        workerAsyncFailure = error;
        void finalizeAsyncTask(task, "failed", { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) });
      });
      worker.once("close", (code) => {
        if (workerAsyncFailure) return;
        void readTask(taskId).then((latest) => {
          if (!latest.workerReadyAt && !TERMINAL_TASK_STATES.has(latest.status)) {
            return finalizeAsyncTask(latest, "failed", { exitCode: code ?? 1, stderr: `${latest.stderr ?? ""}\nAI Bridge worker exited before becoming ready.` });
          }
          return null;
        }).catch(() => {});
      });
      worker.stdin.on("error", (error) => {
        void mutateTask(taskId, async (latest) => {
          if (TERMINAL_TASK_STATES.has(latest.status)) return null;
          latest.stderr = `${latest.stderr ?? ""}\n[AI Bridge worker stdin error] ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
          latest.stdinErrorObserved = true;
          latest.stdinErrorCode = error?.code ?? error?.name ?? "UNKNOWN";
          latest.stdinErrorAt = nowIso();
          return latest;
        }).catch(() => {});
      });
      worker.stdin.end(prompt);
    } catch (error) {
      const finalTask = await finalizeAsyncTask(task, "failed", { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) });
      return { taskId, runId, iteration, status: finalTask.status, claudeSessionId: reservedRun.claudeSessionId, sessionInvocationMode: session.mode, pid: null, workerPid: null, streamLogPath, transcriptLogPath, finalLogPath, startedAt: task.startedAt };
    }
    const workerPid = worker.pid ?? null;
    const observedWorkerIdentity = workerPid ? await waitForProcessIdentity(workerPid) : null;
    const workerIdentity = workerPid
      ? {
          ...(observedWorkerIdentity ?? { pid: workerPid, available: false }),
          pid: workerPid,
          executable: observedWorkerIdentity?.executable ?? workerCommand,
          commandLine: observedWorkerIdentity?.commandLine ?? [workerCommand, ...(workerArgs ?? [])].map((part) => String(part)).join(" "),
        }
      : null;
    if (workerPid) {
      await advanceReservation("worker_spawned", { workerPid, workerIdentity });
    }
    if (env.AI_BRIDGE_TEST_FAULT === "after_worker_spawned_reservation") {
      worker.unref();
      worker.stdin.destroy();
    }
    fault("after_worker_spawned_reservation");
    const launchedTask = await mutateTask(taskId, async (latest) => {
      if (TERMINAL_TASK_STATES.has(latest.status)) return null;
      if (latest.workerLaunchToken !== workerLaunchToken) return latest;
      latest.workerPid = workerPid;
      latest.workerIdentity = workerIdentity;
      return latest;
    });
    worker.unref();
    let readyTask = launchedTask;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      readyTask = await readTask(taskId);
      if (readyTask.workerReadyAt || TERMINAL_TASK_STATES.has(readyTask.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (readyTask.workerReadyAt) await advanceReservation("worker_ready", { workerPid: readyTask.workerPid ?? workerPid, workerIdentity: readyTask.workerIdentity ?? workerIdentity });
    if (TERMINAL_TASK_STATES.has(readyTask.status)) {
      readyTask = await completeTerminalFinalization(readyTask);
      await advanceReservation("complete", { completedAt: nowIso() });
    }

    return { taskId, runId, iteration, status: readyTask.status, claudeSessionId: reservedRun.claudeSessionId, sessionInvocationMode: session.mode, pid: readyTask.pid, workerPid: readyTask.workerPid, streamLogPath, transcriptLogPath, finalLogPath, startedAt: task.startedAt };
    } finally {
      activeStartReservations.delete(reservationId);
    }
}

export async function runWorkerTask(taskId, { prompt = "", env = process.env, workerLaunchToken: providedWorkerLaunchToken } = {}) {
  let task = await readTask(taskId);
  if (TERMINAL_TASK_STATES.has(task.status)) return task;
  const workerLaunchToken = task.workerLaunchToken;
  if (providedWorkerLaunchToken && providedWorkerLaunchToken !== workerLaunchToken) {
    throw new Error("Worker launch token mismatch; refusing to take task ownership.");
  }
  if (env.AI_BRIDGE_TEST_PAUSE_WORKER_BEFORE_OWNERSHIP_READY && env.AI_BRIDGE_TEST_PAUSE_WORKER_BEFORE_OWNERSHIP_RELEASE) {
    await writeFile(env.AI_BRIDGE_TEST_PAUSE_WORKER_BEFORE_OWNERSHIP_READY, "ready");
    for (let i = 0; i < 600; i += 1) {
      if (await access(env.AI_BRIDGE_TEST_PAUSE_WORKER_BEFORE_OWNERSHIP_RELEASE).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const observedWorkerIdentity = await waitForProcessIdentity(process.pid);
  const workerIdentity = {
    ...(observedWorkerIdentity ?? { pid: process.pid, available: false }),
    pid: process.pid,
    executable: observedWorkerIdentity?.executable ?? process.execPath,
    commandLine: observedWorkerIdentity?.commandLine ?? [process.execPath, ...process.argv.slice(1)].map((part) => String(part)).join(" "),
  };
  task = await mutateTask(taskId, async (latest) => {
    if (TERMINAL_TASK_STATES.has(latest.status)) return null;
    if (latest.workerLaunchToken !== workerLaunchToken) {
      throw new Error("Worker launch token mismatch; refusing to take task ownership.");
    }
    latest.workerPid = process.pid;
    latest.workerIdentity = workerIdentity;
    latest.workerStatus = "running";
    latest.workerHeartbeatAt = nowIso();
    latest.workerLogPath ??= workerLogPath(latest);
    return latest;
  });
  await appendFile(task.workerLogPath, `${JSON.stringify({ at: nowIso(), event: "worker_started", taskId })}\n`);

  const commandPath = task.claudeExecutable ?? await resolveExecutable("claude", env);
  const args = Array.isArray(task.claudeProcessArgs)
    ? task.claudeProcessArgs
    : (Array.isArray(task.args) ? task.args.filter((arg) => arg !== "[PROMPT_ON_STDIN_REDACTED]") : []);
  const isCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(commandPath);
  const stdoutBuffer = { value: "" };
  const stderrBuffer = { value: "" };
  const pendingWrites = [];
  let finalPromise = null;
  let finalized = false;
  let timeout = null;
  let cancelInterval = null;
  let childClosed = false;
  let childExitCode = null;
  let resolveClose;
  const closePromise = new Promise((resolve) => {
    resolveClose = resolve;
  });

  const enqueue = (work) => {
    const promise = withQueue(taskQueues, taskId, async () => {
      try {
        await work();
      } catch (error) {
        task.stderr += `\n[AI Bridge worker callback error] ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
      }
    });
    pendingWrites.push(promise);
    return promise;
  };

  const flushBuffers = async () => {
    for (const line of handleStreamChunk(stdoutBuffer, "\n")) {
      const sanitized = redactSecrets(line);
      await appendFile(task.streamLogPath, `${sanitized}\n`);
      await appendTranscriptEvent(task, summarizeStreamEvent(parseStreamJsonLine(sanitized)));
    }
    for (const line of handleStreamChunk(stderrBuffer, "\n")) {
      task.stderr += `${redactSecrets(line)}\n`;
    }
    task.workerHeartbeatAt = nowIso();
    task.heartbeatAt = task.workerHeartbeatAt;
    await writeTaskIfNonTerminal(task);
  };

  const finalize = (status, details = {}) => {
    if (finalPromise) return finalPromise;
    finalized = true;
    if (timeout) clearTimeout(timeout);
    if (cancelInterval) clearInterval(cancelInterval);
    const writesToWaitFor = pendingWrites.slice();
    finalPromise = withQueue(taskQueues, taskId, async () => {
      await Promise.allSettled(writesToWaitFor);
      await flushBuffers();
      const latest = await readTask(taskId).catch(() => task);
      task = { ...task, ...latest, workerStatus: "finished", workerHeartbeatAt: nowIso() };
      await writeTaskIfNonTerminal(task);
      const finalTask = await finalizeAsyncTask(task, status, details);
      await appendFile(task.workerLogPath, `${JSON.stringify({ at: nowIso(), event: "worker_finalized", taskId, status })}\n`);
      return finalTask;
    });
    pendingWrites.push(finalPromise);
    return finalPromise;
  };

  const child = spawn(commandPath, args, {
    cwd: task.workspacePath,
    env,
    windowsHide: true,
    shell: isCmd,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    if (finalized) return;
    enqueue(async () => {
      task.workerHeartbeatAt = nowIso();
      task.heartbeatAt = task.workerHeartbeatAt;
      for (const line of handleStreamChunk(stdoutBuffer, chunk)) {
        const sanitized = redactSecrets(line);
        await appendFile(task.streamLogPath, `${sanitized}\n`);
        await appendTranscriptEvent(task, summarizeStreamEvent(parseStreamJsonLine(sanitized)));
      }
      await writeTaskIfNonTerminal(task);
    });
  });
  child.stderr.on("data", (chunk) => {
    if (finalized) return;
    enqueue(async () => {
      task.workerHeartbeatAt = nowIso();
      task.heartbeatAt = task.workerHeartbeatAt;
      for (const line of handleStreamChunk(stderrBuffer, chunk)) {
        task.stderr += `${redactSecrets(line)}\n`;
      }
      await writeTaskIfNonTerminal(task);
    });
  });
  child.on("error", (error) => {
    finalize("failed", { exitCode: 1, stderr: error.message });
    resolveClose();
  });
  child.on("close", (code) => {
    childClosed = true;
    childExitCode = code;
    if (finalized && !finalPromise) {
      resolveClose();
      return;
    }
    if (!finalized) {
      enqueue(flushBuffers);
    }
    const status = finalized ? task.status : code === 0 ? "completed" : "failed";
    finalize(status, { exitCode: code ?? 1, stderr: task.stderr });
    resolveClose();
  });

  task.pid = child.pid ?? null;
  const identity = task.pid ? await getProcessIdentity(task.pid) : null;
  task = await mutateTask(taskId, async (latest) => {
    if (TERMINAL_TASK_STATES.has(latest.status)) return null;
    if (latest.workerLaunchToken !== workerLaunchToken) return latest;
    latest.pid = task.pid;
    latest.processIdentity = identity;
    latest.processExecutable = identity?.executable ?? commandPath;
    latest.processCommandLineNeedle = latest.claudeSessionId;
    latest.claudeExecutable = commandPath;
    latest.processStartTime = identity?.processStartTime ?? null;
    latest.workerHeartbeatAt = nowIso();
    latest.workerReadyAt = nowIso();
    latest.heartbeatAt = latest.workerHeartbeatAt;
    return latest;
  });

  if (childClosed && !finalPromise) {
    finalize(childExitCode === 0 ? "completed" : "failed", { exitCode: childExitCode ?? 1, stderr: task.stderr });
  } else if (!TERMINAL_TASK_STATES.has(task.status)) {
    child.stdin.on("error", (error) => {
      task.stderr += `\n[AI Bridge stdin error] ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
      task.stdinErrorObserved = true;
      task.stdinErrorCode = error?.code ?? error?.name ?? "UNKNOWN";
      task.stdinErrorAt = nowIso();
    });
    try {
      if (env.AI_BRIDGE_TEST_FORCE_STDIN_ERROR_AFTER_LISTENER === "1") {
        const error = new Error("test forced stdin EPIPE after listener installation");
        error.code = "EPIPE";
        child.stdin.destroy(error);
        await new Promise((resolve) => setImmediate(resolve));
      }
      const stdinDelayMs = Number(env.AI_BRIDGE_TEST_DELAY_CLAUDE_STDIN_WRITE_MS);
      if (stdinDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, stdinDelayMs));
      child.stdin.end(prompt);
    } catch (error) {
      task.stderr += `\n[AI Bridge stdin error] ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
      task.stdinErrorObserved = true;
      task.stdinErrorCode = error?.code ?? error?.name ?? "UNKNOWN";
      task.stdinErrorAt = nowIso();
    }
  }

  if (!finalPromise && !finalized) {
    const deadlineMs = Date.parse(task.deadlineAt ?? "");
    const timeoutDelay = Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs - Date.now()) : Math.max(1, Number(task.timeoutSec ?? 900)) * 1000;
    timeout = setTimeout(() => {
      if (finalPromise || finalized) return;
      finalized = true;
      void killProcessTree(task.pid).then(async (killResult) => {
        const stillAlive = task.pid ? (!killResult.killed && !await waitForProcessExit(task.pid)) : false;
        finalize(stillAlive ? "failed" : "timed_out", {
          exitCode: 1,
          stderr: stillAlive ? `${task.stderr}\nTimeout kill failed; Claude process is still running.` : task.stderr,
          killResult,
        });
        resolveClose();
      });
    }, timeoutDelay);

    cancelInterval = setInterval(() => {
      if (finalPromise || finalized) return;
      void readTask(taskId).then(async (latest) => {
        if (!latest.cancelRequestedAt || latest.cancelHandledRequestId === latest.cancelRequestId || finalPromise || finalized) return;
        task = { ...task, ...latest, status: "cancelling", workerStatus: "stopping", cancelHandledRequestId: latest.cancelRequestId };
        await writeTaskIfNonTerminal(task);
        finalized = true;
        const killResult = await killProcessTree(task.pid);
        const stillAlive = task.pid ? (!killResult.killed && !await waitForProcessExit(task.pid)) : false;
        finalize(stillAlive ? "cancel_failed" : "cancelled", {
          exitCode: 1,
          stderr: stillAlive ? `${task.stderr ?? ""}\nCancelled by AI Bridge, but Claude process is still running.` : `${task.stderr ?? ""}\nCancelled by AI Bridge.`,
          cancelReason: task.cancelReason ?? "Cancelled by AI Bridge.",
          killResult,
        });
        resolveClose();
      }).catch(() => {});
    }, 100);
  }

  try {
    await closePromise;
    return await finalPromise;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (cancelInterval) clearInterval(cancelInterval);
  }
}

export async function cancelClaudeIteration({ taskId } = {}) {
  let task = await readTask(taskId);
  if (TERMINAL_TASK_STATES.has(task.status)) {
    return { taskId, runId: task.runId, status: task.status, cancelled: false };
  }
  if (task.schemaVersion >= 2) {
    const run = await readRun(task.runId).catch(() => null);
    const ownership = run ? await classifyRunningTaskOwnership(task, run) : null;
    if (["startup_in_progress", "startup_in_progress_unverifiable", "worker_identity_unverifiable_waiting"].includes(ownership?.status)) {
      return {
        taskId,
        runId: task.runId,
        status: task.status,
        cancelled: false,
        cancelRequested: false,
        action: ownership.status,
        launcherIdentityStatus: ownership.launcherStatus ?? null,
      };
    }
    if (ownership?.status === "worker_adoptable") {
      const adoption = await adoptReservationWorker(task, ownership.reservation, task.runId, "cancel");
      task = adoption.task;
    } else if (ownership?.status === "worker_mismatched" || ownership?.status === "worker_unverifiable") {
      const terminalStatus = ownership.status === "worker_mismatched" ? "orphaned_identity_mismatch" : "orphaned_unverifiable";
      const finalTask = await finalizeAsyncTask(task, terminalStatus, {
        exitCode: 1,
        stderr: `${task.stderr ?? ""}\nAI Bridge cancel could not prove worker ownership (${ownership.status}); refusing to kill an unknown process.`,
        identityStatus: ownership.status,
      });
      return {
        taskId,
        runId: finalTask.runId,
        status: finalTask.status,
        cancelled: false,
        cancelRequested: false,
        action: ownership.status,
      };
    } else if (ownership?.status === "launcher_dead_no_worker" || ownership?.status === "startup_timed_out") {
      const finalTask = await finalizeAsyncTask(task, "cancelled", {
        exitCode: 1,
        stderr: `${task.stderr ?? ""}\nCancelled by AI Bridge before a worker was recorded.`,
        cancelReason: "Cancelled by AI Bridge.",
      });
      return {
        taskId,
        runId: finalTask.runId,
        status: finalTask.status,
        cancelled: finalTask.status === "cancelled",
        cancelRequested: false,
        action: ownership.status,
      };
    }
    const workerStatus = await getWorkerIdentityStatus(task);
    if (workerStatus !== "matched") {
      const result = await claimWorkerOrphan(task, "cancel");
      return {
        taskId,
        runId: result.task.runId,
        status: result.task.status,
        cancelled: result.task.status === "cancelled",
        cancelRequested: false,
        workerIdentityStatus: workerStatus,
        action: result.action,
        killResult: result.killResult,
      };
    }
    const cancelRequestId = randomUUID();
    await mutateTask(taskId, async (latest) => {
      if (TERMINAL_TASK_STATES.has(latest.status)) return null;
      latest.cancelRequestedAt = latest.cancelRequestedAt ?? nowIso();
      latest.cancelRequestId = latest.cancelRequestId ?? cancelRequestId;
      latest.cancelReason = latest.cancelReason ?? "Cancelled by AI Bridge.";
      return latest;
    });
    let current = await readTask(taskId);
    for (let attempt = 0; attempt < 50 && !TERMINAL_TASK_STATES.has(current.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      current = await readTask(taskId);
    }
    let workerExited = current.workerPid ? await waitForProcessExit(current.workerPid, 3000) : true;
    let workerKillResult = null;
    if (!workerExited && await workerIdentityMatches(current)) {
      workerKillResult = await killProcessTree(current.workerPid);
      workerExited = await waitForProcessExit(current.workerPid, 2000);
    }
    if (!TERMINAL_TASK_STATES.has(current.status)) {
      current = await readTask(taskId);
      if (workerExited || !await workerIdentityMatches(current)) {
        const orphan = await claimWorkerOrphan(current, "cancel");
        current = orphan.task;
      } else {
        current = await finalizeAsyncTask(current, "cancel_failed", {
          exitCode: 1,
          stderr: `${current.stderr ?? ""}\nCancelled by AI Bridge, but the durable worker did not exit and could not be safely taken over.`,
          cancelReason: "Cancelled by AI Bridge.",
          killResult: workerKillResult,
        });
      }
    }
    return {
      taskId,
      runId: current.runId,
      status: current.status,
      cancelled: current.status === "cancelled",
      cancelRequested: true,
      cancelRequestId: current.cancelRequestId,
      workerExited,
      killResult: current.killResult ?? null,
      workerKillResult,
    };
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
  } else {
    finalPromise = finalizeAsyncTask(task, "cancelled", { ...details, killResult: { attempted: true, pending: true } });
  }
  await finalPromise;
  const identity = task.pid ? await getProcessIdentity(task.pid) : null;
  const identityMatches = task.pid ? processIdentityMatches(task, identity) : false;
  const claudeKillResult = runtime?.child
    ? await killProcessTree(runtime.child.pid ?? task.pid)
    : identityMatches
      ? await killProcessTree(task.pid)
      : { attempted: false, killed: false, reason: task.pid ? "process identity mismatch or unavailable" : "missing pid" };
  const workerIdentity = task.workerPid ? await getProcessIdentity(task.workerPid) : null;
  const workerMatches = task.workerPid
    ? processIdentityMatches({
        pid: task.workerPid,
        processStartTime: task.workerIdentity?.processStartTime,
        processExecutable: task.workerIdentity?.executable,
      }, workerIdentity)
    : false;
  const workerKillResult = workerMatches ? await killProcessTree(task.workerPid) : { attempted: false, killed: false, reason: task.workerPid ? "worker identity mismatch or unavailable" : "missing worker pid" };
  const targetCleared = (result, pid) => !pid || result.killed || result.reason === "process not found";
  const killResult = {
    attempted: Boolean(claudeKillResult.attempted || workerKillResult.attempted),
    killed: Boolean(targetCleared(claudeKillResult, task.pid) && targetCleared(workerKillResult, task.workerPid)),
    reason: claudeKillResult.reason ?? workerKillResult.reason ?? null,
    claude: claudeKillResult,
    worker: workerKillResult,
  };
  const finalTask = await readTask(taskId);
  await mutateTask(taskId, async (latest) => TERMINAL_TASK_STATES.has(latest.status) ? { ...latest, killResult } : latest);
  const finalLog = JSON.parse(await readFile(finalTask.finalLogPath, "utf8").catch(() => "{}"));
  await atomicWriteJson(finalTask.finalLogPath, { ...finalLog, killResult });
  const current = await readTask(taskId);
  return { taskId, runId: current.runId, status: current.status, cancelled: current.status === "cancelled", killResult };
}

async function claimWorkerOrphan(task, context = "poll") {
  const identity = task.pid ? await getProcessIdentity(task.pid) : null;
  const identityStatus = task.pid ? processIdentityStatus(task, identity) : "unverifiable";
  if (identityStatus === "matched") {
    const killResult = await killProcessTree(task.pid);
    const stillAlive = task.pid ? (!killResult.killed && !await waitForProcessExit(task.pid)) : false;
    const status = context === "cancel" ? (stillAlive ? "cancel_failed" : "cancelled") : (stillAlive ? "cancel_failed" : "failed");
    const finalTask = await finalizeAsyncTask(task, status, {
      exitCode: 1,
      stderr: `${task.stderr ?? ""}\nAI Bridge ${context} detected a dead worker and ${stillAlive ? "failed to terminate" : "terminated"} its matched orphaned Claude process.`,
      killResult,
      cancelReason: context === "cancel" ? "Cancelled by AI Bridge." : task.cancelReason,
    });
    return { task: finalTask, action: stillAlive ? "orphaned_claude_kill_failed" : "killed_orphaned_claude", identityStatus, killResult };
  }
  const status = identityStatus === "mismatched" ? "orphaned_identity_mismatch" : "orphaned_unverifiable";
  const finalTask = await finalizeAsyncTask(task, status, {
    exitCode: 1,
    stderr: `${task.stderr ?? ""}\nAI Bridge ${context} detected a dead worker but Claude process identity was ${identityStatus}; refusing to kill an unknown process.`,
    identityStatus,
  });
  return { task: finalTask, action: status, identityStatus, killResult: null };
}

async function adoptReservationWorker(task, reservation, runId, context = "recovery") {
  const identity = reservation?.workerPid ? await getProcessIdentity(reservation.workerPid) : null;
  const identityStatus = workerIdentityStatus({
    ...task,
    workerPid: reservation?.workerPid ?? null,
    workerIdentity: reservation?.workerIdentity ?? null,
  }, identity);
  if (identityStatus !== "matched") {
    const finalTask = await finalizeAsyncTask(task, identityStatus === "mismatched" ? "orphaned_identity_mismatch" : "orphaned_unverifiable", {
      exitCode: 1,
      stderr: `${task.stderr ?? ""}\nAI Bridge ${context} could not adopt reservation worker because its identity was ${identityStatus}.`,
      identityStatus,
    });
    return { task: finalTask, action: identityStatus === "mismatched" ? "worker_mismatched" : "worker_unverifiable", identityStatus };
  }

  let adopted = false;
  const adoptedTask = await mutateTask(task.taskId, async (latest) => {
    if (TERMINAL_TASK_STATES.has(latest.status)) return null;
    if (latest.startReservationId !== reservation.reservationId) return null;
    if (latest.workerPid && latest.workerPid !== reservation.workerPid) return null;
    if (latest.workerPid === reservation.workerPid && latest.workerIdentity) return null;
    latest.workerPid = reservation.workerPid;
    latest.workerIdentity = {
      ...(reservation.workerIdentity ?? {}),
      ...(identity ?? {}),
      commandLine: identity?.commandLine ?? reservation.workerIdentity?.commandLine ?? null,
    };
    latest.workerStatus = latest.workerStatus === "starting" ? "running" : latest.workerStatus ?? "running";
    latest.workerAdoptedAt = nowIso();
    latest.workerAdoptedBy = `${process.pid}`;
    latest.heartbeatAt = latest.heartbeatAt ?? nowIso();
    adopted = true;
    return latest;
  });

  if (adopted) {
    await mutateRun(runId, async (latest) => {
      if (latest.startReservation?.reservationId !== reservation.reservationId) return null;
      latest.startReservation = {
        ...latest.startReservation,
        phase: "worker_adopted",
        workerPid: reservation.workerPid,
        workerIdentity: {
          ...(reservation.workerIdentity ?? {}),
          ...(identity ?? {}),
          commandLine: identity?.commandLine ?? reservation.workerIdentity?.commandLine ?? null,
        },
        adoptedAt: nowIso(),
        adoptedBy: `${process.pid}`,
        updatedAt: nowIso(),
      };
      latest.updatedAt = nowIso();
      return latest;
    });
    return { task: adoptedTask, action: "worker_adopted", identityStatus };
  }

  const latestTask = await readTask(task.taskId);
  return { task: latestTask, action: latestTask.workerPid === reservation.workerPid ? "worker_already_adopted" : "worker_adoption_skipped", identityStatus };
}

async function recoverStartReservations() {
  const recovered = [];
  const entries = await readdir(runsRoot()).catch(() => []);
  for (const runId of entries.filter((entry) => RUN_ID_PATTERN.test(entry))) {
    try {
      // Fence concurrent recoveries: mutateRun serializes via withFileLock on run.json.
      // The callback decides what action to take; the actual finalization happens
      // outside the lock to avoid deadlocks with task/run locks.
      let decision = null;
      await mutateRun(runId, async (run) => {
        const reservation = run.startReservation;
        if (!reservation || ["complete", "rolled_back"].includes(reservation.phase)) return null;
        const taskId = reservation.taskId ?? run.activeTaskId;
        const task = taskId ? await readTask(taskId).catch(() => null) : null;

        if (!task) {
          run.activeTaskId = null;
          run.currentIteration = Math.max(0, Number(reservation.iteration ?? run.currentIteration) - 1);
          run.status = Number(reservation.iteration) === 1 ? "ready" : "needs_fix";
          run.startReservation = { ...run.startReservation, phase: "rolled_back", updatedAt: nowIso(), reason: "task_missing" };
          run.updatedAt = nowIso();
          decision = { action: "rolled_back_missing_task", reservationId: reservation.reservationId };
          return run;
        }

        const ownership = await classifyRunningTaskOwnership(task, run);
        if (["startup_in_progress", "startup_in_progress_unverifiable", "worker_identity_unverifiable_waiting"].includes(ownership.status)) {
          decision = { action: ownership.status, reservationId: reservation.reservationId, ownership };
          return null;
        }
        if (ownership.status === "worker_adoptable") {
          decision = { action: "adopt_reservation_worker", reservationId: reservation.reservationId, taskId: task.taskId, task, ownership };
          return null;
        }
        if (ownership.status === "worker_matched") {
          decision = { action: "left_running_matched_worker", reservationId: reservation.reservationId, ownership };
          return null;
        }
        if (ownership.status === "worker_mismatched" || ownership.status === "worker_unverifiable") {
          decision = { action: "finalize_unowned_worker", reservationId: reservation.reservationId, taskId: task.taskId, task, ownership };
          return null;
        }
        if (ownership.status === "launcher_dead_no_worker" || ownership.status === "startup_timed_out") {
          decision = { action: "finalize_task_without_worker", reservationId: reservation.reservationId, taskId: task.taskId, task, ownership };
          return null;
        }
        if (ownership.status === "terminal") {
          decision = { action: "complete_terminal_reservation", reservationId: reservation.reservationId, taskId: task.taskId, task };
          return null;
        }

        decision = { action: "unhandled", reservationId: reservation.reservationId };
        return null;
      }).catch((error) => {
        decision = { action: "reservation_recovery_error", error: error instanceof Error ? error.message : String(error) };
      });

      if (!decision) continue;

      // Carry reservationId through to the second-phase mutateRun for fencing
      const reservationId = decision.reservationId;

      if (decision.action === "startup_in_progress" || decision.action === "startup_in_progress_unverifiable" || decision.action === "worker_identity_unverifiable_waiting" || decision.action === "left_running_matched_worker") {
        recovered.push({ runId, action: decision.action });
        continue;
      }

      if (decision.action === "rolled_back_missing_task") {
        recovered.push({ runId, taskId: null, action: "rolled_back_missing_task" });
        continue;
      }

      if (decision.action === "finalize_task_without_worker") {
        const finalTask = await finalizeAsyncTask(decision.task, "failed", {
          exitCode: 1,
          stderr: `${decision.task.stderr ?? ""}\nAI Bridge recovery found a start reservation whose worker was never spawned.`,
        });
        await mutateRun(runId, async (latest) => {
          if (latest.startReservation?.reservationId !== reservationId) return null;
          latest.startReservation = { ...latest.startReservation, phase: "complete", updatedAt: nowIso(), completedAt: nowIso() };
          return latest;
        });
        recovered.push({ runId, taskId: decision.taskId, status: finalTask.status, action: "failed_task_without_worker" });
        continue;
      }

      if (decision.action === "adopt_reservation_worker") {
        const adoption = await adoptReservationWorker(decision.task, decision.ownership.reservation, runId, "recovery");
        await mutateRun(runId, async (latest) => {
          if (latest.startReservation?.reservationId !== reservationId) return null;
          if (adoption.action === "worker_adopted" || adoption.action === "worker_already_adopted") {
            latest.startReservation = {
              ...latest.startReservation,
              phase: latest.startReservation.phase === "worker_ready" ? "worker_ready" : "worker_adopted",
              workerPid: adoption.task.workerPid ?? latest.startReservation.workerPid,
              workerIdentity: adoption.task.workerIdentity ?? latest.startReservation.workerIdentity,
              adoptedAt: latest.startReservation.adoptedAt ?? nowIso(),
              adoptedBy: latest.startReservation.adoptedBy ?? `${process.pid}`,
              updatedAt: nowIso(),
            };
            latest.updatedAt = nowIso();
            return latest;
          }
          latest.startReservation = { ...latest.startReservation, phase: "complete", updatedAt: nowIso(), completedAt: nowIso() };
          return latest;
        });
        recovered.push({ runId, taskId: decision.taskId, status: adoption.task.status, action: adoption.action, identityStatus: adoption.identityStatus });
        continue;
      }

      if (decision.action === "finalize_unowned_worker") {
        const terminalStatus = decision.ownership.status === "worker_mismatched" ? "orphaned_identity_mismatch" : "orphaned_unverifiable";
        const finalTask = await finalizeAsyncTask(decision.task, terminalStatus, {
          exitCode: 1,
          stderr: `${decision.task.stderr ?? ""}\nAI Bridge recovery could not prove worker ownership (${decision.ownership.status}); refusing to kill an unknown process.`,
          identityStatus: decision.ownership.status,
        });
        await mutateRun(runId, async (latest) => {
          if (latest.startReservation?.reservationId !== reservationId) return null;
          latest.startReservation = { ...latest.startReservation, phase: "complete", updatedAt: nowIso(), completedAt: nowIso() };
          return latest;
        });
        recovered.push({ runId, taskId: decision.taskId, status: finalTask.status, action: decision.ownership.status });
        continue;
      }

      if (decision.action === "complete_terminal_reservation") {
        await completeTerminalFinalization(decision.task);
        await mutateRun(runId, async (latest) => {
          if (latest.startReservation?.reservationId !== reservationId) return null;
          latest.startReservation = { ...latest.startReservation, phase: "complete", updatedAt: nowIso(), completedAt: nowIso() };
          return latest;
        });
        recovered.push({ runId, taskId: decision.taskId, status: decision.task.status, action: "completed_terminal_reservation" });
        continue;
      }

      if (decision.action === "reservation_recovery_error") {
        recovered.push({ runId, action: "reservation_recovery_error", error: decision.error });
        continue;
      }

      if (decision.action === "unhandled") {
        recovered.push({ runId, action: "unhandled_start_reservation" });
      }
    } catch (error) {
      recovered.push({ runId, action: "reservation_recovery_error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return recovered;
}

export async function pollClaudeIteration({ taskId, cursor = 0 } = {}) {
  const task = await readTask(taskId);
  let ownership = null;
  if (task.status === "running" && (task.schemaVersion >= 2 || task.pid)) {
    const run = await readRun(task.runId).catch(() => null);
    ownership = run ? await classifyRunningTaskOwnership(task, run) : null;
    if (ownership?.status === "worker_adoptable") {
      await adoptReservationWorker(task, ownership.reservation, task.runId, "poll");
    } else if (ownership?.status === "worker_mismatched" || ownership?.status === "worker_unverifiable") {
      if (ownership.reservation) {
        const terminalStatus = ownership.status === "worker_mismatched" ? "orphaned_identity_mismatch" : "orphaned_unverifiable";
        await finalizeAsyncTask(task, terminalStatus, {
          exitCode: 1,
          stderr: `${task.stderr ?? ""}\nAI Bridge poll could not prove worker ownership (${ownership.status}); refusing to kill an unknown process.`,
          identityStatus: ownership.status,
        });
      } else {
        await claimWorkerOrphan(task, "poll");
      }
    } else if (ownership?.status === "launcher_dead_no_worker" || ownership?.status === "startup_timed_out") {
      await finalizeAsyncTask(task, "failed", {
        exitCode: 1,
        stderr: `${task.stderr ?? ""}\nAI Bridge poll found startup ownership lost before a worker was recorded.`,
        ownershipStatus: ownership.status,
      });
    } else if (!run && task.schemaVersion >= 2 && !await workerIdentityMatches(task)) {
      await claimWorkerOrphan(task, "poll");
    } else if (ownership?.status === "legacy" || (!run && !task.schemaVersion)) {
      const identity = await getProcessIdentity(task.pid);
      if (!identity || !processIdentityMatches(task, identity)) {
        await finalizeAsyncTask(task, "failed", {
          exitCode: 1,
          stderr: `${task.stderr ?? ""}\nAI Bridge detected an orphaned running task after MCP restart; pid ${task.pid} is missing or no longer matches the recorded Claude process.`,
        });
      }
    }
  }
  let currentTask = await readTask(taskId);
  if (TERMINAL_TASK_STATES.has(currentTask.status)) {
    currentTask = await completeTerminalFinalization(currentTask);
  }
  if (!ownership && currentTask.status === "running") {
    const run = await readRun(currentTask.runId).catch(() => null);
    ownership = run ? await classifyRunningTaskOwnership(currentTask, run) : null;
  }
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
    revision: currentTask.revision,
    cancelRequestedAt: currentTask.cancelRequestedAt ?? null,
    cancelRequestId: currentTask.cancelRequestId ?? null,
    finalizationPhase: currentTask.finalizationPhase ?? null,
    ownershipStatus: ownership?.status ?? null,
    launcherIdentityStatus: ownership?.launcherStatus ?? null,
    workerIdentityStatus: ownership?.workerStatus ?? ownership?.reservationWorkerStatus ?? null,
    streamLogPath: currentTask.streamLogPath,
    transcriptLogPath: currentTask.transcriptLogPath,
    finalLogPath: currentTask.finalLogPath,
  };
}

export async function recoverRunningTasks() {
  const recovered = await recoverStartReservations();
  const diagnostics = [];
  const root = tasksRoot();
  const entries = await readdir(root).catch(() => []);
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    try {
      const taskId = entry.slice(0, -".json".length);
      if (!TASK_ID_PATTERN.test(taskId)) continue;
      const task = await readTask(taskId);
      if (TERMINAL_TASK_STATES.has(task.status)) {
        const finalTask = await completeTerminalFinalization(task);
        recovered.push({ taskId, runId: task.runId, status: finalTask.status, action: "completed_terminal_finalization", finalizationPhase: finalTask.finalizationPhase });
        continue;
      }
      if (task.status !== "running") continue;
      const run = await readRun(task.runId).catch(() => null);
      const ownership = run ? await classifyRunningTaskOwnership(task, run) : null;
      if (["startup_in_progress", "startup_in_progress_unverifiable", "worker_identity_unverifiable_waiting"].includes(ownership?.status)) {
        recovered.push({ taskId, runId: task.runId, status: "running", action: ownership.status, workerPid: task.workerPid ?? null, launcherIdentityStatus: ownership.launcherStatus ?? null });
        continue;
      }
      if (ownership?.status === "worker_adoptable") {
        const adoption = await adoptReservationWorker(task, ownership.reservation, task.runId, "recovery");
        recovered.push({ taskId, runId: task.runId, status: adoption.task.status, action: adoption.action, workerPid: adoption.task.workerPid ?? null, identityStatus: adoption.identityStatus });
        continue;
      }
      if (ownership?.status === "worker_mismatched" || ownership?.status === "worker_unverifiable") {
        if (ownership.reservation) {
          const terminalStatus = ownership.status === "worker_mismatched" ? "orphaned_identity_mismatch" : "orphaned_unverifiable";
          const finalTask = await finalizeAsyncTask(task, terminalStatus, {
            exitCode: 1,
            stderr: `${task.stderr ?? ""}\nAI Bridge recovery could not prove worker ownership (${ownership.status}); refusing to kill an unknown process.`,
            identityStatus: ownership.status,
          });
          recovered.push({ taskId, runId: task.runId, status: finalTask.status, action: ownership.status, workerPid: task.workerPid ?? null });
        } else {
          const orphan = await claimWorkerOrphan(task, "recovery");
          recovered.push({ taskId, runId: task.runId, status: orphan.task.status, action: orphan.action, workerPid: task.workerPid ?? null, identityStatus: orphan.identityStatus });
        }
        continue;
      }
      if (ownership?.status === "launcher_dead_no_worker" || ownership?.status === "startup_timed_out") {
        await finalizeAsyncTask(task, "failed", {
          exitCode: 1,
          stderr: `${task.stderr ?? ""}\nAI Bridge recovery found startup ownership lost before a worker was recorded.`,
          ownershipStatus: ownership.status,
        });
        recovered.push({ taskId, runId: task.runId, status: "failed", action: ownership.status, workerPid: null });
        continue;
      }
      const hasLiveWorker = ownership?.status === "worker_matched" || (task.schemaVersion >= 2 && await workerIdentityMatches(task));
      const identity = hasLiveWorker || !task.pid ? null : await getProcessIdentity(task.pid);
      if (!hasLiveWorker && (!task.pid || !identity || !processIdentityMatches(task, identity))) {
        await finalizeAsyncTask(task, "failed", {
          exitCode: 1,
          stderr: `${task.stderr ?? ""}\nAI Bridge server restarted and marked this running task failed/orphaned because its recorded process was not found or did not match.`,
        });
        recovered.push({ taskId, runId: task.runId, status: "failed", action: "marked_orphaned" });
      } else {
        recovered.push({ taskId, runId: task.runId, status: "running", action: "left_running", pid: task.pid, workerPid: task.workerPid ?? null });
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
  return { taskId, runId: polled.runId, iteration: polled.iteration, status: polled.status, events: polled.events, corruptTranscriptLines: polled.corruptTranscriptLines, streamLogPath: polled.streamLogPath ?? task.streamLogPath, transcriptLogPath: polled.transcriptLogPath ?? task.transcriptLogPath, finalLogPath: polled.finalLogPath ?? task.finalLogPath, exitCode: polled.exitCode, timedOut: polled.timedOut, revision: polled.revision, finalizationPhase: polled.finalizationPhase };
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

async function readJsonLines(filePath, diagnosticCode) {
  const text = await readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const values = [];
  const diagnostics = [];
  let lineNumber = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      diagnostics.push({
        code: diagnosticCode,
        path: filePath,
        line: lineNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { values, diagnostics };
}

async function readRunTasks(runId) {
  const entries = await readdir(tasksRoot()).catch(() => []);
  const tasks = [];
  const diagnostics = [];
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const taskId = entry.slice(0, -5);
    try {
      const task = await readTask(taskId);
      if (task.runId === runId) tasks.push(task);
    } catch (error) {
      const text = await readFile(path.join(tasksRoot(), entry), "utf8").catch(() => "");
      if (text.includes(runId)) {
        diagnostics.push({ code: "task_state_corrupt", taskId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  tasks.sort((a, b) => Number(a.iteration ?? 0) - Number(b.iteration ?? 0));
  return { tasks, diagnostics };
}

function transcriptPathFor(run, task) {
  return task?.transcriptLogPath
    ?? (task?.iteration ? path.join(run.runDir, `iteration-${task.iteration}.transcript.jsonl`) : null)
    ?? path.join(run.runDir, "transcript.jsonl");
}

async function readRunEvents(run, task) {
  const preferred = transcriptPathFor(run, task);
  const fallback = path.join(run.runDir, "transcript.jsonl");
  const preferredExists = await access(preferred).then(() => true).catch(() => false);
  const transcriptPath = preferredExists ? preferred : fallback;
  const parsed = await readJsonLines(transcriptPath, "transcript_line_corrupt");
  return { ...parsed, transcriptPath };
}

const RUN_EXPLORER_STATUS_PRIORITY = new Map([
  ["running", 0],
  ["awaiting_review", 1],
  ["needs_fix", 2],
  ["ready", 3],
  ["failed", 4],
  ["timed_out", 5],
  ["passed", 6],
  ["blocked", 7],
  ["cancelled", 8],
]);

function runSummary(run, { lastTaskStatus = null, workspaceMatch = "none" } = {}) {
  const priority = RUN_EXPLORER_STATUS_PRIORITY.get(run.status) ?? 9;
  return {
    runId: run.runId,
    status: run.status,
    workspacePath: run.workspacePath,
    workspaceKey: run.workspaceKey ?? null,
    workspacePathNormalized: run.workspacePathNormalized ?? null,
    task: run.task,
    currentIteration: run.currentIteration ?? 0,
    maxIterations: run.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    completedIterations: run.completedIterations ?? [],
    activeTaskId: run.activeTaskId ?? null,
    lastTaskId: run.lastTaskId ?? null,
    lastTaskStatus,
    claudeSessionId: run.claudeSessionId ?? null,
    verificationCommands: run.verificationCommands ?? [],
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    rankReason: `${run.status ?? "unknown"} status priority ${priority}; newest updatedAt ranks first within the same status`,
    workspaceMatch,
  };
}

export async function listRuns({
  workspacePath,
  includeTerminal = true,
  status,
  limit = 20,
  maxAgeHours = 720,
} = {}) {
  const diagnostics = [];
  const runs = [];
  const cutoff = Date.now() - Math.max(0, Number(maxAgeHours)) * 3_600_000;
  const workspaceIdentity = workspacePath ? await normalizeWorkspaceIdentity(workspacePath) : null;
  const entries = await readdir(runsRoot(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((item) => item.isDirectory())) {
    try {
      const run = await readRun(entry.name);
      const updated = Date.parse(run.updatedAt ?? run.createdAt ?? 0);
      if (Number.isFinite(updated) && updated < cutoff) continue;
      if (!includeTerminal && FINAL_RUN_STATES.has(run.status)) continue;
      if (status && run.status !== status) continue;
      let workspaceMatch = "none";
      if (workspaceIdentity) {
        if (run.workspaceKey && run.workspaceKey === workspaceIdentity.workspaceKey) {
          workspaceMatch = "exact";
        } else if (run.workspacePathNormalized === workspaceIdentity.normalizedPath) {
          workspaceMatch = "normalized_path";
        } else if (run.workspacePath && normalizePathForComparison(run.workspacePath) === workspaceIdentity.normalizedPath) {
          workspaceMatch = "legacy_path";
        } else {
          continue;
        }
      }
      let lastTaskStatus = null;
      if (run.lastTaskId) {
        try {
          const task = await readTask(run.lastTaskId);
          if (task.runId !== run.runId) throw new Error(`Task belongs to ${task.runId}, not ${run.runId}.`);
          lastTaskStatus = task.status ?? null;
        } catch (error) {
          diagnostics.push({
            code: "last_task_state_corrupt",
            runId: run.runId,
            taskId: run.lastTaskId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      runs.push(runSummary(run, { lastTaskStatus, workspaceMatch }));
    } catch (error) {
      diagnostics.push({ code: "run_state_corrupt", runId: entry.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  runs.sort((a, b) => {
    const priorityDifference = (RUN_EXPLORER_STATUS_PRIORITY.get(a.status) ?? 9)
      - (RUN_EXPLORER_STATUS_PRIORITY.get(b.status) ?? 9);
    return priorityDifference || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
  });
  return { runs: runs.slice(0, Math.max(1, Math.min(100, Number(limit) || 20))), diagnostics };
}

export async function showVerification({ runId, includeOutput = false, maxOutputChars = 4000 } = {}) {
  const run = await readRun(runId);
  const parsed = await readJsonLines(path.join(run.runDir, "verification.jsonl"), "verification_line_corrupt");
  const commands = parsed.values.map((item) => {
    const failed = item.timedOut || Number(item.exitCode) !== 0;
    const result = {
      command: item.command,
      cwd: item.cwd,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      durationMs: Math.max(0, Date.parse(item.finishedAt) - Date.parse(item.startedAt)) || 0,
      exitCode: item.exitCode,
      timedOut: Boolean(item.timedOut),
      status: failed ? "failed" : "passed",
    };
    if (includeOutput) {
      result.stdout = summarizeText(redactSecrets(item.stdout ?? ""), maxOutputChars);
      result.stderr = summarizeText(redactSecrets(item.stderr ?? ""), maxOutputChars);
    }
    return result;
  });
  const status = commands.length === 0
    ? "not_run"
    : parsed.diagnostics.length > 0
      ? "partial"
      : commands.some((item) => item.status === "failed") ? "failed" : "passed";
  return { runId, status, commands, diagnostics: parsed.diagnostics };
}

export async function inspectRun({ runId, includeEvents = true, eventLimit = 20, includeLogs = false } = {}) {
  const run = await readRun(runId);
  const taskResult = await readRunTasks(runId);
  let currentTask = taskResult.tasks.find((task) => task.taskId === run.activeTaskId)
    ?? taskResult.tasks.find((task) => task.taskId === run.lastTaskId)
    ?? taskResult.tasks.at(-1)
    ?? null;
  const finalDiagnostics = [];
  if (currentTask?.finalLogPath && TERMINAL_TASK_STATES.has(terminalStatusOf(currentTask))) {
    if (await shouldRewriteFinalLog(currentTask, terminalStatusOf(currentTask))) {
      currentTask = await completeTerminalFinalization(currentTask);
      const index = taskResult.tasks.findIndex((task) => task.taskId === currentTask.taskId);
      if (index >= 0) taskResult.tasks[index] = currentTask;
      finalDiagnostics.push({
        code: "final_log_repaired",
        taskId: currentTask.taskId,
        path: currentTask.finalLogPath,
        message: "Rebuilt a missing, corrupt, or conflicting final log from authoritative terminal task state.",
      });
    }
  }
  const eventResult = includeEvents
    ? await readRunEvents(run, currentTask)
    : { values: [], diagnostics: [], transcriptPath: null };
  const verification = await showVerification({ runId, includeOutput: includeLogs });
  const usage = await summarizeCosts({ runId });
  const normalizedEventLimit = Number.isFinite(Number(eventLimit)) ? Number(eventLimit) : 20;
  const events = eventResult.values.slice(-Math.max(0, Math.min(500, normalizedEventLimit)));
  return {
    run: runSummary(run, { lastTaskStatus: currentTask?.status ?? null }),
    tasks: taskResult.tasks,
    currentTask,
    events,
    verification,
    usage,
    logs: includeLogs ? {
      runDir: run.runDir,
      transcriptLogPath: eventResult.transcriptPath,
      finalLogPath: currentTask?.finalLogPath ?? null,
      streamLogPath: currentTask?.streamLogPath ?? null,
    } : undefined,
    diagnostics: [...taskResult.diagnostics, ...eventResult.diagnostics, ...verification.diagnostics, ...finalDiagnostics],
  };
}

export async function tailRun({ runId, cursor = 0, limit = 50 } = {}) {
  const run = await readRun(runId);
  const taskResult = await readRunTasks(runId);
  const task = taskResult.tasks.find((item) => item.taskId === run.activeTaskId)
    ?? taskResult.tasks.find((item) => item.taskId === run.lastTaskId)
    ?? taskResult.tasks.at(-1)
    ?? null;
  const eventResult = await readRunEvents(run, task);
  const start = Math.max(0, Number(cursor) || 0);
  const events = eventResult.values.slice(start, start + Math.max(1, Math.min(500, Number(limit) || 50)));
  return {
    runId,
    taskId: task?.taskId ?? null,
    status: task?.status ?? run.status,
    cursor: start,
    nextCursor: start + events.length,
    hasMore: start + events.length < eventResult.values.length,
    events,
    diagnostics: [...taskResult.diagnostics, ...eventResult.diagnostics],
  };
}

async function collectSnapshot(run) {
  const current = await gitBaseline(run.workspacePath);
  const classified = classifySnapshot(run.gitBaseline ?? { statusEntries: [], untrackedFiles: [], fileHashes: {} }, current);
  const baselineInvalidated = (run.gitBaseline?.head && run.gitBaseline.head !== current.head) || (run.gitBaseline?.branch !== current.branch);
  const [diffStat, nameStatus, cachedNameStatus] = await Promise.all([
    execCommand("git", ["diff", "--stat"], { cwd: run.workspacePath }),
    execCommand("git", ["diff", "--name-status", "-z"], { cwd: run.workspacePath }),
    execCommand("git", ["diff", "--cached", "--name-status", "-z"], { cwd: run.workspacePath }),
  ]);
  const payload = {
    runId: run.runId,
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
  return payload;
}

export async function snapshotChanges({ runId } = {}) {
  const run = await readRun(runId);
  const payload = await collectSnapshot(run);
  await atomicWriteJson(path.join(run.runDir, "snapshot.json"), payload);
  return payload;
}

function sensitivePathReason(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/").toLowerCase();
  if (/(^|\/)\.env($|\.)/.test(normalized)) return "environment file";
  if (/\.pem$|\.key$|(^|\/)id_rsa$/.test(normalized)) return "private key or key-like filename";
  if (/credentials?/.test(normalized)) return "credential-like filename";
  if (/secret/.test(normalized)) return "secret-like filename";
  if (/token/.test(normalized)) return "token-like filename";
  if (/password/.test(normalized)) return "password-like filename";
  return null;
}

export async function showRunDiff({ runId, includePatch = false, maxPatchBytes = 20_000 } = {}) {
  const run = await readRun(runId);
  const snapshot = await collectSnapshot(run);
  const sensitivePathWarnings = [...new Set(snapshot.changedFiles.map((item) => item.path))]
    .map((filePath) => ({ path: filePath, reason: sensitivePathReason(filePath) }))
    .filter((warning) => warning.reason);
  const sensitivePaths = sensitivePathWarnings.map((warning) => warning.path);
  const result = { ...snapshot, sensitivePathWarnings, sensitivePaths, diagnostics: [] };
  if (includePatch) {
    const [unstaged, staged] = await Promise.all([
      execCommand("git", ["diff", "--no-ext-diff", "--no-color"], { cwd: run.workspacePath }),
      execCommand("git", ["diff", "--cached", "--no-ext-diff", "--no-color"], { cwd: run.workspacePath }),
    ]);
    const redacted = redactSecrets([unstaged.stdout, staged.stdout].filter(Boolean).join("\n"));
    const normalizedMaximum = Number.isFinite(Number(maxPatchBytes)) ? Number(maxPatchBytes) : 20_000;
    const maximum = Math.max(0, Math.min(1_000_000, normalizedMaximum));
    const bytes = Buffer.from(redacted, "utf8");
    result.patchTruncated = bytes.length > maximum;
    result.patch = bytes.subarray(0, maximum).toString("utf8");
  }
  return result;
}

function exportMarkdown(bundle) {
  const lines = [
    `# AI Bridge Run ${bundle.run.runId}`,
    "",
    `- Status: ${bundle.run.status}`,
    `- Workspace: ${bundle.run.workspacePath}`,
    `- Current iteration: ${bundle.run.currentIteration}`,
    `- Verification: ${bundle.verification.status}`,
    "",
    "## Tasks",
    "",
    ...bundle.tasks.map((task) => `- Iteration ${task.iteration}: ${task.status} (${task.taskId})`),
  ];
  if (bundle.events?.length) {
    lines.push("", "## Transcript", "", ...bundle.events.map((event) => `- ${event.text ?? JSON.stringify(event)}`));
  }
  if (bundle.diff) {
    lines.push("", "## Changes", "", "```text", bundle.diff.gitStatus || "No changes.", "```");
  }
  return `${lines.join("\n")}\n`;
}

export async function exportRun({
  runId,
  format = "json",
  outputPath,
  includeTranscript = true,
  includeStreamJson = false,
  includePatch = false,
} = {}) {
  if (!["json", "markdown"].includes(format)) throw new Error("format must be json or markdown.");
  const inspected = await inspectRun({ runId, includeEvents: includeTranscript, eventLimit: 500, includeLogs: false });
  const run = await readRun(runId);
  const diff = await showRunDiff({ runId, includePatch });
  const bundle = {
    exportedAt: nowIso(),
    run: inspected.run,
    tasks: inspected.tasks,
    verification: inspected.verification,
    usage: inspected.usage,
    diagnostics: inspected.diagnostics,
    events: includeTranscript ? inspected.events : undefined,
    diff,
  };
  if (includeStreamJson) {
    bundle.streamJson = [];
    for (const entry of (await readdir(run.runDir).catch(() => [])).filter((name) => /^iteration-\d+\.stream\.jsonl$/.test(name)).sort()) {
      bundle.streamJson.push({
        path: entry,
        content: redactSecrets(await readFile(path.join(run.runDir, entry), "utf8").catch(() => "")),
      });
    }
  }
  const exportsDir = path.join(bridgeRoot(), "exports");
  await mkdir(exportsDir, { recursive: true });
  let resolvedOutput;
  if (outputPath) {
    resolvedOutput = path.isAbsolute(outputPath)
      ? path.resolve(outputPath)
      : path.resolve(exportsDir, outputPath);
    ensureInside(exportsDir, resolvedOutput);
  } else {
    resolvedOutput = path.join(exportsDir, `${runId}.${format === "json" ? "json" : "md"}`);
  }
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  const content = redactSecrets(format === "json"
    ? `${JSON.stringify(bundle, null, 2)}\n`
    : exportMarkdown(bundle));
  let handle;
  try {
    handle = await open(resolvedOutput, "wx");
    await handle.writeFile(content, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Export already exists: ${resolvedOutput}`);
    throw error;
  } finally {
    await handle?.close();
  }
  return { runId, format, outputPath: resolvedOutput, bytes: Buffer.byteLength(content) };
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
  const updated = await mutateRun(runId, async (latest) => {
    if (!Number.isInteger(iteration) || !latest.completedIterations.includes(iteration)) {
      throw new Error(`Cannot record review for iteration ${iteration}; that iteration has not completed.`);
    }
    if (latest.status !== "awaiting_review" && !["failed", "timed_out"].includes(latest.status)) {
      throw new Error(`Cannot record review while run status is ${latest.status}.`);
    }
    latest.reviews = [...(latest.reviews ?? []), event];
    latest.status = outcome === "pass" ? "passed" : outcome === "needs_fix" ? "needs_fix" : "blocked";
    latest.updatedAt = nowIso();
    return latest;
  });
  return { status: "recorded", runId, runStatus: updated.status, reviewLogPath, nextIterationAllowed: outcome === "needs_fix" };
}

const HISTORIAN_DEFAULT_LIMIT = 20;
const HISTORIAN_MAX_LIMIT = 100;
const HISTORIAN_SNIPPET_CHARS = 500;
const HISTORIAN_MAX_FILE_BYTES = 1024 * 1024;
const HISTORIAN_MAX_TRANSCRIPT_EVENTS = 2000;
const HISTORIAN_MAX_PATCH_BYTES = 20_000;
const HISTORIAN_TERMINAL_RUN_STATES = new Set(["passed", "blocked", "cancelled", "failed", "timed_out"]);

function historianLimit(value) {
  const numeric = Number(value);
  return Math.max(1, Math.min(HISTORIAN_MAX_LIMIT, Number.isFinite(numeric) ? Math.trunc(numeric) : HISTORIAN_DEFAULT_LIMIT));
}

function historianWorkspaceIdentity(workspacePath) {
  if (workspacePath === undefined || workspacePath === null || workspacePath === "") return null;
  const normalizedPath = normalizePathForComparison(normalizeWorkspace(workspacePath));
  return {
    normalizedPath,
    workspaceKey: createHash("sha256").update(normalizedPath).digest("hex"),
  };
}

function historianWorkspaceMatches(run, identity) {
  if (!identity) return true;
  if (run.workspaceKey && run.workspaceKey === identity.workspaceKey) return true;
  const stored = run.workspacePathNormalized
    ? normalizePathForComparison(run.workspacePathNormalized)
    : run.workspacePath ? normalizePathForComparison(run.workspacePath) : null;
  return stored === identity.normalizedPath;
}

async function readBoundedText(filePath, maximumBytes = HISTORIAN_MAX_FILE_BYTES) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const metadata = await handle.stat();
    const requested = Math.max(0, Math.min(maximumBytes, metadata.size));
    const buffer = Buffer.alloc(requested);
    const { bytesRead } = requested > 0 ? await handle.read(buffer, 0, requested, 0) : { bytesRead: 0 };
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: metadata.size > requested,
      size: metadata.size,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { text: "", truncated: false, size: 0, missing: true };
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function loadBoundedJson(filePath, code, context = {}) {
  try {
    const bounded = await readBoundedText(filePath);
    if (bounded.missing) return { value: null, diagnostics: [], missing: true };
    if (bounded.truncated) {
      return {
        value: null,
        diagnostics: [{ code, ...context, file: path.basename(filePath), error: `file exceeds ${HISTORIAN_MAX_FILE_BYTES} byte limit` }],
      };
    }
    return { value: JSON.parse(bounded.text), diagnostics: [] };
  } catch (error) {
    return {
      value: null,
      diagnostics: [{ code, ...context, file: path.basename(filePath), error: error instanceof Error ? error.message : String(error) }],
    };
  }
}

async function loadBoundedJsonLines(filePath, code, context = {}, {
  maximumBytes = HISTORIAN_MAX_FILE_BYTES,
  maximumEvents = Number.POSITIVE_INFINITY,
  truncationCode = `${code}_scan_truncated`,
} = {}) {
  try {
    const bounded = await readBoundedText(filePath, maximumBytes);
    if (bounded.missing) return { values: [], diagnostics: [], missing: true };
    const values = [];
    const diagnostics = [];
    const lines = bounded.text.split(/\r?\n/);
    for (let index = 0; index < lines.length && values.length < maximumEvents; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line));
      } catch (error) {
        diagnostics.push({
          code,
          ...context,
          file: path.basename(filePath),
          line: index + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (bounded.truncated || values.length >= maximumEvents) {
      diagnostics.push({
        code: truncationCode,
        ...context,
        file: path.basename(filePath),
        maxBytes: maximumBytes,
        maxEvents: Number.isFinite(maximumEvents) ? maximumEvents : null,
      });
    }
    return { values, diagnostics };
  } catch (error) {
    return {
      values: [],
      diagnostics: [{ code, ...context, file: path.basename(filePath), error: error instanceof Error ? error.message : String(error) }],
    };
  }
}

function historianSnippet(text, maximum = HISTORIAN_SNIPPET_CHARS) {
  const redacted = redactSecrets(String(text ?? "")).replace(/\s+/g, " ").trim();
  if (redacted.length <= maximum) return redacted;
  return `${redacted.slice(0, Math.max(0, maximum - 14))}…[truncated]`;
}

function historianText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function historianQueryMatch(value, query) {
  if (!query) return false;
  return historianText(value).toLowerCase().includes(String(query).trim().toLowerCase());
}

function historianCursorFingerprint(scope) {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 24);
}

function makeHistorianCursor(offset, scope) {
  return Buffer.from(JSON.stringify({ v: 1, offset, fingerprint: historianCursorFingerprint(scope) }), "utf8").toString("base64url");
}

function parseHistorianCursor(cursor, scope) {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (
      decoded?.v !== 1
      || !Number.isInteger(decoded.offset)
      || decoded.offset < 0
      || decoded.fingerprint !== historianCursorFingerprint(scope)
    ) {
      throw new Error("cursor does not match this Historian query");
    }
    return decoded.offset;
  } catch (error) {
    throw new Error(`Invalid Historian cursor: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function paginateHistorian(matches, { limit, cursor, scope }) {
  const normalizedLimit = historianLimit(limit);
  const offset = parseHistorianCursor(cursor, scope);
  const page = matches.slice(offset, offset + normalizedLimit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < matches.length;
  return {
    matches: page,
    nextCursor: hasMore ? makeHistorianCursor(nextOffset, scope) : null,
    hasMore,
  };
}

function historianDate(value, fieldName) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${fieldName} must be a valid ISO timestamp.`);
  return parsed;
}

function historianTaskTerminal(status) {
  return TERMINAL_TASK_STATES.has(status);
}

async function loadHistorianTasks() {
  const tasksByRun = new Map();
  const diagnostics = [];
  const entries = await readdir(tasksRoot(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
    const taskId = entry.name.slice(0, -5);
    const loaded = await loadBoundedJson(path.join(tasksRoot(), entry.name), "task_state_corrupt", { taskId });
    diagnostics.push(...loaded.diagnostics);
    if (!loaded.value || typeof loaded.value.runId !== "string") continue;
    const list = tasksByRun.get(loaded.value.runId) ?? [];
    list.push(loaded.value);
    tasksByRun.set(loaded.value.runId, list);
  }
  for (const tasks of tasksByRun.values()) {
    tasks.sort((a, b) => Number(a.iteration ?? 0) - Number(b.iteration ?? 0) || String(a.taskId).localeCompare(String(b.taskId)));
  }
  return { tasksByRun, diagnostics };
}

async function loadHistorianTranscripts(runDir, runId) {
  const entries = await readdir(runDir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isFile() && (/^iteration-\d+\.transcript\.jsonl$/.test(entry.name) || entry.name === "transcript.jsonl"))
    .map((entry) => entry.name)
    .sort();
  const values = [];
  const diagnostics = [];
  let remainingBytes = HISTORIAN_MAX_FILE_BYTES;
  for (const name of names) {
    if (remainingBytes <= 0 || values.length >= HISTORIAN_MAX_TRANSCRIPT_EVENTS) break;
    const parsed = await loadBoundedJsonLines(
      path.join(runDir, name),
      "transcript_line_corrupt",
      { runId },
      {
        maximumBytes: remainingBytes,
        maximumEvents: HISTORIAN_MAX_TRANSCRIPT_EVENTS - values.length,
        truncationCode: "transcript_scan_truncated",
      },
    );
    values.push(...parsed.values);
    diagnostics.push(...parsed.diagnostics);
    const size = await stat(path.join(runDir, name)).then((item) => item.size).catch(() => 0);
    remainingBytes -= Math.min(remainingBytes, size);
  }
  return { values, diagnostics };
}

async function loadHistorianRecords({ includeEvents = false } = {}) {
  const taskResult = await loadHistorianTasks();
  const diagnostics = [...taskResult.diagnostics];
  const records = [];
  const entries = await readdir(runsRoot(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const runId = entry.name;
    const runDir = path.join(runsRoot(), runId);
    const runResult = await loadBoundedJson(path.join(runDir, "run.json"), "run_state_corrupt", { runId });
    diagnostics.push(...runResult.diagnostics);
    if (!runResult.value || typeof runResult.value !== "object") continue;
    const reviewResult = await loadBoundedJsonLines(path.join(runDir, "reviews.jsonl"), "review_line_corrupt", { runId });
    const verificationResult = await loadBoundedJsonLines(path.join(runDir, "verification.jsonl"), "verification_line_corrupt", { runId });
    const snapshotResult = await loadBoundedJson(path.join(runDir, "snapshot.json"), "snapshot_state_corrupt", { runId });
    const eventResult = includeEvents
      ? await loadHistorianTranscripts(runDir, runId)
      : { values: [], diagnostics: [] };
    diagnostics.push(
      ...reviewResult.diagnostics,
      ...verificationResult.diagnostics,
      ...snapshotResult.diagnostics,
      ...eventResult.diagnostics,
    );
    if (reviewResult.missing && ["passed", "needs_fix", "blocked"].includes(runResult.value.status)) {
      diagnostics.push({ code: "review_file_missing", runId, file: "reviews.jsonl" });
    }
    const embeddedReviews = Array.isArray(runResult.value.reviews) ? runResult.value.reviews : [];
    const reviews = [...reviewResult.values];
    for (const review of embeddedReviews) {
      if (!reviews.some((item) => item.iteration === review.iteration && item.outcome === review.outcome && item.recordedAt === review.recordedAt)) {
        reviews.push(review);
      }
    }
    if (
      verificationResult.missing
      && reviews.some((review) => Array.isArray(review.verificationCommandsRun) && review.verificationCommandsRun.length > 0)
    ) {
      diagnostics.push({ code: "verification_file_missing", runId, file: "verification.jsonl" });
    }
    records.push({
      run: runResult.value,
      runDir,
      tasks: taskResult.tasksByRun.get(runId) ?? [],
      reviews,
      verification: verificationResult.values,
      snapshot: snapshotResult.value,
      events: eventResult.values,
    });
  }
  return { records, diagnostics };
}

function historianRunUpdatedAt(run) {
  return run.updatedAt ?? run.completedAt ?? run.createdAt ?? "";
}

function historianLastTask(record) {
  return record.tasks.find((task) => task.taskId === record.run.lastTaskId)
    ?? record.tasks.at(-1)
    ?? null;
}

function historianRunSort(a, b) {
  return Number(b.score ?? 0) - Number(a.score ?? 0)
    || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
    || String(a.runId).localeCompare(String(b.runId));
}

function historianDiagnosticKey(item) {
  return JSON.stringify([item.code, item.runId, item.taskId, item.file, item.line, item.error]);
}

function uniqueHistorianDiagnostics(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = historianDiagnosticKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function historianScopedDiagnostics(items, identity, records) {
  if (!identity) return uniqueHistorianDiagnostics(items);
  const eligibleRunIds = new Set(
    records
      .filter((record) => historianWorkspaceMatches(record.run, identity))
      .map((record) => record.run.runId),
  );
  return uniqueHistorianDiagnostics(items.filter((item) => item.runId && eligibleRunIds.has(item.runId)));
}

export async function searchRuns({
  workspacePath,
  query,
  status,
  since,
  until,
  limit = HISTORIAN_DEFAULT_LIMIT,
  cursor,
  includeTerminal = true,
  includeEvents = false,
} = {}) {
  const identity = historianWorkspaceIdentity(workspacePath);
  const statuses = status === undefined
    ? []
    : (Array.isArray(status) ? status : [status]).map((item) => String(item));
  const sinceTime = historianDate(since, "since");
  const untilTime = historianDate(until, "until");
  const normalizedQuery = String(query ?? "").trim();
  const loaded = await loadHistorianRecords({ includeEvents: Boolean(includeEvents) });
  const matches = [];
  for (const record of loaded.records) {
    const { run } = record;
    if (!historianWorkspaceMatches(run, identity)) continue;
    if (!includeTerminal && HISTORIAN_TERMINAL_RUN_STATES.has(run.status)) continue;
    if (statuses.length > 0 && !statuses.includes(run.status)) continue;
    const updatedAt = historianRunUpdatedAt(run);
    const updatedTime = Date.parse(updatedAt);
    if (sinceTime !== null && (!Number.isFinite(updatedTime) || updatedTime < sinceTime)) continue;
    if (untilTime !== null && (!Number.isFinite(updatedTime) || updatedTime > untilTime)) continue;

    let score = 0;
    const reasons = [];
    const snippets = [];
    const exactRun = normalizedQuery && normalizedQuery === run.runId;
    const exactTask = normalizedQuery && record.tasks.some((task) => task.taskId === normalizedQuery);
    if (exactRun) {
      score += 10_000;
      reasons.push("exact_run_id");
    }
    if (exactTask) {
      score += 9_000;
      reasons.push("exact_task_id");
    }
    if (identity) {
      score += 1_000;
      reasons.push("workspace_exact");
    }
    if (statuses.length > 0) {
      score += 500;
      reasons.push("status_match");
    }

    const querySources = [
      { source: "run", value: [run.runId, run.status, run.task].join(" ") },
      ...record.tasks.map((task) => ({ source: "task", value: [task.taskId, task.prompt, task.task, task.stderr].join(" ") })),
      ...record.verification.map((item) => ({ source: "verification", value: [item.command, item.stdout, item.stderr].join(" ") })),
      ...record.reviews.map((item) => ({ source: "review", value: [item.outcome, ...(item.findings ?? [])].join(" ") })),
      ...(includeEvents ? record.events.map((item) => ({ source: "transcript", value: historianText(item) })) : []),
      ...(record.snapshot ? [{ source: "diff", value: historianText(record.snapshot) }] : []),
    ];
    if (normalizedQuery) {
      const queryMatches = querySources.filter((item) => historianQueryMatch(item.value, normalizedQuery));
      if (!exactRun && !exactTask && queryMatches.length === 0) continue;
      for (const item of queryMatches.slice(0, 5)) {
        score += 100;
        if (!reasons.includes(`query_${item.source}`)) reasons.push(`query_${item.source}`);
        snippets.push({ source: item.source, text: historianSnippet(item.value), redacted: true });
      }
    }
    const lastTask = historianLastTask(record);
    matches.push({
      runId: run.runId,
      status: run.status ?? null,
      workspacePath: run.workspacePath ?? null,
      workspacePathNormalized: run.workspacePathNormalized ?? (run.workspacePath ? normalizePathForComparison(run.workspacePath) : null),
      workspaceKey: run.workspaceKey ?? (run.workspacePath ? createHash("sha256").update(normalizePathForComparison(run.workspacePath)).digest("hex") : null),
      repoFingerprint: run.workspaceIdentity?.repoFingerprint ?? null,
      updatedAt,
      lastTaskStatus: lastTask?.status ?? null,
      claudeSessionId: run.claudeSessionId ?? null,
      score,
      reasons,
      snippets,
    });
  }
  matches.sort(historianRunSort);
  const scope = {
    tool: "runs",
    workspace: identity?.workspaceKey ?? null,
    query: normalizedQuery.toLowerCase(),
    statuses: [...statuses].sort(),
    since: since ?? null,
    until: until ?? null,
    includeTerminal: Boolean(includeTerminal),
    includeEvents: Boolean(includeEvents),
  };
  return {
    ...paginateHistorian(matches, { limit, cursor, scope }),
    diagnostics: historianScopedDiagnostics(loaded.diagnostics, identity, loaded.records),
  };
}

function historianVerificationStatus(item) {
  if (item.timedOut) return "timed_out";
  return Number(item.exitCode) === 0 ? "passed" : "failed";
}

function historianRetryable(record, taskStatus) {
  if (taskStatus === "cancelled") return false;
  const iteration = Math.max(0, ...record.tasks.map((task) => Number(task.iteration ?? 0)));
  return !["passed", "blocked", "cancelled"].includes(record.run.status)
    && iteration < Number(record.run.maxIterations ?? DEFAULT_MAX_ITERATIONS);
}

const REVIEW_LIMITATION_PATTERN = /\b(?:partial pass|not passed|did not (?:validate|verify|prove|test)|not validated|failed criterion|gate (?:failed|was not passed)|remains? unverified)\b/i;

export async function searchErrors({
  workspacePath,
  query,
  limit = HISTORIAN_DEFAULT_LIMIT,
  cursor,
} = {}) {
  const identity = historianWorkspaceIdentity(workspacePath);
  const normalizedQuery = String(query ?? "").trim();
  const loaded = await loadHistorianRecords({ includeEvents: true });
  const matches = [];
  const add = (record, item) => {
    if (normalizedQuery && !historianQueryMatch(item, normalizedQuery)) return;
    matches.push({
      ...item,
      snippet: historianSnippet(item.snippet),
      updatedAt: historianRunUpdatedAt(record.run),
    });
  };
  for (const record of loaded.records) {
    if (!historianWorkspaceMatches(record.run, identity)) continue;
    for (const task of record.tasks) {
      if (["failed", "timed_out", "cancelled"].includes(task.status)) {
        add(record, {
          errorType: `${task.status}_task`,
          runId: record.run.runId,
          taskId: task.taskId ?? null,
          source: "task",
          snippet: task.stderr || task.error || `${task.status} task`,
          terminal: historianTaskTerminal(task.status),
          retryable: historianRetryable(record, task.status),
        });
      }
    }
    for (const item of record.verification) {
      if (historianVerificationStatus(item) !== "passed") {
        add(record, {
          errorType: "verification_failed",
          runId: record.run.runId,
          taskId: record.run.lastTaskId ?? null,
          source: "verification",
          snippet: item.stderr || item.stdout || item.command || "verification failed",
          terminal: true,
          retryable: record.run.status === "needs_fix",
        });
      }
    }
    for (const review of record.reviews.filter((item) => item.outcome === "needs_fix")) {
      add(record, {
        errorType: "needs_fix_review",
        runId: record.run.runId,
        taskId: record.run.lastTaskId ?? null,
        source: "review",
        snippet: (review.findings ?? []).join(" ") || "needs_fix review",
        terminal: true,
        retryable: Number(review.iteration ?? 0) < Number(record.run.maxIterations ?? DEFAULT_MAX_ITERATIONS),
      });
    }
    for (const review of record.reviews.filter((item) => item.outcome === "pass")) {
      const findings = (review.findings ?? []).map(historianText);
      const limitationFindings = findings.filter((finding) => REVIEW_LIMITATION_PATTERN.test(finding));
      if (limitationFindings.length === 0) continue;
      const queryFindings = normalizedQuery
        ? findings.filter((finding) => historianQueryMatch(finding, normalizedQuery))
        : [];
      const orderedFindings = [...new Set([...queryFindings, ...limitationFindings, ...findings])];
      add(record, {
        errorType: "review_limitation",
        runId: record.run.runId,
        taskId: record.tasks.find((task) => Number(task.iteration) === Number(review.iteration))?.taskId ?? record.run.lastTaskId ?? null,
        source: "review",
        reviewOutcome: "pass",
        snippet: orderedFindings.join(" "),
        terminal: true,
        retryable: false,
      });
    }
    for (const event of record.events) {
      if (event?.kind === "error" || event?.type === "error" || historianQueryMatch(event?.text, "Error:")) {
        add(record, {
          errorType: "transcript_error",
          runId: record.run.runId,
          taskId: event.taskId ?? record.run.lastTaskId ?? null,
          source: "transcript",
          snippet: event.text ?? event.message ?? historianText(event),
          terminal: false,
          retryable: null,
        });
      }
    }
  }
  const eligibleByRunId = new Map(
    loaded.records
      .filter((record) => historianWorkspaceMatches(record.run, identity))
      .map((record) => [record.run.runId, record]),
  );
  const diagnosticTypes = new Map([
    ["transcript_line_corrupt", "transcript_corrupt"],
    ["verification_line_corrupt", "verification_corrupt"],
    ["review_line_corrupt", "review_corrupt"],
    ["run_state_corrupt", "run_state_corrupt"],
    ["task_state_corrupt", "task_state_corrupt"],
    ["snapshot_state_corrupt", "snapshot_corrupt"],
    ["review_file_missing", "review_file_missing"],
    ["verification_file_missing", "verification_file_missing"],
  ]);
  for (const diagnostic of loaded.diagnostics) {
    const errorType = diagnosticTypes.get(diagnostic.code);
    if (!errorType) continue;
    const record = diagnostic.runId ? eligibleByRunId.get(diagnostic.runId) : null;
    if (identity && !record) continue;
    add(record ?? { run: { updatedAt: "" } }, {
      errorType,
      runId: diagnostic.runId ?? null,
      taskId: diagnostic.taskId ?? null,
      source: "diagnostic",
      snippet: [diagnostic.code, diagnostic.file, diagnostic.line ? `line ${diagnostic.line}` : null, diagnostic.error].filter(Boolean).join(" "),
      terminal: false,
      retryable: null,
    });
  }
  matches.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    || String(a.runId).localeCompare(String(b.runId))
    || String(a.errorType).localeCompare(String(b.errorType)));
  const scope = {
    tool: "errors",
    workspace: identity?.workspaceKey ?? null,
    query: normalizedQuery.toLowerCase(),
  };
  return {
    ...paginateHistorian(matches, { limit, cursor, scope }),
    diagnostics: historianScopedDiagnostics(loaded.diagnostics, identity, loaded.records),
  };
}

export async function searchVerification({
  workspacePath,
  command,
  query,
  exitCode,
  status,
  limit = HISTORIAN_DEFAULT_LIMIT,
  cursor,
} = {}) {
  const identity = historianWorkspaceIdentity(workspacePath);
  const normalizedCommand = String(command ?? "").trim().toLowerCase();
  const normalizedQuery = String(query ?? "").trim();
  const loaded = await loadHistorianRecords();
  const matches = [];
  for (const record of loaded.records) {
    if (!historianWorkspaceMatches(record.run, identity)) continue;
    for (const item of record.verification) {
      const itemStatus = historianVerificationStatus(item);
      if (normalizedCommand && !String(item.command ?? "").toLowerCase().includes(normalizedCommand)) continue;
      if (exitCode !== undefined && Number(item.exitCode) !== Number(exitCode)) continue;
      if (status && itemStatus !== status) continue;
      if (normalizedQuery && !historianQueryMatch([item.command, item.stdout, item.stderr].join(" "), normalizedQuery)) continue;
      matches.push({
        runId: record.run.runId,
        taskId: record.run.lastTaskId ?? null,
        workspacePath: record.run.workspacePath ?? null,
        command: item.command ?? null,
        exitCode: item.exitCode ?? null,
        status: itemStatus,
        timedOut: Boolean(item.timedOut),
        startedAt: item.startedAt ?? null,
        finishedAt: item.finishedAt ?? null,
        durationMs: Number.isFinite(Date.parse(item.finishedAt) - Date.parse(item.startedAt))
          ? Math.max(0, Date.parse(item.finishedAt) - Date.parse(item.startedAt))
          : null,
        stdout: historianSnippet(item.stdout),
        stderr: historianSnippet(item.stderr),
        updatedAt: item.finishedAt ?? historianRunUpdatedAt(record.run),
      });
    }
  }
  matches.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    || String(a.runId).localeCompare(String(b.runId))
    || String(a.command).localeCompare(String(b.command)));
  const scope = {
    tool: "verification",
    workspace: identity?.workspaceKey ?? null,
    command: normalizedCommand,
    query: normalizedQuery.toLowerCase(),
    exitCode: exitCode ?? null,
    status: status ?? null,
  };
  return {
    ...paginateHistorian(matches, { limit, cursor, scope }),
    diagnostics: historianScopedDiagnostics(loaded.diagnostics, identity, loaded.records),
  };
}

function historianChangeType(status, untracked = false) {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (untracked || normalized === "??") return "untracked";
  if (normalized.startsWith("R")) return "renamed";
  if (normalized.startsWith("A")) return "added";
  if (normalized.startsWith("D")) return "deleted";
  return "modified";
}

function historianSnapshotChanges(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const pathSet = (values) => new Set((values ?? []).map((item) => typeof item === "string" ? item : item?.path).filter(Boolean));
  const createdAfterPreflight = pathSet(snapshot.changesCreatedAfterPreflight);
  const modifiedPreExisting = pathSet(snapshot.modifiedPreExistingChanges);
  const preExisting = new Set([
    ...pathSet(snapshot.preExistingChanges),
    ...pathSet(snapshot.preExistingUntrackedFiles),
    ...pathSet(snapshot.preExistingStagedChanges),
  ]);
  const changes = [];
  const add = (entry, untracked = false) => {
    const value = typeof entry === "string" ? { path: entry, status: untracked ? "??" : "M" } : entry;
    if (!value?.path) return;
    const change = {
      path: value.path,
      originalPath: value.originalPath ?? null,
      status: value.status ?? (untracked ? "??" : "M"),
      changeType: historianChangeType(value.status, untracked),
      changeOrigin: createdAfterPreflight.has(value.path)
        ? "created_after_preflight"
        : modifiedPreExisting.has(value.path)
          ? "modified_pre_existing"
          : preExisting.has(value.path)
            ? "pre_existing"
            : "unknown",
    };
    if (!changes.some((item) => item.path === change.path && item.changeType === change.changeType && item.originalPath === change.originalPath)) {
      changes.push(change);
    }
  };
  for (const item of snapshot.changedFiles ?? []) add(item);
  for (const item of snapshot.stagedChanges ?? []) add(item);
  for (const item of snapshot.unstagedChanges ?? []) add(item);
  for (const item of snapshot.renamedFiles ?? []) add({ ...item, status: item.status ?? "R" });
  for (const item of snapshot.untrackedFiles ?? []) add(item, true);
  return changes;
}

export async function searchChangedFiles({
  workspacePath,
  path: requestedPath,
  query,
  status,
  limit = HISTORIAN_DEFAULT_LIMIT,
  cursor,
  includePatch = false,
} = {}) {
  const identity = historianWorkspaceIdentity(workspacePath);
  const pathQuery = String(requestedPath ?? query ?? "").trim().toLowerCase().replaceAll("\\", "/");
  const loaded = await loadHistorianRecords();
  const matches = [];
  const diagnostics = [...historianScopedDiagnostics(loaded.diagnostics, identity, loaded.records)];
  for (const record of loaded.records) {
    if (!historianWorkspaceMatches(record.run, identity)) continue;
    if (status && record.run.status !== status) continue;
    const changes = historianSnapshotChanges(record.snapshot);
    let patchInfo = null;
    if (includePatch) {
      const rawPatch = typeof record.snapshot?.patch === "string" ? record.snapshot.patch : null;
      if (rawPatch === null) {
        if (changes.some((change) => !pathQuery || change.path.toLowerCase().replaceAll("\\", "/").includes(pathQuery))) {
          diagnostics.push({ code: "patch_unavailable", runId: record.run.runId, message: "No persisted patch exists; Historian did not execute git diff." });
        }
      } else {
        const redacted = redactSecrets(rawPatch);
        const bytes = Buffer.from(redacted, "utf8");
        patchInfo = {
          patch: bytes.subarray(0, HISTORIAN_MAX_PATCH_BYTES).toString("utf8"),
          patchTruncated: Buffer.byteLength(rawPatch, "utf8") > HISTORIAN_MAX_PATCH_BYTES || bytes.length > HISTORIAN_MAX_PATCH_BYTES,
        };
      }
    }
    for (const change of changes) {
      const searchable = `${change.path} ${change.originalPath ?? ""}`.toLowerCase().replaceAll("\\", "/");
      if (pathQuery && !searchable.includes(pathQuery)) continue;
      const warning = sensitivePathReason(change.path);
      const result = {
        runId: record.run.runId,
        runStatus: record.run.status ?? null,
        workspacePath: record.run.workspacePath ?? null,
        ...change,
        sensitivePathWarnings: warning ? [{ path: change.path, reason: warning }] : [],
        updatedAt: historianRunUpdatedAt(record.run),
      };
      if (includePatch) {
        result.patch = patchInfo?.patch ?? null;
        result.patchTruncated = patchInfo?.patchTruncated ?? false;
      }
      matches.push(result);
    }
  }
  matches.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    || String(a.runId).localeCompare(String(b.runId))
    || String(a.path).localeCompare(String(b.path)));
  const scope = {
    tool: "changed_files",
    workspace: identity?.workspaceKey ?? null,
    path: pathQuery,
    status: status ?? null,
    includePatch: Boolean(includePatch),
  };
  return {
    ...paginateHistorian(matches, { limit, cursor, scope }),
    diagnostics: uniqueHistorianDiagnostics(diagnostics),
  };
}

export async function searchReviews({
  workspacePath,
  outcome,
  query,
  limit = HISTORIAN_DEFAULT_LIMIT,
  cursor,
} = {}) {
  const identity = historianWorkspaceIdentity(workspacePath);
  const normalizedQuery = String(query ?? "").trim();
  const loaded = await loadHistorianRecords();
  const matches = [];
  for (const record of loaded.records) {
    if (!historianWorkspaceMatches(record.run, identity)) continue;
    for (const review of record.reviews) {
      if (outcome && review.outcome !== outcome) continue;
      const note = (review.findings ?? []).map(historianText).join(" ");
      if (normalizedQuery && !historianQueryMatch([review.outcome, note].join(" "), normalizedQuery)) continue;
      matches.push({
        runId: record.run.runId,
        taskId: record.tasks.find((task) => Number(task.iteration) === Number(review.iteration))?.taskId ?? record.run.lastTaskId ?? null,
        workspacePath: record.run.workspacePath ?? null,
        iteration: review.iteration ?? null,
        outcome: review.outcome ?? null,
        findings: (review.findings ?? []).map((item) => historianSnippet(historianText(item))),
        nextIterationAllowed: review.outcome === "needs_fix"
          && Number(review.iteration ?? 0) < Number(record.run.maxIterations ?? DEFAULT_MAX_ITERATIONS),
        recordedAt: review.recordedAt ?? null,
        updatedAt: review.recordedAt ?? historianRunUpdatedAt(record.run),
      });
    }
  }
  matches.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    || String(a.runId).localeCompare(String(b.runId))
    || Number(b.iteration ?? 0) - Number(a.iteration ?? 0));
  const scope = {
    tool: "reviews",
    workspace: identity?.workspaceKey ?? null,
    outcome: outcome ?? null,
    query: normalizedQuery.toLowerCase(),
  };
  return {
    ...paginateHistorian(matches, { limit, cursor, scope }),
    diagnostics: historianScopedDiagnostics(loaded.diagnostics, identity, loaded.records),
  };
}

function selectWorkspaceMemoryChangedFiles(matches, limit) {
  const priority = new Map([
    ["created_after_preflight", 0],
    ["modified_pre_existing", 1],
    ["unknown", 2],
    ["pre_existing", 3],
  ]);
  const seen = new Set();
  return matches
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (priority.get(a.item.changeOrigin) ?? 9) - (priority.get(b.item.changeOrigin) ?? 9) || a.index - b.index)
    .filter(({ item }) => {
      const key = String(item.path).replaceAll("\\", "/").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ item }) => item);
}

const FAILURE_PATTERN_SEVERITY = new Map([
  ["high", 0],
  ["medium", 1],
  ["low", 2],
]);

const REVIEW_FAILURE_PATTERN = /\b(?:partial pass|weak pass|not passed|unverified|did not (?:validate|verify|prove|test)|does not prove|cannot prove|not validated)\b/i;

function failurePatternEvidence(record, {
  taskId = null,
  reviewOutcome = null,
  source,
  timestamp,
  snippet,
}) {
  return {
    runId: record.run.runId,
    taskId: taskId ?? record.run.lastTaskId ?? null,
    reviewOutcome,
    source,
    timestamp: timestamp ?? historianRunUpdatedAt(record.run),
    snippet: historianSnippet(snippet),
  };
}

function failurePatternSort(a, b) {
  return (FAILURE_PATTERN_SEVERITY.get(a.severity) ?? 9) - (FAILURE_PATTERN_SEVERITY.get(b.severity) ?? 9)
    || String(b.latestEvidenceAt ?? "").localeCompare(String(a.latestEvidenceAt ?? ""))
    || Number(b.evidenceRuns?.length ?? 0) - Number(a.evidenceRuns?.length ?? 0)
    || String(a.patternId).localeCompare(String(b.patternId));
}

function finalizeFailurePattern(pattern) {
  const evidenceRuns = [...(pattern.evidenceRuns ?? [])]
    .sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? ""))
      || String(a.runId).localeCompare(String(b.runId)));
  return {
    ...pattern,
    summary: historianSnippet(pattern.summary),
    evidenceRuns,
    affectedFiles: [...new Set(pattern.affectedFiles ?? [])].sort(),
    latestEvidenceAt: evidenceRuns[0]?.timestamp ?? null,
  };
}

function reviewLimitationKind(text) {
  const value = String(text ?? "");
  if (/in[- ]flight disconnect|disconnect.*(?:completedAt|timestamp)|automatic reconnect/i.test(value)) {
    return {
      id: "in_flight_disconnect",
      title: "In-flight disconnect validations can be overclaimed",
      summary: "Past reviews recorded pass outcomes while still noting unverified reconnect or in-flight disconnect boundaries.",
      reminder: "When validating disconnect behavior, compare disconnect completedAt against Claude completedAt before marking pass.",
      check: "Do not let a persisted pass outcome override a later timestamp-based validation verdict.",
    };
  }
  if (/running-state|running state|polling/i.test(value)) {
    return {
      id: "running_state_polling",
      title: "Running-state polling may remain unverified",
      summary: "Past review evidence recorded an unverified running-state polling boundary.",
      reminder: "Exercise running-state polling separately from completed-task recovery.",
      check: "Require direct running-state polling evidence before claiming reconnect coverage.",
    };
  }
  if (/live replay/i.test(value)) {
    return {
      id: "live_replay",
      title: "Live replay may remain unverified",
      summary: "Past review evidence recorded an unverified live replay boundary.",
      reminder: "Treat live replay as a separate validation target.",
      check: "Do not infer live replay from persisted completed-task recovery.",
    };
  }
  return {
    id: "general",
    title: "Persisted reviews contain validation limitations",
    summary: "Past reviews include partial-pass, weak-pass, not-passed, or unverified evidence.",
    reminder: "Read persisted review findings before reusing a historical pass outcome.",
    check: "Treat limitation wording as authoritative context alongside the persisted review outcome.",
  };
}

function changedFileRiskReason(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/");
  if (normalized === "CONTEXT_HANDOFF.md") {
    return "Follow-up documentation corrections recur in problem runs; verify the handoff against the final source and CI evidence.";
  }
  if (/^docs\/validation\//i.test(normalized)) {
    return "This is validation evidence that was corrected in problem runs; treat it as verdict evidence rather than defect location.";
  }
  if (/^hatch-pet-runs\//i.test(normalized)) {
    return "Pre-existing user artifact noise can contaminate changed-file attribution.";
  }
  return "This path recurs in failed, cancelled, timed-out, blocked, needs-fix, or review-limited history.";
}

export async function summarizeFailurePatterns({
  workspacePath,
  since,
  until,
  limit = HISTORIAN_DEFAULT_LIMIT,
  includePassedLimitations = true,
  includeVerificationFailures = true,
  includeReviewLimitations = true,
  includeChangedFileRisks = true,
  includePreflightRisks = true,
} = {}) {
  const identity = historianWorkspaceIdentity(workspacePath);
  if (!identity) throw new Error("workspacePath is required.");
  const sinceTime = historianDate(since, "since");
  const untilTime = historianDate(until, "until");
  const normalizedLimit = historianLimit(limit);
  const loaded = await loadHistorianRecords();
  const records = loaded.records.filter((record) => {
    if (!historianWorkspaceMatches(record.run, identity)) return false;
    const updatedTime = Date.parse(historianRunUpdatedAt(record.run));
    if (sinceTime !== null && (!Number.isFinite(updatedTime) || updatedTime < sinceTime)) return false;
    if (untilTime !== null && (!Number.isFinite(updatedTime) || updatedTime > untilTime)) return false;
    return true;
  });
  const patterns = [];

  if (includeVerificationFailures) {
    const byCommand = new Map();
    for (const record of records) {
      for (const verification of record.verification) {
        const status = historianVerificationStatus(verification);
        const explicitStatus = String(verification.status ?? "").toLowerCase();
        const stderrHasError = /\b(?:error|failed|failure|fatal|exception|timed[ -]?out)\b/i.test(String(verification.stderr ?? ""));
        if (status === "passed" && !["failed", "timed_out"].includes(explicitStatus) && !stderrHasError) continue;
        const command = String(verification.command ?? "(unknown command)");
        const key = command.toLowerCase();
        const pattern = byCommand.get(key) ?? {
          patternId: `verification_failure:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
          type: "verification_failure",
          severity: "high",
          title: `Verification command has failed: ${command}`,
          command,
          failureCount: 0,
          evidenceRuns: [],
          affectedFiles: [],
          suggestedPreflightReminder: `Run ${command} before handoff and preserve its exit code and bounded stderr.`,
          suggestedReviewCheck: "Do not mark validation passed while a required verification command is failed or timed out.",
          confidence: "high",
        };
        pattern.failureCount += 1;
        pattern.evidenceRuns.push(failurePatternEvidence(record, {
          source: "verification",
          timestamp: verification.finishedAt,
          snippet: verification.stderr || verification.stdout || `${command} ${status}`,
        }));
        byCommand.set(key, pattern);
      }
    }
    for (const pattern of byCommand.values()) {
      pattern.summary = `${pattern.command} failed or timed out ${pattern.failureCount} time(s); latest bounded stderr: ${pattern.evidenceRuns[0]?.snippet ?? "unavailable"}`;
      patterns.push(finalizeFailurePattern(pattern));
    }
  }

  const limitationRecords = new Set();
  if (includeReviewLimitations) {
    const byKind = new Map();
    for (const record of records) {
      for (const review of record.reviews) {
        if (review.outcome === "pass" && !includePassedLimitations) continue;
        for (const finding of (review.findings ?? []).map(historianText)) {
          if (!REVIEW_FAILURE_PATTERN.test(finding)) continue;
          limitationRecords.add(record.run.runId);
          const kind = reviewLimitationKind(finding);
          const pattern = byKind.get(kind.id) ?? {
            patternId: `review_limitation:${kind.id}`,
            type: "review_limitation",
            severity: "medium",
            title: kind.title,
            summary: kind.summary,
            reviewOutcome: review.outcome ?? null,
            evidenceRuns: [],
            affectedFiles: [],
            suggestedPreflightReminder: kind.reminder,
            suggestedReviewCheck: kind.check,
            confidence: "high",
          };
          const evidence = failurePatternEvidence(record, {
            taskId: record.tasks.find((task) => Number(task.iteration) === Number(review.iteration))?.taskId,
            reviewOutcome: review.outcome ?? null,
            source: "review",
            timestamp: review.recordedAt,
            snippet: finding,
          });
          const existingEvidence = pattern.evidenceRuns.find((item) => item.runId === evidence.runId);
          if (existingEvidence) existingEvidence.snippet = historianSnippet(`${existingEvidence.snippet} ${evidence.snippet}`);
          else pattern.evidenceRuns.push(evidence);
          for (const change of historianSnapshotChanges(record.snapshot)) {
            if (/^docs\/validation\//i.test(change.path)) pattern.affectedFiles.push(change.path);
          }
          byKind.set(kind.id, pattern);
        }
      }
    }
    patterns.push(...[...byKind.values()].map(finalizeFailurePattern));
  }

  for (const record of records) {
    for (const task of record.tasks) {
      if (!["failed", "timed_out", "cancelled", "blocked"].includes(task.status)) continue;
      patterns.push(finalizeFailurePattern({
        patternId: `failed_or_cancelled_task:${task.status}:${task.taskId}`,
        type: "failed_or_cancelled_task",
        severity: task.status === "failed" || task.status === "timed_out" ? "high" : "medium",
        title: `Historical task ended as ${task.status}`,
        summary: task.stderr || task.error || `${task.status} task`,
        taskStatus: task.status,
        retryable: historianRetryable(record, task.status),
        evidenceRuns: [failurePatternEvidence(record, {
          taskId: task.taskId,
          source: "task",
          timestamp: task.completedAt,
          snippet: task.stderr || task.error || `${task.status} task`,
        })],
        affectedFiles: [],
        suggestedPreflightReminder: "Inspect the terminal task reason before retrying the same workflow.",
        suggestedReviewCheck: "Confirm retryability from persisted run state and iteration limits.",
        confidence: "high",
      }));
    }
  }

  if (includeChangedFileRisks) {
    const byPath = new Map();
    for (const record of records) {
      const problemRun = ["failed", "timed_out", "cancelled", "blocked", "needs_fix"].includes(record.run.status)
        || limitationRecords.has(record.run.runId);
      if (!problemRun) continue;
      for (const change of historianSnapshotChanges(record.snapshot)) {
        const normalizedPath = change.path.replaceAll("\\", "/");
        const groupedUserArtifacts = /^hatch-pet-runs(?:\/|$)/i.test(normalizedPath);
        const riskPath = groupedUserArtifacts ? "hatch-pet-runs/**" : change.path;
        const key = riskPath.replaceAll("\\", "/").toLowerCase();
        const risk = byPath.get(key) ?? {
          patternId: `changed_file_risk:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
          type: "changed_file_risk",
          severity: /^docs\/validation\//i.test(riskPath) ? "low" : "medium",
          title: `Path recurs in problem history: ${riskPath}`,
          summary: changedFileRiskReason(riskPath),
          path: riskPath,
          count: 0,
          changeOrigins: new Set(),
          relatedRuns: new Set(),
          riskReason: changedFileRiskReason(riskPath),
          evidenceRuns: [],
          affectedFiles: [],
          suggestedPreflightReminder: `Record whether ${riskPath} existed before preflight before attributing it to the next task.`,
          suggestedReviewCheck: "Separate validation-document corrections and pre-existing files from source-code defects.",
          confidence: "high",
        };
        risk.count += 1;
        risk.changeOrigins.add(change.changeOrigin);
        risk.relatedRuns.add(record.run.runId);
        risk.affectedFiles.push(change.path);
        const evidence = failurePatternEvidence(record, {
          source: "snapshot",
          snippet: `${change.path} ${change.changeOrigin}`,
        });
        const existingEvidence = risk.evidenceRuns.find((item) => item.runId === evidence.runId);
        if (existingEvidence) existingEvidence.snippet = historianSnippet(`${existingEvidence.snippet} ${evidence.snippet}`);
        else risk.evidenceRuns.push(evidence);
        byPath.set(key, risk);
      }
    }
    for (const risk of byPath.values()) {
      patterns.push(finalizeFailurePattern({
        ...risk,
        changeOrigins: [...risk.changeOrigins].sort(),
        relatedRuns: [...risk.relatedRuns].sort(),
      }));
    }
  }

  if (includePreflightRisks) {
    const untrackedEvidence = [];
    const modifiedEvidence = [];
    const invalidatedEvidence = [];
    for (const record of records) {
      const snapshot = record.snapshot;
      if (!snapshot || typeof snapshot !== "object") continue;
      const untracked = snapshot.preExistingUntrackedFiles ?? [];
      if (untracked.length > 0) {
        untrackedEvidence.push(failurePatternEvidence(record, {
          source: "snapshot",
          snippet: `Pre-existing untracked paths: ${untracked.join(", ")}`,
        }));
      }
      const modified = snapshot.modifiedPreExistingChanges ?? [];
      if (modified.length > 0) {
        modifiedEvidence.push(failurePatternEvidence(record, {
          source: "snapshot",
          snippet: `Modified pre-existing paths: ${modified.map((item) => item.path ?? item).join(", ")}`,
        }));
      }
      if (snapshot.baselineInvalidated) {
        invalidatedEvidence.push(failurePatternEvidence(record, {
          source: "snapshot",
          snippet: "Saved snapshot reports baselineInvalidated=true",
        }));
      }
    }
    if (untrackedEvidence.length > 0) {
      patterns.push(finalizeFailurePattern({
        patternId: "preflight_baseline_risk:pre_existing_untracked",
        type: "preflight_baseline_risk",
        severity: "medium",
        title: "Pre-existing untracked files can contaminate attribution",
        summary: "Historical snapshots contain pre-existing untracked baseline noise; user artifacts such as hatch-pet-runs must not be attributed to Claude.",
        evidenceRuns: untrackedEvidence,
        affectedFiles: [],
        suggestedPreflightReminder: "Preserve and report pre-existing untracked paths without reading their contents or attributing them to the task.",
        suggestedReviewCheck: "Compare snapshot changeOrigin before claiming a file was created by Claude.",
        confidence: "high",
      }));
    }
    if (modifiedEvidence.length > 0) {
      patterns.push(finalizeFailurePattern({
        patternId: "preflight_baseline_risk:modified_pre_existing",
        type: "preflight_baseline_risk",
        severity: "medium",
        title: "Pre-existing files were modified after preflight",
        summary: "Historical snapshots show modified pre-existing paths that require explicit attribution during review.",
        evidenceRuns: modifiedEvidence,
        affectedFiles: [],
        suggestedPreflightReminder: "Capture hashes for pre-existing changed files before implementation.",
        suggestedReviewCheck: "Review modified pre-existing files separately from files created after preflight.",
        confidence: "high",
      }));
    }
    if (invalidatedEvidence.length > 0) {
      patterns.push(finalizeFailurePattern({
        patternId: "preflight_baseline_risk:baseline_invalidated",
        type: "preflight_baseline_risk",
        severity: "high",
        title: "Historical git baseline was invalidated",
        summary: "A saved snapshot reports that the preflight baseline no longer matched the later workspace baseline.",
        evidenceRuns: invalidatedEvidence,
        affectedFiles: [],
        suggestedPreflightReminder: "Re-establish an authoritative baseline before comparing task changes.",
        suggestedReviewCheck: "Do not make source-attribution claims from an invalidated baseline.",
        confidence: "high",
      }));
    }
  }

  if (includeReviewLimitations) {
    const overclaimEvidence = [];
    for (const record of records) {
      for (const review of record.reviews) {
        if (review.outcome !== "pass" || !includePassedLimitations) continue;
        for (const finding of (review.findings ?? []).map(historianText)) {
          if (!REVIEW_FAILURE_PATTERN.test(finding)) continue;
          overclaimEvidence.push(failurePatternEvidence(record, {
            reviewOutcome: review.outcome,
            source: "review",
            timestamp: review.recordedAt,
            snippet: finding,
          }));
        }
      }
    }
    if (overclaimEvidence.length > 0) {
      patterns.push(finalizeFailurePattern({
        patternId: "validation_overclaim_risk:persisted_pass_with_later_limit",
        type: "validation_overclaim_risk",
        severity: "medium",
        title: "Persisted pass outcomes can overstate later validation evidence",
        summary: "Distinguish completed-task recovery, in-flight disconnect, running-state polling, automatic reconnect, and live replay; a pass in one boundary does not prove the others.",
        evidenceRuns: overclaimEvidence,
        affectedFiles: [],
        suggestedPreflightReminder: "Define authoritative timestamps and separate reconnect boundaries before validation.",
        suggestedReviewCheck: "Compare authoritative completion timestamps and the final documented verdict instead of relying only on a persisted pass outcome.",
        confidence: "high",
      }));
    }
  }

  patterns.sort(failurePatternSort);
  const limitedPatterns = patterns.slice(0, normalizedLimit);
  const topVerificationRisks = limitedPatterns.filter((item) => item.type === "verification_failure");
  const topChangedFileRisks = limitedPatterns.filter((item) => item.type === "changed_file_risk");
  const preflightReminders = [...new Set(limitedPatterns.map((item) => item.suggestedPreflightReminder).filter(Boolean))];
  const reviewChecklist = [...new Set(limitedPatterns.map((item) => item.suggestedReviewCheck).filter(Boolean))];
  return {
    workspacePathNormalized: identity.normalizedPath,
    workspaceKey: identity.workspaceKey,
    window: {
      since: since ?? null,
      until: until ?? null,
    },
    patterns: limitedPatterns,
    topVerificationRisks,
    topChangedFileRisks,
    preflightReminders,
    reviewChecklist,
    historical_only: true,
    current_workspace_state_not_checked: true,
    diagnostics: uniqueHistorianDiagnostics(loaded.diagnostics),
  };
}

export async function workspaceMemorySummary({
  workspacePath,
  includeRecentRuns = true,
  includeChangedFiles = true,
  includeVerificationPatterns = true,
  includeFailurePatterns = true,
  limit = HISTORIAN_DEFAULT_LIMIT,
} = {}) {
  const identity = historianWorkspaceIdentity(workspacePath);
  if (!identity) throw new Error("workspacePath is required.");
  const normalizedLimit = historianLimit(limit);
  const [runs, changed, verification, failures, reviews, loaded] = await Promise.all([
    includeRecentRuns ? searchRuns({ workspacePath, limit: normalizedLimit }) : Promise.resolve({ matches: [], diagnostics: [] }),
    includeChangedFiles ? searchChangedFiles({ workspacePath, limit: HISTORIAN_MAX_LIMIT }) : Promise.resolve({ matches: [], diagnostics: [] }),
    includeVerificationPatterns ? searchVerification({ workspacePath, limit: normalizedLimit }) : Promise.resolve({ matches: [], diagnostics: [] }),
    includeFailurePatterns ? searchErrors({ workspacePath, limit: normalizedLimit }) : Promise.resolve({ matches: [], diagnostics: [] }),
    searchReviews({ workspacePath, limit: normalizedLimit }),
    loadHistorianRecords(),
  ]);
  const matchingRecords = loaded.records
    .filter((record) => historianWorkspaceMatches(record.run, identity))
    .sort((a, b) => String(historianRunUpdatedAt(b.run)).localeCompare(String(historianRunUpdatedAt(a.run))));
  const repoFingerprint = matchingRecords.find((record) => record.run.workspaceIdentity?.repoFingerprint)?.run.workspaceIdentity.repoFingerprint ?? null;
  const recentChangedFiles = selectWorkspaceMemoryChangedFiles(changed.matches, normalizedLimit);
  const diagnostics = uniqueHistorianDiagnostics([
    ...runs.diagnostics,
    ...changed.diagnostics,
    ...verification.diagnostics,
    ...failures.diagnostics,
    ...reviews.diagnostics,
    ...historianScopedDiagnostics(loaded.diagnostics, identity, loaded.records),
    ...(repoFingerprint ? [] : [{ code: "repo_fingerprint_unavailable", workspaceKey: identity.workspaceKey }]),
  ]);
  const suggestedContext = [];
  if (runs.matches.length > 0) suggestedContext.push(`Historian found ${runs.matches.length} recent run(s); inspect a specific run with Run Explorer before treating history as current state.`);
  if (failures.matches.length > 0) suggestedContext.push(`Recent failures mention ${failures.matches[0].errorType}; review persisted evidence before starting another run.`);
  if (recentChangedFiles.length > 0) {
    const firstChange = recentChangedFiles[0];
    suggestedContext.push(
      firstChange.changeOrigin === "created_after_preflight"
        ? `History created after preflight includes ${firstChange.path}; inspect that run before treating the file as current workspace truth.`
        : `Frequently changed history includes ${firstChange.path}; confirm the current workspace separately.`,
    );
  }
  if (reviews.matches.length > 0) suggestedContext.push(`The latest persisted review outcome is ${reviews.matches[0].outcome}.`);
  return {
    workspacePathNormalized: identity.normalizedPath,
    workspaceKey: identity.workspaceKey,
    repoFingerprint,
    recentRuns: runs.matches,
    recentChangedFiles,
    recentVerificationCommands: verification.matches,
    recentFailures: failures.matches,
    recentReviews: reviews.matches,
    suggestedContext,
    diagnostics,
  };
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
  async getProcessIdentity(pid) {
    return await getProcessIdentity(pid);
  },
  async getLauncherIdentityStatus(reservation) {
    return await getLauncherIdentityStatus(reservation);
  },
  async classifyRunningTaskOwnership(task, run) {
    return await classifyRunningTaskOwnership(task, run);
  },
  async writeTaskIfNonTerminal(task) {
    return await writeTaskIfNonTerminal(task);
  },
  async withFileLock(filePath, fn, options) {
    return await withFileLock(filePath, fn, options);
  },
  async finalizeAsyncTask(task, status, details) {
    return await finalizeAsyncTask(task, status, details);
  },
  async writeJsonWithFenceForTest(filePath, value, lease) {
    return await writeJsonWithFence(filePath, value, lease);
  },
  async resetRunForRapidStart(runId) {
    return await mutateRun(runId, async (run) => {
      run.status = "ready";
      run.activeTaskId = null;
      run.currentIteration = 0;
      run.completedIterations = [];
      run.startReservation = { ...(run.startReservation ?? {}), phase: "complete", updatedAt: nowIso() };
      run.updatedAt = nowIso();
      return run;
    });
  },
  async mutateRunForTest(runId, marker) {
    return await mutateRun(runId, async (run) => {
      run.testMarkers = [...(run.testMarkers ?? []), marker];
      return run;
    });
  },
  async mutateTaskForTest(taskId, marker) {
    return await mutateTask(taskId, async (task) => {
      task.testMarkers = [...(task.testMarkers ?? []), marker];
      return task;
    });
  },
  processIdentityStatus(recorded, identity) {
    return processIdentityStatus(recorded, identity);
  },
};
