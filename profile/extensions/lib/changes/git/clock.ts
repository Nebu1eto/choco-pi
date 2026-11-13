import { isNumber, type RuntimeValue } from "../../runtime-values.ts";

/**
 * Time seam for the diff store. Tests inject a fake clock so debounce,
 * polling, backoff, and per-call git timeouts run without real waiting.
 *
 * Timer handles are opaque: a clock only accepts handles it returned itself.
 */
export type DiffClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): RuntimeValue;
  clearTimeout(handle: RuntimeValue): void;
};

/**
 * Wall-clock implementation. Timers are unreferenced so a pending debounce or
 * poll never keeps a finished Pi process alive.
 */
export function createSystemClock(): DiffClock {
  const timers = new Map<number, NodeJS.Timeout>();
  let nextId = 0;
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      nextId += 1;
      const id = nextId;
      const timer = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timer.unref();
      timers.set(id, timer);
      return id;
    },
    clearTimeout(handle) {
      if (!isNumber(handle)) return;
      const timer = timers.get(handle);
      if (timer === undefined) return;
      clearTimeout(timer);
      timers.delete(handle);
    },
  };
}
