import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "../src/json.ts";
import type { ComputerUsePlatformBackend } from "../src/platform/types.ts";
import { createTestExtensionContext } from "./helpers/extension-context.ts";
import {
  CUSTOM_VIEW_NAME,
  FAKE_APP,
  FAKE_APP_B,
  FAKE_WINDOW_TITLE,
  FAKE_WINDOW_TITLE_B,
  startFakeHelperDaemon,
  type FakeHelperDaemon,
} from "./helpers/fake-helper-daemon.ts";

const scratch = await mkdtemp(path.join(os.tmpdir(), "cu-config-snapshot-"));
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

const agentDir = path.join(scratch, "agent");
const projectA = path.join(scratch, "project-a");
const projectB = path.join(scratch, "project-b");
const projectAConfigPath = path.join(projectA, ".pi", "computer-use.json");
const projectBConfigPath = path.join(projectB, ".pi", "computer-use.json");

const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_COMPUTER_USE_HEADLESS",
  "PI_COMPUTER_USE_BROWSER_USE",
  "PI_COMPUTER_USE_DELIVERY_POLICY",
  "PI_COMPUTER_USE_EVENT_DELIVERY",
  "PI_COMPUTER_USE_FOREGROUND_GRANT",
  "PI_COMPUTER_USE_FOREGROUND_PROMPT",
  "PI_COMPUTER_USE_RESTORE_FOCUS",
  "PI_COMPUTER_USE_BACKGROUND_DELIVERY",
] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

let daemon: FakeHelperDaemon | undefined;

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

interface ReadGate {
  entered: Promise<void>;
  open: () => void;
  restore: () => void;
}

function gateReads(file: string): ReadGate {
  const require = createRequire(import.meta.url);
  const promisesModule: typeof import("node:fs/promises") = require("node:fs/promises");
  const original = promisesModule.readFile;
  let markEntered = () => {};
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated = async (...args: Parameters<typeof original>) => {
    if (String(args[0]) === file) {
      markEntered();
      await gate;
    }
    return await original(...args);
  };
  Object.defineProperty(promisesModule, "readFile", {
    configurable: true,
    writable: true,
    value: gated,
  });
  syncBuiltinESMExports();
  const control: ReadGate = {
    entered,
    open: () => release(),
    restore: () => {
      Object.defineProperty(promisesModule, "readFile", {
        configurable: true,
        writable: true,
        value: original,
      });
      syncBuiltinESMExports();
    },
  };
  return control;
}

interface Prepared {
  ctx: ExtensionContext;
  stateId: string;
  ref: string;
}

async function prepare(cwd: string, app: string, title: string): Promise<Prepared> {
  const signal = new AbortController().signal;
  const ctx = await createTestExtensionContext(cwd);
  const found = await bridge.executeFind("find", { app }, signal, undefined, ctx);
  const parsed: JsonValue = JSON.parse(JSON.stringify(found.details));
  assert.ok(isJsonObject(parsed) && Array.isArray(parsed.windows));
  const window = parsed.windows.find((entry) => isJsonObject(entry) && entry.windowTitle === title);
  assert.ok(isJsonObject(window) && isString(window.windowRef), "root " + title);
  const observed = await bridge.executeObserve(
    "observe",
    { root: window.windowRef },
    signal,
    undefined,
    ctx,
  );
  const line = textOf(observed.content)
    .split("\n")
    .find((candidate) => candidate.includes(CUSTOM_VIEW_NAME));
  const ref = /^\s*(@e\d+)\b/.exec(line ?? "")?.[1];
  assert.ok(ref, "custom view ref in " + title);
  return { ctx, stateId: stateIdFromContent(observed.content), ref };
}

async function clickCustomView(prepared: Prepared): Promise<JsonObject> {
  const result = await bridge.executeAct(
    "act",
    { stateId: prepared.stateId, actions: [{ action: "click", ref: prepared.ref }] },
    new AbortController().signal,
    undefined,
    prepared.ctx,
  );
  const parsed: JsonValue = JSON.parse(JSON.stringify(result.details));
  assert.ok(isJsonObject(parsed));
  return parsed;
}

function actRequests(fake: FakeHelperDaemon, from: number): JsonObject[] {
  return fake.requests.slice(from).flatMap((request) => {
    if (request.cmd === "act") return [request];
    if (request.cmd !== "actBatch") return [];
    const actions = request.actions;
    return Array.isArray(actions) ? actions.filter(isJsonObject) : [];
  });
}

interface Interleaved {
  fake: FakeHelperDaemon;
  a: JsonObject;
  b: JsonObject;
  aFrom: number;
  bFrom: number;
  bTo: number;
}

