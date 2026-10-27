import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runComputerUseCommand } from "../extensions/computer-use.ts";
import { executeAct, executeObserve, shutdownComputerUseSession } from "../src/bridge.ts";
import { getSessionGrants } from "../src/config.ts";
import {
  GRANT_OPTION_ALWAYS,
  GRANT_OPTION_DENY,
  GRANT_OPTION_SESSION,
} from "../src/grant-prompt.ts";
import type { UiAction } from "../src/contract.ts";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "../src/json.ts";
import { restoreOutline, type LookResponse, type SerializedOutlineNode } from "../src/outline.ts";
import { replacePlatformBackendForTest } from "../src/platform/index.ts";
import type {
  ComputerUsePlatformBackend,
  HelperActResult,
  HelperRefusalEvidence,
  PlatformActRequest,
  PlatformRestoreUserFocusRequest,
  PlatformRoot,
} from "../src/platform/types.ts";
import { HelperInterruption, PlatformCommandError } from "../src/platform/types.ts";
import { createTestExtensionContext, type TestUiOptions } from "./helpers/extension-context.ts";

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

class ForegroundRequiredFixtureError extends PlatformCommandError {
  readonly code = "foreground_required";
  readonly effectPossible?: boolean;

  constructor(message: string, effectPossible?: boolean, evidence?: HelperRefusalEvidence) {
    super(message, evidence);
    this.effectPossible = effectPossible;
  }
}

