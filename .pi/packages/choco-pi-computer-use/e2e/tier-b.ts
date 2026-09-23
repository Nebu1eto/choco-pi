import { isJsonObject, isNumber, isString, type JsonField, type JsonObject } from "../src/json.ts";
import type { RecordValue } from "./assertions.ts";
import { grantTraceErrors } from "./grant.ts";
import type { ScenarioId } from "./scenarios/index.ts";

/** Fixture evidence for one tier-B scenario; `start`/`end` bracket the Pi process. */
export interface FixtureEvidence {
  target: RecordValue[];
  holder: RecordValue[];
  start: number;
  end: number;
  targetPid?: number;
}

/** Informational tier-B evidence recorded in `summary.json`; never a verdict on its own. */
export interface TierBNotes {
  finalField?: { length: number; value?: string };
  increments?: number;
  customHits?: number;
  holderDisturbances: string[];
  /** S3: whether the single typeText worked in the background or was reported as didnt. */
  typingPath?: "worked" | "didnt";
  /** Acts before the scored typeText (S3), for example a click on the field. */
  priorActs?: number;
  /** S4: who sent the cancel (`pi` transport or the harness proxy) and the helper's ack. */
  cancel?: { origin: string; state: string; ackAt?: number; typedBeforeAck: number };
  /** S5: which layer refused the stale action. */
  staleRefusal?: "stale_look";
  /** act_ui "Effect not verified for action N (<action>: <outcome>)" entries, in result order. */
  unverifiedEffects?: { index: number; action: string; outcome: string }[];
  /** S6: the granted foreground act's outcome (`worked`, or `unknown` for HID delivery). */
  grantedOutcome?: string;
}

export interface TierBInput {
  /** Every proxy row (Pi requests and harness cancels) in arrival order. */
  requests: RecordValue[];
  traces: JsonObject[];
  /** Persisted act_ui toolResult messages. */
  results: JsonField[];
  fixture?: FixtureEvidence;
  intervention?: RecordValue;
  noDispatch: boolean;
}

export interface TierBScore {
  errors: string[];
  notes: TierBNotes;
  inconclusive?: Inconclusive;
}
export type Inconclusive = "no_dispatch" | "no_effect_observed";

const EXPECTED_TEXT = "hello-e2e";
/** S4: field changes this long after the cancel ack count as input after cancellation. */
const ACK_SLACK_MS = 50;
/** S5: the helper's window-frame staleness refusal (bridge.swift `act`, before target resolution). */
const FRAME_STALE_TEXT = /^Window frame changed since look \S+; observe again$/;
/** act_ui text for executed actions whose effect the helper could not verify (src/bridge.ts). */
const UNVERIFIED_TEXT = /Effect not verified for (.+?); confirm it in the returned state/;
const UNVERIFIED_ENTRY = /^action (\d+) \((\w+): (\w+)\)$/;

function get(value: JsonField, key: string): JsonField {
  return isJsonObject(value) ? value[key] : undefined;
}
function num(value: JsonField): number | undefined {
  return isNumber(value) ? value : undefined;
}
function isAct(row: RecordValue): boolean {
  return (row.cmd === "act" || row.cmd === "actBatch") && row.origin !== "harness";
}
function actions(row: RecordValue): string[] {
  if (isString(row.action)) return [row.action];
  return Array.isArray(row.actions)
    ? row.actions.map((action) => get(action, "action")).filter(isString)
    : [];
}
function inWindow(row: RecordValue, from: number, to: number): boolean {
  const ts = num(row.ts);
  return ts !== undefined && ts >= from && ts <= to;
}
function resultText(message: JsonField): string {
  const content = get(message, "content");
  return Array.isArray(content)
    ? content
        .map((part) => get(part, "text"))
        .filter(isString)
        .join("\n")
    : "";
}

/**
 * Parses every "Effect not verified" entry from the act_ui results. Returns undefined when a
 * matching sentence has an entry this parser does not understand, so callers fail closed.
 */
export function unverifiedEffects(results: JsonField[]): TierBNotes["unverifiedEffects"] {
  const entries: NonNullable<TierBNotes["unverifiedEffects"]> = [];
  for (const message of results) {
    const listed = UNVERIFIED_TEXT.exec(resultText(message))?.[1];
    if (listed === undefined) continue;
    for (const part of listed.split(", ")) {
      const match = UNVERIFIED_ENTRY.exec(part);
      if (!match) return undefined;
      entries.push({ index: Number(match[1]), action: match[2], outcome: match[3] });
    }
  }
  return entries;
}

