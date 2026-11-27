import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProcesses, type ProcessRow } from "./chromium.ts";

const BUNDLE = "/Applications/Google Chrome.app";
const MAIN = BUNDLE + "/Contents/MacOS/Google Chrome";
const HELPER =
  BUNDLE + "/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper";
const CRASHPAD =
  BUNDLE + "/Contents/Frameworks/Google Chrome Framework.framework/Helpers/chrome_crashpad_handler";
const DIR = "/tmp/run-1/chromium-profile";
const T0 = "Fri 27 Nov 02:00:00 2026";
const T1 = "Fri 27 Nov 02:00:05 2026";

function row(
  pid: number,
  ppid: number,
  executable: string,
  args: string,
  started = T0,
): ProcessRow {
  return { pid, ppid, started, executable, args };
}

test("ownership: descendants recorded while the browser lived, never a reused pid", () => {
  const recorded = new Map<number, string>();
  const live = [
    row(100, 1, MAIN, MAIN + " --user-data-dir=" + DIR),
    row(101, 100, HELPER, HELPER + " --type=renderer"),
    row(102, 101, "/bin/sleep", "sleep 5"),
  ];
  const first = classifyProcesses({
    spawnedPid: 100,
    recorded,
    table: live,
    appBundle: BUNDLE,
    userDataDir: DIR,
    selfPid: 9,
  });
  assert.deepEqual(first.owned.map((entry) => entry.pid).sort(), [100, 101, 102]);
  const after = [
    row(101, 1, HELPER, HELPER + " --type=renderer"),
    row(102, 1, "/bin/zsh", "zsh", T1),
  ];
  const later = classifyProcesses({
    spawnedPid: -1,
    recorded,
    table: after,
    appBundle: BUNDLE,
    userDataDir: DIR,
    selfPid: 9,
  });
  assert.deepEqual(
    later.owned.map((entry) => entry.pid),
    [101],
    "the reparented helper stays owned",
  );
  assert.deepEqual(
    later.leftovers,
    [],
    "a reused pid that names nothing of ours is not even a leftover",
  );
});

test("ownership: a non-descendant needs the launched bundle and this run's profile argument", () => {
  const table = [
    row(200, 1, HELPER, HELPER + " --type=gpu-process --user-data-dir=" + DIR),
    row(201, 1, HELPER, HELPER + " --user-data-dir=" + DIR + "-other"),
    row(202, 1, "/bin/sh", "/bin/sh -c sleep 30; : --user-data-dir=" + DIR),
    row(
      203,
      1,
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "Chromium --user-data-dir=" + DIR,
    ),
    row(
      204,
      1,
      CRASHPAD,
      CRASHPAD + " --database=" + DIR + "/Crashpad --url=https://example.invalid",
    ),
    row(
      205,
      1,
      CRASHPAD,
      CRASHPAD + " --database=/Users/someone/Library/Application Support/Google/Chrome/Crashpad",
    ),
    row(206, 1, CRASHPAD, CRASHPAD + " --annotation=user-data-dir=" + DIR),
    row(207, 1, HELPER, HELPER + " --user-data-dir=/somewhere/else"),
    row(208, 1, "/usr/bin/grep", "grep x"),
  ];
  const result = classifyProcesses({
    spawnedPid: -1,
    recorded: new Map(),
    table,
    appBundle: BUNDLE,
    userDataDir: DIR,
    selfPid: 9,
  });
  assert.deepEqual(result.owned.map((entry) => entry.pid).sort(), [200, 204, 206]);
  assert.deepEqual(result.leftovers.map((entry) => entry.pid).sort(), [201, 202, 203, 205, 207]);
  const reasons = new Map(result.leftovers.map((entry) => [entry.pid, entry.reason]));
  assert.match(reasons.get(202) ?? "", /executable outside/);
  assert.match(reasons.get(201) ?? "", /no argument names this run's profile directory/);
});
