import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isJsonObject, type JsonObject, type JsonValue } from "../src/json.ts";
import {
  HELPER_STOPPING_REASON,
  HelperInterruption,
  type ComputerUsePlatformBackend,
  type PlatformRequestSession,
} from "../src/platform/types.ts";
import { createTestExtensionContext } from "./helpers/extension-context.ts";
import {
  CUSTOM_VIEW_NAME,
  CUSTOM_VIEW_REF,
  FAKE_APP,
  FAKE_WINDOW_TITLE,
  RESIZED_FRAME,
  defaultSlowHoldMs,
  startFakeHelperDaemon,
  type FakeHelperDaemon,
  type FakeHelperDaemonOptions,
} from "./helpers/fake-helper-daemon.ts";

// helper.ts reads PI_CU_SOCKET_PATH at import time, so the scratch socket is
// configured before the dynamic import below. Nothing here can reach the real
// helper daemon's socket.
const scratch = await mkdtemp(path.join(os.tmpdir(), "cu-helper-"));
const socketPath = path.join(scratch, "bridge.sock");
process.env.PI_CU_SOCKET_PATH = socketPath;
const helper = await import("../src/platform/macos/helper.ts");
const { macosBackend } = await import("../src/platform/macos/backend.ts");
const { ensureMacosReady, releaseMacosOwnership } =
  await import("../src/platform/macos/permissions.ts");
const { replacePlatformBackendForTest } = await import("../src/platform/index.ts");
const bridge = await import("../src/bridge.ts");

let daemon: FakeHelperDaemon | undefined;

