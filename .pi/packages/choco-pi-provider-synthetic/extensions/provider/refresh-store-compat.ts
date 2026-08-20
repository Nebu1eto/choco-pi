// ---------------------------------------------------------------------------
// Backward-compat shim for the Pi coding-agent provider refresh context.
//
// Pi 0.84 replaced dynamic `context.store` read/write access with the
// read-only `context.stored` snapshot and the generation-checked
// `context.publish({ persist })` transaction. This module detects the
// available API shape at runtime so the extension works on both <0.84 (store)
// and >=0.84 (publish) hosts.
//
// Once the minimum supported @earendil-works/pi-coding-agent version is
// >=0.84, delete this file and:
//   - replace `readStoredModels(context)` with `context.stored`
//   - replace `persistModels(context, entry)` with
//     `await context.publish({ persist: entry })` (skip when aborted)
// ---------------------------------------------------------------------------

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const SyntheticModelsStoreEntrySchema = Type.Object({
  models: Type.Array(Type.Unknown()),
  lastModified: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  checkedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  etag: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export type SyntheticModelsStoreEntry = Static<typeof SyntheticModelsStoreEntrySchema>;

const BooleanSchema = Type.Boolean();

type StoreBoundaryValue = {} | null | undefined;

interface LegacyStore {
  read: () => Promise<StoreBoundaryValue>;
  write: (entry: SyntheticModelsStoreEntry) => Promise<StoreBoundaryValue>;
}

type LegacyRefreshModelsContext = RefreshModelsContext & {
  store?: StoreBoundaryValue;
};

function isLegacyStore(value: StoreBoundaryValue): value is LegacyStore {
  if (
    value === null ||
    Object(value) !== value ||
    Array.isArray(value) ||
    value instanceof Function
  ) {
    return false;
  }
  // SAFETY: The non-enumerating checks above establish an object whose two consumed members are guarded below.
  const store = value as { read?: StoreBoundaryValue; write?: StoreBoundaryValue };
  return store.read instanceof Function && store.write instanceof Function;
}

/**
 * Returns the persisted catalog entry for the current provider, reading from
 * the 0.84+ `context.stored` snapshot when available and falling back to the
 * legacy `context.store.read()` on older hosts.
 */
export async function readStoredModels(
  context: RefreshModelsContext,
): Promise<SyntheticModelsStoreEntry | undefined> {
  if (context.stored !== undefined) {
    return Value.Check(SyntheticModelsStoreEntrySchema, context.stored)
      ? context.stored
      : undefined;
  }
  return readLegacyStore(context);
}

async function readLegacyStore(
  context: RefreshModelsContext,
): Promise<SyntheticModelsStoreEntry | undefined> {
  const legacy: LegacyRefreshModelsContext = context;
  if (!isLegacyStore(legacy.store)) return undefined;
  const entry = await legacy.store.read();
  return Value.Check(SyntheticModelsStoreEntrySchema, entry) ? entry : undefined;
}

/**
 * Persists the catalog entry, publishing through
 * `context.publish({ persist: entry })` on 0.84+ hosts and writing through
 * the legacy `context.store.write(entry)` on older hosts.
 *
 * Returns true when the entry was persisted. On 0.84+ hosts a return value of
 * false means a newer refresh superseded this publication (generation check).
 */
export async function persistModels(
  context: RefreshModelsContext,
  entry: SyntheticModelsStoreEntry,
): Promise<boolean> {
  if (!Value.Check(SyntheticModelsStoreEntrySchema, entry)) return false;

  const publish: unknown = context.publish;
  if (publish instanceof Function) {
    const result = await publish({ persist: entry });
    return Value.Check(BooleanSchema, result) && result;
  }

  const legacy: LegacyRefreshModelsContext = context;
  if (!isLegacyStore(legacy.store)) return false;
  await legacy.store.write(entry);
  return true;
}
