import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["--test", "tests/*.test.mjs"], {
  stdio: ["ignore", "pipe", "pipe"],
});

const chunks = [];
const capture = (stream, target) => {
  stream.on("data", (chunk) => {
    target.write(chunk);
    chunks.push(Buffer.from(chunk));
    while (Buffer.concat(chunks).length > 256 * 1024) chunks.shift();
  });
};

capture(child.stdout, process.stdout);
capture(child.stderr, process.stderr);

const exitCode = await new Promise((resolve) => {
  child.on("close", (code) => resolve(code ?? 1));
  child.on("error", (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    resolve(1);
  });
});

if (exitCode !== 0 && process.env.GITHUB_ACTIONS === "true") {
  const output = Buffer.concat(chunks).toString("utf8");
  const lines = output.trimEnd().split(/\r?\n/);
  const start = Math.max(0, lines.findLastIndex((line) => /^not ok\b/.test(line)));
  const excerpt = lines.slice(start >= 0 ? start : Math.max(0, lines.length - 80)).join("\n").slice(-12000);
  const escaped = excerpt.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  process.stdout.write(`::error title=npm test failed::${escaped}\n`);
}

process.exit(exitCode);
