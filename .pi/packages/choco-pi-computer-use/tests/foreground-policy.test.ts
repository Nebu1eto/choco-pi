import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeAct, executeObserve, shutdownComputerUseSession } from "../src/bridge.ts";
import type { UiAction } from "../src/contract.ts";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "../src/json.ts";
import { restoreOutline, type LookResponse, type SerializedOutlineNode } from "../src/outline.ts";
import { replacePlatformBackendForTest } from "../src/platform/index.ts";
import type {
  ComputerUsePlatformBackend,
  HelperActResult,
  PlatformActRequest,
  PlatformRoot,
} from "../src/platform/types.ts";
import { createTestExtensionContext } from "./helpers/extension-context.ts";

const BUNDLE_ID = "test.foreground-fixture";

const root: PlatformRoot = {
  kind: "window",
  rootRef: "native-root-fg",
  windowRef: "native-root-fg",
  windowId: 77,
  pid: 7777,
  appName: "Foreground Fixture",
  bundleId: BUNDLE_ID,
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

function node(
  overrides: Partial<SerializedOutlineNode> & Pick<SerializedOutlineNode, "ref">,
): SerializedOutlineNode {
  return {
    wireRef: undefined,
    role: "Group",
    subrole: "",
    identifier: "",
    title: "",
    description: "",
    value: "",
    actions: [],
    canPress: false,
    canFocus: false,
    canSetValue: false,
    canScroll: false,
    canIncrement: false,
    canDecrement: false,
    isTextInput: false,
    rect: { x: 0, y: 0, w: 640, h: 480 },
    focused: false,
    offscreen: false,
    pictureOnly: false,
    truncated: false,
    text: [],
    children: [],
    ...overrides,
  };
}

function outlineRoot(): SerializedOutlineNode {
  return node({
    ref: "@e1",
    children: [
      node({
        ref: "@e2",
        wireRef: "wire-field-1",
        role: "TextField",
        title: "Name",
        actions: ["AXConfirm"],
        canFocus: true,
        canSetValue: true,
        isTextInput: true,
        rect: { x: 20, y: 20, w: 200, h: 24 },
      }),
      node({
        ref: "@e3",
        wireRef: "wire-button-1",
        role: "Button",
        title: "Continue",
        actions: ["AXPress"],
        canPress: true,
        canFocus: true,
        rect: { x: 20, y: 80, w: 120, h: 32 },
      }),
      // A focusable custom view with no AX action: only pointer input can click it.
      node({
        ref: "@e4",
        wireRef: "wire-custom-1",
        role: "Group",
        description: "Custom View",
        canFocus: true,
        rect: { x: 260, y: 60, w: 160, h: 120 },
      }),
    ],
  });
}

type Responder = (request: PlatformActRequest) => HelperActResult;

class ForegroundRequiredFixtureError extends Error {
  readonly code = "foreground_required";
  readonly effectPossible?: boolean;

  constructor(message: string, effectPossible?: boolean) {
    super(message);
    this.effectPossible = effectPossible;
  }
}

function fakeBackend(
  respond: Responder,
  requests: PlatformActRequest[],
  outlineOnly = false,
): ComputerUsePlatformBackend {
  let observationCount = 0;
  return {
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
      throw new Error("Foreground policy tests must never focus a window.");
    },
    async observe(): Promise<LookResponse> {
      observationCount += 1;
      const outline = restoreOutline({ lookId: `look-${observationCount}`, root: outlineRoot() });
      const look: LookResponse = {
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
        image: { jpegBase64: "AAAA", mimeType: "image/jpeg", width: 640, height: 480 },
        outline: outline.root,
        parsedOutline: outline,
        timings: {},
        readText: { requested: "never", executed: false },
      };
      if (outlineOnly) delete look.image;
      return look;
    },
    async act(request) {
      requests.push(request);
      return respond(request);
    },
    async actBatch() {
      throw new Error("Non-headless actions must be delivered one at a time.");
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
  const match = /\bstate(?:Id)? ([0-9a-f-]{36})\b/i.exec(text);
  if (!match?.[1]) throw new Error("Expected a state id in tool output.");
  return match[1];
}

function detailsJson<T>(result: AgentToolResult<T>): JsonObject {
  const parsed: JsonValue = JSON.parse(JSON.stringify(result.details));
  assert.ok(isJsonObject(parsed), "tool result details must be an object");
  return parsed;
}

function objectField(value: JsonObject, key: string): JsonObject {
  const field = value[key];
  assert.ok(isJsonObject(field), `expected object field '${key}'`);
  return field;
}

const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_COMPUTER_USE_HEADLESS",
  "PI_COMPUTER_USE_BROWSER_USE",
  "PI_COMPUTER_USE_DELIVERY_POLICY",
  "PI_COMPUTER_USE_EVENT_DELIVERY",
  "PI_COMPUTER_USE_FOREGROUND_GRANT",
] as const;

interface Scenario {
  grant?: string;
  deliveryPolicy?: string;
  configGrant?: string[];
  /** Observations carry no image, like a semantic (outline-only) observation. */
  outlineOnly?: boolean;
}

async function withFixture<T>(
  scenario: Scenario,
  respond: Responder,
  run: (context: {
    ctx: ExtensionContext;
    signal: AbortSignal;
    requests: PlatformActRequest[];
  }) => Promise<T>,
): Promise<T> {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const scratch = await mkdtemp(path.join(os.tmpdir(), "cu-foreground-policy-"));
  const agentDir = path.join(scratch, "agent");
  const cwd = path.join(scratch, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  if (scenario.configGrant) {
    await writeFile(
      path.join(cwd, ".pi", "computer-use.json"),
      JSON.stringify({ foreground_grant: scenario.configGrant }),
    );
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_COMPUTER_USE_HEADLESS = "0";
  process.env.PI_COMPUTER_USE_BROWSER_USE = "0";
  delete process.env.PI_COMPUTER_USE_EVENT_DELIVERY;
  if (scenario.deliveryPolicy === undefined) delete process.env.PI_COMPUTER_USE_DELIVERY_POLICY;
  else process.env.PI_COMPUTER_USE_DELIVERY_POLICY = scenario.deliveryPolicy;
  if (scenario.grant === undefined) delete process.env.PI_COMPUTER_USE_FOREGROUND_GRANT;
  else process.env.PI_COMPUTER_USE_FOREGROUND_GRANT = scenario.grant;

  const requests: PlatformActRequest[] = [];
  const restoreBackend = replacePlatformBackendForTest(
    fakeBackend(respond, requests, scenario.outlineOnly === true),
  );
  try {
    const ctx = await createTestExtensionContext(cwd);
    await shutdownComputerUseSession();
    return await run({ ctx, signal: new AbortController().signal, requests });
  } finally {
    await shutdownComputerUseSession();
    restoreBackend();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

async function actOnceWithText(
  context: { ctx: ExtensionContext; signal: AbortSignal },
  actions: UiAction[],
): Promise<{ details: JsonObject; text: string }> {
  const observed = await executeObserve("observe", {}, context.signal, undefined, context.ctx);
  const stateId = stateIdFromContent(observed.content);
  const result = await executeAct(
    "act",
    { stateId, actions },
    context.signal,
    undefined,
    context.ctx,
  );
  const text = result.content
    .filter(
      (part): part is Extract<(typeof result.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  return { details: detailsJson(result), text };
}

async function actOnce(
  context: { ctx: ExtensionContext; signal: AbortSignal },
  actions: UiAction[],
): Promise<JsonObject> {
  return (await actOnceWithText(context, actions)).details;
}

interface Route {
  name: string;
  actions: UiAction[];
  /** The refused action under test (earlier actions succeed). */
  subject: PlatformActRequest["action"];
  targetKind: "x" | "focus";
}

const routes: Route[] = [
  {
    name: "raw coordinate click",
    actions: [{ action: "click", x: 100, y: 100 }],
    subject: "click",
    targetKind: "x",
  },
  {
    name: "typeText without ref after a click",
    actions: [
      { action: "click", x: 100, y: 30 },
      { action: "typeText", text: "hello" },
    ],
    subject: "typeText",
    targetKind: "focus",
  },
  {
    name: "keypress without ref after a click",
    actions: [
      { action: "click", x: 100, y: 30 },
      { action: "keypress", keys: ["Enter"] },
    ],
    subject: "keypress",
    targetKind: "focus",
  },
];

const failureModes: Array<{ name: string; fail: () => HelperActResult }> = [
  { name: "returns didnt", fail: () => ({ outcome: "didnt" }) },
  {
    name: "throws foreground_required",
    fail: () => {
      throw new ForegroundRequiredFixtureError("Web content requires pointer input");
    },
  },
];

function responder(subject: Route["subject"], fail: () => HelperActResult): Responder {
  return (request) => (request.action === subject ? fail() : { outcome: "worked" });
}

function assertNoUngrantedForeground(requests: PlatformActRequest[]): void {
  for (const request of requests) {
    assert.notEqual(request.policy, "foreground", "foreground delivery requires a host grant");
    assert.equal(request.foregroundGrant, undefined, "no grant flag without a host grant");
  }
}

for (const route of routes) {
  for (const mode of failureModes) {
    test(`${route.name}: ${mode.name} yields one act and a foreground_required refusal`, async () => {
      await withFixture({}, responder(route.subject, mode.fail), async (context) => {
        const details = await actOnce(context, route.actions);
        const { requests } = context;
        assertNoUngrantedForeground(requests);
        const subjectRequests = requests.filter((request) => request.action === route.subject);
        assert.equal(subjectRequests.length, 1, "the refused action must be sent exactly once");
        assert.equal(requests.length, route.actions.length, "no retry or extra act call");
        const subject = subjectRequests[0]!;
        assert.equal(subject.policy, "background");
        assert.ok(
          route.targetKind in subject.target,
          `target must be a ${route.targetKind} target`,
        );
        if (route.targetKind === "focus")
          assert.equal(subject.focusResolution, "ax_focused_element");

        assert.equal(details.status, "foreground_required");
        const execution = objectField(details, "execution");
        assert.notEqual(execution.escalatedToForeground, true);
        assert.equal(execution.outcome, "didnt");
        assert.equal(execution.stoppedAt, route.actions.length - 1);
        const refusal = objectField(execution, "refusal");
        assert.equal(refusal.code, "foreground_required");
        assert.equal(refusal.action, route.subject);
        assert.equal(refusal.effectPossible, true, "unproven non-delivery is reported as possible");
        assert.ok(isString(refusal.capability) && refusal.capability.length > 0);
        assert.ok(isString(refusal.grantHint) && refusal.grantHint.includes(BUNDLE_ID));
        const target = objectField(refusal, "target");
        assert.equal(target.bundleId, BUNDLE_ID);
        assert.equal(target.pid, root.pid);
        assert.equal(target.app, root.appName);
        assert.equal(target.windowTitle, root.title);
        const steps = execution.steps;
        assert.ok(Array.isArray(steps));
        for (const step of steps) {
          assert.ok(isJsonObject(step));
          assert.notEqual(step.escalatedToForeground, true);
        }
      });
    });
  }

  test(`${route.name}: a matching env grant delivers in foreground once`, async () => {
    await withFixture(
      { grant: `other.app, ${BUNDLE_ID}` },
      () => ({ outcome: "worked" }),
      async (context) => {
        const details = await actOnce(context, route.actions);
        const subject = context.requests.filter((request) => request.action === route.subject);
        assert.equal(subject.length, 1);
        assert.equal(subject[0]!.policy, "foreground");
        assert.equal(subject[0]!.foregroundGrant, true);
        assert.equal(details.status, "ok");
        const execution = objectField(details, "execution");
        assert.equal(execution.refusal, undefined);
        assert.notEqual(execution.escalatedToForeground, true);
      },
    );
  });

  test(`${route.name}: a grant for a different bundle id does not apply`, async () => {
    await withFixture(
      { grant: "com.example.other" },
      responder(route.subject, () => ({ outcome: "didnt" })),
      async (context) => {
        const details = await actOnce(context, route.actions);
        assertNoUngrantedForeground(context.requests);
        assert.equal(context.requests.filter((r) => r.action === route.subject).length, 1);
        assert.equal(
          objectField(objectField(details, "execution"), "refusal").code,
          "foreground_required",
        );
      },
    );
  });
}

test("a granted foreground attempt that fails is not retried", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    () => {
      throw new ForegroundRequiredFixtureError("still refused");
    },
    async (context) => {
      const details = await actOnce(context, [{ action: "click", x: 100, y: 100 }]);
      assert.equal(context.requests.length, 1);
      assert.equal(context.requests[0]!.policy, "foreground");
      assert.equal(details.status, "foreground_required");
    },
  );
});

test("config-file grant and wildcard are honored; env foreground policy is ignored with a note", async () => {
  await withFixture(
    { configGrant: ["*"] },
    () => ({ outcome: "worked" }),
    async (context) => {
      await actOnce(context, [{ action: "click", x: 100, y: 100 }]);
      assert.equal(context.requests[0]!.policy, "foreground");
      assert.equal(context.requests[0]!.foregroundGrant, true);
    },
  );

  await withFixture(
    { deliveryPolicy: "foreground" },
    () => ({ outcome: "worked" }),
    async (context) => {
      const details = await actOnce(context, [
        { action: "click", ref: "@e3" },
        { action: "click", x: 100, y: 100 },
      ]);
      assertNoUngrantedForeground(context.requests);
      for (const request of context.requests) assert.equal(request.params.delivery, "pid");
      const notes = objectField(details, "config").notes;
      assert.ok(
        Array.isArray(notes) && notes.some((note) => isString(note) && note.includes("ignored")),
      );
    },
  );
});

test("background-eligible actions stay background even when a grant covers the app", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    () => ({ outcome: "didnt" }),
    async (context) => {
      const details = await actOnce(context, [{ action: "typeText", ref: "@e2", text: "x" }]);
      assert.equal(context.requests.length, 1);
      assert.equal(context.requests[0]!.policy, "background");
      assert.equal(
        objectField(objectField(details, "execution"), "refusal").code,
        "foreground_required",
      );
    },
  );
});

test("every act request carries a unique request id, session, and future deadline", async () => {
  await withFixture(
    {},
    () => ({ outcome: "worked", frontmostBefore: { pid: 1 }, frontmostAfter: { pid: 2 } }),
    async (context) => {
      const before = Date.now();
      const details = await actOnce(context, [
        { action: "click", ref: "@e3" },
        { action: "click", x: 100, y: 100 },
      ]);
      const ids = new Set(context.requests.map((request) => request.requestId));
      assert.equal(ids.size, context.requests.length);
      for (const request of context.requests) {
        assert.ok(request.requestId.length > 0);
        assert.ok(request.session.id.length > 0);
        assert.ok(Number.isInteger(request.session.generation));
        assert.ok(request.deadlineMs > before);
      }
      const execution = objectField(details, "execution");
      assert.deepEqual(execution.frontmostBefore, { pid: 1 });
      assert.deepEqual(execution.frontmostAfter, { pid: 2 });
    },
  );
});

test("a helper refusal that proves non-delivery reports effectPossible false", async () => {
  await withFixture(
    {},
    () => {
      throw new ForegroundRequiredFixtureError("rejected before delivery", false);
    },
    async (context) => {
      const details = await actOnce(context, [{ action: "click", x: 100, y: 100 }]);
      assert.equal(context.requests.length, 1);
      const refusal = objectField(objectField(details, "execution"), "refusal");
      assert.equal(refusal.effectPossible, false);
    },
  );
});

const retryModes: Array<{ name: string; refuse: (effectPossible: boolean) => HelperActResult }> = [
  {
    name: "thrown",
    refuse: (effectPossible) => {
      throw new ForegroundRequiredFixtureError("background refused", effectPossible);
    },
  },
  {
    name: "returned",
    refuse: (effectPossible) => ({
      outcome: "didnt",
      error: { code: "foreground_required", message: "background refused", effectPossible },
    }),
  },
];

const refTypeText: UiAction[] = [{ action: "typeText", ref: "@e2", text: "x" }];

for (const mode of retryModes) {
  test(`granted + ${mode.name} foreground_required with effectPossible false retries once in foreground`, async () => {
    await withFixture(
      { grant: BUNDLE_ID },
      (request) => (request.policy === "background" ? mode.refuse(false) : { outcome: "worked" }),
      async (context) => {
        const details = await actOnce(context, refTypeText);
        const [first, second, ...rest] = context.requests;
        assert.equal(rest.length, 0, "at most one retry");
        assert.equal(first?.policy, "background");
        assert.equal(first?.foregroundGrant, undefined);
        assert.equal(second?.policy, "foreground");
        assert.equal(second?.foregroundGrant, true);
        assert.notEqual(first?.requestId, second?.requestId);
        assert.equal(details.status, "ok");
        const execution = objectField(details, "execution");
        assert.equal(execution.refusal, undefined);
        assert.equal(execution.escalatedToForeground, true);
        assert.equal(execution.escalationReason, "foreground_required");
        assert.equal(objectField(execution, "backgroundAttempt").outcome, "foreground_required");
        const steps = execution.steps;
        assert.ok(Array.isArray(steps) && isJsonObject(steps[0]));
        assert.equal(steps[0].escalatedToForeground, true);
        assert.equal(steps[0].backgroundFirst, true);
        assert.equal(steps[0].deliveryPolicy, "foreground");
      },
    );
  });

  test(`granted + ${mode.name} foreground_required with effectPossible true is refused without retry`, async () => {
    await withFixture(
      { grant: BUNDLE_ID },
      () => mode.refuse(true),
      async (context) => {
        const details = await actOnce(context, refTypeText);
        assert.equal(context.requests.length, 1);
        assertNoUngrantedForeground(context.requests);
        const execution = objectField(details, "execution");
        assert.equal(objectField(execution, "refusal").code, "foreground_required");
        assert.equal(objectField(execution, "refusal").effectPossible, true);
        assert.notEqual(execution.escalatedToForeground, true);
      },
    );
  });

  test(`ungranted + ${mode.name} foreground_required with effectPossible false is refused without retry`, async () => {
    await withFixture(
      {},
      () => mode.refuse(false),
      async (context) => {
        const details = await actOnce(context, refTypeText);
        assert.equal(context.requests.length, 1);
        assertNoUngrantedForeground(context.requests);
        const execution = objectField(details, "execution");
        assert.equal(objectField(execution, "refusal").effectPossible, false);
        assert.notEqual(execution.escalatedToForeground, true);
      },
    );
  });

  test(`granted retry that is refused again stops after two calls (${mode.name})`, async () => {
    await withFixture(
      { grant: BUNDLE_ID },
      () => mode.refuse(false),
      async (context) => {
        const details = await actOnce(context, refTypeText);
        assert.equal(context.requests.length, 2);
        assert.equal(context.requests[1]?.policy, "foreground");
        assert.equal(details.status, "foreground_required");
        assert.equal(
          objectField(objectField(details, "execution"), "refusal").code,
          "foreground_required",
        );
      },
    );
  });
}

test("granted + didnt is refused without retry", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    () => ({ outcome: "didnt" }),
    async (context) => {
      const details = await actOnce(context, refTypeText);
      assert.equal(context.requests.length, 1);
      assert.equal(context.requests[0]?.policy, "background");
      const execution = objectField(details, "execution");
      assert.equal(objectField(execution, "refusal").code, "foreground_required");
      assert.notEqual(execution.escalatedToForeground, true);
    },
  );
});

function assertRefTarget(request: PlatformActRequest | undefined, wireRef: string): void {
  assert.ok(request, "expected an act request");
  assert.deepEqual(request.target, { ref: wireRef }, "ref target without coordinate fields");
  assert.equal(request.focusResolution, undefined);
}

for (const outlineOnly of [false, true]) {
  const look = outlineOnly ? "outline-only" : "image-bearing";

  test(`editable ref stays a ref target (${look})`, async () => {
    await withFixture(
      { outlineOnly },
      () => ({ outcome: "worked", performed: { delivery: "ax", focused: true } }),
      async (context) => {
        const details = await actOnce(context, [{ action: "click", ref: "@e2" }]);
        assert.equal(context.requests.length, 1);
        const [request] = context.requests;
        assertRefTarget(request, "wire-field-1");
        assert.equal(request?.policy, "background");
        assert.equal(request?.foregroundGrant, undefined);
        assert.equal(details.status, "ok");
        const execution = objectField(details, "execution");
        assert.equal(execution.refusal, undefined);
        assert.equal(execution.deliveryPolicy, "background");
        assert.equal(execution.delivery, "ax");
      },
    );
  });
}

test("editable ref click stays background even when a grant covers the app", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    () => ({ outcome: "didnt" }),
    async (context) => {
      const details = await actOnce(context, [{ action: "click", ref: "@e2" }]);
      assert.equal(context.requests.length, 1, "a ref click that did not work is not retried");
      assertRefTarget(context.requests[0], "wire-field-1");
      assert.equal(context.requests[0]?.policy, "background");
      assert.equal(context.requests[0]?.foregroundGrant, undefined);
      const execution = objectField(details, "execution");
      assert.equal(execution.outcome, "didnt");
      assert.notEqual(execution.escalatedToForeground, true);
    },
  );
});

