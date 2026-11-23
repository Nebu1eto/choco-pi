import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { hasMethods, isRecord, isString, readProperty } from "../guards.ts";

const BRIDGE_SYMBOL: unique symbol = Symbol.for("choco-pi:compaction-compact-command-bridge");

export interface CompactCommandHost {
  readonly session: { readonly sessionId: string };
}

export type CompactCommandDefer = (
  host: CompactCommandHost,
  customInstructions?: string,
) => Promise<boolean>;

type OriginalHandler = (this: CompactCommandHost, customInstructions?: string) => Promise<void>;

interface CompactCommandBridge {
  readonly original: OriginalHandler;
  readonly defers: Set<CompactCommandDefer>;
}

interface CompactCommandPrototype {
  handleCompactCommand: (this: CompactCommandHost, customInstructions?: string) => Promise<void>;
}

function isCompactCommandHost<T>(value: T): value is T & CompactCommandHost {
  const session = readProperty(value, "session");
  return isRecord(value) && isRecord(session) && isString(readProperty(session, "sessionId"));
}

function isBridge<T>(value: T): value is T & CompactCommandBridge {
  return hasMethods(value, ["original"]) && readProperty(value, "defers") instanceof Set;
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

export function installCompactCommandBridge(defer: CompactCommandDefer): void {
  const existing = readBridge();
  if (existing !== undefined) {
    existing.defers.add(defer);
    return;
  }
  const prototype = hostPrototype();
  const bridge: CompactCommandBridge = {
    original: prototype.handleCompactCommand,
    defers: new Set([defer]),
  };
  Object.defineProperty(globalThis, BRIDGE_SYMBOL, {
    configurable: true,
    writable: true,
    value: bridge,
  });
  prototype.handleCompactCommand = async function patchedHandleCompactCommand(
    this: CompactCommandHost,
    customInstructions?: string,
  ): Promise<void> {
    if (isCompactCommandHost(this)) {
      for (const current of bridge.defers) {
        let handled = false;
        try {
          handled = await current(this, customInstructions);
        } catch {
          handled = false;
        }
        if (handled) return;
      }
    }
    await bridge.original.call(this, customInstructions);
  };
}

export function releaseCompactCommandBridge(defer: CompactCommandDefer): void {
  readBridge()?.defers.delete(defer);
}

export function compactCommandBridgeInstalled(): boolean {
  return readBridge() !== undefined;
}

export function liveCompactCommandDefers(): number {
  return readBridge()?.defers.size ?? 0;
}
