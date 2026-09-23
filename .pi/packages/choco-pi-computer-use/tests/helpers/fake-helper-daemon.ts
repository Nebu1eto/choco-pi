/**
 * Wire-level fake of the macOS computer-use helper daemon (protocol 7).
 *
 * It speaks the helper's newline-delimited JSON protocol on a Unix socket and
 * never touches Accessibility, screen capture, or input. Tests import
 * `startFakeHelperDaemon`; tier-A E2E runs it as a CLI:
 *
 *   node --experimental-strip-types tests/helpers/fake-helper-daemon.ts \
 *     --socket <path> --script <name> [--log <requests.jsonl>] \
 *     [--executable-path <path>] [--protocol-version <n>]
 *
 * Scripts: s1-ok, s2-foreground-required, s3-didnt, s4-slow-type, s5-stale,
 * s6-grant, s7-ownership (short forms S1..S7 / s1..s7 are accepted).
 * In every script an ungranted click or press on the text field (`field-1`)
 * is a pid-scoped AX focus request that works (`delivery: "ax"`,
 * `grounding: "focus"`), as in the helper.
 *
 * S2 and S6 add a custom view (`custom-1`, AXGroup, description "Custom
 * View", no AXPress, `canFocus: true`). `canFocus` keeps it a ref target in
 * `src/actions.ts` (a node with only incidental actions would fall back to
 * coordinates, which need an image-bearing look the fake never returns).
 * As in the helper, in every script an ungranted click or press on a ref
 * with no AX press action that is not a text input is refused with
 * `foreground_required` (`effectPossible: false`) before any delivery; the
 * button (`button-1`) is pressed through AX with or without a grant. A
 * granted click on `custom-1` is HID coordinates with activation and
 * answers `unknown` (no AX-visible change); with `params.delivery: "pid"`
 * it answers `didnt` (`evidence.observableChange: false`).
 *
 * The window frame is recorded per look. A `look` carrying
 * `fixtureMutation: "resize"` moves and resizes the window first; an act
 * with a look taken before that refuses with `stale_look` ("Window frame
 * changed since look <id>; observe again", `effectPossible: false`), as the
 * helper does. S5's generation bump (`fixtureMutation:
 * "bump_root_generation"`, or its second look) still invalidates every
 * earlier look id.
 *
 * S4 types the first chunk, then holds the `typeText` act for longer than the
 * TypeScript client's timeout (see `defaultSlowHoldMs`), waking at once on
 * `cancel`; the act then fails `cancelled` with a `partial` result. With
 * `cancelBlockMs` the wake is delayed, modelling a request still inside a
 * blocking call: the cancel then acks the non-terminal `stopping` state
 * (`effectPossible: true`) and the act answers `cancelled` later.
 *
 * As in the helper: a `cancel` for an id not yet seen answers `not_found` and
 * tombstones the id (60 s, at most 256 ids), so an act that later registers
 * under it is refused at its first checkpoint (`rejected_before_delivery`).
 * Admitted owner-gated requests pin ownership until they return: TTL expiry,
 * claims by other sessions, and `release` (`owner_busy`) are refused while
 * any runs, and refusals carry `activeRequests`. Checkpoints refresh the
 * owner lease.
 *
 * Log rows: `act`/`actBatch` rows are written when answered and carry
 * `response` (the envelope without `id`); `cancel` rows carry `ack`; every
 * other request is logged on receipt.
 *
 * The fake app matches the E2E scenario prompts ("CU Fixture Target") and the
 * S6 foreground grant (`com.choco-pi.FocusFixture`).
 *
 * Shutdown: `close()` and SIGTERM/SIGINT/SIGHUP stop listening, destroy every
 * client socket, abort in-flight slow requests, and unlink the socket path;
 * the CLI exits within SHUTDOWN_DEADLINE_MS even if cleanup stalls, and also
 * exits when its parent process disappears.
 */
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
] as const;
export type FakeScript = (typeof FAKE_SCRIPTS)[number];

export interface FakeHelperDaemonOptions {
  socketPath: string;
  script: FakeScript | string;
  /**
   * NDJSON log: one line per received request. `act`/`actBatch` lines are
   * written when answered and carry `response`; cancel lines carry `ack`.
   */
  logPath?: string;
  /** Reported as `diagnostics.executablePath`; omitted when absent. */
  executablePath?: string;
  /** Protocol reported until the first `shutdown`; afterwards 7. Default 7. */
  initialProtocolVersion?: number;
  /** s4-slow-type delay before each chunk after the hold. Default 5000 ms. */
  slowChunkMs?: number;
  /** s4-slow-type hold after the first chunk. Default `defaultSlowHoldMs(text)`. */
  slowHoldMs?: number;
  /** Delay before a `cancel` wakes a held request (a blocking call). Default 0. */
  cancelBlockMs?: number;
  /** Owner lease without requests in flight. Default 30000 ms (the helper's). */
  ownerTtlMs?: number;
}

