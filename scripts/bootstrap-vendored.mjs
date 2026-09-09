// Bootstrap vendored runtime dependencies for the six Pi packages that
// load from source via .pi/settings.json. Each carries package.json +
// pnpm-lock.yaml in-tree; this script runs exactly one
// pnpm install --frozen-lockfile --ignore-scripts per package so the
// environment matches a reproducible, deployable seed.
//
// Failure handling: if a single package's install fails after the frozen
// check, its node_modules is rolled back (moved aside first) and the
// error is rethrown; successful packages stay installed. A package whose
// node_modules is absent and no backup exists is simply awaited after
// the frozen check.
//
// Exit codes: 0 ok; 1 one package hard-failed (see stderr).
import { execFileSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const VENDORED = [
  ".pi/packages/choco-pi-codex",
  ".pi/packages/choco-pi-lsp",
  ".pi/packages/choco-pi-mcp",
  ".pi/packages/choco-pi-provider-synthetic",
  ".pi/packages/choco-pi-subagents",
  ".pi/packages/choco-pi-web-access",
];

function say(msg) {
  process.stdout.write(msg + "\n");
}

function installOne(packageDir) {
  const nm = path.join(packageDir, "node_modules");
  const backup = nm + ".bootstrap-backup";
  const tag = path.relative(ROOT, packageDir);
  say("\n> " + tag + ": installing with frozen lockfile...");
  try {
    if (existsSync(nm)) {
      if (existsSync(backup)) rmSync(backup, { recursive: true });
      renameSync(nm, backup);
    }
    execFileSync(
      "pnpm",
      ["install", "--frozen-lockfile", "--ignore-workspace", "--ignore-scripts"],
      {
        cwd: packageDir,
        stdio: "inherit",
        env: { ...process.env },
      },
    );
    if (!existsSync(nm)) {
      throw new Error("pnpm install completed but " + tag + "/node_modules is absent");
    }
    if (existsSync(backup)) rmSync(backup, { recursive: true });
    say("> " + tag + ": ok (pinned)");
  } catch (error) {
    say("> " + tag + ": FAILED - " + String(error.message).split("\n")[0]);
    if (existsSync(backup) && !existsSync(nm)) {
      renameSync(backup, nm);
      say("> " + tag + ": recovered prior node_modules from backup");
    }
    throw error;
  }
}

function main() {
  const failures = [];
  for (const dir of VENDORED) {
    const packageDir = path.join(ROOT, dir);
    try {
      installOne(packageDir);
    } catch (error) {
      failures.push({ dir, error });
    }
  }
  if (failures.length) {
    say("\nbootstrap-vendored FAILED:");
    for (const { dir, error } of failures) {
      say("  - " + dir + ": " + String(error.message).split("\n")[0]);
    }
    process.exitCode = 1;
    return;
  }
  say("\nbootstrap-vendored OK - all six vendored packages restored.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
