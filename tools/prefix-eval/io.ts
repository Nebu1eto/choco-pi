import { readFile } from "node:fs/promises";
import { compile, type Static, type Validator } from "@earendil-works/pi-schema";
import {
  isString,
  reinterpretHostValue,
  type RuntimeValue,
} from "../../.pi/extensions/lib/runtime-values.ts";
import { JsonSchema, type JsonValue } from "./types.ts";

const jsonCheck = compile(JsonSchema).check;
const validators = new WeakMap<object, Validator>();

/** Whether `value` matches `schema`; each schema object is compiled once. */
function matches<S extends object>(schema: S, value: RuntimeValue): value is Static<S> {
  let validator = validators.get(schema);
  if (validator === undefined) {
    validator = compile(schema);
    validators.set(schema, validator);
  }
  return validator.check(value);
}

export function parseJson(text: string): JsonValue {
  let parsed: RuntimeValue;
  try {
    parsed = reinterpretHostValue<RuntimeValue>(JSON.parse(text));
  } catch (error) {
    throw new Error("Input is not valid JSON", { cause: error });
  }
  if (!jsonCheck(parsed)) {
    throw new Error("Input contains a value that JSON cannot represent");
  }
  return parsed;
}

export function validateValue<Schema extends object>(
  schema: Schema,
  value: RuntimeValue,
  description: string,
): Static<Schema> {
  if (!matches(schema, value)) {
    throw new Error(`Invalid ${description}`);
  }
  return value;
}

export async function readValidatedJson<Schema extends object>(
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
