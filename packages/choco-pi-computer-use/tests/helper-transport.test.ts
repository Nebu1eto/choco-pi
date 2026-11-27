import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { UiAction } from "../src/contract.ts";
import { isJsonObject, isNumber, isString, type JsonObject, type JsonValue } from "../src/json.ts";
import {
  HELPER_STOPPING_REASON,
  HelperInterruption,
  type ComputerUsePlatformBackend,
  type PlatformRequestSession,
} from "../src/platform/types.ts";
import { createTestExtensionContext, type TestUiOptions } from "./helpers/extension-context.ts";
import {
  CUSTOM_VIEW_NAME,
  CUSTOM_VIEW_REF,
  FAKE_APP,
  FAKE_APP_B,
  FAKE_WINDOW_TITLE,
  FAKE_WINDOW_TITLE_B,
  PID_OUTSIDE_TARGET_EVIDENCE,
  RESIZED_FRAME,
  TERMINAL_USER_APP,
  USER_WINDOW_ID,
  NEUTRAL_USER_APP,
  defaultSlowHoldMs,
  startFakeHelperDaemon,
  type FakeHelperDaemon,
  type FakeHelperDaemonOptions,
} from "./helpers/fake-helper-daemon.ts";

const scratch = await mkdtemp(path.join(os.tmpdir(), "cu-helper-"));
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
const { AppBlockedError } = await import("../src/app-policy.ts");

let daemon: FakeHelperDaemon | undefined;

async function startDaemon(
  options: Omit<FakeHelperDaemonOptions, "socketPath">,
): Promise<FakeHelperDaemon> {
  await daemon?.close();
  daemon = await startFakeHelperDaemon({ socketPath, userApp: "neutral", ...options });
  return daemon;
}

function session(id: string = randomUUID()): PlatformRequestSession {
  return { id, generation: 0 };
}

function actArgs(
  owner: PlatformRequestSession,
  lookId: string,
  fields: JsonObject,
): JsonObject & { requestId: string } {
  return {
    requestId: randomUUID(),
    session: { id: owner.id, generation: owner.generation },
    budgetMs: 60_000,
    lookId,
    pid: FAKE_APP.pid,
    policy: "background",
    ...fields,
  };
}

async function lookId(client: InstanceType<typeof helper.MacosHelperClient>): Promise<string> {
  const look = await client.command<{ lookId?: string }>("look", { pid: FAKE_APP.pid });
  assert.ok(look.lookId, "fake look returns a lookId");
  return look.lookId;
}

async function rejection<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, "helper commands reject with Error instances");
    return error;
  }
  assert.fail("expected the helper command to reject");
}

function wireBackend(act?: ComputerUsePlatformBackend["act"]): ComputerUsePlatformBackend {
  return {
    name: "macos",
    ensureReady: ensureMacosReady,
    listApps: macosBackend.listApps,
    listRoots: macosBackend.listRoots,
    getFrontmost: macosBackend.getFrontmost,
    focusWindow: macosBackend.focusWindow,
    restoreUserFocus: macosBackend.restoreUserFocus,
    observe: macosBackend.observe,
    act: act ?? macosBackend.act,
    actBatch: macosBackend.actBatch,
    readText: macosBackend.readText,
    waitFor: macosBackend.waitFor,
    isBrowserApp: () => false,
    isChromeFamilyApp: () => false,
    openBrowserLocation: async () => false,
  };
}

const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_COMPUTER_USE_HEADLESS",
  "PI_COMPUTER_USE_BROWSER_USE",
  "PI_COMPUTER_USE_DELIVERY_POLICY",
  "PI_COMPUTER_USE_EVENT_DELIVERY",
  "PI_COMPUTER_USE_FOREGROUND_GRANT",
] as const;

async function actThroughBridge(
  backend: ComputerUsePlatformBackend,
  beforeAct?: () => Promise<void>,
  options: {
    ref?: string;
    foregroundGrant?: string;
    findFixture?: boolean;
    signal?: AbortSignal;
    actions?: UiAction[];
    ui?: TestUiOptions;
  } = {},
): Promise<{ details: JsonObject; text: string }> {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const cwd = path.join(scratch, "project");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await mkdir(path.join(scratch, "agent"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
  process.env.PI_COMPUTER_USE_HEADLESS = "0";
  process.env.PI_COMPUTER_USE_BROWSER_USE = "0";
  delete process.env.PI_COMPUTER_USE_DELIVERY_POLICY;
  delete process.env.PI_COMPUTER_USE_EVENT_DELIVERY;
  delete process.env.PI_COMPUTER_USE_FOREGROUND_GRANT;
  if (options.foregroundGrant)
    process.env.PI_COMPUTER_USE_FOREGROUND_GRANT = options.foregroundGrant;
  const restore = replacePlatformBackendForTest(backend);
  const signal = options.signal ?? new AbortController().signal;
  try {
    const ctx = await createTestExtensionContext(cwd, options.ui);
    await bridge.shutdownComputerUseSession();
    if (options.findFixture)
      await bridge.executeFind("find", { app: FAKE_APP.appName }, signal, undefined, ctx);
    const observed = await bridge.executeObserve(
      "observe",
      options.findFixture ? { root: "@r1" } : {},
      signal,
      undefined,
      ctx,
    );
    const stateId = stateIdFromContent(observed.content);
    const ref = options.ref ?? "@e3";
    if (options.ref) {
      const line = textOf(observed.content)
        .split("\n")
        .find((candidate) => candidate.trim().startsWith(`${ref} `));
      assert.match(line ?? "", new RegExp(CUSTOM_VIEW_NAME), `${ref} is the custom view`);
    }
    await beforeAct?.();
    const result = await bridge.executeAct(
      "act",
      { stateId, actions: options.actions ?? [{ action: "click", ref }] },
      signal,
      undefined,
      ctx,
    );
    const parsed: JsonValue = JSON.parse(JSON.stringify(result.details));
    assert.ok(isJsonObject(parsed));
    return { details: parsed, text: textOf(result.content) };
  } finally {
    await bridge.shutdownComputerUseSession();
    await releaseMacosOwnership(AbortSignal.timeout(1_000));
    restore();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  assert.ok(isJsonObject(nested), `expected object field '${key}'`);
  return nested;
}

before(() => {
  assert.equal(helper.HELPER_SOCKET_PATH, socketPath, "tests must only use the scratch socket");
});

after(async () => {
  await daemon?.close();
  await rm(scratch, { recursive: true, force: true });
});

test("abort sends cancel for the semantic requestId and records the ack", async () => {
  const fake = await startDaemon({ script: "s4-slow-type", slowChunkMs: 5_000 });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const args = actArgs(session(), look, {
    action: "typeText",
    target: { ref: "field-1" },
    params: { text: "abcdefgh" },
  });
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 150);
  const error = await rejection(
    client.command("act", args, { signal: controller.signal, timeoutMs: 30_000 }),
  );

  assert.ok(error instanceof helper.HelperAbortedError, "abort surfaces HelperAbortedError");
  assert.equal(error.message, "Operation aborted.");
  assert.deepEqual(error.cancel, {
    acknowledged: true,
    state: "stopped",
    stoppedAt: 1,
    effectPossible: true,
  });
  assert.equal(error.effectPossible, true);
  assert.equal(error.interruption?.code, "cancelled");
  assert.equal(error.interruption?.clientTimeout, false);
  assert.ok(Date.now() - started < 2_000, "abort does not wait for the slow chunk");

  const cancels = fake.requests.filter((request) => request.cmd === "cancel");
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0]?.target, args.requestId, "cancel targets the semantic requestId");
  assert.notEqual(cancels[0]?.target, fake.requests.find((r) => r.cmd === "act")?.id);
  assert.deepEqual(cancels[0]?.ack, error.cancel);
});

async function logLines(logPath: string): Promise<JsonObject[]> {
  return (await readFile(logPath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): JsonValue => JSON.parse(line))
    .filter(isJsonObject);
}

test("s4 holds typeText past the client timeout and honors cancel at once", async () => {
  const text = "abcdefgh";
  assert.ok(defaultSlowHoldMs(text) > Math.max(15_000, text.length * 25 + 6_000));
  const logPath = path.join(scratch, "s4.requests.jsonl");
  const fake = await startDaemon({ script: "s4-slow-type", logPath });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const args = actArgs(session(), look, {
    action: "typeText",
    target: { ref: "field-1" },
    params: { text },
  });
  const started = Date.now();
  const error = await rejection(client.daemonCommand("act", args, 300));
  const elapsed = Date.now() - started;

  assert.ok(error instanceof helper.HelperTransportError, "the client timeout fires");
  assert.match(error.message, /timed out after 300ms/);
  assert.ok(elapsed < 1_500, `cancel is honored at once (${elapsed} ms)`);
  assert.deepEqual(error.cancel, {
    acknowledged: true,
    state: "stopped",
    stoppedAt: 1,
    effectPossible: true,
  });
  assert.equal(error.effectPossible, true);
  assert.equal(error.response?.code, "cancelled");
  assert.equal(error.interruption?.clientTimeout, true);
  assert.equal(error.interruption?.result?.outcome, "partial");
  assert.equal(error.interruption?.result?.stoppedAt, 1);

  await new Promise((resolve) => setTimeout(resolve, 200));
  await fake.close();
  daemon = undefined;
  const lines = await logLines(logPath);
  const commands = lines.map((line) => line.cmd);
  const actAt = commands.indexOf("act");
  const cancelAt = commands.indexOf("cancel");
  assert.ok(actAt >= 0 && cancelAt > actAt, "the act line precedes the cancel line");
  assert.equal(commands.lastIndexOf("act"), actAt, "no later act reaches the fake");
  assert.equal(commands.length, cancelAt + 1, "the cancel is the last line");
  const act = lines[actAt]!;
  assert.equal(act.requestId, args.requestId);
  assert.deepEqual(act.response, {
    ok: false,
    error: { code: "cancelled", message: "Request was cancelled", effectPossible: true },
    result: { outcome: "partial", stoppedAt: 1, reason: "cancelled" },
  });
  const cancel = lines[cancelAt]!;
  assert.equal(cancel.target, args.requestId, "cancel targets the semantic requestId");
  assert.deepEqual(cancel.ack, error.cancel);
});

