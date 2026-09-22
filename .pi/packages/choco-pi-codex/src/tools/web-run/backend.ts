import { spawn } from "node:child_process";
import { formatNativeBinaryError, nativeBinaryRecoveryMessage } from "../../native-binary-error.ts";
import type { CodexToolProvider } from "../../adapter/codex-tool-provider.ts";
import { codexToolProviderEnv } from "../../adapter/codex-tool-provider.ts";
import type { BoundaryRecord, BoundaryValue } from "../boundary.ts";
import { isNumberValue, isObjectValue, isStringValue } from "../boundary.ts";

export type CodexWebRunTransportErrorKind =
  | "missing_binary"
  | "cancelled"
  | "stale_session"
  | "auth"
  | "config"
  | "request"
  | "network"
  | "quota"
  | "transport"
  | "protocol";

export class CodexWebRunTransportError extends Error {
  readonly kind: CodexWebRunTransportErrorKind;
  readonly status: number | undefined;

  constructor(
    kind: CodexWebRunTransportErrorKind,
    message: string,
    options: ErrorOptions & { status?: number | undefined } = {},
  ) {
    super(message, options);
    this.name = "CodexWebRunTransportError";
    this.kind = kind;
    this.status = options.status;
  }
}

export interface OpenAICodexWebRunRequest {
  binaryPath: string | undefined;
  params: BoundaryRecord;
  provider: CodexToolProvider;
  sessionId: string;
  model?: string | undefined;
  signal?: AbortSignal | undefined | null;
  isSessionCurrent?: (() => boolean) | undefined;
}

export interface OpenAICodexWebRunResult {
  text: string;
  details: BoundaryRecord;
}

interface WebRunRequest extends BoundaryRecord {
  id: string;
  model?: string | undefined;
}

interface StructuredFailure {
  status: number | undefined;
  code: string | undefined;
  message: string | undefined;
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);
const TERMINATION_GRACE_MS = 100;

function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function errorCode(value: BoundaryValue): string | undefined {
  if (!isObjectValue(value)) return undefined;
  return isStringValue(value["code"]) ? value["code"] : undefined;
}

function structuredFailure(text: string): StructuredFailure | undefined {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObjectValue(parsed)) return undefined;
  const nested = isObjectValue(parsed["error"]) ? parsed["error"] : undefined;
  const statusValue = parsed["status"] ?? parsed["status_code"] ?? nested?.["status"];
  const codeValue = parsed["code"] ?? nested?.["code"];
  const messageValue = parsed["message"] ?? nested?.["message"];
  return {
    status: isNumberValue(statusValue) ? statusValue : undefined,
    code: isStringValue(codeValue) ? codeValue : undefined,
    message: isStringValue(messageValue) ? messageValue : undefined,
  };
}

function classifyStructuredFailure(failure: StructuredFailure): CodexWebRunTransportErrorKind {
  if (failure.status === 401 || failure.status === 403) return "auth";
  if (failure.status === 429) return "quota";
  if (failure.status !== undefined && failure.status >= 400 && failure.status < 500)
    return "request";
  if (failure.status !== undefined && failure.status >= 500) return "transport";
  switch (failure.code) {
    case "authentication_error":
    case "invalid_api_key":
      return "auth";
    case "insufficient_quota":
    case "rate_limit_exceeded":
      return "quota";
    case "invalid_request_error":
      return "request";
    default:
      return "transport";
  }
}

function assertRunnable(
  signal: AbortSignal | undefined | null,
  isSessionCurrent: (() => boolean) | undefined,
): void {
  if (signal?.aborted) throw new CodexWebRunTransportError("cancelled", "web_run was cancelled");
  if (isSessionCurrent && !isSessionCurrent())
    throw new CodexWebRunTransportError("stale_session", "web_run session is no longer current");
}

