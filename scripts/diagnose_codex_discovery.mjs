import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_VERSION } from "../mcp/core.mjs";
import { diagnosePluginExposure } from "./diagnose_plugin_exposure.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");

async function exists(target) {
  if (!target) return false;
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    return null;
  }
}

function redactString(value) {
  return value
    .replaceAll(/\bsk-[a-z0-9_-]{4,}\b/gi, "[REDACTED]")
    .replaceAll(/\bbearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

function sanitize(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

function addCandidate(candidates, kind, target) {
  if (!target) return;
  const resolved = path.resolve(target);
  const identity = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (candidates.some((candidate) => candidate.identity === identity)) return;
  candidates.push({ kind, path: resolved, identity });
}

async function collectLocalCodexHints({ home, appData, localAppData, codexHome }) {
  const candidates = [];
  addCandidate(candidates, "CODEX_HOME", codexHome);
  addCandidate(candidates, "User Codex directory", path.join(home, ".codex"));
  addCandidate(candidates, "User ChatGPT directory", path.join(home, ".chatgpt"));
  addCandidate(candidates, "Roaming Codex directory", appData ? path.join(appData, "Codex") : null);
  addCandidate(candidates, "Roaming ChatGPT directory", appData ? path.join(appData, "ChatGPT") : null);
  addCandidate(candidates, "Local Codex directory", localAppData ? path.join(localAppData, "Codex") : null);
  addCandidate(candidates, "Local ChatGPT directory", localAppData ? path.join(localAppData, "ChatGPT") : null);
  addCandidate(candidates, "Local OpenAI directory", localAppData ? path.join(localAppData, "OpenAI") : null);
  return Promise.all(candidates.map(async ({ identity: _identity, ...candidate }) => ({
    ...candidate,
    status: await exists(candidate.path) ? "exists" : "not_found",
    meaning: "filesystem observation only",
  })));
}

function isWithin(candidateRoot, target) {
  const relative = path.relative(candidateRoot, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function inspectRepoPath(repoRoot, localCodexHints) {
  const containingCandidates = localCodexHints
    .filter((hint) => isWithin(hint.path, repoRoot))
    .map((hint) => hint.path);
  const warnings = [];
  if (/\s/.test(repoRoot)) warnings.push("Repository path contains whitespace.");
  if (/[^\x00-\x7F]/.test(repoRoot)) warnings.push("Repository path contains non-ASCII characters.");
  if (process.platform === "win32") {
    const withoutRoot = repoRoot.slice(path.parse(repoRoot).root.length);
    if (/[<>:"|?*]/.test(withoutRoot)) warnings.push("Repository path contains Windows-special characters.");
  }
  return {
    containsWhitespace: /\s/.test(repoRoot),
    containsNonAscii: /[^\x00-\x7F]/.test(repoRoot),
    containsWindowsSpecialCharacters: process.platform === "win32"
      ? /[<>:"|?*]/.test(repoRoot.slice(path.parse(repoRoot).root.length))
      : false,
    candidatePlacement: {
      status: containingCandidates.length ? "observed_within_candidate_directory" : "not_observed",
      containingCandidates,
      meaning: "path comparison only; not proof of plugin installation or discovery",
    },
    warnings,
  };
}

export async function diagnoseCodexDiscovery({ repoRoot = defaultRepoRoot } = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const packageJson = await readJson(path.join(resolvedRoot, "package.json"));
  const pluginJson = await readJson(path.join(resolvedRoot, ".codex-plugin", "plugin.json"));
  const mcpJson = await readJson(path.join(resolvedRoot, ".mcp.json"));
  const pluginDiagnosis = await diagnosePluginExposure({ repoRoot: resolvedRoot });
  const mcpEntry = mcpJson?.mcpServers?.["ai-bridge"] ?? null;
  const entryPointsToServer = mcpEntry?.command === "node"
    && Array.isArray(mcpEntry?.args)
    && mcpEntry.args.some((argument) => String(argument).replaceAll("\\", "/").endsWith("mcp/server.mjs"));
  const environment = {
    home: homedir(),
    appData: process.env.APPDATA ?? null,
    localAppData: process.env.LOCALAPPDATA ?? null,
    codexHome: process.env.CODEX_HOME ?? null,
  };
  const localCodexHints = await collectLocalCodexHints(environment);
  const report = {
    ok: Boolean(
      pluginDiagnosis.ok
      && packageJson?.version === APP_VERSION
      && pluginJson?.version?.startsWith(`${APP_VERSION}+`),
    ),
    repo: {
      root: resolvedRoot,
      packageVersion: packageJson?.version ?? null,
      appVersion: APP_VERSION,
      pluginVersion: pluginJson?.version ?? null,
      pathInspection: inspectRepoPath(resolvedRoot, localCodexHints),
    },
    mcp: {
      mcpJsonExists: Boolean(mcpJson),
      serverName: mcpEntry ? "ai-bridge" : null,
      command: mcpEntry?.command ?? null,
      args: mcpEntry?.args ?? null,
      entryPointsToServer,
      serverExists: await exists(path.join(resolvedRoot, "mcp", "server.mjs")),
      smokeOk: pluginDiagnosis.serverSmoke.ok,
      toolCount: pluginDiagnosis.serverSmoke.toolCount,
      requiredToolsPresent: pluginDiagnosis.serverSmoke.missingRequiredTools.length === 0,
    },
    plugin: {
      manifestExists: pluginDiagnosis.manifest.exists,
      mcpConfigOk: pluginDiagnosis.mcpConfig.ok,
      skillsPathExists: pluginDiagnosis.skills.ok,
      skillFileExists: await exists(path.join(resolvedRoot, "skills", "ai-bridge", "SKILL.md")),
      diagnosePluginOk: pluginDiagnosis.ok,
    },
    environment,
    localCodexHints,
    codexThreadExposure: {
      status: "unknown",
      message: "This local script cannot prove whether a fresh ChatGPT/Codex thread exposes ai_bridge_* tools.",
    },
    nextActions: [
      "Run npm run smoke:mcp-tools from the repository root.",
      "Run npm run diagnose:plugin from the repository root.",
      "Run npm run diagnose:codex-discovery from the repository root.",
      "Open a fresh Codex thread and record whether ai_bridge_* tools appear.",
      "If local diagnostics pass but tools are absent, treat the blocker as Codex/plugin discovery outside AI Bridge runtime.",
    ],
  };
  return sanitize(report);
}

export function formatDiscoveryReport(report) {
  return [
    "AI Bridge Fresh Thread Plugin Discovery Diagnostics",
    `Local fact collection: ${report.ok ? "passed" : "failed"}`,
    `Repository: ${report.repo.root}`,
    `Versions: package=${report.repo.packageVersion}, app=${report.repo.appVersion}, plugin=${report.repo.pluginVersion}`,
    `MCP: smoke=${report.mcp.smokeOk ? "passed" : "failed"}, tools=${report.mcp.toolCount}, required=${report.mcp.requiredToolsPresent ? "present" : "missing"}`,
    `Plugin layout: ${report.plugin.diagnosePluginOk ? "passed" : "failed"}`,
    `Local path hints checked: ${report.localCodexHints.length}`,
    `codexThreadExposure: ${report.codexThreadExposure.status}`,
    report.codexThreadExposure.message,
    "--- JSON report ---",
    JSON.stringify(report, null, 2),
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const report = await diagnoseCodexDiscovery();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatDiscoveryReport(report)}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}
