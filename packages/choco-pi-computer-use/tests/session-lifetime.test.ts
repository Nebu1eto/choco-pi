import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createComputerUseSessionHandlers } from "../extensions/computer-use.ts";
import {
  executeInspectUi,
  executeObserve,
  executeReadText,
  shutdownComputerUseSession,
} from "../src/bridge.ts";
import {
  helperRequestSession,
  liveComputerUseSessions,
  resourceScheduler,
  runtimeState,
  sessionKeyOf,
} from "../src/bridge/state-store.ts";
import { foregroundGrantCovers, getSessionGrants, grantForSession } from "../src/config.ts";
import { restoreOutline, type LookResponse, type SerializedOutlineNode } from "../src/outline.ts";
import { ensurePermissions } from "../src/permissions.ts";
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
  observeError?: string;
  ensureReady?: ComputerUsePlatformBackend["ensureReady"];
}

function fakeBackend(record: BackendRecord): ComputerUsePlatformBackend {
  let observations = 0;
  return {
    name: "macos",
    async shutdown() {
      record.shutdowns += 1;
    },
    async ensureReady(ctx, state, signal) {
      if (record.ensureReady) return await record.ensureReady(ctx, state, signal);
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
      if (record.observeError !== undefined) throw new Error(record.observeError);
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

test("a separately evaluated module instance shares the helper owner, the live sessions, and the managed browser", async () => {
  await withFixture(async (fixture) => {
    const specifier = new URL("../src/bridge/state-store.ts?second-instance", import.meta.url).href;
    const second: unknown = await import(specifier);
    assert.ok(isStateStoreInstance(second));
    assert.equal(second.helperRequestSession, helperRequestSession, "one owner per process");

    const { parentLoad } = await startParent(fixture);
    second.registerComputerUseSession("worktree-child");
    const generation = helperRequestSession.generation;

    await parentLoad.sessionShutdown({ type: "session_shutdown", reason: "quit" }, fixture.parent);
    assert.equal(fixture.browser.killed, false, "the managed browser outlives this instance");
    assert.equal(runtimeState.managedBrowser, fixture.browser);
    assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, "9555", "the CDP port stays exported");
    assert.equal(fixture.record.shutdowns, 0, "the helper claim outlives this instance");
    assert.equal(helperRequestSession.generation, generation);
    assert.deepEqual(liveComputerUseSessions(), ["worktree-child"]);

    await second.endComputerUseSession("worktree-child");
    assert.deepEqual(liveComputerUseSessions(), []);
    assert.equal(helperRequestSession.generation, generation + 1);
    assert.equal(fixture.browser.killed, true, "the last live session stopped the browser");
    await exited(fixture.browser);
    assert.equal(runtimeState.managedBrowser, undefined);
    assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined, "the CDP port was restored");
    assert.equal(fixture.record.shutdowns, 2, "the last session released every instance's claim");
  });
});

function textContent<T>(content: AgentToolResult<T>["content"]): string {
  return content
    .filter(
      (part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

test("a stored @o output is readable only by the session that produced it", async () => {
  await withFixture(async (fixture) => {
    const parentLoad = createComputerUseSessionHandlers();
    await parentLoad.sessionStart({ type: "session_start", reason: "startup" }, fixture.parent);
    const childLoad = createComputerUseSessionHandlers();
    await childLoad.sessionStart({ type: "session_start", reason: "startup" }, fixture.child);
    fixture.record.observeError = `secret-of-parent ${"x".repeat(64 * 1024)}`;
    let message = "";
    await assert.rejects(
      executeObserve(
        "observe-big",
        { mode: "semantic" },
        fixture.signal,
        undefined,
        fixture.parent,
      ),
      (error: Error) => {
        message = error.message;
        return true;
      },
    );
    fixture.record.observeError = undefined;
    const ref = /read_text\(\{ ref: "(@o\d+)"/.exec(message)?.[1];
    assert.ok(ref, `the oversized error was stored: ${message.slice(-200)}`);

    await assert.rejects(
      executeReadText("read-child", { ref }, fixture.signal, undefined, fixture.child),
      /unavailable or was evicted/,
      "another live session cannot read it",
    );
    const page = await executeReadText(
      "read-parent",
      { ref },
      fixture.signal,
      undefined,
      fixture.parent,
    );
    assert.match(textContent(page.content), /secret-of-parent/);

    const third = await createTestExtensionContext(path.dirname(fixture.parent.cwd));
    const thirdLoad = createComputerUseSessionHandlers();
    await thirdLoad.sessionStart({ type: "session_start", reason: "startup" }, third);
    await assert.rejects(
      executeReadText("read-third", { ref }, fixture.signal, undefined, third),
      /unavailable or was evicted/,
    );
    await thirdLoad.sessionShutdown({ type: "session_shutdown", reason: "quit" }, third);
    await childLoad.sessionShutdown({ type: "session_shutdown", reason: "quit" }, fixture.child);
    await executeReadText("read-parent-again", { ref }, fixture.signal, undefined, fixture.parent);

    await parentLoad.sessionShutdown({ type: "session_shutdown", reason: "new" }, fixture.parent);
    const nextLoad = createComputerUseSessionHandlers();
    await nextLoad.sessionStart({ type: "session_start", reason: "new" }, fixture.parent);
    await assert.rejects(
      executeReadText("read-restarted", { ref }, fixture.signal, undefined, fixture.parent),
      /unavailable or was evicted/,
    );
    await nextLoad.sessionShutdown({ type: "session_shutdown", reason: "quit" }, fixture.parent);
  });
});

test("permission setup of a session that ended while it awaited never touches that session's UI", async () => {
  await withFixture(async (fixture) => {
    const selects: string[] = [];
    const notices: string[] = [];
    const ctx = await createTestExtensionContext(path.dirname(fixture.parent.cwd), {
      select: async (title) => {
        selects.push(title);
        return "Cancel";
      },
      notify: (message) => {
        notices.push(message);
      },
    });
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let entered: () => void = () => undefined;
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let checks = 0;
    fixture.record.ensureReady = async (setupCtx, state, signal) => {
      await ensurePermissions(
        setupCtx,
        {
          kinds: [{ kind: "accessibility", openOption: "Open Accessibility Settings (missing)" }],
          copy: {
            nonInteractiveError: () => "non-interactive",
            prompt: () => "grant the helper",
            incompleteError: () => "setup incomplete",
            readyMessage: "ready",
            stillMissing: () => "still missing",
          },
          checkPermissions: async () => {
            checks += 1;
            if (checks === 1) {
              entered();
              await gate;
            }
            return { accessibility: false, screenRecording: false };
          },
          registerPermissions: async () => undefined,
          openPermissionPane: async () => undefined,
          restartHelper: async () => undefined,
        },
        "/test/pi-computer-use.app",
        signal,
      );
      return state;
    };
    const load = createComputerUseSessionHandlers();
    const started = load.sessionStart({ type: "session_start", reason: "startup" }, ctx);
    await checking;
    await load.sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);
    openGate();
    await started;
    assert.deepEqual(selects, [], "the retired session's setup asked nothing");
    assert.deepEqual(notices, [], "and showed nothing");
    assert.equal(checks, 1, "it stopped at the first await after the session ended");
  });
});
