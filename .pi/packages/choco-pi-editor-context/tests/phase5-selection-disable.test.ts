import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

test("real publish CLI suppresses selection text while retaining focused metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-phase5-selection-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const agentDirectory = join(root, "agent");
  const bridgeDirectory = join(agentDirectory, "choco-pi", "session-bridge");
  const liveDirectory = join(bridgeDirectory, "live");
  const workspace = join(root, "workspace");
  const bufferPath = join(workspace, "src", "example.ts");
  await Promise.all([
    mkdir(liveDirectory, { recursive: true }),
    mkdir(join(workspace, "src"), { recursive: true }),
  ]);
  await writeFile(
    join(liveDirectory, "session-1.owner-1.json"),
    `${JSON.stringify({
      version: 1,
      sessionId: "session-1",
      sessionFile: join(root, "session-1.jsonl"),
      cwd: workspace,
      pid: process.pid,
      ownerId: "owner-1",
      status: "idle",
      updatedAt: new Date().toISOString(),
    })}\n`,
  );

  const sentinel = "PRIVATE-PHASE5-SELECTION";
  const baseArgs = [
    "publish",
    "--session-id",
    "session-1",
    "--owner-id",
    "owner-1",
    "--cwd",
    workspace,
    "--path",
    bufferPath,
    "--line",
    "4",
    "--column",
    "8",
    "--language",
    "TypeScript",
    "--symbol",
    "Example.run",
  ] as const;
  const contextPath = join(bridgeDirectory, "editor-context", "session-1.owner-1.json");
  const environment = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDirectory,
    PHASE5_SELECTION: sentinel,
  };

  const byFlagArgs = [...baseArgs, "--selection-env", "PHASE5_SELECTION", "--no-selection-text"];
  assert.equal(byFlagArgs.includes(sentinel), false);
  const byFlag = await runCli(byFlagArgs, environment);
  assert.equal(byFlag.code, 0, byFlag.stderr || byFlag.stdout);
  assert.equal(`${byFlag.stdout}${byFlag.stderr}`.includes(sentinel), false);
  const flagSource = await readFile(contextPath, "utf8");
  assert.equal(flagSource.includes(sentinel), false);
  const flagDocument = JSON.parse(flagSource);
  assert.equal(flagDocument.selection, undefined);
  assert.deepEqual(flagDocument.cursor, { line: 4, column: 8 });
  assert.deepEqual(flagDocument.buffer, {
    path: bufferPath,
    language: "TypeScript",
    symbol: "Example.run",
  });
  assert.equal(flagDocument.workspace.root, workspace);

  const missingSelectionFile = join(root, "must-not-be-read.txt");
  const byEnvironmentArgs = [...baseArgs, "--selection-file", missingSelectionFile];
  assert.equal(byEnvironmentArgs.includes(sentinel), false);
  const byEnvironment = await runCli(byEnvironmentArgs, {
    ...environment,
    CHOCO_PI_EDITOR_CONTEXT_NO_SELECTION: "1",
  });
  assert.equal(byEnvironment.code, 0, byEnvironment.stderr || byEnvironment.stdout);
  assert.equal(`${byEnvironment.stdout}${byEnvironment.stderr}`.includes(sentinel), false);
  const environmentSource = await readFile(contextPath, "utf8");
  assert.equal(environmentSource.includes(sentinel), false);
  const environmentDocument = JSON.parse(environmentSource);
  assert.equal(environmentDocument.selection, undefined);
  assert.deepEqual(environmentDocument.cursor, { line: 4, column: 8 });
  assert.equal(environmentDocument.buffer.symbol, "Example.run");
});