async function startDaemon(
  options: Omit<FakeHelperDaemonOptions, "socketPath">,
): Promise<FakeHelperDaemon> {
  await daemon?.close();
  daemon = await startFakeHelperDaemon({ socketPath, ...options });
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
    deadlineMs: Date.now() + 60_000,
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

/** The real macOS backend over the fake daemon, with an optional act override. */
function wireBackend(act?: ComputerUsePlatformBackend["act"]): ComputerUsePlatformBackend {
  return {
    name: "macos",
    ensureReady: ensureMacosReady,
    listApps: macosBackend.listApps,
    listRoots: macosBackend.listRoots,
    getFrontmost: macosBackend.getFrontmost,
    focusWindow: macosBackend.focusWindow,
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
  options: { ref?: string; foregroundGrant?: string; findFixture?: boolean } = {},
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
  const signal = new AbortController().signal;
  try {
    const ctx = await createTestExtensionContext(cwd);
    await bridge.shutdownComputerUseSession();
    // As the models do: find the fixture's root, then observe it (its pid,
    // not the frontmost app's).
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
      { stateId, actions: [{ action: "click", ref }] },
      signal,
      undefined,
      ctx,
    );
    const parsed: JsonValue = JSON.parse(JSON.stringify(result.details));
    assert.ok(isJsonObject(parsed));
    return { details: parsed, text: textOf(result.content) };
  } finally {
    await bridge.shutdownComputerUseSession();
    // wireBackend has no shutdown hook; release as the macOS backend's
    // shutdown does, so the shared client's learned session never leaks
    // into the next test.
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
  const match = /\bstate(?:Id)? ([0-9a-f-]{36})\b/i.exec(textOf(content));
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
  // The first chunk is typed at once; the abort lands in the hold before chunk 1.
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

  // Nothing else arrives after the cancel.
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

test("act log rows carry the response, including a stale_look refusal", async () => {
  const logPath = path.join(scratch, "s5.requests.jsonl");
  const fake = await startDaemon({ script: "s5-stale", logPath });
  const client = new helper.MacosHelperClient();
  const first = await lookId(client);
  await lookId(client); // the second look bumps the generation
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

test("a second session is refused with owned_by_other_session", async () => {
  const fake = await startDaemon({ script: "s7-ownership" });
  const first = new helper.MacosHelperClient();
  const second = new helper.MacosHelperClient();
  const firstSession = session("session-a");
  const secondSession = session("session-b");
  const look = await lookId(first);

  const worked = await first.command<{ outcome?: string }>(
    "act",
    actArgs(firstSession, look, { action: "click", target: { ref: "button-1" } }),
  );
  assert.equal(worked.outcome, "worked");
  assert.deepEqual(first.currentSession, firstSession);
  assert.deepEqual(await first.claim(), {
    claimed: true,
    owner: firstSession,
    ttlMs: 30_000,
  });

  const refused = await rejection(
    second.command(
      "act",
      actArgs(secondSession, look, { action: "click", target: { ref: "button-1" } }),
    ),
  );
  assert.ok(refused instanceof helper.HelperCommandError);
  assert.equal(refused.code, "owned_by_other_session");
  assert.equal(refused.effectPossible, false);
  assert.equal(refused.interruption?.code, "owned_by_other_session");

  const claim = await rejection(second.claim());
  assert.ok(claim instanceof helper.HelperCommandError);
  assert.equal(claim.code, "owned_by_other_session");

  // Owner-gated commands without their own session carry the learned one.
  const focus = await rejection(second.command("focusWindow", { pid: FAKE_APP.pid }));
  assert.ok(focus instanceof helper.HelperCommandError);
  assert.equal(focus.code, "owned_by_other_session");
  const focusRequest = fake.requests.findLast((request) => request.cmd === "focusWindow");
  assert.deepEqual(focusRequest?.session, secondSession);

  assert.equal(await first.release(), true);
  const afterRelease = await second.command<{ outcome?: string }>(
    "act",
    actArgs(secondSession, look, { action: "click", target: { ref: "button-1" } }),
  );
  assert.equal(afterRelease.outcome, "worked");
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a stopping cancel ack is non-terminal: effect stays possible and nothing reports a stop", async () => {
  // The cancel wakes the held act only after 1 s, so the fake acks `stopping`.
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

  // A stopping ack whose effectPossible is false still cannot prove no delivery.
  const forced = new HelperInterruption({
    code: "cancelled",
    effectPossible: false,
    cancel: { acknowledged: true, state: "stopping", effectPossible: false },
    clientTimeout: true,
  });
  assert.equal(forced.state, "stopping");
  assert.equal(forced.effectPossible, true);

  // By contrast, the helper's own `cancelled` answer is terminal.
  const answered = new helper.HelperCommandError("Request was cancelled", "cancelled", {
    effectPossible: true,
    result: { outcome: "partial", stoppedAt: 1, reason: "cancelled" },
  });
  assert.equal(answered.interruption?.state, "stopped");
  assert.equal(answered.interruption?.reason, undefined);

  // The act reaches its checkpoint once the blocking call returns and reports cancelled.
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

  const ack = await client.command<JsonObject>("cancel", { target: args.requestId });
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

  // Nothing was pressed: the label still reads "Ready", and another id works.
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

test("ownership is pinned while an act is in flight: TTL expiry, claims, and release are refused", async () => {
  // A 50 ms lease would expire mid-act without the pin.
  await startDaemon({ script: "s4-slow-type", ownerTtlMs: 50 });
  const first = new helper.MacosHelperClient();
  const second = new helper.MacosHelperClient();
  const firstSession = session("session-a");
  const secondSession = session("session-b");
  const look = await lookId(first);
  const controller = new AbortController();
  const inflight = rejection(
    first.command(
      "act",
      actArgs(firstSession, look, {
        action: "typeText",
        target: { ref: "field-1" },
        params: { text: "abcdefgh" },
      }),
      { signal: controller.signal, timeoutMs: 30_000 },
    ),
  );
  await delay(250);

  const claim = await rejection(second.command("claim", { session: secondSession }));
  assert.ok(claim instanceof helper.HelperCommandError);
  assert.equal(claim.code, "owned_by_other_session");
  assert.equal(claim.effectPossible, false);
  assert.equal(claim.activeRequests, 1);

  const release = await rejection(first.command("release", { session: firstSession }));
  assert.ok(release instanceof helper.HelperCommandError);
  assert.equal(release.code, "owner_busy");
  assert.equal(release.activeRequests, 1);

  controller.abort();
  const aborted = await inflight;
  assert.ok(aborted instanceof helper.HelperAbortedError);
  assert.equal(aborted.cancel?.state, "stopped");

  // Unpinned, the lease runs out 50 ms after the act ended.
  await delay(150);
  assert.deepEqual(await second.command("claim", { session: secondSession }), {
    claimed: true,
    owner: secondSession,
    ttlMs: 50,
  });
});

test("ensureProtocol restarts a protocol-6 fake and accepts protocol 7", async () => {
  const fake = await startDaemon({ script: "s1-ok", initialProtocolVersion: 6 });
  const client = new helper.MacosHelperClient();
  const diagnostics = await client.ensureProtocol();

  assert.equal(diagnostics.protocolVersion, 7);
  assert.equal(diagnostics.executablePath, undefined);
  const commands = fake.requests.map((request) => request.cmd);
  const shutdownAt = commands.indexOf("shutdown");
  assert.ok(shutdownAt > 0, "the mismatch triggers shutdown");
  assert.equal(commands[0], "diagnostics");
  assert.ok(commands.slice(shutdownAt + 1).includes("diagnostics"));
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
  assert.match(custom.message, /no accessibility action/);

  // Like the helper, a button with AXPress is pressed through AX in the background.
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

test("bridge: an S6 custom-view ref click reaches the fake by ref and escalates once under the grant", async () => {
  const fake = await startDaemon({ script: "s6-grant" });
  const { details, text } = await actThroughBridge(wireBackend(), undefined, {
    ref: "@e5",
    findFixture: true,
    foregroundGrant: FAKE_APP.bundleId,
  });
  const acts = fake.requests.filter((request) => request.cmd === "act");
  assert.equal(acts.length, 2, "one background attempt and one granted retry");
  for (const act of acts) {
    assert.deepEqual(act.target, { ref: CUSTOM_VIEW_REF });
    assert.equal(act.pid, FAKE_APP.pid);
  }
  assert.equal(acts[0]?.policy, "background");
  assert.equal(acts[0]?.foregroundGrant, undefined);
  assert.equal(acts[1]?.policy, "foreground");
  assert.equal(acts[1]?.foregroundGrant, true);
  assert.equal(field(acts[1]!, "response").ok, true);
  assert.equal(field(field(acts[0]!, "response"), "error").effectPossible, false);
  const execution = field(details, "execution");
  assert.equal(execution.outcome, "unknown");
  assert.equal(execution.escalatedToForeground, true);
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
  assert.equal(error.effectPossible, false, "refused before any delivery");
  assert.match(text, /foreground/i);
  assert.match(text, /delivered no input/);
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
      // Mirrors what daemonCommand attaches after an acknowledged timeout cancel.
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

/** Records every install/probe/launch attempt; probing still reaches the fake. */
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

/** Teaches the client its session through an act, as the bridge does. */
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
  // Accepts the connection and never answers.
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

/** Connects, asks listApps once, then leaves the connection open and idle. */
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
  await fake.close(); // idempotent
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
