/**
 * LSP initializationOptions validation and deep merge.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

import { obj, compile } from "@earendil-works/pi-schema";
import { isRuntimeString } from "../../tools/runtime-values.ts";
import { isBooleanValue, isFiniteNumber } from "./schema-guards.ts";

// --- Init override helpers ---

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

/**
 * Recursively merges `override` onto `base`. Override wins on leaf conflicts
 * at every nesting level; arrays and non-plain-object values are replaced, not
 * merged (consistent with standard LSP settings merge semantics).
 */
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

/**
 * Merges user-supplied initializationOptions onto a server's built-in defaults.
 * - If neither side is defined → undefined (no options sent).
 * - If only one side is defined → that side is returned directly.
 * - Both defined → deep merge, user wins on conflicts.
 */
export function mergeInitializationOptions(
  base: LspInitializationOptions | undefined,
  override: LspInitializationOptions | undefined,
): LspInitializationOptions | undefined {
  if (!override) return base;
  if (!base) return override;
  return deepMergeObjects(base, override);
}
