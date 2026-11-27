import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createComputerUseSessionHandlers } from "../extensions/computer-use.ts";
import { executeInspectUi, executeObserve, shutdownComputerUseSession } from "../src/bridge.ts";
import {
  helperRequestSession,
  liveComputerUseSessions,
  resourceScheduler,
  runtimeState,
  sessionKeyOf,
} from "../src/bridge/state-store.ts";
import { foregroundGrantCovers, getSessionGrants, grantForSession } from "../src/config.ts";
import { restoreOutline, type LookResponse, type SerializedOutlineNode } from "../src/outline.ts";
import { replacePlatformBackendForTest } from "../src/platform/index.ts";
import type { ComputerUsePlatformBackend, PlatformRoot } from "../src/platform/types.ts";
import { runInSessionScope, sessionScopeFor } from "../src/runtime.ts";
import { createTestExtensionContext } from "./helpers/extension-context.ts";

const BUNDLE_ID = "test.session-lifetime";

const root: PlatformRoot = {
  kind: "window",
  rootRef: "native-root-lifetime",
  windowRef: "native-root-lifetime",
  windowId: 51,
  pid: 5151,
  appName: "Lifetime Fixture",
  bundleId: BUNDLE_ID,
  title: "Lifetime Window",
  role: "AXWindow",
  subrole: "AXStandardWindow",
  zOrder: 0,
  framePoints: { x: 0, y: 0, w: 640, h: 480 },
  scaleFactor: 1,
  isOnscreen: true,
  isFocused: true,
  isMinimized: false,
  isMain: true,
  isModal: false,
};

function serializedNode(): SerializedOutlineNode {
  return {
    ref: "@e1",
    wireRef: "wire-button-1",
    role: "Button",
    subrole: "",
    identifier: "lifetime-button",
    title: "Continue",
    description: "",
    value: "",
    actions: ["press"],
    canPress: true,
    canFocus: true,
    canSetValue: false,
    canScroll: false,
    canIncrement: false,
    canDecrement: false,
    isTextInput: false,
    rect: { x: 10, y: 10, w: 120, h: 32 },
    focused: false,
    offscreen: false,
    pictureOnly: false,
    truncated: false,
    text: [],
    children: [],
  };
}

interface BackendRecord {
  shutdowns: number;
}

function fakeBackend(record: BackendRecord): ComputerUsePlatformBackend {
  let observations = 0;
  return {
    name: "macos",
    async shutdown() {
      record.shutdowns += 1;
    },
    async ensureReady(_ctx, state) {
      return state;
    },
    async listApps() {
      return [{ appName: "Lifetime Fixture", bundleId: BUNDLE_ID, pid: 5151 }];
    },
    async listRoots() {
      return [root];
    },
    async getFrontmost() {
      return {
        appName: "Lifetime Fixture",
        bundleId: BUNDLE_ID,
        pid: 5151,
        windowTitle: root.title,
        windowId: root.windowId,
        rootRef: root.rootRef,
      };
    },
    async focusWindow() {
      throw new Error("Session lifetime tests must not focus a window.");
    },
    async restoreUserFocus() {
      throw new Error("Session lifetime tests must not restore focus.");
    },
    async observe(request): Promise<LookResponse> {
      observations += 1;
      const outline = restoreOutline({ lookId: `look-${observations}`, root: serializedNode() });
      return {
        lookId: outline.lookId,
        capturedAt: Date.now() / 1000,
        window: {
          windowId: 51,
          rootRef: root.rootRef,
          framePoints: root.framePoints,
          scaleFactor: root.scaleFactor,
          isModal: false,
          role: "AXWindow",
          subrole: "AXStandardWindow",
        },
        outline: outline.root,
        parsedOutline: outline,
        timings: {},
        readText: { requested: request.readText, executed: false },
      };
    },
    async act() {
      throw new Error("Session lifetime tests must not act.");
    },
    async actBatch() {
      throw new Error("Session lifetime tests must not act.");
    },
    async readText() {
      return { text: "", offset: 0, limit: 0, totalChars: 0, hasMore: false };
    },
    async waitFor() {
      return { found: true };
    },
    isBrowserApp() {
      return false;
    },
    isChromeFamilyApp() {
      return false;
    },
    async openBrowserLocation() {
      return false;
    },
  };
}

