import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// TUI /compact bridge
// ---------------------------------------------------------------------------
//
// Pi matches `/compact` by text before extension commands and before the
// `input` event, and the only hook it offers, `session_before_compact`, can
// only end the host compaction with `cancel`, which prints "Compaction
// cancelled". Taking over the interactive mode's own command handler (the way
// the settings dialog takes over `/settings`) is the only way for a plain
// `/compact` to continue in the background without that line and without
// aborting a running agent.

const BRIDGE_SYMBOL: unique symbol = Symbol.for("choco-pi:compaction-compact-command-bridge");

/** The interactive-mode fields the bridge reaches for. */
export interface CompactCommandHost {
  readonly session: { readonly sessionId: string };
}

/** Decides whether a `/compact` typed in `host` (with optional instructions) was taken over. */
export type CompactCommandDefer = (
  host: CompactCommandHost,
  customInstructions?: string,
) => Promise<boolean>;

type OriginalHandler = (this: CompactCommandHost, customInstructions?: string) => Promise<void>;

interface CompactCommandBridge {
  /** Pi's own handler, kept for custom instructions and every refused request. */
  readonly original: OriginalHandler;
  /** Replaced on every extension load; undefined while no registration is live. */
  defer: CompactCommandDefer | undefined;
}

/** The host prototype as this module reaches it: one private method it swaps. */
interface CompactCommandPrototype {
  handleCompactCommand: (this: CompactCommandHost, customInstructions?: string) => Promise<void>;
}

const HostSessionSchema = Type.Object({ session: Type.Object({ sessionId: Type.String() }) });
const BridgeSlotSchema = Type.Object({ original: Type.Function([], Type.Unknown()) });

function isCompactCommandHost<T>(value: T): value is T & CompactCommandHost {
  return Value.Check(HostSessionSchema, value);
}

function isBridge<T>(value: T): value is T & CompactCommandBridge {
  return Value.Check(BridgeSlotSchema, value);
}

function hostPrototype(): CompactCommandPrototype {
  const prototype: object = InteractiveMode.prototype;
  // SAFETY: the host declares `handleCompactCommand` privately with this signature.
  return prototype as CompactCommandPrototype;
}

function readBridge(): CompactCommandBridge | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(globalThis, BRIDGE_SYMBOL)?.value;
  return isBridge(found) ? found : undefined;
}

/**
 * Install the prototype patch once per process and bind `defer` for this
 * registration. Later installs (after `/reload`) only replace `defer`.
 */
export function installCompactCommandBridge(defer: CompactCommandDefer): void {
  const existing = readBridge();
  if (existing !== undefined) {
    existing.defer = defer;
    return;
  }
  const prototype = hostPrototype();
  const bridge: CompactCommandBridge = { original: prototype.handleCompactCommand, defer };
  Object.defineProperty(globalThis, BRIDGE_SYMBOL, {
    configurable: true,
    writable: true,
    value: bridge,
  });
  prototype.handleCompactCommand = async function patchedHandleCompactCommand(
    this: CompactCommandHost,
    customInstructions?: string,
  ): Promise<void> {
    const current = bridge.defer;
    if (current !== undefined && isCompactCommandHost(this)) {
      let handled = false;
      try {
        handled = await current(this, customInstructions);
      } catch {
        handled = false;
      }
      if (handled) return;
    }
    await bridge.original.call(this, customInstructions);
  };
}

/** Drop `defer` when it is still the one this registration installed. */
export function releaseCompactCommandBridge(defer: CompactCommandDefer): void {
  const bridge = readBridge();
  if (bridge !== undefined && bridge.defer === defer) bridge.defer = undefined;
}

/** Whether the prototype patch is installed in this process. */
export function compactCommandBridgeInstalled(): boolean {
  return readBridge() !== undefined;
}
