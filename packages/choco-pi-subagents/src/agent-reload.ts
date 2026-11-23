import type { AgentConfig } from "./types.ts";

export interface AgentReloaderDeps {
  load: (cwd: string, strict: boolean) => Promise<Map<string, AgentConfig>>;
  register: (userAgents: Map<string, AgentConfig>) => void;
  cwd: () => string;
}

export interface AgentReloader {
  reload(strict?: boolean): Promise<void>;
  reregister(): void;
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
