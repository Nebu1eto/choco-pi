export { loadHookSources, mergeHooks, type LoadHooksOptions } from "./config.ts";
export { HookEngine, matchesIf, mergeResults } from "./engine.ts";
export {
  executeHandler,
  parseOutput,
  substitute,
  type HookBackends,
  type RawExecution,
} from "./executor.ts";
export { matcherValue, matches } from "./matcher.ts";
export * from "./types.ts";
