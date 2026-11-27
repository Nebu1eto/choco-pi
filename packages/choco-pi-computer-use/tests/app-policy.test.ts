import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "../src/json.ts";
import type { ComputerUsePlatformBackend } from "../src/platform/types.ts";
import { createTestExtensionContext } from "./helpers/extension-context.ts";
import {
  FAKE_APP,
  startFakeHelperDaemon,
  type FakeHelperDaemon,
} from "./helpers/fake-helper-daemon.ts";

const scratch = await mkdtemp(path.join(os.tmpdir(), "cu-app-policy-"));
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
const bridge = await import("../src/bridge.ts");
const policy = await import("../src/app-policy.ts");
const config = await import("../src/config.ts");
const { runComputerUseCommand } = await import("../extensions/computer-use.ts");

const TERMINAL = { appName: "Terminal", bundleId: "com.apple.Terminal", pid: 4141 };
const agentDir = path.join(scratch, "agent");
const projectDir = path.join(scratch, "project");
const userConfigPath = path.join(agentDir, "extensions", "pi-computer-use.json");
const projectConfigPath = path.join(projectDir, ".pi", "computer-use.json");

const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_COMPUTER_USE_HEADLESS",
  "PI_COMPUTER_USE_BROWSER_USE",
  "PI_COMPUTER_USE_DELIVERY_POLICY",
  "PI_COMPUTER_USE_EVENT_DELIVERY",
  "PI_COMPUTER_USE_FOREGROUND_GRANT",
  "PI_COMPUTER_USE_BLOCKED_APPS",
  "PI_COMPUTER_USE_UNBLOCKED_APPS",
  "__CFBundleIdentifier",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

let daemon: FakeHelperDaemon | undefined;
let restoreBackend: (() => void) | undefined;
let restoreProbe: (() => void) | undefined;

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

