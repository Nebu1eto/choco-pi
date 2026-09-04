import { type BoundaryValue, isBoundaryArray, isString } from "../../boundary.ts";
import { stringField } from "../../pi-rpc/protocol.ts";

/** Concatenate the text of every `text` block in a replayed content array. */
function textBlocks(content: BoundaryValue): string {
  if (!isBoundaryArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (stringField(block, "type") !== "text") continue;
    const blockText = stringField(block, "text");
    if (blockText) text += blockText;
  }
  return text;
}

export function normalizePiMessageText(content: BoundaryValue): string {
  if (isString(content)) return content;
  return textBlocks(content);
}

export function normalizePiAssistantText(content: BoundaryValue): string {
  // Assistant content is typically an array of blocks; only replay text blocks for MVP.
  return textBlocks(content);
}
