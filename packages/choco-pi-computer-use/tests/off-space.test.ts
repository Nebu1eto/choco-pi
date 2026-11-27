import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { UiAction } from "../src/contract.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "../src/json.ts";
import type { ComputerUsePlatformBackend } from "../src/platform/types.ts";
import { createTestExtensionContext } from "./helpers/extension-context.ts";
import {
  CUSTOM_VIEW_NAME,
  FAKE_APP,
  startFakeHelperDaemon,
  type FakeHelperDaemon,
  type FakeHelperDaemonOptions,
} from "./helpers/fake-helper-daemon.ts";

const scratch = await mkdtemp(path.join(os.tmpdir(), "cu-off-space-"));
const socketPath = path.join(scratch, "bridge.sock");
process.env.PI_CU_SOCKET_PATH = socketPath;
const scratchAppPath = path.join(scratch, "pi-computer-use.app");
const scratchExecutablePath = path.join(scratchAppPath, "Contents", "MacOS", "bridge");
await mkdir(path.dirname(scratchExecutablePath), { recursive: true });
await writeFile(scratchExecutablePath, "");
const scratchExecutableMtime = Math.floor(Date.now() / 1000) - 86_400;
await utimes(scratchExecutablePath, scratchExecutableMtime, scratchExecutableMtime);
process.env.PI_COMPUTER_USE_HELPER_APP_PATH = scratchAppPath;
const helper = await import("../src/platform/macos/helper.ts");
const { macosBackend } = await import("../src/platform/macos/backend.ts");
const { ensureMacosReady, releaseMacosOwnership } =
  await import("../src/platform/macos/permissions.ts");
const { replacePlatformBackendForTest } = await import("../src/platform/index.ts");
const { AppBlockedError } = await import("../src/app-policy.ts");
const bridge = await import("../src/bridge.ts");
const { helperRequestSession } = await import("../src/bridge/state-store.ts");

const agentDir = path.join(scratch, "agent");
const projectDir = path.join(scratch, "project");
const userConfigPath = path.join(agentDir, "extensions", "pi-computer-use.json");
const INCREMENT = "@e3";
const CUSTOM_VIEW = "@e5";

const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_COMPUTER_USE_HEADLESS",
  "PI_COMPUTER_USE_BROWSER_USE",
  "PI_COMPUTER_USE_DELIVERY_POLICY",
  "PI_COMPUTER_USE_EVENT_DELIVERY",
  "PI_COMPUTER_USE_FOREGROUND_GRANT",
  "PI_COMPUTER_USE_FOREGROUND_PROMPT",
  "PI_COMPUTER_USE_BACKGROUND_DELIVERY",
  "PI_COMPUTER_USE_BLOCKED_APPS",
] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

let daemon: FakeHelperDaemon | undefined;

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function prepare(user: JsonObject | undefined): Promise<void> {
  await rm(path.dirname(userConfigPath), { recursive: true, force: true });
  await mkdir(path.dirname(userConfigPath), { recursive: true });
  await mkdir(path.join(projectDir, ".pi"), { recursive: true });
  if (user) await writeFile(userConfigPath, JSON.stringify(user));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_COMPUTER_USE_HEADLESS = "0";
  process.env.PI_COMPUTER_USE_BROWSER_USE = "0";
}

function wireBackend(): ComputerUsePlatformBackend {
  return {
    name: "macos",
    ensureReady: ensureMacosReady,
    listApps: macosBackend.listApps,
    listRoots: macosBackend.listRoots,
    getFrontmost: macosBackend.getFrontmost,
    focusWindow: macosBackend.focusWindow,
    restoreUserFocus: macosBackend.restoreUserFocus,
    observe: macosBackend.observe,
    act: macosBackend.act,
    actBatch: macosBackend.actBatch,
    readText: macosBackend.readText,
    waitFor: macosBackend.waitFor,
    isBrowserApp: () => false,
    isChromeFamilyApp: () => false,
    openBrowserLocation: async () => false,
  };
}

function textOf<T>(result: AgentToolResult<T>): string {
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function detailsOf<T>(result: AgentToolResult<T>): JsonObject {
  const parsed: JsonValue = JSON.parse(JSON.stringify(result.details));
  assert.ok(isJsonObject(parsed));
  return parsed;
}

function stateIdOf<T>(result: AgentToolResult<T>): string {
  const match = /\bstate(?:_id)? ([0-9a-f-]{36})\b/i.exec(textOf(result));
  if (!match?.[1]) throw new Error("Expected a state id in tool output.");
  return match[1];
}

function firstWindow(details: JsonObject): JsonObject {
  const windows = details.windows;
  assert.ok(Array.isArray(windows) && windows.length > 0, "find_roots listed a root");
  const first = windows[0];
  assert.ok(isJsonObject(first));
  return first;
}

async function rejection<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, "the call rejects with an Error");
    return error;
  }
  assert.fail("expected the call to reject");
}

