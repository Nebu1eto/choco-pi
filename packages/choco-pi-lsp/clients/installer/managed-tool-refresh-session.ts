let refreshesThisSession = 0;

export function managedToolRefreshesThisSession(): number {
  return refreshesThisSession;
}

export function reserveManagedToolRefreshSlot(maxPerSession: number): boolean {
  if (refreshesThisSession >= maxPerSession) return false;
  refreshesThisSession += 1;
  return true;
}

export function releaseManagedToolRefreshSlot(): void {
  if (refreshesThisSession > 0) refreshesThisSession -= 1;
}

export function resetManagedToolRefreshSession(): void {
  refreshesThisSession = 0;
}