/** Holder focus loss, keystrokes, or another app becoming frontmost inside [from, to]. */
export function holderDisturbances(fixture: FixtureEvidence, from: number, to: number): string[] {
  return fixture.holder
    .filter((row) => inWindow(row, from, to))
    .flatMap((row) => {
      if (row.event === "appInactive" || row.event === "windowResignKey" || row.event === "keyDown")
        return [`${String(row.event)}@${String(row.ts)}`];
      if (row.event === "frontmost" && row.bundleId !== "com.choco-pi.FocusHolder")
        return [`frontmost ${String(row.bundleId)}@${String(row.ts)}`];
      return [];
    });
}

/** The target's final state from its `quitting` row. */
export function finalState(
  fixture: FixtureEvidence,
): Pick<TierBNotes, "finalField" | "increments" | "customHits"> {
  const quit = fixture.target.findLast((row) => row.event === "quitting");
  if (!quit) return {};
  const length = num(quit.length) ?? 0;
  return {
    finalField: isString(quit.value) ? { length, value: quit.value } : { length },
    increments: num(quit.increments),
    customHits: num(quit.customHits),
  };
}

function fieldChangesAfter(fixture: FixtureEvidence, ts: number): RecordValue[] {
  return fixture.target.filter(
    (row) =>
      (row.event === "fieldValue" || row.event === "increment" || row.event === "customHit") &&
      (num(row.ts) ?? 0) > ts,
  );
}

function scoreS3(input: TierBInput, notes: TierBNotes, errors: string[]): void {
  const acts = input.requests.filter(isAct);
  const typing = acts.filter((row) => actions(row).includes("typeText"));
  if (typing.length !== 1) {
    errors.push(`expected exactly one typeText act request, got ${typing.length}`);
    return;
  }
  const [typed] = typing;
  notes.priorActs = acts.indexOf(typed);
  if (acts.slice(acts.indexOf(typed) + 1).length) errors.push("act request after typeText (retry)");
  const response = typed.response;
  const outcome = get(get(response, "result"), "outcome");
  const value = notes.finalField?.value;
  if (get(response, "ok") === true && outcome === "worked") {
    notes.typingPath = "worked";
    if (value !== EXPECTED_TEXT)
      errors.push(`typeText worked but field is ${JSON.stringify(value ?? notes.finalField)}`);
    return;
  }
  const refused =
    outcome === "didnt" || get(get(response, "error"), "code") === "foreground_required";
  const structured = input.results.some((message) => {
    const details = get(message, "details");
    return (
      get(details, "status") === "foreground_required" ||
      get(get(get(details, "execution"), "refusal"), "code") === "foreground_required"
    );
  });
  if (!refused || !structured) {
    errors.push("typeText neither worked nor returned a structured didnt refusal");
    return;
  }
  notes.typingPath = "didnt";
  if (value?.includes(EXPECTED_TEXT)) errors.push("didnt reported although the field changed");
}

function scoreS4(input: TierBInput, notes: TierBNotes, errors: string[]): Inconclusive | undefined {
  const fixture = input.fixture;
  const typed = input.requests.find((row) => isAct(row) && actions(row).includes("typeText"));
  const id = typed?.requestId;
  if (!typed || !isString(id)) {
    errors.push("no typeText act request with a requestId");
    return undefined;
  }
  const cancel = input.requests.find(
    (row) =>
      row.cmd === "cancel" && row.target === id && (num(row.seq) ?? 0) > (num(typed.seq) ?? 0),
  );
  if (!cancel) {
    errors.push("missing cancel for the typeText act");
    return undefined;
  }
  const ack = cancel.ack;
  const state = get(ack, "state");
  const actCancelled = get(get(typed.response, "error"), "code") === "cancelled";
  if (
    get(ack, "acknowledged") !== true ||
    !(state === "stopped" || (state === "stopping" && actCancelled))
  )
    errors.push(`cancel not acknowledged as stopped (state ${String(state)})`);
  if (!actCancelled) errors.push("typeText act not answered as cancelled");
  if (input.requests.some((row) => isAct(row) && (num(row.seq) ?? 0) > (num(cancel.seq) ?? 0)))
    errors.push("act request after cancel");
  const worked = input.traces.some((trace) =>
    [trace, ...(Array.isArray(trace.steps) ? trace.steps : [])].some(
      (entry) => get(entry, "requestId") === id && get(entry, "outcome") === "worked",
    ),
  );
  if (worked) errors.push("cancelled typeText reported as worked");
  const ackAt = num(cancel.respondedAt);
  if (!fixture || ackAt === undefined) {
    errors.push("cancel ack time or fixture evidence missing");
    return undefined;
  }
  const typedBeforeAck = fixture.target.filter(
    (row) => row.event === "fieldValue" && (num(row.ts) ?? 0) <= ackAt,
  ).length;
  notes.cancel = {
    origin: isString(cancel.origin) ? cancel.origin : "unknown",
    state: String(state),
    ackAt,
    typedBeforeAck,
  };
  const late = fieldChangesAfter(fixture, ackAt + ACK_SLACK_MS);
  if (late.length)
    errors.push(
      `fixture changed ${late.length} time(s) after the cancel ack (+${ACK_SLACK_MS} ms)`,
    );
  // Nothing typed before the ack makes "no input after the ack" vacuous.
  return typedBeforeAck === 0 ? "no_effect_observed" : undefined;
}