function stateIdFromContent<T>(content: AgentToolResult<T>["content"]): string {
  const text = content
    .filter(
      (part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  const match = /\bstate(?:_id)? ([0-9a-f-]{36})\b/i.exec(text);
  if (!match?.[1]) throw new Error("Expected a state id in tool output.");
  return match[1];
}

function spawnStandInBrowser(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function grantInSession(ctx: ExtensionContext, bundleId: string): void {
  runInSessionScope(sessionScopeFor(sessionKeyOf(ctx)), () => {
    assert.equal(grantForSession(bundleId), true);
  });
}

function coveredInSession(ctx: ExtensionContext, bundleId: string): boolean {
  return runInSessionScope(sessionScopeFor(sessionKeyOf(ctx)), () =>
    foregroundGrantCovers(bundleId),
  );
}

function grantsInSession(ctx: ExtensionContext): string[] {
  return runInSessionScope(sessionScopeFor(sessionKeyOf(ctx)), () => getSessionGrants());
}

interface Fixture {
  record: BackendRecord;
  parent: ExtensionContext;
  child: ExtensionContext;
  browser: ChildProcess;
  signal: AbortSignal;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "cu-session-lifetime-"));
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const savedGrant = process.env.PI_COMPUTER_USE_FOREGROUND_GRANT;
  const savedCdpPort = process.env.PI_COMPUTER_USE_CDP_PORT;
  process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
  delete process.env.PI_COMPUTER_USE_FOREGROUND_GRANT;
  delete process.env.PI_COMPUTER_USE_CDP_PORT;
  const record: BackendRecord = { shutdowns: 0 };
  const restoreBackend = replacePlatformBackendForTest(fakeBackend(record));
  const browser = spawnStandInBrowser();
  try {
    await shutdownComputerUseSession();
    record.shutdowns = 0;
    const parent = await createTestExtensionContext(scratch);
    const child = await createTestExtensionContext(scratch);
    assert.notEqual(sessionKeyOf(parent), sessionKeyOf(child));
    await run({ record, parent, child, browser, signal: new AbortController().signal });
  } finally {
    await shutdownComputerUseSession();
    if (browser.exitCode === null && browser.signalCode === null) browser.kill("SIGKILL");
    await exited(browser);
    restoreBackend();
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedGrant === undefined) delete process.env.PI_COMPUTER_USE_FOREGROUND_GRANT;
    else process.env.PI_COMPUTER_USE_FOREGROUND_GRANT = savedGrant;
    if (savedCdpPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
    else process.env.PI_COMPUTER_USE_CDP_PORT = savedCdpPort;
    await rm(scratch, { recursive: true, force: true });
  }
}

async function startParent(fixture: Fixture) {
  const parentLoad = createComputerUseSessionHandlers();
  await parentLoad.sessionStart({ type: "session_start", reason: "startup" }, fixture.parent);
  grantInSession(fixture.parent, BUNDLE_ID);
  const observed = await executeObserve(
    "observe-parent",
    { mode: "semantic" },
    fixture.signal,
    undefined,
    fixture.parent,
  );
  const stateId = stateIdFromContent(observed.content);
  runtimeState.managedBrowser = fixture.browser;
  runtimeState.managedBrowserCdpPort = "9555";
  process.env.PI_COMPUTER_USE_CDP_PORT = "9555";
  return { parentLoad, stateId };
}

test("another session starting and ending leaves the parent session's state intact", async () => {
  await withFixture(async (fixture) => {
    const { stateId } = await startParent(fixture);
    const scheduler = resourceScheduler;
    const ownerId = helperRequestSession.id;
    const generation = helperRequestSession.generation;

    const childLoad = createComputerUseSessionHandlers();
    await childLoad.sessionStart({ type: "session_start", reason: "startup" }, fixture.child);
    assert.equal(coveredInSession(fixture.child, BUNDLE_ID), false, "grants are per session");
    grantInSession(fixture.child, "test.child-only");
    await executeObserve(
      "observe-child",
      { mode: "semantic" },
      fixture.signal,
      undefined,
      fixture.child,
    );
    await childLoad.sessionShutdown({ type: "session_shutdown", reason: "quit" }, fixture.child);

    assert.equal(coveredInSession(fixture.parent, BUNDLE_ID), true, "parent grant survives");
    assert.deepEqual(grantsInSession(fixture.parent), [BUNDLE_ID]);
    const inspected = await executeInspectUi(
      "inspect-parent",
      { ref: "@e1", stateId },
      fixture.signal,
      undefined,
      fixture.parent,
    );
    assert.match(
      inspected.content[0]?.type === "text" ? inspected.content[0].text : "",
      /Continue/,
      "the parent's saved observation is still usable by state_id",
    );
    assert.equal(resourceScheduler, scheduler, "the scheduler was not closed or replaced");
    assert.equal(runtimeState.managedBrowser, fixture.browser, "managed browser is still tracked");
    assert.equal(runtimeState.managedBrowserCdpPort, "9555");
    assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, "9555");
    assert.equal(fixture.browser.killed, false, "the managed browser was not signalled");
    assert.equal(fixture.record.shutdowns, 0, "the helper owner claim was not released");
    assert.equal(helperRequestSession.id, ownerId);
    assert.equal(helperRequestSession.generation, generation);
    assert.deepEqual(liveComputerUseSessions(), [sessionKeyOf(fixture.parent)]);
  });
});

