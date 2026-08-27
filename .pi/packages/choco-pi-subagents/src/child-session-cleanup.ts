export const SHELL_MANAGER_SYMBOL: unique symbol = Symbol.for("choco-pi-shells:manager");
export const CODEX_TRANSPORT_CLEANUP_SYMBOL: unique symbol = Symbol.for(
  "choco-pi-codex:transport-cleanup",
);

export interface ChildSessionOwner {
  sessionManager: { getSessionId(): string };
}

interface CleanupCandidate {
  cleanupOwner?: unknown;
}

interface CleanupRegistry {
  [SHELL_MANAGER_SYMBOL]?: CleanupCandidate | null;
  [CODEX_TRANSPORT_CLEANUP_SYMBOL]?: CleanupCandidate | null;
}

interface ResolvedCleanup {
  candidate: CleanupCandidate;
  cleanupOwner: (ownerId: string) => void | Promise<void>;
}

function resolveCleanup(
  symbol: typeof SHELL_MANAGER_SYMBOL | typeof CODEX_TRANSPORT_CLEANUP_SYMBOL,
): ResolvedCleanup | undefined {
  try {
    // SAFETY: Both symbol-keyed slots are treated as candidates until their method is callable.
    const registry = globalThis as typeof globalThis & CleanupRegistry;
    const candidate =
      symbol === SHELL_MANAGER_SYMBOL
        ? registry[SHELL_MANAGER_SYMBOL]
        : registry[CODEX_TRANSPORT_CLEANUP_SYMBOL];
    if (!candidate || !(candidate.cleanupOwner instanceof Function)) return undefined;
    // SAFETY: The function check above establishes the only cleanup call shape this seam uses.
    return {
      candidate,
      cleanupOwner: candidate.cleanupOwner as (ownerId: string) => void | Promise<void>,
    };
  } catch {
    return undefined;
  }
}

function startCleanup(cleanup: ResolvedCleanup, ownerId: string): void {
  try {
    const result = cleanup.cleanupOwner.call(cleanup.candidate, ownerId);
    void Promise.resolve(result).catch(() => {});
  } catch {
    // Optional extension seams must not prevent the owning session from disposing.
  }
}

/** Start optional cross-extension cleanup without delaying child-session disposal. */
export function cleanupChildSessionOwner(session: ChildSessionOwner): void {
  const cleanups = [
    resolveCleanup(SHELL_MANAGER_SYMBOL),
    resolveCleanup(CODEX_TRANSPORT_CLEANUP_SYMBOL),
  ].filter((cleanup): cleanup is ResolvedCleanup => cleanup !== undefined);
  if (cleanups.length === 0) return;

  let ownerId: string;
  try {
    ownerId = session.sessionManager.getSessionId();
  } catch {
    // Optional extension seams must not prevent the owning session from disposing.
    return;
  }

  for (const cleanup of cleanups) startCleanup(cleanup, ownerId);
}
