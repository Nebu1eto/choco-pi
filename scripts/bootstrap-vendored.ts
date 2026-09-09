import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VENDORED = [
  ".pi/packages/choco-pi-codex",
  ".pi/packages/choco-pi-lsp",
  ".pi/packages/choco-pi-mcp",
  ".pi/packages/choco-pi-provider-synthetic",
  ".pi/packages/choco-pi-subagents",
  ".pi/packages/choco-pi-web-access",
] as const;

export type Runner = (args: readonly string[], cwd: string) => Promise<string>;

// Resolve only on close: even a spawn error must settle before filesystem rollback.
export const runPnpm: Runner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const capture = args.length === 1 && args[0] === "--version";
    const child = spawn("pnpm", [...args], {
      cwd,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let output = "";
    let spawnError: Error | undefined;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error(`pnpm exited with ${signal ?? code}`));
      else resolve(output);
    });
  });

const filesystem = { lstat, mkdir, readdir, rename, rm };
type Filesystem = typeof filesystem;

async function exists(file: string, fs: Filesystem): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** The runner must settle only after its child has exited; cancellation alone is not settlement. */
export async function installOne(
  packageDir: string,
  runner: Runner = runPnpm,
  fs: Filesystem = filesystem,
): Promise<void> {
  const modules = path.join(packageDir, "node_modules");
  const claim = `${modules}.bootstrap-lock`;
  const backup = `${modules}.bootstrap-backup-${randomUUID()}`;
  try {
    await fs.mkdir(claim);
  } catch (error) {
    throw new Error(
      `Cannot claim ${claim}; inspect for another installer or interrupted run: ${String(error)}`,
      { cause: error },
    );
  }

  let retainClaim = false;
  try {
    const unknown = (await fs.readdir(packageDir)).filter((name) =>
      name.startsWith("node_modules.bootstrap-backup"),
    );
    if (unknown.length) {
      throw new Error(
        `Recovery required; refusing existing backups: ${unknown.map((name) => path.join(packageDir, name)).join(", ")}`,
      );
    }
    const hadModules = await exists(modules, fs);
    if (hadModules) await fs.rename(modules, backup);
    try {
      await runner(["install", "--frozen-lockfile", "--ignore-scripts"], packageDir);
      if (!(await exists(modules, fs))) {
        throw new Error(`pnpm succeeded but ${modules} is absent`);
      }
    } catch (error) {
      try {
        await fs.rm(modules, { recursive: true, force: true });
        if (hadModules) await fs.rename(backup, modules);
      } catch (rollbackError) {
        retainClaim = true;
        throw new AggregateError(
          [error, rollbackError],
          `Install failed: ${String(error)}; rollback failed: ${String(rollbackError)}. Inspect ${modules}, ${backup}, and retained claim ${claim}.`,
        );
      }
      throw error;
    }
    // A backup cleanup failure must not roll back to a possibly partially removed backup.
    if (hadModules) await fs.rm(backup, { recursive: true });
  } finally {
    if (!retainClaim) await fs.rm(claim, { recursive: true });
  }
}

export async function bootstrap(
  root: string,
  runner: Runner = runPnpm,
  report: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error("Vendored installation requires Node >=24");
  }
  // Bootstrap runs before dependencies exist: validate the one manifest field using built-ins.
  let manager: string;
  try {
    const manifest: { packageManager?: string } | null = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    manager = manifest?.packageManager ?? "";
    // assert.match checks primitive string identity as well as the exact pin syntax.
    assert.match(manager, /^pnpm@\d+\.\d+\.\d+$/);
  } catch (error) {
    throw new Error(
      `Root package.json must be readable JSON pinning packageManager to an exact pnpm@x.y.z: ${String(error)}`,
      { cause: error },
    );
  }
  const expected = manager.slice("pnpm@".length);
  const actual = (await runner(["--version"], root)).trim();
  if (actual !== expected) {
    throw new Error(`Expected pnpm ${expected}, found ${actual}; no package trees were changed`);
  }
  const failures: Error[] = [];
  for (const dir of VENDORED) {
    report(`> ${dir}: installing with frozen lockfile...`);
    try {
      await installOne(path.join(root, dir), runner);
      report(`> ${dir}: ok`);
    } catch (error) {
      const failure = new Error(`${dir}: ${String(error)}`, { cause: error });
      failures.push(failure);
      report(`> ${failure.message}`);
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      `Vendored installation failed:\n${failures.map((error) => error.message).join("\n")}`,
    );
  }
  report("bootstrap-vendored OK - all six vendored packages restored.");
}

// No interrupt handler: a killed process can leave its claim and backup for manual inspection.
// Never infer that a child stopped from an aborted promise and race it with rollback.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await bootstrap(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
