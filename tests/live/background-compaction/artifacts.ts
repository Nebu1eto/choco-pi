import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const JsonSchema = Type.Cyclic(
  {
    Json: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("Json")),
      Type.Record(Type.String(), Type.Ref("Json")),
    ]),
  },
  "Json",
);
export const InputSchema = Type.Cyclic(
  {
    Input: Type.Union([
      Type.Undefined(),
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("Input")),
      Type.Record(Type.String(), Type.Ref("Input")),
    ]),
  },
  "Input",
);
export type ArtifactValue = Static<typeof JsonSchema>;
export type ArtifactInput = Static<typeof InputSchema>;

const sensitiveKey =
  /signature|ciphertext|encrypted|authorization|credential|api.?key|access.?token|refresh.?token|cookie|headers/i;
const RedactionSchema = Type.Object(
  {
    redacted: Type.Literal(true),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    bytes: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
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
  if (!Value.Check(InputSchema, value)) throw new Error("Non-serializable artifact input");
  if (value === null || value === undefined) return null;
  if (Value.Check(Type.String(), value))
    return sensitiveText.test(value) ||
      protectedStrings.some((secret) => secret.length > 0 && value.includes(secret))
      ? { redacted: true, ...digest(value) }
      : value;
  if (Value.Check(Type.Boolean(), value) || Value.Check(Type.Number(), value)) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, protectedStrings));
  const result: Record<string, ArtifactValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key) && key.endsWith("Redacted") && Value.Check(RedactionSchema, item))
      result[key] = { redacted: true, sha256: item.sha256, bytes: item.bytes };
    else if (sensitiveKey.test(key)) {
      const serialized = Value.Check(Type.String(), item) ? item : (JSON.stringify(item) ?? "");
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
  if (!Value.Check(JsonSchema, value)) return [`${path}:invalid-json`];
  if (Value.Check(Type.String(), value))
    return sensitiveText.test(value) ||
      knownSecrets.some((secret) => secret.length > 0 && value.includes(secret))
      ? [path]
      : [];
  if (Array.isArray(value))
    return value.flatMap((item, index) => artifactLeaks(item, `${path}[${index}]`, knownSecrets));
  if (value === null || Value.Check(Type.Boolean(), value) || Value.Check(Type.Number(), value))
    return [];
  return Object.entries(value).flatMap(([key, item]) =>
    sensitiveKey.test(key) && !(key.endsWith("Redacted") && Value.Check(RedactionSchema, item))
      ? [`${path}.${key}`]
      : artifactLeaks(item, `${path}.${key}`, knownSecrets),
  );
}
export async function writeArtifact(
  dir: string,
  filename: string,
  value: ArtifactInput,
): Promise<void> {
  if (!Value.Check(InputSchema, value)) throw new Error("Non-serializable artifact input");
  const safe = redact(value);
  if (!Value.Check(JsonSchema, safe) || artifactLeaks(safe).length > 0)
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
    if (!Value.Check(InputSchema, data)) throw new Error("Non-serializable recorder input");
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