test("s4 with a deadline overrun: a timeout equal to budgetMs cancels the act still in flight", async () => {
  const logPath = path.join(scratch, "s4-overrun.requests.jsonl");
  const fake = await startDaemon({ script: "s4-slow-type", logPath, deadlineOverrunMs: 250 });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const args = {
    ...actArgs(session(), look, {
      action: "typeText",
      target: { ref: "field-1" },
      params: { text: "abcdefgh" },
    }),
    budgetMs: 400,
  };
  const error = await rejection(client.daemonCommand("act", args, 400));

  assert.ok(error instanceof helper.HelperTransportError, "the client timeout fires first");
  assert.match(error.message, /timed out after 400ms/);
  assert.deepEqual(error.cancel, {
    acknowledged: true,
    state: "stopped",
    stoppedAt: 1,
    effectPossible: true,
  });
  assert.equal(error.interruption?.clientTimeout, true);
  assert.equal(error.interruption?.state, "stopped");

  await new Promise((resolve) => setTimeout(resolve, 200));
  await fake.close();
  daemon = undefined;
  const lines = await logLines(logPath);
  const act = lines.find((line) => line.cmd === "act");
  assert.deepEqual(act?.response, {
    ok: false,
    error: { code: "cancelled", message: "Request was cancelled", effectPossible: true },
    result: { outcome: "partial", stoppedAt: 1, reason: "cancelled" },
  });
  assert.equal(lines.filter((line) => line.cmd === "cancel")[0]?.target, args.requestId);
});

test("act log rows carry the response, including a stale_look refusal", async () => {
  const logPath = path.join(scratch, "s5.requests.jsonl");
  const fake = await startDaemon({ script: "s5-stale", logPath });
  const client = new helper.MacosHelperClient();
  const first = await lookId(client);
  await lookId(client);
  const args = actArgs(session(), first, { action: "click", target: { ref: "button-1" } });
  const refused = await rejection(client.command("act", args));
  assert.ok(refused instanceof helper.HelperCommandError);
  assert.equal(refused.code, "stale_look");
  await fake.close();
  daemon = undefined;
  const act = (await logLines(logPath)).find((line) => line.cmd === "act");
  assert.equal(act?.requestId, args.requestId);
  assert.deepEqual(act?.response, {
    ok: false,
    error: {
      code: "stale_look",
      message: `Look id '${first}' is no longer available`,
      effectPossible: false,
    },
  });
});

test("timeout cancels a partially delivered request and reports a possible effect", async () => {
  await startDaemon({ script: "s4-slow-type", slowChunkMs: 200 });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const args = actArgs(session(), look, {
    action: "typeText",
    target: { ref: "field-1" },
    params: { text: "abcdefghijklmnop" },
  });
  const error = await rejection(client.command("act", args, { timeoutMs: 500 }));

  assert.ok(error instanceof helper.HelperTransportError);
  assert.equal(error.cancel?.acknowledged, true);
  assert.equal(error.cancel?.state, "stopped");
  assert.equal(error.cancel?.effectPossible, true, "earlier chunks were delivered");
  assert.equal(error.effectPossible, true);
  assert.equal(error.response?.code, "cancelled", "the helper answered the original request");
  assert.equal(error.interruption?.clientTimeout, true);
  assert.equal(error.interruption?.result?.outcome, "partial");
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a stopping cancel ack is non-terminal: effect stays possible and nothing reports a stop", async () => {
  const fake = await startDaemon({ script: "s4-slow-type", cancelBlockMs: 1_000 });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const args = actArgs(session(), look, {
    action: "typeText",
    target: { ref: "field-1" },
    params: { text: "abcdefgh" },
  });
  const error = await rejection(client.daemonCommand("act", args, 300));

  assert.ok(error instanceof helper.HelperTransportError);
  assert.deepEqual(error.cancel, { acknowledged: true, state: "stopping", effectPossible: true });
  assert.equal(error.effectPossible, true);
  assert.equal(error.response, undefined, "no terminal answer arrived before the ack");
  const interruption = error.interruption;
  assert.ok(interruption);
  assert.equal(interruption.state, "stopping");
  assert.equal(interruption.effectPossible, true);
  assert.equal(interruption.reason, HELPER_STOPPING_REASON);
  assert.equal(interruption.result, undefined, "no stopped result is claimed");

  const forced = new HelperInterruption({
    code: "cancelled",
    effectPossible: false,
    cancel: { acknowledged: true, state: "stopping", effectPossible: false },
    clientTimeout: true,
  });
  assert.equal(forced.state, "stopping");
  assert.equal(forced.effectPossible, true);

  const answered = new helper.HelperCommandError("Request was cancelled", "cancelled", {
    effectPossible: true,
    result: { outcome: "partial", stoppedAt: 1, reason: "cancelled" },
  });
  assert.equal(answered.interruption?.state, "stopped");
  assert.equal(answered.interruption?.reason, undefined);

  await delay(1_200);
  const act = fake.requests.find((request) => request.cmd === "act");
  assert.equal(field(field(act!, "response"), "error").code, "cancelled");
});

test("bridge does not report a stopping ack as a stop", async () => {
  await startDaemon({ script: "s1-ok" });
  const { details, text } = await actThroughBridge(
    wireBackend(async () => {
      const error = new helper.HelperTransportError(
        "Daemon command 'act' timed out after 15000ms.",
      );
      error.cancel = { acknowledged: true, state: "stopping", effectPossible: false };
      error.interruption = new HelperInterruption({
        code: "cancelled",
        effectPossible: false,
        cancel: error.cancel,
        clientTimeout: true,
      });
      throw error;
    }),
  );

  assert.equal(details.status, "cancelled");
  const execution = field(details, "execution");
  assert.equal(execution.state, "stopping");
  assert.equal(execution.effectPossible, true);
  assert.equal(execution.outcome, "partial");
  assert.equal(execution.stateReason, HELPER_STOPPING_REASON);
  assert.doesNotMatch(text, /helper stopped/);
  assert.match(text, /may continue until the helper reports stopped/);
  assert.match(text, /observe_ui/);
});

test("a cancel before registration tombstones the id and the act is refused before delivery", async () => {
  const fake = await startDaemon({ script: "s1-ok" });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const owner = session();
  const args = actArgs(owner, look, { action: "click", target: { ref: "button-1" } });

  const foreign = await client.command<JsonObject>("cancel", {
    target: args.requestId,
    session: session(),
  });
  assert.deepEqual(foreign, { acknowledged: true, state: "not_found" });
  const ack = await client.command<JsonObject>("cancel", {
    target: args.requestId,
    session: owner,
  });
  assert.deepEqual(ack, { acknowledged: true, state: "not_found" });

  const refused = await rejection(client.command("act", args));
  assert.ok(refused instanceof helper.HelperCommandError);
  assert.equal(refused.code, "cancelled");
  assert.equal(refused.effectPossible, false);
  assert.equal(refused.interruption?.state, "stopped");
  assert.deepEqual(refused.interruption?.result, {
    outcome: "rejected_before_delivery",
    stoppedAt: 0,
    reason: "cancelled",
  });

  const after = await client.command<{ outline?: JsonObject }>("look", { pid: FAKE_APP.pid });
  assert.match(JSON.stringify(after.outline), /"Ready"/);
  const other = await client.command<{ outcome?: string }>(
    "act",
    actArgs(owner, look, { action: "click", target: { ref: "button-1" } }),
  );
  assert.equal(other.outcome, "worked");
  const acts = fake.requests.filter((request) => request.cmd === "act");
  assert.equal(field(field(acts[0]!, "response"), "result").outcome, "rejected_before_delivery");
});

test("ensureProtocol shuts down a protocol-7 daemon once and accepts protocol 8", async () => {
  const fake = await startDaemon({ script: "s1-ok", initialProtocolVersion: 7 });
  const client = new helper.MacosHelperClient();
  const diagnostics = await client.ensureProtocol();

  assert.equal(diagnostics.protocolVersion, 8);
  assert.equal(diagnostics.executablePath, undefined);
  const commands = fake.requests.map((request) => request.cmd);
  const shutdownAt = commands.indexOf("shutdown");
  assert.ok(shutdownAt > 0, "the mismatch triggers shutdown");
  assert.equal(commands[0], "diagnostics");
  assert.ok(commands.slice(shutdownAt + 1).includes("diagnostics"));
});

test("ensureProtocol restarts a same-protocol daemon that reports no startedAt", async () => {
  const fake = await startDaemon({ script: "s1-ok", initialStartedAt: null });
  const client = new helper.MacosHelperClient();
  const diagnostics = await client.ensureProtocol();

  const commands = fake.requests.map((request) => request.cmd);
  const shutdownAt = commands.indexOf("shutdown");
  assert.ok(shutdownAt > 0, "a pre-startedAt daemon is restarted");
  assert.ok(commands.slice(shutdownAt + 1).includes("diagnostics"));
  assert.equal(diagnostics.protocolVersion, 8);
  assert.ok(diagnostics.startedAt !== undefined && diagnostics.startedAt > scratchExecutableMtime);
});