async function teardown(): Promise<void> {
  await bridge.shutdownComputerUseSession();
  await releaseMacosOwnership(AbortSignal.timeout(1_000));
  restoreBackend?.();
  restoreBackend = undefined;
  restoreProbe?.();
  restoreProbe = undefined;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface Setup {
  user?: JsonObject;
  project?: JsonObject;
  env?: Partial<Record<EnvKey, string>>;
  ancestry?: () => Promise<number[]>;
}

async function setup(
  options: Setup = {},
): Promise<{ ctx: ExtensionContext; fake: FakeHelperDaemon }> {
  await teardown();
  await daemon?.close();
  daemon = await startFakeHelperDaemon({ socketPath, script: "s1-ok" });
  await rm(path.dirname(userConfigPath), { recursive: true, force: true });
  await rm(path.dirname(projectConfigPath), { recursive: true, force: true });
  await mkdir(path.dirname(userConfigPath), { recursive: true });
  await mkdir(path.dirname(projectConfigPath), { recursive: true });
  if (options.user) await writeFile(userConfigPath, JSON.stringify(options.user));
  if (options.project) await writeFile(projectConfigPath, JSON.stringify(options.project));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_COMPUTER_USE_HEADLESS = "0";
  process.env.PI_COMPUTER_USE_BROWSER_USE = "0";
  for (const key of ENV_KEYS) {
    const value = options.env?.[key];
    if (value !== undefined) process.env[key] = value;
  }
  restoreProbe = policy.replaceHostAncestryProbeForTest(
    options.ancestry ?? (async () => [process.pid]),
  );
  restoreBackend = replacePlatformBackendForTest(wireBackend());
  const ctx = await createTestExtensionContext(projectDir);
  return { ctx, fake: daemon };
}

before(() => {
  assert.equal(helper.HELPER_SOCKET_PATH, socketPath, "tests must only use the scratch socket");
});

afterEach(teardown);

after(async () => {
  await daemon?.close();
  await rm(scratch, { recursive: true, force: true });
});

const signal = new AbortController().signal;

function textOf<T>(content: AgentToolResult<T>["content"]): string {
  return content
    .filter(
      (part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

function stateIdFromContent<T>(content: AgentToolResult<T>["content"]): string {
  const match = /\bstate(?:_id)? ([0-9a-f-]{36})\b/i.exec(textOf(content));
  if (!match?.[1]) throw new Error("Expected a state id in tool output.");
  return match[1];
}

function detailsOf<T>(result: AgentToolResult<T>): JsonObject {
  const parsed: JsonValue = JSON.parse(JSON.stringify(result.details));
  assert.ok(isJsonObject(parsed));
  return parsed;
}

async function assertBlocked(
  promise: Promise<unknown>,
  app: string,
  reason?: string,
): Promise<void> {
  await assert.rejects(promise, (error: Error) => {
    assert.ok(error instanceof policy.AppBlockedError, String(error));
    assert.equal(error.code, "app_blocked");
    if (reason) assert.equal(error.reason, reason);
    assert.ok(error.message.startsWith("app_blocked: "), error.message);
    assert.ok(
      error.message.includes("computer-use is not allowed to operate " + app + " ("),
      error.message,
    );
    assert.match(error.message, /This is a user-level policy/);
    return true;
  });
}

function commands(fake: FakeHelperDaemon, ...cmds: string[]): JsonObject[] {
  return fake.requests.filter((request) => cmds.includes(String(request.cmd)));
}

async function findRoot(
  ctx: ExtensionContext,
  app: string,
): Promise<{ ref: string; root: JsonObject; text: string }> {
  const found = await bridge.executeFind("find", { app }, signal, undefined, ctx);
  const windows = detailsOf(found).windows;
  assert.ok(Array.isArray(windows));
  const roots = windows.filter(isJsonObject);
  assert.equal(roots.length, 1);
  const root = roots[0]!;
  const ref = root.windowRef;
  assert.ok(isString(ref), "find_roots returns an @r ref");
  return { ref, root, text: textOf(found.content) };
}

async function observeFixture(ctx: ExtensionContext): Promise<string> {
  const { ref } = await findRoot(ctx, FAKE_APP.appName);
  const observed = await bridge.executeObserve("observe", { root: ref }, signal, undefined, ctx);
  return stateIdFromContent(observed.content);
}

test("find_roots lists a default-blocked terminal and marks it blocked in text and details", async () => {
  const { ctx } = await setup();
  const terminal = await findRoot(ctx, TERMINAL.appName);
  assert.equal(terminal.root.blocked, true);
  assert.equal(terminal.root.block_reason, "terminal");
  assert.match(
    terminal.text,
    /BLOCKED: computer-use may not operate this app \(it is a terminal emulator; user-level policy\)/,
  );
  const fixture = await findRoot(ctx, FAKE_APP.appName);
  assert.equal(fixture.root.blocked, false);
  assert.equal(fixture.root.block_reason, undefined);
  assert.doesNotMatch(fixture.text, /BLOCKED/);
});

test("observe_ui and search_ui refuse a blocked app before any look reaches the helper", async () => {
  const { ctx, fake } = await setup();
  await assertBlocked(
    bridge.executeObserve("observe", {}, signal, undefined, ctx),
    "Terminal",
    "terminal",
  );
  const { ref } = await findRoot(ctx, TERMINAL.appName);
  await assertBlocked(
    bridge.executeObserve("observe", { root: ref }, signal, undefined, ctx),
    "Terminal",
  );
  await assertBlocked(
    bridge.executeSearchUi("search", { text: "Continue" }, signal, undefined, ctx),
    "Terminal",
  );
  assert.equal(commands(fake, "look").length, 0, "no look was sent for the blocked app");
});

test("a state observed before a project-file block cannot be read or acted on", async () => {
  const { ctx, fake } = await setup();
  const stateId = await observeFixture(ctx);
  const looksBefore = commands(fake, "look").length;
  assert.ok(looksBefore > 0);
  await writeFile(projectConfigPath, JSON.stringify({ blocked_apps: [FAKE_APP.bundleId] }));
  await assertBlocked(
    bridge.executeAct(
      "act",
      { stateId, actions: [{ action: "click", ref: "@e3" }] },
      signal,
      undefined,
      ctx,
    ),
    FAKE_APP.appName,
    "user_blocked",
  );
  await assertBlocked(
    bridge.executeInspectUi("inspect", { ref: "@e1", stateId }, signal, undefined, ctx),
    FAKE_APP.appName,
  );
  await assertBlocked(
    bridge.executeReadText("read", { ref: "@e1", stateId }, signal, undefined, ctx),
    FAKE_APP.appName,
  );
  await assertBlocked(
    bridge.executeWaitFor("wait", { text: "Continue", stateId }, signal, undefined, ctx),
    FAKE_APP.appName,
  );
  const found = await findRoot(ctx, FAKE_APP.appName);
  assert.equal(found.root.blocked, true);
  assert.equal(found.root.block_reason, "user_blocked");
  await assertBlocked(
    bridge.executeObserve("observe", { root: found.ref }, signal, undefined, ctx),
    FAKE_APP.appName,
  );
  assert.equal(commands(fake, "act", "actBatch").length, 0, "no act request was sent");
  assert.equal(commands(fake, "axReadText", "axWaitFor").length, 0, "no read or wait was sent");
  assert.equal(commands(fake, "look").length, looksBefore, "no further look was sent");
});

test("blocked_apps from the environment adds a block that the user file cannot lift", async () => {
  const { ctx, fake } = await setup({
    user: { unblocked_apps: [FAKE_APP.bundleId] },
    env: { PI_COMPUTER_USE_BLOCKED_APPS: FAKE_APP.bundleId.toLowerCase() },
  });
  const { ref, root } = await findRoot(ctx, FAKE_APP.appName);
  assert.equal(root.blocked, true);
  await assertBlocked(
    bridge.executeObserve("observe", { root: ref }, signal, undefined, ctx),
    FAKE_APP.appName,
    "user_blocked",
  );
  assert.equal(commands(fake, "look").length, 0);
});

test("an ancestor pid of this process is refused, even with a user-file unblock", async () => {
  const { ctx, fake } = await setup({
    user: { unblocked_apps: [FAKE_APP.bundleId] },
    ancestry: async () => [process.pid, 999_001, FAKE_APP.pid],
  });
  const { ref, root } = await findRoot(ctx, FAKE_APP.appName);
  assert.equal(root.blocked, true);
  assert.equal(root.block_reason, "host_app");
  await assertBlocked(
    bridge.executeObserve("observe", { root: ref }, signal, undefined, ctx),
    FAKE_APP.appName,
    "host_app",
  );
  assert.equal(commands(fake, "look").length, 0);
  assert.ok(policy.effectiveAppBlocklist().pids.includes(FAKE_APP.pid));
});

test("project-file and environment unblocks are ignored and shown as ignored", async () => {
  const { ctx, fake } = await setup({
    project: { unblocked_apps: [TERMINAL.bundleId] },
    env: { PI_COMPUTER_USE_UNBLOCKED_APPS: TERMINAL.bundleId },
  });
  await assertBlocked(
    bridge.executeObserve("observe", {}, signal, undefined, ctx),
    "Terminal",
    "terminal",
  );
  assert.equal(commands(fake, "look").length, 0);
  const status = await runComputerUseCommand("", projectDir);
  assert.ok(
    status.message.includes(
      "ignored unblocked_apps from " + projectConfigPath + ": com.apple.Terminal",
    ),
    status.message,
  );
  assert.match(
    status.message,
    /ignored unblocked_apps from PI_COMPUTER_USE_UNBLOCKED_APPS: com\.apple\.Terminal/,
  );
  assert.match(
    status.message,
    /PI_COMPUTER_USE_UNBLOCKED_APPS \(ignored: the environment cannot unblock apps\)/,
  );
  assert.match(status.message, /blocked apps \(default\): [^\n]*com\.apple\.Terminal/);
});

test("a user-file unblock lifts a default block", async () => {
  const { ctx, fake } = await setup({ user: { unblocked_apps: [TERMINAL.bundleId] } });
  const observed = await bridge.executeObserve("observe", {}, signal, undefined, ctx);
  const target = detailsOf(observed).target;
  assert.ok(isJsonObject(target));
  assert.equal(target.bundleId, TERMINAL.bundleId);
  assert.equal(commands(fake, "look").length, 1, "the unblocked terminal was observed");
  const status = await runComputerUseCommand("", projectDir);
  assert.match(status.message, /unblocked_apps \(user file only\): com\.apple\.Terminal/);
  assert.doesNotMatch(status.message, /blocked apps \(default\): [^\n]*com\.apple\.Terminal/);
});

test("the launching GUI app's bundle id cannot be unblocked", async () => {
  const { ctx, fake } = await setup({
    user: { unblocked_apps: [TERMINAL.bundleId] },
    env: { __CFBundleIdentifier: TERMINAL.bundleId },
  });
  await assertBlocked(
    bridge.executeObserve("observe", {}, signal, undefined, ctx),
    "Terminal",
    "host_app",
  );
  assert.equal(commands(fake, "look").length, 0);
  const status = await runComputerUseCommand("", projectDir);
  assert.match(status.message, /unblocked_apps with no effect [^\n]*com\.apple\.Terminal/);
});

test("an ordinary app is observed and acted on as before", async () => {
  const { ctx, fake } = await setup();
  const { root } = await findRoot(ctx, FAKE_APP.appName);
  assert.equal(root.blocked, false);
  const stateId = await observeFixture(ctx);
  assert.ok(commands(fake, "look").length > 0);
  const acted = await bridge.executeAct(
    "act",
    { stateId, actions: [{ action: "click", ref: "@e3" }] },
    signal,
    undefined,
    ctx,
  );
  assert.ok(commands(fake, "act", "actBatch").length > 0, "the act reached the helper");
  assert.ok(isJsonObject(detailsOf(acted).execution));
});

test("a failed ancestry lookup falls back to this process and its parent and shows in status", async () => {
  await setup({
    ancestry: async () => {
      throw new Error("ps unavailable");
    },
  });
  config.loadComputerUseConfig(projectDir);
  await policy.ensureAppPolicyReady();
  const state = policy.hostProcessState();
  assert.equal(state.status, "failed");
  assert.deepEqual(
    state.pids,
    [process.pid, process.ppid].filter((pid) => pid > 1),
  );
  assert.equal(policy.appBlockFor({ pid: process.ppid })?.reason, "host_app");
  const status = await runComputerUseCommand("", projectDir);
  assert.match(status.message, /lookup failed \(ps unavailable\); blocking only pids/);
  policy.retryFailedHostLookup();
  assert.equal(policy.hostProcessState().status, "pending");
});

test("unit: helper, SecurityAgent, defaults, the native blocklist, and ps parsing", async () => {
  const lifted = policy.DEFAULT_BLOCKED_APPS[1]!.bundleId;
  await setup({ user: { unblocked_apps: ["com.apple.SecurityAgent", lifted] } });
  config.loadComputerUseConfig(projectDir);
  await policy.ensureAppPolicyReady();
  assert.equal(
    policy.appBlockFor({ bundleId: helper.HELPER_BUNDLE_ID, pid: 999_002 })?.reason,
    "helper",
  );
  assert.equal(
    policy.appBlockFor({ bundleId: "com.apple.securityagent", pid: 999_002 }),
    undefined,
  );
  assert.equal(
    policy.appBlockFor({ bundleId: "com.bitwarden.desktop", pid: 999_002 })?.reason,
    "password_manager",
  );
  assert.equal(policy.appBlockFor({ bundleId: "com.example.Editor", pid: 999_002 }), undefined);
  const list = policy.effectiveAppBlocklist();
  assert.ok(list.bundleIds.includes(helper.HELPER_BUNDLE_ID));
  assert.ok(list.bundleIds.includes("com.apple.Terminal"));
  assert.ok(!list.bundleIds.includes("com.apple.SecurityAgent"));
  assert.ok(!list.bundleIds.includes(lifted));
  assert.deepEqual(
    list.pids,
    [process.pid, process.ppid].filter((pid) => pid > 1),
  );
  assert.deepEqual(
    policy.ancestryFromPsOutput("  1     0\n 50     1\n 60    50\n 70    60\n 80    1\n", 70),
    [70, 60, 50],
  );
  assert.throws(() => policy.ancestryFromPsOutput(" 50 1\n", 70), /did not list this process/);
});

interface GatedBackend {
  entered: Promise<void>;
  open: () => void;
  restore: () => void;
}

function gatedBackend(): GatedBackend {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let markEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let gated = true;
  const restore = replacePlatformBackendForTest({
    ...wireBackend(),
    ensureReady: async (readyCtx, state, readySignal) => {
      if (gated) {
        gated = false;
        markEntered();
        await gate;
      }
      return await ensureMacosReady(readyCtx, state, readySignal);
    },
  });
  return { entered, open, restore };
}

async function otherProjectDir(): Promise<string> {
  const dir = path.join(scratch, "project-other");
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, ".pi"), { recursive: true });
  return dir;
}

test("an in-flight call keeps the app policy it loaded when another session loads another project", async () => {
  const { ctx, fake } = await setup({ project: { blocked_apps: [FAKE_APP.bundleId] } });
  const other = await otherProjectDir();
  const { ref, root } = await findRoot(ctx, FAKE_APP.appName);
  assert.equal(root.blocked, true);
  const gated = gatedBackend();
  try {
    const observing = bridge.executeObserve("observe", { root: ref }, signal, undefined, ctx);
    await gated.entered;
    config.loadComputerUseConfig(other);
    assert.deepEqual(config.getAppPolicySettings().blockedApps, []);
    gated.open();
    await assertBlocked(observing, FAKE_APP.appName, "user_blocked");
  } finally {
    gated.restore();
  }
  assert.equal(commands(fake, "look").length, 0, "no look was sent for the blocked app");
});

test("the blocklist sent to the helper is the one the call loaded, with this process as client pid", async () => {
  const elsewhere = "com.example.blocked-in-this-project";
  const { ctx, fake } = await setup({ project: { blocked_apps: [elsewhere] } });
  const other = await otherProjectDir();
  const { ref } = await findRoot(ctx, FAKE_APP.appName);
  const gated = gatedBackend();
  try {
    const observing = bridge.executeObserve("observe", { root: ref }, signal, undefined, ctx);
    await gated.entered;
    config.loadComputerUseConfig(other);
    gated.open();
    await observing;
  } finally {
    gated.restore();
  }
  const looks = commands(fake, "look");
  assert.equal(looks.length, 1);
  const list = looks[0]!.appBlocklist;
  assert.ok(isJsonObject(list));
  assert.ok(
    Array.isArray(list.bundleIds) && list.bundleIds.includes(elsewhere),
    JSON.stringify(list),
  );
  assert.equal(list.clientPid, process.pid, "the helper can walk this process's ancestry itself");
});

test("a failed ancestry lookup is retried on the next tool call", async () => {
  let attempts = 0;
  const { ctx } = await setup({
    ancestry: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ps unavailable");
      return [process.pid, 999_003, FAKE_APP.pid];
    },
  });
  const first = await findRoot(ctx, FAKE_APP.appName);
  assert.equal(policy.hostProcessState().status, "failed");
  assert.equal(first.root.blocked, false, "the fallback blocks only this process and its parent");
  const second = await findRoot(ctx, FAKE_APP.appName);
  assert.equal(policy.hostProcessState().status, "resolved");
  assert.equal(second.root.blocked, true, "the ancestor found on retry is blocked");
  assert.equal(second.root.block_reason, "host_app");
});
