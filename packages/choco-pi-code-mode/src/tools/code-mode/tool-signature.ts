import { arr, compile, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { isJsonObject, type BoundaryValue } from "../../adapter/runtime-values.ts";

const MAX_SIGNATURE_LITERALS = 4;
const MAX_SIGNATURE_LITERAL_LENGTH = 20;
const MAX_COMPACT_PROPERTIES = 6;

const ParameterSchemaSpec = obj(
  { properties: map(unknown()), required: opt(arr(str())) },
  { open: true },
);
type ParameterSchema = Static<typeof ParameterSchemaSpec>;
const isParameterSchema = compile(ParameterSchemaSpec).check;

const PropertyLiteralSpec = obj(
  { enum: opt(arr(unknown())), anyOf: opt(arr(unknown())) },
  { open: true },
);
type PropertyNode = Static<typeof PropertyLiteralSpec>;
const isPropertyNode = compile(PropertyLiteralSpec).check;
const isConstNode = compile(obj({ const: unknown() }, { open: true })).check;

function literalList(rendered: readonly string[]): string | undefined {
  if (rendered.length === 0 || rendered.length > MAX_SIGNATURE_LITERALS) return undefined;
  if (rendered.some((value) => value.length > MAX_SIGNATURE_LITERAL_LENGTH)) return undefined;
  return rendered.join("|");
}

function propertyLiterals(property: PropertyNode): string | undefined {
  if (property.enum)
    return literalList(property.enum.map((value) => String(JSON.stringify(value))));
  if (!property.anyOf) return undefined;
  const rendered: string[] = [];
  for (const branch of property.anyOf) {
    if (!isConstNode(branch)) return undefined;
    rendered.push(String(JSON.stringify(branch.const)));
  }
  return literalList(rendered);
}

interface ParameterSignatures {
  full: string;
  compact: string;
}

const signatureCache = new WeakMap<object, ParameterSignatures | undefined>();

function computeSignatures(schema: ParameterSchema): ParameterSignatures {
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(schema.properties).map(([name, property]) => {
    const literals = isPropertyNode(property) ? propertyLiterals(property) : undefined;
    const label = required.has(name) ? name : name + "?";
    return { required: required.has(name), text: literals ? label + ":" + literals : label };
  });
  const full = entries.map((entry) => entry.text).join(", ");
  if (entries.length <= MAX_COMPACT_PROPERTIES) return { full, compact: full };
  const compact = [...entries.filter((entry) => entry.required).map((entry) => entry.text), "…"];
  return { full, compact: compact.join(", ") };
}

function cachedSignatures(schema: BoundaryValue): ParameterSignatures | undefined {
  if (!isJsonObject(schema)) return undefined;
  if (signatureCache.has(schema)) return signatureCache.get(schema);
  const signatures = isParameterSchema(schema) ? computeSignatures(schema) : undefined;
  signatureCache.set(schema, signatures);
  return signatures;
}

export function parameterSignature(schema: BoundaryValue, compact = false): string | undefined {
  const signatures = cachedSignatures(schema);
  return compact ? signatures?.compact : signatures?.full;
}

export function toolCallSignature(
  name: string,
  schema: BoundaryValue,
  compact = false,
): string | undefined {
  const signature = parameterSignature(schema, compact);
  if (signature === undefined) return undefined;
  return signature === "" ? name + "()" : name + "({" + signature + "})";
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function nameRank(given: string, candidate: string): number {
  const wanted = nameKey(given);
  const name = nameKey(candidate);
  const threshold = Math.max(2, Math.floor(wanted.length / 3));
  const distance = levenshtein(wanted, name);
  if (distance <= threshold) return distance;
  const contained = wanted.length >= 3 && (name.includes(wanted) || wanted.includes(name));
  return contained ? threshold + 1 : -1;
}

export function unknownParameterHints(schema: BoundaryValue, input: BoundaryValue): string[] {
  if (!isParameterSchema(schema) || !isJsonObject(input)) return [];
  const declared = Object.keys(schema.properties);
  const given = Object.keys(input);
  const unused = declared.filter((name) => !given.includes(name));
  return given
    .filter((key) => !declared.includes(key))
    .map((key) => {
      const nearest = unused
        .map((name) => ({ name, rank: nameRank(key, name) }))
        .filter(({ rank }) => rank >= 0)
        .sort((left, right) => left.rank - right.rank)[0];
      return nearest ? key + " → " + nearest.name : key;
    });
}
