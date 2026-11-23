import { isJsonObject, isString, type JsonField, type JsonObject } from "../src/json.ts";

function get(value: JsonField, key: string): JsonField {
  return isJsonObject(value) ? value[key] : undefined;
}

export function traceEntries(trace: JsonObject): JsonField[] {
  const steps = get(trace, "steps");
  return Array.isArray(steps) && steps.length ? steps : [trace];
}

export function grantTraceErrors(granted: JsonObject, traces: JsonObject[]): string[] {
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
  const expected: [string, JsonField][] = [
    ["escalatedToForeground", true],
    ["deliveryPolicy", "foreground"],
    ["foregroundGrant", true],
    ["outcome", wire],
  ];
  const mismatches = expected.flatMap(([key, want]) => {
    const actual = get(entry, key);
    return actual === want
      ? []
      : [`step ${key} ${JSON.stringify(actual ?? null)} != ${JSON.stringify(want)}`];
  });
  const traceOutcome = get(trace, "outcome");
  if (traceOutcome !== wire)
    mismatches.push(
      `trace outcome ${JSON.stringify(traceOutcome ?? null)} != ${JSON.stringify(wire)}`,
    );
  return mismatches.length
    ? [`granted foreground act ${id} trace disagrees with the wire reply: ${mismatches.join(", ")}`]
    : [];
}
