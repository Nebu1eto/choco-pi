/** Shared lazy formatter catalog seam (#1394). */
import { createLazyImport } from "./lazy-import.ts";

type FormatterModule = typeof import("./formatters.ts");
const lazyFormatters = createLazyImport<FormatterModule>(() => import("./formatters.ts"));

export function warmFormatters(): Promise<FormatterModule> {
  return lazyFormatters.get();
}

export function loadFormatters(): Promise<FormatterModule> {
  return warmFormatters();
}
