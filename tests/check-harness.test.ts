import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkHarness,
  parseCliArgs,
  type HarnessOptions,
} from "../.pi/skills/check/scripts/check-harness.ts";

const root = "/fixture/.pi";

function fixture(overrides: Partial<HarnessOptions> = {}) {
  const reads: string[] = [];
  const files = new Map<string, string>([
    [path.join(root, "settings.json"), JSON.stringify({ packages: [], tuiMode: "inline" })],
  ]);
  return {
    reads,
    options: {
      configRoot: root,
      mode: "automatic" as const,
      nodeVersion: "v24.0.0",
      readText: async (target: string) => {
        reads.push(target);
        const value = files.get(target);
        if (value === undefined) throw new Error(`missing fixture: ${target}`);
        return value;
      },
      pathExists: async () => false,
      runCommand: async () => ({ status: 0, stdout: "0.84.2\n", stderr: "" }),
      ...overrides,
    },
  };
}

test("automatic core readiness warns for irrelevant optional failures", async () => {
  const { options } = fixture();
  const report = await checkHarness(options);

  assert.equal(report.status, "warn");
  assert.equal(report.mode, "automatic");
  assert.deepEqual(report.requiredCapabilities, []);
  assert.equal(report.checks.find((check) => check.id === "tui-mode")?.status, "warn");
  assert.equal(report.checks.find((check) => check.id === "choco-pi-lsp")?.status, "warn");
  assert.equal(report.checks.find((check) => check.id === "settings")?.status, "pass");
});

test("a requested unavailable capability fails closed", async () => {
  const { options } = fixture({ requiredCapabilities: ["lsp"] });
  const report = await checkHarness(options);

  assert.equal(report.status, "fail");
  assert.equal(report.checks.find((check) => check.id === "choco-pi-lsp")?.status, "fail");
  assert.equal(report.checks.find((check) => check.id === "tui-mode")?.status, "warn");
});

test("full check preserves every capability failure", async () => {
  const { options } = fixture({ mode: "full" });
  const report = await checkHarness(options);

  assert.equal(report.status, "fail");
  assert.equal(report.requiredCapabilities, "all");
  for (const id of ["tui-mode", "subagents", "resources", "choco-pi-lsp"]) {
    assert.equal(report.checks.find((check) => check.id === id)?.status, "fail");
  }
});

test("invalid CLI input is rejected before a check can run", () => {
  assert.throws(() => parseCliArgs(["--automatic", "--require", "shell"]), /unknown capability/);
  assert.throws(() => parseCliArgs(["--execute", "anything"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["--automatic", "--require"]), /needs a capability/);
});

test("direct and symlink CLI entries reject invalid input", () => {
  const scriptPath = fileURLToPath(
    new URL("../.pi/skills/check/scripts/check-harness.ts", import.meta.url),
  );
  const tempRoot = mkdtempSync(path.join(tmpdir(), "choco-pi-check-"));
  const symlinkPath = path.join(tempRoot, "check-entry.ts");
  symlinkSync(scriptPath, symlinkPath);

  try {
    for (const entry of [scriptPath, symlinkPath]) {
      const result = spawnSync(process.execPath, [entry, "--invalid"], { encoding: "utf8" });
      assert.equal(result.status, 2, entry);
      assert.equal(result.stdout, "", entry);
      assert.match(result.stderr, /unknown argument: --invalid/, entry);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("malformed core settings cannot be downgraded", async () => {
  const { options } = fixture({ readText: async () => "not-json" });
  const report = await checkHarness(options);

  assert.equal(report.status, "fail");
  assert.equal(report.checks.find((check) => check.id === "settings")?.status, "fail");
});

test("checks never read credential files", async () => {
  const { options, reads } = fixture();
  await checkHarness(options);

  assert.equal(
    reads.some((target) => /(?:auth\.json|credential|token|secret)/i.test(target)),
    false,
  );
});
