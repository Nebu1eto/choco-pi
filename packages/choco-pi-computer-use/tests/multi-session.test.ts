import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { UiAction } from "../src/contract.ts";
import { isJsonObject, isNumber, type JsonObject, type JsonValue } from "../src/json.ts";
import type { ComputerUsePlatformBackend, PlatformRequestSession } from "../src/platform/types.ts";
import { createTestExtensionContext } from "./helpers/extension-context.ts";
import {
  FAKE_APP,
  FAKE_APP_B,
  startFakeHelperDaemon,
  type FakeHelperDaemon,
  type FakeHelperDaemonOptions,
} from "./helpers/fake-helper-daemon.ts";

const scratch = await mkdtemp(path.join(os.tmpdir(), "cu-multi-"));
const socketPath = path.join(scratch, "bridge.sock");
process.env.PI_CU_SOCKET_PATH = socketPath;
const scratchAppPath = path.join(scratch, "pi-computer-use.app");
const scratchExecutablePath = path.join(scratchAppPath, "Contents", "MacOS", "bridge");
await mkdir(path.dirname(scratchExecutablePath), { recursive: true });
await writeFile(scratchExecutablePath, "");
const mtime = Math.floor(Date.now() / 1000) - 86_400;
await utimes(scratchExecutablePath, mtime, mtime);
process.env.PI_COMPUTER_USE_HELPER_APP_PATH = scratchAppPath;
const helper = await import("../src/platform/macos/helper.ts");
const { macosBackend } = await import("../src/platform/macos/backend.ts");
const { ensureMacosReady, macosForegroundSection, releaseMacosOwnership } =
  await import("../src/platform/macos/permissions.ts");
const { replacePlatformBackendForTest } = await import("../src/platform/index.ts");
const bridge = await import("../src/bridge.ts");

type Client = InstanceType<typeof helper.MacosHelperClient>;
let daemon: FakeHelperDaemon | undefined;

async function startDaemon(
  options: Omit<FakeHelperDaemonOptions, "socketPath" | "script"> & { script?: string } = {},
): Promise<FakeHelperDaemon> {
  await daemon?.close();
  daemon = await startFakeHelperDaemon({
    socketPath,
    userApp: "neutral",
    secondTarget: true,
    script: "s1-ok",
    ...options,
  });
  return daemon;
}

after(async () => {
  await daemon?.close();
  await rm(scratch, { recursive: true, force: true });
});

const session = (id: string): PlatformRequestSession => ({ id, generation: 0 });

async function client(id: string): Promise<{ client: Client; session: PlatformRequestSession }> {
  const created = new helper.MacosHelperClient();
  const owned = session(id);
  created.adoptSession(owned);
  await created.diagnosticsCommand();
  return { client: created, session: owned };
}

async function look(c: Client, pid = FAKE_APP.pid): Promise<string> {
  const result = await c.command<{ lookId?: string }>("look", { pid });
  assert.ok(result.lookId);
  return result.lookId;
}

function act(owner: PlatformRequestSession, lookId: string, pid: number, fields: JsonObject = {}) {
  return {
    requestId: randomUUID(),
    session: { ...owner },
    budgetMs: 60_000,
    lookId,
    pid,
    policy: "background",
    action: "click",
    target: { ref: "button-1" },
    ...fields,
  };
}

const granted = { policy: "foreground", foregroundGrant: true };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rejection<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected the helper command to reject");
}

interface Span {
  session: string;
  pid: number;
  foreground: boolean;
  start: number;
  end: number;
}

function spans(fake: FakeHelperDaemon): Span[] {
  return fake.actSpans.map((span) => ({
    session: String(span.session),
    pid: isNumber(span.pid) ? span.pid : -1,
    foreground: span.foreground === true,
    start: isNumber(span.start) ? span.start : 0,
    end: isNumber(span.end) ? span.end : 0,
  }));
}

const overlap = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

