import type { BoundaryValue } from "../boundary.ts";
import { isFunctionValue, isObjectValue } from "../boundary.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PREFLIGHT_PROTOCOL = "@howaboua/pi-codex-conversion/code-mode-preflight/v1";
export const PREFLIGHT_REQUEST_CHANNEL = `${PREFLIGHT_PROTOCOL}/request`;
export const PREFLIGHT_AVAILABLE_CHANNEL = `${PREFLIGHT_PROTOCOL}/available`;

export interface CodeModeToolPreflightCall {
  toolName: string;
  input: unknown;
  toolCallId: string;
  cwd: string;
  extensionContext: ExtensionContext;
  signal: AbortSignal;
}

export type CodeModeToolPreflightResult = { block: true; reason: string } | { block?: false };

export type CodeModeToolPreflight = (
  call: CodeModeToolPreflightCall,
) => CodeModeToolPreflightResult | void | Promise<CodeModeToolPreflightResult | void>;

export interface PreflightBroker {
  protocol: typeof PREFLIGHT_PROTOCOL;
  isActive(): boolean;
  register(preflight: CodeModeToolPreflight): () => void;
}

export function isProtocolRequest(value: BoundaryValue): boolean {
  return Boolean(
    value && isObjectValue(value) && "protocol" in value && value.protocol === PREFLIGHT_PROTOCOL,
  );
}

export function isPreflightBroker(value: BoundaryValue): value is PreflightBroker {
  return Boolean(
    value &&
    isObjectValue(value) &&
    "protocol" in value &&
    value.protocol === PREFLIGHT_PROTOCOL &&
    "isActive" in value &&
    isFunctionValue(value.isActive) &&
    "register" in value &&
    isFunctionValue(value.register),
  );
}
