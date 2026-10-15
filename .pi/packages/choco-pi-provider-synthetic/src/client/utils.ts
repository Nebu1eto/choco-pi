import { Type } from "typebox";
import { Value } from "typebox/value";

const FETCH_TIMEOUT_MS = 15_000;
const ErrorPayloadSchema = Type.Object({ error: Type.Optional(Type.String()) });

export function isTimeoutReason(reason: Error | DOMException | undefined): boolean {
  return (
    (reason instanceof DOMException && reason.name === "TimeoutError") ||
    (reason instanceof Error && reason.name === "TimeoutError")
  );
}

export function combineWithTimeout(
  signal?: AbortSignal,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

export function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export async function parseErrorMessage(response: Response): Promise<string> {
  const message = response.statusText;
  try {
    const body = await response.text();
    if (!body) return message;
    try {
      const parsed = JSON.parse(body);
      return Value.Check(ErrorPayloadSchema, parsed) && parsed.error ? parsed.error : body;
    } catch {
      return body;
    }
  } catch {
    return message;
  }
}