function scoreS5(input: TierBInput, notes: TierBNotes, errors: string[]): void {
  const mutation = input.intervention;
  const at = num(mutation?.at);
  const requestedAt = num(mutation?.requestedAt);
  if (mutation?.ok !== true || at === undefined || requestedAt === undefined) {
    errors.push("fixture mutation not acknowledged");
    return;
  }
  const acts = input.requests.filter(isAct);
  if (acts.some((row) => (num(row.at) ?? 0) < requestedAt))
    errors.push("act before the fixture mutation (harness race)");
  const after = acts.filter((row) => (num(row.at) ?? 0) >= requestedAt);
  // The resize is out of band: only the helper's frame check can see it, so exactly one act
  // follows the mutation and the helper refuses it before delivery as a frame change.
  const error = get(after[0]?.response, "error");
  const message = get(error, "message");
  const staleLook =
    after.length === 1 &&
    get(after[0].response, "ok") !== true &&
    get(error, "code") === "stale_look" &&
    get(error, "effectPossible") === false &&
    isString(message) &&
    FRAME_STALE_TEXT.test(message);
  if (staleLook) notes.staleRefusal = "stale_look";
  else {
    const delivered = after.filter((row) => get(row.response, "ok") === true).length;
    errors.push(
      `stale action not refused as a window-frame stale_look: ${after.length} act(s) after the mutation, ${delivered} answered ok, error ${JSON.stringify(error ?? null)}`,
    );
  }
  if (input.fixture) {
    const changed = fieldChangesAfter(input.fixture, at);
    if (changed.length)
      errors.push(
        `fixture changed after the mutation (${changed.map((row) => String(row.event)).join(",")})`,
      );
  }
}

function scoreS6(input: TierBInput, notes: TierBNotes, errors: string[]): void {
  const acts = input.requests.filter(isAct);
  const foreground = acts.filter((row) => row.policy === "foreground");
  if (foreground.length !== 1 || foreground[0].foregroundGrant !== true) {
    errors.push(`expected one granted foreground act, got ${foreground.length}`);
    return;
  }
  const [granted] = foreground;
  // Exactly: one ungranted background act refused before delivery, then the granted retry.
  const refused = acts[acts.indexOf(granted) - 1];
  const refusal = get(refused?.response, "error");
  if (
    acts.length !== 2 ||
    acts[1] !== granted ||
    refused?.policy !== "background" ||
    refused.foregroundGrant === true ||
    get(refused.response, "ok") === true ||
    get(refusal, "code") !== "foreground_required" ||
    get(refusal, "effectPossible") !== false ||
    JSON.stringify(refused.target) !== JSON.stringify(granted.target) ||
    JSON.stringify(actions(refused)) !== JSON.stringify(actions(granted))
  )
    errors.push(
      `expected a refused background act on the same target then the granted act, got ${acts.length} act(s)`,
    );
  const result = get(granted.response, "result");
  const outcome = get(result, "outcome");
  if (isString(outcome)) notes.grantedOutcome = outcome;
  // HID delivery cannot attest its effect (`unknown`); the fixture's customHits is the proof.
  if (get(granted.response, "ok") !== true || (outcome !== "worked" && outcome !== "unknown"))
    errors.push(`granted foreground act answered ${String(outcome)}`);
  // The execution trace must agree with the wire: escalated, granted, foreground, same outcome.
  errors.push(...grantTraceErrors(granted, input.traces));
  const pid = input.fixture?.targetPid;
  if (pid === undefined || num(get(result, "frontmostAfter")) !== pid)
    errors.push(`frontmostAfter ${String(get(result, "frontmostAfter"))} is not the target ${pid}`);
  if (notes.customHits !== 1) errors.push(`custom-view hits ${String(notes.customHits)} != 1`);
  // The refused background act must have had no effect and must not have disturbed the holder:
  // every custom-view hit and holder focus loss comes at or after the granted act. The holder
  // never receives input in S6: a keyDown or fieldValue on it at any time fails.
  const grantedAt = num(granted.at);
  if (grantedAt === undefined) errors.push("granted foreground act has no timestamp");
  const early = (rows: RecordValue[] | undefined, events: string[]): RecordValue[] =>
    (rows ?? []).filter(
      (row) =>
        isString(row.event) &&
        events.includes(row.event) &&
        (grantedAt === undefined || (num(row.ts) ?? Number.NEGATIVE_INFINITY) < grantedAt),
    );
  const label = (rows: RecordValue[]): string =>
    rows.map((row) => `${String(row.event)}@${String(row.ts)}`).join(", ");
  if (early(input.fixture?.target, ["customHit"]).length)
    errors.push("custom-view hit before the granted foreground act");
  const resigned = early(input.fixture?.holder, ["appInactive", "windowResignKey"]);
  if (resigned.length)
    errors.push(`holder resigned active before the granted foreground act: ${label(resigned)}`);
  const typed = (input.fixture?.holder ?? []).filter(
    (row) => row.event === "keyDown" || row.event === "fieldValue",
  );
  if (typed.length) errors.push(`holder received input: ${label(typed)}`);
  if (
    !input.fixture?.holder.some(
      (row) =>
        row.event === "appInactive" &&
        inWindow(row, input.fixture?.start ?? 0, input.fixture?.end ?? 0),
    )
  )
    errors.push("foreground path ran but the holder never resigned active");
}

