export const SHELL_MANAGER_SYMBOL: unique symbol = Symbol.for("choco-pi-shells:manager");

export interface ChildSessionOwner {
  sessionManager: { getSessionId(): string };
}

interface ShellCleanupCandidate {
  cleanupOwner?: string | ((ownerId: string) => Promise<void>);
}

interface ShellCleanupRegistry {
  [SHELL_MANAGER_SYMBOL]?: ShellCleanupCandidate | null;
}

/** Start optional cross-extension cleanup without delaying child-session disposal. */
export function cleanupChildSessionOwner(session: ChildSessionOwner): void {
  try {
    // SAFETY: The process-global slot is treated only as a candidate until its method is callable.
    const registry = globalThis as typeof globalThis & ShellCleanupRegistry;
    const manager = registry[SHELL_MANAGER_SYMBOL];
    if (!(manager?.cleanupOwner instanceof Function)) return;

    const cleanup = manager.cleanupOwner(session.sessionManager.getSessionId());
    void Promise.resolve(cleanup).catch(() => {});
  } catch {
    // Optional extension seams must not prevent the owning session from disposing.
  }
}
