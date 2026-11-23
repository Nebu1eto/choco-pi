/**
 * host-slot.ts — Host-scoped coordination of which extension owns Code Mode.
 *
 * Pi gives each extension its own `ExtensionAPI` (and its own module
 * evaluation), so neither an API object nor module state can be shared. All
 * extensions of one Pi runtime do share the event bus behind `pi.events`, and
 * its `emit` runs listeners synchronously. The owner answers a probe on
 * CODE_MODE_HOST_CHANNEL by filling in the probe's `owner`; a later extension
 * probes before registering anything and stands down when an owner answered.
 *
 * - A provider that composes Code Mode with its own ports (choco-pi-codex)
 *   claims the slot as `provider`; the standalone extension then registers
 *   nothing, so no Code Mode or core tool is registered twice.
 * - The standalone extension (`src/extension.ts`) claims it as `standalone`
 *   when it loads first or alone.
 *
 * A host without a working `pi.events` (unit-test fakes) has no slot: probes
 * find no owner and claims are no-ops.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isFunctionValue,
  isObjectValue,
  isStringValue,
  type BoundaryValue,
} from "./tools/boundary.ts";

/** Do not rename: a live cross-extension runtime contract. */
export const CODE_MODE_HOST_CHANNEL = "choco-pi:code-mode-host/v1";

export type CodeModeHostOwnerKind = "provider" | "standalone";

export interface CodeModeHostOwner {
  kind: CodeModeHostOwnerKind;
  /** Package directory name of the owning extension, e.g. `choco-pi-codex`. */
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

/** The extension that already owns Code Mode on this Pi runtime, if any. */
export function probeCodeModeHostOwner(pi: ExtensionAPI): CodeModeHostOwner | undefined {
  if (!hasEventBus(pi)) return undefined;
  const probe: CodeModeHostProbe = { protocol: CODE_MODE_HOST_CHANNEL, owner: undefined };
  pi.events.emit(CODE_MODE_HOST_CHANNEL, probe);
  return probe.owner;
}

/**
 * Answer later probes with `owner`; the first claim on a runtime wins. Returns
 * the release function. Pi drops the listener when the extension reloads.
 */
export function claimCodeModeHost(pi: ExtensionAPI, owner: CodeModeHostOwner): () => void {
  if (!hasEventBus(pi)) return () => {};
  const claimed: CodeModeHostOwner = { kind: owner.kind, name: owner.name };
  return pi.events.on(CODE_MODE_HOST_CHANNEL, (data) => {
    if (!isCodeModeHostProbe(data) || data.owner !== undefined) return;
    if (isStringValue(claimed.name)) data.owner = { ...claimed };
  });
}