export interface FakeHelperDaemon {
  readonly socketPath: string;
  readonly script: FakeScript;
  /** Every logged request, in log order (see `logPath`). */
  readonly requests: JsonObject[];
  close(): Promise<void>;
}

export const FAKE_PROTOCOL_VERSION = 7;
export const FAKE_APP = {
  appName: "CU Fixture Target",
  bundleId: "com.choco-pi.FocusFixture",
  pid: 4242,
};
export const FAKE_WINDOW_TITLE = "CU Fixture Target";
export const CUSTOM_VIEW_REF = "custom-1";
export const CUSTOM_VIEW_NAME = "Custom View";
/** Upper bound for close() and for the CLI's signal-to-exit path. */
export const SHUTDOWN_DEADLINE_MS = 250;
/** Mirrors `COMMAND_TIMEOUT_MS` in src/bridge.ts. */
const CLIENT_COMMAND_TIMEOUT_MS = 15_000;

/**
 * The S4 hold: 10 s beyond the larger client timeout the bridge applies to a
 * typeText of this length (`act`: len*25+4000, `actBatch`: len*25+6000).
 */
export function defaultSlowHoldMs(text: string): number {
  return Math.max(CLIENT_COMMAND_TIMEOUT_MS, text.length * 25 + 6_000) + 10_000;
}
const USER_APP = { appName: "Terminal", bundleId: "com.apple.Terminal", pid: 4141 };
const WINDOW_ID = 41;
interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}
const INITIAL_FRAME: Frame = { x: 0, y: 0, w: 640, h: 480 };
/** Frame after `fixtureMutation: "resize"` (the tier-B fixture's move and shrink). */
export const RESIZED_FRAME: Frame = { x: 40, y: 30, w: 560, h: 452 };
/** Refs the helper would press through AX, and text inputs it focuses through AX. */
const PRESSABLE_REFS = new Set(["button-1"]);
const TEXT_REFS = new Set(["field-1"]);
const NO_AX_ACTION_REASON =
  "target has no accessibility action; pointer delivery needs a host foreground grant";

function framesDiffer(left: Frame, right: Frame): boolean {
  return (
    Math.abs(left.x - right.x) > 1 ||
    Math.abs(left.y - right.y) > 1 ||
    Math.abs(left.w - right.w) > 1 ||
    Math.abs(left.h - right.h) > 1
  );
}
const ROOT_REF = "fake-root-1";
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
  /** Extra fields merged into the wire `error` object. */
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

class FakeHelperState {
  readonly script: FakeScript;
  private protocolVersion: number;
  private readonly executablePath?: string;
  private readonly slowChunkMs: number;
  private readonly slowHoldMs?: number;
  private readonly cancelBlockMs: number;
  private readonly ownerTtlMs: number;
  private owner?: Session & { lastSeen: number };
  /** Admitted owner-gated requests still running; positive pins the owner. */
  private ownerActive = 0;
  private readonly active = new Map<string, Tracked>();
  private readonly completed: string[] = [];
  private readonly tombstones: { id: string; at: number }[] = [];
  private lookCount = 0;
  private lookSequence = 0;
  private generation = 1;
  private readonly validLooks = new Set<string>();
  private frame: Frame = INITIAL_FRAME;
  private readonly lookFrames = new Map<string, Frame>();
  private fieldValue = "";
  private pressCount = 0;
  private frontmost = USER_APP;
  private pendingDelta = false;

  constructor(options: FakeHelperDaemonOptions) {
    this.script = resolveFakeScript(options.script);
    this.protocolVersion = options.initialProtocolVersion ?? FAKE_PROTOCOL_VERSION;
    this.executablePath = options.executablePath;
    this.slowChunkMs = options.slowChunkMs ?? 5_000;
    this.slowHoldMs = options.slowHoldMs;
    this.cancelBlockMs = options.cancelBlockMs ?? 0;
    this.ownerTtlMs = options.ownerTtlMs ?? OWNER_TTL_MS;
  }

  async handle(request: JsonObject): Promise<JsonValue> {
    const cmd = stringField(request, "cmd") ?? "";
    const session = sessionOf(request);
    const gated = OWNER_GATED.has(cmd);
    if (gated) this.authorize(session, true);
    else if (session) this.refresh(session);
    try {
      return await this.dispatch(cmd, request, session);
    } finally {
      if (gated) this.endOwned(session);
    }
  }

