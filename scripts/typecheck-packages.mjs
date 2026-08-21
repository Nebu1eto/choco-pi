import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(repoRoot, ".pi", "packages");

const projects = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(packagesDir, entry.name))
  .filter((dir) => readdirSync(dir).includes("tsconfig.json"));

let failed = false;
for (const project of projects) {
  const label = path.relative(repoRoot, project);
  const result = spawnSync("npx", ["tsc", "--noEmit", "-p", project], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failed = true;
    console.error(`typecheck failed: ${label}`);
  }
}

process.exit(failed ? 1 : 0);