test("outline-only: click a text field, type, and press stay background ref actions", async () => {
  await withFixture(
    { outlineOnly: true },
    () => ({ outcome: "worked", performed: { delivery: "ax" } }),
    async (context) => {
      const details = await actOnce(context, [
        { action: "click", ref: "@e2" },
        { action: "typeText", text: "hello-e2e" },
        { action: "press", ref: "@e3" },
      ]);
      const [click, type, press, ...rest] = context.requests;
      assert.equal(rest.length, 0);
      assertNoUngrantedForeground(context.requests);
      assert.equal(click?.action, "click");
      assertRefTarget(click, "wire-field-1");
      assert.equal(type?.action, "typeText");
      assertRefTarget(type, "wire-field-1");
      assert.equal(press?.action, "press");
      assertRefTarget(press, "wire-button-1");
      for (const request of context.requests) assert.equal(request.policy, "background");
      assert.equal(details.status, "ok");
      const execution = objectField(details, "execution");
      assert.equal(execution.deliveryPolicy, "background");
      assert.equal(execution.delivery, "ax");
    },
  );
});

test("image-bearing: typeText after a text-field ref click keeps the focus target", async () => {
  await withFixture(
    {},
    () => ({ outcome: "worked" }),
    async (context) => {
      await actOnce(context, [
        { action: "click", ref: "@e2" },
        { action: "typeText", text: "x" },
      ]);
      const type = context.requests[1];
      assert.ok(type && "focus" in type.target);
      assert.equal(type.focusResolution, "ax_focused_element");
      assert.equal(type.policy, "background");
    },
  );
});

