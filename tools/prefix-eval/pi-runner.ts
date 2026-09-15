import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSessionUsage } from "./session-usage.ts";

export interface PiRunOptions {
  model: string;
  thinking: string;
  cwd: string;
  outDir: string;
  prompts: string[];
  timeoutMs: number;
}

export interface PiRunResult {
  finalMessage: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  sessionDirectory: string;
  capturePath: string;
}

const captureExtensionPath = fileURLToPath(new URL("./capture-extension.ts", import.meta.url));

function terminateProcessGroup(processId: number | undefined, signal: NodeJS.Signals): void {
  if (processId === undefined) return;
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

export async function runPi(options: PiRunOptions): Promise<PiRunResult> {
  const sessionDirectory = join(options.outDir, "sessions");
  const capturePath = join(options.outDir, "capture.jsonl");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(capturePath, "", { mode: 0o600 });

  const startedAt = performance.now();
  const child = spawn(
    "pi",
    [
      "--model",
      options.model,
      "--thinking",
      options.thinking,
      "--session-dir",
      sessionDirectory,
      "-e",
      captureExtensionPath,
      "-p",
      ...options.prompts,
    ],
    {
      cwd: options.cwd,
      detached: true,
      env: {
        ...process.env,
        CHOCO_PI_PREFIX_CAPTURE: capturePath,
        CHOCO_PI_PREFIX_CAPTURE_FULL: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child.pid, "SIGTERM");
  }, options.timeoutMs);
  const forceKill = setTimeout(() => {
    if (timedOut && child.exitCode === null) terminateProcessGroup(child.pid, "SIGKILL");
  }, options.timeoutMs + 5_000);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => {
    clearTimeout(timeout);
    clearTimeout(forceKill);
  });

  const wallMs = Math.round(performance.now() - startedAt);
  await Promise.all([
    writeFile(join(options.outDir, "stdout.txt"), stdout, { mode: 0o600 }),
    writeFile(join(options.outDir, "stderr.txt"), stderr, { mode: 0o600 }),
  ]);
  const usage = await readSessionUsage(sessionDirectory);
  return {
    finalMessage: usage.finalMessage,
    stdout,
    stderr,
    exitCode,
    timedOut,
    wallMs,
    sessionDirectory,
    capturePath,
  };
}
