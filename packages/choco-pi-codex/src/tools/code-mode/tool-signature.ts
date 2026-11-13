/**
 * Compact call signatures for bridged Pi tools, e.g.
 * `{file_path, line, message, disposition:"false-positive"|"suppress"|"defer"|"flagged", reason?}`.
 *
 * Shared by the Code Mode prompt's tool list, the bridge's `invalid_arguments` error and
 * choco-pi's `tool_search`, so all three show the same argument names. Only top-level
 * property names are rendered, optional ones end in `?`, and a small enum of short values
 * is spelled out because a guessed spelling (`false_positive`) fails validation.
 *
 * The prompt uses the compact form: a tool with more than six properties lists its required
 * ones and then `…` (ALL_TOOLS has the rest), which keeps the list about 1.7 KB longer
 * instead of 4.5 KB for choco-pi's 55 bridged tools.
 */
import { arr, compile, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { isJsonObject, type BoundaryValue } from "../../adapter/runtime-values.ts";

const MAX_SIGNATURE_LITERALS = 4;
const MAX_SIGNATURE_LITERAL_LENGTH = 20;
const MAX_COMPACT_PROPERTIES = 6;

/** The object-schema facets a signature reads; everything else is opaque. */
const ParameterSchemaSpec = obj(
  { properties: map(unknown()), required: opt(arr(str())) },
  { open: true },
);
type ParameterSchema = Static<typeof ParameterSchemaSpec>;
const isParameterSchema = compile(ParameterSchemaSpec).check;

/** A property's literal facets: `enum`, or `anyOf` whose branches may each pin a `const`. */
const PropertyLiteralSpec = obj(
  { enum: opt(arr(unknown())), anyOf: opt(arr(unknown())) },
  { open: true },
);
type PropertyNode = Static<typeof PropertyLiteralSpec>;
const isPropertyNode = compile(PropertyLiteralSpec).check;
const isConstNode = compile(obj({ const: unknown() }, { open: true })).check;

/** `"a"|"b"` for at most four short literals (already JSON-rendered); otherwise undefined. */
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

/**
 * The top-level parameter list of an object schema without braces (`""` when it has no
 * properties), or undefined when the schema declares no property map. Memoized per schema
 * object: the prompt is rebuilt often and must stay byte-stable. `compact` applies the
 * prompt's cap for tools with more than six properties.
 */
export function parameterSignature(schema: BoundaryValue, compact = false): string | undefined {
  const signatures = cachedSignatures(schema);
  return compact ? signatures?.compact : signatures?.full;
}

/** `name({a, b?})`, `name()` for no parameters, or undefined when the schema is opaque. */
export function toolCallSignature(
  name: string,
  schema: BoundaryValue,
  compact = false,
): string | undefined {
  const signature = parameterSignature(schema, compact);
  if (signature === undefined) return undefined;
  return signature === "" ? name + "()" : name + "({" + signature + "})";
}

/** Names compared ignoring case and separators, so `filePath` matches `file_path`. */
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

/**
 * Rank of a parameter name for a given key, nearest first; -1 when it is not close. A small
 * edit distance wins over containment, so `path` finds `file_path` but not `line`.
 */
function nameRank(given: string, candidate: string): number {
  const wanted = nameKey(given);
  const name = nameKey(candidate);
  const threshold = Math.max(2, Math.floor(wanted.length / 3));
  const distance = levenshtein(wanted, name);
  if (distance <= threshold) return distance;
  const contained = wanted.length >= 3 && (name.includes(wanted) || wanted.includes(name));
  return contained ? threshold + 1 : -1;
}

/**
 * One entry per input key the schema does not declare: `path → file_path` when a declared
 * name the input left out is close, otherwise the bare key. Empty for opaque schemas.
 */
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
