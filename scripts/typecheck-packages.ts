import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(repoRoot, "packages");

async function packageProjects(): Promise<string[]> {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const projects: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    if ((await readdir(dir)).includes("tsconfig.json")) projects.push(dir);
  }
  return projects;
}

function typecheck(project: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsc", "--noEmit", "-p", project], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

let failed = false;
for (const project of await packageProjects()) {
  if ((await typecheck(project)) !== 0) {
    failed = true;
    console.error(`typecheck failed: ${path.relative(repoRoot, project)}`);
  }
}

process.exitCode = failed ? 1 : 0;
