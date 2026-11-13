import { osInfo } from "./node-runtime.ts";

/**
 * Codex CLI release whose wire identity this provider mirrors. openai/codex sends its
 * `CARGO_PKG_VERSION` both as the `version` header and inside the User-Agent; this matches the
 * codex-cli build the request shape was last verified against.
 */
export const CODEX_CLIENT_VERSION = "0.162.1";

export type CodexRequestKind = "turn" | "prewarm";

export interface CodexTurnMetadata {
  requestKind: CodexRequestKind;
  model: string;
  reasoningEffort?: string | undefined;
}

interface MacProductVersionCache {
  current: string | undefined;
}

const macProductVersion: MacProductVersionCache = { current: undefined };

if (globalThis.process?.platform === "darwin") {
  import("node:fs/promises")
    .then((fs) => fs.readFile("/System/Library/CoreServices/SystemVersion.plist", "utf8"))
    .then((plist) => {
      macProductVersion.current = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/
        .exec(plist)?.[1]
        ?.trim();
    })
    .catch(() => {
      macProductVersion.current = undefined;
    });
}

/** Mirrors `os_info`'s `{os_type} {version}; {architecture}` segment of the Codex User-Agent. */
function osDescriptor(): string {
  const os = osInfo.current;
  if (!os) return "Unknown unknown; unknown";
  const platform = os.platform();
  const machine = os.arch() === "x64" ? "x86_64" : os.arch();
  if (platform === "darwin")
    return `Mac OS ${macProductVersion.current ?? os.release()}; ${machine}`;
  if (platform === "win32") return `Windows ${os.release()}; ${machine}`;
  if (platform === "linux") return `Linux ${os.release()}; ${machine}`;
  return `${platform} ${os.release()}; ${machine}`;
}

/**
 * Mirrors codex terminal-detection `user_agent_token`: TERM_PROGRAM[/version], then TERM, with
 * characters outside `[A-Za-z0-9._/-]` replaced by `_`.
 */
function terminalToken(): string {
  return rawTerminalToken().replace(/[^A-Za-z0-9._/-]/g, "_");
}

function rawTerminalToken(): string {
  const env = globalThis.process?.env ?? {};
  const program = env["TERM_PROGRAM"]?.trim();
  if (program && program.toLowerCase() !== "tmux") {
    const version = env["TERM_PROGRAM_VERSION"]?.trim();
    return version ? `${program}/${version}` : program;
  }
  return env["TERM"]?.trim() || "unknown";
}

/** Replaces characters outside printable ASCII, as Codex's `sanitize_user_agent` does. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "_");
}

/** Mirrors openai/codex `get_codex_user_agent` for a client that sets no suffix. */
export function codexUserAgent(originator: string): string {
  return sanitizeHeaderValue(
    `${originator}/${CODEX_CLIENT_VERSION} (${osDescriptor()}) ${terminalToken()}`,
  );
}

/**
 * Codex window ids are `<thread>:<auto-compaction window number>`. This provider does not track
 * compaction windows, so every request reports window 0.
 */
export function codexWindowId(threadId: string): string {
  return `${threadId}:0`;
}

/** ASCII-only JSON, matching Codex's `to_ascii_json_string` for header-safe metadata. */
function toAsciiJson(value: CodexTurnMetadataPayload): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The `x-codex-turn-metadata` subset this provider can state truthfully. */
export function codexTurnMetadataHeader(threadId: string, metadata: CodexTurnMetadata): string {
  const payload: CodexTurnMetadataPayload = {
    session_id: threadId,
    thread_id: threadId,
    window_id: codexWindowId(threadId),
    window_number: 0,
    request_kind: metadata.requestKind,
    model: metadata.model,
  };
  if (metadata.reasoningEffort) payload.reasoning_effort = metadata.reasoningEffort;
  return toAsciiJson(payload);
}

interface CodexTurnMetadataPayload {
  session_id: string;
  thread_id: string;
  window_id: string;
  window_number: number;
  request_kind: CodexRequestKind;
  model: string;
  reasoning_effort?: string;
}
