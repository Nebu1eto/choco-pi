import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isFunctionValue,
  isObjectValue,
  isStringValue,
  type BoundaryValue,
} from "./tools/boundary.ts";

export const CODE_MODE_HOST_CHANNEL = "choco-pi:code-mode-host/v1";

export type CodeModeHostOwnerKind = "provider" | "standalone";

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

export function probeCodeModeHostOwner(pi: ExtensionAPI): CodeModeHostOwner | undefined {
  if (!hasEventBus(pi)) return undefined;
  const probe: CodeModeHostProbe = { protocol: CODE_MODE_HOST_CHANNEL, owner: undefined };
  pi.events.emit(CODE_MODE_HOST_CHANNEL, probe);
  return probe.owner;
}

export function claimCodeModeHost(pi: ExtensionAPI, owner: CodeModeHostOwner): () => void {
  if (!hasEventBus(pi)) return () => {};
  const claimed: CodeModeHostOwner = { kind: owner.kind, name: owner.name };
  return pi.events.on(CODE_MODE_HOST_CHANNEL, (data) => {
    if (!isCodeModeHostProbe(data) || data.owner !== undefined) return;
    if (isStringValue(claimed.name)) data.owner = { ...claimed };
  });
}
