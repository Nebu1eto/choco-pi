import { isObjectValue } from "./protocol-values.js";
/**
 * Decide the `isError` override for a finished tool result in the `tool_result` hook.
 *
 * A failed MCP tool call is *returned* (not thrown), tagged `details.error: "tool_error"` (the server
 * returned an error result) or `"call_failed"` (the call itself threw and was caught). pi never reads a
 * result-level `isError`, so without this such a call is recorded as a success. Returning
 * `{ isError: true }` (and nothing else) flips the flag; pi's field-by-field merge keeps the original
 * `content` and `details` intact.
 *
 * Limited to those two codes: the adapter's other `details.error` values (`auth_required`, connection
 * states, search/validation feedback, ...) are not failed tool calls, so they get no override.
 */

export function toolErrorOverride<BoundaryValue>(
  details: BoundaryValue,
): { isError: true } | undefined {
  if (details && isObjectValue(details) && "error" in details) {
    // SAFETY: Adjacent validation or the typed SDK establishes the asserted protocol value shape at this compatibility boundary.
    const code = (details as { error?: unknown }).error;
    if (code === "tool_error" || code === "call_failed") {
      return { isError: true };
    }
  }
  return undefined;
}
