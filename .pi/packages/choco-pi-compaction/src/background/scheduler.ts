export interface SchedulerClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): () => void;
}

export const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export type WorkSettlement =
  | { readonly ok: true }
  | { readonly ok: false; readonly cause: unknown };

interface Job {
  readonly ownerKey: string;
  readonly cap: number;
  readonly queuedAt: number;
  readonly sequence: number;
  readonly headroom: number;
  bypasses: number;
  readonly signal: AbortSignal;
  readonly run: () => Promise<void>;
  readonly finish: (result: WorkSettlement) => void;
  detach(): void;
}

interface ScheduledWork {
  readonly accepted: boolean;
  /** Always fulfilled: errors are retained for the owner to observe and rethrow. */
  readonly completed: Promise<WorkSettlement>;
}

/** One module-level instance shares quota across owners in this process, not across processes. */
export class PreparationLimiter {
  private readonly queued: Job[] = [];
  private readonly active = new Map<string, Job>();
  private sequence = 0;

  submit(options: {
    ownerKey: string;
    cap: number;
    maxQueued: number;
    headroom: number;
    clock: SchedulerClock;
    signal: AbortSignal;
    run: () => Promise<void>;
  }): ScheduledWork {
    if (
      this.active.has(options.ownerKey) ||
      this.queued.some((job) => job.ownerKey === options.ownerKey)
    ) {
      return { accepted: false, completed: Promise.resolve({ ok: true }) };
    }
    if (options.signal.aborted || this.queued.length >= options.maxQueued) {
      return { accepted: false, completed: Promise.resolve({ ok: true }) };
    }
    let finish: (result: WorkSettlement) => void = () => {};
    const completed = new Promise<WorkSettlement>((resolve) => {
      finish = resolve;
    });
    const job: Job = {
      ownerKey: options.ownerKey,
      cap: options.cap,
      queuedAt: options.clock.now(),
      sequence: this.sequence++,
      headroom: options.headroom,
      bypasses: 0,
      signal: options.signal,
      run: options.run,
      finish,
      detach: () => options.signal.removeEventListener("abort", abort),
    };
    const abort = () => {
      const index = this.queued.indexOf(job);
      if (index < 0) return;
      this.queued.splice(index, 1);
      job.detach();
      job.finish({ ok: true });
      this.pump();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    this.queued.push(job);
    this.pump();
    return { accepted: true, completed };
  }

  private pump(): void {
    // Oldest first. Equal-clock jobs gain bypass credit before urgency breaks ties,
    // so even a frozen/coarse clock cannot let newer parents starve queued children.
    this.queued.sort(
      (a, b) =>
        a.queuedAt - b.queuedAt ||
        b.bypasses - a.bypasses ||
        a.headroom - b.headroom ||
        a.sequence - b.sequence,
    );
    while (this.queued.length > 0) {
      const next = this.queued[0];
      if (!next) return;
      const cap = Math.min(next.cap, ...Array.from(this.active.values(), (job) => job.cap));
      if (this.active.size >= cap) return;
      this.queued.shift();
      for (const waiting of this.queued) waiting.bypasses++;
      next.detach();
      this.active.set(next.ownerKey, next);
      // run's physical lifetime, including an abort-ignoring backend, owns the slot.
      void Promise.resolve()
        .then(next.run)
        .then(
          () => this.release(next),
          (cause: unknown) => this.release(next, { ok: false, cause }),
        );
    }
  }

  private release(job: Job, result: WorkSettlement = { ok: true }): void {
    this.active.delete(job.ownerKey);
    job.finish(result);
    this.pump();
  }
}

export const processPreparationLimiter = new PreparationLimiter();

export function waitUntil(
  clock: SchedulerClock,
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      cancelTimer();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const cancelTimer = clock.setTimer(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}
