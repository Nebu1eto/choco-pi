import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";

// Pi's extension loader exposes pi-ai root modules, not api/* subpaths.
// Keep aligned with pi-ai src/api/constrained-sampling.ts.
const JsonSchemaValueSchema = Type.Union([
  Type.Record(Type.String(), Type.Unknown()),
  Type.Array(Type.Unknown()),
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  Type.Undefined(),
]);
type JsonSchemaValue = import("typebox").Static<typeof JsonSchemaValueSchema>;
type JsonSchemaProperty = JsonSchemaObject | undefined;
interface JsonSchemaObject {
  [key: string]: JsonSchemaValue;
  type?: JsonSchemaValue;
  properties?: Record<string, JsonSchemaProperty>;
  required?: JsonSchemaValue;
  items?: JsonSchemaValue;
  anyOf?: JsonSchemaValue;
  additionalProperties?: JsonSchemaValue;
  const?: JsonSchemaValue;
  enum?: JsonSchemaValue;
}

const JsonSchemaObjectSchema = Type.Unsafe<JsonSchemaObject>({ type: "object" });
const StringSchema = Type.String();
const StringArraySchema = Type.Array(StringSchema);

class UnsupportedStrictJsonSchemaError extends Error {}

const UNSUPPORTED_STRICT_SCHEMA_KEYS = [
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "oneOf",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "prefixItems",
  "not",
  "if",
  "then",
  "else",
] as const;

function isJsonSchemaObject<T>(value: T): value is Extract<T, object> & JsonSchemaObject {
  return Check(JsonSchemaObjectSchema, value);
}

function isStructuredSchema<T>(schema: T): boolean {
  if (!isJsonSchemaObject(schema)) return false;
  const types = Check(StringSchema, schema.type)
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type
      : [];
  return (
    types.includes("object") ||
    types.includes("array") ||
    schema.properties !== undefined ||
    schema.items !== undefined
  );
}

function schemaAllowsNull<T>(schema: T): boolean {
  if (!isJsonSchemaObject(schema)) return false;
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")))
    return true;
  if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null)))
    return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some((variant) => schemaAllowsNull(variant));
}

function makeJsonSchemaNodeStrict<T>(schema: T): void {
  if (!isJsonSchemaObject(schema)) {
    throw new UnsupportedStrictJsonSchemaError("boolean schemas are unsupported");
  }
  for (const key of UNSUPPORTED_STRICT_SCHEMA_KEYS) {
    if (schema[key] !== undefined) {
      throw new UnsupportedStrictJsonSchemaError(`${key} schemas are unsupported`);
    }
  }

  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      throw new UnsupportedStrictJsonSchemaError("anyOf must contain at least one schema");
    }
    for (const variant of schema.anyOf) {
      if (isStructuredSchema(variant)) {
        throw new UnsupportedStrictJsonSchemaError("object and array unions are unsupported");
      }
      makeJsonSchemaNodeStrict(variant);
    }
  }

  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      throw new UnsupportedStrictJsonSchemaError("tuple schemas are unsupported");
    }
    makeJsonSchemaNodeStrict(schema.items);
  }

  const isObjectSchema = schema.type === "object";
  if (schema.properties !== undefined && !isObjectSchema) {
    throw new UnsupportedStrictJsonSchemaError("properties require type object");
  }
  if (!isObjectSchema) return;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new UnsupportedStrictJsonSchemaError(
      "schema-valued or true additionalProperties is unsupported",
    );
  }
  if (schema.properties !== undefined && !isJsonSchemaObject(schema.properties)) {
    throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
  }
  if (schema.required !== undefined && !Check(StringArraySchema, schema.required)) {
    throw new UnsupportedStrictJsonSchemaError("object required must be a string array");
  }

  const properties = schema.properties ?? {};
  const propertyNames = Object.keys(properties);
  const required = new Set(Check(StringArraySchema, schema.required) ? schema.required : []);
  if ([...required].some((key) => !propertyNames.includes(key))) {
    throw new UnsupportedStrictJsonSchemaError("required contains an unknown property");
  }
  for (const [key, property] of Object.entries(properties)) {
    makeJsonSchemaNodeStrict(property);
    if (!required.has(key) && !schemaAllowsNull(property)) {
      properties[key] = { anyOf: [property, { type: "null" }] };
    }
  }
  schema.required = propertyNames;
  schema.additionalProperties = false;
}

export function makeStrictJsonSchema(schema: Tool["parameters"]): JsonSchemaObject {
  const cloned = structuredClone(schema);
  if (!isJsonSchemaObject(cloned)) {
    throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
  }
  makeJsonSchemaNodeStrict(cloned);
  if (cloned.type !== "object") {
    throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
  }
  return cloned;
}

export function getJsonSchemaToolParameters(
  tool: Tool,
  strict: boolean | undefined,
): Tool["parameters"] {
  return strict === true ? makeStrictJsonSchema(tool.parameters) : tool.parameters;
}

