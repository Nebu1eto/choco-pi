import { appendFile, mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";

export const FAKE_SCRIPTS = [
  "s1-ok",
  "s2-foreground-required",
  "s3-didnt",
  "s4-slow-type",
  "s5-stale",
  "s6-grant",
  "s7-ownership",
  "s8-foreground-not-acquired",
  "s9-foreground-lost",
  "s10-pid-unknown",
] as const;
export type FakeScript = (typeof FAKE_SCRIPTS)[number];

export interface FakeHelperDaemonOptions {
  socketPath: string;
  script: FakeScript | string;
  logPath?: string;
  executablePath?: string;
  initialProtocolVersion?: number;
  relaunchProtocolVersion?: number;
  initialStartedAt?: number | null;
  slowChunkMs?: number;
  slowHoldMs?: number;
  deadlineOverrunMs?: number;
  cancelBlockMs?: number;
  pidSettleHoldMs?: number;
  ownerTtlMs?: number;
  sessionModel?: "single" | "multi";
  actHoldMs?: number;
  coordinationWaitMs?: number;
  foregroundSectionIdleMs?: number;
  foregroundSectionRestoreMs?: number;
  refusalActivates?: boolean;
  secondTarget?: boolean;
  foregroundHoldMs?: number;
  targetKeyWindowId?: number;
  userApp?: FakeUserApp;
  realOwner?: "window" | "element";
  dropForegroundActConnection?: boolean;
  setTextValueOnly?: boolean;
  extendedDelivery?: "available" | "unavailable";
  extendedAnswer?:
    | "unknown"
    | "foreground_required"
    | "foreground_required_bare"
    | "didnt"
    | "ending"
    | "key_window_refusal"
    | "key_window_unresolved";
  offSpace?: "resolved" | "never_shown";
}

export interface FakeHelperDaemon {
  readonly socketPath: string;
  readonly script: FakeScript;
  readonly requests: JsonObject[];
  readonly actSpans: JsonObject[];
  offSpaceDiscoveries(): number;
  foregroundSectionHolder(): string | undefined;
  setProtocolVersion(version: number): void;
  close(): Promise<void>;
}

export const FAKE_PROTOCOL_VERSION = 8;
export const FAKE_APP = {
  appName: "CU Fixture Target",
  bundleId: "com.choco-pi.FocusFixture",
  pid: 4242,
};
export const FAKE_APP_B = {
  appName: "Second Fixture",
  bundleId: "com.choco-pi.FocusFixture",
  pid: 4343,
};
export const FAKE_WINDOW_TITLE = "CU Fixture Target";
export const FAKE_WINDOW_TITLE_B = "Second Fixture Window";
export const CUSTOM_VIEW_REF = "custom-1";
export const CUSTOM_VIEW_NAME = "Custom View";
export const SHUTDOWN_DEADLINE_MS = 250;
const CLIENT_COMMAND_TIMEOUT_MS = 15_000;

export function defaultSlowHoldMs(text: string): number {
  return Math.max(CLIENT_COMMAND_TIMEOUT_MS, text.length * 25 + 6_000) + 10_000;
}
export const TERMINAL_USER_APP = { appName: "Terminal", bundleId: "com.apple.Terminal", pid: 4141 };
export const NEUTRAL_USER_APP = {
  appName: "Notes Fake",
  bundleId: "com.example.user-app",
  pid: 4141,
};
const USER_WINDOW_TITLES = { terminal: "Terminal", neutral: "Notes Fake Window" } as const;
export type FakeUserApp = keyof typeof USER_WINDOW_TITLES;
export const USER_WINDOW_ID = 7;
const WINDOW_ID = 41;
const WINDOW_ID_B = 43;
interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}
const INITIAL_FRAME: Frame = { x: 0, y: 0, w: 640, h: 480 };
export const RESIZED_FRAME: Frame = { x: 40, y: 30, w: 560, h: 452 };
const PRESSABLE_REFS = new Set(["button-1"]);
const TEXT_REFS = new Set(["field-1"]);
const NO_AX_ACTION_REASON =
  "target has no accessibility action; pointer delivery needs a host foreground grant";
export const PID_NO_CHANGE_REASON =
  "Pid-targeted pointer input produced no observable change; pointer delivery needs a host foreground grant";
export const PID_OUTSIDE_TARGET_EVIDENCE = {
  deliveryUsed: "pid_pointer",
  pidPointerAttempted: true,
  observableChange: false,
  pixelCheck: "compared",
  pixelChange: false,
  pixelChangeOutsideTarget: true,
  pixelRegion: "element",
  changeOutsideTarget: true,
} as const;

function framesDiffer(left: Frame, right: Frame): boolean {
  return (
    Math.abs(left.x - right.x) > 1 ||
    Math.abs(left.y - right.y) > 1 ||
    Math.abs(left.w - right.w) > 1 ||
    Math.abs(left.h - right.h) > 1
  );
}
const ROOT_REF = "fake-root-1";
const ROOT_REF_B = "fake-root-2";
const OWNER_TTL_MS = 30_000;
const TOMBSTONE_TTL_MS = 60_000;
const TOMBSTONE_LIMIT = 256;
const TYPE_CHUNK_CHARS = 4;
const OWNER_GATED = new Set([
  "act",
  "actBatch",
  "focusWindow",
  "setWindowFrame",
  "beginInputSuppression",
  "endInputSuppression",
  "restoreUserFocus",
  "foregroundSection",
]);

export function resolveFakeScript(name: string): FakeScript {
  const normalized = name.trim().toLowerCase();
  const match = FAKE_SCRIPTS.find(
    (script) => script === normalized || script.split("-")[0] === normalized,
  );
  if (!match) throw new Error(`Unknown fake helper script '${name}'.`);
  return match;
}

class FakeFailure extends Error {
  readonly code: string;
  readonly effectPossible?: boolean;
  readonly result?: JsonObject;
  readonly details?: JsonObject;

  constructor(
    code: string,
    message: string,
    effectPossible?: boolean,
    result?: JsonObject,
    details?: JsonObject,
  ) {
    super(message);
    this.code = code;
    this.effectPossible = effectPossible;
    this.result = result;
    this.details = details;
  }
}

interface Session {
  id: string;
  generation: number;
}

interface Tracked {
  cancelled: boolean;
  stopped: boolean;
  effect: boolean;
  step: number;
  deadlineMs?: number;
  session?: Session;
  wake?: () => void;
}

function stringField(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return isString(value) ? value : undefined;
}

function numberField(record: JsonObject, key: string): number | undefined {
  const value = record[key];
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}

function objectField(record: JsonObject, key: string): JsonObject {
  const value = record[key];
  return isJsonObject(value) ? value : {};
}

function sessionOf(request: JsonObject): Session | undefined {
  const actions = request.actions;
  const first = Array.isArray(actions) && isJsonObject(actions[0]) ? actions[0] : undefined;
  const raw = isJsonObject(request.session)
    ? request.session
    : first && isJsonObject(first.session)
      ? first.session
      : undefined;
  if (!raw || !isString(raw.id) || raw.id.length === 0) return undefined;
  return { id: raw.id, generation: numberField(raw, "generation") ?? 0 };
}

function isGrantedHidRequest(request: JsonObject): boolean {
  return (
    request.policy === "foreground" &&
    request.foregroundGrant === true &&
    objectField(request, "params").delivery !== "pid"
  );
}

