import { isJsonObject, isString, type JsonField, type JsonObject } from "../src/json.ts";

function get(value: JsonField, key: string): JsonField {
  return isJsonObject(value) ? value[key] : undefined;
}

export function traceEntries(trace: JsonObject): JsonField[] {
  const steps = get(trace, "steps");
  return Array.isArray(steps) && steps.length ? steps : [trace];
}

export type GrantRoute = "direct" | "escalated";

export interface GrantScore {
  route?: GrantRoute;
  granted?: JsonObject;
  errors: string[];
}

const SEQUENCE =
  "expected the granted act alone, or one refused background act on the same target then the granted act";

export function grantScore(acts: JsonObject[], traces: JsonObject[]): GrantScore {
  const foreground = acts.filter((row) => row.policy === "foreground");
  const grantedCount = foreground.filter((row) => row.foregroundGrant === true).length;
  if (foreground.length !== 1 || grantedCount !== 1)
    return {
      errors: [
        `expected one granted foreground act, got ${foreground.length} foreground act(s), ${grantedCount} granted`,
      ],
    };
  const [granted] = foreground;
  const index = acts.indexOf(granted);
  const refused = acts[index - 1];
  const refusal = get(refused?.response, "error");
  const route: GrantRoute | undefined =
    acts.length === 1
      ? "direct"
      : acts.length === 2 &&
          index === 1 &&
          refused?.policy === "background" &&
          refused.foregroundGrant !== true &&
          get(refused.response, "ok") !== true &&
          get(refusal, "code") === "foreground_required" &&
          get(refusal, "effectPossible") === false &&
          get(get(refusal, "evidence"), "pidPointerAttempted") !== true &&
          JSON.stringify(refused.target) === JSON.stringify(granted.target) &&
          JSON.stringify(actionsOf(refused)) === JSON.stringify(actionsOf(granted))
        ? "escalated"
        : undefined;
  if (!route) return { granted, errors: [`${SEQUENCE}, got ${acts.length} act(s)`] };
  return { route, granted, errors: grantTraceErrors(granted, traces, route) };
}

function actionsOf(row: JsonObject): string[] {
  if (isString(row.action)) return [row.action];
  return Array.isArray(row.actions)
    ? row.actions.map((action) => get(action, "action")).filter(isString)
    : [];
}

export function grantTraceErrors(
  granted: JsonObject,
  traces: JsonObject[],
  route: GrantRoute,
): string[] {
  const id = granted.requestId;
  if (!isString(id)) return ["granted foreground act has no requestId to match a trace step"];
  const wire = get(get(granted.response, "result"), "outcome");
  if (!isString(wire)) return [`granted foreground act ${id} reply has no outcome`];
  const matches = traces.flatMap((trace) =>
    traceEntries(trace)
      .filter((entry) => get(entry, "requestId") === id)
      .map((entry) => ({ trace, entry })),
  );
  if (matches.length !== 1)
    return [`expected one trace step for the granted foreground act ${id}, got ${matches.length}`];
  const [{ trace, entry }] = matches;
  const escalated = route === "escalated";
  const expected: [string, JsonField][] = [
    ["deliveryPolicy", "foreground"],
    ["foregroundGrant", true],
    ["outcome", wire],
    ["backgroundFirst", escalated],
  ];
  const mismatches = expected.flatMap(([key, want]) => {
    const actual = get(entry, key);
    return actual === want
      ? []
      : [`step ${key} ${JSON.stringify(actual ?? null)} != ${JSON.stringify(want)}`];
  });
  const stepEscalated = get(entry, "escalatedToForeground");
  if ((stepEscalated === true) !== escalated)
    mismatches.push(
      `step escalatedToForeground ${JSON.stringify(stepEscalated ?? null)} != ${JSON.stringify(escalated)}`,
    );
  const traceOutcome = get(trace, "outcome");
  if (traceOutcome !== wire)
    mismatches.push(
      `trace outcome ${JSON.stringify(traceOutcome ?? null)} != ${JSON.stringify(wire)}`,
    );
  if ((get(trace, "escalatedToForeground") === true) !== escalated)
    mismatches.push(
      `trace escalatedToForeground ${JSON.stringify(get(trace, "escalatedToForeground") ?? null)} != ${JSON.stringify(escalated)}`,
    );
  if (!escalated && get(trace, "backgroundFirst") === true)
    mismatches.push("trace backgroundFirst true for a granted act sent to the foreground directly");
  return mismatches.length
    ? [
        `granted foreground act ${id} (${route}) trace disagrees with the wire reply: ${mismatches.join(", ")}`,
      ]
    : [];
}
