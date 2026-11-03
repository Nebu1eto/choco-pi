import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compile, int, lit, obj, str } from "@earendil-works/pi-schema";
import type { Schema } from "@earendil-works/pi-schema";
import type { RuntimeValue } from "../../../.pi/extensions/lib/runtime-values.ts";
import { isArray, isBoolean, isNumber, isRecord, isString, matches } from "./schema-check.ts";

/** Decoded-JSON values: what an artifact file can hold. */
export type ArtifactValue =
  | null
  | boolean
  | number
  | string
  | ArtifactValue[]
  | { [key: string]: ArtifactValue };
/** Recorder input: JSON plus `undefined` (dropped on serialisation). */
export type ArtifactInput =
  | undefined
  | null
  | boolean
  | number
  | string
  | ArtifactInput[]
  | { [key: string]: ArtifactInput };

// Raw $defs/$ref schemas: pi-schema builders cannot express recursion. Numbers are bounded to
// reject NaN/Infinity as the previous schema library's number check did.
const finiteNumber = { type: "number", minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE };
const JSON_DEF = {
  Json: {
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      finiteNumber,
      { type: "string" },
      { type: "array", items: { $ref: "#/$defs/Json" } },
      { type: "object", additionalProperties: { $ref: "#/$defs/Json" } },
    ],
  },
};
export const JsonSchema: Schema<ArtifactValue> = { $ref: "#/$defs/Json", $defs: JSON_DEF };
/**
 * JSON-only recursion for embedding in object schemas. `undefined` is not JSON, so it is only
 * accepted by `isArtifactInput`; this schema is used on payloads decoded from JSON text.
 */
const INPUT_DEF = {
  Input: {
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      finiteNumber,
      { type: "string" },
      { type: "array", items: { $ref: "#/$defs/Input" } },
      { type: "object", additionalProperties: { $ref: "#/$defs/Input" } },
    ],
  },
};
export const InputSchema: Schema<ArtifactInput> = { $ref: "#/$defs/Input", $defs: INPUT_DEF };

/**
 * Hoists the recursive `$defs` of `JsonSchema`/`InputSchema` onto a schema that embeds them.
 * pi-schema resolves `#/$defs/...` against the compiled root, so an embedded
 * `InputSchema` inside `obj({...})` fails with "Unresolved $ref" unless the
 * root carries the definitions (observed on the live Anthropic transport).
 */
export function withArtifactDefs<S extends object>(schema: S): S {
  return { ...schema, $defs: { ...JSON_DEF, ...INPUT_DEF } };
}

/** Whether `value` is `ArtifactInput`: JSON recursion plus `undefined` anywhere. */
export function isArtifactInput(value: RuntimeValue): value is ArtifactInput {
  if (value === undefined || value === null || isBoolean(value) || isNumber(value)) return true;
  if (isString(value)) return true;
  if (isArray(value)) return value.every(isArtifactInput);
  return isArtifactRecord(value);
}

/** Whether `value` is an object whose every value is `ArtifactInput`. */
export function isArtifactRecord(value: RuntimeValue): value is { [key: string]: ArtifactInput } {
  return isRecord(value) && Object.values(value).every(isArtifactInput);
}

const isArtifactJson = compile(JsonSchema).check;

/** Replaces the old `Value.Parse(JsonSchema, v)`: assertion only (no defaults or conversion applied). */
export function parseArtifactValue(value: RuntimeValue): ArtifactValue {
  if (!isArtifactJson(value)) throw new Error("Non-JSON artifact value");
  return value;
}

/**
 * Replaces the old `Value.Parse(InputSchema, v)`: assertion only. Its Clean/Convert/Default
 * steps were identities for this open, default-free schema.
 */
export function parseArtifactInput(value: RuntimeValue): ArtifactInput {
  if (!isArtifactInput(value)) throw new Error("Non-serializable artifact input");
  return value;
}

const sensitiveKey =
  /signature|ciphertext|encrypted|authorization|credential|api.?key|access.?token|refresh.?token|cookie|headers/i;
