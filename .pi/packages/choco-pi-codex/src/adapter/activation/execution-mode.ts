// Retained only so old session entries remain display-only during replay.
export const EXECUTION_MODE_SESSION_ENTRY = "pi-codex-conversion-execution-mode";

export type ExecutionMode = "normal" | "code" | "notebook";

export function normalizeExecutionMode(value: unknown): ExecutionMode | undefined {
	// Notebook Mode was removed from this fork; configs that still request it
	// are silently downgraded to Code Mode.
	if (value === "notebook") return "code";
	return value === "normal" || value === "code"
		? value
		: undefined;
}
