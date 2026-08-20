import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { HighlightFn, ResolvedReviewConfig } from "../types.ts";

export type HighlightFactoryOptions = {
  config: ResolvedReviewConfig["highlight"];
  filePath: string;
  /** UTF-8 size of the complete file, when known. */
  fileBytes?: number;
  /** Number of physical lines in the complete diff, when known. */
  diffLines?: number;
};

function plainLines(code: string): string[] {
  return code.split("\n");
}

/**
 * Build a syntax highlighter for one file in one diff.
 *
 * Pi 0.84.1's `highlightCode` currently preserves physical lines, including a
 * final empty line. The length check below keeps the review gutter aligned if
 * that implementation ever changes: the complete block falls back to plain
 * text rather than attempting to guess which highlighted line was dropped.
 */
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

/** Positional convenience wrapper for callers that already hold full config. */
export function createDiffHighlighter(
  config: ResolvedReviewConfig,
  filePath: string,
  fileBytes?: number,
  diffLines?: number,
): HighlightFn {
  return createHighlight({ config: config.highlight, filePath, fileBytes, diffLines });
}