function fakeBackend(
  respond: Responder,
  requests: PlatformActRequest[],
  outlineOnly = false,
  restores: PlatformRestoreUserFocusRequest[] = [],
  restoreFails = false,
  frontmost: { pid: number } = { pid: root.pid! },
  roots: PlatformRoot[] = [root],
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
      return roots;
    },
    async getFrontmost() {
      if (frontmost.pid !== root.pid)
        return { appName: "User App", pid: frontmost.pid, windowTitle: "User Window" };
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
    async restoreUserFocus(request) {
      restores.push(request);
      if (restoreFails) throw new Error("restore fixture failure");
      return { restored: true, appRestored: true, windowRestored: false, appName: "User App" };
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
  "PI_COMPUTER_USE_FOREGROUND_PROMPT",
  "PI_COMPUTER_USE_RESTORE_FOCUS",
] as const;

interface Scenario {
  grant?: string;
  deliveryPolicy?: string;
  configGrant?: string[];
  /** Observations carry no image, like a semantic (outline-only) observation. */
  outlineOnly?: boolean;
  /** Host UI for the tool context; omitted means no UI (`hasUI` false). */
  ui?: TestUiOptions;
  promptMode?: string;
  restoreFocus?: string;
  /** Initial contents of the user-level config file in the temp agent dir. */
  userConfig?: JsonObject;
  /** Make the user config directory read-only so writing the file fails. */
  readOnlyUserConfig?: boolean;
  restoreFails?: boolean;
  /** Mutable frontmost app reported by getFrontmost; defaults to the target. */
  frontmost?: { pid: number };
  /** Windows reported by listRoots; defaults to the single target window. */
  roots?: PlatformRoot[];
  headless?: boolean;
}

interface FixtureContext {
  ctx: ExtensionContext;
  signal: AbortSignal;
  requests: PlatformActRequest[];
  restores: PlatformRestoreUserFocusRequest[];
  userConfigPath: string;
  cwd: string;
}

async function withFixture<T>(
  scenario: Scenario,
  respond: Responder,
  run: (context: FixtureContext) => Promise<T>,
): Promise<T> {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const scratch = await mkdtemp(path.join(os.tmpdir(), "cu-foreground-policy-"));
  const agentDir = path.join(scratch, "agent");
  const cwd = path.join(scratch, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  const userConfigDir = path.join(agentDir, "extensions");
  const userConfigPath = path.join(userConfigDir, "pi-computer-use.json");
  if (scenario.userConfig || scenario.readOnlyUserConfig) {
    await mkdir(userConfigDir, { recursive: true });
    if (scenario.userConfig)
      await writeFile(userConfigPath, JSON.stringify(scenario.userConfig, null, 2));
    if (scenario.readOnlyUserConfig) {
      if (scenario.userConfig) await chmod(userConfigPath, 0o444);
      await chmod(userConfigDir, 0o555);
    }
  }
  if (scenario.configGrant) {
    await writeFile(
      path.join(cwd, ".pi", "computer-use.json"),
      JSON.stringify({ foreground_grant: scenario.configGrant }),
    );
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_COMPUTER_USE_HEADLESS = scenario.headless === true ? "1" : "0";
  process.env.PI_COMPUTER_USE_BROWSER_USE = "0";
  delete process.env.PI_COMPUTER_USE_EVENT_DELIVERY;
  if (scenario.deliveryPolicy === undefined) delete process.env.PI_COMPUTER_USE_DELIVERY_POLICY;
  else process.env.PI_COMPUTER_USE_DELIVERY_POLICY = scenario.deliveryPolicy;
  if (scenario.grant === undefined) delete process.env.PI_COMPUTER_USE_FOREGROUND_GRANT;
  else process.env.PI_COMPUTER_USE_FOREGROUND_GRANT = scenario.grant;
  if (scenario.promptMode === undefined) delete process.env.PI_COMPUTER_USE_FOREGROUND_PROMPT;
  else process.env.PI_COMPUTER_USE_FOREGROUND_PROMPT = scenario.promptMode;
  if (scenario.restoreFocus === undefined) delete process.env.PI_COMPUTER_USE_RESTORE_FOCUS;
  else process.env.PI_COMPUTER_USE_RESTORE_FOCUS = scenario.restoreFocus;

  const requests: PlatformActRequest[] = [];
  const restores: PlatformRestoreUserFocusRequest[] = [];
  const restoreBackend = replacePlatformBackendForTest(
    fakeBackend(
      respond,
      requests,
      scenario.outlineOnly === true,
      restores,
      scenario.restoreFails === true,
      scenario.frontmost,
      scenario.roots,
    ),
  );
  try {
    const ctx = await createTestExtensionContext(cwd, scenario.ui);
    await shutdownComputerUseSession();
    return await run({
      ctx,
      signal: new AbortController().signal,
      requests,
      restores,
      userConfigPath,
      cwd,
    });
  } finally {
    await shutdownComputerUseSession();
    restoreBackend();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (scenario.readOnlyUserConfig) await chmod(userConfigDir, 0o755);
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

test("click rejects missing, ambiguous, and partial targets before native delivery", async () => {
  await withFixture(
    {},
    () => ({ outcome: "worked" }),
    async ({ ctx, signal, requests }) => {
      const observed = await executeObserve("observe", {}, signal, undefined, ctx);
      const stateId = stateIdFromContent(observed.content);
      const invalidTargets: UiAction[] = [
        { action: "click" },
        { action: "click", ref: "@e2", x: 10, y: 20 },
        { action: "click", x: 10 },
        { action: "click", y: 20 },
      ];
      for (const action of invalidTargets) {
        await assert.rejects(
          executeAct("invalid-click", { stateId, actions: [action] }, signal, undefined, ctx),
          /click (requires exactly one target|coordinates require both x and y)/,
        );
      }
      assert.deepEqual(requests, [], "invalid clicks must not reach the native backend");
    },
  );
});

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

function assertImplicitFocusRequest(
  request: PlatformActRequest | undefined,
  action: PlatformActRequest["action"],
  focus: JsonObject,
): void {
  assert.ok(request, "expected an act request");
  assert.equal(request.action, action);
  assert.deepEqual(request.target, { focus }, "focus target, never a ref or a point");
  assert.equal(request.focusResolution, "ax_focused_element");
  assert.equal(request.policy, "background");
  assert.equal(request.foregroundGrant, undefined);
}

for (const outlineOnly of [false, true]) {
  const look = outlineOnly ? "outline-only" : "image-bearing";
  const focus: JsonObject = outlineOnly ? {} : { x: 320, y: 240 };

  test(`${look}: a first-action keypress without ref goes to the app's focused element`, async () => {
    await withFixture(
      { outlineOnly },
      () => ({ outcome: "unknown" }),
      async (context) => {
        const { details, text } = await actOnceWithText(context, [
          { action: "keypress", keys: ["option", "right"] },
        ]);
        assert.equal(context.requests.length, 1);
        const [request] = context.requests;
        assertImplicitFocusRequest(request, "keypress", focus);
        assert.ok(request?.action === "keypress");
        assert.deepEqual(request.params.keys, ["option", "right"]);
        assert.equal(details.status, "ok");
        assert.match(text, /Effect not verified for action 1 \(keypress: unknown\)/);
      },
    );
  });

  test(`${look}: a first-action typeText without ref goes to the app's focused element`, async () => {
    await withFixture(
      { outlineOnly },
      () => ({ outcome: "worked" }),
      async (context) => {
        const details = await actOnce(context, [{ action: "typeText", text: "hello" }]);
        assert.equal(context.requests.length, 1);
        const [request] = context.requests;
        assertImplicitFocusRequest(request, "typeText", focus);
        assert.ok(request?.action === "typeText");
        assert.equal(request.params.text, "hello");
        assert.equal(details.status, "ok");
      },
    );
  });
}

test("a keypress without ref stays background first under a foreground grant", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    () => ({ outcome: "unknown" }),
    async (context) => {
      await actOnce(context, [{ action: "keypress", keys: ["Enter"] }]);
      assert.equal(context.requests.length, 1);
      assertImplicitFocusRequest(context.requests[0], "keypress", { x: 320, y: 240 });
    },
  );
});

test("keyboard input with a ref keeps its ref target and no focus resolution", async () => {
  await withFixture(
    {},
    () => ({ outcome: "worked" }),
    async (context) => {
      await actOnce(context, [
        { action: "keypress", ref: "@e2", keys: ["cmd", "a"] },
        { action: "typeText", ref: "@e2", text: "x" },
      ]);
      const [keypress, type, ...rest] = context.requests;
      assert.equal(rest.length, 0);
      assert.equal(keypress?.action, "keypress");
      assertRefTarget(keypress, "wire-field-1");
      assert.equal(type?.action, "typeText");
      assertRefTarget(type, "wire-field-1");
      for (const request of context.requests) assert.equal(request.policy, "background");
    },
  );
});

const otherWindow: PlatformRoot = {
  ...root,
  rootRef: "native-root-other",
  windowRef: "native-root-other",
  windowId: 78,
  title: "Other Window",
};

test("keyboard input without ref is refused before delivery when another window holds focus", async () => {
  const roots = [{ ...root, isFocused: false, isMain: false }, otherWindow];
  await withFixture(
    { roots },
    () => ({ outcome: "worked" }),
    async (context) => {
      for (const actions of [
        [{ action: "keypress", keys: ["option", "right"] }],
        [{ action: "typeText", text: "hello" }],
        // A button press establishes no focus, so the keypress is still ref-less input.
        [
          { action: "press", ref: "@e3" },
          { action: "keypress", keys: ["Enter"] },
        ],
      ] satisfies UiAction[][]) {
        await assert.rejects(
          actOnce(context, actions),
          /goes to Foreground Fixture's focused element, which is in window "Other Window", not this state's window "Fixture Window"\. Nothing was sent\./,
        );
      }
      assert.deepEqual(context.requests, [], "nothing reaches the helper");
    },
  );
});

test("keyboard input without ref is delivered when no window reports focus or main", async () => {
  const roots = [
    { ...root, isFocused: false, isMain: false },
    { ...otherWindow, isFocused: false, isMain: false },
  ];
  await withFixture(
    { roots },
    () => ({ outcome: "unknown" }),
    async (context) => {
      await actOnce(context, [{ action: "keypress", keys: ["Enter"] }]);
      assert.equal(context.requests.length, 1);
      assertImplicitFocusRequest(context.requests[0], "keypress", { x: 320, y: 240 });
    },
  );
});

test("headless mode refuses keyboard input without ref before delivery", async () => {
  await withFixture(
    { headless: true },
    () => ({ outcome: "worked" }),
    async ({ ctx, signal, requests }) => {
      const observed = await executeObserve("observe", {}, signal, undefined, ctx);
      const stateId = stateIdFromContent(observed.content);
      for (const action of [
        { action: "keypress", keys: ["Enter"] },
        { action: "typeText", text: "hello" },
      ] satisfies UiAction[]) {
        await assert.rejects(
          executeAct("headless", { stateId, actions: [action] }, signal, undefined, ctx),
          new RegExp(
            `^Error: ${action.action} without ref is unavailable in headless mode: .* Pass the @e ref`,
          ),
        );
      }
      assert.deepEqual(requests, []);
    },
  );
});

test("keyboard actions reject x/y before delivery", async () => {
  await withFixture(
    {},
    () => ({ outcome: "worked" }),
    async ({ ctx, signal, requests }) => {
      const observed = await executeObserve("observe", {}, signal, undefined, ctx);
      const stateId = stateIdFromContent(observed.content);
      for (const action of [
        { action: "keypress", x: 10, y: 20, keys: ["Enter"] },
        { action: "keypress", ref: "@e2", x: 10, keys: ["Enter"] },
        { action: "typeText", y: 20, text: "hello" },
      ] satisfies UiAction[]) {
        await assert.rejects(
          executeAct("xy", { stateId, actions: [action] }, signal, undefined, ctx),
          new RegExp(
            `^Error: ${action.action} does not take x/y: .*Click the point first.*pass the control's ref\\.$`,
          ),
        );
      }
      assert.deepEqual(requests, []);
    },
  );
});

const customClick: UiAction[] = [{ action: "click", ref: "@e4" }];
/** A click on the AXPress button: not pointer-only, so background first even under a grant. */
const pressClick: UiAction[] = [{ action: "click", ref: "@e3" }];

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

test("granted: a click on a ref without an AX action goes to foreground directly", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    (request) => {
      if (request.policy === "background")
        throw new ForegroundRequiredFixtureError("no accessibility action", false);
      return { outcome: "unknown", performed: { delivery: "hid", grounding: "coordinates" } };
    },
    async (context) => {
      const { details, text } = await actOnceWithText(context, customClick);
      const [first, ...rest] = context.requests;
      assert.equal(rest.length, 0, "no background attempt before the granted one");
      assert.equal(first?.policy, "foreground");
      assert.equal(first?.foregroundGrant, true);
      assertRefTarget(first, "wire-custom-1");
      assert.equal(details.status, "ok");
      const execution = objectField(details, "execution");
      assert.notEqual(execution.escalatedToForeground, true);
      assert.equal(execution.outcome, "unknown");
      assert.match(text, /Effect not verified for action 1 \(click: unknown\)/);
    },
  );
});

test("a background didnt on a ref click without an AX action is refused and never retried", async () => {
  await withFixture(
    { ui: { select: forbiddenSelect() }, promptMode: "always" },
    () => ({ outcome: "didnt", performed: { delivery: "pid", grounding: "coordinates" } }),
    async (context) => {
      const details = await actOnce(context, customClick);
      assert.equal(context.requests.length, 1, "a didnt proves delivery: no retry");
      assert.equal(context.requests[0]?.policy, "background");
      assert.equal(details.status, "foreground_required");
      assert.deepEqual(getSessionGrants(), [], "a didnt never auto-grants");
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

// --- Session grants, the grant prompt, and focus restoration ---

const USER_PID = 4141;

/** Background refuses with proof of non-delivery; a granted foreground attempt works and takes focus. */
const refuseUntilGranted: Responder = (request) => {
  if (request.policy === "background")
    throw new ForegroundRequiredFixtureError("background refused", false);
  return { outcome: "worked", frontmostBefore: USER_PID, frontmostAfter: root.pid };
};

interface SelectCall {
  title: string;
  options: string[];
}

function selectStub(answer: string | undefined, calls: SelectCall[]): TestUiOptions["select"] {
  return async (title, options) => {
    calls.push({ title, options });
    return answer;
  };
}

function forbiddenSelect(): TestUiOptions["select"] {
  return async () => {
    throw new Error("no grant dialog may be shown");
  };
}

test("ask + TUI: allowing for the session retries once in foreground as user_grant, then asks no more", async () => {
  const calls: SelectCall[] = [];
  await withFixture(
    { ui: { select: selectStub(GRANT_OPTION_SESSION, calls) } },
    refuseUntilGranted,
    async (context) => {
      const details = await actOnce(context, refTypeText);
      assert.equal(calls.length, 1, "one prompt");
      assert.ok(calls[0]!.title.includes(BUNDLE_ID) && calls[0]!.title.includes(root.appName!));
      assert.ok(!calls[0]!.title.includes("background input"), "no pid attempt was reported");
      assert.deepEqual(calls[0]!.options, [
        GRANT_OPTION_SESSION,
        GRANT_OPTION_ALWAYS,
        GRANT_OPTION_DENY,
      ]);
      assert.deepEqual(
        context.requests.map((request) => [request.policy, request.foregroundGrant]),
        [
          ["background", undefined],
          ["foreground", true],
        ],
      );
      assert.equal(details.status, "ok");
      const execution = objectField(details, "execution");
      assert.equal(execution.escalatedToForeground, true);
      assert.equal(execution.escalationReason, "user_grant");
      assert.equal(
        execution.retryDeferred,
        undefined,
        "a pre-delivery refusal keeps the same-call retry",
      );
      assert.equal(details.nextStep, undefined);
      assert.equal(objectField(execution, "grantPrompt").decision, "session");
      assert.deepEqual(getSessionGrants(), [BUNDLE_ID]);

      const again = objectField(await actOnce(context, refTypeText), "execution");
      assert.equal(calls.length, 1, "the session grant covers later calls without a prompt");
      assert.equal(again.escalationReason, "foreground_required");
      assert.equal(context.requests.length, 4);
    },
  );
});

test("ask + TUI: Not now refuses without retry and is not asked again this session", async () => {
  const calls: SelectCall[] = [];
  await withFixture(
    { ui: { select: selectStub(GRANT_OPTION_DENY, calls) } },
    refuseUntilGranted,
    async (context) => {
      const first = await actOnce(context, refTypeText);
      assert.equal(calls.length, 1);
      assert.equal(context.requests.length, 1);
      assertNoUngrantedForeground(context.requests);
      assert.equal(first.status, "foreground_required");
      const execution = objectField(first, "execution");
      assert.equal(objectField(execution, "grantPrompt").decision, "denied");
      const refusal = objectField(execution, "refusal");
      assert.ok(isString(refusal.grantHint) && refusal.grantHint.includes("declined"));

      const second = await actOnce(context, refTypeText);
      assert.equal(calls.length, 1, "no second prompt for the same bundle id");
      assert.equal(context.requests.length, 2);
      assertNoUngrantedForeground(context.requests);
      assert.equal(second.status, "foreground_required");
    },
  );
});

for (const variant of [
  { name: "no UI", scenario: {} },
  { name: "rpc mode", scenario: { ui: { select: forbiddenSelect(), mode: "rpc" as const } } },
  { name: "prompt off", scenario: { ui: { select: forbiddenSelect() }, promptMode: "off" } },
]) {
  test(`no grant prompt with ${variant.name}: refused once, no retry`, async () => {
    await withFixture(variant.scenario, refuseUntilGranted, async (context) => {
      const details = await actOnce(context, refTypeText);
      assert.equal(context.requests.length, 1);
      assertNoUngrantedForeground(context.requests);
      assert.equal(details.status, "foreground_required");
      assert.deepEqual(getSessionGrants(), []);
    });
  });
}

test("effectPossible true never prompts", async () => {
  await withFixture(
    { ui: { select: forbiddenSelect() } },
    () => {
      throw new ForegroundRequiredFixtureError("maybe delivered", true);
    },
    async (context) => {
      const details = await actOnce(context, refTypeText);
      assert.equal(context.requests.length, 1);
      assert.equal(details.status, "foreground_required");
      assert.equal(objectField(details, "execution").grantPrompt, undefined);
    },
  );
});

test("Always allow saves the bundle id to the user config and keeps unrelated keys", async () => {
  const calls: SelectCall[] = [];
  await withFixture(
    {
      ui: { select: selectStub(GRANT_OPTION_ALWAYS, calls) },
      userConfig: { custom_key: "keep", cursor_overlay: false, foreground_grant: ["other.app"] },
    },
    refuseUntilGranted,
    async (context) => {
      const details = await actOnce(context, refTypeText);
      assert.equal(details.status, "ok");
      const execution = objectField(details, "execution");
      assert.equal(execution.escalationReason, "user_grant");
      const prompt = objectField(execution, "grantPrompt");
      assert.equal(prompt.decision, "always");
      assert.equal(prompt.persisted, true);
      const saved: JsonValue = JSON.parse(await readFile(context.userConfigPath, "utf-8"));
      assert.deepEqual(saved, {
        custom_key: "keep",
        cursor_overlay: false,
        foreground_grant: ["other.app", BUNDLE_ID],
      });
    },
  );
});

test("Always allow still grants for the session when saving fails and says so", async () => {
  const calls: SelectCall[] = [];
  const notices: string[] = [];
  const original = { custom_key: "keep" };
  await withFixture(
    {
      ui: {
        select: selectStub(GRANT_OPTION_ALWAYS, calls),
        notify: (message) => {
          notices.push(message);
        },
      },
      userConfig: original,
      readOnlyUserConfig: true,
    },
    refuseUntilGranted,
    async (context) => {
      const details = await actOnce(context, refTypeText);
      assert.equal(details.status, "ok");
      const execution = objectField(details, "execution");
      assert.equal(execution.escalationReason, "user_grant");
      const prompt = objectField(execution, "grantPrompt");
      assert.equal(prompt.persisted, false);
      assert.ok(isString(prompt.error) && prompt.error.length > 0);
      assert.ok(notices.some((notice) => notice.includes("this session only")));
      assert.deepEqual(getSessionGrants(), [BUNDLE_ID]);
      const saved: JsonValue = JSON.parse(await readFile(context.userConfigPath, "utf-8"));
      assert.deepEqual(saved, original, "a failed save leaves the file untouched");
    },
  );
});

/** Links the user config to a real file in a separate directory and returns that file. */
async function linkUserConfig(userConfigPath: string, content: JsonObject): Promise<string> {
  const realDir = path.join(path.dirname(path.dirname(userConfigPath)), "real-config");
  const realPath = path.join(realDir, "pi-computer-use.json");
  await mkdir(realDir, { recursive: true });
  await writeFile(realPath, JSON.stringify(content, null, 2));
  await mkdir(path.dirname(userConfigPath), { recursive: true });
  await symlink(realPath, userConfigPath);
  return realPath;
}

test("Always allow keeps a symlinked user config a symlink and writes its real file", async () => {
  const calls: SelectCall[] = [];
  await withFixture(
    { ui: { select: selectStub(GRANT_OPTION_ALWAYS, calls) } },
    refuseUntilGranted,
    async (context) => {
      const realPath = await linkUserConfig(context.userConfigPath, { custom_key: "keep" });
      const details = await actOnce(context, refTypeText);
      assert.equal(objectField(objectField(details, "execution"), "grantPrompt").persisted, true);
      assert.ok((await lstat(context.userConfigPath)).isSymbolicLink());
      const saved: JsonValue = JSON.parse(await readFile(realPath, "utf-8"));
      assert.deepEqual(saved, { custom_key: "keep", foreground_grant: [BUNDLE_ID] });
      assert.deepEqual(await readdir(path.dirname(realPath)), ["pi-computer-use.json"]);
    },
  );
});

test("Always allow: a failed temp write leaves the original config intact", async () => {
  await assertFailedTempWriteKeepsOriginal();
});

test("Always allow writes through a dangling symlinked user config and keeps the link", async () => {
  const calls: SelectCall[] = [];
  await withFixture(
    { ui: { select: selectStub(GRANT_OPTION_ALWAYS, calls) } },
    refuseUntilGranted,
    async (context) => {
      const realDir = path.join(path.dirname(path.dirname(context.userConfigPath)), "real-config");
      const realPath = path.join(realDir, "pi-computer-use.json");
      await mkdir(realDir, { recursive: true });
      await mkdir(path.dirname(context.userConfigPath), { recursive: true });
      await symlink(realPath, context.userConfigPath);
      const details = await actOnce(context, refTypeText);
      assert.equal(objectField(objectField(details, "execution"), "grantPrompt").persisted, true);
      assert.ok((await lstat(context.userConfigPath)).isSymbolicLink());
      const saved: JsonValue = JSON.parse(await readFile(realPath, "utf-8"));
      assert.deepEqual(saved, { foreground_grant: [BUNDLE_ID] });
      assert.deepEqual(await readdir(realDir), ["pi-computer-use.json"]);
    },
  );
});

async function assertFailedTempWriteKeepsOriginal(): Promise<void> {
  const calls: SelectCall[] = [];
  const original = { custom_key: "keep", foreground_grant: ["other.app"] };
  await withFixture(
    { ui: { select: selectStub(GRANT_OPTION_ALWAYS, calls) } },
    refuseUntilGranted,
    async (context) => {
      // The real file stays writable, but its directory cannot take the temp sibling.
      const realPath = await linkUserConfig(context.userConfigPath, original);
      await chmod(path.dirname(realPath), 0o555);
      try {
        const details = await actOnce(context, refTypeText);
        const execution = objectField(details, "execution");
        assert.equal(execution.escalationReason, "user_grant");
        const prompt = objectField(execution, "grantPrompt");
        assert.equal(prompt.persisted, false);
        assert.ok(isString(prompt.error) && prompt.error.includes("could not write"));
        const saved: JsonValue = JSON.parse(await readFile(realPath, "utf-8"));
        assert.deepEqual(saved, original);
        assert.deepEqual(await readdir(path.dirname(realPath)), ["pi-computer-use.json"]);
      } finally {
        await chmod(path.dirname(realPath), 0o755);
      }
    },
  );
}

for (const variant of [
  { name: "TUI", ui: { select: forbiddenSelect() } },
  { name: "non-TUI", ui: undefined },
]) {
  test(`foreground_prompt always (${variant.name}): one foreground retry as auto_grant without a dialog`, async () => {
    await withFixture(
      { ui: variant.ui, promptMode: "always" },
      refuseUntilGranted,
      async (context) => {
        const details = await actOnce(context, refTypeText);
        assert.deepEqual(
          context.requests.map((request) => request.policy),
          ["background", "foreground"],
        );
        assert.equal(context.requests[1]!.foregroundGrant, true);
        assert.equal(details.status, "ok");
        const execution = objectField(details, "execution");
        assert.equal(execution.escalationReason, "auto_grant");
        assert.equal(objectField(execution, "grantPrompt").decision, "auto");
        assert.deepEqual(getSessionGrants(), [BUNDLE_ID]);
      },
    );
  });
}

test("/computer-use grant always persists, overrides an earlier Not now, and applies to the next act without reload", async () => {
  const calls: SelectCall[] = [];
  await withFixture(
    { ui: { select: selectStub(GRANT_OPTION_DENY, calls) }, userConfig: { custom_key: 1 } },
    refuseUntilGranted,
    async (context) => {
      const denied = await actOnce(context, refTypeText);
      assert.equal(denied.status, "foreground_required");
      assert.equal(calls.length, 1);

      const result = await runComputerUseCommand("grant always", context.cwd);
      assert.equal(result.level, "info");
      assert.match(result.message, /foreground_prompt: always/);
      const saved: JsonValue = JSON.parse(await readFile(context.userConfigPath, "utf-8"));
      assert.deepEqual(saved, { custom_key: 1, foreground_prompt: "always" });

      const granted = await actOnce(context, refTypeText);
      assert.equal(calls.length, 1, "always never shows a dialog");
      assert.equal(granted.status, "ok");
      assert.equal(objectField(granted, "execution").escalationReason, "auto_grant");

      // A new session drops the session choice and grants; the saved file still applies.
      await shutdownComputerUseSession();
      const afterRestart = await actOnce(context, refTypeText);
      assert.equal(objectField(afterRestart, "execution").escalationReason, "auto_grant");
      assert.equal(calls.length, 1);

      const status = await runComputerUseCommand("", context.cwd);
      assert.match(status.message, /foreground_prompt: always/);
      assert.match(
        status.message,
        new RegExp(`session grants: ${BUNDLE_ID.replaceAll(".", "\\.")}`),
      );
      assert.match(status.message, /restore_focus: enabled/);
      const usage = await runComputerUseCommand("grant sometimes", context.cwd);
      assert.equal(usage.level, "error");
    },
  );
});

const coordinateClicks: UiAction[] = [
  { action: "click", x: 100, y: 100 },
  { action: "click", x: 110, y: 110 },
];

function grantedResponder(frontmostBefore: number, frontmostAfter: number): Responder {
  return () => ({ outcome: "worked", frontmostBefore, frontmostAfter });
}

test("after a granted batch that took focus, focus goes back to the user's app once", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    grantedResponder(USER_PID, root.pid!),
    async (context) => {
      const details = await actOnce(context, coordinateClicks);
      assert.equal(context.requests.length, 2);
      assert.equal(context.restores.length, 1);
      assert.equal(context.restores[0]!.pid, USER_PID);
      const execution = objectField(details, "execution");
      assert.equal(details.status, "ok");
      assert.equal(execution.outcome, "worked");
      assert.equal(execution.focusRestored, true);
      assert.equal(execution.focusRestoreReason, "restored");
    },
  );
});

for (const variant of [
  {
    name: "the user switched to a third app",
    respond: grantedResponder(USER_PID, 5151),
    scenario: { grant: BUNDLE_ID },
    reason: "user_switched",
  },
  {
    name: "the target was already frontmost",
    respond: grantedResponder(root.pid!, root.pid!),
    scenario: { grant: BUNDLE_ID },
    reason: "target_was_frontmost",
  },
  {
    name: "restore_focus is off",
    respond: grantedResponder(USER_PID, root.pid!),
    scenario: { grant: BUNDLE_ID, restoreFocus: "0" },
    reason: "disabled",
  },
]) {
  test(`focus is not restored when ${variant.name}`, async () => {
    await withFixture(variant.scenario, variant.respond, async (context) => {
      const details = await actOnce(context, coordinateClicks);
      assert.equal(context.restores.length, 0);
      assert.equal(details.status, "ok");
      const execution = objectField(details, "execution");
      assert.equal(execution.outcome, "worked");
      assert.equal(execution.focusRestored, false);
      assert.equal(execution.focusRestoreReason, variant.reason);
    });
  });
}

test("focus is not restored when the user switches apps after the last granted step replied", async () => {
  const frontmost = { pid: root.pid! };
  await withFixture(
    { grant: BUNDLE_ID, frontmost },
    () => {
      // The click took focus; afterwards (as during a later wait) the user moves to a third app.
      frontmost.pid = 5151;
      return { outcome: "worked", frontmostBefore: USER_PID, frontmostAfter: root.pid };
    },
    async (context) => {
      const details = await actOnce(context, [{ action: "click", x: 100, y: 100 }]);
      assert.equal(context.requests.length, 1);
      assert.equal(context.requests[0]?.foregroundGrant, true);
      assert.equal(context.restores.length, 0, "the user's new app is never overridden");
      assert.equal(details.status, "ok");
      const execution = objectField(details, "execution");
      assert.equal(execution.outcome, "worked");
      assert.equal(execution.focusRestored, false);
      assert.equal(execution.focusRestoreReason, "user_switched");
    },
  );
});

test("a failed focus restore never changes the act outcome", async () => {
  await withFixture(
    { grant: BUNDLE_ID, restoreFails: true },
    grantedResponder(USER_PID, root.pid!),
    async (context) => {
      const details = await actOnce(context, coordinateClicks);
      assert.equal(context.restores.length, 1);
      assert.equal(details.status, "ok");
      const execution = objectField(details, "execution");
      assert.equal(execution.outcome, "worked");
      assert.equal(execution.focusRestored, false);
      assert.ok(
        isString(execution.focusRestoreReason) &&
          execution.focusRestoreReason.startsWith("restore_failed"),
      );
    },
  );
});

test("background-only acts never restore focus", async () => {
  await withFixture({}, grantedResponder(USER_PID, root.pid!), async (context) => {
    const details = await actOnce(context, [{ action: "click", ref: "@e3" }]);
    assert.equal(context.restores.length, 0);
    assert.equal(objectField(details, "execution").focusRestored, undefined);
  });
});

// --- Background pid pointer attempt verified by the helper ---

const NO_CHANGE_EVIDENCE: HelperRefusalEvidence = {
  deliveryUsed: "pid_pointer",
  pidPointerAttempted: true,
  observableChange: false,
  pixelCheck: "compared",
  pixelChange: false,
};

/** Background posts by pid and observes no change; a granted foreground attempt works. */
const pidNoChangeUntilGranted: Responder = (request) => {
  if (request.policy === "background")
    throw new ForegroundRequiredFixtureError(
      "Pid-targeted pointer input produced no observable change; pointer delivery needs a host foreground grant",
      false,
      NO_CHANGE_EVIDENCE,
    );
  return { outcome: "worked", frontmostBefore: USER_PID, frontmostAfter: root.pid };
};

for (const variant of [
  { name: "a ref without an AX action", actions: customClick },
  { name: "a raw coordinate click", actions: [{ action: "click", x: 100, y: 100 }] },
] satisfies Array<{ name: string; actions: UiAction[] }>) {
  test(`pid pointer attempt that changed something on ${variant.name}: worked, no refusal, no prompt`, async () => {
    await withFixture(
      { ui: { select: forbiddenSelect() } },
      () => ({
        outcome: "worked",
        performed: { delivery: "pid", grounding: "coordinates" },
        evidence: {
          deliveryUsed: "pid_pointer",
          pidPointerAttempted: true,
          observableChange: true,
          pixelCheck: "compared",
          pixelChange: true,
        },
      }),
      async (context) => {
        const details = await actOnce(context, variant.actions);
        assert.equal(context.requests.length, 1);
        assertNoUngrantedForeground(context.requests);
        assert.equal(context.requests[0]?.policy, "background");
        assert.equal(details.status, "ok");
        const execution = objectField(details, "execution");
        assert.equal(execution.refusal, undefined);
        assert.notEqual(execution.escalatedToForeground, true);
        assert.equal(execution.grantPrompt, undefined);
        assert.equal(execution.pidPointerAttempted, true);
        const steps = execution.steps;
        assert.ok(Array.isArray(steps) && isJsonObject(steps[0]));
        assert.equal(objectField(steps[0], "evidence").deliveryUsed, "pid_pointer");
        assert.equal(objectField(steps[0], "evidence").pixelChange, true);
        assert.equal(steps[0].delivery, "pid");
      },
    );
  });
}

test("pid pointer attempt with no change: refusal carries the evidence and says so", async () => {
  await withFixture({}, pidNoChangeUntilGranted, async (context) => {
    const details = await actOnce(context, customClick);
    assert.equal(context.requests.length, 1, "no grant, no UI: no retry");
    assert.equal(details.status, "foreground_required");
    const execution = objectField(details, "execution");
    assert.equal(execution.pidPointerAttempted, true);
    const refusal = objectField(execution, "refusal");
    assert.equal(refusal.effectPossible, false);
    assert.equal(refusal.pidPointerAttempted, true);
    assert.equal(refusal.observableChange, false);
    assert.ok(isString(refusal.grantHint) && refusal.grantHint.includes("observed no change"));
    assert.equal(refusal.nextStep, "observe_then_retry");
    assert.equal(refusal.grantedForNextCall, false);
    assert.equal(details.nextStep, "observe_then_retry");
    assert.equal(execution.retryDeferred, true);
  });
});

/** A deferred refusal: one background delivery, grant recorded, observe before acting again. */
function assertDeferred(details: JsonObject, text: string, granted: boolean): void {
  assert.equal(details.status, "foreground_required");
  assert.equal(details.nextStep, "observe_then_retry");
  const execution = objectField(details, "execution");
  assert.notEqual(execution.escalatedToForeground, true);
  assert.equal(execution.retryDeferred, true);
  assert.equal(execution.retryDeferredReason, "pid_pointer_delivered_without_observable_change");
  assert.equal(execution.pidPointerAttempted, true);
  const refusal = objectField(execution, "refusal");
  assert.equal(refusal.nextStep, "observe_then_retry");
  assert.equal(refusal.grantedForNextCall, granted);
  assert.match(
    text,
    /sent to Foreground Fixture in the background and produced no observable change/,
  );
  assert.match(text, /not repeated in the foreground in this call/);
  assert.match(text, /observe_then_retry — call observe_ui/);
  if (granted) assert.match(text, /next act_ui on it uses foreground input/);
}

test("pid pointer attempt with no change: ask + TUI allow grants for the session, defers the retry, next call goes foreground", async () => {
  const calls: SelectCall[] = [];
  await withFixture(
    { ui: { select: selectStub(GRANT_OPTION_SESSION, calls) } },
    pidNoChangeUntilGranted,
    async (context) => {
      const { details, text } = await actOnceWithText(context, [
        { action: "click", x: 100, y: 100 },
      ]);
      assert.equal(calls.length, 1, "one prompt");
      const title = calls[0]!.title;
      assert.ok(
        title.includes("already sent this click") && title.includes("saw no visible change"),
        "the prompt says a background attempt was sent and showed nothing",
      );
      assert.ok(
        title.includes("not sent again now"),
        "the prompt says allowing does not repeat it",
      );
      assert.deepEqual(
        context.requests.map((request) => [request.policy, request.foregroundGrant]),
        [["background", undefined]],
        "no second delivery in the same call",
      );
      assertDeferred(details, text, true);
      assert.equal(
        objectField(objectField(details, "execution"), "grantPrompt").decision,
        "session",
      );
      assert.deepEqual(getSessionGrants(), [BUNDLE_ID]);

      const next = await actOnce(context, [{ action: "click", x: 100, y: 100 }]);
      assert.equal(calls.length, 1, "no second prompt");
      assert.deepEqual(
        context.requests.map((request) => [request.policy, request.foregroundGrant]),
        [
          ["background", undefined],
          ["foreground", true],
        ],
        "the next call goes to foreground directly",
      );
      assert.equal(next.status, "ok");
    },
  );
});

for (const variant of [
  { name: "a ref without an AX action", actions: customClick },
  { name: "a coordinate scroll", actions: [{ action: "scroll", x: 100, y: 100, scrollY: 3 }] },
] satisfies Array<{ name: string; actions: UiAction[] }>) {
  test(`pid pointer attempt with no change on ${variant.name}: always grants, defers the retry, next call goes foreground`, async () => {
    await withFixture(
      { ui: { select: forbiddenSelect() }, promptMode: "always" },
      pidNoChangeUntilGranted,
      async (context) => {
        const { details, text } = await actOnceWithText(context, variant.actions);
        assert.deepEqual(
          context.requests.map((request) => request.policy),
          ["background"],
          "no second delivery in the same call",
        );
        assertDeferred(details, text, true);
        assert.equal(
          objectField(objectField(details, "execution"), "grantPrompt").decision,
          "auto",
        );
        assert.deepEqual(getSessionGrants(), [BUNDLE_ID]);

        const next = await actOnce(context, variant.actions);
        assert.deepEqual(
          context.requests.map((request) => [request.policy, request.foregroundGrant]),
          [
            ["background", undefined],
            ["foreground", true],
          ],
        );
        assert.equal(next.status, "ok");
        assert.notEqual(objectField(next, "execution").escalatedToForeground, true);
      },
    );
  });
}

test("pid pointer attempt with no change: Not now defers with no grant and says so", async () => {
  const calls: SelectCall[] = [];
  await withFixture(
    { ui: { select: selectStub(GRANT_OPTION_DENY, calls) } },
    pidNoChangeUntilGranted,
    async (context) => {
      const { details, text } = await actOnceWithText(context, customClick);
      assert.equal(calls.length, 1);
      assert.equal(context.requests.length, 1);
      assertDeferred(details, text, false);
      assert.deepEqual(getSessionGrants(), []);
    },
  );
});

test("Always allow after a pid attempt persists the grant without a same-call retry", async () => {
  const calls: SelectCall[] = [];
  await withFixture(
    { ui: { select: selectStub(GRANT_OPTION_ALWAYS, calls) } },
    pidNoChangeUntilGranted,
    async (context) => {
      const { details, text } = await actOnceWithText(context, customClick);
      assert.equal(context.requests.length, 1);
      assertDeferred(details, text, true);
      const prompt = objectField(objectField(details, "execution"), "grantPrompt");
      assert.equal(prompt.decision, "always");
      assert.equal(prompt.persisted, true);
      const saved: JsonValue = JSON.parse(await readFile(context.userConfigPath, "utf-8"));
      assert.deepEqual(saved, { foreground_grant: [BUNDLE_ID] });
    },
  );
});

test("a covering grant sends a pointer-only click to foreground with no background attempt", async () => {
  await withFixture({ grant: BUNDLE_ID }, pidNoChangeUntilGranted, async (context) => {
    const details = await actOnce(context, customClick);
    assert.deepEqual(
      context.requests.map((request) => request.policy),
      ["foreground"],
    );
    assert.equal(details.status, "ok");
    assert.equal(objectField(details, "execution").pidPointerAttempted, undefined);
  });
});

for (const variant of [
  // AXPress ref: background first even under a grant, as the helper decides.
  { name: "a covering grant", scenario: { grant: BUNDLE_ID }, actions: pressClick },
  { name: "ask + TUI", scenario: { ui: { select: forbiddenSelect() } }, actions: customClick },
  { name: "foreground_prompt always", scenario: { promptMode: "always" }, actions: customClick },
] satisfies Array<{ name: string; scenario: Scenario; actions: UiAction[] }>) {
  test(`inconsistent evidence (effectPossible false, observableChange true) never retries with ${variant.name}`, async () => {
    await withFixture(
      variant.scenario,
      (request) => {
        if (request.policy === "background")
          throw new ForegroundRequiredFixtureError("inconsistent", false, {
            pidPointerAttempted: true,
            observableChange: true,
          });
        return { outcome: "worked" };
      },
      async (context) => {
        const details = await actOnce(context, variant.actions);
        assert.equal(context.requests.length, 1, "no retry");
        assertNoUngrantedForeground(context.requests);
        assert.deepEqual(getSessionGrants(), [], "no auto grant");
        const refusal = objectField(objectField(details, "execution"), "refusal");
        assert.equal(refusal.effectPossible, true, "a possible effect is reported");
      },
    );
  });
}

test("a returned (batch-step style) no-change refusal under a covering grant is deferred, not retried", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    (request) =>
      request.policy === "background"
        ? {
            outcome: "didnt",
            error: {
              code: "foreground_required",
              message: "no observable change",
              effectPossible: false,
              evidence: NO_CHANGE_EVIDENCE,
            },
          }
        : { outcome: "worked" },
    async (context) => {
      // The outline shows AXPress, so the bridge sends background first; the
      // helper still reports a delivered pid attempt (stale outline).
      const { details, text } = await actOnceWithText(context, pressClick);
      assert.deepEqual(
        context.requests.map((request) => request.policy),
        ["background"],
      );
      assertDeferred(details, text, true);
    },
  );
});

// ---- Batch failures: validate before delivery, report partial delivery ----

/** A helper command failure that is not a refusal or an interruption. */
class HelperFailureFixtureError extends PlatformCommandError {
  readonly effectPossible?: boolean;

  constructor(message: string, code: string, effectPossible?: boolean) {
    super(message, undefined, code);
    this.effectPossible = effectPossible;
  }
}

/** A transport error carrying a helper interruption, as the macOS client raises them. */
class InterruptionFixtureError extends PlatformCommandError {
  readonly interruption: HelperInterruption;

  constructor(interruption: HelperInterruption) {
    super("Helper request interrupted.");
    this.interruption = interruption;
  }
}

/** Answers "worked" except for the 1-based \`failAt\` call, which throws \`error\`. */
function failingResponder(
  failAt: number,
  error: () => Error,
  ok: Responder = () => ({ outcome: "worked" }),
): Responder {
  let calls = 0;
  return (request) => {
    calls += 1;
    if (calls === failAt) throw error();
    return ok(request);
  };
}

async function observeStateId(context: FixtureContext): Promise<string> {
  const observed = await executeObserve("observe", {}, context.signal, undefined, context.ctx);
  return stateIdFromContent(observed.content);
}

async function actOnState(
  context: FixtureContext,
  stateId: string,
  actions: UiAction[],
): Promise<{ details: JsonObject; text: string }> {
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

async function assertBaseStale(context: FixtureContext, stateId: string): Promise<void> {
  await assert.rejects(
    actOnState(context, stateId, [{ action: "setText", ref: "@e2", text: "again" }]),
    /observation_refresh_required.*"reason":"stale"/,
  );
}

async function assertBaseValid(context: FixtureContext, stateId: string): Promise<void> {
  const again = await actOnState(context, stateId, [
    { action: "setText", ref: "@e2", text: "again" },
  ]);
  assert.equal(again.details.status, "ok", "the base state still accepts actions");
}

function stepsOf(execution: JsonObject): JsonObject[] {
  const steps = execution.steps;
  assert.ok(Array.isArray(steps), "execution.steps");
  return steps.map((step) => {
    assert.ok(isJsonObject(step));
    return step;
  });
}

const setFirst: UiAction = { action: "setText", ref: "@e2", text: "a" };

for (const [name, failing, message] of [
  [
    "an unknown ref",
    { action: "press", ref: "@e99" },
    /Outline ref '@e99' is stale or not available/,
  ],
  [
    "out-of-image coordinates",
    { action: "click", x: 9999, y: 1 },
    /Coordinates \(9999,1\) are outside the latest look image bounds \(640x480\)/,
  ],
  [
    "a scroll without target",
    { action: "scroll", scrollY: 3 },
    /scroll requires either ref or both x and y\./,
  ],
  [
    "a one-point drag",
    { action: "drag", path: [{ x: 1, y: 1 }] },
    /drag\.path must contain at least two points\./,
  ],
  [
    "a keypress without keys",
    { action: "keypress", ref: "@e2", keys: [] },
    /keypress\.keys must contain at least one key\./,
  ],
] satisfies Array<[string, UiAction, RegExp]>) {
  test(`batch: ${name} at action 2 is rejected before action 1 is sent`, async () => {
    await withFixture(
      {},
      () => ({ outcome: "worked" }),
      async (context) => {
        const stateId = await observeStateId(context);
        await assert.rejects(actOnState(context, stateId, [setFirst, failing]), (error: Error) => {
          assert.match(error.message, new RegExp(`^act_ui action 2 \\(${failing.action}\\): `));
          assert.match(error.message, message, "the original message follows the prefix");
          assert.match(error.message, / Nothing was sent\.$/);
          return true;
        });
        assert.deepEqual(context.requests, [], "action 1 was not sent");
        await assertBaseValid(context, stateId);
      },
    );
  });
}

test("batch: a single invalid action keeps its original message", async () => {
  await withFixture(
    {},
    () => ({ outcome: "worked" }),
    async (context) => {
      const stateId = await observeStateId(context);
      await assert.rejects(
        actOnState(context, stateId, [{ action: "press", ref: "@e99" }]),
        /^Error: Outline ref '@e99' is stale or not available/,
      );
      assert.deepEqual(context.requests, []);
    },
  );
});

test("batch: outline-only coordinates at action 2 are rejected before action 1 is sent", async () => {
  await withFixture(
    { outlineOnly: true },
    () => ({ outcome: "worked" }),
    async (context) => {
      const stateId = await observeStateId(context);
      await assert.rejects(
        actOnState(context, stateId, [setFirst, { action: "click", x: 10, y: 10 }]),
        /^Error: act_ui action 2 \(click\): Coordinates require an image-bearing root\..* Nothing was sent\.$/,
      );
      assert.deepEqual(context.requests, []);
      await assertBaseValid(context, stateId);
    },
  );
});

test("batch: headless keyboard input without ref at action 2 is rejected before action 1", async () => {
  await withFixture(
    { headless: true },
    () => ({ outcome: "worked" }),
    async (context) => {
      const stateId = await observeStateId(context);
      await assert.rejects(
        actOnState(context, stateId, [setFirst, { action: "keypress", keys: ["Enter"] }]),
        /^Error: act_ui action 2 \(keypress\): keypress without ref is unavailable in headless mode: .* Nothing was sent\.$/,
      );
      assert.deepEqual(context.requests, []);
    },
  );
});

test("batch: a helper failure at action 2 returns a partial successor state", async () => {
  await withFixture(
    {},
    failingResponder(2, () => new HelperFailureFixtureError("element vanished", "invalid_args")),
    async (context) => {
      const stateId = await observeStateId(context);
      const { details, text } = await actOnState(context, stateId, [
        setFirst,
        { action: "press", ref: "@e3" },
        { action: "setText", ref: "@e2", text: "never" },
      ]);
      assert.equal(context.requests.length, 2, "action 3 was not sent");
      assert.equal(details.status, "partial");
      const execution = objectField(details, "execution");
      assert.equal(execution.stoppedAt, 1);
      assert.equal(execution.actionCount, 2);
      assert.equal(execution.outcome, "unknown");
      assert.deepEqual(execution.error, {
        code: "invalid_args",
        message: "element vanished",
        effectPossible: true,
      });
      const [delivered, failed, ...rest] = stepsOf(execution);
      assert.equal(rest.length, 0);
      assert.equal(delivered?.outcome, "worked");
      assert.equal(delivered?.requestId, context.requests[0]?.requestId);
      assert.equal(failed?.outcome, "unknown");
      assert.equal(failed?.requestId, context.requests[1]?.requestId);
      assert.equal(failed?.deliveryPolicy, context.requests[1]?.policy);
      assert.deepEqual(failed?.error, execution.error);
      const successor = objectField(details, "capture").stateId;
      assert.ok(isString(successor) && successor !== stateId, "a fresh successor state");
      assert.equal(details.baseStateId, stateId);
      assert.match(
        text,
        /^act_ui stopped at action 2 \(press\) in Foreground Fixture — Fixture Window: element vanished\. Action 1 was delivered; action 2 \(press\) may have reached the app; later actions were not sent\. Returned state [0-9a-f-]{36}\./,
      );
      assert.match(text, /Effect not verified for action 2 \(press: unknown\)/);
      await assertBaseStale(context, stateId);
      assert.ok(isString(successor));
      const next = await actOnState(context, successor, [
        { action: "setText", ref: "@e2", text: "b" },
      ]);
      assert.equal(next.details.status, "ok", "the successor state accepts actions");
    },
  );
});

test("batch: a failure that proves no delivery reports the failed action as didnt", async () => {
  await withFixture(
    {},
    failingResponder(2, () => new HelperFailureFixtureError("look expired", "stale_look", false)),
    async (context) => {
      const stateId = await observeStateId(context);
      const { details, text } = await actOnState(context, stateId, [
        setFirst,
        { action: "press", ref: "@e3" },
      ]);
      assert.equal(details.status, "partial");
      const execution = objectField(details, "execution");
      assert.equal(execution.outcome, "didnt");
      assert.equal(stepsOf(execution)[1]?.outcome, "didnt");
      assert.deepEqual(execution.error, {
        code: "stale_look",
        message: "look expired",
        effectPossible: false,
      });
      assert.match(text, /action 2 \(press\) delivered nothing; later actions were not sent\./);
      await assertBaseStale(context, stateId);
    },
  );
});

test("batch: a helper failure at action 1 still throws, with nothing earlier sent", async () => {
  await withFixture(
    {},
    failingResponder(1, () => new HelperFailureFixtureError("element vanished", "invalid_args")),
    async (context) => {
      const stateId = await observeStateId(context);
      await assert.rejects(
        actOnState(context, stateId, [{ action: "press", ref: "@e3" }, setFirst]),
        { message: "element vanished" },
      );
      assert.equal(context.requests.length, 1);
      await assertBaseStale(context, stateId);
    },
  );
});

test("batch: focus is restored after granted input when a later action fails", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    failingResponder(
      2,
      () => new HelperFailureFixtureError("element vanished", "invalid_args"),
      grantedResponder(USER_PID, root.pid!),
    ),
    async (context) => {
      const stateId = await observeStateId(context);
      const { details } = await actOnState(context, stateId, coordinateClicks);
      assert.equal(details.status, "partial");
      assert.equal(context.restores.length, 1);
      assert.equal(context.restores[0]!.pid, USER_PID);
      const execution = objectField(details, "execution");
      assert.equal(execution.focusRestored, true);
      assert.equal(execution.focusRestoreReason, "restored");
    },
  );
});

