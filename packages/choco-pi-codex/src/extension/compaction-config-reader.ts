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

export function publishCodexCompactionConfigReaderIfVacant(): (() => void) | undefined {
  if (readGlobalSlot(CODEX_COMPACTION_CONFIG_READER_KEY) !== undefined) return undefined;
  return publishCodexCompactionConfigReader(readCodexCompactionConfig);
}
