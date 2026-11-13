import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultAuthFile, MissingAuthTokenError, readAuthToken } from "../figma/common/auth.ts";
import { writeAuthToken } from "../figma/common/auth-config.ts";

const ENV_KEYS = [
  "HOME",
  "PI_CODING_AGENT_DIR",
  "CHOCO_PI_STANDALONE",
  "CHOCO_PI_HOME",
  "FIGMA_AUTH_PATH_TEST_TOKEN",
] as const;

async function withScratch(
  run: (paths: { home: string; chocoHome: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "figma-auth-path-"));
  const previous = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  const home = path.join(root, "home");
  process.env.HOME = home;
  try {
    await run({ home, chocoHome: path.join(root, "choco") });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const options = { envName: "FIGMA_AUTH_PATH_TEST_TOKEN", authPath: ["figma", "token"] } as const;

test("figma auth file is CHOCO_PI_HOME/agent/auth.json standalone and ~/.pi/agent/auth.json legacy", () => {
  assert.equal(
    defaultAuthFile({ CHOCO_PI_STANDALONE: "1", CHOCO_PI_HOME: "/choco" }, "/home/user"),
    path.join("/choco", "agent", "auth.json"),
  );
  assert.equal(
    defaultAuthFile({}, "/home/user"),
    path.join("/home/user", ".pi", "agent", "auth.json"),
  );
});

test("standalone figma auth never reads ~/.pi/agent/auth.json and writes under CHOCO_PI_HOME", async () => {
  await withScratch(async ({ home, chocoHome }) => {
    const legacyAuth = path.join(home, ".pi", "agent", "auth.json");
    await mkdir(path.dirname(legacyAuth), { recursive: true });
    await writeFile(legacyAuth, JSON.stringify({ figma: { token: "legacy-token" } }));
    process.env.CHOCO_PI_STANDALONE = "1";
    process.env.CHOCO_PI_HOME = chocoHome;
    const standaloneAuth = path.join(chocoHome, "agent", "auth.json");
    let failure: Error | undefined;
    try {
      await readAuthToken(options);
    } catch (error) {
      if (error instanceof Error) failure = error;
    }
    assert.ok(failure instanceof MissingAuthTokenError);
    assert.ok(failure.message.includes(standaloneAuth), failure.message);
    await writeAuthToken({ authPath: options.authPath, token: "standalone-token" });
    assert.deepEqual(JSON.parse(await readFile(standaloneAuth, "utf8")), {
      figma: { token: "standalone-token" },
    });
    assert.equal(await readAuthToken(options), "standalone-token");
    assert.deepEqual(JSON.parse(await readFile(legacyAuth, "utf8")), {
      figma: { token: "legacy-token" },
    });
  });
});

test("legacy figma auth still reads ~/.pi/agent/auth.json", async () => {
  await withScratch(async ({ home }) => {
    const legacyAuth = path.join(home, ".pi", "agent", "auth.json");
    await mkdir(path.dirname(legacyAuth), { recursive: true });
    await writeFile(legacyAuth, JSON.stringify({ figma: { token: "legacy-token" } }));
    assert.equal(await readAuthToken(options), "legacy-token");
  });
});
