import { type BoundaryValue, isBoundaryRecord, isNumber } from "../../boundary.ts";
import { stringField, toolResultText, type PiToolResult } from "../../pi-rpc/protocol.ts";

/** Read `key` from an undecoded value without deciding what the field holds. */
function propertyValue(value: BoundaryValue, key: string): BoundaryValue {
  return isBoundaryRecord(value) ? value[key] : undefined;
}

/** Read `key` from an undecoded value when it holds any number, including non-finite ones. */
function anyNumberField(value: BoundaryValue, key: string): number | undefined {
  const field = propertyValue(value, key);
  return isNumber(field) ? field : undefined;
}

export function toolResultToText(result: PiToolResult): string {
  if (!result) return "";

  const details = propertyValue(result, "details");

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = stringField(details, "diff");
  if (diff !== undefined && diff.trim()) {
    return diff;
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const blocks = toolResultText(result);
  if (blocks) return blocks;

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    stringField(details, "stdout") ??
    stringField(result, "stdout") ??
    stringField(details, "output") ??
    stringField(result, "output");

  const stderr = stringField(details, "stderr") ?? stringField(result, "stderr");

  const exitCode =
    anyNumberField(details, "exitCode") ??
    anyNumberField(result, "exitCode") ??
    anyNumberField(details, "code") ??
    anyNumberField(result, "code");

  if ((stdout !== undefined && stdout.trim()) || (stderr !== undefined && stderr.trim())) {
    const parts: string[] = [];
    if (stdout !== undefined && stdout.trim()) parts.push(stdout);
    if (stderr !== undefined && stderr.trim()) parts.push(`stderr:\n${stderr}`);
    if (exitCode !== undefined) parts.push(`exit code: ${exitCode}`);
    return parts.join("\n\n").trimEnd();
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
