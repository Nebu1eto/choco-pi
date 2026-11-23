/**
 * Publishes the Codex compaction config reader (`@choco-pi/shared/codex-compaction-contract`)
 * so the compaction host reads `compaction.responsesCompaction` and
 * `scope.additionalProviders` without importing this package.
 *
 * First registration wins, like the native-compaction budget hook: a child
 * registration sharing the process neither replaces nor withdraws the
 * parent's reader. The reader is a pure function of its options, so any live
 * registration's reader answers identically.
 */
import {
  CODEX_COMPACTION_CONFIG_READER_KEY,
  type CodexCompactionConfigReader,
  publishCodexCompactionConfigReader,
} from "@choco-pi/shared/codex-compaction-contract";
import { readGlobalSlot } from "@choco-pi/shared/symbols";
import { readEffectiveCodexConversionConfig } from "../adapter/activation/config-store.ts";

export const readCodexCompactionConfig: CodexCompactionConfigReader = ({ cwd, projectTrusted }) => {
  const config = readEffectiveCodexConversionConfig({ cwd, projectTrusted });
  return {
    responsesCompaction: config.compaction.responsesCompaction,
    additionalProviders: [...config.scope.additionalProviders],
  };
};

/** Publishes the reader unless another registration holds the slot; returns its withdrawal. */
export function publishCodexCompactionConfigReaderIfVacant(): (() => void) | undefined {
  if (readGlobalSlot(CODEX_COMPACTION_CONFIG_READER_KEY) !== undefined) return undefined;
  return publishCodexCompactionConfigReader(readCodexCompactionConfig);
}
