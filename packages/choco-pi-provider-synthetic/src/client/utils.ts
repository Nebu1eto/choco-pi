import { compile, obj, opt, str } from "@earendil-works/pi-schema";

const FETCH_TIMEOUT_MS = 15_000;
const ErrorPayloadSchema = obj({ error: opt(str()) }, { open: true });
const isErrorPayload = compile(ErrorPayloadSchema).check;

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
      return isErrorPayload(parsed) && parsed.error ? parsed.error : body;
    } catch {
      return body;
    }
  } catch {
    return message;
  }
}
