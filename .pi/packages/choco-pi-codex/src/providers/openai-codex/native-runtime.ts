import { Type } from "typebox";
import { Check } from "typebox/value";
import type { NativeSteeringConnection } from "./native-steering.ts";
import type { WebSocketLike } from "./types.ts";

interface NativeRuntime {
  bySocket: WeakMap<WebSocketLike, NativeSteeringConnection>;
  byOwner: Map<string, NativeSteeringConnection>;
  asyncCalls: Map<string, Set<string>>;
}
const SlotSchema = Type.Unsafe<NativeRuntime>({ type: "object" });
const slot = Symbol.for("choco-pi-codex:native-responses-runtime:v1");

function runtime(): NativeRuntime {
  const existing = Object.getOwnPropertyDescriptor(globalThis, slot)?.value;
  if (
    Check(SlotSchema, existing) &&
    existing.bySocket instanceof WeakMap &&
    existing.byOwner instanceof Map &&
    existing.asyncCalls instanceof Map
  )
    return existing;
  const value: NativeRuntime = {
    bySocket: new WeakMap(),
    byOwner: new Map(),
    asyncCalls: new Map(),
  };
  Object.defineProperty(globalThis, slot, { configurable: true, value });
  return value;
}

// Pi extension loading and deferred native imports can instantiate a module separately.
// Share only owned state, never replace Pi methods or prototypes.
export const nativeRuntime = runtime();