  private async dispatch(
    cmd: string,
    request: JsonObject,
    session: Session | undefined,
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
        // The fake keeps running (the harness owns its lifetime); a
        // "relaunched" helper reports the current protocol and no owner.
        this.protocolVersion = FAKE_PROTOCOL_VERSION;
        this.owner = undefined;
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
        return await this.cancel(stringField(request, "target") ?? "");
      case "listApps":
        return {
          apps: [
            { ...FAKE_APP, isFrontmost: this.frontmost.pid === FAKE_APP.pid },
            { ...USER_APP, isFrontmost: this.frontmost.pid === USER_APP.pid },
          ],
        };
      case "listRoots":
      case "listWindows":
        return { roots: [this.root()] };
      case "getFrontmost":
        return this.frontmost.pid === FAKE_APP.pid
          ? { ...FAKE_APP, windowTitle: FAKE_WINDOW_TITLE, windowId: WINDOW_ID }
          : { ...USER_APP, windowTitle: "Terminal", windowId: 7 };
      case "look":
        return this.look(request);
      case "act":
        return await this.tracked([request], session, (tracked) =>
          this.act(request, false, tracked),
        );
      case "actBatch":
        return await this.tracked(this.batchActions(request), session, (tracked) =>
          this.actBatch(request, tracked),
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
        this.frontmost = FAKE_APP;
        return { focused: true };
      default:
        throw new FakeFailure("unknown_command", `Unknown command '${cmd}'`);
    }
  }

  cancelAckFor(target: string): Promise<JsonObject> {
    return this.cancel(target);
  }

  /** Stops every in-flight request at its next checkpoint and wakes sleepers. */
  shutdown(): void {
    for (const tracked of this.active.values()) {
      tracked.cancelled = true;
      tracked.wake?.();
    }
  }

