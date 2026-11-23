import { type LspBoundaryValue } from "./runtime-guards.ts";

export interface SingleFlightOptions {
  generation?: () => number;
  coalesceTrailing?: boolean;
}

export interface SingleFlight<T> {
  run(key: string, fn: () => Promise<T>): Promise<T>;
  has(key: string): boolean;
  size(): number;
  clear(): void;
}

interface Flight<T> {
  promise: Promise<T>;
  generation: number;
  rerunRequested: boolean;
}

export function createSingleFlight<T>(options: SingleFlightOptions = {}): SingleFlight<T> {
  const { generation: readGeneration, coalesceTrailing = false } = options;
  const flights = new Map<string, Flight<T>>();

  const currentGeneration = (): number => readGeneration?.() ?? 0;

  const release = (key: string, flight: Flight<T>): void => {
    if (flights.get(key) !== flight) return;
    flights.delete(key);
  };

  const run = (key: string, fn: () => Promise<T>): Promise<T> => {
    const existing = flights.get(key);
    if (existing && existing.generation === currentGeneration()) {
      if (coalesceTrailing) existing.rerunRequested = true;
      return existing.promise;
    }

    let settle!: (value: T) => void;

    let fail!: (error: LspBoundaryValue) => void;
    const promise = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const flight: Flight<T> = {
      promise,
      generation: currentGeneration(),
      rerunRequested: false,
    };

    const chain = async (): Promise<T> => {
      let result = await fn();
      while (flight.rerunRequested) {
        flight.rerunRequested = false;
        result = await fn();
      }
      return result;
    };

    flights.set(key, flight);
    chain().then(
      (value) => {
        release(key, flight);
        settle(value);
      },
      (error) => {
        release(key, flight);
        fail(error);
      },
    );
    return flight.promise;
  };

  return {
    run,
    has: (key) => flights.has(key),
    size: () => flights.size,
    clear: () => flights.clear(),
  };
}
