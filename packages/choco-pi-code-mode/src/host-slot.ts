import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isFunctionValue,
  isObjectValue,
  isStringValue,
  type BoundaryValue,
} from "./tools/boundary.ts";

/** Cross-extension event-bus channel for negotiating single-owner code-mode registration. */
export const CODE_MODE_HOST_CHANNEL = "choco-pi:code-mode-host/v1";

/** Distinguishes a provider-bundled code-mode host from the standalone fallback package. */
export type CodeModeHostOwnerKind = "provider" | "standalone";

/** Identity of the extension claiming ownership of the code-mode host slot. */
export interface CodeModeHostOwner {
  kind: CodeModeHostOwnerKind;
  name: string;
}

interface CodeModeHostProbe {
  protocol: typeof CODE_MODE_HOST_CHANNEL;
  owner: CodeModeHostOwner | undefined;
}

function isCodeModeHostProbe(value: BoundaryValue): value is CodeModeHostProbe {
  return (
    isObjectValue(value) &&
    "protocol" in value &&
    value.protocol === CODE_MODE_HOST_CHANNEL &&
    "owner" in value
  );
}

function hasEventBus(pi: ExtensionAPI): boolean {
  const events: BoundaryValue = pi.events;
  return (
    isObjectValue(events) &&
    "emit" in events &&
    isFunctionValue(events.emit) &&
    "on" in events &&
    isFunctionValue(events.on)
  );
}

/** Synchronously queries `pi.events` to check whether another extension has already claimed the code-mode host. */
export function probeCodeModeHostOwner(pi: ExtensionAPI): CodeModeHostOwner | undefined {
  if (!hasEventBus(pi)) return undefined;
  const probe: CodeModeHostProbe = { protocol: CODE_MODE_HOST_CHANNEL, owner: undefined };
  pi.events.emit(CODE_MODE_HOST_CHANNEL, probe);
  return probe.owner;
}

/** Registers an event-bus responder that claims the code-mode host slot until its disposer runs. */
export function claimCodeModeHost(pi: ExtensionAPI, owner: CodeModeHostOwner): () => void {
  if (!hasEventBus(pi)) return () => {};
  const claimed: CodeModeHostOwner = { kind: owner.kind, name: owner.name };
  return pi.events.on(CODE_MODE_HOST_CHANNEL, (data) => {
    if (!isCodeModeHostProbe(data) || data.owner !== undefined) return;
    if (isStringValue(claimed.name)) data.owner = { ...claimed };
  });
}
