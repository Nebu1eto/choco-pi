import { performance } from "node:perf_hooks";
import { CHOCO_PI_LSP_EVAL_STARTED_MS } from "./eval-timestamp.ts";

export const CHOCO_PI_LSP_LOADED_FROM: "dist" | "source" = import.meta.url.endsWith(".js")
  ? "dist"
  : "source";

let loadMs: number | undefined;

export function markPiLensLoaded(): number {
  if (loadMs === undefined) {
    loadMs = Math.round(performance.now());
  }
  return loadMs;
}

export function getPiLensLoadMs(): number | undefined {
  return loadMs;
}

export const CHOCO_PI_LSP_HOST_BOOT_MS = Math.round(CHOCO_PI_LSP_EVAL_STARTED_MS);

export function getPiLensEvalMs(): number | undefined {
  return loadMs === undefined ? undefined : Math.max(0, loadMs - CHOCO_PI_LSP_HOST_BOOT_MS);
}