class RebuildingClient extends helper.MacosHelperClient {
  setups = 0;
  onSetup: () => Promise<void> = async () => undefined;

  override canRebuildInstalledHelper(): boolean {
    return true;
  }

  override async runHelperSetup(): Promise<void> {
    this.setups += 1;
    await this.onSetup();
  }
}

test("ensureProtocol rebuilds an installed helper that is still an older protocol after relaunch", async () => {
  const fake = await startDaemon({
    script: "s1-ok",
    initialProtocolVersion: 7,
    relaunchProtocolVersion: 7,
  });
  const client = new RebuildingClient();
  client.onSetup = async () => fake.setProtocolVersion(8);
  const diagnostics = await client.ensureProtocol();

  assert.equal(diagnostics.protocolVersion, 8);
  assert.equal(client.setups, 1);
  const commands = fake.requests.map((request) => request.cmd);
  assert.equal(commands.filter((cmd) => cmd === "shutdown").length, 2);
});

test("ensureProtocol reports the mismatch when the rebuild leaves the helper on the older protocol", async () => {
  await startDaemon({ script: "s1-ok", initialProtocolVersion: 7, relaunchProtocolVersion: 7 });
  const client = new RebuildingClient();

  await assert.rejects(
    client.ensureProtocol(),
    /mismatch after relaunch: protocol 7 \(expected 8\)/,
  );
  assert.equal(client.setups, 1);
});

test("ensureProtocol names a failed rebuild and the command that repairs it", async () => {
  await startDaemon({ script: "s1-ok", initialProtocolVersion: 7, relaunchProtocolVersion: 7 });
  const client = new RebuildingClient();
  client.onSetup = async () => {
    throw new Error("swiftc not found");
  };

  await assert.rejects(
    client.ensureProtocol(),
    /protocol 7, older than the expected 8, and rebuilding it failed: swiftc not found\. Run `node .*setup-helper\.ts`/,
  );
});

test("ensureProtocol never rebuilds over a helper newer than this code", async () => {
  await startDaemon({ script: "s1-ok", initialProtocolVersion: 9, relaunchProtocolVersion: 9 });
  const client = new RebuildingClient();

  await assert.rejects(
    client.ensureProtocol(),
    /mismatch after relaunch: protocol 9 \(expected 8\)/,
  );
  assert.equal(client.setups, 0);
});

test("two clients that find an older helper rebuild it once", async () => {
  const fake = await startDaemon({
    script: "s1-ok",
    initialProtocolVersion: 7,
    relaunchProtocolVersion: 7,
  });
  const first = new RebuildingClient();
  const second = new RebuildingClient();
  const setup = async (): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    fake.setProtocolVersion(8);
  };
  first.onSetup = setup;
  second.onSetup = setup;
  const [a, b] = await Promise.all([first.ensureProtocol(), second.ensureProtocol()]);

  assert.equal(a.protocolVersion, 8);
  assert.equal(b.protocolVersion, 8);
  assert.equal(first.setups + second.setups, 1);
});

test("ensureProtocol restarts a daemon started before the executable was rebuilt", async () => {
  const fake = await startDaemon({
    script: "s1-ok",
    initialStartedAt: scratchExecutableMtime - 3_600,
  });
  const client = new helper.MacosHelperClient();
  const diagnostics = await client.ensureProtocol();

  const commands = fake.requests.map((request) => request.cmd);
  const shutdownAt = commands.indexOf("shutdown");
  assert.ok(shutdownAt > 0, "a daemon older than the executable is restarted");
  assert.ok(commands.slice(shutdownAt + 1).includes("diagnostics"));
  assert.ok(diagnostics.startedAt !== undefined && diagnostics.startedAt > scratchExecutableMtime);
});

test("ensureProtocol keeps a daemon started after the executable was written", async () => {
  const fake = await startDaemon({ script: "s1-ok" });
  const client = new helper.MacosHelperClient();
  const diagnostics = await client.ensureProtocol();

  const commands = fake.requests.map((request) => request.cmd);
  assert.ok(commands.includes("diagnostics"));
  assert.ok(!commands.includes("shutdown"), "a fresh daemon is not restarted");
  assert.equal(diagnostics.protocolVersion, 8);
  assert.ok(diagnostics.startedAt !== undefined && diagnostics.startedAt > scratchExecutableMtime);
});

test("ensureProtocol reports the stale reason when a relaunch stays stale", async () => {
  await startDaemon({ script: "s1-ok", initialStartedAt: scratchExecutableMtime - 3_600 });
  const future = Math.floor(Date.now() / 1000) + 3_600;
  await utimes(scratchExecutablePath, future, future);
  try {
    const client = new helper.MacosHelperClient();
    const error = await rejection(client.ensureProtocol());
    assert.match(
      error.message,
      /mismatch after relaunch: executable .* modified at .* after the daemon started/,
    );
  } finally {
    await utimes(scratchExecutablePath, scratchExecutableMtime, scratchExecutableMtime);
  }
});

test("effectPossible:false from a helper error reaches HelperCommandError", async () => {
  await startDaemon({ script: "s2-foreground-required" });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const owner = session();

  const custom = await rejection(
    client.command(
      "act",
      actArgs(owner, look, { action: "click", target: { ref: CUSTOM_VIEW_REF } }),
    ),
  );
  assert.ok(custom instanceof helper.HelperCommandError);
  assert.equal(custom.code, "foreground_required", "S2 refuses the custom view");
  assert.equal(custom.effectPossible, false);
  assert.match(custom.message, /no observable change/);
  assert.deepEqual(custom.evidence, {
    deliveryUsed: "pid_pointer",
    pidPointerAttempted: true,
    observableChange: false,
    pixelCheck: "compared",
    pixelChange: false,
  });

  const axOnly = await rejection(
    client.command(
      "act",
      actArgs(owner, look, {
        action: "click",
        target: { ref: CUSTOM_VIEW_REF },
        policy: "ax_only",
      }),
    ),
  );
  assert.ok(axOnly instanceof helper.HelperCommandError);
  assert.equal(axOnly.code, "foreground_required");
  assert.equal(axOnly.effectPossible, false);
  assert.match(axOnly.message, /no accessibility action/);
  assert.equal(axOnly.evidence, undefined);

  const pressed = await client.command<JsonObject>(
    "act",
    actArgs(owner, look, { action: "click", target: { ref: "button-1" } }),
  );
  assert.equal(pressed.outcome, "worked");
  assert.deepEqual(pressed.performed, { delivery: "ax", grounding: "description" });

  const ungranted = await rejection(
    client.command(
      "act",
      actArgs(owner, look, {
        action: "setText",
        target: { ref: "field-1" },
        policy: "foreground",
        params: { text: "x" },
      }),
    ),
  );
  assert.ok(ungranted instanceof helper.HelperCommandError);
  assert.equal(ungranted.code, "foreground_required", "foreground without a grant is refused");
  assert.equal(ungranted.effectPossible, false);
});

test("the fake reports executablePath only when configured and grants foreground only with a grant", async () => {
  await startDaemon({ script: "s6-grant", executablePath: "/tmp/fake/bridge" });
  const client = new helper.MacosHelperClient();
  const diagnostics = await client.diagnosticsCommand();
  assert.equal(diagnostics.executablePath, "/tmp/fake/bridge");
  const look = await lookId(client);
  const owner = session();

  const background = await rejection(
    client.command(
      "act",
      actArgs(owner, look, { action: "click", target: { ref: CUSTOM_VIEW_REF } }),
    ),
  );
  assert.ok(background instanceof helper.HelperCommandError);
  assert.equal(background.code, "foreground_required");
  assert.equal(background.effectPossible, false);

  const granted = await client.command<{
    outcome?: string;
    frontmostBefore?: number;
    frontmostAfter?: number;
  }>(
    "act",
    actArgs(owner, look, {
      action: "click",
      target: { ref: CUSTOM_VIEW_REF },
      policy: "foreground",
      foregroundGrant: true,
    }),
  );
  assert.equal(granted.outcome, "unknown", "HID delivery cannot be evaluated through AX");
  assert.notEqual(granted.frontmostBefore, FAKE_APP.pid);
  assert.equal(granted.frontmostAfter, FAKE_APP.pid);
});

test("a granted pid click on a view without an AX action reports didnt", async () => {
  await startDaemon({ script: "s6-grant" });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const result = await client.command<JsonObject>(
    "act",
    actArgs(session(), look, {
      action: "click",
      target: { ref: CUSTOM_VIEW_REF },
      policy: "foreground",
      foregroundGrant: true,
      params: { delivery: "pid" },
    }),
  );
  assert.equal(result.outcome, "didnt");
  assert.deepEqual(result.evidence, { observableChange: false });
  assert.equal(result.frontmostAfter, 4141, "pid delivery does not activate the target");
});

