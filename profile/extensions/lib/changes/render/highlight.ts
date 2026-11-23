import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { HighlightFn, HighlightLimits } from "../types.ts";

export const DEFAULT_HIGHLIGHT = { enabled: true, maxFileBytes: 512_000, maxDiffLines: 20_000 };

export type HighlightFactoryOptions = {
  config: HighlightLimits;
  filePath: string;
  fileBytes?: number;
  diffLines?: number;
};

function plainLines(code: string): string[] {
  return code.split("\n");
}

export function createHighlight(options: HighlightFactoryOptions): HighlightFn {
  const { config, filePath } = options;
  const disabledForDiff =
    !config.enabled ||
    (options.fileBytes !== undefined && options.fileBytes > config.maxFileBytes) ||
    (options.diffLines !== undefined && options.diffLines > config.maxDiffLines);

  return (code, requestedLanguage) => {
    const sourceLines = plainLines(code);
    if (disabledForDiff || Buffer.byteLength(code, "utf8") > config.maxFileBytes) {
      return sourceLines;
    }

    try {
      const language = requestedLanguage ?? getLanguageFromPath(filePath);
      const highlighted = highlightCode(code, language);
      return highlighted.length === sourceLines.length ? highlighted : sourceLines;
    } catch {
      return sourceLines;
    }
  };
}

export function createDiffHighlighter(
  config: { highlight: HighlightLimits },
  filePath: string,
  fileBytes?: number,
  diffLines?: number,
): HighlightFn {
  return createHighlight({ config: config.highlight, filePath, fileBytes, diffLines });
}
