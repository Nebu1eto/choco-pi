const idleTimerReleases = new Set<() => void>();
let idleTimersSuspended = false;

export function registerIdleTimerRelease(release: () => void): void {
  idleTimerReleases.add(release);
}

export function idleEvictionTimersSuspended(): boolean {
  return idleTimersSuspended;
}

export function releaseIdleEvictionTimers(): void {
  idleTimersSuspended = true;
  for (const release of idleTimerReleases) {
    try {
      release();
    } catch {}
  }
}

export function resumeIdleEvictionTimers(): void {
  idleTimersSuspended = false;
}
