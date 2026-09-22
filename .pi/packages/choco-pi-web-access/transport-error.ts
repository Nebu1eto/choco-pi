export type SearchTransportFailureKind =
  | "auth"
  | "cancelled"
  | "config"
  | "network"
  | "quota"
  | "request"
  | "response"
  | "stale"
  | "transient";

interface SearchTransportErrorOptions {
  status?: number;
  retryable?: boolean;
}

export class SearchTransportError extends Error {
  readonly transport: string;
  readonly kind: SearchTransportFailureKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    transport: string,
    kind: SearchTransportFailureKind,
    message: string,
    options: SearchTransportErrorOptions = {},
  ) {
    super(message);
    this.name = kind === "cancelled" ? "AbortError" : "SearchTransportError";
    this.transport = transport;
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? (kind === "network" || kind === "transient");
  }
}

export function classifyHttpFailure(status: number): "auth" | "quota" | "request" | "transient" {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status >= 500 && status < 600) return "transient";
  return "request";
}

export function assertTransportRequestActive(
  transport: string,
  signal?: AbortSignal,
  isCurrent?: () => boolean,
): void {
  if (signal?.aborted) {
    throw new SearchTransportError(transport, "cancelled", `${transport} request was cancelled`);
  }
  if (isCurrent && !isCurrent()) {
    throw new SearchTransportError(transport, "stale", `${transport} request context is stale`);
  }
}
