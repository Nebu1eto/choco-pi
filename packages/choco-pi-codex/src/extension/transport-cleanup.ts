import { cleanupOpenAICodexTransportSession } from "../providers/openai-codex/transport-cleanup.ts";

export const CODEX_TRANSPORT_CLEANUP_SYMBOL: unique symbol = Symbol.for(
  "choco-pi-codex:transport-cleanup",
);

export interface CodexTransportCleanupCandidate {
  cleanupOwner(ownerId: string): void;
}

const CODEX_TRANSPORT_CLEANUP_CANDIDATE: CodexTransportCleanupCandidate = Object.freeze({
  cleanupOwner: cleanupOpenAICodexTransportSession,
});

interface CodexTransportCleanupRegistry {
  [CODEX_TRANSPORT_CLEANUP_SYMBOL]?: CodexTransportCleanupCandidate | null;
}

/** Publish a stateless process-global bridge for owners that dispose sessions directly. */
export function registerCodexTransportCleanup(): CodexTransportCleanupCandidate {
  // SAFETY: This extension owns the symbol-keyed slot and publishes only its stateless candidate.
  const registry = globalThis as typeof globalThis & CodexTransportCleanupRegistry;
  registry[CODEX_TRANSPORT_CLEANUP_SYMBOL] = CODEX_TRANSPORT_CLEANUP_CANDIDATE;
  return CODEX_TRANSPORT_CLEANUP_CANDIDATE;
}
