import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type * from "web-tree-sitter";

export type WebTreeSitter = typeof import("web-tree-sitter");

const _require = createRequire(import.meta.url);

export function loadWebTreeSitter(): Promise<WebTreeSitter> {
  try {
    const entry = _require.resolve("web-tree-sitter");
    // SAFETY: The resolved entry is the installed module represented by this local declaration; failed or incompatible imports reject this promise.
    return import(pathToFileURL(entry).href) as Promise<WebTreeSitter>;
  } catch {
    return import("web-tree-sitter");
  }
}
