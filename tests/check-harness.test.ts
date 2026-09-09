import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { promisify } from "node:util";
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
const execFileAsync = promisify(execFile);

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
      pathExists: async () => true,
      runCommand: async () => ({ status: 0, stdout: "0.85.1\n", stderr: "" }),
      ...overrides,
    },
  };
}

test("Pi readiness requires exactly the supported SDK release", async () => {
  for (const version of ["0.84.2", "0.85.0", "0.85.1", "0.85.2", "0.85.1-rc.1", "garbage"]) {
    const { options } = fixture({
      runCommand: async () => ({ status: 0, stdout: `${version}\n`, stderr: "" }),
    });
    const report = await checkHarness(options);
    assert.equal(
      report.checks.find((check) => check.id === "pi")?.status,
      version === "0.85.1" ? "pass" : "fail",
      version,
    );
  }
});

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
  const { options } = fixture({ mode: "full", pathExists: async () => false });
  const report = await checkHarness(options);

  assert.equal(report.status, "fail");
  assert.equal(report.requiredCapabilities, "all");
  for (const id of ["tui-mode", "subagents", "resources", "choco-pi-lsp"]) {
    assert.equal(report.checks.find((check) => check.id === id)?.status, "fail");
  }
});

for (const missing of ["SYSTEM.md", "scripts/checkout-mutation-lease.ts"]) {
  test(`automatic readiness blocks missing ${missing}`, async () => {
    const { options } = fixture({
      pathExists: async (target) => target !== path.join(root, missing),
    });
    const report = await checkHarness(options);
    assert.equal(report.status, "fail");
    assert.equal(report.checks.find((check) => check.id === "core-resources")?.status, "fail");
  });
}

test("optional resources block only when requested", async () => {
  for (const required of [false, true]) {
    const { options } = fixture({
      requiredCapabilities: required ? ["resources"] : [],
      pathExists: async (target) => target !== path.join(root, "extensions/apex-provider.ts"),
    });
    const report = await checkHarness(options);
    assert.equal(report.status, required ? "fail" : "warn");
    assert.equal(report.checks.find((check) => check.id === "core-resources")?.status, "pass");
    assert.equal(
      report.checks.find((check) => check.id === "resources")?.status,
      required ? "fail" : "warn",
    );
  }
});

test("invalid CLI input is rejected before a check can run", () => {
  assert.throws(() => parseCliArgs(["--automatic", "--require", "shell"]), /unknown capability/);
  assert.throws(() => parseCliArgs(["--execute", "anything"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["--automatic", "--require"]), /needs a capability/);
});

test("direct and symlink CLI entries reject invalid input", async () => {
  const scriptPath = fileURLToPath(
    new URL("../.pi/skills/check/scripts/check-harness.ts", import.meta.url),
  );
  const executable = process.execPath;
  const tempRoot = await mkdtemp(path.join(tmpdir(), "choco-pi-check-"));
  const symlinkPath = path.join(tempRoot, "check-entry.ts");

  try {
    await symlink(scriptPath, symlinkPath);
    for (const entry of [scriptPath, symlinkPath]) {
      await assert.rejects(execFileAsync(executable, [entry, "--invalid"]), {
        code: 2,
        stdout: "",
        stderr: "unknown argument: --invalid\n",
      });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("importing the harness does not run the CLI with absent or unrelated entry paths", async () => {
  const scriptUrl = new URL("../.pi/skills/check/scripts/check-harness.ts", import.meta.url).href;
  const executable = process.execPath;
  for (const entry of [
    undefined,
    "/nonexistent/choco-pi-entry.ts",
    fileURLToPath(import.meta.url),
  ]) {
    const source = `process.argv[1] = ${JSON.stringify(entry)}; await import(${JSON.stringify(scriptUrl)});`;
    const result = await execFileAsync(executable, ["--input-type=module", "--eval", source]);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
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
