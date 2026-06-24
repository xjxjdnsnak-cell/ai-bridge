import { runWorkerTask } from "./core.mjs";

const taskId = process.argv[2];

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

try {
  if (!taskId) throw new Error("taskId is required.");
  await runWorkerTask(taskId, { prompt: await readStdin(), env: process.env });
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
