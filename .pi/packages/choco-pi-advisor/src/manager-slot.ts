import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
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
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: AdvisorSpawnOptions,
  ): string;
  getRecord(id: string): AdvisorRecord | undefined;
  disposeSettledRecord?: (id: string) => boolean;
}
const managerSchema = Type.Object({
  spawn: Type.Function([], Type.String()),
  getRecord: Type.Function([Type.String()], Type.Unknown()),
});

export function resolveAdvisorManager(): AdvisorManager | undefined {
  const candidate: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    Symbol.for("pi-subagents:manager"),
  )?.value;
  if (!Value.Check(managerSchema, candidate)) return undefined;
  // SAFETY: Value.Check establishes both callable methods; their signatures are the
  // shared internal AgentManager ABI, not arbitrary user-supplied JSON functions.
  return candidate as AdvisorManager;
}