interface Session {
  fake: FakeHelperDaemon;
  find(): Promise<AgentToolResult<unknown>>;
  observe(): Promise<AgentToolResult<unknown>>;
  act(stateId: string, actions: UiAction[]): Promise<AgentToolResult<unknown>>;
}

async function withSession(
  fake: Partial<Omit<FakeHelperDaemonOptions, "socketPath">>,
  user: JsonObject | undefined,
  body: (session: Session) => Promise<void>,
): Promise<void> {
  await daemon?.close();
  daemon = await startFakeHelperDaemon({
    socketPath,
    userApp: "neutral",
    script: "s1-ok",
    ...fake,
  });
  const started = daemon;
  await prepare(user);
  const restore = replacePlatformBackendForTest(wireBackend());
  const signal = new AbortController().signal;
  try {
    const ctx = await createTestExtensionContext(projectDir);
    await bridge.shutdownComputerUseSession();
    await body({
      fake: started,
      find: async () =>
        await bridge.executeFind("find", { app: FAKE_APP.appName }, signal, undefined, ctx),
      observe: async () =>
        await bridge.executeObserve("observe", { root: "@r1" }, signal, undefined, ctx),
      act: async (stateId, actions) =>
        await bridge.executeAct("act", { stateId, actions }, signal, undefined, ctx),
    });
  } finally {
    await bridge.shutdownComputerUseSession();
    await releaseMacosOwnership(AbortSignal.timeout(1_000));
    restore();
  }
}

before(() => {
  assert.equal(helper.HELPER_SOCKET_PATH, socketPath, "tests must only use the scratch socket");
});

afterEach(restoreEnv);

after(async () => {
  await daemon?.close();
  await rm(scratch, { recursive: true, force: true });
});

test("an off-Space window the app exposed is listed off_space, observed and pressed in standard mode, and the results say so", async () => {
  await withSession({ offSpace: "resolved" }, undefined, async (session) => {
    const found = await session.find();
    const root = firstWindow(detailsOf(found));
    assert.equal(root.off_space, true);
    assert.equal(root.off_space_access, "readable");
    assert.equal(root.isOnscreen, false);
    assert.match(textOf(found), /off_space \(on a Space no display shows\)/);

    const observed = await session.observe();
    const observedDetails = detailsOf(observed);
    assert.equal(field(observedDetails, "off_space").discovery_activation, false);
    assert.match(
      textOf(observed),
      /on a Space no display shows; it was read without switching Spaces\./,
    );
    const look = session.fake.requests.find((request) => request.cmd === "look");
    assert.ok(look);
    assert.equal(look.backgroundDelivery, undefined, "standard looks ask for no discovery");

    const acted = await session.act(stateIdOf(observed), [{ action: "click", ref: INCREMENT }]);
    assert.match(textOf(acted), /without switching Spaces, and no discovery activation was used/);
    const acts = session.fake.requests.filter((request) => request.cmd === "act");
    assert.equal(acts.length, 1);
    assert.equal(acts[0]!.policy, "background");
    assert.equal(session.fake.offSpaceDiscoveries(), 0);
  });
});

test("a never-shown off-Space window is listed as needing discovery and refused in standard mode with its own code", async () => {
  await withSession(
    { offSpace: "never_shown", extendedDelivery: "available" },
    undefined,
    async (session) => {
      const root = firstWindow(detailsOf(await session.find()));
      assert.equal(root.off_space, true);
      assert.equal(root.off_space_access, "needs_discovery");
      assert.equal(root.nativeWindowRef, undefined, "no AX root ref without the window's element");
      const error = await rejection(session.observe());
      assert.match(error.message, /^off_space_window_unresolved: /);
      assert.match(error.message, /show the window once/);
      assert.match(error.message, /background_delivery: "extended"/);
      assert.doesNotMatch(error.message, /not found/i);
      assert.equal(session.fake.offSpaceDiscoveries(), 0, "standard mode never activates");
    },
  );
});

