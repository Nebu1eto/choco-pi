import { type LspBoundaryValue } from "./runtime-guards.ts";
export interface LazyImport<T> {
  get(): Promise<T>;
  resetForTests(): void;
}

export function createLazyImport<T>(load: () => Promise<T>): LazyImport<T> {
  let cached: Promise<T> | undefined;
  return {
    get(): Promise<T> {
      return (cached ??= Promise.resolve()
        .then(() => load())

        .catch((err: LspBoundaryValue) => {
          cached = undefined;
          throw err;
        }));
    },
    resetForTests(): void {
      cached = undefined;
    },
  };
}