class FakeHelperState {
  readonly script: FakeScript;
  private protocolVersion: number;
  private readonly relaunchProtocolVersion: number;
  private startedAt?: number;
  private readonly executablePath?: string;
  private readonly slowChunkMs: number;
  private readonly slowHoldMs?: number;
  private readonly deadlineOverrunMs: number;
  private readonly cancelBlockMs: number;
  private readonly pidSettleHoldMs: number;
  private readonly ownerTtlMs: number;
  private readonly refusalActivates: boolean;
  private readonly secondTarget: boolean;
  private readonly foregroundHoldMs: number;
  private readonly targetKeyWindowId?: number;
  private readonly realOwner?: "window" | "element";
  private readonly setTextValueOnly: boolean;
  private readonly extendedDelivery?: "available" | "unavailable";
  private readonly extendedAnswer: NonNullable<FakeHelperDaemonOptions["extendedAnswer"]>;
  private readonly offSpace?: "resolved" | "never_shown";
  private offSpaceExposed = false;
  offSpaceDiscoveries = 0;
  private owner?: Session & { lastSeen: number };
  private ownerActive = 0;
  private readonly multi: boolean;
  private readonly sessions = new Map<
    string,
    { generation: number; lastSeen: number; active: number }
  >();
  private sessionlessActive = 0;
  private readonly lookOwners = new Map<string, string | undefined>();
  private readonly lookGenerations = new Map<string, number>();
  private readonly lookSessionGenerations = new Map<string, number>();
  private readonly targetHolders = new Map<number, string>();
  private section?: {
    holder: string;
    explicit: boolean;
    lastSeen: number;
    active: number;
    targets: Set<number>;
    userApp?: typeof FAKE_APP;
    acquireIds?: Set<string>;
    restoring?: boolean;
  };
  private readonly pendingAcquires = new Set<string>();
  private readonly cancelledAcquires = new Map<string, number>();
  private readonly sectionRestoreMs: number;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly actHoldMs: number;
  private readonly coordinationWaitMs: number;
  private readonly sectionIdleMs: number;
  readonly actSpans: JsonObject[] = [];
  private readonly active = new Map<string, Tracked>();
  private readonly completed: { id: string; sessionId?: string }[] = [];
  private readonly tombstones: { id: string; at: number; sessionId?: string }[] = [];
  private readonly lookApps = new Map<string, number>();
  private lookCount = 0;
  private lookSequence = 0;
  private generation = 1;
  private readonly validLooks = new Set<string>();
  private frame: Frame = INITIAL_FRAME;
  private readonly lookFrames = new Map<string, Frame>();
  private fieldValue = "";
  private pressCount = 0;
  private readonly userApp: typeof FAKE_APP;
  private readonly userWindowTitle: string;
  private frontmost: typeof FAKE_APP;
  private pendingDelta = false;

  constructor(options: FakeHelperDaemonOptions) {
    this.script = resolveFakeScript(options.script);
    this.protocolVersion = options.initialProtocolVersion ?? FAKE_PROTOCOL_VERSION;
    this.relaunchProtocolVersion = options.relaunchProtocolVersion ?? FAKE_PROTOCOL_VERSION;
    this.startedAt =
      options.initialStartedAt === null
        ? undefined
        : (options.initialStartedAt ?? Date.now() / 1000);
    this.executablePath = options.executablePath;
    this.slowChunkMs = options.slowChunkMs ?? 5_000;
    this.slowHoldMs = options.slowHoldMs;
    this.deadlineOverrunMs = options.deadlineOverrunMs ?? 0;
    this.cancelBlockMs = options.cancelBlockMs ?? 0;
    this.pidSettleHoldMs = options.pidSettleHoldMs ?? 0;
    this.ownerTtlMs = options.ownerTtlMs ?? OWNER_TTL_MS;
    this.multi = (options.sessionModel ?? "multi") === "multi" && this.script !== "s7-ownership";
    this.actHoldMs = options.actHoldMs ?? 0;
    this.coordinationWaitMs = options.coordinationWaitMs ?? 10_000;
    this.sectionIdleMs = options.foregroundSectionIdleMs ?? 10_000;
    this.sectionRestoreMs = options.foregroundSectionRestoreMs ?? 30;
    this.refusalActivates = options.refusalActivates ?? true;
    this.secondTarget = options.secondTarget === true;
    this.foregroundHoldMs = options.foregroundHoldMs ?? 0;
    this.targetKeyWindowId = options.targetKeyWindowId;
    this.realOwner = options.realOwner;
    this.setTextValueOnly = options.setTextValueOnly === true;
    this.extendedDelivery = options.extendedDelivery;
    this.extendedAnswer = options.extendedAnswer ?? "unknown";
    this.offSpace = options.offSpace;
    this.offSpaceExposed = options.offSpace === "resolved";
    const user = options.userApp ?? "terminal";
    this.userApp = user === "neutral" ? NEUTRAL_USER_APP : TERMINAL_USER_APP;
    this.userWindowTitle = USER_WINDOW_TITLES[user];
    this.frontmost = this.userApp;
  }

  async handle(request: JsonObject, connectionClosed?: () => boolean): Promise<JsonValue> {
    const cmd = stringField(request, "cmd") ?? "";
    const session = sessionOf(request);
    const gated = OWNER_GATED.has(cmd);
    if (gated) this.authorize(session, true);
    else if (session) this.refresh(session);
    if (session && this.multi) this.noteLookSession(session);
    try {
      return await this.dispatch(cmd, request, session, connectionClosed);
    } finally {
      if (gated) this.endOwned(session);
      this.armExpiry();
    }
  }

