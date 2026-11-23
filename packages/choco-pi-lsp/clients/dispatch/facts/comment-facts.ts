import type { FactProvider } from "../fact-provider-types.ts";
import { extractFactsFromTree, walk } from "./tree-sitter-facts.ts";

export interface CommentSummary {
  line: number;
  text: string;
}

export const commentFactProvider: FactProvider = {
  id: "fact.file.comments",
  provides: ["file.comments"],
  requires: ["file.content"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath);
  },
  async run(ctx, store) {
    await extractFactsFromTree(ctx, store, { "file.comments": [] }, (root) => {
      const comments: CommentSummary[] = [];
      walk(root, (node) => {
        if (node.type === "comment") {
          comments.push({ line: node.startPosition.row + 1, text: node.text });
        }
      });
      return { "file.comments": comments };
    });
  },
};