async function interleave(a: JsonObject, b: JsonObject): Promise<Interleaved> {
  await daemon?.close();
  daemon = await startFakeHelperDaemon({
    socketPath,
    userApp: "neutral",
    script: "s6-grant",
    secondTarget: true,
  });
  const fake = daemon;
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_COMPUTER_USE_BROWSER_USE = "0";
  await rm(agentDir, { recursive: true, force: true });
  await mkdir(path.dirname(projectAConfigPath), { recursive: true });
  await mkdir(path.dirname(projectBConfigPath), { recursive: true });
  await writeFile(projectAConfigPath, JSON.stringify(a));
  await writeFile(projectBConfigPath, JSON.stringify(b));
  const restoreBackend = replacePlatformBackendForTest(wireBackend());
  try {
    await bridge.shutdownComputerUseSession();
    const preparedA = await prepare(projectA, FAKE_APP.appName, FAKE_WINDOW_TITLE);
    const preparedB = await prepare(projectB, FAKE_APP_B.appName, FAKE_WINDOW_TITLE_B);
    const gate = gateReads(projectAConfigPath);
    let actA: Promise<JsonObject>;
    let bDetails: JsonObject;
    let bFrom: number;
    let bTo: number;
    try {
      actA = clickCustomView(preparedA);
      await gate.entered;
      bFrom = fake.requests.length;
      bDetails = await clickCustomView(preparedB);
      bTo = fake.requests.length;
      assert.deepEqual(
        config.getComputerUseConfig(),
        (await config.loadComputerUseConfig(projectB)).config,
        "B's configuration is the published one",
      );
    } finally {
      gate.open();
      gate.restore();
    }
    const aFrom = fake.requests.length;
    const aDetails = await actA;
    return { fake, a: aDetails, b: bDetails, aFrom, bFrom, bTo };
  } finally {
    await bridge.shutdownComputerUseSession();
    await releaseMacosOwnership(AbortSignal.timeout(1_000));
    restoreBackend();
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

test("a headless call without a grant keeps its configuration when a later load with a grant is published first", async () => {
  const { fake, a, b, aFrom, bFrom, bTo } = await interleave(
    { headless: true },
    { headless: false, foreground_grant: [FAKE_APP_B.bundleId] },
  );
  const bActs = fake.requests.slice(bFrom, bTo).filter((request) => request.cmd === "act");
  assert.ok(bActs.length >= 1, "B acted");
  assert.ok(
    bActs.every((act) => act.policy === "foreground" && act.foregroundGrant === true),
    "B's call used its own grant: " + JSON.stringify(bActs.map((act) => act.policy)),
  );
  assert.equal(field(b, "execution").deliveryPolicy, "foreground");

  const aActs = actRequests(fake, aFrom);
  assert.ok(
    aActs.every((act) => act.policy !== "foreground" && act.foregroundGrant === undefined),
    "A's click never carries a foreground policy or grant: " + JSON.stringify(aActs),
  );
  assert.ok(
    aActs.every((act) => act.policy === "ax_only"),
    "A's click is ax_only, as its headless configuration says",
  );
  const execution = field(a, "execution");
  assert.notEqual(execution.deliveryPolicy, "foreground");
  assert.equal(execution.escalatedToForeground, undefined);
  assert.equal(field(a, "config").headless, true, "A's result reports A's configuration");
  assert.equal(field(b, "config").headless, false);
});

test("a restore_focus: false call is not overridden by a concurrent load of a project that restores focus", async () => {
  const { fake, a, b, aFrom, bFrom, bTo } = await interleave(
    { foreground_grant: [FAKE_APP.bundleId], restore_focus: false },
    { foreground_grant: [FAKE_APP.bundleId], restore_focus: true },
  );
  const bRequests = fake.requests.slice(bFrom, bTo);
  assert.ok(
    bRequests.some((request) => request.cmd === "restoreUserFocus"),
    "B restored focus, as its configuration says",
  );
  assert.equal(field(b, "execution").focusRestoreReason, "restored");
  const aRequests = fake.requests.slice(aFrom);
  assert.ok(
    aRequests.some((request) => request.cmd === "act" && request.policy === "foreground"),
    "A delivered granted foreground input",
  );
  assert.equal(
    aRequests.filter((request) => request.cmd === "restoreUserFocus").length,
    0,
    "A never restores focus: restore_focus is false in its configuration",
  );
  const execution = field(a, "execution");
  assert.equal(execution.focusRestored, false);
  assert.equal(execution.focusRestoreReason, "disabled");
  assert.equal(field(a, "config").restore_focus, false);
});
