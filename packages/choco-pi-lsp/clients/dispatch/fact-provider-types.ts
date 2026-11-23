import type { FactStore, ReadonlyFactStore } from "./fact-store.ts";
import type { DispatchContext } from "./types.ts";

export interface FactProvider {
  id: string;
  provides: string[];
  requires: string[];
  appliesTo(ctx: DispatchContext): boolean;
  run(ctx: DispatchContext, store: FactStore): Promise<void> | void;
}

export interface FactRule {
  id: string;
  requires: string[];
  appliesTo(ctx: DispatchContext): boolean;
  evaluate(ctx: DispatchContext, store: ReadonlyFactStore): import("./types.ts").Diagnostic[];
}
