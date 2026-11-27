import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { isNumber } from "../src/json.ts";
import type { PlatformRequestSession } from "../src/platform/types.ts";
import {
  FAKE_APP,
  startFakeHelperDaemon,
  type FakeHelperDaemon,
  type FakeHelperDaemonOptions,
} from "./helpers/fake-helper-daemon.ts";

const scratch = await mkdtemp(path.join(os.tmpdir(), "cu-section-"));
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
const { replacePlatformBackendForTest, currentPlatformBackend } =
  await import("../src/platform/index.ts");
const { enterForegroundSection } = await import("../src/bridge/helper-act.ts");

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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function client(id: string): Promise<{ client: Client; session: PlatformRequestSession }> {
  const created = new helper.MacosHelperClient();
  const owned: PlatformRequestSession = { id, generation: 0 };
  created.adoptSession(owned);
  await created.diagnosticsCommand();
  return { client: created, session: owned };
}

async function rejection<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected the helper command to reject");
}

test("N4: a cancelled acquire never takes the section; when the holder releases it is free at once", async () => {
  await startDaemon();
  const a = await client("section-a");
  const b = await client("section-b");
  const c = await client("section-c");
  assert.equal((await a.client.foregroundSection("acquire", 100))?.acquired, true);
  const acquireId = randomUUID();
  const controller = new AbortController();
  const waiting = rejection(
    b.client.foregroundSection("acquire", 5_000, controller.signal, acquireId),
  );
  await pause(150);
  controller.abort();
  await waiting;
  const cancelled = await b.client.foregroundSection("release", 0, undefined, acquireId);
  assert.equal(cancelled?.released, false, "B held nothing");
  assert.equal((await a.client.foregroundSection("release", 0))?.released, true);
  await pause(50);
  const next = await c.client.foregroundSection("acquire", 0);
  assert.equal(
    next?.acquired,
    true,
    "the section was free at once: B's cancelled wait took nothing",
  );
  assert.equal(daemon?.foregroundSectionHolder(), "section-c");
  await c.client.foregroundSection("release", 0);
});

test("N4: a release naming an acquire granted meanwhile releases it; it never releases another acquire", async () => {
  await startDaemon();
  const b = await client("section-b");
  const first = randomUUID();
  assert.equal(
    (await b.client.foregroundSection("acquire", 100, undefined, first))?.acquired,
    true,
  );
  const stale = await b.client.foregroundSection("release", 0, undefined, randomUUID());
  assert.equal(stale?.released, false, "a release naming another acquire leaves the section");
  assert.equal(daemon?.foregroundSectionHolder(), "section-b");
  const released = await b.client.foregroundSection("release", 0, undefined, first);
  assert.equal(released?.released, true);
  assert.equal(daemon?.foregroundSectionHolder(), undefined);
});

test("N4: an aborted enterForegroundSection cancels its helper acquire", async () => {
  await startDaemon();
  const a = await client("section-a");
  const b = await client("section-b");
  const c = await client("section-c");
  const restore = replacePlatformBackendForTest({
    ...currentPlatformBackend,
    name: "macos",
    foregroundSection: async (op, waitMs, signal, acquireId) => {
      const result = await b.client.foregroundSection(op, waitMs, signal, acquireId);
      if (result === undefined) return undefined;
      return op === "acquire" ? result.acquired === true : result.released === true;
    },
  });
  try {
    assert.equal((await a.client.foregroundSection("acquire", 100))?.acquired, true);
    const controller = new AbortController();
    const entering = rejection(enterForegroundSection({ focusCaptured: false }, controller.signal));
    await pause(150);
    controller.abort();
    await entering;
    await pause(100);
    assert.equal((await a.client.foregroundSection("release", 0))?.released, true);
    await pause(50);
    assert.equal((await c.client.foregroundSection("acquire", 0))?.acquired, true);
    await c.client.foregroundSection("release", 0);
  } finally {
    restore();
  }
});

test("N2: an idle section expires on a timer, with no request from anyone", async () => {
  await startDaemon({ foregroundSectionIdleMs: 300 });
  const a = await client("section-a");
  assert.equal((await a.client.foregroundSection("acquire", 100))?.acquired, true);
  assert.equal(daemon?.foregroundSectionHolder(), "section-a");
  await pause(700);
  assert.equal(daemon?.foregroundSectionHolder(), undefined, "expired without a request");
});

test("N2: a silent session expires on a timer, with no request from anyone", async () => {
  await startDaemon({ ownerTtlMs: 300, foregroundSectionIdleMs: 60_000 });
  const a = await client("section-a");
  assert.equal((await a.client.foregroundSection("acquire", 100))?.acquired, true);
  await pause(700);
  assert.equal(daemon?.foregroundSectionHolder(), undefined, "the expired session's section went");
});

test("N1: the successor of an expired section records the user's app, not the previous target", async () => {
  await startDaemon({ script: "s6-grant", foregroundSectionIdleMs: 300 });
  const a = await client("section-a");
  const b = await client("section-b");
  const first = await a.client.foregroundSection("acquire", 100);
  const userPid = first?.frontmostPid;
  assert.ok(isNumber(userPid) && userPid !== FAKE_APP.pid);
  await a.client.command("focusWindow", {
    pid: FAKE_APP.pid,
    foregroundGrant: true,
    session: { id: "section-a", generation: 0 },
  });
  const next = await b.client.foregroundSection("acquire", 5_000);
  assert.equal(next?.acquired, true);
  assert.equal(next?.frontmostPid, userPid, "B recorded the user's app as the user's window");
  await b.client.foregroundSection("release", 0);
});
