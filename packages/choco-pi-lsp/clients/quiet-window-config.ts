import { toPositiveFinite } from "./env-utils.ts";

let _enabledCache: boolean | undefined;

export function isQuietWindowEnabled(): boolean {
  if (_enabledCache !== undefined) return _enabledCache;
  _enabledCache = process.env.CHOCO_PI_LSP_QUIET_WINDOW !== "0";
  return _enabledCache;
}

export function _resetQuietWindowEnabledForTests(): void {
  _enabledCache = undefined;
}

const DEFAULT_QUIET_WINDOW_WAIT_MS = 15_000;

export function quietWindowWaitMs(): number {
  const raw = toPositiveFinite(process.env.CHOCO_PI_LSP_QUIET_WINDOW_WAIT_MS);
  return raw > 0 ? raw : DEFAULT_QUIET_WINDOW_WAIT_MS;
}
