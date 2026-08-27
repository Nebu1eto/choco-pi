import type { ExtensionAPI, MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { render } from "grok-mermaid";

const MERMAID_FENCE = /```mermaid[^\n]*\n([\s\S]*?)```/gi;

function hardBreakDiagram(lines: string[]): string {
  return `${lines.map((line) => `\`${line.replaceAll("`", "\\`")}\``).join("  \n")}\n`;
}

export function renderNarrowMermaid(markdown: string, context: MarkdownTransformContext): string {
  if (context.messageType !== "assistant") return markdown;
  return markdown.replace(MERMAID_FENCE, (fence, source: string) => {
    const original = render(source);
    if (original && original.width <= context.availableWidth)
      return hardBreakDiagram(original.plain);
    const verticalSource = source.replace(
      /^(\s*(?:flowchart|graph)\s+)(?:LR|RL)(\s*)$/im,
      "$1TD$2",
    );
    if (verticalSource === source) return fence;
    const vertical = render(verticalSource);
    return vertical && vertical.width <= context.availableWidth
      ? hardBreakDiagram(vertical.plain)
      : fence;
  });
}

export default function mermaidFallback(pi: ExtensionAPI): void {
  pi.registerMarkdownTransformer(renderNarrowMermaid);
}
