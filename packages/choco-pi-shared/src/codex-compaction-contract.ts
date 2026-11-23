import { arr, bool, compile, obj, str } from "@earendil-works/pi-schema";
import { isObject, type RuntimeValue } from "./runtime-values.ts";
import { deleteGlobalSlot, readGlobalSlot, writeGlobalSlot } from "./symbols.ts";

/** Cross-extension `globalThis` slot protocol for reading Codex compaction settings across jiti `moduleCache: false` boundaries. */
export const CODEX_COMPACTION_CONFIG_READER_PROTOCOL = "choco-pi:codex-compaction-config-reader/v1";
export const CODEX_COMPACTION_CONFIG_READER_KEY = Symbol.for(
  CODEX_COMPACTION_CONFIG_READER_PROTOCOL,
);

/** Normalized Codex compaction configuration snapshot shared between provider and compaction extensions. */
export interface CodexCompactionSnapshotContract {
  readonly responsesCompaction: boolean;
  readonly additionalProviders: readonly string[];
}

/** Workspace trust and directory inputs passed to the registered Codex compaction config reader. */
export interface CodexCompactionConfigReadOptions {
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

/** Callback registered in the global slot to supply Codex compaction settings on demand. */
export type CodexCompactionConfigReader = (
  options: CodexCompactionConfigReadOptions,
) => CodexCompactionSnapshotContract;

interface RegisteredReaderEntry {
  readonly protocol: typeof CODEX_COMPACTION_CONFIG_READER_PROTOCOL;
  readonly read: CodexCompactionConfigReader;
}

interface ReaderCandidate {
  protocol?: RuntimeValue;
  read?: RuntimeValue;
}

function isRegisteredReaderEntry<T extends RuntimeValue>(
  value: T,
): value is T & RegisteredReaderEntry {
  if (!isObject(value) || value === null || Array.isArray(value)) return false;
  const candidate: ReaderCandidate = value;
  return (
    candidate.protocol === CODEX_COMPACTION_CONFIG_READER_PROTOCOL &&
    candidate.read instanceof Function
  );
}

const isSnapshot = compile(
  obj({ responsesCompaction: bool(), additionalProviders: arr(str()) }, { open: false }),
).check;

export function publishCodexCompactionConfigReader(read: CodexCompactionConfigReader): () => void {
  const entry: RegisteredReaderEntry = {
    protocol: CODEX_COMPACTION_CONFIG_READER_PROTOCOL,
    read,
  };
  writeGlobalSlot(CODEX_COMPACTION_CONFIG_READER_KEY, entry);
  return () => {
    if (readGlobalSlot(CODEX_COMPACTION_CONFIG_READER_KEY) === entry) {
      deleteGlobalSlot(CODEX_COMPACTION_CONFIG_READER_KEY);
    }
  };
}

export function readRegisteredCodexCompactionSnapshot(
  options: CodexCompactionConfigReadOptions,
): CodexCompactionSnapshotContract | undefined {
  const entry = readGlobalSlot(CODEX_COMPACTION_CONFIG_READER_KEY);
  if (!isRegisteredReaderEntry(entry)) return undefined;
  try {
    const raw: RuntimeValue = entry.read(options);
    if (!isSnapshot(raw)) return undefined;
    return {
      responsesCompaction: raw.responsesCompaction,
      additionalProviders: [...raw.additionalProviders],
    };
  } catch {
    return undefined;
  }
}
