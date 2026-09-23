import assert from "node:assert/strict";
import test from "node:test";

import {
  compareVersion,
  probeLauncherVersion,
  readImportedSdkVersion,
} from "../.pi/extensions/lib/pi-runtime-identity.ts";

test("imported SDK identity uses supported public exports", async () => {
  const observation = await readImportedSdkVersion();
  assert.equal(observation.source, "imported-sdk");
  assert.equal(observation.version, "0.87.1");
  assert.equal(observation.authoritative, true);
  assert.match(observation.path ?? "", /pi-coding-agent/);
});

test("semantic comparison handles prereleases, builds, and malformed versions", () => {
  const cases: ReadonlyArray<readonly [string, string, -1 | 0 | 1 | undefined]> = [
    ["0.87.1", "0.87.1", 0],
    ["0.87.1+local", "0.87.1+other", 0],
    ["0.87.1-rc.2", "0.87.1-rc.10", -1],
    ["0.87.1-1", "0.87.1-alpha", -1],
    ["0.87.1", "0.87.1-rc.1", 1],
    ["0.87.0", "0.86.9", 1],
    ["99999999999999999999.0.0", "99999999999999999998.0.0", 1],
    ["0.86", "0.87.1", undefined],
    ["0.86.01", "0.87.1", undefined],
    ["garbage", "0.87.1", undefined],
  ];
  for (const [left, right, expected] of cases) {
    assert.equal(compareVersion(left, right), expected, `${left} vs ${right}`);
  }
});

test("launcher probing uses a literal executable and never invokes a shell", async () => {
  const calls: Array<{ executable: string; args: readonly string[]; timeoutMs: number }> = [];
  const observation = await probeLauncherVersion({
    executable: "/tmp/fake managers/pi alias",
    timeoutMs: 25,
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, timeoutMs: options.timeoutMs });
      return { status: 0, stdout: "0.87.1\n", stderr: "startup banner was not sourced" };
    },
  });
  assert.deepEqual(calls, [
    { executable: "/tmp/fake managers/pi alias", args: ["--version"], timeoutMs: 25 },
  ]);
  assert.equal(observation.version, "0.87.1");
  assert.equal(observation.authoritative, false);
});

test("launcher probe preserves cancellation and timeout failures as launcher evidence", async () => {
  const controller = new AbortController();
  controller.abort();
  const observation = await probeLauncherVersion({
    signal: controller.signal,
    runCommand: async (_executable, _args, options) => {
      assert.equal(options.signal?.aborted, true);
      throw new Error("cancelled");
    },
  });
  assert.equal(observation.version, undefined);
  assert.equal(observation.error, "cancelled");
});