/**
 * Tier-B assertions over the proxy request log and the fixture logs. The tier-agnostic checks in
 * `verify` (dispatch attribution, headless config, S1 per-step delivery, S2 refusal) still apply.
 */
export function scoreTierB(scenario: ScenarioId, input: TierBInput): TierBScore {
  const errors: string[] = [];
  const fixture = input.fixture;
  const notes: TierBNotes = { holderDisturbances: [] };
  if (!fixture) return { errors: ["fixture evidence missing"], notes };
  Object.assign(notes, finalState(fixture));
  if (notes.finalField === undefined) errors.push("fixture final state missing");
  notes.holderDisturbances = holderDisturbances(fixture, fixture.start, fixture.end);
  if (scenario !== "S6" && notes.holderDisturbances.length)
    errors.push(`holder disturbed: ${notes.holderDisturbances.join(", ")}`);
  const acts = input.requests.filter(isAct);
  if (scenario !== "S6") {
    if (acts.some((row) => row.policy !== "background" && row.policy !== "ax_only"))
      errors.push("non-background act request");
    for (const row of acts) {
      const result = get(row.response, "result");
      const before = get(result, "frontmostBefore");
      if (before !== undefined && before !== get(result, "frontmostAfter"))
        errors.push(`helper frontmost changed on ${String(row.requestId)}`);
    }
  }
  if (input.noDispatch && scenario !== "S5") return { errors, notes, inconclusive: "no_dispatch" };
  let inconclusive: Inconclusive | undefined;
  if (scenario === "S1") {
    if (notes.finalField?.value !== EXPECTED_TEXT)
      errors.push(`field is ${JSON.stringify(notes.finalField)}, expected ${EXPECTED_TEXT}`);
    if (notes.increments !== 1) errors.push(`increments ${String(notes.increments)} != 1`);
    if (notes.customHits !== 0) errors.push(`custom-view hits ${String(notes.customHits)} != 0`);
    // The helper cannot attest an AXPress effect, so the Increment press (or a click on it) may
    // be reported as "Effect not verified (press: unknown)"; the fixture's field and counter are
    // the proof. Any other unverified entry (a didnt, or unverified typing) fails.
    const unverified = unverifiedEffects(input.results);
    if (unverified === undefined) errors.push("unparseable 'Effect not verified' text");
    else {
      notes.unverifiedEffects = unverified;
      for (const entry of unverified)
        if (!["press", "click"].includes(entry.action) || entry.outcome !== "unknown")
          errors.push(
            `unexpected unverified effect: action ${entry.index} (${entry.action}: ${entry.outcome})`,
          );
    }
  }
  if (scenario === "S2" && notes.customHits !== 0)
    errors.push(`custom-view hits ${String(notes.customHits)} != 0`);
  if (scenario === "S3") scoreS3(input, notes, errors);
  if (scenario === "S4") inconclusive = scoreS4(input, notes, errors);
  if (scenario === "S5") scoreS5(input, notes, errors);
  if (scenario === "S6") scoreS6(input, notes, errors);
  return inconclusive ? { errors, notes, inconclusive } : { errors, notes };
}