const customClick: UiAction[] = [{ action: "click", ref: "@e4" }];

function noteRegions(details: JsonObject): JsonObject[] {
  const regions = objectField(details, "note").regions;
  assert.ok(Array.isArray(regions));
  return regions.filter(isJsonObject);
}

test("background click on a ref without an AX action: one act and a refusal before delivery", async () => {
  await withFixture(
    {},
    (request) => {
      if (request.policy === "background")
        throw new ForegroundRequiredFixtureError(
          "target has no accessibility action; pointer delivery needs a host foreground grant",
          false,
        );
      return { outcome: "worked" };
    },
    async (context) => {
      const details = await actOnce(context, customClick);
      assert.equal(context.requests.length, 1, "no retry without a grant");
      assertNoUngrantedForeground(context.requests);
      assertRefTarget(context.requests[0], "wire-custom-1");
      assert.equal(context.requests[0]?.policy, "background");
      assert.equal(details.status, "foreground_required");
      const execution = objectField(details, "execution");
      assert.notEqual(execution.escalatedToForeground, true);
      const refusal = objectField(execution, "refusal");
      assert.equal(refusal.effectPossible, false);
      assert.equal(refusal.capability, "pointer_input");
      assert.ok(isString(refusal.grantHint) && refusal.grantHint.includes(BUNDLE_ID));
    },
  );
});

