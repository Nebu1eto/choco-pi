import { isNativeSteerPending } from "../providers/openai-codex/native-steering.ts";

export const NATIVE_STEERING_SYMBOL: unique symbol = Symbol.for("choco-pi-codex:native-steering");

export interface NativeSteeringCandidate {
  isNativeSteerPending(sessionId: string): boolean;
}

const NATIVE_STEERING_CANDIDATE: NativeSteeringCandidate = Object.freeze({
  isNativeSteerPending,
});

interface NativeSteeringRegistry {
  [NATIVE_STEERING_SYMBOL]?: NativeSteeringCandidate | null;
}

/** Publish a stateless process-global bridge for native-steering consumers. */
export function registerNativeSteeringBridge(): NativeSteeringCandidate {
  // SAFETY: This extension owns the symbol-keyed slot and accepts only its callable seam shape.
  const registry = globalThis as typeof globalThis & NativeSteeringRegistry;
  const existing = registry[NATIVE_STEERING_SYMBOL];
  if (existing?.isNativeSteerPending instanceof Function) return existing;
  registry[NATIVE_STEERING_SYMBOL] = NATIVE_STEERING_CANDIDATE;
  return NATIVE_STEERING_CANDIDATE;
}