  private armExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (!this.multi || this.stopped) return;
    const due: number[] = [];
    const section = this.section;
    if (section?.explicit && !section.restoring && section.active === 0)
      due.push(section.lastSeen + this.sectionIdleMs);
    for (const entry of this.sessions.values())
      if (entry.active === 0) due.push(entry.lastSeen + this.ownerTtlMs);
    if (due.length === 0) return;
    const delay = Math.max(0, Math.min(...due) - Date.now()) + 5;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.pruneSessions();
      this.expireIdleSection();
      this.armExpiry();
    }, delay);
    this.expiryTimer.unref?.();
  }

  private async dispatch(
    cmd: string,
    request: JsonObject,
    session: Session | undefined,
    connectionClosed?: () => boolean,
  ): Promise<JsonValue> {
    switch (cmd) {
      case "diagnostics":
        return this.diagnostics();
      case "checkPermissions":
        return {
          accessibility: true,
          screenRecording: true,
          screenRecordingPreflight: true,
          screenRecordingCapturable: true,
          source: { attribution: "helper-app", pid: process.pid },
        };
      case "shutdown":
        if (this.multi) {
          const busy = this.otherSessionsActive(session?.id);
          if (busy > 0)
            throw new FakeFailure(
              "helper_busy",
              `shutdown refused: other sessions have ${busy} request(s) in flight`,
              false,
              undefined,
              { activeRequests: busy },
            );
        }
        this.protocolVersion = this.relaunchProtocolVersion;
        this.startedAt = Date.now() / 1000;
        this.owner = undefined;
        this.sessions.clear();
        this.section = undefined;
        return { shuttingDown: true };
      case "claim":
        if (!session) throw new FakeFailure("invalid_args", "claim requires session");
        this.authorize(session, false);
        return {
          claimed: true,
          owner: { id: session.id, generation: session.generation },
          ttlMs: this.ownerTtlMs,
        };
      case "release":
        return { released: this.release(session) };
      case "cancel":
        return await this.cancel(stringField(request, "target") ?? "", session);
      case "foregroundSection":
        return await this.foregroundSectionCommand(request, session, connectionClosed);
      case "listApps":
        return {
          apps: [
            { ...FAKE_APP, isFrontmost: this.frontmost.pid === FAKE_APP.pid },
            { ...this.userApp, isFrontmost: this.frontmost.pid === this.userApp.pid },
            ...(this.secondTarget
              ? [{ ...FAKE_APP_B, isFrontmost: this.frontmost.pid === FAKE_APP_B.pid }]
              : []),
          ],
        };
      case "listRoots":
      case "listWindows":
        return { roots: this.roots(numberField(request, "pid")) };
      case "getFrontmost":
        return this.getFrontmost();
      case "look":
        return this.look(request, session);
      case "act":
        return await this.tracked([request], session, (tracked) =>
          this.coordinated(request, session, tracked, () => this.act(request, false, tracked)),
        );
      case "actBatch":
        return await this.tracked(this.batchActions(request), session, (tracked) =>
          this.coordinated(request, session, tracked, () => this.actBatch(request, tracked)),
        );
      case "axWaitFor":
        return { found: true, gone: false, timedOut: false, nodeCount: 4 };
      case "axReadText": {
        const text = this.fieldValue;
        return { text, offset: 0, limit: text.length, totalChars: text.length, hasMore: false };
      }
      case "focusedElement":
        return {
          exists: true,
          elementRef: "field-1",
          role: "AXTextField",
          subrole: "",
          isTextInput: true,
          isSecure: false,
          canSetValue: true,
        };
      case "focusWindow":
        if (request.foregroundGrant !== true)
          throw new FakeFailure(
            "foreground_required",
            "focusWindow requires a host foreground grant",
            false,
          );
        if (this.section && this.section.holder === session?.id)
          this.section.targets.add(numberField(request, "pid") ?? FAKE_APP.pid);
        this.frontmost = FAKE_APP;
        return { focused: true };
      case "restoreUserFocus": {
        if (request.foregroundGrant !== true)
          throw new FakeFailure(
            "foreground_required",
            "restoreUserFocus requires a host foreground grant",
            false,
          );
        return this.restoreUserFocus(request);
      }
      default:
        throw new FakeFailure("unknown_command", `Unknown command '${cmd}'`);
    }
  }

  cancelAckFor(target: string, session: Session | undefined): Promise<JsonObject> {
    return this.cancel(target, session);
  }

  private roots(pid: number | undefined): JsonObject[] {
    if (!this.secondTarget) return [this.root(FAKE_APP.pid)];
    if (pid === FAKE_APP_B.pid) return [this.root(FAKE_APP_B.pid)];
    if (pid === FAKE_APP.pid) return [this.root(FAKE_APP.pid)];
    return [this.root(FAKE_APP.pid), this.root(FAKE_APP_B.pid)];
  }

  private targetApp(pid: number | undefined): typeof FAKE_APP {
    return this.secondTarget && pid === FAKE_APP_B.pid ? FAKE_APP_B : FAKE_APP;
  }

  private enforceAppPolicy(request: JsonObject, owner: typeof FAKE_APP, act: boolean): void {
    const list = objectField(request, "appBlocklist");
    const pids = Array.isArray(list.pids) ? list.pids.filter(isNumber) : [];
    const bundleIds = Array.isArray(list.bundleIds)
      ? list.bundleIds.filter(isString).map((bundleId) => bundleId.toLowerCase())
      : [];
    const match = pids.includes(owner.pid)
      ? "pid"
      : bundleIds.includes(owner.bundleId.toLowerCase())
        ? "bundle_id"
        : undefined;
    if (!match) return;
    const details: JsonObject = {
      blockedPid: owner.pid,
      blockedApp: owner.appName,
      blockedBundleId: owner.bundleId,
      blockMatch: match,
    };
    if (act) details.inputSent = false;
    throw new FakeFailure(
      "app_blocked",
      `app_blocked: computer-use is not allowed to operate ${owner.appName} (${owner.bundleId}, pid ${owner.pid}); the helper refused the real owner of the requested window or element, and nothing was observed or sent to it`,
      false,
      undefined,
      details,
    );
  }

  private getFrontmost(): JsonObject {
    const front = this.frontmost;
    if (front.pid === this.userApp.pid)
      return {
        ...this.userApp,
        windowTitle: this.userWindowTitle,
        windowId: USER_WINDOW_ID,
        windowSource: "focused",
      };
    const second = front.pid === FAKE_APP_B.pid;
    return {
      ...front,
      windowTitle: second ? FAKE_WINDOW_TITLE_B : FAKE_WINDOW_TITLE,
      windowId: second ? WINDOW_ID_B : (this.targetKeyWindowId ?? WINDOW_ID),
      windowSource: "focused",
    };
  }

  private restoreUserFocus(request: JsonObject): JsonObject {
    const pid = numberField(request, "pid");
    const app = [FAKE_APP, FAKE_APP_B, this.userApp].find((candidate) => candidate.pid === pid);
    if (!app) throw new FakeFailure("app_not_found", `App with pid ${pid} is no longer running`);
    const frontmostBefore = this.frontmost.pid;
    const expected = numberField(request, "expectedFrontmostPid");
    if (expected !== undefined && expected !== frontmostBefore)
      return {
        restored: false,
        appRestored: false,
        windowRestored: false,
        appName: app.appName,
        reason: "frontmost_changed",
        frontmostBefore,
      };
    this.frontmost = app;
    const windowId = numberField(request, "windowId");
    const windowTitle = stringField(request, "windowTitle");
    const known =
      app.pid === this.userApp.pid
        ? [{ id: USER_WINDOW_ID, title: this.userWindowTitle }]
        : app.pid === FAKE_APP_B.pid
          ? [{ id: WINDOW_ID_B, title: FAKE_WINDOW_TITLE_B }]
          : [
              { id: WINDOW_ID, title: FAKE_WINDOW_TITLE },
              ...(this.targetKeyWindowId === undefined
                ? []
                : [{ id: this.targetKeyWindowId, title: "Second Window" }]),
            ];
    const match =
      windowId !== undefined
        ? known.find((window) => window.id === windowId)
        : windowTitle
          ? known.find((window) => window.title.toLowerCase() === windowTitle.toLowerCase())
          : undefined;
    const windowNamed = windowId !== undefined || windowTitle !== undefined;
    return {
      restored: !windowNamed || match !== undefined,
      appRestored: true,
      windowRestored: match !== undefined,
      appName: app.appName,
      windowTitle: match?.title ?? "",
      windowMatch: windowId !== undefined ? "id" : windowTitle ? "title" : "none",
      frontmostBefore,
    };
  }

  foregroundSectionHolder(): string | undefined {
    return this.section?.holder;
  }

  setProtocolVersion(version: number): void {
    this.protocolVersion = version;
    this.startedAt = Date.now() / 1000;
  }

  shutdown(): void {
    this.stopped = true;
    clearTimeout(this.expiryTimer);
    for (const tracked of this.active.values()) {
      tracked.cancelled = true;
      tracked.wake?.();
    }
  }

  private extendedStatus(request: JsonObject, policy: string): string | undefined {
    if (request.backgroundDelivery !== "extended") return undefined;
    if (this.extendedDelivery !== "available") return "unavailable";
    return policy === "background" ? "used" : "not_applicable";
  }

  private extendedPointerAnswer(): JsonObject {
    const evidence: JsonObject = {
      deliveryUsed: "pid_pointer",
      pidPointerAttempted: true,
      observableChange: false,
      pixelCheck: "compared",
      pixelChange: false,
    };
    const performed: JsonObject = {
      delivery: "pid",
      grounding: "coordinates",
      verification: "caller_required",
      extendedDelivery: "used",
    };
    switch (this.extendedAnswer) {
      case "foreground_required":
        throw new FakeFailure("foreground_required", PID_NO_CHANGE_REASON, false, undefined, {
          evidence: { ...evidence, extendedDelivery: "used" },
          extendedDelivery: "used",
        });
      case "foreground_required_bare":
        throw new FakeFailure("foreground_required", PID_NO_CHANGE_REASON, false, undefined, {
          extendedDelivery: "used",
        });
      case "didnt":
        return {
          outcome: "didnt",
          performed,
          evidence: { observableChange: false, extendedDelivery: "used" },
        };
      case "ending":
        return {
          outcome: "unknown",
          performed: { delivery: "pid", extendedDelivery: "used" },
          evidence: {
            extendedDelivery: "used",
            observableChange: false,
            extendedDeliveryEnding: {
              code: "foreground_required",
              message: "The text field does not accept accessibility focus",
            },
          },
        };
      case "key_window_refusal":
      case "key_window_unresolved":
      case "unknown":
        return {
          outcome: "unknown",
          performed,
          evidence: { ...evidence, extendedDelivery: "used" },
        };
    }
  }

  private diagnostics(): JsonObject {
    const output: JsonObject = {
      protocolVersion: this.protocolVersion,
      architectureVersion: 1,
      invariants: [
        "state-scoped-observations",
        "bounded-observation-history",
        "multi-root-forest",
        "progressive-disclosure",
        "atomic-physical-input",
        "concurrent-requests",
        "transactional-batching",
        "foreground-grant-enforced",
        "request-cancellation",
        "session-ownership",
        "fake-helper",
        ...(this.multi
          ? [
              "multi-session",
              "per-target-serialization",
              "exclusive-foreground-section",
              "session-scoped-looks",
            ]
          : []),
      ],
      pid: process.pid,
      macOS: "fake",
      arch: "arm64",
      accessibility: true,
      screenRecording: true,
      fake: true,
      script: this.script,
    };
    if (this.executablePath) output.executablePath = this.executablePath;
    if (this.startedAt !== undefined) output.startedAt = this.startedAt;
    if (this.extendedDelivery)
      output.extendedDelivery =
        this.extendedDelivery === "available"
          ? { available: true, osMajorVersion: 27, missingSymbols: [] }
          : { available: false, osMajorVersion: 26, missingSymbols: [], reason: "os_not_measured" };
    if (this.offSpace)
      output.offSpace = {
        available: true,
        discoveryAvailable: this.extendedDelivery === "available",
        missingSymbols: [],
      };
    return output;
  }

  private authorize(session: Session | undefined, pin: boolean): void {
    if (this.multi) return this.authorizeMulti(session, pin);
    const now = Date.now();
    const pinned = this.ownerActive > 0;
    const live =
      this.owner && (pinned || now - this.owner.lastSeen < this.ownerTtlMs)
        ? this.owner
        : undefined;
    const refuse = (message: string) =>
      new FakeFailure("owned_by_other_session", message, false, undefined, {
        activeRequests: this.ownerActive,
      });
    if (!session) {
      if (live)
        throw refuse("The helper is owned by another session; this request carries no session");
      this.owner = undefined;
      if (pin) this.ownerActive += 1;
      return;
    }
    if (live) {
      if (live.id !== session.id) throw refuse("The helper is owned by another session");
      if (session.generation < live.generation)
        throw refuse("The helper is owned by a newer generation of this session");
      if (session.generation > live.generation && pinned)
        throw refuse("An older generation of this session still has requests in flight");
    } else if (!this.owner && pinned) {
      throw refuse("Requests without a session are in flight");
    }
    this.owner = { ...session, lastSeen: now };
    if (pin) this.ownerActive += 1;
  }

  private endOwned(session: Session | undefined): void {
    if (this.multi) {
      if (!session) this.sessionlessActive = Math.max(0, this.sessionlessActive - 1);
      const entry = session ? this.sessions.get(session.id) : undefined;
      if (entry) {
        entry.active = Math.max(0, entry.active - 1);
        if (entry.generation === session?.generation) entry.lastSeen = Date.now();
      }
      return;
    }
    this.ownerActive = Math.max(0, this.ownerActive - 1);
    const owner = this.owner;
    if (session && owner && owner.id === session.id && owner.generation === session.generation)
      owner.lastSeen = Date.now();
  }

  private refresh(session: Session): void {
    if (this.multi) {
      this.pruneSessions();
      const entry = this.sessions.get(session.id);
      if (!entry)
        this.sessions.set(session.id, {
          generation: session.generation,
          lastSeen: Date.now(),
          active: 0,
        });
      else if (entry.generation === session.generation) entry.lastSeen = Date.now();
      if (this.section?.holder === session.id) this.section.lastSeen = Date.now();
      return;
    }
    const owner = this.owner;
    if (
      owner &&
      owner.id === session.id &&
      owner.generation === session.generation &&
      (this.ownerActive > 0 || Date.now() - owner.lastSeen < this.ownerTtlMs)
    )
      owner.lastSeen = Date.now();
  }

  private release(session: Session | undefined): boolean {
    if (this.multi) {
      const entry = session ? this.sessions.get(session.id) : undefined;
      if (!session || !entry || session.generation < entry.generation) return false;
      if (entry.active > 0)
        throw new FakeFailure(
          "owner_busy",
          `release refused: this session has ${entry.active} request(s) in flight`,
          false,
          undefined,
          { activeRequests: entry.active },
        );
      this.endSession(session.id, true);
      return true;
    }
    if (
      !session ||
      !this.owner ||
      this.owner.id !== session.id ||
      session.generation < this.owner.generation
    )
      return false;
    if (this.ownerActive > 0)
      throw new FakeFailure(
        "owner_busy",
        `release refused: the owner has ${this.ownerActive} request(s) in flight`,
        false,
        undefined,
        { activeRequests: this.ownerActive },
      );
    this.owner = undefined;
    return true;
  }

  private authorizeMulti(session: Session | undefined, pin: boolean): void {
    this.pruneSessions();
    if (!session) {
      if (pin) this.sessionlessActive += 1;
      return;
    }
    const now = Date.now();
    const live = this.sessions.get(session.id);
    if (live) {
      const refuse = (message: string) =>
        new FakeFailure("owned_by_other_session", message, false, undefined, {
          activeRequests: live.active,
        });
      if (session.generation < live.generation)
        throw refuse("The helper session is held by a newer generation of this session");
      if (session.generation > live.generation && live.active > 0)
        throw refuse("An older generation of this session still has requests in flight");
      live.generation = session.generation;
      live.lastSeen = now;
      if (pin) live.active += 1;
    } else
      this.sessions.set(session.id, {
        generation: session.generation,
        lastSeen: now,
        active: pin ? 1 : 0,
      });
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions)
      if (entry.active === 0 && now - entry.lastSeen >= this.ownerTtlMs) this.endSession(id, false);
  }

  private endSession(id: string, dropLooks: boolean): void {
    this.sessions.delete(id);
    if (dropLooks) {
      this.dropLooks(id);
      this.lookSessionGenerations.delete(id);
    }
    if (this.section?.holder === id && !this.section.restoring) this.retireSection(!dropLooks);
  }

  private dropLooks(id: string): void {
    for (const [lookId, owner] of this.lookOwners)
      if (owner === id) {
        this.lookOwners.delete(lookId);
        this.lookGenerations.delete(lookId);
        this.validLooks.delete(lookId);
      }
  }

  private noteLookSession(session: Session): void {
    const known = this.lookSessionGenerations.get(session.id);
    if (known !== undefined && session.generation < known) return;
    if (known !== undefined && session.generation > known) this.dropLooks(session.id);
    this.lookSessionGenerations.set(session.id, session.generation);
  }

  private otherSessionsActive(caller: string | undefined): number {
    let count =
      caller === undefined ? Math.max(0, this.sessionlessActive - 1) : this.sessionlessActive;
    for (const [id, entry] of this.sessions) if (id !== caller) count += entry.active;
    return count;
  }

  private async waitUntil(
    tracked: Tracked | undefined,
    limitMs: number,
    ready: () => boolean,
  ): Promise<boolean> {
    const end = Date.now() + limitMs;
    while (!ready()) {
      if (tracked) this.checkpoint(tracked);
      if (Date.now() >= end) return false;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return true;
  }

  private expireIdleSection(): void {
    const section = this.section;
    if (
      section?.explicit &&
      !section.restoring &&
      section.active === 0 &&
      Date.now() - section.lastSeen >= this.sectionIdleMs
    )
      this.retireSection(true);
  }

  private retireSection(restore: boolean): void {
    const section = this.section;
    if (!section) return;
    const userApp = section.userApp;
    if (!restore || !userApp || !section.targets.has(this.frontmost.pid)) {
      this.section = undefined;
      return;
    }
    section.restoring = true;
    const timer = setTimeout(() => {
      if (this.section === section) {
        if (section.targets.has(this.frontmost.pid)) this.frontmost = userApp;
        this.section = undefined;
      }
      this.armExpiry();
    }, this.sectionRestoreMs);
    timer.unref?.();
  }

  private async coordinated(
    request: JsonObject,
    session: Session | undefined,
    tracked: Tracked,
    body: () => Promise<JsonObject>,
  ): Promise<JsonObject> {
    if (!this.multi) return await body();
    const first = this.batchActions(request)[0] ?? request;
    const lookId = stringField(first, "lookId") ?? "";
    const owner = this.lookOwners.get(lookId);
    if (owner !== undefined && owner !== session?.id)
      throw new FakeFailure(
        "not_look_owner",
        `Look id '${lookId}' belongs to another session; nothing was sent. Observe the window in this session first`,
        false,
      );
    const pid = this.lookApps.get(lookId) ?? numberField(first, "pid") ?? FAKE_APP.pid;
    const requestKey = `req:${Math.random()}`;
    const sessionKey = session?.id ?? requestKey;
    const foreground = isGrantedHidRequest(first);
    let implicit = false;
    if (foreground) {
      const started = Date.now();
      const entered = await this.waitUntil(tracked, this.coordinationWaitMs, () => {
        this.expireIdleSection();
        return !this.section || (this.section.holder === sessionKey && !this.section.restoring);
      });
      if (!entered)
        throw new FakeFailure(
          "foreground_busy",
          "foreground_busy: another computer-use session holds the foreground; nothing was sent. Retry later",
          false,
          undefined,
          { inputSent: false, waitedMs: Date.now() - started, retry: "later" },
        );
      if (this.section) {
        this.section.active += 1;
        this.section.targets.add(pid);
      } else {
        implicit = true;
        this.section = {
          holder: sessionKey,
          explicit: false,
          lastSeen: Date.now(),
          active: 1,
          targets: new Set([pid]),
        };
      }
    }
    try {
      const started = Date.now();
      let reason = "act";
      const acquired = await this.waitUntil(tracked, this.coordinationWaitMs, () => {
        this.expireIdleSection();
        const holder = this.targetHolders.get(pid);
        if (holder !== undefined && holder !== requestKey) return false;
        if (this.section && this.section.holder !== sessionKey && this.section.targets.has(pid)) {
          reason = "foreground_section";
          return false;
        }
        return true;
      });
      if (!acquired)
        throw new FakeFailure(
          "target_busy",
          "target_busy: another computer-use session is acting on this app; nothing was sent. Retry later",
          false,
          undefined,
          { inputSent: false, busyReason: reason, waitedMs: Date.now() - started, retry: "later" },
        );
      this.targetHolders.set(pid, requestKey);
      const span: JsonObject = {
        requestId: stringField(first, "requestId") ?? null,
        session: session?.id ?? null,
        pid,
        foreground,
        start: Date.now(),
      };
      try {
        if (this.actHoldMs > 0) await this.sleep(tracked, this.actHoldMs);
        return await body();
      } finally {
        span.end = Date.now();
        this.actSpans.push(span);
        if (this.targetHolders.get(pid) === requestKey) this.targetHolders.delete(pid);
      }
    } finally {
      if (foreground && this.section?.holder === sessionKey) {
        this.section.active = Math.max(0, this.section.active - 1);
        this.section.lastSeen = Date.now();
        if (implicit && !this.section.explicit && this.section.active === 0)
          this.section = undefined;
      }
    }
  }

  private async foregroundSectionCommand(
    request: JsonObject,
    session: Session | undefined,
    connectionClosed?: () => boolean,
  ): Promise<JsonObject> {
    if (!session)
      throw new FakeFailure(
        "invalid_args",
        "foregroundSection requires session {id, generation}",
        false,
      );
    const op = stringField(request, "op") ?? "acquire";
    const acquireId = stringField(request, "acquireId") || undefined;
    if (op === "release") {
      if (acquireId !== undefined) {
        const now = Date.now();
        for (const [id, at] of this.cancelledAcquires)
          if (now - at >= 60_000) this.cancelledAcquires.delete(id);
        const waiting = this.pendingAcquires.has(acquireId);
        const section = this.section;
        if (section?.holder === session.id && section.acquireIds?.has(acquireId)) {
          if (!section.restoring) this.retireSection(false);
          return { released: true, cancelledWait: waiting };
        }
        this.cancelledAcquires.set(acquireId, now);
        return { released: false, cancelledWait: waiting };
      }
      const held = this.section?.holder === session.id;
      if (held && !this.section?.restoring) this.section = undefined;
      return { released: held };
    }
    const waitMs = Math.max(
      0,
      Math.min(this.coordinationWaitMs, numberField(request, "waitMs") ?? 0),
    );
    const started = Date.now();
    let abandoned: string | undefined;
    if (acquireId !== undefined) this.pendingAcquires.add(acquireId);
    let entered: boolean;
    try {
      entered = await this.waitUntil(undefined, waitMs, () => {
        if (acquireId !== undefined && this.cancelledAcquires.has(acquireId)) {
          abandoned = "cancelled";
          return true;
        }
        if (connectionClosed?.()) {
          abandoned = "connection_closed";
          return true;
        }
        this.expireIdleSection();
        return !this.section || (this.section.holder === session.id && !this.section.restoring);
      });
    } finally {
      if (acquireId !== undefined) this.pendingAcquires.delete(acquireId);
    }
    if (!entered)
      throw new FakeFailure(
        "foreground_busy",
        "foreground_busy: another computer-use session holds the foreground; nothing was sent. Retry later",
        false,
        undefined,
        { waitedMs: Date.now() - started, retry: "later" },
      );
    if (abandoned !== undefined)
      throw new FakeFailure(
        "cancelled",
        `cancelled: this foregroundSection acquire ended before it was granted (${abandoned}); the section was not taken`,
        false,
        undefined,
        { waitedMs: Date.now() - started, reason: abandoned },
      );
    const alreadyHeld = this.section !== undefined;
    if (this.section) {
      this.section.explicit = true;
      this.section.lastSeen = Date.now();
      this.section.acquireIds ??= new Set();
      if (acquireId !== undefined) this.section.acquireIds.add(acquireId);
    } else
      this.section = {
        holder: session.id,
        explicit: true,
        lastSeen: Date.now(),
        active: 0,
        targets: new Set(),
        userApp: this.frontmost,
        acquireIds: new Set(acquireId === undefined ? [] : [acquireId]),
      };
    this.armExpiry();
    return {
      acquired: true,
      alreadyHeld,
      waitedMs: Date.now() - started,
      frontmostPid: this.frontmost.pid,
    };
  }

  private pruneTombstones(now: number): void {
    const fresh = this.tombstones.filter((tombstone) => now - tombstone.at < TOMBSTONE_TTL_MS);
    this.tombstones.splice(0, this.tombstones.length, ...fresh.slice(-TOMBSTONE_LIMIT));
  }

  private async cancel(target: string, session: Session | undefined): Promise<JsonObject> {
    const tracked = this.active.get(target);
    const entry = this.completed.findLast((candidate) => candidate.id === target);
    const registeredBy = tracked ? tracked.session?.id : entry?.sessionId;
    if (registeredBy !== undefined && registeredBy !== session?.id)
      throw new FakeFailure(
        "not_request_owner",
        `cancel refused: request '${target}' was registered by another session`,
        false,
      );
    if (!tracked) {
      const completed = entry !== undefined;
      if (!completed) {
        const now = Date.now();
        const kept = this.tombstones.filter(
          (tombstone) => tombstone.id !== target || tombstone.sessionId !== session?.id,
        );
        this.tombstones.splice(0, this.tombstones.length, ...kept, {
          id: target,
          at: now,
          sessionId: session?.id,
        });
        this.pruneTombstones(now);
      }
      return {
        acknowledged: true,
        state: completed ? "completed" : "not_found",
      };
    }
    tracked.cancelled = true;
    if (this.cancelBlockMs > 0) setTimeout(() => tracked.wake?.(), this.cancelBlockMs).unref();
    else tracked.wake?.();
    const until = Date.now() + 300;
    while (Date.now() < until) {
      if (tracked.stopped)
        return {
          acknowledged: true,
          state: "stopped",
          stoppedAt: tracked.step,
          effectPossible: tracked.effect,
        };
      if (this.active.get(target) !== tracked)
        return { acknowledged: true, state: "completed", effectPossible: tracked.effect };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { acknowledged: true, state: "stopping", effectPossible: true };
  }

  private batchActions(request: JsonObject): JsonObject[] {
    const actions = request.actions;
    return Array.isArray(actions) ? actions.filter(isJsonObject) : [];
  }

  private async tracked(
    requests: JsonObject[],
    session: Session | undefined,
    body: (tracked: Tracked) => Promise<JsonObject>,
  ): Promise<JsonObject> {
    const ids = requests.flatMap((request) => {
      const id = stringField(request, "requestId");
      return id ? [id] : [];
    });
    const receivedAt = Date.now();
    if (requests.some((request) => "deadlineMs" in request && !("budgetMs" in request)))
      throw new FakeFailure(
        "invalid_args",
        "deadlineMs is not accepted since protocol 8; send budgetMs",
        false,
      );
    const deadlines = requests.flatMap((request) => {
      const budget = numberField(request, "budgetMs");
      return budget === undefined ? [] : [receivedAt + budget];
    });
    this.pruneTombstones(receivedAt);
    const tombstoned = ids.some((id) =>
      this.tombstones.some(
        (tombstone) => tombstone.id === id && (!session || tombstone.sessionId === session.id),
      ),
    );
    const tracked: Tracked = {
      cancelled: tombstoned,
      stopped: false,
      effect: false,
      step: 0,
      deadlineMs: deadlines.length > 0 ? Math.min(...deadlines) : undefined,
      session,
    };
    for (const id of ids) this.active.set(id, tracked);
    try {
      this.checkpoint(tracked);
      return await body(tracked);
    } catch (error) {
      const hid = requests.some(isGrantedHidRequest);
      if (
        error instanceof FakeFailure &&
        (error.effectPossible === undefined || (hid && error.details?.inputSent === undefined))
      )
        throw new FakeFailure(
          error.code,
          error.message,
          error.effectPossible ?? tracked.effect,
          error.result,
          hid && error.details?.inputSent === undefined
            ? { ...error.details, inputSent: tracked.effect }
            : error.details,
        );
      throw error;
    } finally {
      for (const id of ids) {
        this.active.delete(id);
        this.completed.push({ id, sessionId: session?.id });
      }
      if (this.completed.length > 64) this.completed.splice(0, this.completed.length - 64);
    }
  }

  private checkpoint(tracked: Tracked): void {
    if (tracked.session) this.refresh(tracked.session);
    const expired = tracked.deadlineMs !== undefined && Date.now() >= tracked.deadlineMs;
    if (!tracked.cancelled && !expired) return;
    tracked.stopped = true;
    throw new FakeFailure(
      "cancelled",
      tracked.cancelled
        ? "Request was cancelled"
        : "Request deadline passed before delivery completed",
      tracked.effect,
      {
        outcome: tracked.effect ? "partial" : "rejected_before_delivery",
        stoppedAt: tracked.step,
        reason: tracked.cancelled ? "cancelled" : "deadline",
      },
    );
  }

  private root(pid: number): JsonObject {
    const second = this.secondTarget && pid === FAKE_APP_B.pid;
    const app = second ? FAKE_APP_B : FAKE_APP;
    const root: JsonObject = {
      kind: "window",
      rootRef: second ? ROOT_REF_B : ROOT_REF,
      windowRef: second ? ROOT_REF_B : ROOT_REF,
      windowId: second ? WINDOW_ID_B : WINDOW_ID,
      pid: app.pid,
      appName: app.appName,
      bundleId: app.bundleId,
      title: second ? FAKE_WINDOW_TITLE_B : FAKE_WINDOW_TITLE,
      role: "AXWindow",
      subrole: "AXStandardWindow",
      zOrder: 0,
      framePoints: { ...this.frame },
      scaleFactor: 1,
      isOnscreen: true,
      isFocused: true,
      isMinimized: false,
      isMain: true,
      isModal: false,
      metadata: { generation: this.generation },
    };
    if (this.offSpace && !second) {
      root.isOnscreen = false;
      root.isFocused = false;
      root.offSpace = true;
      root.offSpaceAccess = this.offSpaceExposed ? "resolved" : "unresolved";
      if (!this.offSpaceExposed) {
        delete root.rootRef;
        delete root.windowRef;
      }
    }
    return root;
  }

  private node(
    ref: string,
    role: string,
    title: string,
    value: string,
    rect: JsonObject,
    capabilities: { press?: boolean; text?: boolean; focus?: boolean; description?: string },
  ): JsonObject {
    return {
      ref,
      role,
      subrole: "",
      identifier: ref,
      title,
      description: capabilities.description ?? "",
      value,
      actions: capabilities.press ? ["press"] : [],
      canPress: capabilities.press === true,
      canFocus:
        capabilities.press === true || capabilities.text === true || capabilities.focus === true,
      canSetValue: capabilities.text === true,
      canScroll: false,
      canIncrement: false,
      canDecrement: false,
      isTextInput: capabilities.text === true,
      rect,
      children: [],
    };
  }

  private look(request: JsonObject, session?: Session): JsonObject {
    const requested =
      this.secondTarget &&
      (request.windowId === WINDOW_ID_B ||
        request.windowRef === ROOT_REF_B ||
        request.pid === FAKE_APP_B.pid)
        ? FAKE_APP_B
        : FAKE_APP;
    this.enforceAppPolicy(request, this.realOwner === "window" ? this.userApp : requested, false);
    let offSpace: JsonObject | undefined;
    if (this.offSpace && requested.pid === FAKE_APP.pid) {
      if (!this.offSpaceExposed) {
        if (request.backgroundDelivery !== "extended" || this.extendedDelivery !== "available")
          throw new FakeFailure(
            "off_space_window_unresolved",
            request.backgroundDelivery === "extended"
              ? `off_space_window_unresolved: window ${WINDOW_ID} of ${FAKE_APP.appName} is on a Space no display shows, and the app has not exposed it to Accessibility; the discovery activation extended delivery would use is unavailable in this helper (os_not_measured), so nothing was activated or captured. The user can show the window once (switch to its Space and back)`
              : `off_space_window_unresolved: window ${WINDOW_ID} of ${FAKE_APP.appName} is on a Space no display shows, and the app has not exposed it to Accessibility, so it cannot be read without switching Spaces; nothing was activated or captured. The user can show the window once (switch to its Space and back), or enable background_delivery: "extended", which lets the helper tell the app it is active for a moment so that it exposes the window`,
            false,
            undefined,
            { offSpace: true, windowId: WINDOW_ID, discoveryActivation: false },
          );
        this.offSpaceDiscoveries += 1;
        this.offSpaceExposed = true;
        offSpace = {
          discoveryActivation: true,
          resolvedBy: "discovery_main_window",
          spacesUnchanged: true,
        };
      } else {
        offSpace = { discoveryActivation: false, resolvedBy: request.windowRef ? "ref" : "cache" };
      }
    }
    this.lookCount += 1;
    const bump =
      request.fixtureMutation === "bump_root_generation" ||
      (this.script === "s5-stale" && this.lookCount === 2);
    if (bump) {
      this.generation += 1;
      this.validLooks.clear();
      this.lookFrames.clear();
      this.pendingDelta = true;
    }
    if (request.fixtureMutation === "resize") this.frame = RESIZED_FRAME;
    const lookId = `look_${++this.lookSequence}`;
    this.validLooks.add(lookId);
    this.lookFrames.set(lookId, this.frame);
    const second =
      this.secondTarget &&
      (request.windowId === WINDOW_ID_B ||
        request.windowRef === ROOT_REF_B ||
        request.pid === FAKE_APP_B.pid);
    this.lookApps.set(lookId, second ? FAKE_APP_B.pid : FAKE_APP.pid);
    this.lookOwners.set(lookId, session?.id);
    if (session) this.lookGenerations.set(lookId, session.generation);
    const sameOwner = [...this.lookOwners].filter(([, owner]) => owner === session?.id);
    for (const [evicted] of sameOwner.slice(0, Math.max(0, sameOwner.length - 8))) {
      this.lookOwners.delete(evicted);
      this.validLooks.delete(evicted);
    }
    const label =
      this.pressCount > 0
        ? `Clicked ${this.pressCount}`
        : this.generation > 1
          ? `Generation ${this.generation}`
          : "Ready";
    const customView =
      this.script === "s2-foreground-required" ||
      this.script === "s6-grant" ||
      this.script === "s8-foreground-not-acquired" ||
      this.script === "s10-pid-unknown"
        ? [
            this.node(
              CUSTOM_VIEW_REF,
              "AXGroup",
              "",
              "",
              { x: 260, y: 60, w: 160, h: 120 },
              { focus: true, description: CUSTOM_VIEW_NAME },
            ),
          ]
        : [];
    const outline = {
      ...this.node("root-1", "AXWindow", FAKE_WINDOW_TITLE, "", { x: 0, y: 0, w: 640, h: 480 }, {}),
      children: [
        this.node(
          "field-1",
          "AXTextField",
          "Name",
          this.fieldValue,
          { x: 20, y: 20, w: 200, h: 24 },
          { text: true },
        ),
        this.node(
          "button-1",
          "AXButton",
          "Increment",
          "",
          { x: 20, y: 60, w: 120, h: 32 },
          { press: true },
        ),
        this.node("label-1", "AXStaticText", label, label, { x: 20, y: 110, w: 200, h: 20 }, {}),
        ...customView,
      ],
    };
    const readText = stringField(request, "readText") ?? "never";
    const response: JsonObject = {
      lookId,
      capturedAt: Date.now() / 1000,
      hasImage: false,
      window: {
        windowId: second ? WINDOW_ID_B : WINDOW_ID,
        rootRef: second ? ROOT_REF_B : ROOT_REF,
        kind: "window",
        framePoints: { ...this.frame },
        scaleFactor: 1,
        isModal: false,
        metadata: { generation: this.generation },
        role: "AXWindow",
        subrole: "AXStandardWindow",
      },
      outline,
      timings: { captureMs: 0, describeMs: 0, readTextMs: 0 },
      readText: { requested: readText, executed: false },
    };
    if (offSpace) response.offSpace = offSpace;
    return response;
  }

  private async act(request: JsonObject, deferred: boolean, tracked: Tracked): Promise<JsonObject> {
    const policy = (() => {
      const raw = stringField(request, "policy") ?? "background";
      return raw === "default" ? "background" : raw;
    })();
    const granted = policy === "foreground" && request.foregroundGrant === true;
    if (policy === "foreground" && !granted)
      throw new FakeFailure(
        "foreground_required",
        "Foreground delivery requires a host foreground grant on the request",
        tracked.effect,
      );
    const lookId = stringField(request, "lookId") ?? "";
    const caller = sessionOf(request);
    const lookGeneration = this.lookGenerations.get(lookId);
    const otherGeneration =
      this.multi &&
      caller !== undefined &&
      this.lookOwners.get(lookId) === caller.id &&
      lookGeneration !== caller.generation;
    if (!this.validLooks.has(lookId) || otherGeneration)
      throw new FakeFailure("stale_look", `Look id '${lookId}' is no longer available`, false);
    const recordedFrame = this.lookFrames.get(lookId);
    if (recordedFrame && framesDiffer(recordedFrame, this.frame))
      throw new FakeFailure(
        "stale_look",
        `Window frame changed since look ${lookId}; observe again`,
        tracked.effect,
      );
    const action = stringField(request, "action") ?? "";
    const params = objectField(request, "params");
    const target = objectField(request, "target");
    const ref =
      stringField(target, "ref") ??
      (request.focusResolution === "ax_focused_element" ? "field-1" : undefined);
    const delivery = granted && params.delivery !== "pid" ? "hid" : "pid";
    const frontmostBefore = this.frontmost.pid;
    const app = this.targetApp(this.lookApps.get(lookId) ?? numberField(request, "pid"));
    this.enforceAppPolicy(request, this.realOwner === "window" ? this.userApp : app, true);
    if (this.realOwner === "element" && ref !== undefined)
      this.enforceAppPolicy(request, this.userApp, true);
    const offSpaceTarget = this.offSpace !== undefined && app.pid === FAKE_APP.pid;
    if (offSpaceTarget && policy === "foreground")
      throw new FakeFailure(
        "off_space_foreground",
        "off_space_foreground: the target window is on a Space no display shows; foreground delivery would bring it to the front and switch the user's Space, so nothing was activated or sent",
        false,
        undefined,
        { inputSent: false, activationAttempted: false, offSpace: true },
      );
    const effect = (activates = delivery === "hid") => {
      tracked.effect = true;
      if (activates) this.frontmost = app;
    };
    const finish = (response: JsonObject): JsonObject => {
      if (deferred) return response;
      const output: JsonObject = {
        ...response,
        frontmostBefore,
        frontmostAfter: this.frontmost.pid,
      };
      if (offSpaceTarget)
        output.performed = { ...objectField(output, "performed"), offSpace: true };
      if (this.pendingDelta) {
        this.pendingDelta = false;
        output.rootDelta = [
          {
            change: "appeared",
            kind: "sheet",
            title: `Generation ${this.generation}`,
            pid: FAKE_APP.pid,
            ref: `fake-sheet-${this.generation}`,
          },
        ];
      }
      return output;
    };

    if (this.script === "s8-foreground-not-acquired" && delivery === "hid") {
      this.checkpoint(tracked);
      tracked.effect = true;
      const frontmostPid = this.frontmost.pid;
      if (this.refusalActivates) this.frontmost = FAKE_APP;
      throw new FakeFailure(
        "foreground_not_acquired",
        `No input was sent; the target did not come to the front within 400 ms: ${FAKE_APP.appName} (pid ${FAKE_APP.pid}) is not the frontmost app.`,
        true,
        undefined,
        {
          inputSent: false,
          activationAttempted: true,
          destinationReason: "app_not_frontmost",
          targetPid: FAKE_APP.pid,
          frontmostPid,
          frontmostBefore,
          frontmostAfter: this.frontmost.pid,
        },
      );
    }
    if (this.script === "s9-foreground-lost" && action === "typeText") {
      if (delivery !== "hid")
        throw new FakeFailure(
          "foreground_required",
          "Typing into this field needs foreground keyboard input",
          false,
        );
      const text = isString(params.text) ? params.text : "";
      const sent = text.slice(0, TYPE_CHUNK_CHARS);
      this.checkpoint(tracked);
      effect();
      this.fieldValue += sent;
      this.frontmost = this.userApp;
      throw new FakeFailure(
        "foreground_lost",
        `Foreground input stopped after some input was sent: ${FAKE_APP.appName} (pid ${FAKE_APP.pid}) is not the frontmost app. Nothing more was sent. ${sent.length} character(s) of the text were sent first.`,
        true,
        { outcome: "partial", stoppedAt: tracked.step, charactersSent: sent.length },
        {
          inputSent: true,
          activationAttempted: true,
          charactersSent: sent.length,
          destinationReason: "app_not_frontmost",
          targetPid: FAKE_APP.pid,
          frontmostPid: this.userApp.pid,
          frontmostBefore,
          frontmostAfter: this.userApp.pid,
        },
      );
    }

    const clicks = action === "click" || action === "press";
    const clicksField = clicks && ref !== undefined && TEXT_REFS.has(ref);
    const noAxAction =
      clicks && ref !== undefined && !PRESSABLE_REFS.has(ref) && !TEXT_REFS.has(ref);
    if (noAxAction && !granted) {
      if (policy !== "background")
        throw new FakeFailure("foreground_required", NO_AX_ACTION_REASON, tracked.effect);
      const effectBefore = tracked.effect;
      this.checkpoint(tracked);
      effect();
      if (this.pidSettleHoldMs > 0) {
        await this.sleep(tracked, this.pidSettleHoldMs);
        this.checkpoint(tracked);
      }
      const extended = this.extendedStatus(request, policy);
      if (extended === "used") return finish(this.extendedPointerAnswer());
      if (this.script === "s10-pid-unknown")
        return finish({
          outcome: "unknown",
          performed: { delivery: "pid", grounding: "coordinates", verification: "caller_required" },
          evidence: { ...PID_OUTSIDE_TARGET_EVIDENCE },
        });
      const details: JsonObject = {
        evidence: {
          deliveryUsed: "pid_pointer",
          pidPointerAttempted: true,
          observableChange: false,
          pixelCheck: "compared",
          pixelChange: false,
        },
      };
      if (extended) details.extendedDelivery = extended;
      throw new FakeFailure(
        "foreground_required",
        PID_NO_CHANGE_REASON,
        effectBefore,
        undefined,
        details,
      );
    }

    if (action === "setText") {
      if (ref !== "field-1")
        throw new FakeFailure("invalid_args", "setText requires the text field");
      this.checkpoint(tracked);
      effect();
      this.fieldValue = isString(params.text) ? params.text : "";
      if (this.setTextValueOnly)
        return finish({
          outcome: "unknown",
          performed: {
            delivery: "ax",
            grounding: "description",
            textCommit: "value",
            textCommitUnavailable: "selected_text_not_settable",
          },
          evidence: { value: this.fieldValue, valueWriteOnly: true },
        });
      return finish({
        outcome: "worked",
        performed: { delivery: "ax", grounding: "description", textCommit: "selected_text" },
        evidence: { value: this.fieldValue },
      });
    }
    if (action === "typeText") {
      const text = isString(params.text) ? params.text : "";
      if (
        this.extendedStatus(request, policy) === "used" &&
        (this.extendedAnswer === "key_window_refusal" ||
          this.extendedAnswer === "key_window_unresolved")
      ) {
        this.checkpoint(tracked);
        effect();
        const resolved = this.extendedAnswer === "key_window_refusal";
        throw new FakeFailure(
          "foreground_required",
          resolved
            ? "Extended background delivery could not make the observed window the target's key window; no key input was sent"
            : "Extended background delivery could not resolve the observed window, so it could not confirm that window is the target's key window; no key input was sent, only the activation",
          false,
          undefined,
          { keyWindowAcquired: false, observedWindowResolved: resolved, extendedDelivery: "used" },
        );
      }
      if (this.extendedStatus(request, policy) === "used" && this.extendedAnswer === "didnt") {
        this.checkpoint(tracked);
        effect();
        return finish({
          outcome: "didnt",
          performed: { delivery, grounding: "coordinates", extendedDelivery: "used" },
          evidence: { value: this.fieldValue, valueChanged: false, extendedDelivery: "used" },
        });
      }
      if (this.script === "s3-didnt") {
        this.checkpoint(tracked);
        effect();
        return finish({
          outcome: "didnt",
          performed: { delivery, grounding: "coordinates" },
          evidence: { value: this.fieldValue, valueChanged: false },
        });
      }
      for (let index = 0; index < text.length; index += TYPE_CHUNK_CHARS) {
        const chunk = index / TYPE_CHUNK_CHARS;
        if (!deferred) tracked.step = chunk;
        this.checkpoint(tracked);
        if (this.script === "s4-slow-type" && chunk > 0) {
          await this.sleep(tracked, this.slowChunkMs);
          this.checkpoint(tracked);
        }
        effect();
        this.fieldValue += text.slice(index, index + TYPE_CHUNK_CHARS);
        if (this.script === "s4-slow-type" && chunk === 0) {
          if (!deferred) tracked.step = 1;
          await this.sleep(tracked, this.slowHoldMs ?? defaultSlowHoldMs(text));
          await this.overrunDeadline(tracked);
          this.checkpoint(tracked);
        }
      }
      return finish({
        outcome: text.length > 0 ? "worked" : "unknown",
        performed: { delivery, grounding: "coordinates" },
        evidence: { value: this.fieldValue, valueChanged: text.length > 0 },
      });
    }
    if (clicksField && !granted) {
      this.checkpoint(tracked);
      effect();
      return finish({
        outcome: "worked",
        performed: { delivery: "ax", grounding: "focus", focused: true },
        evidence: { focusHeld: true },
      });
    }
    if (clicks && noAxAction) {
      this.checkpoint(tracked);
      effect();
      if (delivery === "hid") {
        if (this.foregroundHoldMs > 0) await this.sleep(tracked, this.foregroundHoldMs);
        return finish({
          outcome: "unknown",
          performed: { delivery: "hid", grounding: "coordinates", activated: true },
        });
      }
      return finish({
        outcome: "didnt",
        performed: { delivery: "pid", grounding: "coordinates", verification: "caller_required" },
        evidence: { observableChange: false },
      });
    }
    if (clicks) {
      this.checkpoint(tracked);
      effect(false);
      if (ref === "button-1") this.pressCount += 1;
      return finish({
        outcome: ref === "button-1" ? "worked" : "unknown",
        performed: { delivery: "ax", grounding: "description" },
      });
    }
    this.checkpoint(tracked);
    effect();
    return finish({ outcome: "unknown", performed: { delivery, grounding: "coordinates" } });
  }

  private async sleep(tracked: Tracked, ms: number): Promise<void> {
    if (tracked.cancelled) return;
    const left =
      tracked.deadlineMs === undefined ? ms : Math.max(0, tracked.deadlineMs - Date.now());
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(ms, left));
      tracked.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    tracked.wake = undefined;
  }

  private async overrunDeadline(tracked: Tracked): Promise<void> {
    if (this.deadlineOverrunMs <= 0 || tracked.cancelled || tracked.deadlineMs === undefined)
      return;
    if (Date.now() < tracked.deadlineMs) return;
    const until = tracked.deadlineMs + this.deadlineOverrunMs;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())));
  }

  private async actBatch(request: JsonObject, tracked: Tracked): Promise<JsonObject> {
    const actions = this.batchActions(request);
    if (actions.length === 0 || actions.length > 20)
      throw new FakeFailure("invalid_args", "actBatch requires 1...20 actions");
    const frontmostBefore = this.frontmost.pid;
    const steps: JsonObject[] = [];
    let stoppedAt: number | undefined;
    for (const [index, action] of actions.entries()) {
      tracked.step = index;
      try {
        this.checkpoint(tracked);
        const list = request.appBlocklist;
        const step = await this.act(
          list !== undefined && action.appBlocklist === undefined
            ? { ...action, appBlocklist: list }
            : action,
          true,
          tracked,
        );
        steps.push(step);
        if (step.outcome === "didnt") {
          stoppedAt = index;
          break;
        }
      } catch (error) {
        if (!(error instanceof FakeFailure)) throw error;
        if (error.code === "cancelled")
          throw new FakeFailure(error.code, error.message, error.effectPossible, {
            ...error.result,
            stoppedAt: index,
            steps,
          });
        steps.push({
          outcome: "didnt",
          error: {
            code: error.code,
            message: error.message,
            effectPossible: error.effectPossible ?? tracked.effect,
          },
        });
        stoppedAt = index;
        break;
      }
    }
    const outcomes = steps.map((step) => step.outcome);
    const response: JsonObject = {
      outcome: outcomes.includes("didnt")
        ? "didnt"
        : outcomes.includes("unknown")
          ? "unknown"
          : "worked",
      performed: { transaction: true, actionCount: steps.length },
      steps,
      frontmostBefore,
      frontmostAfter: this.frontmost.pid,
    };
    if (stoppedAt !== undefined) response.stoppedAt = stoppedAt;
    return response;
  }
}

