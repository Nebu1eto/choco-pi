import { osInfo } from "./node-runtime.ts";

export const CODEX_CLIENT_VERSION = "0.169.0";

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

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "_");
}

export function codexUserAgent(originator: string): string {
  return sanitizeHeaderValue(
    `${originator}/${CODEX_CLIENT_VERSION} (${osDescriptor()}) ${terminalToken()}`,
  );
}

export function codexWindowId(threadId: string): string {
  return `${threadId}:0`;
}

function toAsciiJson(value: CodexTurnMetadataPayload): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

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
