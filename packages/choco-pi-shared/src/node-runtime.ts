import path from "node:path";

/**
 * The Node.js executable for child processes that need Node semantics.
 *
 * The `choco-pi` launcher can run Pi under Bun (`CHOCO_PI_RUNTIME=bun`). There
 * `process.execPath` is the bun binary, so a child spawned as
 * `process.execPath <script>` would silently run under Bun, and Node-only
 * flags (`--permission`, `--allow-fs-read`, `--max-old-space-size`) or a
 * shebang tool that expects `node` beside `execPath` would break. The launcher
 * exports the qualifying Node as `CHOCO_PI_NODE` in both runtimes.
 *
 * Pure and synchronous: callers may pass the runtime facts; the defaults read
 * the current process at call time, never at module load.
 */
export type NodeRuntimeEnv = Readonly<Record<string, string | undefined>>;

export type NodeRuntimeFacts = {
  env?: NodeRuntimeEnv;
  execPath?: string;
  versions?: Readonly<Record<string, string | undefined>>;
};

/** True when this process runs under Bun (Pi's own `isBunRuntime` test). */
export function isBunRuntime(versions: NodeRuntimeFacts["versions"] = process.versions): boolean {
  const bun = versions?.bun;
  return bun !== undefined && bun !== "";
}

/**
 * `process.execPath` under Node; under Bun the absolute `CHOCO_PI_NODE`, else
 * `"node"` (a PATH lookup by the spawn).
 */
export function nodeExecutable(facts: NodeRuntimeFacts = {}): string {
  if (!isBunRuntime(facts.versions ?? process.versions)) return facts.execPath ?? process.execPath;
  const configured = (facts.env ?? process.env).CHOCO_PI_NODE;
  return configured !== undefined && path.isAbsolute(configured) ? configured : "node";
}

/** The directory of {@link nodeExecutable} for PATH lists; undefined when it is a PATH lookup. */
export function nodeBinDirectory(facts: NodeRuntimeFacts = {}): string | undefined {
  const executable = nodeExecutable(facts);
  return path.isAbsolute(executable) ? path.dirname(executable) : undefined;
}
