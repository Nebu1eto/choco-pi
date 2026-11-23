import type { ProgramStatus } from "@earendil-works/pi-tui";

export const RELEASE_CHECK_MS = 250;
export const WAKE_GRACE_MS = 5_000;

export type ProgramStatusWriter = (status: ProgramStatus) => void;

export interface ProgramStatusHoldOptions {
  isBackgroundBusy(): boolean;
  isRootIdle(): boolean;
  now?: () => number;
}

export class ProgramStatusHold {
  readonly #options: ProgramStatusHoldOptions;
  #write: ProgramStatusWriter | undefined;
  #written: ProgramStatus | undefined;
  #held: ProgramStatus | undefined;
  #wakeExpectedAt: number | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(options: ProgramStatusHoldOptions) {
    this.#options = options;
  }

  attach(write: ProgramStatusWriter): void {
    this.#write = write;
  }

  report(status: ProgramStatus): void {
    const write = this.#write;
    if (!write) return;
    if (!this.#disposed && status.state === "done" && this.#options.isBackgroundBusy()) {
      this.#held = status;
      if (this.#written?.state !== "working") this.#emit(write, { ...status, state: "working" });
      this.#startTimer();
      return;
    }
    this.#clearHold();
    this.#emit(write, status);
  }

  expectWake(): void {
    this.#wakeExpectedAt = this.#now();
  }

  rootRunStarted(): void {
    this.#wakeExpectedAt = undefined;
  }

  check(): void {
    const held = this.#held;
    const write = this.#write;
    if (!held || !write) return;
    const wakeAt = this.#wakeExpectedAt;
    if (wakeAt !== undefined && this.#now() - wakeAt < WAKE_GRACE_MS) return;
    if (this.#options.isBackgroundBusy() || !this.#options.isRootIdle()) return;
    this.#clearHold();
    this.#emit(write, held);
  }

  isHolding(): boolean {
    return this.#held !== undefined;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const held = this.#held;
    const write = this.#write;
    this.#clearHold();
    if (held && write && !this.#options.isBackgroundBusy()) this.#emit(write, held);
    this.#write = undefined;
  }

  #emit(write: ProgramStatusWriter, status: ProgramStatus): void {
    this.#written = status;
    write(status);
  }

  #clearHold(): void {
    this.#held = undefined;
    this.#wakeExpectedAt = undefined;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #startTimer(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.check(), RELEASE_CHECK_MS);
    this.#timer.unref?.();
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