test("batch: focus is not restored while an interrupted request may still deliver", async () => {
  await withFixture(
    { grant: BUNDLE_ID },
    failingResponder(
      2,
      () =>
        new InterruptionFixtureError(
          new HelperInterruption({
            code: "cancelled",
            cancel: { acknowledged: true, state: "stopping" },
            clientTimeout: true,
          }),
        ),
      grantedResponder(USER_PID, root.pid!),
    ),
    async (context) => {
      const stateId = await observeStateId(context);
      const { details, text } = await actOnState(context, stateId, coordinateClicks);
      assert.equal(details.status, "cancelled");
      assert.equal(context.restores.length, 0, "no focus restore while delivery may continue");
      const execution = objectField(details, "execution");
      assert.equal(execution.focusRestored, false);
      assert.equal(execution.focusRestoreReason, "delivery_may_continue");
      assert.equal(execution.stoppedAt, 1);
      assert.equal(execution.outcome, "partial");
      assert.equal(stepsOf(execution).length, 1);
      assert.match(text, /Action 1 was delivered before the interruption/);
      await assertBaseStale(context, stateId);
    },
  );
});

test("batch: a cancel that rejected action 2 before delivery still reports action 1", async () => {
  await withFixture(
    {},
    failingResponder(
      2,
      () =>
        new InterruptionFixtureError(
          new HelperInterruption({
            code: "cancelled",
            effectPossible: false,
            result: { outcome: "rejected_before_delivery" },
          }),
        ),
    ),
    async (context) => {
      const stateId = await observeStateId(context);
      const { details, text } = await actOnState(context, stateId, [
        setFirst,
        { action: "press", ref: "@e3" },
      ]);
      assert.equal(details.status, "cancelled");
      const execution = objectField(details, "execution");
      assert.equal(execution.outcome, "partial");
      assert.equal(execution.effectPossible, true);
      assert.equal(execution.stoppedAt, 1);
      const [delivered, ...rest] = stepsOf(execution);
      assert.equal(rest.length, 0);
      assert.equal(delivered?.requestId, context.requests[0]?.requestId);
      assert.match(text, /Action 1 was delivered before the interruption; call observe_ui/);
      await assertBaseStale(context, stateId);
    },
  );
});

