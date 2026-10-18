/**
 * Per-module-graph registry of shutdown timer releases.
 *
 * Several warm caches arm unref'd idle-eviction timers (20+ minutes), and
 * session_start schedules unref'd background work. An unref'd timer does not
 * keep the process alive, but its callback still pins the owning module graph
 * until it fires. Pi may evaluate this package more than once per process
 * (in-process sessions with another cwd re-evaluate the extension graph), so a
 * shut-down graph stayed reachable for the full idle window after its last
 * session ended.
 *
 * Modules register a release function when they are evaluated; the primary
 * `session_shutdown` teardown calls {@link releaseIdleEvictionTimers}. Cache
 * releases clear timer handles only and keep the entries warm. Until the next
 * `session_start` resumes them, idle-eviction timers are not re-armed, so
 * background work that finishes after shutdown cannot pin the graph again; a
 * live graph re-arms each timer on its next cache use after resuming.
 *
 * The registry is deliberately module-local: it releases only this graph's
 * timers, never another live graph's.
 */

const idleTimerReleases = new Set<() => void>();
let idleTimersSuspended = false;

export function registerIdleTimerRelease(release: () => void): void {
  idleTimerReleases.add(release);
}

/** True between a primary session_shutdown and the next session_start. */
export function idleEvictionTimersSuspended(): boolean {
  return idleTimersSuspended;
}

export function releaseIdleEvictionTimers(): void {
  idleTimersSuspended = true;
  for (const release of idleTimerReleases) {
    try {
      release();
    } catch {
      // Releasing a timer handle is best-effort teardown; one failing cache
      // must not keep the remaining caches' timers armed.
    }
  }
}

export function resumeIdleEvictionTimers(): void {
  idleTimersSuspended = false;
}
