import assert from "node:assert/strict";
import test from "node:test";
import { dedupeInFlight } from "../clients/in-flight-dedup.ts";
import {
  buildOpengrepInitialization,
  buildOpengrepScanArgs,
  DEFAULT_OPENGREP_JOBS,
  MAX_OPENGREP_JOBS,
  resolveOpengrepJobs,
} from "../clients/opengrep-runtime.ts";

test("bounds Opengrep workers and accepts an in-range positive integer override", () => {
  assert.equal(resolveOpengrepJobs({}), DEFAULT_OPENGREP_JOBS);
  assert.equal(resolveOpengrepJobs({ CHOCO_PI_LSP_OPENGREP_JOBS: "1" }), 1);
  assert.equal(
    resolveOpengrepJobs({ CHOCO_PI_LSP_OPENGREP_JOBS: String(MAX_OPENGREP_JOBS + 1) }),
    MAX_OPENGREP_JOBS,
  );
  assert.equal(resolveOpengrepJobs({ CHOCO_PI_LSP_OPENGREP_JOBS: "0" }), DEFAULT_OPENGREP_JOBS);
  assert.equal(resolveOpengrepJobs({ CHOCO_PI_LSP_OPENGREP_JOBS: "0b111" }), DEFAULT_OPENGREP_JOBS);
  assert.equal(resolveOpengrepJobs({ CHOCO_PI_LSP_OPENGREP_JOBS: "0x10" }), DEFAULT_OPENGREP_JOBS);
  assert.equal(resolveOpengrepJobs({ CHOCO_PI_LSP_OPENGREP_JOBS: "1e3" }), DEFAULT_OPENGREP_JOBS);
  assert.equal(resolveOpengrepJobs({ CHOCO_PI_LSP_OPENGREP_JOBS: "2.5" }), DEFAULT_OPENGREP_JOBS);
  assert.equal(resolveOpengrepJobs({ CHOCO_PI_LSP_OPENGREP_JOBS: " 1 " }), 1);
  assert.equal(resolveOpengrepJobs({ CHOCO_PI_LSP_OPENGREP_JOBS: "many" }), DEFAULT_OPENGREP_JOBS);
});

test("builds Opengrep LSP initialization without ambient project config", () => {
  assert.deepEqual(buildOpengrepInitialization("fixture/config.yml", 3), {
    scan: {
      configuration: ["fixture/config.yml"],
      onlyGitDirty: false,
      jobs: 3,
    },
    metrics: { enabled: false },
    doHover: false,
  });
});

test("passes the worker limit and scratch exclusions to the exact CLI arguments", () => {
  assert.deepEqual(
    buildOpengrepScanArgs({
      configArg: "auto",
      reportPath: "/tmp/report.json",
      cwd: "/tmp/project",
      excludeNames: [".scratch", ".worktrees"],
      jobs: 3,
    }),
    [
      "scan",
      "--config",
      "auto",
      "--jobs",
      "3",
      "--json",
      "--json-output",
      "/tmp/report.json",
      "--no-error",
      "--quiet",
      "--disable-version-check",
      "--exclude",
      ".scratch",
      "--exclude",
      ".worktrees",
      "/tmp/project",
    ],
  );
});

test("deduplicates concurrent operations for the same root and clears settled entries", async () => {
  const inFlight = new Map<string, Promise<object>>();
  const root = "/tmp/project";
  let runs = 0;
  const run = async (): Promise<object> => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {};
  };

  const first = dedupeInFlight(inFlight, root, run);
  const second = dedupeInFlight(inFlight, root, run);
  assert.strictEqual(first, second);
  assert.strictEqual(await first, await second);
  assert.equal(runs, 1);

  await dedupeInFlight(inFlight, root, run);
  assert.equal(runs, 2);
});
