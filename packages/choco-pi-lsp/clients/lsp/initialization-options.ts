import { obj, compile } from "@earendil-works/pi-schema";
import { isRuntimeString } from "../../tools/runtime-values.ts";
import { isBooleanValue, isFiniteNumber } from "./schema-guards.ts";

export interface LspInitializationOptions {
  [key: string]: LspInitializationValue;
}

export type LspInitializationValue =
  | string
  | number
  | boolean
  | null
  | LspInitializationOptions
  | LspInitializationValue[];

export const InitializationObjectSchema = obj({}, { open: true });

export const isInitializationObject = compile(InitializationObjectSchema).check;

export function isInitializationValue<T>(value: T): value is T & LspInitializationValue {
  if (value === null || isRuntimeString(value) || isFiniteNumber(value) || isBooleanValue(value)) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isInitializationValue);
  if (!isInitializationObject(value)) return false;
  return Object.values(value).every(isInitializationValue);
}

export function isInitializationOptions<T>(value: T): value is T & LspInitializationOptions {
  return isInitializationObject(value) && Object.values(value).every(isInitializationValue);
}

export function deepMergeObjects(
  base: LspInitializationOptions,
  override: LspInitializationOptions,
): LspInitializationOptions {
  const result: LspInitializationOptions = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (
      isInitializationOptions(value) &&
      current !== undefined &&
      isInitializationOptions(current)
    ) {
      result[key] = deepMergeObjects(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function mergeInitializationOptions(
  base: LspInitializationOptions | undefined,
  override: LspInitializationOptions | undefined,
): LspInitializationOptions | undefined {
  if (!override) return base;
  if (!base) return override;
  return deepMergeObjects(base, override);
}
