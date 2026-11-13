import type { TUI } from "@earendil-works/pi-tui";
import { isFunction } from "./runtime-values.ts";

/**
 * Keeps a mouse report split by a busy event loop from reaching Pi as an Escape key.
 *
 * pi-tui's stdin buffer hands a bare ESC on as the Escape key once its escape
 * timeout (10 ms by default) runs out. While the transcript scrolls, the event
 * loop can stay busy for longer than that between two reads, so a wheel report
 * `ESC [<65;12;30M` can be read as a bare ESC first and `[<65;12;30M` later.
 * The ESC then aborts the running turn (or leaves the /diff pane), and the
 * rest of the report arrives one character at a time as typed text.
 *
 * A bare ESC shortly after mouse input is therefore held back. When what
 * follows continues a mouse report (`[<` and a digit), the ESC and the whole
 * report are dropped; otherwise the ESC is handed on, on its own and before
 * the input that showed it was a key, or once no input has followed for a
 * short time. A bare ESC without recent mouse input is never held.
 */

export const ESC = "\u001b";
/** How long after mouse input a bare ESC may still start a split report. */
export const MOUSE_WINDOW_MS = 300;
/** How long a held ESC waits for the rest of a report before it counts as a key. */
export const HOLD_MS = 50;

/** What may follow ESC in a report not yet finished: `[`, `[<`, `[<64;19`, ... */
const PARTIAL_TAIL = /^\[(?:<(?:\d+(?:;(?:\d+(?:;\d*)?)?)?)?)?$/;
/** A whole report after its ESC, at the start of the text. */
const COMPLETE_TAIL = /^\[<\d+;\d+;\d+[Mm]/;
/** Text after ESC that can only be a mouse report. */
const CONFIRMED_TAIL = /^\[<\d/;
/** A whole report, with or without its ESC, anywhere in raw input. */
const REPORT_ANYWHERE = /\[<\d+;\d+;\d+[Mm]/;

/** Whether raw terminal input carries an SGR mouse report or the tail of one. */
export function containsMouseReport(text: string): boolean {
  return REPORT_ANYWHERE.test(text);
}

/** Whether `data` is exactly one whole SGR mouse report. */
export function isMouseReport(data: string): boolean {
  if (!data.startsWith(ESC)) return false;
  const match = COMPLETE_TAIL.exec(data.slice(1));
  return match !== null && match[0].length === data.length - 1;
}

/** The result a Pi terminal input listener returns. */
export type InputDecision = { consume: true } | { data: string } | undefined;

/** Cancels a scheduled callback; calling it again does nothing. */
export type Cancel = () => void;

export interface GuardHost {
  now(): number;
  /** Hand `data` to Pi's input path again; the guard lets it through once. */
  replay(data: string): void;
  /** Run `run` after `ms` milliseconds. */
  after(ms: number, run: () => void): Cancel;
  /** Run `run` after the input already waiting to be read has been read. */
  afterPendingInput(run: () => void): Cancel;
}

interface Hold {
  /** The text after the ESC read so far: "" or a prefix of a report's tail. */
  tail: string;
  cancel: Cancel;
}

export class MouseEscapeGuard {
  private readonly host: GuardHost;
  private lastMouseAt = Number.NEGATIVE_INFINITY;
  private hold: Hold | undefined;
  /** Input being replayed by this guard, which passes it once. */
  private replaying: string | undefined;
  private disposed = false;

  constructor(host: GuardHost) {
    this.host = host;
  }

  /** Raw terminal input, as read and before Pi parses it. Only recency is recorded. */
  observeRaw(chunk: string): void {
    if (!this.disposed && containsMouseReport(chunk)) this.noteMouse();
  }

  /** Pi's terminal input listener. */
  handleInput(data: string): InputDecision {
    if (this.disposed) return undefined;
    if (this.replaying !== undefined && data === this.replaying) {
      this.replaying = undefined;
      return undefined;
    }
    const hold = this.hold;
    if (hold === undefined) return this.handleFree(data);
    const candidate = hold.tail + data;
    const complete = COMPLETE_TAIL.exec(candidate);
    if (complete !== null) {
      this.endHold();
      this.noteMouse();
      const rest = candidate.slice(complete[0].length);
      return rest.length === 0 ? { consume: true } : { data: rest };
    }
    if (PARTIAL_TAIL.test(candidate)) {
      this.endHold();
      this.startHold(candidate);
      return { consume: true };
    }
    // `data` breaks the report: the held text was typed, or the rest of a
    // report that broke off. Settle it before `data` goes on its way.
    this.endHold();
    this.settle(hold.tail);
    return this.handleFree(data);
  }

  /** Whether an ESC or the start of a report is held back. */
  isHolding(): boolean {
    return this.hold !== undefined;
  }

  /** Stop for good: cancel the timers and drop whatever is held. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endHold();
  }

  private handleFree(data: string): InputDecision {
    if (data === ESC) {
      if (this.host.now() - this.lastMouseAt > MOUSE_WINDOW_MS) return undefined;
      this.startHold("");
      return { consume: true };
    }
    if (data.startsWith(ESC)) {
      const tail = data.slice(1);
      if (isMouseReport(data)) {
        this.noteMouse();
        return undefined;
      }
      // A fragment that already reads `ESC [<digit` can only be a broken report.
      if (CONFIRMED_TAIL.test(tail) && PARTIAL_TAIL.test(tail)) {
        this.noteMouse();
        this.startHold(tail);
        return { consume: true };
      }
    }
    return undefined;
  }

  private startHold(tail: string): void {
    let cancelDeferred: Cancel | undefined;
    const cancelTimer = this.host.after(HOLD_MS, () => {
      // Input that arrived while the loop was busy is read before this runs,
      // so a late tail still finds the hold.
      cancelDeferred = this.host.afterPendingInput(() => {
        if (this.hold !== hold) return;
        this.endHold();
        this.settle(hold.tail);
      });
    });
    const hold: Hold = {
      tail,
      cancel: () => {
        cancelTimer();
        cancelDeferred?.();
      },
    };
    this.hold = hold;
  }

  private endHold(): void {
    const hold = this.hold;
    this.hold = undefined;
    hold?.cancel();
  }

  /** A hold that turned out not to be a whole report: drop a broken report, replay a key. */
  private settle(tail: string): void {
    if (this.disposed) return;
    if (CONFIRMED_TAIL.test(tail)) {
      this.noteMouse();
      return;
    }
    this.replay(ESC);
    for (const char of tail) {
      if (this.disposed) return;
      this.replay(char);
    }
  }

  private replay(data: string): void {
    const previous = this.replaying;
    this.replaying = data;
    try {
      this.host.replay(data);
    } finally {
      this.replaying = previous;
    }
  }

  private noteMouse(): void {
    this.lastMouseAt = this.host.now();
  }
}

/** The private method of pi-tui's TUI that runs input through its listeners and focus. */
export interface InputReplayTarget {
  handleTerminalInput(data: string): void;
}

/**
 * Whether `tui` can take input again. pi-tui keeps `handleTerminalInput`
 * private, so it is confirmed at run time; without it the guard stays off.
 */
export function isInputReplayTarget(tui: TUI): tui is TUI & InputReplayTarget {
  return "handleTerminalInput" in tui && isFunction(tui.handleTerminalInput);
}

/** Raw stdin data as text: a string after `setEncoding`, a Buffer before. */
export function rawInputText(chunk: string | Buffer): string {
  return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
}
