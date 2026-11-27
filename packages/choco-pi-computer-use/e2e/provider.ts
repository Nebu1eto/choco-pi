import { isJsonObject, isString, type JsonField } from "../src/json.ts";
import type { RecordValue } from "./assertions.ts";

export type EnvironmentBlock = "capacity" | "provider-auth";

const CAPACITY = /capacity|rate.limit|overload|429|529/i;
const AUTH_FAILURE =
  /OAuth refresh failed|invalid_grant|authentication_error|invalid[ _-]?api[ _-]?key|\b401\b|unauthorized|not authenticated|no api key/i;

function get(value: JsonField, key: string): JsonField {
  return isJsonObject(value) ? value[key] : undefined;
}

function providerErrors(events: RecordValue[]): JsonField[] {
  return events
    .filter((event) => event.type === "message_end")
    .map((event) => event.message)
    .filter((message) => get(message, "stopReason") === "error");
}

export async function environmentBlock(input: {
  code: number | null;
  stderr: string;
  events: RecordValue[];
  requests: () => Promise<RecordValue[]>;
}): Promise<EnvironmentBlock | undefined> {
  const errors = providerErrors(input.events);
  if (
    (input.code !== 0 && CAPACITY.test(input.stderr)) ||
    errors.some((message) => CAPACITY.test(JSON.stringify(message)))
  )
    return "capacity";
  const auth = errors.some((message) => {
    const text = get(message, "errorMessage");
    return isString(text) && AUTH_FAILURE.test(text);
  });
  if (!auth) return undefined;
  const helperRequests = (await input.requests()).filter((row) => row.origin !== "harness");
  return helperRequests.length === 0 ? "provider-auth" : undefined;
}