test("background_delivery extended observes a never-shown off-Space window after exactly one discovery activation", async () => {
  await withSession(
    { offSpace: "never_shown", extendedDelivery: "available" },
    { background_delivery: "extended" },
    async (session) => {
      await session.find();
      const observed = await session.observe();
      const details = detailsOf(observed);
      assert.equal(field(details, "off_space").discovery_activation, true);
      assert.match(textOf(observed), /after a one-time discovery activation/);
      const looks = session.fake.requests.filter((request) => request.cmd === "look");
      assert.equal(looks[0]!.backgroundDelivery, "extended");
      const again = detailsOf(await session.observe());
      assert.equal(field(again, "off_space").discovery_activation, false);
      assert.equal(session.fake.offSpaceDiscoveries(), 1);
    },
  );
});

test("extended delivery without the helper's discovery capability refuses and says why", async () => {
  await withSession(
    { offSpace: "never_shown", extendedDelivery: "unavailable" },
    { background_delivery: "extended" },
    async (session) => {
      await session.find();
      const error = await rejection(session.observe());
      assert.match(error.message, /^off_space_window_unresolved: /);
      assert.match(error.message, /unavailable in this helper/);
      assert.equal(session.fake.offSpaceDiscoveries(), 0);
    },
  );
});

test("a blocked app's off-Space window is flagged in find_roots and refused before any look", async () => {
  await withSession(
    { offSpace: "never_shown", extendedDelivery: "available" },
    { blocked_apps: [FAKE_APP.bundleId], background_delivery: "extended" },
    async (session) => {
      const root = firstWindow(detailsOf(await session.find()));
      assert.equal(root.off_space, true);
      assert.equal(root.blocked, true);
      const listing = session.fake.requests.find((request) => request.cmd === "listRoots");
      assert.ok(listing);
      const list = field(listing, "appBlocklist");
      assert.ok(Array.isArray(list.bundleIds) && list.bundleIds.includes(FAKE_APP.bundleId));
      const error = await rejection(session.observe());
      assert.ok(error instanceof AppBlockedError, String(error));
      assert.equal(session.fake.requests.filter((request) => request.cmd === "look").length, 0);
      assert.equal(session.fake.offSpaceDiscoveries(), 0);
    },
  );
});

test("a foreground grant is not used for an off-Space window: no foreground act or focus request is sent", async () => {
  await withSession(
    { offSpace: "resolved", script: "s2-foreground-required" },
    { foreground_grant: [FAKE_APP.bundleId] },
    async (session) => {
      await session.find();
      const observed = await session.observe();
      const line = textOf(observed)
        .split("\n")
        .find((candidate) => candidate.trim().startsWith(CUSTOM_VIEW + " "));
      assert.match(line ?? "", new RegExp(CUSTOM_VIEW_NAME));
      let outcome: string;
      try {
        outcome = textOf(
          await session.act(stateIdOf(observed), [{ action: "click", ref: CUSTOM_VIEW }]),
        );
      } catch (error) {
        outcome = error instanceof Error ? error.message : "non-error rejection";
      }
      const acts = session.fake.requests.filter((request) => request.cmd === "act");
      assert.ok(acts.length >= 1, "the click was attempted");
      assert.match(outcome, /Space no display shows/);
      assert.doesNotMatch(outcome, /uses foreground input/);
      for (const act of acts) {
        assert.equal(act.policy, "background", outcome);
        assert.equal(act.foregroundGrant, undefined);
      }
      assert.equal(
        session.fake.requests.filter((request) =>
          ["focusWindow", "restoreUserFocus"].includes(String(request.cmd)),
        ).length,
        0,
      );
    },
  );
});

test("the helper's off_space_foreground refusal reaches the client with its code and no input sent", async () => {
  await withSession({ offSpace: "resolved" }, undefined, async (session) => {
    await session.find();
    const look = await macosBackend.observe({
      target: { pid: FAKE_APP.pid, windowId: 1 },
      readText: "never",
    });
    const error = await rejection(
      macosBackend.act({
        requestId: "off-space-foreground",
        session: { ...helperRequestSession },
        budgetMs: 5_000,
        lookId: look.lookId,
        pid: FAKE_APP.pid,
        target: { ref: "button-1" },
        policy: "foreground",
        foregroundGrant: true,
        action: "press",
        params: { delivery: "hid" },
      }),
    );
    assert.ok(error instanceof helper.HelperCommandError, String(error));
    assert.equal(error.code, "off_space_foreground");
    assert.equal(error.effectPossible, false);
    assert.match(error.message, /switch the user's Space/);
    void session;
  });
});

function field(value: JsonObject, key: string): JsonObject {
  const nested = value[key];
  assert.ok(isJsonObject(nested), "expected object field '" + key + "'");
  return nested;
}
