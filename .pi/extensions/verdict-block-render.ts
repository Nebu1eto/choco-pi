/**
 * Transcript display of structured reviewer and verifier blocks.
 *
 * A Markdown transformer runs at display time only, in the interactive terminal:
 * the stored message, what the model receives and any recorded verdict are
 * unchanged. A block the strict parser accepts is replaced by a readable
 * summary; a rejected block is shown as it is, after one line naming the
 * parser's reason; a block still streaming or with an open fence is left alone.
 */
import type {
  ExtensionAPI,
  MarkdownMessageType,
  MarkdownTransformContext,
} from "@earendil-works/pi-coding-agent";
import {
  analyzeVerdictText,
  messageLines,
  noticeMarkdown,
  summaryMarkdown,
} from "./lib/verdict-summary.ts";

/** Assistant replies and default-rendered custom messages; never user input or thinking. */
export const VERDICT_RENDER_MESSAGE_TYPES: readonly MarkdownMessageType[] = ["assistant", "custom"];

/** At or under this many lines the original fence stays below its summary; above it, only a note remains. */
export const RAW_BLOCK_MAX_MESSAGE_LINES = 30;

export function renderVerdictBlocks(markdown: string, context: MarkdownTransformContext): string {
  if (context.isStreaming || !VERDICT_RENDER_MESSAGE_TYPES.includes(context.messageType)) {
    return markdown;
  }
  const analysis = analyzeVerdictText(markdown);
  if (analysis.state === "absent" || analysis.state === "unterminated") return markdown;
  if (analysis.state === "invalid") {
    return analysis.notices.map(noticeMarkdown).join("\n\n") + "\n\n" + markdown;
  }
  const lines = messageLines(markdown);
  const keepRaw = lines.length <= RAW_BLOCK_MAX_MESSAGE_LINES;
  const output: string[] = [];
  let next = 0;
  for (const block of analysis.blocks) {
    output.push(...lines.slice(next, block.startLine));
    const fence = lines.slice(block.startLine, block.endLine + 1);
    const replacement = [summaryMarkdown(block.summary)];
    replacement.push(
      keepRaw
        ? fence.join("\n")
        : "*Raw " +
            block.summary.info +
            " block (" +
            fence.length +
            " lines) hidden here; the stored message keeps it.*",
    );
    output.push("", replacement.join("\n\n"), "");
    next = block.endLine + 1;
  }
  output.push(...lines.slice(next));
  return output.join("\n");
}

export default function verdictBlockRender(pi: ExtensionAPI): void {
  pi.registerMarkdownTransformer(renderVerdictBlocks, {
    messageTypes: VERDICT_RENDER_MESSAGE_TYPES,
  });
}