test("the last session ending performs the full cleanup", async () => {
  await withFixture(async (fixture) => {
    const { parentLoad, stateId } = await startParent(fixture);
    const childLoad = createComputerUseSessionHandlers();
    await childLoad.sessionStart({ type: "session_start", reason: "startup" }, fixture.child);
    await childLoad.sessionShutdown({ type: "session_shutdown", reason: "quit" }, fixture.child);
    const scheduler = resourceScheduler;
    const ownerId = helperRequestSession.id;
    const generation = helperRequestSession.generation;

    await parentLoad.sessionShutdown({ type: "session_shutdown", reason: "quit" }, fixture.parent);

    assert.deepEqual(liveComputerUseSessions(), []);
    assert.notEqual(resourceScheduler, scheduler, "the scheduler was closed and replaced");
    assert.equal(runtimeState.managedBrowser, undefined);
    assert.equal(runtimeState.managedBrowserCdpPort, undefined);
    assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined);
    assert.equal(fixture.browser.killed, true, "the managed browser was terminated");
    await exited(fixture.browser);
    assert.equal(fixture.record.shutdowns, 1, "the helper owner claim was released once");
    assert.equal(helperRequestSession.id, ownerId, "the owner id is stable for the process");
    assert.equal(helperRequestSession.generation, generation + 1);
    assert.equal(coveredInSession(fixture.parent, BUNDLE_ID), false, "grants are gone");
    await assert.rejects(
      executeInspectUi(
        "inspect-after",
        { ref: "@e1", stateId },
        fixture.signal,
        undefined,
        fixture.parent,
      ),
      /unavailable or was evicted/,
    );
  });
});

test("a restarted session (/new, resume, reload) starts with no stale state", async () => {
  await withFixture(async (fixture) => {
    const { parentLoad, stateId } = await startParent(fixture);
    await parentLoad.sessionShutdown({ type: "session_shutdown", reason: "new" }, fixture.parent);
    const nextLoad = createComputerUseSessionHandlers();
    await nextLoad.sessionStart({ type: "session_start", reason: "new" }, fixture.parent);
    assert.deepEqual(grantsInSession(fixture.parent), []);
    await assert.rejects(
      executeInspectUi(
        "inspect-new",
        { ref: "@e1", stateId },
        fixture.signal,
        undefined,
        fixture.parent,
      ),
      /unavailable or was evicted/,
    );
    assert.equal(fixture.record.shutdowns, 1);
    await nextLoad.sessionShutdown({ type: "session_shutdown", reason: "quit" }, fixture.parent);
  });
});

interface StateStoreInstance {
  helperRequestSession: typeof helperRequestSession;
  registerComputerUseSession(sessionKey: string): void;
  endComputerUseSession(sessionKey: string): Promise<void>;
}

function isStateStoreInstance<T>(value: T): value is T & StateStoreInstance {
  if (value === null || value === undefined || Object(value) !== value) return false;
  const candidate = Object(value);
  return (
    Object(candidate.helperRequestSession) === candidate.helperRequestSession &&
    candidate.registerComputerUseSession instanceof Function &&
    candidate.endComputerUseSession instanceof Function
  );
}

test("a separately evaluated module instance shares the helper owner and the live sessions", async () => {
  await withFixture(async (fixture) => {
    const specifier = new URL("../src/bridge/state-store.ts?second-instance", import.meta.url).href;
    const second: unknown = await import(specifier);
    assert.ok(isStateStoreInstance(second));
    assert.equal(second.helperRequestSession, helperRequestSession, "one owner per process");

    const { parentLoad } = await startParent(fixture);
    second.registerComputerUseSession("worktree-child");
    const generation = helperRequestSession.generation;

    await parentLoad.sessionShutdown({ type: "session_shutdown", reason: "quit" }, fixture.parent);
    assert.equal(fixture.browser.killed, true, "this instance released its own resources");
    assert.equal(fixture.record.shutdowns, 0, "the helper claim outlives this instance");
    assert.equal(helperRequestSession.generation, generation);
    assert.deepEqual(liveComputerUseSessions(), ["worktree-child"]);

    await second.endComputerUseSession("worktree-child");
    assert.deepEqual(liveComputerUseSessions(), []);
    assert.equal(helperRequestSession.generation, generation + 1);
    assert.equal(fixture.record.shutdowns, 2, "the last session released every instance's claim");
  });
});
