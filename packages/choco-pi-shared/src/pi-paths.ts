import { homedir } from "node:os";
import path from "node:path";

/** Environment map subset used to resolve standalone vs. legacy Pi state and agent directories. */
export type PiPathEnv = Readonly<Record<string, string | undefined>>;

export function standaloneHome(env: PiPathEnv = process.env): string | undefined {
  if (env.CHOCO_PI_STANDALONE !== "1") return undefined;
  const home = env.CHOCO_PI_HOME;
  return home !== undefined && path.isAbsolute(home) ? path.normalize(home) : undefined;
}

export function piAgentDir(env: PiPathEnv = process.env, home: string = homedir()): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured !== undefined && configured.length > 0) return configured;
  const standalone = standaloneHome(env);
  return standalone === undefined
    ? path.join(home, ".pi", "agent")
    : path.join(standalone, "agent");
}

export function piStateRoot(env: PiPathEnv = process.env, home: string = homedir()): string {
  return standaloneHome(env) ?? path.join(home, ".pi");
}

export function legacyPiFallbacks(
  env: PiPathEnv = process.env,
  home: string = homedir(),
): readonly string[] {
  return standaloneHome(env) === undefined ? [path.join(home, ".pi")] : [];
}