function runWebRunBinary(
  binaryPath: string,
  request: WebRunRequest,
  env: NodeJS.ProcessEnv,
  secrets: readonly string[],
  signal: AbortSignal | undefined | null,
  isSessionCurrent: (() => boolean) | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      assertRunnable(signal, isSessionCurrent);
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let processError: Error | undefined;
    let terminationError: CodexWebRunTransportError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(binaryPath, ["-"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const terminate = (error: CodexWebRunTransportError) => {
      terminationError ??= error;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
    };
    const onAbort = () => {
      terminate(new CodexWebRunTransportError("cancelled", "web_run was cancelled"));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      processError = error;
    });
    child.on("close", (code) =>
      finish(() => {
        if (terminationError) {
          reject(terminationError);
          return;
        }
        if (processError) {
          const error = processError;
          const errorValue = errorCode(error);
          let kind: CodexWebRunTransportErrorKind = "transport";
          if (errorValue === "ENOENT") kind = "missing_binary";
          else if (NETWORK_ERROR_CODES.has(errorValue ?? "")) kind = "network";
          reject(
            new CodexWebRunTransportError(
              kind,
              redactSecrets(formatNativeBinaryError("web_run", error, { binaryPath }), secrets),
              { cause: error },
            ),
          );
          return;
        }
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const detail =
          redactSecrets(stderr, secrets).trim() || `web_run exited with code ${code ?? "unknown"}`;
        const nativeFailure = nativeBinaryRecoveryMessage("web_run", detail);
        if (nativeFailure) {
          reject(new CodexWebRunTransportError("transport", nativeFailure));
          return;
        }
        const failure = structuredFailure(redactSecrets(stderr, secrets).trim());
        reject(
          new CodexWebRunTransportError(
            failure ? classifyStructuredFailure(failure) : "transport",
            failure?.message?.trim() || detail,
            { status: failure?.status },
          ),
        );
      }),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.on("error", (error) => {
      if (settled) return;
      processError = error;
      terminate(
        new CodexWebRunTransportError("transport", redactSecrets(error.message, secrets), {
          cause: error,
        }),
      );
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function formatWebRunOutput(parsed: BoundaryRecord): string | undefined {
  const outputText = parsed["output"] ?? parsed["output_text"] ?? parsed["text"];
  if (isStringValue(outputText) && outputText.trim()) return outputText;
  if (parsed["search_results"] !== undefined) return JSON.stringify(parsed, null, 2);
  if (
    Array.isArray(parsed["content"]) ||
    Array.isArray(parsed["open"]) ||
    Array.isArray(parsed["find"])
  )
    return JSON.stringify(parsed, null, 2);
  return undefined;
}

/** Execute the native Codex web helper with already-resolved OpenAI credentials. */
async function executeCodexWebRun(
  options: OpenAICodexWebRunRequest,
  requireOpenAI: boolean,
): Promise<OpenAICodexWebRunResult> {
  const binaryPath = options.binaryPath;
  const sessionId = options.sessionId;
  const model = options.model;
  const signal = options.signal;
  const isSessionCurrent = options.isSessionCurrent;
  const params = options.params;
  const provider = options.provider;
  assertRunnable(signal, isSessionCurrent);
  if (!binaryPath)
    throw new CodexWebRunTransportError(
      "missing_binary",
      `web_run binary is not bundled for ${process.platform}-${process.arch}`,
    );
  if (requireOpenAI && provider.route !== "openai-codex")
    throw new CodexWebRunTransportError(
      "config",
      "Native OpenAI web search requires the OpenAI Codex subscription transport",
    );
  const request: WebRunRequest = { ...params, id: sessionId };
  if (model) request["model"] = model;
  const stdout = await runWebRunBinary(
    binaryPath,
    request,
    codexToolProviderEnv(provider),
    [provider.token, provider.accountId],
    signal,
    isSessionCurrent,
  );
  assertRunnable(signal, isSessionCurrent);
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new CodexWebRunTransportError(
      "protocol",
      "web_run returned invalid structured JSON output",
      { cause: error },
    );
  }
  if (!isObjectValue(parsed))
    throw new CodexWebRunTransportError(
      "protocol",
      "web_run returned invalid structured JSON output",
    );
  const output = formatWebRunOutput(parsed);
  if (!output) throw new CodexWebRunTransportError("protocol", "web_run search returned no output");
  return { text: output, details: parsed };
}

/** Execute the helper for the standalone tool's legacy configured-provider route. */
export function executeConfiguredCodexWebRun(
  options: OpenAICodexWebRunRequest,
): Promise<OpenAICodexWebRunResult> {
  return executeCodexWebRun(options, false);
}

/** Execute a backend-adapter request, rejecting non-OpenAI provider credentials. */
export function executeOpenAICodexWebRun(
  options: OpenAICodexWebRunRequest,
): Promise<OpenAICodexWebRunResult> {
  return executeCodexWebRun(options, true);
}
