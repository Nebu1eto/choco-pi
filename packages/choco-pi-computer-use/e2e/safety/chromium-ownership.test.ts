import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChromiumInstance } from "./chromium.ts";

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

test(
  "stop signals the spawned browser and its descendants, never a process that only names the profile",
  { timeout: 60_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-chromium-own-"));
    const bundle = join(dir, "Fake Browser.app");
    const binary = join(bundle, "Contents", "MacOS", "Fake Browser");
    await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
    await writeFile(binary, "#!/bin/sh\n/bin/sleep 30 &\nwait\n");
    await chmod(binary, 0o755);
    const profile = join(dir, "profile");
    const instance = await ChromiumInstance.launch(
      { app: bundle, binary, version: null, bundleId: null },
      profile,
      "about:blank",
      join(dir, "browser.log"),
    );
    const impostor = spawn(
      "/bin/sh",
      ["-c", "sleep 30; :", "impostor", "--user-data-dir=" + profile],
      { stdio: "ignore" },
    );
    const sibling = spawn(
      "/bin/sh",
      ["-c", "sleep 30; :", "sibling", "--user-data-dir=" + profile + "-x"],
      { stdio: "ignore" },
    );
    try {
      await pause(800);
      const owned = await instance.ownedPids();
      assert.ok(owned.includes(instance.pid), "the spawned browser is owned");
      assert.ok(owned.length >= 2, "its child is owned: " + owned.join(","));
      assert.ok(!owned.includes(impostor.pid ?? -1), "the impostor is not owned");
      assert.ok(!owned.includes(sibling.pid ?? -1), "the sibling-profile process is not owned");
      const stopped = await instance.stop();
      assert.ok(alive(impostor.pid), "the impostor was not signalled");
      assert.ok(alive(sibling.pid), "the sibling-profile process was not signalled");
      assert.ok(!stopped.pids.includes(impostor.pid ?? -1));
      for (const pid of owned) assert.ok(!alive(pid), "owned pid " + String(pid) + " stopped");
      assert.ok(
        stopped.leftovers.some((left) => left.pid === impostor.pid),
        "the impostor is reported as a leftover",
      );
    } finally {
      impostor.kill("SIGKILL");
      sibling.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  },
);
