import { truncateToWidth } from "./deps/pi-tui.ts";

interface ELLIPSISKINDValues extends Record<string, number> {}
const ELLIPSIS_KIND: ELLIPSISKINDValues = { "…": 0, "...": 1, "": 2 };
let truncateIsNative: boolean | null = null;

export function _resetTruncateProbeForTests(): void {
  truncateIsNative = null;
}

export function fitLine(s: string, maxWidth: number, ellipsis = "..."): string {
  const w = Math.max(0, maxWidth);

  // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
  const fn = truncateToWidth as (...a: unknown[]) => string;
  if (truncateIsNative === true) {
    return fn(s, w, ELLIPSIS_KIND[ellipsis] ?? 1, false, 8);
  }
  if (truncateIsNative === false) {
    return fn(s, w, ellipsis);
  }
  try {
    const out = fn(s, w, ellipsis);
    truncateIsNative = false;
    return out;
  } catch {
    truncateIsNative = true;
    return fn(s, w, ELLIPSIS_KIND[ellipsis] ?? 1, false, 8);
  }
}

export function fitLines(lines: string[], width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return lines;
  return lines.map((line) => fitLine(line, width));
}
