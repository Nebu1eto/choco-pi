import { isFiniteNumber } from "./runtime-guards.ts";

export function isTestMode(): boolean {
  if (process.env.CHOCO_PI_LSP_TEST_MODE === "1") return true;
  if (process.env.VITEST && process.env.CHOCO_PI_LSP_TEST_MODE !== "0") return true;
  return false;
}

export function toPositiveFinite<T>(value: T): number {
  const num = isFiniteNumber(value) ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

export function lazyEnvNumber(envName: string, fallback: number) {
  let memo: number | undefined;
  return {
    get(): number {
      if (memo !== undefined) return memo;
      const envValue = toPositiveFinite(process.env[envName]);
      memo = envValue > 0 ? envValue : fallback;
      return memo;
    },
    _resetForTests(): void {
      memo = undefined;
    },
  };
}
