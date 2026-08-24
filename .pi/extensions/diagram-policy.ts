/**
 * diagram-policy.ts — Keep drawn structure in mermaid, not in art characters.
 *
 * SYSTEM.md requires diagrams to be fenced mermaid blocks. A system-prompt
 * line is a one-shot instruction with no feedback, and it is easy to sidestep:
 * a model that does not think of its arrow sketch as "a diagram" draws it
 * anyway, usually inside an unlabeled fence.
 *
 * This extension closes the loop. It watches finished assistant messages for
 * structure drawn with box, line, or arrow characters and, when it finds any,
 * appends a <system-reminder> to the next request context — the same tagged
 * channel the code-mode batching nudge uses. Nothing is rewritten and nothing
 * reaches the transcript, so a false positive costs one hidden line.
 *
 * Fences carrying real command output or code are exempt by language, because
 * a pasted dependency tree or table border is not the model drawing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isString } from "./lib/runtime-values.ts";

/** Box drawing, block, and solid arrowhead characters models use to draw. */
const ART_CHARACTERS = /[\u2500-\u257f\u2190-\u21ff\u25b2\u25bc\u25c4\u25ba]/g;
/** Classic ASCII art: +---+ corners and --> / <-- arrow runs. */
const ASCII_ART_RUN = /\+-{2,}\+|-{2,}>|<-{2,}/g;
/** Art characters on one line before it counts as drawing rather than prose. */
const ART_DENSITY = 6;
/** Languages whose fences carry real output or code, never the model drawing. */
const EXEMPT_FENCE_LANGUAGES = new Set([
  "mermaid",
  "sh",
  "bash",
  "zsh",
  "shell",
  "console",
  "diff",
  "patch",
  "log",
  "json",
  "yaml",
  "yml",
  "toml",
  "sql",
  "ts",
  "tsx",
  "js",
  "jsx",
  "python",
  "py",
  "go",
  "rust",
  "java",
  "kotlin",
  "swift",
  "c",
  "cpp",
  "csharp",
  "html",
  "css",
]);

const FENCE = "```";

export const DIAGRAM_REMINDER =
  "<system-reminder>\n" +
  "The previous answer drew structure with box, line, or arrow characters. " +
  "Structure drawn that way is a diagram: render it as a fenced mermaid block " +
  "(flowchart/graph, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram), " +
  "or state it in prose. Do not emit ASCII or Unicode art for the rest of this session.\n" +
  "</system-reminder>";

function countMatches(line: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  const matches = line.match(pattern);
  return matches ? matches.length : 0;
}

/** True when one line is drawn structure rather than prose that mentions an arrow. */
function isDrawnLine(line: string): boolean {
  if (countMatches(line, ART_CHARACTERS) >= ART_DENSITY) return true;
  return countMatches(line, ASCII_ART_RUN) >= 2;
}

/**
 * True when the text draws structure outside an exempt fence. Prose with a
 * single arrow, markdown tables, mermaid blocks, and pasted command output all
 * stay clear.
 */
export function containsDrawnDiagram(text: string): boolean {
  let fenceLanguage: string | undefined;
  let inFence = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(FENCE)) {
      if (inFence) {
        inFence = false;
        fenceLanguage = undefined;
      } else {
        inFence = true;
        fenceLanguage = trimmed.slice(FENCE.length).trim().toLowerCase();
      }
      continue;
    }
    if (inFence && fenceLanguage && EXEMPT_FENCE_LANGUAGES.has(fenceLanguage)) continue;
    if (isDrawnLine(line)) return true;
  }
  return false;
}

interface AssistantContentItem {
  type?: string;
  text?: string;
}

interface FinishedMessage {
  role?: string;
  content?: string | AssistantContentItem[];
}

function assistantText(message: FinishedMessage): string {
  if (message.role !== "assistant") return "";
  const content = message.content;
  if (isString(content)) return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item.type === "text" && isString(item.text))
    .map((item) => item.text)
    .join("\n");
}

export default function diagramPolicy(pi: ExtensionAPI): void {
  let reminderPending = false;

  pi.on("message_end", (event) => {
    const message: FinishedMessage = event.message;
    if (!containsDrawnDiagram(assistantText(message))) return;
    reminderPending = true;
  });

  pi.on("context", (event) => {
    if (!reminderPending) return;
    reminderPending = false;
    return {
      messages: [
        ...event.messages,
        { role: "user", content: DIAGRAM_REMINDER, timestamp: Date.now() },
      ],
    };
  });
}