test("granted: a refused background click on a ref without an AX action retries once in foreground", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    (request) => {
      if (request.policy === "background")
        throw new ForegroundRequiredFixtureError("no accessibility action", false);
      return { outcome: "unknown", performed: { delivery: "hid", grounding: "coordinates" } };
    },
    async (context) => {
      const { details, text } = await actOnceWithText(context, customClick);
      const [first, second, ...rest] = context.requests;
      assert.equal(rest.length, 0, "at most one retry");
      assert.equal(first?.policy, "background");
      assert.equal(first?.foregroundGrant, undefined);
      assert.equal(second?.policy, "foreground");
      assert.equal(second?.foregroundGrant, true);
      assertRefTarget(second, "wire-custom-1");
      assert.equal(details.status, "ok");
      const execution = objectField(details, "execution");
      assert.equal(execution.escalatedToForeground, true);
      assert.equal(execution.outcome, "unknown");
      assert.match(text, /Effect not verified for action 1 \(click: unknown\)/);
    },
  );
});

test("a background didnt on a ref click without an AX action is refused and never retried", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    () => ({ outcome: "didnt", performed: { delivery: "pid", grounding: "coordinates" } }),
    async (context) => {
      const details = await actOnce(context, customClick);
      assert.equal(context.requests.length, 1, "a didnt proves delivery: no retry");
      assert.equal(context.requests[0]?.policy, "background");
      assert.equal(details.status, "foreground_required");
      const execution = objectField(details, "execution");
      assert.equal(execution.outcome, "didnt");
      assert.notEqual(execution.escalatedToForeground, true);
      const refusal = objectField(execution, "refusal");
      assert.equal(refusal.effectPossible, true);
      assert.equal(refusal.capability, "pointer_input");
    },
  );
});

