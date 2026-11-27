import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { UiAction } from "../src/contract.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "../src/json.ts";
import type { ComputerUsePlatformBackend } from "../src/platform/types.ts";
import { createTestExtensionContext, type TestUiOptions } from "./helpers/extension-context.ts";
import {
  CUSTOM_VIEW_NAME,
  FAKE_APP,
  startFakeHelperDaemon,
  type FakeHelperDaemon,
  type FakeHelperDaemonOptions,
} from "./helpers/fake-helper-daemon.ts";

const scratch = await mkdtemp(path.join(os.tmpdir(), "cu-background-delivery-"));
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
const config = await import("../src/config.ts");
const { runComputerUseCommand } = await import("../extensions/computer-use.ts");

const agentDir = path.join(scratch, "agent");
const projectDir = path.join(scratch, "project");
const otherProjectDir = path.join(scratch, "other-project");
const userConfigPath = path.join(agentDir, "extensions", "pi-computer-use.json");
const projectConfigPath = path.join(projectDir, ".pi", "computer-use.json");
const CUSTOM_VIEW = "@e5";
const FIELD = "@e2";

const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_COMPUTER_USE_HEADLESS",
  "PI_COMPUTER_USE_BROWSER_USE",
  "PI_COMPUTER_USE_DELIVERY_POLICY",
  "PI_COMPUTER_USE_EVENT_DELIVERY",
  "PI_COMPUTER_USE_FOREGROUND_GRANT",
  "PI_COMPUTER_USE_FOREGROUND_PROMPT",
  "PI_COMPUTER_USE_BACKGROUND_DELIVERY",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

let daemon: FakeHelperDaemon | undefined;

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function writeConfigs(user?: JsonObject, project?: JsonObject): Promise<void> {
  await rm(path.dirname(userConfigPath), { recursive: true, force: true });
  await rm(path.dirname(projectConfigPath), { recursive: true, force: true });
  await mkdir(path.dirname(userConfigPath), { recursive: true });
  await mkdir(path.dirname(projectConfigPath), { recursive: true });
  await mkdir(path.join(otherProjectDir, ".pi"), { recursive: true });
  if (user) await writeFile(userConfigPath, JSON.stringify(user));
  if (project) await writeFile(projectConfigPath, JSON.stringify(project));
}

function setEnv(env: Partial<Record<EnvKey, string>>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_COMPUTER_USE_HEADLESS = "0";
  process.env.PI_COMPUTER_USE_BROWSER_USE = "0";
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) process.env[key] = value;
  }
}

function wireBackend(
  overrides: Partial<ComputerUsePlatformBackend> = {},
): ComputerUsePlatformBackend {
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
    ...overrides,
  };
}

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

function field(value: JsonObject, key: string): JsonObject {
  const nested = value[key];
  assert.ok(isJsonObject(nested), "expected object field '" + key + "'");
  return nested;
}

interface Run {
  user?: JsonObject;
  project?: JsonObject;
  env?: Partial<Record<EnvKey, string>>;
  fake?: Partial<Omit<FakeHelperDaemonOptions, "socketPath">>;
  actions?: UiAction[];
  ui?: TestUiOptions;
  backend?: Partial<ComputerUsePlatformBackend>;
  inspect?: () => Promise<void>;
}