export function resolveJsonSchemaStrictSampling(
  tool: Tool,
  supportsStrictMode: boolean,
): boolean | undefined {
  const config = tool.constrainedSampling;
  if (!config || config.type !== "json_schema") return undefined;

  if (supportsStrictMode) {
    try {
      makeStrictJsonSchema(tool.parameters);
      return true;
    } catch (error) {
      if (!(error instanceof UnsupportedStrictJsonSchemaError)) throw error;
      if (config.strict !== "require") return undefined;
      throw new Error(
        `Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`,
      );
    }
  }
  if (config.strict === "require") {
    throw new Error(
      `Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`,
    );
  }
  return undefined;
}

export interface GrammarConstrainedSampling {
  format: "lark" | "regex";
  definition: string;
  inputProperty: string;
}

export interface GrammarToolInputJsonBuffer {
  input: string;
  started: boolean;
  closed: boolean;
}

const GrammarArgumentValueSchema = Type.Union([
  Type.Record(Type.String(), Type.Unknown()),
  Type.Array(Type.Unknown()),
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  Type.Undefined(),
]);
type GrammarArgumentValue = import("typebox").Static<typeof GrammarArgumentValueSchema>;

export function getGrammarToolInput(
  toolName: string,
  arguments_: Record<string, GrammarArgumentValue>,
  inputProperty: string,
): string {
  const input = arguments_[inputProperty];
  if (!Check(StringSchema, input)) {
    throw new Error(
      `Grammar tool call "${toolName}" requires argument "${inputProperty}" to be a string.`,
    );
  }
  return input;
}

export function appendGrammarToolInputJsonDelta(
  buffer: GrammarToolInputJsonBuffer,
  inputProperty: string,
  nextInput: string,
  close: boolean,
): string | undefined {
  if (buffer.closed) {
    if (close && nextInput === buffer.input) return undefined;
    throw new Error(
      `grammar tool input for property "${inputProperty}" changed after it was closed`,
    );
  }
  if (!nextInput.startsWith(buffer.input)) {
    throw new Error(`grammar tool input for property "${inputProperty}" changed non-monotonically`);
  }

  const inputDelta = nextInput.slice(buffer.input.length);
  if (!close && inputDelta.length === 0) return undefined;

  let delta = "";
  if (!buffer.started) {
    delta += `{${JSON.stringify(inputProperty)}:"`;
    buffer.started = true;
  }
  delta += JSON.stringify(inputDelta).slice(1, -1);
  buffer.input = nextInput;

  if (close) {
    delta += '"}';
    buffer.closed = true;
  }
  return delta;
}

function inferGrammarInputProperty(tool: Tool): string {
  const schema = tool.parameters;
  if (!isJsonSchemaObject(schema) || schema.type !== "object") {
    throw new Error("grammar constrained sampling requires an object parameter schema");
  }
  if (!Check(StringArraySchema, schema.required) || schema.required.length !== 1) {
    throw new Error("grammar constrained sampling requires exactly one required string property");
  }

  const inputProperty = schema.required[0];
  if (inputProperty === undefined) {
    throw new Error("grammar constrained sampling requires exactly one required string property");
  }
  if (!schema.properties?.[inputProperty]) {
    throw new Error(
      `grammar constrained sampling requires a properties entry for ${inputProperty}`,
    );
  }
  if (schema.properties[inputProperty]?.type !== "string") {
    throw new Error(`grammar constrained sampling property ${inputProperty} must have type string`);
  }
  return inputProperty;
}

export function resolveGrammarConstrainedSampling(
  tool: Tool,
  supportsOpenAIGrammarTools: boolean,
): GrammarConstrainedSampling | undefined {
  const config = tool.constrainedSampling;
  if (!config || config.type !== "grammar") return undefined;
  if (!supportsOpenAIGrammarTools) return undefined;

  const larkDefinition = config.variants.openai_lark;
  const regexDefinition = config.variants.openai_regex;
  const hasLarkDefinition = Check(StringSchema, larkDefinition) && larkDefinition.trim().length > 0;
  const hasRegexDefinition =
    Check(StringSchema, regexDefinition) && regexDefinition.trim().length > 0;
  if (!hasLarkDefinition && !hasRegexDefinition) {
    throw new Error(
      `Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`,
    );
  }
  const definition = hasLarkDefinition ? larkDefinition : regexDefinition;
  if (definition === undefined) {
    throw new Error(
      `Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`,
    );
  }

  try {
    return {
      format: hasLarkDefinition ? "lark" : "regex",
      definition,
      inputProperty: inferGrammarInputProperty(tool),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: ${message}.`);
  }
}

export function createGrammarToolInputProperties(
  tools: Tool[] | undefined,
  supportsOpenAIGrammarTools: boolean,
): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  for (const tool of tools ?? []) {
    const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
    if (grammar) properties.set(tool.name, grammar.inputProperty);
  }
  return properties;
}
