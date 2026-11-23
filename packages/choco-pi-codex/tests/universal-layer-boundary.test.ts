/**
 * The provider-neutral layer (Code Mode, core tools, patch engine, shell) must
 * not import OpenAI Codex / Responses code. The extension composition root
 * (`src/extension/`) injects the provider pieces through the ports in
 * `src/adapter/code-mode/ports.ts`, so the universal tree can move to its own
 * package without dragging the provider along.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

const UNIVERSAL_DIRECTORIES = [
  "tools/code-mode",
  "tools/apply-patch",
  "tools/exec",
  "tools/view-image",
  "tools/native",
  "patch",
  "shell",
  "adapter/code-mode",
];
const UNIVERSAL_FILES = ["adapter/code-mode.ts"];

/** Provider-side targets, as `src`-relative POSIX paths or directory prefixes. */
const FORBIDDEN_TARGETS = [
  "providers/openai-",
  "adapter/compaction/",
  "adapter/openai-sign-in.ts",
  "adapter/codex-tool-provider.ts",
  "tools/imagegen/",
  "tools/web-run/",
];

const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(["'])([^"'\n]+)\1/gm;

async function listTypeScript(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

async function universalFiles(): Promise<string[]> {
  const nested = await Promise.all(
    UNIVERSAL_DIRECTORIES.map((directory) => listTypeScript(join(SRC, directory))),
  );
  return [...nested.flat(), ...UNIVERSAL_FILES.map((file) => join(SRC, file))].sort();
}

function toSrcPath(path: string): string {
  return relative(SRC, path).split(sep).join("/");
}

async function relativeImports(file: string): Promise<string[]> {
  const source = await readFile(file, "utf8");
  return [...source.matchAll(SPECIFIER_PATTERN)]
    .map((match) => match[2] ?? "")
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => toSrcPath(resolve(dirname(file), specifier)));
}

test("the universal layer has no imports into OpenAI provider code", async () => {
  const files = await universalFiles();
  assert.ok(files.length > 50, `expected the universal tree, found ${files.length} files`);
  const violations: string[] = [];
  for (const file of files) {
    for (const target of await relativeImports(file)) {
      if (FORBIDDEN_TARGETS.some((forbidden) => target.startsWith(forbidden)))
        violations.push(`${toSrcPath(file)} -> ${target}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("the universal layer does not import the extension composition root", async () => {
  const violations: string[] = [];
  for (const file of await universalFiles()) {
    for (const target of await relativeImports(file)) {
      if (target.startsWith("extension/")) violations.push(`${toSrcPath(file)} -> ${target}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("the exec grammar contract is a pure leaf module", async () => {
  const source = await readFile(join(SRC, "tools/code-mode/exec-contract.ts"), "utf8");
  assert.deepEqual([...source.matchAll(SPECIFIER_PATTERN)], []);
});

test("the scanner sees every import form it guards", async () => {
  const source = [
    'import { a } from "../../providers/openai-codex/x.ts";',
    'import type { B } from "./b.ts";',
    'export { c } from "../c.ts";',
    'const d = () => import("../../tools/web-run/tool.ts");',
    'import "./side-effect.ts";',
  ].join("\n");
  assert.deepEqual(
    [...source.matchAll(SPECIFIER_PATTERN)].map((match) => match[2]),
    [
      "../../providers/openai-codex/x.ts",
      "./b.ts",
      "../c.ts",
      "../../tools/web-run/tool.ts",
      "./side-effect.ts",
    ],
  );
});
