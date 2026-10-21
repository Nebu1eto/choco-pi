/**
 * agent-reload.ts — Generation-guarded, coalescing reload of custom agent
 * definitions into the process-global registry.
 *
 * Loading is asynchronous, so two reloads can be in flight at once and finish
 * in either order. Each reload snapshots its working directory and takes a
 * generation before its first await. When its load settles it registers only
 * if no newer reload has started; otherwise it discards its result and settles
 * with the newest reload instead, so every caller observes a registry at least
 * as fresh as the moment it asked. A new call always starts its own load: an
 * agent file written just before the call must not be missed because an older
 * load had already read the directory.
 */

import type { AgentConfig } from "./types.ts";

export interface AgentReloaderDeps {
  /** Reads agent definitions for `cwd`; rejects only under `strict`. */
  load: (cwd: string, strict: boolean) => Promise<Map<string, AgentConfig>>;
  /** Replaces the process-global registry. */
  register: (userAgents: Map<string, AgentConfig>) => void;
  /** Working directory for discovery, read once per reload before awaiting. */
  cwd: () => string;
}

export interface AgentReloader {
  /** Reload and register; settles once the registry reflects this or a newer load. */
  reload(strict?: boolean): Promise<void>;
  /** Re-register the last loaded user agents without touching the filesystem. */
  reregister(): void;
  /** Discard every in-flight reload; none of them will register afterwards. */
  invalidate(): void;
}

export function createAgentReloader(deps: AgentReloaderDeps): AgentReloader {
  let generation = 0;
  let latest: Promise<void> | undefined;
  let lastLoaded = new Map<string, AgentConfig>();

  const reload = (strict = false): Promise<void> => {
    const own = ++generation;
    const cwd = deps.cwd();
    const run = deps.load(cwd, strict).then((userAgents): Promise<void> | undefined => {
      if (own === generation) {
        lastLoaded = userAgents;
        deps.register(userAgents);
        return undefined;
      }
      // Superseded: a newer reload owns the registry. Settle with it so this
      // caller still sees a registry no older than its own request. `latest`
      // is never this run here — a newer generation either replaced it or
      // `invalidate` cleared it.
      return latest;
    });
    latest = run;
    return run;
  };

  return {
    reload,
    reregister: () => deps.register(lastLoaded),
    invalidate: () => {
      generation++;
      latest = undefined;
    },
  };
}