test("a window resized since the look refuses the act as stale_look before delivery", async () => {
  const logPath = path.join(scratch, "resize.requests.jsonl");
  const fake = await startDaemon({ script: "s1-ok", logPath });
  const client = new helper.MacosHelperClient();
  const owner = session();
  const first = await lookId(client);
  const resized = await client.command<{ lookId?: string; window?: JsonObject }>("look", {
    pid: FAKE_APP.pid,
    fixtureMutation: "resize",
  });
  assert.ok(resized.lookId && resized.lookId !== first);
  assert.deepEqual(resized.window?.framePoints, RESIZED_FRAME);

  const refused = await rejection(
    client.command(
      "act",
      actArgs(owner, first, {
        action: "setText",
        target: { ref: "field-1" },
        params: { text: "stale" },
      }),
    ),
  );
  assert.ok(refused instanceof helper.HelperCommandError);
  assert.equal(refused.code, "stale_look", "ref-based AX writes are not exempt");
  assert.equal(refused.effectPossible, false);
  assert.equal(refused.message, `Window frame changed since look ${first}; observe again`);

  const fresh = await client.command<{ outcome?: string }>(
    "act",
    actArgs(owner, resized.lookId, {
      action: "setText",
      target: { ref: "field-1" },
      params: { text: "fresh" },
    }),
  );
  assert.equal(fresh.outcome, "worked", "a look taken after the resize acts");
  const text = await client.command<{ text?: string }>("axReadText", { pid: FAKE_APP.pid });
  assert.equal(text.text, "fresh", "the stale act delivered nothing");
  await fake.close();
  daemon = undefined;
  const acts = (await logLines(logPath)).filter((line) => line.cmd === "act");
  assert.equal(acts.length, 2);
  assert.equal(field(field(acts[0]!, "response"), "error").code, "stale_look");
});

test("S6 refuses the custom view in background and clicks it with a grant", async () => {
  await startDaemon({ script: "s6-grant" });
  const client = new helper.MacosHelperClient();
  const outline = await client.command<{ outline?: JsonObject }>("look", { pid: FAKE_APP.pid });
  const children = outline.outline?.children;
  assert.ok(Array.isArray(children));
  const custom = children.find((child) => isJsonObject(child) && child.ref === CUSTOM_VIEW_REF);
  assert.ok(isJsonObject(custom));
  assert.equal(custom.description, CUSTOM_VIEW_NAME);
  assert.equal(custom.canPress, false);
  assert.deepEqual(custom.actions, []);
  const look = await lookId(client);
  const owner = session();

  const background = await rejection(
    client.command(
      "act",
      actArgs(owner, look, { action: "click", target: { ref: CUSTOM_VIEW_REF } }),
    ),
  );
  assert.ok(background instanceof helper.HelperCommandError);
  assert.equal(background.code, "foreground_required");
  assert.equal(background.effectPossible, false);

  const granted = await client.command<JsonObject>(
    "act",
    actArgs(owner, look, {
      action: "click",
      target: { ref: CUSTOM_VIEW_REF },
      policy: "foreground",
      foregroundGrant: true,
    }),
  );
  assert.equal(granted.outcome, "unknown");
  assert.deepEqual(granted.performed, {
    delivery: "hid",
    grounding: "coordinates",
    activated: true,
  });
  assert.equal(granted.frontmostBefore, 4141);
  assert.equal(granted.frontmostAfter, FAKE_APP.pid);
});

test("bridge: an S6 custom-view ref click under the grant goes to foreground directly", async () => {
  const fake = await startDaemon({ script: "s6-grant" });
  const { details, text } = await actThroughBridge(wireBackend(), undefined, {
    ref: "@e5",
    findFixture: true,
    foregroundGrant: FAKE_APP.bundleId,
  });
  const acts = fake.requests.filter((request) => request.cmd === "act");
  assert.equal(acts.length, 1, "one granted attempt, no background pid attempt first");
  for (const act of acts) {
    assert.deepEqual(act.target, { ref: CUSTOM_VIEW_REF });
    assert.equal(act.pid, FAKE_APP.pid);
  }
  assert.equal(acts[0]?.policy, "foreground");
  assert.equal(acts[0]?.foregroundGrant, true);
  assert.equal(field(acts[0]!, "response").ok, true);
  const execution = field(details, "execution");
  assert.equal(execution.outcome, "unknown");
  assert.notEqual(execution.escalatedToForeground, true);
  const restores = fake.requests.filter((request) => request.cmd === "restoreUserFocus");
  assert.equal(restores.length, 1, "focus goes back to the user's app once");
  assert.equal(restores[0]?.pid, 4141);
  assert.equal(restores[0]?.windowId, USER_WINDOW_ID, "the restore names the captured window id");
  assert.equal(restores[0]?.expectedFrontmostPid, FAKE_APP.pid);
  assert.equal(restores[0]?.foregroundGrant, true);
  assert.equal(execution.focusRestored, true);
  assert.equal(execution.focusRestoreReason, "restored");
  assert.match(text, /Effect not verified for action 1 \(click: unknown\)/);
  const regions = field(details, "note").regions;
  assert.ok(Array.isArray(regions));
  for (const region of regions)
    assert.ok(isJsonObject(region) && region.detail !== "acted here", "no unverified change claim");
});

test("bridge: an S2 custom-view ref click reaches the fake by ref and is refused", async () => {
  const fake = await startDaemon({ script: "s2-foreground-required" });
  const { text } = await actThroughBridge(wireBackend(), undefined, {
    ref: "@e5",
    findFixture: true,
  });
  const acts = fake.requests.filter((request) => request.cmd === "act");
  assert.equal(acts.length, 1, "no retry without a grant");
  assert.deepEqual(acts[0]?.target, { ref: CUSTOM_VIEW_REF });
  assert.equal(acts[0]?.pid, FAKE_APP.pid);
  assert.equal(acts[0]?.policy, "background");
  const error = field(field(acts[0]!, "response"), "error");
  assert.equal(error.code, "foreground_required");
  assert.equal(error.effectPossible, false, "the pid attempt verifiably changed nothing");
  assert.equal(field(error, "evidence").pidPointerAttempted, true);
  assert.equal(field(error, "evidence").observableChange, false);
  assert.match(text, /foreground/i);
  assert.match(text, /produced no observable change/);
});

test("a cancel during a background pid attempt's settle wait is cancelled with a possible effect", async () => {
  const fake = await startDaemon({ script: "s2-foreground-required", pidSettleHoldMs: 5_000 });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const args = actArgs(session(), look, { action: "click", target: { ref: CUSTOM_VIEW_REF } });
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 150);
  const error = await rejection(
    client.command("act", args, { signal: controller.signal, timeoutMs: 30_000 }),
  );

  assert.ok(error instanceof helper.HelperAbortedError, "abort surfaces HelperAbortedError");
  assert.equal(error.effectPossible, true, "the pid event was already posted");
  assert.equal(error.cancel?.state, "stopped");
  assert.equal(error.cancel?.effectPossible, true);
  assert.equal(error.interruption?.code, "cancelled");
  assert.equal(error.interruption?.result?.outcome, "partial");
  assert.ok(Date.now() - started < 2_000, "the cancel ends the settle wait at once");
  const act = fake.requests.find((request) => request.cmd === "act");
  const response = field(act!, "response");
  assert.equal(response.ok, false);
  assert.equal(field(response, "error").code, "cancelled", "never foreground_required");
  assert.equal(field(response, "error").effectPossible, true);
  assert.equal(field(response, "error").evidence, undefined);
});

test("bridge: an aborted background pid attempt reports cancelled, not a no-change refusal", async () => {
  const fake = await startDaemon({ script: "s2-foreground-required", pidSettleHoldMs: 5_000 });
  const controller = new AbortController();
  let thrown: Error | undefined;
  let outcome: { details: JsonObject; text: string } | undefined;
  try {
    outcome = await actThroughBridge(
      wireBackend(),
      async () => {
        setTimeout(() => controller.abort(), 150);
      },
      { ref: "@e5", findFixture: true, signal: controller.signal },
    );
  } catch (error) {
    assert.ok(error instanceof Error);
    thrown = error;
  }
  const acts = fake.requests.filter((request) => request.cmd === "act");
  assert.equal(acts.length, 1, "no retry or second attempt");
  assert.equal(field(field(acts[0]!, "response"), "error").code, "cancelled");
  assert.equal(field(field(acts[0]!, "response"), "error").effectPossible, true);
  if (outcome) {
    assert.equal(outcome.details.status, "cancelled");
    assert.equal(field(outcome.details, "execution").effectPossible, true);
    assert.doesNotMatch(outcome.text, /produced no observable change/);
  } else {
    assert.ok(thrown);
    assert.doesNotMatch(thrown.message, /foreground/i);
  }
});

test("bridge maps an ownership refusal to a structured owned_by_other_session result", async () => {
  const fake = await startDaemon({ script: "s7-ownership" });
  const intruder = new helper.MacosHelperClient();
  const intruderSession = session("intruder");
  const { details, text } = await actThroughBridge(wireBackend(), async () => {
    const look = await lookId(intruder);
    await intruder.command(
      "act",
      actArgs(intruderSession, look, { action: "click", target: { ref: "button-1" } }),
    );
  });

  assert.equal(details.status, "owned_by_other_session");
  assert.equal(field(details, "error").code, "owned_by_other_session");
  const execution = field(details, "execution");
  assert.equal(execution.outcome, "rejected_before_delivery");
  assert.equal(execution.effectPossible, false);
  assert.match(text, /owned_by_other_session/);
  const piAct = fake.requests.findLast((request) => request.cmd === "act");
  assert.ok(piAct && isJsonObject(piAct.session));
  assert.notEqual(piAct.session.id, intruderSession.id);
  assert.equal(piAct.policy, "background");
  assert.equal(piAct.foregroundGrant, undefined);
});

