import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type {
  CodexDiagnosticsFailure,
  CodexDiagnosticsFailureCategory,
  CodexDiagnosticsSink,
} from "./types.ts";

const DiagnosticRecordType = Type.Record(Type.String(), Type.Unknown());
type DiagnosticRecord = Static<typeof DiagnosticRecordType>;
const DiagnosticRecordSchema = Type.Unsafe<DiagnosticRecord>({ type: "object" });
const StringSchema = Type.String();
const NumberSchema = Type.Number();

function record<T>(value: T): DiagnosticRecord | undefined {
  return Check(DiagnosticRecordSchema, value) ? value : undefined;
}

function safeCode<T>(value: T): string | undefined {
  return Check(StringSchema, value) && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : undefined;
}

function statusCode<T>(value: T): number | undefined {
  const parsed = Check(StringSchema, value) && /^\d{3}$/.test(value) ? Number(value) : value;
  return Check(NumberSchema, parsed) && Number.isInteger(parsed) && parsed >= 100 && parsed <= 599
    ? parsed
    : undefined;
}

function category(description: string): CodexDiagnosticsFailureCategory {
  if (/abort/i.test(description)) return "aborted";
  if (/401|403|unauthori[sz]ed|forbidden|authentication|token expired/i.test(description))
    return "authentication";
  if (/websocket_connection_limit_reached|connection limit/i.test(description))
    return "connection_limit";
  if (/1009|message too big/i.test(description)) return "message_too_big";
  if (/previous_response_not_found|previous response.*not found/i.test(description))
    return "previous_response_missing";
  if (/server_is_overloaded|slow_down|overload/i.test(description)) return "overload";
  if (/rate.?limit|429/i.test(description)) return "rate_limit";
  if (/timed? out|timeout/i.test(description)) return "timeout";
  if (/protocol|invalid response|unhandled.*status/i.test(description)) return "protocol";
  if (/websocket|socket|connection|network|fetch/i.test(description)) return "connection";
  if (description) return "transport";
  return "unknown";
}

export function codexDiagnosticsFailure<T>(error: T): CodexDiagnosticsFailure {
  const outer = record(error);
  const payload = record(outer?.["payload"]);
  const response = record(payload?.["response"]);
  const responseError = record(response?.["error"]);
  const code =
    safeCode(outer?.["code"]) ??
    safeCode(payload?.["code"]) ??
    safeCode(responseError?.["code"]) ??
    safeCode(responseError?.["type"]);
  const status =
    statusCode(outer?.["status"]) ??
    statusCode(payload?.["status"]) ??
    statusCode(responseError?.["status"]);
  const description = [
    error instanceof Error ? error.name : undefined,
    error instanceof Error ? error.message : Check(StringSchema, error) ? error : undefined,
    code,
    status,
  ]
    .filter((value) => value !== undefined)
    .join(" ");
  const failure: CodexDiagnosticsFailure = { category: category(description) };
  if (code) failure.code = code;
  if (status !== undefined) failure.status = status;
  return failure;
}

export function noThrowCodexDiagnosticsSink(
  sink: CodexDiagnosticsSink | undefined,
): CodexDiagnosticsSink | undefined {
  if (!sink) return undefined;
  return (event) => {
    try {
      sink(event);
    } catch {
      // Optional diagnostics must never change provider execution.
    }
  };
}
