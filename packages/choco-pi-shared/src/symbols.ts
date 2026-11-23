import type { RuntimeValue } from "./runtime-values.ts";

/**
 * Process-global Symbol.for registry keys and stateless globalThis accessors.
 * Literal protocol strings are frozen cross-extension interfaces — do not rename.
 */
export const GLOBAL_SYMBOLS = Object.freeze({
  stopControl: Symbol.for("choco-pi:stop-control/v1"),
  subagentsManager: Symbol.for("pi-subagents:manager"),
  compactionBackgroundAdoption: Symbol.for("choco-pi:compaction-background-adoption"),
  usageLimitPolicy: Symbol.for("choco-pi.usage-limit-policy"),
  toolScope: Symbol.for("choco-pi.tool-scope.v1"),
});

export function readGlobalSlot(key: symbol): RuntimeValue {
  const value: RuntimeValue = Object.getOwnPropertyDescriptor(globalThis, key)?.value;
  return value;
}

export function writeGlobalSlot(key: symbol, value: RuntimeValue): void {
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

export function deleteGlobalSlot(key: symbol): void {
  Reflect.deleteProperty(globalThis, key);
}
