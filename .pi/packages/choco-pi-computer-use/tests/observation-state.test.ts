import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  executeAct,
  executeInspectUi,
  executeObserve,
  ObservationRefreshRequiredError,
  shutdownComputerUseSession,
} from "../src/bridge.ts";
import { restoreOutline, type LookResponse, type SerializedOutlineNode } from "../src/outline.ts";
import { replacePlatformBackendForTest } from "../src/platform/index.ts";
import type { ComputerUsePlatformBackend, PlatformRoot } from "../src/platform/types.ts";

const root: PlatformRoot = {
  kind: "window",
  rootRef: "native-root-1",
  windowRef: "native-root-1",
  windowId: 41,
  pid: 4242,
  appName: "Fixture App",
  bundleId: "test.fixture-app",
  title: "Fixture Window",
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
    identifier: "fixture-button",
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

function stateIdFromContent<T>(content: AgentToolResult<T>["content"]): string {
  const text = content
    .filter(
      (part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  const match = /\bstate(?:Id)? ([0-9a-f-]{36})\b/i.exec(text);
  if (!match?.[1]) throw new Error("Expected a state id in tool output.");
  return match[1];
}

function contextFixture(): ExtensionContext {
  // SAFETY: Bridge setup reads only cwd from this fixture; the fake backend ignores the remaining host context.
  return { cwd: "/Users/Nebuleto/Workspace/choco-pi", hasUI: false } as ExtensionContext;
}

test("observation prerequisites self-heal for reads and fail safely for actions", async () => {
  let observationCount = 0;
  let actionCount = 0;
  const backend: ComputerUsePlatformBackend = {
    name: "macos",
    async ensureReady(_ctx, state) {
      return state;
    },
    async listApps() {
      return [{ appName: root.appName!, bundleId: root.bundleId, pid: root.pid! }];
    },
    async listRoots() {
      return [root];
    },
    async getFrontmost() {
      return {
        appName: root.appName!,
        bundleId: root.bundleId,
        pid: root.pid!,
        windowTitle: root.title,
        windowId: root.windowId,
        rootRef: root.rootRef,
      };
    },
    async focusWindow() {
      throw new Error("Read-only auto-observation must not focus a window.");
    },
    async observe(request): Promise<LookResponse> {
      observationCount += 1;
      if (observationCount === 1) {
        assert.equal(
          request.readText,
          "never",
          "automatic inspection must use semantic observation",
        );
        assert.equal(request.includeImage, false, "automatic inspection must not capture an image");
      }
      const outline = restoreOutline({
        lookId: `look-${observationCount}`,
        root: serializedNode(),
      });
      return {
        lookId: outline.lookId,
        capturedAt: Date.now() / 1000,
        window: {
          windowId: root.windowId!,
          rootRef: root.rootRef,
          framePoints: root.framePoints,
          scaleFactor: root.scaleFactor,
          isModal: false,
          role: root.role!,
          subrole: root.subrole!,
        },
        outline: outline.root,
        parsedOutline: outline,
        timings: {},
        readText: { requested: request.readText, executed: false },
      };
    },
    async act() {
      actionCount += 1;
      return { outcome: "worked" };
    },
    async actBatch(requests) {
      actionCount += requests.length;
      return {
        outcome: "worked",
        performed: { transaction: true, actionCount: requests.length },
      };
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
  const restoreBackend = replacePlatformBackendForTest(backend);
  const ctx = contextFixture();
  const signal = new AbortController().signal;

  try {
    await shutdownComputerUseSession();
    const inspected = await executeInspectUi(
      "inspect-fresh",
      { ref: "@e1" },
      signal,
      undefined,
      ctx,
    );
    assert.equal(observationCount, 1);
    assert.match(
      inspected.content[0]?.type === "text" ? inspected.content[0].text : "",
      /Continue/,
    );

    await shutdownComputerUseSession();
    await assert.rejects(
      executeAct(
        "act-missing",
        { actions: [{ action: "press", ref: "@e1" }] },
        signal,
        undefined,
        ctx,
      ),
      (error: Error) => {
        assert.ok(error instanceof ObservationRefreshRequiredError);
        assert.deepEqual(error.requirement, {
          code: "observation_refresh_required",
          operation: "act_ui",
          reason: "missing",
          stateId: undefined,
          refresh: { tool: "observe_ui", arguments: { mode: "fused" } },
          staleness: undefined,
        });
        return true;
      },
    );
    assert.equal(actionCount, 0, "missing-state refusal must not deliver an action");

    const initial = await executeObserve("observe-initial", {}, signal, undefined, ctx);
    const initialStateId = stateIdFromContent(initial.content);
    const firstAction = await executeAct(
      "act-first",
      { stateId: initialStateId, actions: [{ action: "press", ref: "@e1" }] },
      signal,
      undefined,
      ctx,
    );
    assert.notEqual(stateIdFromContent(firstAction.content), initialStateId);
    assert.equal(actionCount, 1);

    await assert.rejects(
      executeAct(
        "act-stale",
        { stateId: initialStateId, actions: [{ action: "press", ref: "@e1" }] },
        signal,
        undefined,
        ctx,
      ),
      (error: Error) => {
        assert.ok(error instanceof ObservationRefreshRequiredError);
        assert.equal(error.requirement.reason, "stale");
        assert.equal(error.requirement.stateId, initialStateId);
        assert.equal(error.requirement.refresh.tool, "observe_ui");
        assert.equal(error.requirement.refresh.arguments.mode, "fused");
        assert.equal(error.requirement.refresh.arguments.root, "@r1");
        assert.equal(error.requirement.staleness?.observationEpoch, 0);
        assert.equal(error.requirement.staleness?.currentEpoch, 1);
        return true;
      },
    );
    assert.equal(actionCount, 1, "stale-state refusal must not deliver an action");

    const refreshed = await executeObserve("observe-refresh", {}, signal, undefined, ctx);
    const refreshedStateId = stateIdFromContent(refreshed.content);
    await executeAct(
      "act-refreshed",
      { stateId: refreshedStateId, actions: [{ action: "press", ref: "@e1" }] },
      signal,
      undefined,
      ctx,
    );
    assert.equal(actionCount, 2, "an action using the refreshed observation must succeed");
  } finally {
    await shutdownComputerUseSession();
    restoreBackend();
  }
});
