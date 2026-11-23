import path from "node:path";

export type NodeRuntimeEnv = Readonly<Record<string, string | undefined>>;

export type NodeRuntimeFacts = {
  env?: NodeRuntimeEnv;
  execPath?: string;
  versions?: Readonly<Record<string, string | undefined>>;
};

export function isBunRuntime(versions: NodeRuntimeFacts["versions"] = process.versions): boolean {
  const bun = versions?.bun;
  return bun !== undefined && bun !== "";
}

export function nodeExecutable(facts: NodeRuntimeFacts = {}): string {
  if (!isBunRuntime(facts.versions ?? process.versions)) return facts.execPath ?? process.execPath;
  const configured = (facts.env ?? process.env).CHOCO_PI_NODE;
  return configured !== undefined && path.isAbsolute(configured) ? configured : "node";
}

export function nodeBinDirectory(facts: NodeRuntimeFacts = {}): string | undefined {
  const executable = nodeExecutable(facts);
  return path.isAbsolute(executable) ? path.dirname(executable) : undefined;
}
