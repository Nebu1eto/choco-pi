import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PACKAGE_ROOT, "src");

const FORBIDDEN_PACKAGES = [
  "@choco-pi/codex",
  "openai",
  "undici",
  "js-tiktoken",
  "partial-json",
  "proxy-from-env",
  "base64-js",
];

const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(["'])([^"'\n]+)\1/gm;

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(SRC, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function toPackagePath(path: string): string {
  return relative(PACKAGE_ROOT, path).split(sep).join("/");
}

async function specifiers(file: string): Promise<string[]> {
  const source = await readFile(file, "utf8");
  return [...source.matchAll(SPECIFIER_PATTERN)].map((match) => match[2] ?? "");
}

test("the package source imports no OpenAI provider package", async () => {
  const files = await sourceFiles();
  assert.ok(files.length > 50, `expected the universal tree, found ${files.length} files`);
  const violations: string[] = [];
  for (const file of files) {
    for (const specifier of await specifiers(file)) {
      if (FORBIDDEN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`)))
        violations.push(`${toPackagePath(file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("relative imports stay inside the package source", async () => {
  const violations: string[] = [];
  for (const file of await sourceFiles()) {
    for (const specifier of await specifiers(file)) {
      if (!specifier.startsWith(".")) continue;
      const target = toPackagePath(resolve(dirname(file), specifier));
      if (!target.startsWith("src/")) violations.push(`${toPackagePath(file)} -> ${target}`);
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
    'import { a } from "@choco-pi/codex/x";',
    'import type { B } from "./b.ts";',
    'export { c } from "../c.ts";',
    'const d = () => import("openai");',
    'import "./side-effect.ts";',
  ].join("\n");
  assert.deepEqual(
    [...source.matchAll(SPECIFIER_PATTERN)].map((match) => match[2]),
    ["@choco-pi/codex/x", "./b.ts", "../c.ts", "openai", "./side-effect.ts"],
  );
});