const RedactionSchema = obj({
  redacted: lit(true),
  sha256: str({ pattern: "^[a-f0-9]{64}$" }),
  bytes: int({ minimum: 0 }),
});
const sensitiveText = /\bsk-[A-Za-z0-9_-]+|Bearer\s+\S+|-----BEGIN .*PRIVATE KEY-----/i;
export function digest(text: string) {
  return {
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
  };
}
/** Redact BEFORE values enter the recorder; protected session storage is never copied verbatim. */
export function redact(
  value: ArtifactInput,
  protectedStrings: readonly string[] = [],
): ArtifactValue {
  if (!isArtifactInput(value)) throw new Error("Non-serializable artifact input");
  if (value === null || value === undefined) return null;
  if (isString(value))
    return sensitiveText.test(value) ||
      protectedStrings.some((secret) => secret.length > 0 && value.includes(secret))
      ? { redacted: true, ...digest(value) }
      : value;
  if (isBoolean(value) || isNumber(value)) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, protectedStrings));
  const result: Record<string, ArtifactValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key) && key.endsWith("Redacted") && matches(RedactionSchema, item))
      result[key] = { redacted: true, sha256: item.sha256, bytes: item.bytes };
    else if (sensitiveKey.test(key)) {
      const serialized = isString(item) ? item : (JSON.stringify(item) ?? "");
      result[`${key}Redacted`] = { redacted: true, ...digest(serialized) };
    } else result[key] = redact(item, protectedStrings);
  }
  return result;
}
export function artifactLeaks(
  value: ArtifactInput,
  path = "$",
  knownSecrets: readonly string[] = [],
): string[] {
  if (!matches(JsonSchema, value)) return [`${path}:invalid-json`];
  if (isString(value))
    return sensitiveText.test(value) ||
      knownSecrets.some((secret) => secret.length > 0 && value.includes(secret))
      ? [path]
      : [];
  if (Array.isArray(value))
    return value.flatMap((item, index) => artifactLeaks(item, `${path}[${index}]`, knownSecrets));
  if (value === null || isBoolean(value) || isNumber(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    sensitiveKey.test(key) && !(key.endsWith("Redacted") && matches(RedactionSchema, item))
      ? [`${path}.${key}`]
      : artifactLeaks(item, `${path}.${key}`, knownSecrets),
  );
}
export async function writeArtifact(
  dir: string,
  filename: string,
  value: ArtifactInput,
): Promise<void> {
  if (!isArtifactInput(value)) throw new Error("Non-serializable artifact input");
  const safe = redact(value);
  if (!matches(JsonSchema, safe) || artifactLeaks(safe).length > 0)
    throw new Error("Artifact validation failed");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, filename), `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
}
export interface EvidenceRecord {
  sequence: number;
  elapsedMs: number;
  kind: string;
  data: ArtifactValue;
}
export class Recorder {
  readonly records: EvidenceRecord[] = [];
  private readonly started = performance.now();
  readonly #protectedStrings: readonly string[];
  constructor(protectedStrings: readonly string[] = []) {
    this.#protectedStrings = [...protectedStrings];
  }
  record(kind: string, data: ArtifactInput): number {
    if (!isArtifactInput(data)) throw new Error("Non-serializable recorder input");
    const sequence = this.records.length;
    this.records.push({
      sequence,
      elapsedMs: performance.now() - this.started,
      kind,
      data: redact(data, this.#protectedStrings),
    });
    return sequence;
  }
}

/** A coordinator status as recorder input: readonly failure rows become plain JSON rows. */
export function statusArtifact(status: {
  readonly recentFailures?: readonly {
    readonly candidateId: string;
    readonly backendId: string;
    readonly reason: string;
    readonly detail: string | null;
    readonly at: number;
  }[];
}): ArtifactInput {
  const { recentFailures, ...rest } = status;
  return { ...rest, recentFailures: (recentFailures ?? []).map((row) => ({ ...row })) };
}
