import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import type { TSchema, Static } from "typebox";
import {
  isString,
  reinterpretHostValue,
  type RuntimeValue,
} from "../../.pi/extensions/lib/runtime-values.ts";
import { JsonSchema, type JsonValue } from "./types.ts";

export function parseJson(text: string): JsonValue {
  let parsed: RuntimeValue;
  try {
    parsed = reinterpretHostValue<RuntimeValue>(JSON.parse(text));
  } catch (error) {
    throw new Error("Input is not valid JSON", { cause: error });
  }
  if (!Value.Check(JsonSchema, parsed)) {
    throw new Error("Input contains a value that JSON cannot represent");
  }
  return parsed;
}

export function validateValue<Schema extends TSchema>(
  schema: Schema,
  value: RuntimeValue,
  description: string,
): Static<Schema> {
  if (!Value.Check(schema, value)) {
    throw new Error(`Invalid ${description}`);
  }
  return value;
}

export async function readValidatedJson<Schema extends TSchema>(
  path: string,
  schema: Schema,
  description: string,
): Promise<Static<Schema>> {
  const contents = await readFile(path, "utf8");
  return validateValue(schema, parseJson(contents), description);
}

export function parseNamedOptions(
  argumentsToParse: readonly string[],
  booleanNames: ReadonlySet<string> = new Set(),
): Map<string, string | true> {
  const options = new Map<string, string | true>();
  for (let index = 0; index < argumentsToParse.length;) {
    const argument = argumentsToParse[index];
    if (!argument?.startsWith("--")) {
      throw new Error(`Expected an option name, received ${argument ?? "end of arguments"}`);
    }
    const name = argument.slice(2);
    if (booleanNames.has(name)) {
      options.set(name, true);
      index += 1;
      continue;
    }
    const value = argumentsToParse[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option --${name} requires a value`);
    }
    options.set(name, value);
    index += 2;
  }
  return options;
}

export function requiredStringOption(options: Map<string, string | true>, name: string): string {
  const value = options.get(name);
  if (!isString(value) || value.length === 0) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}