async function actThroughBridge(
  run: Run,
): Promise<{ details: JsonObject; text: string; fake: FakeHelperDaemon; acts: JsonObject[] }> {
  await daemon?.close();
  daemon = await startFakeHelperDaemon({
    socketPath,
    userApp: "neutral",
    script: "s2-foreground-required",
    ...run.fake,
  });
  const fake = daemon;
  await writeConfigs(run.user, run.project);
  setEnv(run.env ?? {});
  const restore = replacePlatformBackendForTest(wireBackend(run.backend));
  const signal = new AbortController().signal;
  try {
    const ctx = await createTestExtensionContext(projectDir, run.ui);
    await bridge.shutdownComputerUseSession();
    await bridge.executeFind("find", { app: FAKE_APP.appName }, signal, undefined, ctx);
    const observed = await bridge.executeObserve(
      "observe",
      { root: "@r1" },
      signal,
      undefined,
      ctx,
    );
    if (!run.actions) {
      const line = textOf(observed.content)
        .split("\n")
        .find((candidate) => candidate.trim().startsWith(CUSTOM_VIEW + " "));
      assert.match(line ?? "", new RegExp(CUSTOM_VIEW_NAME), CUSTOM_VIEW + " is the custom view");
    }
    const result = await bridge.executeAct(
      "act",
      {
        stateId: stateIdFromContent(observed.content),
        actions: run.actions ?? [{ action: "click", ref: CUSTOM_VIEW }],
      },
      signal,
      undefined,
      ctx,
    );
    const parsed: JsonValue = JSON.parse(JSON.stringify(result.details));
    assert.ok(isJsonObject(parsed));
    await run.inspect?.();
    return {
      details: parsed,
      text: textOf(result.content),
      fake,
      acts: fake.requests.filter((request) => request.cmd === "act"),
    };
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

test("background_delivery defaults to standard and layers user file < project file < env", async () => {
  await writeConfigs();
  setEnv({});
  assert.equal(
    (await config.loadComputerUseConfig(projectDir)).config.background_delivery,
    "standard",
  );

  await writeConfigs({ background_delivery: "extended" });
  assert.equal(
    (await config.loadComputerUseConfig(projectDir)).config.background_delivery,
    "extended",
  );

  await writeConfigs({ background_delivery: "extended" }, { background_delivery: "standard" });
  assert.equal(
    (await config.loadComputerUseConfig(projectDir)).config.background_delivery,
    "standard",
  );

  await writeConfigs(undefined, { computer_use: { background_delivery: " Extended " } });
  assert.equal(
    (await config.loadComputerUseConfig(projectDir)).config.background_delivery,
    "extended",
  );

  await writeConfigs({ background_delivery: "extended" });
  setEnv({ PI_COMPUTER_USE_BACKGROUND_DELIVERY: "standard" });
  const loaded = await config.loadComputerUseConfig(projectDir);
  assert.equal(loaded.config.background_delivery, "standard");
  assert.equal(loaded.env.background_delivery, "standard");

  for (const invalid of ["on", "true", "", "hid"]) {
    await writeConfigs({ background_delivery: invalid });
    setEnv({ PI_COMPUTER_USE_BACKGROUND_DELIVERY: invalid });
    assert.equal(
      (await config.loadComputerUseConfig(projectDir)).config.background_delivery,
      "standard",
      JSON.stringify(invalid) + " is ignored",
    );
  }
  await writeConfigs({ background_delivery: true });
  setEnv({});
  assert.equal(
    (await config.loadComputerUseConfig(projectDir)).config.background_delivery,
    "standard",
  );
});

test("standard: the act request carries no backgroundDelivery and the result is as before", async () => {
  const { details, acts } = await actThroughBridge({});
  assert.equal(acts.length, 1);
  assert.equal("backgroundDelivery" in acts[0]!, false, "no wire field under the default");
  const error = field(field(acts[0]!, "response"), "error");
  assert.equal(error.code, "foreground_required");
  assert.equal("extendedDelivery" in error, false);
  assert.equal(details.status, "foreground_required");
  assert.equal("background_delivery" in field(details, "config"), false, "results unchanged");
});

for (const variant of [
  { name: "project file", project: { background_delivery: "extended" } },
  { name: "env", env: { PI_COMPUTER_USE_BACKGROUND_DELIVERY: "extended" } },
]) {
  test(
    "extended (" +
      variant.name +
      "): one background act with the wire field, answered unknown, no refusal, prompt, or retry",
    async () => {
      const prompts: string[] = [];
      const { details, text, acts } = await actThroughBridge({
        project: variant.project,
        env: { PI_COMPUTER_USE_FOREGROUND_PROMPT: "ask", ...variant.env },
        fake: { extendedDelivery: "available" },
        ui: {
          select: async (title) => {
            prompts.push(title);
            return undefined;
          },
        },
      });
      assert.equal(acts.length, 1, "the extended act is delivered exactly once");
      assert.equal(acts[0]?.policy, "background");
      assert.equal(acts[0]?.backgroundDelivery, "extended");
      assert.equal(acts[0]?.foregroundGrant, undefined);
      const execution = field(details, "execution");
      assert.equal(execution.outcome, "unknown");
      assert.equal(execution.refusal, undefined);
      assert.equal(execution.retryDeferred, undefined);
      assert.equal(execution.escalatedToForeground, undefined);
      assert.deepEqual(prompts, [], "an unverified extended effect asks for no grant");
      const steps = execution.steps;
      assert.ok(Array.isArray(steps) && isJsonObject(steps[0]));
      assert.equal(field(steps[0], "performed").extendedDelivery, "used");
      assert.equal(field(steps[0], "evidence").extendedDelivery, "used");
      assert.equal(field(details, "config").background_delivery, "extended");
      assert.match(text, /Effect not verified for action 1 \(click: unknown\)/);
      assert.match(text, /Extended background delivery was used for 1 action/);
      assert.doesNotMatch(text, /foreground_required/);
    },
  );
}

function assertExtendedEnding(details: JsonObject, text: string): JsonObject {
  assert.notEqual(details.status, "foreground_required", "not a foreground_required result");
  const execution = field(details, "execution");
  assert.equal(execution.outcome, "unknown");
  assert.equal(execution.refusal, undefined, "no refusal");
  assert.equal(execution.retryDeferred, undefined);
  assert.equal(execution.escalatedToForeground, undefined);
  const steps = execution.steps;
  assert.ok(Array.isArray(steps) && isJsonObject(steps[0]));
  assert.equal(field(steps[0], "performed").extendedDelivery, "used");
  assert.equal(field(steps[0], "evidence").extendedDelivery, "used");
  assert.equal(
    field(field(steps[0], "evidence"), "extendedDeliveryEnding").code,
    "foreground_required",
  );
  assert.match(text, /Extended background delivery was used for 1 action/);
  assert.match(text, /Action 1 ended after the app was told it was active/);
  assert.doesNotMatch(text, /foreground_required|foreground_grant|foreground input/);
  return execution;
}

for (const answer of ["foreground_required", "foreground_required_bare", "ending"] as const) {
  for (const prompt of ["always", "ask"] as const) {
    test(
      "extended: the " +
        answer +
        " answer after extended delivery is unknown, never a refusal or a foreground repeat (prompt " +
        prompt +
        ")",
      async () => {
        const prompts: string[] = [];
        const { details, text, acts } = await actThroughBridge({
          project: { background_delivery: "extended" },
          env: { PI_COMPUTER_USE_FOREGROUND_PROMPT: prompt },
          fake: { extendedDelivery: "available", extendedAnswer: answer },
          ui: {
            select: async (title, options) => {
              prompts.push(title);
              return options[0];
            },
          },
        });
        assert.equal(acts.length, 1, "no second delivery");
        assert.ok(
          acts.every((act) => act.policy === "background" && act.foregroundGrant === undefined),
          "nothing went to the foreground",
        );
        assert.deepEqual(prompts, [], "no grant dialog: the input may already have taken effect");
        assertExtendedEnding(details, text);
      },
    );
  }
}

test("extended: a key-window refusal of a typeText is unknown, stated, and not repeated", async () => {
  const prompts: string[] = [];
  const { details, text, acts } = await actThroughBridge({
    project: { background_delivery: "extended" },
    env: { PI_COMPUTER_USE_FOREGROUND_PROMPT: "always" },
    fake: { script: "s1-ok", extendedDelivery: "available", extendedAnswer: "key_window_refusal" },
    actions: [{ action: "typeText", ref: FIELD, text: "abc" }],
    ui: {
      select: async (title, options) => {
        prompts.push(title);
        return options[0];
      },
    },
  });
  assert.equal(acts.length, 1, "no second delivery");
  assert.deepEqual(prompts, []);
  assertExtendedEnding(details, text);
});

test("extended: an action that ended unverified stops the transaction; later actions are not sent", async () => {
  const { details, text, acts } = await actThroughBridge({
    project: { background_delivery: "extended" },
    env: { PI_COMPUTER_USE_FOREGROUND_PROMPT: "always" },
    fake: { extendedDelivery: "available", extendedAnswer: "foreground_required" },
    actions: [
      { action: "click", ref: CUSTOM_VIEW },
      { action: "typeText", ref: FIELD, text: "abc" },
    ],
  });
  assert.equal(acts.length, 1, "the second action was not sent");
  const execution = assertExtendedEnding(details, text);
  assert.equal(execution.actionCount, 1);
  assert.match(text, /Action 2 was not sent/);
});

test("unit: a native batch step refused after extended delivery is unknown, never a refusal", async () => {
  const { nativeBatchStepTrace } = await import("../src/bridge/desktop-actions.ts");
  const { refusalForResult } = await import("../src/bridge/helper-act.ts");
  const target = {
    appName: FAKE_APP.appName,
    bundleId: FAKE_APP.bundleId,
    pid: FAKE_APP.pid,
    windowTitle: "Fixture",
    windowId: 1,
    windowRef: "@r1",
    framePoints: { x: 0, y: 0, w: 400, h: 300 },
    scaleFactor: 2,
    isMinimized: false,
    isOnscreen: true,
    isMain: true,
    isFocused: false,
  };
  const action = {
    action: "typeText" as const,
    target: { ref: "field-1" },
    params: { text: "abc" },
    establishesFocus: false as const,
    implicitFocus: false,
    wantsForeground: false,
  };
  for (const error of [
    {
      code: "foreground_required",
      message: "no key",
      effectPossible: false,
      extendedDelivery: "used",
    },
    {
      code: "foreground_required",
      message: "no key",
      effectPossible: false,
      evidence: { extendedDelivery: "used" },
    },
  ]) {
    const step = { outcome: "didnt" as const, error };
    assert.equal(refusalForResult(target, action, false, "background", step), undefined);
    const trace = nativeBatchStepTrace(step, action, target, "req-1");
    assert.equal(trace.outcome, "unknown");
    assert.equal(trace.refusal, undefined);
  }
});

test("extended: a didnt answer to a typeText is reported as given, never turned into a refusal", async () => {
  const { details, acts } = await actThroughBridge({
    project: { background_delivery: "extended" },
    env: { PI_COMPUTER_USE_FOREGROUND_PROMPT: "always" },
    fake: { script: "s1-ok", extendedDelivery: "available", extendedAnswer: "didnt" },
    actions: [{ action: "typeText", ref: FIELD, text: "abc" }],
  });
  assert.equal(acts.length, 1);
  assert.equal(acts[0]?.backgroundDelivery, "extended");
  const execution = field(details, "execution");
  assert.equal(execution.refusal, undefined, "no foreground_required refusal");
  assert.equal(execution.escalatedToForeground, undefined);
});

test("extended under a covering grant: a pointer-only click still goes to the foreground (HID) without the field", async () => {
  const { acts } = await actThroughBridge({
    project: { background_delivery: "extended" },
    env: { PI_COMPUTER_USE_FOREGROUND_GRANT: FAKE_APP.bundleId },
    fake: { script: "s6-grant", extendedDelivery: "available" },
  });
  assert.equal(acts.length, 1);
  assert.equal(acts[0]?.policy, "foreground");
  assert.equal(acts[0]?.foregroundGrant, true);
  assert.equal("backgroundDelivery" in acts[0]!, false, "a granted HID act never asks for it");
});

test("extended on a helper where it is unavailable: delivered as standard and said so", async () => {
  const { details, acts } = await actThroughBridge({
    project: { background_delivery: "extended" },
    fake: { extendedDelivery: "unavailable" },
  });
  assert.equal(acts.length, 1);
  assert.equal(acts[0]?.backgroundDelivery, "extended");
  const error = field(field(acts[0]!, "response"), "error");
  assert.equal(error.code, "foreground_required");
  assert.equal(error.extendedDelivery, "unavailable");
  assert.equal(details.status, "foreground_required", "the standard answer, unchanged");
});

test("a tool call keeps the background-delivery mode it loaded when another project's config loads meanwhile", async () => {
  await writeFile(path.join(otherProjectDir, ".pi", "computer-use.json"), "{}").catch(async () => {
    await mkdir(path.join(otherProjectDir, ".pi"), { recursive: true });
    await writeFile(path.join(otherProjectDir, ".pi", "computer-use.json"), "{}");
  });
  let switched = false;
  const { acts } = await actThroughBridge({
    project: { background_delivery: "extended" },
    fake: { extendedDelivery: "available" },
    backend: {
      async act(request, options) {
        switched =
          (await config.loadComputerUseConfig(otherProjectDir)).config.background_delivery ===
          "standard";
        return await macosBackend.act(request, options);
      },
      async ensureReady(ctx, state, signal) {
        const ready = await ensureMacosReady(ctx, state, signal);
        await config.loadComputerUseConfig(otherProjectDir);
        return ready;
      },
    },
  });
  assert.ok(switched, "the other project's config was loaded during the call");
  assert.equal(config.getComputerUseConfig().background_delivery, "standard");
  assert.equal(acts.length, 1);
  assert.equal(acts[0]?.backgroundDelivery, "extended", "the call's own snapshot decides");
});

test("each tool call loads the configuration once, with no blocking file read", async () => {
  const require = createRequire(import.meta.url);
  const fsModule: typeof import("node:fs") = require("node:fs");
  const promisesModule: typeof import("node:fs/promises") = require("node:fs/promises");
  const watched = new Set([userConfigPath, projectConfigPath]);
  const calls: string[] = [];
  type WatchedPath =
    | Parameters<typeof fsModule.readFileSync>[0]
    | Parameters<typeof promisesModule.readFile>[0];
  const note = (kind: string, file: WatchedPath): void => {
    const name = String(file);
    if (watched.has(name)) calls.push(kind + " " + name);
  };
  const original = {
    readFileSync: fsModule.readFileSync,
    existsSync: fsModule.existsSync,
    readFile: promisesModule.readFile,
    access: promisesModule.access,
  };
  type Replacement = (
    ...args: never[]
  ) =>
    | ReturnType<typeof original.existsSync>
    | Promise<void>
    | ReturnType<typeof original.readFileSync>
    | ReturnType<typeof original.readFile>;
  const replace = (
    target: typeof fsModule | typeof promisesModule,
    name: keyof typeof original,
    value: Replacement,
  ): void => {
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
  };
  replace(fsModule, "readFileSync", (...args: Parameters<typeof original.readFileSync>) => {
    note("readFileSync", args[0]);
    return original.readFileSync(...args);
  });
  replace(fsModule, "existsSync", (...args: Parameters<typeof original.existsSync>) => {
    note("existsSync", args[0]);
    return original.existsSync(...args);
  });
  replace(promisesModule, "readFile", (...args: Parameters<typeof original.readFile>) => {
    note("readFile", args[0]);
    return original.readFile(...args);
  });
  replace(promisesModule, "access", (...args: Parameters<typeof original.access>) => {
    note("access", args[0]);
    return original.access(...args);
  });
  syncBuiltinESMExports();
  try {
    await actThroughBridge({
      user: { foreground_prompt: "off" },
      project: { background_delivery: "extended" },
      fake: { extendedDelivery: "available" },
    });
  } finally {
    replace(fsModule, "readFileSync", original.readFileSync);
    replace(fsModule, "existsSync", original.existsSync);
    replace(promisesModule, "readFile", original.readFile);
    replace(promisesModule, "access", original.access);
    syncBuiltinESMExports();
  }
  const count = (kind: string, file: string) =>
    calls.filter((call) => call === kind + " " + file).length;
  for (const file of watched) {
    assert.equal(
      count("existsSync", file) + count("readFileSync", file),
      0,
      "no blocking read of " + file,
    );
    assert.equal(count("readFile", file), 3, "one read of " + file + " per tool call");
  }
});

test("a config file edited between tool calls applies on the next call", async () => {
  const { acts } = await actThroughBridge({
    project: {},
    fake: { extendedDelivery: "available" },
    backend: {
      async observe(request, options) {
        const observed = await macosBackend.observe(request, options);
        await writeFile(projectConfigPath, JSON.stringify({ background_delivery: "extended" }));
        return observed;
      },
    },
  });
  assert.equal(acts.length, 1);
  assert.equal(acts[0]?.backgroundDelivery, "extended", "act_ui loaded the edited file");
});

test("/computer-use shows background_delivery and whether the helper can use extended delivery", async () => {
  const messages: string[] = [];
  const inspect = async () => {
    messages.push((await runComputerUseCommand("", projectDir)).message);
  };
  await actThroughBridge({
    project: { background_delivery: "extended" },
    fake: { extendedDelivery: "available" },
    inspect,
  });
  await actThroughBridge({ fake: { extendedDelivery: "unavailable" }, inspect });
  await actThroughBridge({ project: { background_delivery: "extended" }, inspect });
  const [available, unavailable, predates] = messages;
  assert.match(
    available ?? "",
    /background_delivery: extended \(opt-in, undocumented macOS interfaces; the helper can use extended delivery\)/,
  );
  assert.match(unavailable ?? "", /background_delivery: standard \(default;/);
  assert.match(unavailable ?? "", /the helper cannot use extended delivery \(os_not_measured\)/);
  assert.match(
    predates ?? "",
    /this helper does not support extended delivery; extended requests are delivered as standard/,
  );

  setEnv({ PI_COMPUTER_USE_BACKGROUND_DELIVERY: "extended" });
  await writeConfigs();
  const fromEnv = await runComputerUseCommand("", projectDir);
  assert.match(fromEnv.message, /env overrides: [^\n]*background_delivery/);
  assert.match(fromEnv.message, /background_delivery: extended /);
});
