export function combineAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length <= 1) return live[0];
  const combine = AbortSignal.any;
  if (combine instanceof Function) return combine(live);
  const controller = new AbortController();
  for (const s of live) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

export interface DeadlineOptions {
  ms?: number;
  deadlineAt?: number;
  onTimeout?: "reject" | "undefined";
  onReject?: "propagate" | "undefined";
}

export function withDeadline<T>(
  promise: Promise<T>,
  options: { ms?: number; deadlineAt?: number; onTimeout?: "reject"; onReject?: "propagate" },
): Promise<T>;
export function withDeadline<T>(
  promise: Promise<T>,
  options: DeadlineOptions,
): Promise<T | undefined>;
export function withDeadline<T>(
  promise: Promise<T>,
  options: DeadlineOptions,
): Promise<T | undefined> {
  const onTimeout = options.onTimeout ?? "reject";
  const onReject = options.onReject ?? "propagate";
  const ms = options.ms ?? (options.deadlineAt !== undefined ? options.deadlineAt - Date.now() : 0);

  if (ms <= 0) {
    promise.catch(() => {});
    return onTimeout === "undefined"
      ? Promise.resolve(undefined)
      : Promise.reject(new Error(`Timeout after ${Math.max(0, ms)}ms`));
  }

  const base: Promise<T | undefined> =
    onReject === "undefined" ? promise.catch(() => undefined) : promise;
  if (onReject === "propagate") promise.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T | undefined>((resolve, reject) => {
    timer = setTimeout(() => {
      if (onTimeout === "undefined") resolve(undefined);
      else reject(new Error(`Timeout after ${ms}ms`));
    }, ms);
  });

  return Promise.race([base, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return withDeadline(promise, { ms: timeoutMs });
}

export function withBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | undefined> {
  return withDeadline(promise, { ms: budgetMs, onTimeout: "undefined" });
}
