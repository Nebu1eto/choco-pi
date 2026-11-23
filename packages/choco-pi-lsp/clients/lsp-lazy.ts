import { createLazyImport } from "./lazy-import.ts";

type LspModule = typeof import("./lsp/index.ts");
const lazyLsp = createLazyImport<LspModule>(() => import("./lsp/index.ts"));

export function warmLspService(): Promise<LspModule> {
  return lazyLsp.get();
}

export function loadLspService(): Promise<LspModule> {
  return warmLspService();
}