test("bridge maps a helper cancelled error to partial execution with stoppedAt", async () => {
  await startDaemon({ script: "s1-ok" });
  const { details, text } = await actThroughBridge(
    wireBackend(async () => {
      throw new helper.HelperCommandError(
        "Request deadline passed before delivery completed",
        "cancelled",
        { effectPossible: true, result: { outcome: "partial", stoppedAt: 0, reason: "deadline" } },
      );
    }),
  );

  assert.equal(details.status, "cancelled");
  assert.equal(field(details, "error").code, "cancelled");
  const execution = field(details, "execution");
  assert.equal(execution.outcome, "partial");
  assert.equal(execution.stoppedAt, 0);
  assert.equal(execution.reason, "deadline");
  assert.equal(execution.effectPossible, true);
  assert.match(text, /observe_ui/);
});

test("bridge maps an acknowledged client-timeout cancel without delivery to rejected_before_delivery", async () => {
  await startDaemon({ script: "s1-ok" });
  const { details } = await actThroughBridge(
    wireBackend(async () => {
      const error = new helper.HelperTransportError(
        "Daemon command 'act' timed out after 15000ms.",
      );
      error.cancel = { acknowledged: true, state: "stopped", stoppedAt: 0, effectPossible: false };
      error.effectPossible = false;
      error.interruption = new HelperInterruption({
        code: "cancelled",
        effectPossible: false,
        cancel: error.cancel,
        clientTimeout: true,
      });
      throw error;
    }),
  );

  assert.equal(details.status, "cancelled");
  const execution = field(details, "execution");
  assert.equal(execution.outcome, "rejected_before_delivery");
  assert.equal(execution.reason, "client_timeout");
  assert.equal(field(execution, "cancel").state, "stopped");
});

class LaunchTrackingClient extends helper.MacosHelperClient {
  launches: string[] = [];

  override async ensureInstalled(signal?: AbortSignal): Promise<void> {
    this.launches.push("ensureInstalled");
    await super.ensureInstalled(signal);
  }

  override async ensureDaemon(signal?: AbortSignal): Promise<boolean> {
    this.launches.push("ensureDaemon");
    return await super.ensureDaemon(signal);
  }

  override async launchDaemon(signal?: AbortSignal): Promise<void> {
    this.launches.push("launchDaemon");
    await super.launchDaemon(signal);
  }
}

async function learnSession(client: InstanceType<typeof helper.MacosHelperClient>): Promise<void> {
  const owner = session();
  const look = await lookId(client);
  await client.command(
    "act",
    actArgs(owner, look, { action: "click", target: { ref: "button-1" } }),
  );
  assert.deepEqual(client.currentSession, owner);
}

test("release with the daemon gone returns false quickly and launches nothing", async () => {
  await startDaemon({ script: "s1-ok" });
  const client = new LaunchTrackingClient();
  await learnSession(client);
  await daemon?.close();
  daemon = undefined;
  client.launches = [];

  const started = Date.now();
  assert.equal(await client.release(), false);
  assert.ok(Date.now() - started < 500, "a missing socket fails fast");
  assert.deepEqual(client.launches, [], "teardown never installs, probes, or launches");
  assert.equal(client.currentSession, undefined, "the learned session is forgotten");
});

test("release against a helper that never answers is bounded at 500 ms", async () => {
  await startDaemon({ script: "s1-ok" });
  const client = new LaunchTrackingClient();
  await learnSession(client);
  await daemon?.close();
  daemon = undefined;
  client.launches = [];
  const accepted: net.Socket[] = [];
  const silent = net.createServer((socket) => accepted.push(socket));
  await new Promise<void>((resolve) => silent.listen(socketPath, resolve));
  try {
    const started = Date.now();
    assert.equal(await client.release(), false);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 400 && elapsed < 1_000, `release waited ${elapsed} ms`);
    assert.deepEqual(client.launches, []);
  } finally {
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test("a second release sends nothing", async () => {
  const logPath = path.join(scratch, "release.requests.jsonl");
  await startDaemon({ script: "s1-ok", logPath });
  const client = new helper.MacosHelperClient();
  await learnSession(client);

  assert.equal(await client.release(), true);
  assert.equal(await client.release(), false);
  await daemon?.close();
  daemon = undefined;
  const lines = (await readFile(logPath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): JsonValue => JSON.parse(line));
  const releases = lines.filter((line) => isJsonObject(line) && line.cmd === "release");
  assert.equal(releases.length, 1, "exactly one release line reaches the helper");
});

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function idleClient(sock: string): Promise<{ socket: net.Socket; apps: JsonValue }> {
  const socket = net.createConnection(sock);
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const line = await new Promise<string>((resolve) => {
    let buffer = "";
    const onData = (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);
      resolve(buffer.slice(0, newline));
    };
    socket.on("data", onData);
    socket.write(`${JSON.stringify({ id: 1, cmd: "listApps" })}\n`);
  });
  const parsed: JsonValue = JSON.parse(line);
  assert.ok(isJsonObject(parsed) && isJsonObject(parsed.result));
  return { socket, apps: parsed.result.apps ?? null };
}

test("the fake reports the scenario fixture name, bundle id, and window title", () => {
  assert.equal(FAKE_APP.appName, "CU Fixture Target");
  assert.equal(FAKE_APP.bundleId, "com.choco-pi.FocusFixture");
  assert.equal(FAKE_WINDOW_TITLE, "CU Fixture Target");
});

test("close() destroys idle client connections, unlinks the socket, and resolves within 500 ms", async () => {
  const sock = path.join(scratch, "close-idle.sock");
  const fake = await startFakeHelperDaemon({ socketPath: sock, script: "s1-ok" });
  const { socket, apps } = await idleClient(sock);
  assert.ok(Array.isArray(apps));
  assert.ok(apps.some((app) => isJsonObject(app) && app.appName === "CU Fixture Target"));
  const clientClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const started = Date.now();
  await fake.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `close() took ${elapsed} ms`);
  await clientClosed;
  assert.equal(await exists(sock), false, "socket path is unlinked");
  await fake.close();
});