async function section(c: Client, op: "acquire" | "release"): Promise<boolean> {
  const result = await c.foregroundSection(op, 100);
  assert.ok(result, "the multi-session fake has a foreground section");
  return op === "acquire" ? result.acquired === true : result.released === true;
}

test("acts of two sessions on one app are serialized", async () => {
  const fake = await startDaemon({ actHoldMs: 200 });
  const a = await client("session-a");
  const b = await client("session-b");
  const [lookA, lookB] = await Promise.all([look(a.client), look(b.client)]);
  const results = await Promise.all([
    a.client.command<{ outcome?: string }>("act", act(a.session, lookA, FAKE_APP.pid)),
    b.client.command<{ outcome?: string }>("act", act(b.session, lookB, FAKE_APP.pid)),
  ]);
  assert.deepEqual(
    results.map((result) => result.outcome),
    ["worked", "worked"],
  );
  const [first, second] = spans(fake);
  assert.ok(first && second && !overlap(first, second), "acts on one pid never overlap");
});

test("a session cannot act on another session's look or cancel its request", async () => {
  await startDaemon({ script: "s4-slow-type", slowChunkMs: 400 });
  const a = await client("session-a");
  const b = await client("session-b");
  const lookA = await look(a.client);
  const stolen = await rejection(b.client.command("act", act(b.session, lookA, FAKE_APP.pid)));
  assert.ok(stolen instanceof helper.HelperCommandError);
  assert.equal(stolen.code, "not_look_owner");
  assert.equal(stolen.effectPossible, false);

  const request = act(a.session, lookA, FAKE_APP.pid, {
    action: "typeText",
    target: { ref: "field-1" },
    params: { text: "abcdefgh" },
  });
  const typing = rejection(a.client.command("act", request, { timeoutMs: 30_000 }));
  await pause(100);
  const cancel = await rejection(
    b.client.command("cancel", { target: request.requestId, session: b.session }),
  );
  assert.ok(cancel instanceof helper.HelperCommandError);
  assert.equal(cancel.code, "not_request_owner");
  const ack = await a.client.command<{ state?: string }>("cancel", {
    target: request.requestId,
    session: a.session,
  });
  assert.equal(ack.state, "stopped");
  await typing;
});

test("a session's looks survive other sessions' observations and waiting for the helper", async () => {
  await startDaemon({ actHoldMs: 150 });
  const a = await client("session-a");
  const b = await client("session-b");
  const lookA = await look(a.client);
  for (let index = 0; index < 12; index += 1) await look(b.client);
  const lookB = await look(b.client);
  const busy = b.client.command("act", act(b.session, lookB, FAKE_APP.pid));
  await pause(20);
  const waited = await a.client.command<{ outcome?: string }>(
    "act",
    act(a.session, lookA, FAKE_APP.pid),
  );
  assert.equal(waited.outcome, "worked", "the first act after waiting still has its look");
  await busy;
});

test("a session that stops heart-beating expires alone: its section goes, its looks stay, others are untouched", async () => {
  await startDaemon({ ownerTtlMs: 120 });
  const dead = await client("session-dead");
  const live = await client("session-live");
  const deadLook = await look(dead.client);
  const liveLook = await look(live.client, FAKE_APP_B.pid);
  assert.equal(await section(dead.client, "acquire"), true);
  for (let index = 0; index < 4; index += 1) {
    await pause(60);
    await live.client.command("act", act(live.session, liveLook, FAKE_APP_B.pid));
  }
  const foreground = await live.client.command<{ outcome?: string }>(
    "act",
    act(live.session, liveLook, FAKE_APP_B.pid, granted),
  );
  assert.equal(foreground.outcome, "worked", "the expired session's foreground section is gone");
  const back = await dead.client.command<{ outcome?: string }>(
    "act",
    act(dead.session, deadLook, FAKE_APP.pid),
  );
  assert.equal(back.outcome, "worked", "liveness expiry does not drop the session's looks");
});

