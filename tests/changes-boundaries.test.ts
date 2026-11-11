import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `/review-assist` (`review/`) and the `/diff` pane (`diff/`) share code only
 * through `lib/changes/`. Either extension can then be disabled or edited
 * without breaking the other, and the shared layer depends on neither.
 */

const EXTENSIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../.pi/extensions");

type Area = "review" | "diff" | "lib/changes";

const AREAS: readonly Area[] = ["review", "diff", "lib/changes"];

/** What each area must never import. */
const FORBIDDEN = {
  review: ["diff"],
  diff: ["review"],
  "lib/changes": ["review", "diff"],
} as const satisfies Record<Area, readonly Area[]>;

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+|^\s*export\s+\*\s+from\s*)["']([^"']+)["']/gm;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function areaOf(path: string): Area | undefined {
  const local = relative(EXTENSIONS, path).split(sep).join("/");
  if (local.startsWith("lib/changes/")) return "lib/changes";
  if (local.startsWith("review/")) return "review";
  if (local.startsWith("diff/")) return "diff";
  return undefined;
}

function relativeSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)]
    .map((match) => match[1] ?? "")
    .filter((specifier) => specifier.startsWith("."));
}

async function crossings(): Promise<string[]> {
  const found: string[] = [];
  for (const area of AREAS) {
    for (const file of await sourceFiles(join(EXTENSIONS, area))) {
      const source = await readFile(file, "utf8");
      for (const specifier of relativeSpecifiers(source)) {
        const target = areaOf(resolve(dirname(file), specifier));
        const forbidden: readonly Area[] = FORBIDDEN[area];
        if (target && forbidden.includes(target)) {
          found.push(`${relative(EXTENSIONS, file)} -> ${specifier}`);
        }
      }
    }
  }
  return found;
}

test("review, diff, and lib/changes import each other only through lib/changes", async () => {
  for (const area of AREAS) {
    assert.ok((await sourceFiles(join(EXTENSIONS, area))).length > 0, `${area} has sources`);
  }
  assert.deepEqual(await crossings(), []);
});