test("the CLI exits on SIGTERM within 500 ms with an idle client connected", async () => {
  const sock = path.join(scratch, "close-cli.sock");
  const script = fileURLToPath(new URL("./helpers/fake-helper-daemon.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", script, "--socket", sock, "--script", "S1"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    await new Promise<void>((resolve, reject) => {
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.includes("ready ")) resolve();
      });
      child.once("exit", (code) => reject(new Error(`fake exited early with ${code}`)));
    });
    const { socket } = await idleClient(sock);
    try {
      const started = Date.now();
      assert.ok(child.kill("SIGTERM"));
      const code = await exited;
      const elapsed = Date.now() - started;
      assert.equal(code, 0);
      assert.ok(elapsed < 500, `SIGTERM exit took ${elapsed} ms`);
      assert.equal(await exists(sock), false, "socket path is unlinked");
    } finally {
      socket.destroy();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("bridge: an act after its session went quiet past the helper TTL still uses its observation", async () => {
  const fake = await startDaemon({ script: "s1-ok", ownerTtlMs: 100 });
  const { details } = await actThroughBridge(
    wireBackend(),
    async () => await new Promise((resolve) => setTimeout(resolve, 350)),
    { findFixture: true, actions: [{ action: "press", ref: "@e3" }] },
  );
  assert.equal(details.status, "ok");
  assert.equal(field(details, "execution").outcome, "worked");
  const acts = fake.requests.filter((request) => request.cmd === "act");
  assert.equal(acts.length, 1);
  assert.equal(field(acts[0]!, "response").ok, true, "the helper still had the look");
});

test("bridge: an observation the helper no longer has asks for a refresh and attributes the refused act", async () => {
  const logPath = path.join(scratch, "gone.requests.jsonl");
  const fake = await startDaemon({ script: "s1-ok", logPath });
  const mutator = new helper.MacosHelperClient();
  const { details, text } = await actThroughBridge(
    wireBackend(),
    async () => {
      await mutator.command("look", { pid: FAKE_APP.pid, fixtureMutation: "bump_root_generation" });
    },
    { findFixture: true, actions: [{ action: "press", ref: "@e3" }] },
  );
  await fake.close();
  daemon = undefined;
  assert.equal(details.status, "observation_refresh_required");
  assert.equal(details.nextStep, "observe_then_retry");
  assert.deepEqual(details.refresh, {
    tool: "observe_ui",
    arguments: { root: "@r1", mode: "fused" },
  });
  assert.equal(field(details, "error").code, "stale_look");
  assert.equal(field(details, "error").inputSent, false);
  const requirement: JsonValue = JSON.parse(text);
  assert.ok(isJsonObject(requirement));
  assert.equal(requirement.code, "observation_refresh_required");
  assert.equal(requirement.operation, "act_ui");
  assert.equal(requirement.reason, "stale");
  assert.deepEqual(requirement.refresh, details.refresh);
  assert.equal(field(requirement, "cause").code, "stale_look");
  const execution = field(details, "execution");
  assert.equal(execution.outcome, "didnt");
  assert.equal(execution.stoppedAt, 0);
  const logged = (await logLines(logPath)).filter((line) => line.cmd === "act");
  assert.equal(logged.length, 1, "the act was not retried");
  assert.equal(field(field(logged[0]!, "response"), "error").code, "stale_look");
  const steps = execution.steps;
  assert.ok(Array.isArray(steps) && steps.length === 1 && isJsonObject(steps[0]));
  assert.equal(steps[0].requestId, logged[0]?.requestId, "the refused act is in the trace");
});

test("a stale_look at action 2 over the wire returns a partial successor with both requests", async () => {
  const logPath = path.join(scratch, "partial.requests.jsonl");
  const fake = await startDaemon({ script: "s1-ok", logPath });
  const mutator = new helper.MacosHelperClient();
  let acts = 0;
  const backend = wireBackend(async (request, options) => {
    acts += 1;
    if (acts === 2)
      await mutator.command("look", { pid: FAKE_APP.pid, fixtureMutation: "bump_root_generation" });
    return await macosBackend.act(request, options);
  });
  const { details, text } = await actThroughBridge(backend, undefined, {
    findFixture: true,
    actions: [
      { action: "setText", ref: "@e2", text: "first" },
      { action: "press", ref: "@e3" },
      { action: "setText", ref: "@e2", text: "never" },
    ],
  });
  await fake.close();
  daemon = undefined;
  assert.equal(details.status, "partial");
  const execution = field(details, "execution");
  assert.equal(execution.stoppedAt, 1);
  assert.equal(field(execution, "error").code, "stale_look");
  assert.equal(field(execution, "error").effectPossible, false);
  const steps = execution.steps;
  assert.ok(Array.isArray(steps) && steps.length === 2);
  const logged = (await logLines(logPath)).filter((line) => line.cmd === "act");
  assert.equal(logged.length, 2, "action 3 never reached the helper");
  assert.equal(field(field(logged[1]!, "response"), "error").code, "stale_look");
  for (const [index, step] of steps.entries()) {
    assert.ok(isJsonObject(step));
    assert.equal(step.requestId, logged[index]?.requestId, "each logged act matches a step");
  }
  assert.match(
    text,
    /act_ui stopped at action 2 \(press\).*Action 1 was delivered; action 2 \(press\) delivered nothing/,
  );
});

test("a foreground_not_acquired refusal reaches HelperCommandError with inputSent false", async () => {
  await startDaemon({ script: "s8-foreground-not-acquired" });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const refused = await rejection(
    client.command(
      "act",
      actArgs(session(), look, {
        action: "keypress",
        target: { ref: "field-1" },
        policy: "foreground",
        foregroundGrant: true,
        params: { keys: ["cmd", "w"] },
      }),
    ),
  );
  assert.ok(refused instanceof helper.HelperCommandError);
  assert.equal(refused.code, "foreground_not_acquired");
  assert.equal(refused.effectPossible, true, "the activation request is a possible effect");
  assert.deepEqual(refused.destination, {
    inputSent: false,
    activationAttempted: true,
    reason: "app_not_frontmost",
    frontmostPid: 4141,
    frontmostBefore: 4141,
    frontmostAfter: FAKE_APP.pid,
  });
  assert.equal(refused.interruption, undefined, "a destination refusal is not an interruption");
});

for (const activates of [true, false]) {
  test(`bridge: foreground_not_acquired is terminal, unretried, and ${activates ? "restores focus after a late activation" : "leaves focus alone when activation never lands"}`, async () => {
    const fake = await startDaemon({
      script: "s8-foreground-not-acquired",
      refusalActivates: activates,
    });
    const { details, text } = await actThroughBridge(wireBackend(), undefined, {
      ref: "@e5",
      findFixture: true,
      foregroundGrant: FAKE_APP.bundleId,
    });
    const acts = fake.requests.filter((request) => request.cmd === "act");
    assert.equal(acts.length, 1, "the refused action is never sent again in the same call");
    assert.equal(acts[0]?.policy, "foreground");
    assert.equal(field(field(acts[0]!, "response"), "error").inputSent, false);
    assert.equal(details.status, "foreground_not_acquired");
    assert.equal(field(details, "error").code, "foreground_not_acquired");
    assert.equal(field(details, "error").inputSent, false);
    const execution = field(details, "execution");
    assert.equal(execution.outcome, "didnt");
    assert.equal(execution.stoppedAt, 0);
    const error = field(execution, "error");
    assert.equal(error.code, "foreground_not_acquired");
    assert.equal(error.inputSent, false);
    assert.equal(error.effectPossible, true);
    assert.equal(error.activationAttempted, true);
    assert.match(text, /no input was sent; the target did not come to the front/);
    assert.match(text, /will not be retried/);
    const restores = fake.requests.filter((request) => request.cmd === "restoreUserFocus");
    if (activates) {
      assert.equal(restores.length, 1, "the late activation is undone once");
      assert.equal(restores[0]?.pid, 4141);
      assert.equal(
        restores[0]?.windowId,
        USER_WINDOW_ID,
        "the restore names the captured window id",
      );
      assert.equal(restores[0]?.expectedFrontmostPid, FAKE_APP.pid);
      assert.equal(execution.focusRestored, true);
      assert.equal(execution.focusRestoreReason, "restored");
      assert.match(text, /focus was given back/);
    } else {
      assert.equal(restores.length, 0, "nothing to undo when the target never came forward");
      assert.equal(execution.focusRestored, false);
      assert.equal(execution.focusRestoreReason, "focus_not_taken");
    }
  });
}

test("bridge: foreground_lost mid-typing is a partial result with stoppedAt and the characters sent", async () => {
  const fake = await startDaemon({ script: "s9-foreground-lost" });
  const { details, text } = await actThroughBridge(wireBackend(), undefined, {
    findFixture: true,
    foregroundGrant: FAKE_APP.bundleId,
    actions: [{ action: "typeText", ref: "@e2", text: "abcdefgh" }],
  });
  const acts = fake.requests.filter((request) => request.cmd === "act");
  assert.deepEqual(
    acts.map((request) => request.policy),
    ["background", "foreground"],
    "one granted escalation and no retry after the loss",
  );
  assert.equal(field(field(acts[1]!, "response"), "error").code, "foreground_lost");
  assert.equal(details.status, "partial");
  const execution = field(details, "execution");
  assert.equal(execution.stoppedAt, 0);
  const error = field(execution, "error");
  assert.equal(error.code, "foreground_lost");
  assert.equal(error.inputSent, true);
  assert.equal(error.effectPossible, true);
  assert.equal(error.charactersSent, 4);
  assert.match(
    text,
    /No earlier action was sent; action 1 \(.*\) sent 4 character\(s\) to the app/,
  );
  assert.equal(
    fake.requests.filter((request) => request.cmd === "restoreUserFocus").length,
    0,
    "the user already switched away",
  );
  assert.equal(execution.focusRestored, false);
  assert.equal(execution.focusRestoreReason, "user_switched");
});

test("linux and windows helpers live under CHOCO_PI_HOME/agent standalone and ~/.pi/agent legacy", async () => {
  const { linuxHelperPath } = await import("../src/platform/linux/helper.ts");
  const { windowsHelperPath } = await import("../src/platform/windows/helper.ts");
  const standalone = { CHOCO_PI_STANDALONE: "1", CHOCO_PI_HOME: "/choco" };
  const home = "/home/user";
  assert.equal(
    linuxHelperPath(standalone, home),
    path.join("/choco", "agent", "helpers", "pi-computer-use", "linux-bridge"),
  );
  assert.equal(
    windowsHelperPath(standalone, home),
    path.join("/choco", "agent", "helpers", "pi-computer-use", "windows-bridge.exe"),
  );
  assert.equal(
    linuxHelperPath({}, home),
    path.join(home, ".pi", "agent", "helpers", "pi-computer-use", "linux-bridge"),
  );
  assert.equal(
    windowsHelperPath({}, home),
    path.join(home, ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe"),
  );
  assert.equal(
    linuxHelperPath({ ...standalone, PI_COMPUTER_USE_LINUX_HELPER_PATH: "/override" }, home),
    "/override",
  );
  assert.equal(
    windowsHelperPath(
      { ...standalone, PI_COMPUTER_USE_WINDOWS_HELPER_PATH: "/override.exe" },
      home,
    ),
    "/override.exe",
  );
});

interface PreparedTarget {
  stateId: string;
  ref: string;
}

async function prepareCustomView(
  ctx: Awaited<ReturnType<typeof createTestExtensionContext>>,
  app: string,
  title: string,
): Promise<PreparedTarget> {
  const signal = new AbortController().signal;
  const found = await bridge.executeFind("find", { app }, signal, undefined, ctx);
  const parsed: JsonValue = JSON.parse(JSON.stringify(found.details));
  assert.ok(isJsonObject(parsed) && Array.isArray(parsed.windows));
  const window = parsed.windows.find((entry) => isJsonObject(entry) && entry.windowTitle === title);
  assert.ok(isJsonObject(window) && isString(window.windowRef), `root ${title}`);
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
  assert.ok(ref, `custom view ref in ${title}`);
  return { stateId: stateIdFromContent(observed.content), ref };
}

async function withGrantedBridge<T>(
  body: (ctx: Awaited<ReturnType<typeof createTestExtensionContext>>) => Promise<T>,
): Promise<T> {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const cwd = path.join(scratch, "project");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await mkdir(path.join(scratch, "agent"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
  process.env.PI_COMPUTER_USE_HEADLESS = "0";
  process.env.PI_COMPUTER_USE_BROWSER_USE = "0";
  delete process.env.PI_COMPUTER_USE_DELIVERY_POLICY;
  delete process.env.PI_COMPUTER_USE_EVENT_DELIVERY;
  process.env.PI_COMPUTER_USE_FOREGROUND_GRANT = FAKE_APP.bundleId;
  const restore = replacePlatformBackendForTest(wireBackend());
  try {
    const ctx = await createTestExtensionContext(cwd);
    await bridge.shutdownComputerUseSession();
    return await body(ctx);
  } finally {
    await bridge.shutdownComputerUseSession();
    await releaseMacosOwnership(AbortSignal.timeout(1_000));
    restore();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function actCustomView(
  ctx: Awaited<ReturnType<typeof createTestExtensionContext>>,
  prepared: PreparedTarget,
  signal: AbortSignal = new AbortController().signal,
): Promise<JsonObject> {
  const result = await bridge.executeAct(
    "act",
    { stateId: prepared.stateId, actions: [{ action: "click", ref: prepared.ref }] },
    signal,
    undefined,
    ctx,
  );
  const parsed: JsonValue = JSON.parse(JSON.stringify(result.details));
  assert.ok(isJsonObject(parsed));
  return parsed;
}

function foregroundFlow(fake: FakeHelperDaemon): JsonObject[] {
  return fake.requests.filter(
    (request) =>
      request.cmd === "getFrontmost" ||
      request.cmd === "restoreUserFocus" ||
      (request.cmd === "act" && request.policy === "foreground"),
  );
}

test("bridge: two concurrent foreground act_ui calls on different apps are serialized and attributed truthfully", async () => {
  const fake = await startDaemon({ script: "s6-grant", secondTarget: true, foregroundHoldMs: 300 });
  await withGrantedBridge(async (ctx) => {
    const first = await prepareCustomView(ctx, FAKE_APP.appName, FAKE_WINDOW_TITLE);
    const second = await prepareCustomView(ctx, FAKE_APP_B.appName, FAKE_WINDOW_TITLE_B);
    const flowStart = fake.requests.length;
    const [a, b] = await Promise.all([actCustomView(ctx, first), actCustomView(ctx, second)]);
    const flow = foregroundFlow({ ...fake, requests: fake.requests.slice(flowStart) });
    assert.deepEqual(
      flow.map((request) => request.cmd),
      [
        "getFrontmost",
        "act",
        "getFrontmost",
        "restoreUserFocus",
        "getFrontmost",
        "act",
        "getFrontmost",
        "restoreUserFocus",
      ],
      "one call's capture, act, and restore complete before the other's capture",
    );
    const acts = flow.filter((request) => request.cmd === "act");
    assert.notEqual(acts[0]?.pid, acts[1]?.pid, "the two calls target different apps");
    for (const restore of flow.filter((request) => request.cmd === "restoreUserFocus")) {
      assert.equal(restore.pid, NEUTRAL_USER_APP.pid);
      assert.equal(restore.windowId, USER_WINDOW_ID);
    }
    assert.deepEqual(
      flow
        .filter((request) => request.cmd === "restoreUserFocus")
        .map((r) => r.expectedFrontmostPid),
      acts.map((request) => request.pid),
      "each restore expects its own target in front",
    );
    for (const details of [a, b]) {
      const execution = field(details, "execution");
      assert.equal(
        execution.frontmostBefore,
        NEUTRAL_USER_APP.pid,
        "each call saw the user's app first",
      );
      assert.equal(execution.focusRestoreReason, "restored");
      assert.equal(execution.focusWindowRestored, true);
    }
  });
});

test("bridge: an unfinished foreground delivery keeps the section closed until the helper reports it stopped", async () => {
  const fake = await startDaemon({
    script: "s6-grant",
    secondTarget: true,
    foregroundHoldMs: 5_000,
    cancelBlockMs: 1_000,
  });
  await withGrantedBridge(async (ctx) => {
    const first = await prepareCustomView(ctx, FAKE_APP.appName, FAKE_WINDOW_TITLE);
    const second = await prepareCustomView(ctx, FAKE_APP_B.appName, FAKE_WINDOW_TITLE_B);
    const controller = new AbortController();
    const aborted = actCustomView(ctx, first, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(aborted, /aborted/i);
    const firstAck = fake.requests.find((request) => request.cmd === "cancel");
    assert.equal(field(firstAck!, "ack").state, "stopping", "the helper had not stopped yet");
    const followedAt = fake.requests.length;
    const next = await actCustomView(ctx, second);
    assert.equal(field(next, "execution").focusRestoreReason, "restored");
    const unfinished = fake.requests.find(
      (request) => request.cmd === "act" && request.pid === FAKE_APP.pid,
    );
    const answeredAt = unfinished?.answeredAt;
    assert.ok(isNumber(answeredAt), "the unfinished act was answered");
    const capture = fake.requests
      .slice(followedAt)
      .find((request) => request.cmd === "getFrontmost");
    const capturedAt = capture?.receivedAt;
    assert.ok(isNumber(capturedAt));
    assert.ok(capturedAt >= answeredAt, "no capture before the unfinished act stopped");
    const polls = fake.requests.filter(
      (request) => request.cmd === "cancel" && request.target === unfinished?.requestId,
    );
    assert.ok(polls.length >= 2, "the stop was confirmed by asking again");
    assert.deepEqual(polls.at(-1)?.session, unfinished?.session, "cancels carry the owner");
  });
});

test("cancel from another session is refused and does not stop the request", async () => {
  await startDaemon({ script: "s4-slow-type", slowChunkMs: 5_000 });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const owner = session();
  const args = actArgs(owner, look, {
    action: "typeText",
    target: { ref: "field-1" },
    params: { text: "abcdefgh" },
  });
  const pending = rejection(client.command("act", args, { timeoutMs: 30_000 }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const refused = await rejection(
    client.command("cancel", { target: args.requestId, session: session() }),
  );
  assert.ok(refused instanceof helper.HelperCommandError);
  assert.equal(refused.code, "not_request_owner");
  const ack = await client.command<JsonObject>("cancel", {
    target: args.requestId,
    session: owner,
  });
  assert.equal(ack.state, "stopped");
  const stopped = await pending;
  assert.ok(stopped instanceof helper.HelperCommandError);
  assert.equal(stopped.code, "cancelled");
});

test("the helper deadline is the relative budget from receipt, and an absolute deadline is refused", async () => {
  await startDaemon({ script: "s4-slow-type", slowChunkMs: 200 });
  const client = new helper.MacosHelperClient();
  const look = await lookId(client);
  const owner = session();
  const started = Date.now();
  const expired = await rejection(
    client.command(
      "act",
      {
        ...actArgs(owner, look, {
          action: "typeText",
          target: { ref: "field-1" },
          params: { text: "abcdefghijkl" },
        }),
        budgetMs: 300,
      },
      { timeoutMs: 10_000 },
    ),
  );
  assert.ok(expired instanceof helper.HelperCommandError);
  assert.equal(expired.code, "cancelled");
  assert.equal(expired.interruption?.result?.reason, "deadline");
  assert.ok(Date.now() - started < 5_000);
  const { budgetMs: _budget, ...legacy } = actArgs(owner, look, {
    action: "click",
    target: { ref: "button-1" },
  });
  const refused = await rejection(
    client.command("act", { ...legacy, deadlineMs: Date.now() + 60_000 }),
  );
  assert.ok(refused instanceof helper.HelperCommandError);
  assert.equal(refused.code, "invalid_args");
});

test("bridge: a background pid click that changed only pixels outside the target is unknown, never retried or prompted", async () => {
  const fake = await startDaemon({ script: "s10-pid-unknown" });
  const prompts: string[] = [];
  const { details, text } = await actThroughBridge(wireBackend(), undefined, {
    ref: "@e5",
    findFixture: true,
    ui: {
      select: async (title) => {
        prompts.push(title);
        return undefined;
      },
    },
  });
  const acts = fake.requests.filter((request) => request.cmd === "act");
  assert.equal(acts.length, 1, "the delivered background click is never retried");
  assert.equal(acts[0]?.policy, "background");
  assert.equal(acts[0]?.foregroundGrant, undefined);
  const result = field(field(acts[0]!, "response"), "result");
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(field(result, "evidence"), { ...PID_OUTSIDE_TARGET_EVIDENCE });
  assert.deepEqual(prompts, [], "an unverified effect asks for no foreground grant");
  const execution = field(details, "execution");
  assert.equal(execution.outcome, "unknown");
  assert.equal(execution.refusal, undefined, "not a refusal");
  assert.equal(execution.retryDeferred, undefined);
  assert.equal(execution.escalatedToForeground, undefined);
  const steps = execution.steps;
  assert.ok(Array.isArray(steps) && steps.length === 1 && isJsonObject(steps[0]));
  assert.equal(steps[0].outcome, "unknown");
  assert.equal(steps[0].refusal, undefined);
  assert.equal(field(steps[0], "evidence").changeOutsideTarget, true);
  assert.match(text, /Effect not verified for action 1 \(click: unknown\)/);
  assert.doesNotMatch(text, /foreground_required/);
});

test("look and act requests carry the session's app blocklist", async () => {
  const fake = await startDaemon({ script: "s1-ok" });
  await actThroughBridge(wireBackend(), undefined, { findFixture: true });
  for (const cmd of ["look", "act"]) {
    const request = fake.requests.find((candidate) => candidate.cmd === cmd);
    assert.ok(request, `the bridge sent ${cmd}`);
    const list = field(request, "appBlocklist");
    assert.ok(Array.isArray(list.bundleIds) && list.bundleIds.includes("com.apple.Terminal"));
    assert.ok(
      Array.isArray(list.pids) && list.pids.includes(process.pid),
      "this process is blocked",
    );
  }
  const listings = fake.requests.filter((candidate) => candidate.cmd === "listRoots");
  assert.ok(listings.length > 0, "the bridge listed roots");
  for (const request of listings)
    assert.ok(
      Array.isArray(field(request, "appBlocklist").bundleIds),
      "listings carry the blocklist",
    );
});

test("bridge: the helper's app_blocked on a window's real owner reads like the TypeScript check, before any capture", async () => {
  const fake = await startDaemon({ script: "s1-ok", userApp: "terminal", realOwner: "window" });
  const error = await rejection(
    actThroughBridge(wireBackend(), undefined, { ref: "@e3", findFixture: true }),
  );
  assert.ok(error instanceof AppBlockedError, `got ${error.name}: ${error.message}`);
  assert.equal(error.reason, "terminal");
  assert.equal(error.pid, TERMINAL_USER_APP.pid);
  const typeScriptSide = new AppBlockedError(TERMINAL_USER_APP, {
    reason: "terminal",
    matched: TERMINAL_USER_APP.bundleId,
  });
  assert.equal(error.message, typeScriptSide.message);
  assert.equal("effectPossible" in error && error.effectPossible, false);
  assert.equal(fake.requests.filter((request) => request.cmd === "act").length, 0);
});

test("bridge: the helper's app_blocked on the element an act resolves sends nothing and is not retried", async () => {
  const fake = await startDaemon({
    script: "s2-foreground-required",
    userApp: "terminal",
    realOwner: "element",
  });
  const prompts: string[] = [];
  const error = await rejection(
    actThroughBridge(wireBackend(), undefined, {
      ref: "@e5",
      findFixture: true,
      ui: {
        select: async (title) => {
          prompts.push(title);
          return undefined;
        },
      },
    }),
  );
  assert.ok(error instanceof AppBlockedError, `got ${error.name}: ${error.message}`);
  assert.match(error.message, /^app_blocked: computer-use is not allowed to operate Terminal/);
  const acts = fake.requests.filter((request) => request.cmd === "act");
  assert.equal(acts.length, 1, "no retry and no foreground escalation");
  const refusal = field(field(acts[0]!, "response"), "error");
  assert.equal(refusal.code, "app_blocked");
  assert.equal(refusal.inputSent, false);
  assert.equal(refusal.effectPossible, false);
  assert.deepEqual(prompts, []);
});

type InjectedFault = "client_reset" | "malformed_reply" | { reply: string };

function injectFaultAfterForegroundActWrite(
  fault: InjectedFault,
  matches: (chunk: string) => boolean = (chunk) =>
    chunk.includes('"cmd":"act"') && chunk.includes('"policy":"foreground"'),
  delayMs = 30,
): () => void {
  const original = net.createConnection;
  let injected = false;
  const failing = (socketPath: string): net.Socket => {
    const socket = original(socketPath);
    const realWrite = socket.write.bind(socket);
    Object.defineProperty(socket, "write", {
      configurable: true,
      writable: true,
      value: (chunk: string): boolean => {
        const accepted = realWrite(chunk);
        if (!injected && matches(chunk)) {
          injected = true;
          const inject = () => {
            if (fault === "client_reset")
              socket.destroy(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
            else if (fault === "malformed_reply")
              socket.emit("data", "<html>not a helper reply</html>\n");
            else socket.emit("data", fault.reply + "\n");
          };
          if (delayMs === 0) inject();
          else setTimeout(inject, delayMs);
        }
        return accepted;
      },
    });
    return socket;
  };
  Object.defineProperty(net, "createConnection", {
    configurable: true,
    writable: true,
    value: failing,
  });
  return () =>
    Object.defineProperty(net, "createConnection", {
      configurable: true,
      writable: true,
      value: original,
    });
}

async function lostConnectionHoldsSection(fault: "helper_closed" | InjectedFault): Promise<void> {
  const fake = await startDaemon({
    script: "s6-grant",
    secondTarget: true,
    foregroundHoldMs: 1_500,
    cancelBlockMs: 1_000,
    dropForegroundActConnection: fault === "helper_closed",
  });
  await withGrantedBridge(async (ctx) => {
    const first = await prepareCustomView(ctx, FAKE_APP.appName, FAKE_WINDOW_TITLE);
    const second = await prepareCustomView(ctx, FAKE_APP_B.appName, FAKE_WINDOW_TITLE_B);
    const restoreNet =
      fault === "helper_closed" ? undefined : injectFaultAfterForegroundActWrite(fault);
    let lost: JsonObject;
    try {
      lost = await actCustomView(ctx, first);
    } finally {
      restoreNet?.();
    }
    const execution = field(lost, "execution");
    assert.equal(lost.status, "cancelled", JSON.stringify(lost));
    assert.equal(execution.reason, "connection_lost");
    assert.equal(execution.effectPossible, true);
    const followedAt = fake.requests.length;
    const next = await actCustomView(ctx, second);
    assert.equal(field(next, "execution").focusRestoreReason, "restored");
    const unfinished = fake.requests.find(
      (request) => request.cmd === "act" && request.pid === FAKE_APP.pid,
    );
    if (fault === "helper_closed") assert.equal(unfinished?.connectionDropped, true);
    const answeredAt = unfinished?.answeredAt;
    assert.ok(isNumber(answeredAt), "the accepted act ran to its end in the helper");
    const capture = fake.requests
      .slice(followedAt)
      .find((request) => request.cmd === "getFrontmost");
    assert.ok(isNumber(capture?.receivedAt));
    assert.ok(
      capture.receivedAt >= answeredAt,
      "the next foreground call waited for the request the lost connection left running",
    );
    const cancels = fake.requests.filter(
      (request) => request.cmd === "cancel" && request.target === unfinished?.requestId,
    );
    assert.ok(cancels.length >= 1, "the client cancelled the unconfirmed request");
  });
}

test("bridge: a socket error after a foreground act was written holds the section until the helper reports it stopped", async () => {
  await lostConnectionHoldsSection("client_reset");
});

test("bridge: the helper closing the connection after a foreground act was sent holds the section the same way", async () => {
  await lostConnectionHoldsSection("helper_closed");
});

test("bridge: an undecodable reply after a foreground act was sent is no confirmation and holds the section the same way", async () => {
  await lostConnectionHoldsSection("malformed_reply");
});

for (const reply of [
  "{}",
  "null",
  "[]",
  '{"ok":"yes"}',
  '{"ok":false}',
  '{"ok":false,"error":"x"}',
]) {
  test(
    "bridge: a JSON reply that is not a response envelope (" +
      reply +
      ") after a foreground act was sent is no confirmation and holds the section the same way",
    async () => {
      await lostConnectionHoldsSection({ reply });
    },
  );
}

test("client: a JSON reply that is not a response envelope to a command without a request id is a transport error", async () => {
  const fake = await startDaemon({ script: "s1-ok" });
  for (const reply of ["{}", "null", "[]", '{"ok":"yes"}']) {
    const client = new helper.MacosHelperClient();
    const restoreNet = injectFaultAfterForegroundActWrite(
      { reply },
      (chunk) => chunk.includes('"cmd":"listApps"'),
      0,
    );
    const cancelsBefore = fake.requests.filter((request) => request.cmd === "cancel").length;
    let error: Error;
    try {
      error = await rejection(client.daemonCommand("listApps", {}, 2_000));
    } finally {
      restoreNet();
    }
    assert.ok(error instanceof helper.HelperTransportError, reply + ": " + error.name);
    assert.match(error.message, /could not be decoded \(not a response envelope\)/);
    assert.equal(error.connectionLost, false);
    assert.equal(error.interruption, undefined);
    assert.equal(
      fake.requests.filter((request) => request.cmd === "cancel").length,
      cancelsBefore,
      "no cancel was sent",
    );
  }
});

test("bridge: a granted HID act refused before any input reports inputSent false in the step error", async () => {
  await startDaemon({ script: "s6-grant" });
  await withGrantedBridge(async (ctx) => {
    const prepared = await prepareCustomView(ctx, FAKE_APP.appName, FAKE_WINDOW_TITLE);
    const mutator = new helper.MacosHelperClient();
    let acts = 0;
    const restore = replacePlatformBackendForTest(
      wireBackend(async (request, options) => {
        acts += 1;
        if (acts === 2)
          await mutator.command("look", {
            pid: FAKE_APP.pid,
            fixtureMutation: "bump_root_generation",
          });
        return await macosBackend.act(request, options);
      }),
    );
    try {
      const result = await bridge.executeAct(
        "act",
        {
          stateId: prepared.stateId,
          actions: [
            { action: "click", ref: prepared.ref },
            { action: "click", ref: prepared.ref },
          ],
        },
        new AbortController().signal,
        undefined,
        ctx,
      );
      const parsed: JsonValue = JSON.parse(JSON.stringify(result.details));
      assert.ok(isJsonObject(parsed));
      assert.equal(parsed.status, "partial");
      const error = field(field(parsed, "execution"), "error");
      assert.equal(error.code, "stale_look");
      assert.equal(error.inputSent, false, "the helper counted no event for the refused act");
    } finally {
      restore();
    }
  });
});

test("bridge: a set_text the helper could only write as a value is reported unverified, not as a change", async () => {
  const fake = await startDaemon({ script: "s1-ok", setTextValueOnly: true });
  const { details, text } = await actThroughBridge(wireBackend(), undefined, {
    findFixture: true,
    actions: [{ action: "setText", ref: "@e2", text: "value only" }],
  });
  const execution = field(details, "execution");
  assert.equal(execution.outcome, "unknown");
  const steps = execution.steps;
  assert.ok(Array.isArray(steps) && isJsonObject(steps[0]));
  assert.equal(field(steps[0], "performed").textCommit, "value");
  assert.match(text, /Effect not verified for action 1 \(set_text: unknown\)/);
  const acts = fake.requests.filter((request) => request.cmd === "act");
  assert.equal(acts.length, 1, "an unverified set_text is never retried or escalated");
});
