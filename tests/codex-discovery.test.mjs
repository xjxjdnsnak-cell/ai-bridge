import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "diagnose_codex_discovery.mjs");

function runDiagnostic(args = []) {
  return execFile(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: path.join(tmpdir(), "sk-test-secret-codex-home"),
    },
    timeout: 20000,
    windowsHide: true,
  });
}

test("discovery diagnostic CLI reports unknown thread exposure without leaking secret-like values", async () => {
  const { stdout } = await runDiagnostic();
  assert.match(stdout, /AI Bridge Fresh Thread Plugin Discovery Diagnostics/);
  assert.match(stdout, /codexThreadExposure/);
  assert.match(stdout, /unknown/);
  assert.doesNotMatch(stdout, /sk-test-secret-codex-home/i);
  assert.doesNotMatch(stdout, /bearer\s+\S+/i);
});

test("discovery diagnostic JSON is parseable and includes bounded local facts", async () => {
  const { stdout } = await runDiagnostic(["--json"]);
  assert.doesNotMatch(stdout, /sk-test-secret-codex-home/i);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.ok(report.repo);
  assert.ok(report.mcp);
  assert.ok(report.plugin);
  assert.ok(report.codexThreadExposure);
  assert.ok(Array.isArray(report.nextActions));
  assert.equal(report.codexThreadExposure.status, "unknown");
  assert.equal(report.mcp.smokeOk, true);
  assert.equal(report.mcp.entryPointsToServer, true);
  assert.ok(report.mcp.toolCount >= 18);
  assert.equal(report.mcp.requiredToolsPresent, true);
  assert.ok(report.localCodexHints.length <= 8);
  for (const hint of report.localCodexHints) {
    assert.ok(["exists", "not_found", "unknown"].includes(hint.status));
    assert.equal(hint.meaning, "filesystem observation only");
  }
});

test("discovery diagnostic source avoids broad home scans and environment dumps", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.doesNotMatch(source, /\breaddir(?:Sync)?\b/);
  assert.doesNotMatch(source, /\bglob\b/);
  assert.doesNotMatch(source, /Object\.(?:keys|entries|values)\(process\.env\)/);
  assert.doesNotMatch(source, /JSON\.stringify\(process\.env/);
  assert.doesNotMatch(source, /recursive\s*:\s*true/);
});
