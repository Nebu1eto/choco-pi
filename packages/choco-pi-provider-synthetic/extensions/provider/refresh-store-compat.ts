import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { arr, bool, compile, nullable, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { finiteNum } from "../../src/schema.ts";

export const SyntheticModelsStoreEntrySchema = obj(
  {
    models: arr(unknown()),
    lastModified: opt(nullable(finiteNum())),
    checkedAt: opt(nullable(finiteNum())),
    etag: opt(nullable(str())),
  },
  { open: true },
);

const isModelsStoreEntry = compile(SyntheticModelsStoreEntrySchema).check;

export type SyntheticModelsStoreEntry = Static<typeof SyntheticModelsStoreEntrySchema>;

const isBoolean = compile(bool()).check;

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

export async function readStoredModels(
  context: RefreshModelsContext,
): Promise<SyntheticModelsStoreEntry | undefined> {
  if (context.stored !== undefined) {
    return isModelsStoreEntry(context.stored) ? context.stored : undefined;
  }
  return readLegacyStore(context);
}

async function readLegacyStore(
  context: RefreshModelsContext,
): Promise<SyntheticModelsStoreEntry | undefined> {
  const legacy: LegacyRefreshModelsContext = context;
  if (!isLegacyStore(legacy.store)) return undefined;
  const entry = await legacy.store.read();
  return isModelsStoreEntry(entry) ? entry : undefined;
}

export async function persistModels(
  context: RefreshModelsContext,
  entry: SyntheticModelsStoreEntry,
): Promise<boolean> {
  if (!isModelsStoreEntry(entry)) return false;

  const publish: unknown = context.publish;
  if (publish instanceof Function) {
    const result = await publish({ persist: entry });
    return isBoolean(result) && result;
  }

  const legacy: LegacyRefreshModelsContext = context;
  if (!isLegacyStore(legacy.store)) return false;
  await legacy.store.write(entry);
  return true;
}
