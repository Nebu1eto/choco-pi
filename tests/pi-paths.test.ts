import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  legacyPiFallbacks,
  piAgentDir,
  piStateRoot,
  standaloneHome,
} from "../profile/extensions/lib/pi-paths.ts";
import { usageCachePath } from "../profile/extensions/lib/usage-cache.ts";

const home = "/home/user";
const chocoHome = "/opt/choco";
const standalone = { CHOCO_PI_STANDALONE: "1", CHOCO_PI_HOME: chocoHome };
const launcherEnv = { ...standalone, PI_CODING_AGENT_DIR: path.join(chocoHome, "agent") };
const legacy = {};

test("standaloneHome requires the launcher flag and an absolute CHOCO_PI_HOME", () => {
  assert.equal(standaloneHome(standalone), chocoHome);
  assert.equal(
    standaloneHome({ CHOCO_PI_STANDALONE: "1", CHOCO_PI_HOME: "/opt/x/../choco/" }),
    "/opt/choco/",
  );
  assert.equal(standaloneHome(legacy), undefined);
  assert.equal(standaloneHome({ CHOCO_PI_HOME: chocoHome }), undefined);
  assert.equal(
    standaloneHome({ CHOCO_PI_STANDALONE: "true", CHOCO_PI_HOME: chocoHome }),
    undefined,
  );
  assert.equal(
    standaloneHome({ CHOCO_PI_STANDALONE: "1", CHOCO_PI_HOME: "relative/home" }),
    undefined,
  );
  assert.equal(standaloneHome({ CHOCO_PI_STANDALONE: "1" }), undefined);
});

test("piAgentDir prefers PI_CODING_AGENT_DIR, then the standalone home, then ~/.pi/agent", () => {
  assert.equal(piAgentDir(launcherEnv, home), path.join(chocoHome, "agent"));
  assert.equal(piAgentDir(standalone, home), path.join(chocoHome, "agent"));
  assert.equal(
    piAgentDir({ ...standalone, PI_CODING_AGENT_DIR: "" }, home),
    path.join(chocoHome, "agent"),
  );
  assert.equal(piAgentDir(legacy, home), path.join(home, ".pi", "agent"));
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }, home), "/custom/agent");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "" }, home), path.join(home, ".pi", "agent"));
  assert.equal(piAgentDir({ CHOCO_PI_HOME: chocoHome }, home), path.join(home, ".pi", "agent"));
});

test("piStateRoot is the standalone home, else ~/.pi", () => {
  assert.equal(piStateRoot(standalone, home), chocoHome);
  assert.equal(piStateRoot(launcherEnv, home), chocoHome);
  assert.equal(piStateRoot(legacy, home), path.join(home, ".pi"));
  assert.equal(piStateRoot({ PI_CODING_AGENT_DIR: "/custom/agent" }, home), path.join(home, ".pi"));
});

test("legacyPiFallbacks is empty in standalone mode and ~/.pi in legacy mode", () => {
  assert.deepEqual(legacyPiFallbacks(standalone, home), []);
  assert.deepEqual(legacyPiFallbacks(launcherEnv, home), []);
  assert.deepEqual(legacyPiFallbacks(legacy, home), [path.join(home, ".pi")]);
  assert.deepEqual(legacyPiFallbacks({ PI_CODING_AGENT_DIR: "/custom/agent" }, home), [
    path.join(home, ".pi"),
  ]);
});

test("no standalone resolver result lies under ~/.pi", () => {
  const piHome = path.join(home, ".pi");
  for (const env of [standalone, launcherEnv]) {
    for (const value of [
      piAgentDir(env, home),
      piStateRoot(env, home),
      ...legacyPiFallbacks(env, home),
    ])
      assert.ok(!value.startsWith(piHome), value);
  }
});

test("the usage cache lives under CHOCO_PI_HOME in standalone mode and ~/.pi in legacy mode", () => {
  assert.equal(
    usageCachePath(standalone, home),
    path.join(chocoHome, "agent", "choco-pi", "usage-cache.json"),
  );
  assert.equal(
    usageCachePath(legacy, home),
    path.join(home, ".pi", "agent", "choco-pi", "usage-cache.json"),
  );
});
