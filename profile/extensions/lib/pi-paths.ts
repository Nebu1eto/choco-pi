import { homedir } from "node:os";
import path from "node:path";

/**
 * Where Pi user state lives for this process.
 *
 * Legacy mode (the env contract below unset) keeps Pi's own defaults under
 * `~/.pi`. Standalone mode is set by the `choco-pi` launcher, which exports
 * `CHOCO_PI_STANDALONE=1` with an absolute `CHOCO_PI_HOME` and points
 * `PI_CODING_AGENT_DIR` at `$CHOCO_PI_HOME/agent`; in that mode nothing here
 * resolves under `~/.pi`. Keying on the launcher-only flag, not on
 * `CHOCO_PI_HOME` alone, keeps a plain `pi` started from a shell that happens
 * to export `CHOCO_PI_HOME` in legacy mode.
 *
 * Pure and synchronous: callers pass the environment and home directory, so
 * every result is a function of its inputs.
 */
export type PiPathEnv = Readonly<Record<string, string | undefined>>;

/** `CHOCO_PI_HOME` when the launcher marked this process standalone; otherwise undefined. */
export function standaloneHome(env: PiPathEnv = process.env): string | undefined {
  if (env.CHOCO_PI_STANDALONE !== "1") return undefined;
  const home = env.CHOCO_PI_HOME;
  return home !== undefined && path.isAbsolute(home) ? path.normalize(home) : undefined;
}

/** Pi's agent directory: `PI_CODING_AGENT_DIR`, else `<standalone home>/agent`, else `~/.pi/agent`. */
export function piAgentDir(env: PiPathEnv = process.env, home: string = homedir()): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured !== undefined && configured.length > 0) return configured;
  const standalone = standaloneHome(env);
  return standalone === undefined
    ? path.join(home, ".pi", "agent")
    : path.join(standalone, "agent");
}

/** Root for user state beside the agent directory (`pi-acp/`, `config/`): the standalone home, else `~/.pi`. */
export function piStateRoot(env: PiPathEnv = process.env, home: string = homedir()): string {
  return standaloneHome(env) ?? path.join(home, ".pi");
}

/**
 * Pre-agent-directory locations older code still reads for compatibility
 * (`~/.pi/agent-memory`, `~/.pi/skills`, web-search's `~/.pi`). Callers join
 * their own subpath. Empty in standalone mode, so no legacy fallback reaches
 * `~/.pi` there.
 */
export function legacyPiFallbacks(
  env: PiPathEnv = process.env,
  home: string = homedir(),
): readonly string[] {
  return standaloneHome(env) === undefined ? [path.join(home, ".pi")] : [];
}