function errorEnvelope(id: JsonValue, error: Error): JsonObject {
  if (error instanceof FakeFailure) {
    const payload: JsonObject = { code: error.code, message: error.message };
    if (error.effectPossible !== undefined) payload.effectPossible = error.effectPossible;
    for (const [key, value] of Object.entries(error.details ?? {}))
      if (!(key in payload)) payload[key] = value;
    const envelope: JsonObject = { id, ok: false, error: payload };
    if (error.result) envelope.result = error.result;
    return envelope;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { id, ok: false, error: { code: "internal_error", message } };
}

export async function startFakeHelperDaemon(
  options: FakeHelperDaemonOptions,
): Promise<FakeHelperDaemon> {
  const state = new FakeHelperState(options);
  const requests: JsonObject[] = [];
  const sockets = new Set<net.Socket>();
  let logQueue: Promise<void> = Promise.resolve();
  if (options.logPath) await mkdir(path.dirname(options.logPath), { recursive: true });
  const log = (entry: JsonObject) => {
    requests.push(entry);
    const logPath = options.logPath;
    if (!logPath) return;
    logQueue = logQueue
      .then(() => appendFile(logPath, `${JSON.stringify(entry)}\n`))
      .catch(() => undefined);
  };
  let closing: Promise<void> | undefined;
  let resetDone = false;

  const respond = async (socket: net.Socket, line: string) => {
    let request: JsonObject;
    try {
      const parsed: JsonValue = JSON.parse(line);
      if (!isJsonObject(parsed)) throw new Error("Request must be a JSON object");
      request = parsed;
    } catch (error) {
      socket.write(
        `${JSON.stringify(errorEnvelope("invalid", error instanceof Error ? error : new Error(String(error))))}\n`,
      );
      return;
    }
    const id = request.id ?? "invalid";
    const entry: JsonObject = { ...request, receivedAt: Date.now(), script: state.script };
    let response: JsonObject;
    if (request.cmd === "cancel") {
      try {
        const ack = await state.cancelAckFor(
          stringField(request, "target") ?? "",
          sessionOf(request),
        );
        entry.ack = ack;
        response = { id, ok: true, result: ack };
      } catch (error) {
        response = errorEnvelope(id, error instanceof Error ? error : new Error(String(error)));
      }
      log(entry);
    } else if (request.cmd === "act" || request.cmd === "actBatch") {
      if (
        options.dropForegroundActConnection &&
        !resetDone &&
        request.cmd === "act" &&
        request.policy === "foreground"
      ) {
        resetDone = true;
        entry.connectionDropped = true;
        socket.destroy();
      }
      try {
        response = { id, ok: true, result: await state.handle(request) };
      } catch (error) {
        response = errorEnvelope(id, error instanceof Error ? error : new Error(String(error)));
      }
      const logged: JsonObject = { ...response };
      delete logged.id;
      entry.response = logged;
      entry.answeredAt = Date.now();
      log(entry);
    } else {
      log(entry);
      try {
        response = { id, ok: true, result: await state.handle(request, () => socket.destroyed) };
      } catch (error) {
        response = errorEnvelope(id, error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  };

  const server = net.createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void respond(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });

  await unlink(options.socketPath).catch(() => undefined);
  await mkdir(path.dirname(options.socketPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    socketPath: options.socketPath,
    script: state.script,
    requests,
    actSpans: state.actSpans,
    offSpaceDiscoveries: () => state.offSpaceDiscoveries,
    foregroundSectionHolder: () => state.foregroundSectionHolder(),
    setProtocolVersion: (version) => state.setProtocolVersion(version),
    close() {
      closing ??= (async () => {
        const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        state.shutdown();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await settleWithin(
          Promise.all([serverClosed, logQueue, unlink(options.socketPath).catch(() => undefined)]),
          SHUTDOWN_DEADLINE_MS - 25,
        );
      })();
      return closing;
    },
  };
}

function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(args: readonly string[]): Promise<void> {
  const socketPath = argValue(args, "--socket");
  const script = argValue(args, "--script");
  if (!socketPath || !script)
    throw new Error(
      "Usage: fake-helper-daemon.ts --socket <path> --script <name> [--log <jsonl>] [--executable-path <path>] [--protocol-version <n>] [--started-at <s|none>] [--user-app terminal|neutral] [--deadline-overrun-ms <ms>]",
    );
  const protocolArg = argValue(args, "--protocol-version");
  const startedAtArg = argValue(args, "--started-at");
  const userAppArg = argValue(args, "--user-app");
  if (userAppArg !== undefined && userAppArg !== "terminal" && userAppArg !== "neutral")
    throw new Error("--user-app must be terminal or neutral");
  const overrunArg = argValue(args, "--deadline-overrun-ms");
  const deadlineOverrunMs = overrunArg === undefined ? undefined : Number(overrunArg);
  if (
    deadlineOverrunMs !== undefined &&
    !(Number.isSafeInteger(deadlineOverrunMs) && deadlineOverrunMs >= 0)
  )
    throw new Error("--deadline-overrun-ms must be a non-negative integer");
  let daemon: FakeHelperDaemon | undefined;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS);
    const closed = daemon ? daemon.close() : unlink(socketPath).catch(() => undefined);
    void closed.finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  process.stdout.on("error", () => undefined);
  const parentPid = process.ppid;
  setInterval(() => {
    if (process.ppid !== parentPid) stop();
  }, 500).unref();
  daemon = await startFakeHelperDaemon({
    socketPath,
    script,
    logPath: argValue(args, "--log"),
    executablePath: argValue(args, "--executable-path"),
    initialProtocolVersion: protocolArg === undefined ? undefined : Number(protocolArg),
    initialStartedAt:
      startedAtArg === undefined
        ? undefined
        : startedAtArg === "none"
          ? null
          : Number(startedAtArg),
    userApp: userAppArg,
    deadlineOverrunMs,
  });
  if (stopping) {
    await daemon.close();
    process.exit(0);
  }
  process.stdout.write(`ready ${daemon.socketPath}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