test("a session's looks are reclaimed by its release and by a newer generation, never by another session", async () => {
  await startDaemon({ ownerTtlMs: 120 });
  const a = await client("session-a");
  const b = await client("session-b");
  const lookA = await look(a.client);
  const lookB = await look(b.client, FAKE_APP_B.pid);
  const newer = { id: a.session.id, generation: a.session.generation + 1 };
  const stale = await rejection(a.client.command("act", act(newer, lookA, FAKE_APP.pid)));
  assert.ok(stale instanceof helper.HelperCommandError);
  assert.equal(stale.code, "stale_look");
  const older = await rejection(a.client.command("act", act(a.session, lookA, FAKE_APP.pid)));
  assert.ok(older instanceof helper.HelperCommandError);
  assert.equal(older.code, "owned_by_other_session", "the older generation is refused as before");
  const kept = await b.client.command<{ outcome?: string }>(
    "act",
    act(b.session, lookB, FAKE_APP_B.pid),
  );
  assert.equal(kept.outcome, "worked");
  assert.equal(await b.client.release(), true);
  const released = await rejection(b.client.command("act", act(b.session, lookB, FAKE_APP_B.pid)));
  assert.ok(released instanceof helper.HelperCommandError);
  assert.equal(released.code, "stale_look", "release drops the session's looks");
});

test("release ends only the caller's session, and is refused while that session is busy", async () => {
  await startDaemon({ script: "s4-slow-type", slowChunkMs: 300 });
  const a = await client("session-a");
  const b = await client("session-b");
  const lookA = await look(a.client);
  await look(b.client);
  const typing = a.client.command<{ outcome?: string }>(
    "act",
    act(a.session, lookA, FAKE_APP.pid, {
      action: "typeText",
      target: { ref: "field-1" },
      params: { text: "abcd" },
    }),
    { timeoutMs: 30_000 },
  );
  await pause(80);
  assert.equal(await b.client.release(), true, "another session releases while this one is busy");
  const busy = await rejection(a.client.command("release", { session: a.session }));
  assert.ok(busy instanceof helper.HelperCommandError);
  assert.equal(busy.code, "owner_busy");
  assert.equal((await typing).outcome, "worked", "the busy session's act was not affected");
});

test("shutdown is refused while another session has a request in flight", async () => {
  await startDaemon({ actHoldMs: 400 });
  const a = await client("session-a");
  const b = await client("session-b");
  const lookA = await look(a.client);
  const slow = a.client.command("act", act(a.session, lookA, FAKE_APP.pid));
  await pause(80);
  const refused = await rejection(b.client.command("shutdown", {}));
  assert.ok(refused instanceof helper.HelperCommandError);
  assert.equal(refused.code, "helper_busy");
  await slow;
});

const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_COMPUTER_USE_HEADLESS",
  "PI_COMPUTER_USE_BROWSER_USE",
  "PI_COMPUTER_USE_DELIVERY_POLICY",
  "PI_COMPUTER_USE_EVENT_DELIVERY",
  "PI_COMPUTER_USE_FOREGROUND_GRANT",
] as const;

