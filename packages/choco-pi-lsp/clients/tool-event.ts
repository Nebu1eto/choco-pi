import { type LspBoundaryValue, type LspDictionaryValue } from "./runtime-guards.ts";
import { sanitizeCorrelationId } from "./read-guard-logger.ts";

export function isToolCallEventType<T extends string>(
  toolName: T,
  event: LspBoundaryValue,
): boolean {
  return (
    event !== null &&
    Object(event) === event &&
    !Array.isArray(event) &&
    !(event instanceof Function) &&
    // SAFETY: The non-enumerating structural checks establish that the host discriminator can be read.
    (event as { toolName?: LspBoundaryValue }).toolName === toolName
  );
}

export function resolveToolCallCorrelationId(event: LspBoundaryValue): string | undefined {
  // SAFETY: The host tool discriminator and adjacent array/object checks establish the accessed event payload member before use.
  const value = (event ?? {}) as Record<string, LspDictionaryValue>;
  for (const candidate of [value.toolCallId, value.callId, value.requestId, value.id]) {
    const sanitized = sanitizeCorrelationId(candidate);
    if (sanitized) return sanitized;
  }
  return undefined;
}
