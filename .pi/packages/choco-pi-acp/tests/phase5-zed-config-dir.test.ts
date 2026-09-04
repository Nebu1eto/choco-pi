import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isBoundaryArray, isBoundaryRecord, isString, parseJsonLine } from "../src/boundary.ts";
import { parseZedTasks } from "../src/zed/setup.ts";

const adapterCli = fileURLToPath(new URL("../bin/choco-pi-acp.ts", import.meta.url));

function runAdapter(
  cwd: string,
  args: readonly string[],
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [adapterCli, "zed", ...args], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stderr, stdout }));
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("real Zed CLI targets a resolved isolated config directory for its full lifecycle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-phase5-zed-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const relativeConfigDirectory = join("profile", "config");
  const configDirectory = resolve(await realpath(root), relativeConfigDirectory);
  const settingsPath = join(configDirectory, "settings.json");
  const tasksPath = join(configDirectory, "tasks.json");

  const dryRun = await runAdapter(root, [
    "setup",
    "--dry-run",
    "--zed-config-dir",
    relativeConfigDirectory,
  ]);
  assert.equal(dryRun.code, 0, dryRun.stderr || dryRun.stdout);
  assert.match(dryRun.stdout, new RegExp(`Zed config directory: ${configDirectory}`));
  assert.match(dryRun.stdout, new RegExp(`Zed settings: ${settingsPath}`));
  assert.match(dryRun.stdout, new RegExp(`Zed tasks: ${tasksPath}`));
  assert.equal(await pathExists(configDirectory), false);

  const missingDoctor = await runAdapter(root, ["doctor", "--zed-config-dir", configDirectory]);
  assert.equal(missingDoctor.code, 1);
  assert.match(missingDoctor.stdout, /Status: setup required/);
  assert.equal(await pathExists(configDirectory), false);

  const apply = await runAdapter(root, [
    "setup",
    "--apply",
    "--zed-config-dir",
    relativeConfigDirectory,
  ]);
  assert.equal(apply.code, 0, apply.stderr || apply.stdout);
  const settings = parseJsonLine(await readFile(settingsPath, "utf8"));
  const tasks = parseZedTasks(await readFile(tasksPath, "utf8"));
  const agentServers = isBoundaryRecord(settings) ? settings.agent_servers : undefined;
  const chocoPi = isBoundaryRecord(agentServers) ? agentServers["choco-pi"] : undefined;
  assert.equal(isBoundaryRecord(chocoPi) ? chocoPi.type : undefined, "custom");
  const privateTask = tasks.find(
    (task) => task.label === "Choco Pi: Sync Focused Context (No Selection)",
  );
  const privateTaskArgs = privateTask?.args;
  assert.equal(isBoundaryArray(privateTaskArgs), true);
  if (!isBoundaryArray(privateTaskArgs)) throw new Error("private task args are missing");
  assert.equal(privateTaskArgs.includes("--no-selection-text"), true);
  assert.equal(privateTaskArgs.includes("--selection-env"), false);
  assert.deepEqual(privateTask?.env, {});

  const conflictingTasks = tasks.map((task) =>
    task.label === "Choco Pi: Sync Focused Context"
      ? { ...task, command: "conflicting-command" }
      : task,
  );
  await writeFile(tasksPath, `${JSON.stringify(conflictingTasks, null, 2)}\n`);
  const conflict = await runAdapter(root, [
    "setup",
    "--apply",
    "--zed-config-dir",
    relativeConfigDirectory,
  ]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stdout, /Refusing to replace/);
  const replace = await runAdapter(root, [
    "setup",
    "--apply",
    "--replace",
    "--zed-config-dir",
    relativeConfigDirectory,
  ]);
  assert.equal(replace.code, 0, replace.stderr || replace.stdout);

  const doctor = await runAdapter(root, ["doctor", "--zed-config-dir", configDirectory]);
  assert.equal(doctor.code, 0, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /Status: configured/);
  assert.match(doctor.stdout, new RegExp(`Zed config directory: ${configDirectory}`));

  const configuredSettings = await readFile(settingsPath, "utf8");
  const configuredTasks = await readFile(tasksPath, "utf8");
  const removeDryRun = await runAdapter(root, [
    "remove",
    "--dry-run",
    "--zed-config-dir",
    configDirectory,
  ]);
  assert.equal(removeDryRun.code, 0, removeDryRun.stderr || removeDryRun.stdout);
  assert.equal(await readFile(settingsPath, "utf8"), configuredSettings);
  assert.equal(await readFile(tasksPath, "utf8"), configuredTasks);

  const remove = await runAdapter(root, ["remove", "--apply", "--zed-config-dir", configDirectory]);
  assert.equal(remove.code, 0, remove.stderr || remove.stdout);
  const removedSettings = parseJsonLine(await readFile(settingsPath, "utf8"));
  const removedTasks = parseZedTasks(await readFile(tasksPath, "utf8"));
  const removedAgentServers = isBoundaryRecord(removedSettings)
    ? removedSettings.agent_servers
    : undefined;
  assert.equal(
    isBoundaryRecord(removedAgentServers) ? removedAgentServers["choco-pi"] : undefined,
    undefined,
  );
  assert.equal(
    removedTasks.some((task) => isString(task.label) && task.label.startsWith("Choco Pi:")),
    false,
  );
});

test("Zed config directory validation accepts fresh directories and ordinary files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-phase5-zed-safe-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const configDirectory = join(await realpath(root), "config");
  await mkdir(configDirectory);

  const empty = await runAdapter(root, ["setup", "--dry-run", "--zed-config-dir", configDirectory]);
  assert.equal(empty.code, 0, empty.stderr || empty.stdout);

  await writeFile(join(configDirectory, "settings.json"), "{}\n");
  await writeFile(join(configDirectory, "tasks.json"), "[]\n");
  const existing = await runAdapter(root, [
    "setup",
    "--dry-run",
    "--zed-config-dir",
    configDirectory,
  ]);
  assert.equal(existing.code, 0, existing.stderr || existing.stdout);
});

test("Zed config directory validation rejects a regular file path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-phase5-zed-file-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const configPath = join(await realpath(root), "not-a-directory");
  await writeFile(configPath, "ordinary file\n");

  const result = await runAdapter(root, ["setup", "--dry-run", "--zed-config-dir", configPath]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /--zed-config-dir must target a directory/);
});

test("Zed config directory validation rejects target-file symlinks outside it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-phase5-zed-symlink-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const configDirectory = join(canonicalRoot, "config");
  const outsideSettings = join(canonicalRoot, "outside-settings.json");
  await mkdir(configDirectory);
  await writeFile(outsideSettings, "{}\n");
  await symlink(outsideSettings, join(configDirectory, "settings.json"));

  const result = await runAdapter(root, [
    "setup",
    "--dry-run",
    "--zed-config-dir",
    configDirectory,
  ]);
  assert.equal(result.code, 1);
  assert.match(
    result.stdout,
    /--zed-config-dir settings\.json must not resolve outside the config directory/,
  );
});

test("Zed config directory validation rejects a filesystem root", async () => {
  const result = await runAdapter(tmpdir(), [
    "setup",
    "--dry-run",
    "--zed-config-dir",
    resolve(tmpdir(), "/"),
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /--zed-config-dir cannot target a filesystem root/);
});
