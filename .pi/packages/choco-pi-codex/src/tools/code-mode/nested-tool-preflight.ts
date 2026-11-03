import type { BoundaryValue } from "../boundary.ts";
import { isObjectValue, isStringValue } from "../boundary.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createScratchWarner,
  loadScratchGrants,
  scratchDestinations,
} from "../../../../../extensions/lib/scratch-path.ts";
import {
  type CodeModeToolPreflight,
  type CodeModeToolPreflightCall,
  isProtocolRequest,
  PREFLIGHT_AVAILABLE_CHANNEL,
  PREFLIGHT_PROTOCOL,
  PREFLIGHT_REQUEST_CHANNEL,
  type PreflightBroker,
} from "./preflight-protocol.ts";
import type { ToolExecutionContext } from "./types.ts";

/** Resolves to non-blocking warnings the caller delivers to the agent. */
export type CodeModeToolPreflightRunner = (
  call: CodeModeToolPreflightCall,
) => Promise<readonly string[]>;

interface BrokerRegistration {
  run: CodeModeToolPreflightRunner;
}

export function registerCodeModePreflightBroker(pi: ExtensionAPI): BrokerRegistration {
  const preflights = new Set<CodeModeToolPreflight>();
  let active = true;
  // Warn mode: temporary files outside the session scratch directory are reported, never blocked.
  let grants: Promise<string[]> | undefined;
  const scratchWarner = createScratchWarner({ grants: () => (grants ??= loadScratchGrants()) });
  const broker: PreflightBroker = {
    protocol: PREFLIGHT_PROTOCOL,
    isActive: () => active,
    register(preflight) {
      if (!active) return () => {};
      preflights.add(preflight);
      return () => preflights.delete(preflight);
    },
  };
  const announce = () => {
    if (active) pi.events.emit(PREFLIGHT_AVAILABLE_CHANNEL, broker);
  };
  pi.events.on(PREFLIGHT_REQUEST_CHANNEL, (value) => {
    if (isProtocolRequest(value)) announce();
  });
  pi.on("session_start", () => {
    grants = undefined;
    scratchWarner.reset();
  });
  pi.on("session_shutdown", () => {
    active = false;
    preflights.clear();
  });
  announce();
  return {
    async run(call) {
      const destinations = scratchDestinations(call.toolName, call.input);
      const warnings =
        destinations.length === 0
          ? []
          : await scratchWarner.check({
              sessionId: call.extensionContext.sessionManager.getSessionId(),
              toolName: call.toolName,
              cwd: call.cwd,
              destinations,
            });
      call.signal.throwIfAborted();
      for (const preflight of Array.from(preflights)) {
        call.signal.throwIfAborted();
        const pending = Promise.resolve().then(() => preflight(preflightSnapshot(call)));
        void pending.catch(() => undefined);
        const result = await raceAbort(pending, call.signal);
        call.signal.throwIfAborted();
        if (result?.block !== true) continue;
        const reason = isStringValue(result.reason) ? result.reason.trim() : "";
        throw new Error(reason || `Code Mode nested tool blocked: ${call.toolName}`);
      }
      return warnings;
    },
  };
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function runCodeModeToolPreflight(
  toolName: string,
  input: BoundaryValue,
  context: ToolExecutionContext,
  signal: AbortSignal,
): Promise<readonly string[]> {
  signal.throwIfAborted();
  if (!context.preflight) return [];
  if (!context.toolCallId || !context.extensionContext)
    throw new Error("Code Mode nested tool preflight context is unavailable");
  const warnings = await context.preflight({
    toolName,
    input,
    toolCallId: context.toolCallId,
    cwd: context.cwd,
    extensionContext: context.extensionContext,
    signal,
  });
  signal.throwIfAborted();
  return warnings;
}

function preflightSnapshot(call: CodeModeToolPreflightCall): CodeModeToolPreflightCall {
  return Object.freeze({
    ...call,
    input: freezeInput(structuredClone(call.input)),
  });
}

function freezeInput(value: BoundaryValue): BoundaryValue {
  if (!value || !isObjectValue(value) || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeInput(item);
  } else {
    for (const item of Object.values(value)) freezeInput(item);
  }
  return Object.freeze(value);
}