function backend(): ComputerUsePlatformBackend {
  return {
    name: "macos",
    foregroundSection: macosForegroundSection,
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

async function actThroughBridge(
  actions: (observed: string) => UiAction[],
  options: { grant?: string; beforeAct?: () => Promise<void> } = {},
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
  if (options.grant) process.env.PI_COMPUTER_USE_FOREGROUND_GRANT = options.grant;
  const restore = replacePlatformBackendForTest(backend());
  const signal = new AbortController().signal;
  try {
    const ctx = await createTestExtensionContext(cwd);
    await bridge.shutdownComputerUseSession();
    await bridge.executeFind("find", { app: FAKE_APP.appName }, signal, undefined, ctx);
    const observed = await bridge.executeObserve(
      "observe",
      { root: "@r1" },
      signal,
      undefined,
      ctx,
    );
    const text = textOf(observed.content);
    const stateId = /\bstate(?:_id)? ([0-9a-f-]{36})\b/i.exec(text)?.[1];
    assert.ok(stateId, "observe returns a state id");
    await options.beforeAct?.();
    const result = await bridge.executeAct(
      "act",
      { stateId, actions: actions(text) },
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

function refFor(observed: string, title: string): string {
  const line = observed
    .split("\n")
    .find((candidate) => candidate.includes(DQ + title + DQ) && /^\s*@e\d+/.test(candidate));
  const ref = line ? /@e\d+/.exec(line)?.[0] : undefined;
  assert.ok(ref, "a ref for " + title);
  return ref;
}
const DQ = '"';

test("bridge: another session's work is no ownership refusal, and the bridge's looks carry its session", async () => {
  const fake = await startDaemon();
  const other = await client("other-process");
  const otherLook = await look(other.client);
  await other.client.command("act", act(other.session, otherLook, FAKE_APP.pid));
  const { details } = await actThroughBridge((observed) => [
    { action: "press", ref: refFor(observed, "Increment") },
  ]);
  assert.notEqual(details.status, "owned_by_other_session");
  const piLook = fake.requests.findLast((request) => request.cmd === "look");
  assert.ok(piLook && isJsonObject(piLook.session), "the bridge's look carries its session");
  assert.notEqual(piLook.session.id, other.session.id);
});

test("bridge: a target held past the wait answers target_busy, nothing sent, retry later", async () => {
  await startDaemon({ actHoldMs: 700, coordinationWaitMs: 150 });
  const other = await client("other-process");
  const otherLook = await look(other.client);
  let slow: Promise<JsonValue> | undefined;
  const { details, text } = await actThroughBridge(
    (observed) => [{ action: "press", ref: refFor(observed, "Increment") }],
    {
      beforeAct: async () => {
        slow = other.client.command("act", act(other.session, otherLook, FAKE_APP.pid));
        await pause(60);
      },
    },
  );
  await slow;
  assert.equal(details.status, "target_busy");
  assert.equal(details.nextStep, "retry_later");
  assert.ok(isJsonObject(details.error));
  assert.equal(details.error.inputSent, false);
  assert.match(text, /^target_busy: .*nothing was sent/);
  assert.match(text, /retry_later/);
});

test("bridge: a foreground act while another process holds the foreground answers foreground_busy, nothing sent", async () => {
  const fake = await startDaemon({ script: "s6-grant", coordinationWaitMs: 200 });
  const other = await client("other-process");
  const { details, text } = await actThroughBridge(
    (observed) => [{ action: "click", ref: refFor(observed, "Custom View") }],
    {
      grant: FAKE_APP.bundleId,
      beforeAct: async () => {
        assert.equal(await section(other.client, "acquire"), true);
      },
    },
  );
  assert.equal(details.status, "foreground_busy");
  assert.equal(details.nextStep, "retry_later");
  assert.match(text, /^foreground_busy: .*nothing was sent/);
  const acts = fake.requests.filter(
    (request) => request.cmd === "act" || request.cmd === "actBatch",
  );
  assert.equal(acts.length, 0, "the bridge sent no act while the foreground was held");
  await other.client.foregroundSection("release", 0);
});

test("bridge: a granted foreground act runs inside the helper's foreground section", async () => {
  const fake = await startDaemon({ script: "s6-grant" });
  await actThroughBridge(
    (observed) => [{ action: "click", ref: refFor(observed, "Custom View") }],
    { grant: FAKE_APP.bundleId },
  );
  const sections = fake.requests.filter((request) => request.cmd === "foregroundSection");
  assert.deepEqual(
    sections.map((request) => request.op),
    ["acquire", "release"],
  );
  const acquireAt = fake.requests.indexOf(sections[0]!);
  const actAt = fake.requests.findIndex((request) => request.cmd === "act");
  const releaseAt = fake.requests.indexOf(sections[1]!);
  assert.ok(acquireAt < actAt && actAt < releaseAt, "the act ran inside the section");
});
