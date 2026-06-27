import { execFile } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateTrackedPid(pid) {
  if (!await processExists(pid)) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (let attempt = 0; attempt < 20 && await processExists(pid); attempt += 1) {
    await sleep(50);
  }
  if (await processExists(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

export async function cleanupTrackedBridgeProcesses(bridgeHome) {
  const taskDir = path.join(bridgeHome, "tasks");
  const entries = await readdir(taskDir).catch(() => []);
  const pids = new Set();
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const task = await readFile(path.join(taskDir, entry), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    for (const pid of [task?.pid, task?.workerPid]) {
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  for (const pid of pids) await terminateTrackedPid(pid);
}

export async function removeTempPath(targetPath) {
  if (!targetPath) return;
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code)) throw error;
      await sleep(50 * (attempt + 1));
    }
  }
  throw lastError;
}

export function registerTempCleanup(t, { bridgeHomes = [], paths = [] }) {
  t.after(async () => {
    for (const bridgeHome of bridgeHomes) await cleanupTrackedBridgeProcesses(bridgeHome);
    for (const targetPath of [...bridgeHomes, ...paths].reverse()) await removeTempPath(targetPath);
  });
}
