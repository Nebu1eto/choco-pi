import {
  isFiniteNumber,
  isObjectRecord,
  isString,
  type LspBoundaryValue,
  type LspDictionaryValue,
} from "./runtime-guards.ts";

import { captureReadContentBinding, type ReadContentBinding } from "./read-guard.ts";

export const READ_BRIDGE_KEY: unique symbol = Symbol.for("choco-pi-lsp:read-bridge");

export interface ReadBridgeEntry {
  filePath: string;
  requestedOffset: number;
  requestedLimit: number | undefined;
  consumer?: string;
}

export interface ReadBridge {
  readonly version: 1;
  recordRead(entry: ReadBridgeEntry): void;
}

interface BridgeDeps {
  getReadGuard(): {
    recordRead(record: {
      filePath: string;
      requestedOffset: number;
      requestedLimit: number;
      effectiveOffset: number;
      effectiveLimit: number;
      expandedByLsp: boolean;
      turnIndex: number;
      writeIndex: number;
      timestamp: number;
      source?: string;
      contentBinding?: ReadContentBinding;
    }): void;
  };
  getTurnIndex(): number;
  peekWriteIndex(): number;
  isRecordable(filePath: string): boolean;
}

function isValidEntry(entry: LspBoundaryValue): entry is ReadBridgeEntry {
  if (!isObjectRecord(entry) || entry === null) return false;

  // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
  const e = entry as Record<string, LspDictionaryValue>;

  if (!isString(e["filePath"]) || e["filePath"] === "") return false;

  const offset = e["requestedOffset"];
  if (
    !isFiniteNumber(offset) ||
    !Number.isFinite(offset) ||
    offset < 1 ||
    !Number.isInteger(offset)
  )
    return false;

  const limit = e["requestedLimit"];
  if (limit !== undefined) {
    if (!isFiniteNumber(limit) || !Number.isFinite(limit) || limit < 1 || !Number.isInteger(limit))
      return false;
  }

  return true;
}

export function registerReadBridge(deps: BridgeDeps): void {
  // SAFETY: This module owns the symbol or process-global slot and writes only the declared state representation.
  if (READ_BRIDGE_KEY in (globalThis as object)) return;

  const bridge: ReadBridge = Object.freeze({
    version: 1 as const,
    recordRead(entry: ReadBridgeEntry): void {
      if (!isValidEntry(entry)) return;

      if (!deps.isRecordable(entry.filePath)) return;

      const offset = entry.requestedOffset;
      const limit = entry.requestedLimit ?? Number.MAX_SAFE_INTEGER;
      const contentBinding = captureReadContentBinding(entry.filePath, offset, limit);

      deps.getReadGuard().recordRead({
        filePath: entry.filePath,
        requestedOffset: offset,
        requestedLimit: limit,
        effectiveOffset: offset,
        effectiveLimit: limit,
        expandedByLsp: false,
        turnIndex: deps.getTurnIndex(),
        writeIndex: deps.peekWriteIndex(),
        timestamp: Date.now(),
        source: `bridge:${entry.consumer ?? "unknown"}`,
        ...(contentBinding !== undefined && { contentBinding }),
      });
    },
  });

  Object.defineProperty(globalThis, READ_BRIDGE_KEY, {
    value: bridge,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}
