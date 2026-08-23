import { containsManagedSessionRestoreKey } from "../../managed-session-capabilities.ts";
import { hasRuntimeType } from "../../parsing.ts";
import { redactSensitiveText, redactSensitiveValue } from "../../runtime.ts";
import type { AgentBrowserResultValue } from "../contracts.ts";
import { stringifyUnknown, truncateText } from "../text.ts";

const UNTITLED_PAGE_SUMMARY = "(untitled page)";

export function stringifyModelFacing<Value>(value: Value): string {
  return stringifyUnknown(redactSensitiveValue(value));
}

export function parseJsonPreviewString(value: string): AgentBrowserResultValue {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    const parsed: AgentBrowserResultValue = JSON.parse(trimmed);
    return parsed;
  } catch {
    return value;
  }
}

export function redactModelFacingText(text: string): string {
  const parsed = parseJsonPreviewString(text);
  if (parsed !== text) {
    return stringifyModelFacing(parsed);
  }
  return redactSensitiveText(text);
}

export function redactModelFacingTextIfSensitive(text: string): string {
  return containsManagedSessionRestoreKey(text) ||
    /(?:@|\b(?:access[_-]?key|api[_-]?key|auth|authorization|basic|bearer|connection[_-]?string|cookie|database[_-]?url|db[_-]?url|mongo(?:db)?[_-]?uri|pass(?:word)?|private[_-]?key|redis[_-]?url|secret|session[_-]?id|token)\b)/i.test(
      text,
    )
    ? redactModelFacingText(text)
    : text;
}

export function getArrayField<Value>(
  data: Record<string, Value>,
  key: string,
): AgentBrowserResultValue[] | undefined {
  const value = data[key];
  if (!Array.isArray(value)) return undefined;
  // SAFETY: presentation records are decoded from the upstream CLI JSON envelope, so array members are JSON result values.
  return value as AgentBrowserResultValue[];
}

export function getStringField<Value>(
  data: Record<string, Value>,
  key: string,
): string | undefined {
  const value = data[key];
  return hasRuntimeType(value, "string") && value.trim().length > 0 ? value.trim() : undefined;
}

// `lifecycle` is upstream launch/reuse bookkeeping, never page content, so it must not be the
// answer an agent reads when a command has no dedicated presenter.
export function omitUpstreamLifecycle<Value>(data: Record<string, Value>) {
  const { lifecycle: _lifecycle, ...rest } = data;
  return rest;
}

export function getPageSummary<Value>(data: Record<string, Value>): string | undefined {
  const title = hasRuntimeType(data.title, "string") ? data.title : undefined;
  const url = hasRuntimeType(data.url, "string") ? data.url : undefined;
  if (title === undefined && url === undefined) return undefined;
  if (title && url) return `${title}\n${url}`;
  if (url) return url;
  return title || UNTITLED_PAGE_SUMMARY;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function firstLine(value: string, maxChars = 160): string {
  return truncateText(value.split("\n", 1)[0] ?? value, maxChars);
}
