import type { ProgramStatus } from "@earendil-works/pi-tui";

/**
 * Pi reports `done` (OSC 7501) every time the root run settles. With
 * background subagents that happens when the main agent ends its turn while
 * they still run and again after each wake turn a completion triggers, and a
 * terminal such as Rex may notify on every one. Background work is still
 * work, so while it is pending the root record stays `working` and the held
 * `done` is reported once everything has settled.
 *
 * Pi has no extension API for program status, so this wraps the terminal
 * instance's `setProgramStatus`, the single path Pi's reporter writes through.
 */

/** How often a held `done` is rechecked; the release condition is never time alone. */
export const RELEASE_CHECK_MS = 250;
/** A requested wake turn that never starts stops blocking the release after this long. */
export const WAKE_GRACE_MS = 5_000;

export type ProgramStatusWriter = (status: ProgramStatus) => void;

export interface ProgramStatusHoldOptions {
  /** Running or queued agents, held completion notifications, or pending workflow nudges. */
  isBackgroundBusy(): boolean;
  /** The root session has no active run or compaction and nothing queued. */
  isRootIdle(): boolean;
  now?: () => number;
}

export class ProgramStatusHold {
  readonly #options: ProgramStatusHoldOptions;
  #write: ProgramStatusWriter | undefined;
  /** Last report written to the terminal. */
  #written: ProgramStatus | undefined;
  /** `done` withheld while background work runs. */
  #held: ProgramStatus | undefined;
  #wakeExpectedAt: number | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(options: ProgramStatusHoldOptions) {
    this.#options = options;
  }

  /** Bind the writer that reaches the terminal (the unwrapped predecessor). */
  attach(write: ProgramStatusWriter): void {
    this.#write = write;
  }

  /** Filter one report from Pi. */
  report(status: ProgramStatus): void {
    const write = this.#write;
    if (!write) return;
    if (!this.#disposed && status.state === "done" && this.#options.isBackgroundBusy()) {
      this.#held = status;
      // Withholding keeps an identical `working` record untouched; anything else becomes working.
      if (this.#written?.state !== "working") this.#emit(write, { ...status, state: "working" });
      this.#startTimer();
      return;
    }
    this.#clearHold();
    this.#emit(write, status);
  }

  /** A delivery asked Pi to start a wake turn; its own reports will supersede the hold. */
  expectWake(): void {
    this.#wakeExpectedAt = this.#now();
  }

  /** The root run started, so any expected wake has arrived. */
  rootRunStarted(): void {
    this.#wakeExpectedAt = undefined;
  }

  /** Release the held `done` when no background work, wake, or root run remains. */
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

  /**
   * Stop filtering. A held `done` is written only if nothing is pending; with
   * work still running the record stays `working` rather than notifying early.
   */
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
