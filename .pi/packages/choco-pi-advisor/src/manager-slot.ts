import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdvisorEffort } from "./settings.ts";

export interface AdvisorSpawnOptions {
  description: string;
  model: Model<Api>;
  thinkingLevel: AdvisorEffort;
  isBackground: false;
  signal: AbortSignal | undefined;
  onTextDelta: (delta: string, fullText: string) => void;
}
export interface AdvisorRecord {
  promise: Promise<unknown>;
  result?: string;
  status?: string;
  error?: string;
}
export interface AdvisorManager {
  /**
   * Spawn an `internal` agent by its exact registry name. Unlike `spawn`, which
   * treats internal agents as unknown and may substitute `fallbackSubagent`,
   * this refuses anything but the named internal agent.
   */
  spawnInternal(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: AdvisorSpawnOptions,
  ): string;
  getRecord(id: string): AdvisorRecord | undefined;
  disposeSettledRecord?: (id: string) => boolean;
}

type ManagerCandidate = {} | null | undefined;
interface ManagerMethods {
  spawnInternal: Function;
  getRecord: Function;
}

/**
 * A subagents build without `spawnInternal` is refused rather than used through
 * `spawn`: there the internal advisor type resolves to `fallbackSubagent`, so
 * the consult would run as an edit-capable agent with the wrong prompt.
 */
function hasManagerMethods(value: ManagerCandidate): value is ManagerMethods {
  return (
    value instanceof Object &&
    "spawnInternal" in value &&
    value.spawnInternal instanceof Function &&
    "getRecord" in value &&
    value.getRecord instanceof Function
  );
}

export function resolveAdvisorManager(): AdvisorManager | undefined {
  const candidate: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    Symbol.for("pi-subagents:manager"),
  )?.value;
  if (!hasManagerMethods(candidate)) return undefined;
  // SAFETY: hasManagerMethods establishes both callable methods; their signatures are the
  // shared internal AgentManager ABI, not arbitrary user-supplied JSON functions.
  return candidate as AdvisorManager;
}