test("batch: a cancel of action 1 is reported as before", async () => {
  await withFixture(
    {},
    failingResponder(
      1,
      () =>
        new InterruptionFixtureError(
          new HelperInterruption({
            code: "cancelled",
            effectPossible: false,
            result: { outcome: "rejected_before_delivery", stoppedAt: 0 },
          }),
        ),
    ),
    async (context) => {
      const stateId = await observeStateId(context);
      const { details } = await actOnState(context, stateId, [setFirst]);
      assert.equal(details.status, "cancelled");
      const execution = objectField(details, "execution");
      assert.equal(execution.outcome, "rejected_before_delivery");
      assert.equal(execution.effectPossible, false);
      assert.equal(execution.stoppedAt, 0);
      assert.equal(execution.steps, undefined);
      await assertBaseValid(context, stateId);
    },
  );
});

for (const [name, failAt, effectPossible, stale] of [
  ["after a delivered action", 2, false, true],
  ["at action 1 when it may have taken effect", 1, true, true],
  ["at action 1 when it proved no delivery", 1, false, false],
] satisfies Array<[string, number, boolean, boolean]>) {
  test(`batch: foreground_required ${name} ${stale ? "invalidates" : "keeps"} the base state`, async () => {
    await withFixture(
      {},
      failingResponder(
        failAt,
        () => new ForegroundRequiredFixtureError("needs foreground", effectPossible),
      ),
      async (context) => {
        const stateId = await observeStateId(context);
        const actions: UiAction[] =
          failAt === 2
            ? [setFirst, { action: "click", ref: "@e3" }]
            : [{ action: "click", ref: "@e3" }];
        const { details } = await actOnState(context, stateId, actions);
        assert.equal(details.status, "foreground_required");
        assert.equal(objectField(details, "execution").stoppedAt, failAt - 1);
        if (stale) await assertBaseStale(context, stateId);
        else await assertBaseValid(context, stateId);
      },
    );
  });
}

test("batch: up-front preparation keeps the same-call focus routes", async () => {
  for (const outlineOnly of [false, true]) {
    await withFixture(
      { outlineOnly },
      () => ({ outcome: "worked" }),
      async (context) => {
        await actOnce(context, [
          { action: "click", ref: "@e2" },
          { action: "typeText", text: "x" },
          { action: "keypress", keys: ["Enter"] },
        ]);
        const [click, type, key, ...rest] = context.requests;
        assert.equal(rest.length, 0);
        assertRefTarget(click, "wire-field-1");
        for (const request of [type, key]) {
          assert.ok(request);
          if (outlineOnly) {
            assertRefTarget(request, "wire-field-1");
          } else {
            assert.deepEqual(request.target, { focus: { x: 320, y: 240 } });
            assert.equal(request.focusResolution, "ax_focused_element");
          }
          assert.equal(request.policy, "background");
        }
      },
    );
  }
});
