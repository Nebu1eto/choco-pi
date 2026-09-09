import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PACKAGE_NAMES = [
  "choco-pi-codex",
  "choco-pi-lsp",
  "choco-pi-mcp",
  "choco-pi-provider-synthetic",
  "choco-pi-subagents",
  "choco-pi-web-access",
] as const;

const ROOT = new URL("../", import.meta.url);
const EXACT_PACKAGE_MANAGER = "pnpm@11.11.0";
const COMMON_WORKSPACE = `packages:
  - .

minimumReleaseAgeExclude:
  - typebox@1.3.29
`;
const SYNTHETIC_WORKSPACE = `packages:
  - .

overrides:
  "@earendil-works/pi-ai": 0.84.0
  "@earendil-works/pi-tui": 0.84.0

minimumReleaseAgeExclude:
  - typebox@1.3.29
`;

async function readText(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}

test("root and vendored packages require the exact pnpm toolchain", async () => {
  // SAFETY: this repository-controlled manifest is exercised only through optional scalar fields.
  const rootManifest = JSON.parse(await readText("package.json")) as {
    packageManager?: string;
    scripts?: Record<string, string>;
  };
  assert.equal(rootManifest.packageManager, EXACT_PACKAGE_MANAGER);
  assert.equal(rootManifest.scripts?.["install:vendored"], "node scripts/bootstrap-vendored.ts");

  for (const packageName of PACKAGE_NAMES) {
    // SAFETY: each repository-controlled manifest is exercised only through optional policy fields.
    const manifest = JSON.parse(await readText(`.pi/packages/${packageName}/package.json`)) as {
      packageManager?: string;
      pnpm?: unknown;
    };
    assert.equal(manifest.packageManager, EXACT_PACKAGE_MANAGER, packageName);
    assert.equal(manifest.pnpm, undefined, `${packageName} must keep pnpm policy in its workspace`);
  }
});

test("each vendored install is an isolated one-package workspace", async () => {
  for (const packageName of PACKAGE_NAMES) {
    const workspace = await readText(`.pi/packages/${packageName}/pnpm-workspace.yaml`);
    const expected =
      packageName === "choco-pi-provider-synthetic" ? SYNTHETIC_WORKSPACE : COMMON_WORKSPACE;
    assert.equal(workspace, expected, packageName);
  }
});

test("the synthetic frozen lock retains exact SDK overrides and TypeBox", async () => {
  const lock = await readText(".pi/packages/choco-pi-provider-synthetic/pnpm-lock.yaml");
  assert.match(
    lock,
    /overrides:\n  '@earendil-works\/pi-ai': 0\.84\.0\n  '@earendil-works\/pi-tui': 0\.84\.0/,
  );
  assert.match(lock, /typebox:\n        specifier: \^1\.3\.29\n        version: 1\.3\.29/);
});