  private diagnostics(): JsonObject {
    const output: JsonObject = {
      protocolVersion: this.protocolVersion,
      architectureVersion: 1,
      // Same set as the native helper; the TS client asserts the shared contract.
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
    return output;
  }

  private authorize(session: Session | undefined, pin: boolean): void {
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
    this.ownerActive = Math.max(0, this.ownerActive - 1);
    const owner = this.owner;
    if (session && owner && owner.id === session.id && owner.generation === session.generation)
      owner.lastSeen = Date.now();
  }

  private refresh(session: Session): void {
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

  private pruneTombstones(now: number): void {
    const fresh = this.tombstones.filter((tombstone) => now - tombstone.at < TOMBSTONE_TTL_MS);
    this.tombstones.splice(0, this.tombstones.length, ...fresh.slice(-TOMBSTONE_LIMIT));
  }

  private async cancel(target: string): Promise<JsonObject> {
    const tracked = this.active.get(target);
    if (!tracked) {
      const completed = this.completed.includes(target);
      if (!completed) {
        const now = Date.now();
        const kept = this.tombstones.filter((tombstone) => tombstone.id !== target);
        this.tombstones.splice(0, this.tombstones.length, ...kept, { id: target, at: now });
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
    // Non-terminal: the request may still deliver until its next checkpoint.
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
    const deadlines = requests.flatMap((request) => {
      const deadline = numberField(request, "deadlineMs");
      return deadline === undefined ? [] : [deadline];
    });
    this.pruneTombstones(Date.now());
    const tombstoned = ids.some((id) => this.tombstones.some((tombstone) => tombstone.id === id));
    const tracked: Tracked = {
      // A cancel that arrived before registration refuses the request at its
      // first checkpoint, before any delivery.
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
      if (error instanceof FakeFailure && error.effectPossible === undefined)
        throw new FakeFailure(error.code, error.message, tracked.effect, error.result);
      throw error;
    } finally {
      for (const id of ids) {
        this.active.delete(id);
        this.completed.push(id);
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

  private root(): JsonObject {
    return {
      kind: "window",
      rootRef: ROOT_REF,
      windowRef: ROOT_REF,
      windowId: WINDOW_ID,
      pid: FAKE_APP.pid,
      appName: FAKE_APP.appName,
      bundleId: FAKE_APP.bundleId,
      title: FAKE_WINDOW_TITLE,
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

  private look(request: JsonObject): JsonObject {
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
    const label =
      this.pressCount > 0
        ? `Clicked ${this.pressCount}`
        : this.generation > 1
          ? `Generation ${this.generation}`
          : "Ready";
    const customView =
      this.script === "s2-foreground-required" || this.script === "s6-grant"
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
    return {
      lookId,
      capturedAt: Date.now() / 1000,
      hasImage: false,
      window: {
        windowId: WINDOW_ID,
        rootRef: ROOT_REF,
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
    if (!this.validLooks.has(lookId))
      throw new FakeFailure("stale_look", `Look id '${lookId}' is no longer available`);
    // Like the helper: the window frame recorded at look time must still hold.
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
    // Only granted HID delivery activates the target app.
    const effect = (activates = delivery === "hid") => {
      tracked.effect = true;
      if (activates) this.frontmost = FAKE_APP;
    };
    const finish = (response: JsonObject): JsonObject => {
      if (deferred) return response;
      const output: JsonObject = {
        ...response,
        frontmostBefore,
        frontmostAfter: this.frontmost.pid,
      };
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

    const clicks = action === "click" || action === "press";
    const clicksField = clicks && ref !== undefined && TEXT_REFS.has(ref);
    // The helper's rule: a click with no AX route is refused before delivery
    // unless the request carries a foreground grant.
    const noAxAction =
      clicks && ref !== undefined && !PRESSABLE_REFS.has(ref) && !TEXT_REFS.has(ref);
    if (noAxAction && !granted)
      throw new FakeFailure("foreground_required", NO_AX_ACTION_REASON, tracked.effect);

    if (action === "setText") {
      if (ref !== "field-1")
        throw new FakeFailure("invalid_args", "setText requires the text field");
      this.checkpoint(tracked);
      effect();
      this.fieldValue = isString(params.text) ? params.text : "";
      return finish({
        outcome: "worked",
        performed: { delivery: "ax", grounding: "description" },
        evidence: { value: this.fieldValue },
      });
    }
    if (action === "typeText") {
      const text = isString(params.text) ? params.text : "";
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
        // A single act reports the chunk index it stopped at; a batch step
        // keeps the batch index.
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
          // The first chunk lands at once; then the act is held past the
          // client timeout (even for a one-chunk text). Cancel wakes it.
          if (!deferred) tracked.step = 1;
          await this.sleep(tracked, this.slowHoldMs ?? defaultSlowHoldMs(text));
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
      // Like the helper: a text-field ref click is a pid-scoped AX focus request.
      this.checkpoint(tracked);
      effect();
      return finish({
        outcome: "worked",
        performed: { delivery: "ax", grounding: "focus", focused: true },
        evidence: { focusHeld: true },
      });
    }
    if (clicks && noAxAction) {
      // Granted pointer input on a view without an AX action.
      this.checkpoint(tracked);
      effect();
      if (delivery === "hid")
        return finish({
          outcome: "unknown",
          performed: { delivery: "hid", grounding: "coordinates", activated: true },
        });
      return finish({
        outcome: "didnt",
        performed: { delivery: "pid", grounding: "coordinates", verification: "caller_required" },
        evidence: { observableChange: false },
      });
    }
    if (clicks) {
      // AXPress, granted or not: no activation.
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

  /** Sleeps up to `ms`; `cancel` and shutdown wake it at once. */
  private async sleep(tracked: Tracked, ms: number): Promise<void> {
    if (tracked.cancelled) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      tracked.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    tracked.wake = undefined;
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
        const step = await this.act(action, true, tracked);
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
      // Cancel acks are logged on the request line itself.
      try {
        const ack = await state.cancelAckFor(stringField(request, "target") ?? "");
        entry.ack = ack;
        response = { id, ok: true, result: ack };
      } catch (error) {
        response = errorEnvelope(id, error instanceof Error ? error : new Error(String(error)));
      }
      log(entry);
    } else if (request.cmd === "act" || request.cmd === "actBatch") {
      // Logged once, when answered, so scoring can attribute the outcome by
      // requestId. A cancelled act is answered before its cancel ack is
      // logged, so its line precedes the cancel line.
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
        response = { id, ok: true, result: await state.handle(request) };
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
    close() {
      // Idempotent and bounded: idle or busy client connections never hold it open.
      closing ??= (async () => {
        const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        state.shutdown();
        // Let woken requests answer and queue their log lines first.
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

/** Resolves when `promise` settles or after `ms`, whichever comes first. */
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
      "Usage: fake-helper-daemon.ts --socket <path> --script <name> [--log <jsonl>] [--executable-path <path>] [--protocol-version <n>]",
    );
  const protocolArg = argValue(args, "--protocol-version");
  let daemon: FakeHelperDaemon | undefined;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Hard deadline: exit even if cleanup stalls. process.exit ends every
    // remaining handle, including connections accepted during shutdown.
    setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS);
    const closed = daemon ? daemon.close() : unlink(socketPath).catch(() => undefined);
    void closed.finally(() => process.exit(0));
  };
  // Handlers first, so a signal during startup still unlinks and exits.
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  // A closed stdout pipe (harness gone) must not crash before cleanup.
  process.stdout.on("error", () => undefined);
  // Orphan guard: when the launching process dies we are reparented; exit.
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
