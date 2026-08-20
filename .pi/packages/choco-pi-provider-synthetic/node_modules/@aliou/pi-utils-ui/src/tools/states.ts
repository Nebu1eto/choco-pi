export type ToolResultState =
  | "running"
  | "done"
  | "aborted"
  | "error"
  | "empty";

export function resolveToolResultState(details: {
  response?: string;
  aborted?: boolean;
  error?: string;
}): ToolResultState {
  if (details.aborted) return "aborted";
  if (details.error) return "error";
  if (details.response) return "done";
  return "running";
}
