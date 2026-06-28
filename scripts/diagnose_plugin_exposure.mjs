import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runMcpToolsSmoke } from "./smoke_mcp_tools.mjs";

const scriptPath = fileURLToPath(import.meta.url);

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(target) {
  try {
    return { ok: true, value: JSON.parse(await readFile(target, "utf8")), error: null };
  } catch (error) {
    return { ok: false, value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function inspectPathWarnings(repoRoot) {
  const warnings = [];
  if (/\s/.test(repoRoot)) warnings.push("Repository path contains whitespace; verify plugin launch arguments preserve it.");
  if (/[^\x00-\x7F]/.test(repoRoot)) warnings.push("Repository path contains non-ASCII characters; verify the installed plugin resolves the exact path.");
  if (process.platform === "win32") {
    const withoutRoot = repoRoot.slice(path.parse(repoRoot).root.length);
    if (/[<>:"|?*]/.test(withoutRoot)) warnings.push("Repository path contains characters that are special on Windows.");
  }
  return warnings;
}

async function inspectCodexPaths() {
  const home = homedir();
  const candidates = [
    process.env.CODEX_HOME ? { kind: "CODEX_HOME", path: path.resolve(process.env.CODEX_HOME) } : null,
    { kind: "Codex configuration directory", path: path.join(home, ".codex") },
    { kind: "Codex plugin directory", path: path.join(home, ".codex", "plugins") },
    { kind: "Codex plugin cache", path: path.join(home, ".codex", "plugins", "cache") },
    { kind: "Personal marketplace configuration", path: path.join(home, ".agents", "plugins", "marketplace.json") },
  ].filter(Boolean);
  return Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    exists: await exists(candidate.path),
  })));
}

export async function diagnosePluginExposure({ repoRoot = process.cwd() } = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const packagePath = path.join(resolvedRoot, "package.json");
  const pluginPath = path.join(resolvedRoot, ".codex-plugin", "plugin.json");
  const serverPath = path.join(resolvedRoot, "mcp", "server.mjs");
  const readmePath = path.join(resolvedRoot, "README.md");
  const packageResult = await readJson(packagePath);
  const pluginResult = await readJson(pluginPath);
  const packageVersion = packageResult.value?.version ?? null;
  const pluginVersion = pluginResult.value?.version ?? null;
  const pluginNameOk = pluginResult.value?.name === "ai-bridge";
  const mcpConfigPath = typeof pluginResult.value?.mcpServers === "string"
    ? path.resolve(resolvedRoot, pluginResult.value.mcpServers)
    : null;
  const mcpConfigResult = mcpConfigPath
    ? await readJson(mcpConfigPath)
    : { ok: false, value: null, error: "plugin manifest does not configure mcpServers" };
  const mcpServerEntry = mcpConfigResult.value?.mcpServers?.["ai-bridge"] ?? null;
  const mcpConfigOk = mcpConfigResult.ok
    && typeof mcpServerEntry?.command === "string"
    && Array.isArray(mcpServerEntry?.args)
    && mcpServerEntry.args.some((argument) => String(argument).replaceAll("\\", "/").endsWith("mcp/server.mjs"));
  const skillsRoot = typeof pluginResult.value?.skills === "string"
    ? path.resolve(resolvedRoot, pluginResult.value.skills)
    : null;
  const skillPath = skillsRoot ? path.join(skillsRoot, "ai-bridge", "SKILL.md") : null;
  const skillsRootExists = skillsRoot ? await isDirectory(skillsRoot) : false;
  const skillExists = skillPath ? await exists(skillPath) : false;
  const serverExists = await exists(serverPath);
  const readmeExists = await exists(readmePath);
  const repositoryRootOk = packageResult.ok
    && pluginResult.ok
    && serverExists
    && await isDirectory(path.join(resolvedRoot, ".git"));
  const serverSmoke = serverExists
    ? await runMcpToolsSmoke({ repoRoot: resolvedRoot })
    : {
      ok: false,
      serverVersion: null,
      toolCount: 0,
      missingRequiredTools: [],
      protocolErrors: ["mcp/server.mjs does not exist"],
    };
  const versionsConsistent = Boolean(
    packageVersion
    && serverSmoke.serverVersion === packageVersion
    && typeof pluginVersion === "string"
    && pluginVersion.startsWith(`${packageVersion}+`),
  );
  const manifestOk = pluginResult.ok
    && pluginNameOk
    && Boolean(pluginVersion)
    && typeof pluginResult.value?.skills === "string"
    && typeof pluginResult.value?.mcpServers === "string";
  const skillsOk = skillsRootExists && skillExists;
  const warnings = inspectPathWarnings(resolvedRoot);
  if (!versionsConsistent) {
    warnings.push("Package, MCP server, and plugin versions are not aligned.");
  }
  const installationHints = await inspectCodexPaths();
  const nextActions = [];
  if (!repositoryRootOk) nextActions.push("Run this command from the AI Bridge repository root.");
  if (!manifestOk || !skillsOk || !mcpConfigOk) nextActions.push("Repair the local plugin manifest, MCP configuration, or skill paths before reinstalling the plugin.");
  if (!serverSmoke.ok) nextActions.push("Run npm run smoke:mcp-tools and inspect the reported protocol errors.");
  if (repositoryRootOk && manifestOk && mcpConfigOk && skillsOk && serverSmoke.ok) {
    nextActions.push("Local checks passed. If a fresh Codex thread still lacks ai_bridge_* tools, verify or reinstall AI Bridge through the supported Codex plugin manager, restart Codex, and open another fresh thread.");
  }

  const report = {
    ok: repositoryRootOk && manifestOk && mcpConfigOk && skillsOk && serverSmoke.ok && readmeExists && versionsConsistent,
    repoRoot: resolvedRoot,
    repositoryRootOk,
    packageVersion,
    pluginVersion,
    versionsConsistent,
    serverSmoke: {
      ok: serverSmoke.ok,
      serverVersion: serverSmoke.serverVersion,
      toolCount: serverSmoke.toolCount,
      missingRequiredTools: serverSmoke.missingRequiredTools,
      protocolErrors: serverSmoke.protocolErrors,
    },
    manifest: {
      ok: manifestOk,
      path: ".codex-plugin/plugin.json",
      exists: await exists(pluginPath),
      validJson: pluginResult.ok,
      name: pluginResult.value?.name ?? null,
      error: pluginResult.error,
    },
    mcpConfig: {
      ok: mcpConfigOk,
      path: mcpConfigPath ? path.relative(resolvedRoot, mcpConfigPath).replaceAll("\\", "/") : null,
      exists: mcpConfigPath ? await exists(mcpConfigPath) : false,
      validJson: mcpConfigResult.ok,
      serverName: mcpServerEntry ? "ai-bridge" : null,
      command: mcpServerEntry?.command ?? null,
      args: mcpServerEntry?.args ?? null,
      error: mcpConfigResult.error,
    },
    skills: {
      ok: skillsOk,
      path: skillPath ? path.relative(resolvedRoot, skillPath).replaceAll("\\", "/") : null,
      configuredRoot: pluginResult.value?.skills ?? null,
    },
    server: {
      exists: serverExists,
      path: "mcp/server.mjs",
    },
    readme: {
      exists: readmeExists,
      path: "README.md",
    },
    codexDiscovery: {
      status: "unknown",
      message: "Local diagnostics cannot prove that a fresh ChatGPT/Codex thread will expose the plugin.",
      observedPaths: installationHints,
    },
    warnings,
    nextActions,
  };
  return report;
}

export function formatDiagnosticReport(report) {
  return [
    "AI Bridge Plugin Exposure Diagnostics",
    `Local diagnostic result: ${report.ok ? "passed" : "failed"}`,
    `Repository root: ${report.repositoryRootOk ? "valid" : "invalid"} (${report.repoRoot})`,
    `Package/plugin/server versions aligned: ${report.versionsConsistent ? "yes" : "no"}`,
    `Manifest: ${report.manifest.ok ? "valid" : "invalid"} (${report.manifest.path})`,
    `MCP configuration: ${report.mcpConfig.ok ? "valid" : "invalid"} (${report.mcpConfig.path ?? "unresolved"})`,
    `Skills: ${report.skills.ok ? "valid" : "invalid"} (${report.skills.path ?? "unresolved"})`,
    `MCP server tools/list: ${report.serverSmoke.ok ? "passed" : "failed"} (${report.serverSmoke.toolCount} tools)`,
    "Codex UI/tool exposure: unknown",
    "Local MCP success and Codex plugin discovery are separate checks.",
    "--- JSON report ---",
    JSON.stringify(report, null, 2),
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const report = await diagnosePluginExposure();
  process.stdout.write(`${formatDiagnosticReport(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}