test("an unknown outcome is not reported as a change and surfaces the step outcome", async () => {
  await withFixture(
    {},
    () => ({ outcome: "unknown", performed: { delivery: "ax", grounding: "description" } }),
    async (context) => {
      const { details, text } = await actOnceWithText(context, [{ action: "press", ref: "@e3" }]);
      assert.equal(context.requests.length, 1);
      assert.equal(details.status, "ok");
      const execution = objectField(details, "execution");
      assert.equal(execution.outcome, "unknown");
      const steps = execution.steps;
      assert.ok(Array.isArray(steps) && isJsonObject(steps[0]));
      assert.equal(steps[0].outcome, "unknown");
      assert.match(text, /Effect not verified for action 1 \(press: unknown\)/);
      const regions = noteRegions(details);
      assert.ok(
        regions.every((region) => region.detail !== "acted here"),
        "no region claims a change",
      );
      assert.ok(regions.some((region) => region.detail === "effect not verified"));
    },
  );
});

test("a worked outcome still marks the acted region changed", async () => {
  await withFixture(
    {},
    () => ({ outcome: "worked", performed: { delivery: "ax", grounding: "description" } }),
    async (context) => {
      const { details, text } = await actOnceWithText(context, [{ action: "press", ref: "@e3" }]);
      assert.doesNotMatch(text, /Effect not verified/);
      assert.ok(
        noteRegions(details).some(
          (region) => region.status === "changed" && region.detail === "acted here",
        ),
      );
    },
  );
});

test("aggregated trace has no top-level delivery policy when steps differ", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    (request) => ({
      outcome: "worked",
      performed: { delivery: request.policy === "foreground" ? "hid" : "ax" },
    }),
    async (context) => {
      const details = await actOnce(context, [
        { action: "click", ref: "@e3" },
        { action: "click", x: 100, y: 100 },
      ]);
      assert.deepEqual(
        context.requests.map((request) => request.policy),
        ["background", "foreground"],
      );
      const execution = objectField(details, "execution");
      assert.equal(execution.deliveryPolicy, undefined);
      assert.equal(execution.delivery, undefined);
      const steps = execution.steps;
      assert.ok(Array.isArray(steps) && isJsonObject(steps[0]) && isJsonObject(steps[1]));
      assert.equal(steps[0].deliveryPolicy, "background");
      assert.equal(steps[1].deliveryPolicy, "foreground");
    },
  );
});
