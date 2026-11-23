import { isNumber, type RuntimeValue } from "../../runtime-values.ts";

export type DiffClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): RuntimeValue;
  clearTimeout(handle: RuntimeValue): void;
};

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
