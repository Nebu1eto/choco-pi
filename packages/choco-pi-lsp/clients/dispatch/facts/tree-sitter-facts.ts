import {
  childrenOfType,
  firstChildOfType,
  withTreeSitterRoot,
  type TsNode,
  walk,
} from "../../tree-sitter-shared.ts";
import type { FactStore } from "../fact-store.ts";
import type { DispatchContext } from "../types.ts";

export { childrenOfType, firstChildOfType, type TsNode, walk };

export const withFactTree = withTreeSitterRoot;

export async function extractFactsFromTree(
  ctx: DispatchContext,
  store: FactStore,
  defaults: Record<string, unknown[]>,
  extract: (root: TsNode, content: string) => Record<string, unknown[]>,
  coverageFact?: string,
): Promise<void> {
  const writeAll = (facts: Record<string, unknown[]>, complete: boolean): void => {
    for (const key of Object.keys(defaults)) {
      store.setFileFact(ctx.filePath, key, facts[key] ?? defaults[key]);
    }
    if (coverageFact) {
      store.setFileFact(ctx.filePath, coverageFact, complete ? "complete" : "unavailable");
    }
  };
  const content = store.getFileFact<string | null>(ctx.filePath, "file.content");
  if (content == null) return writeAll(defaults, false);
  const parsed = await withFactTree(ctx.filePath, content, (root) => extract(root, content));
  writeAll(parsed.parsed ? parsed.value : defaults, parsed.parsed);
}
