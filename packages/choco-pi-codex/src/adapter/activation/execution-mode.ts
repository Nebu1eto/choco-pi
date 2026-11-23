import type { BoundaryValue } from "@choco-pi/code-mode/runtime-values";
export const EXECUTION_MODE_SESSION_ENTRY = "pi-codex-conversion-execution-mode";

export type ExecutionMode = "normal" | "code" | "notebook";

export function normalizeExecutionMode(value: BoundaryValue): ExecutionMode | undefined {
  if (value === "notebook") return "code";
  return value === "normal" || value === "code" ? value : undefined;
}
