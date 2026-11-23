import type { TUI } from "@earendil-works/pi-tui";
import { isFunction } from "./runtime-values.ts";

export const ESC = "\u001b";
export const MOUSE_WINDOW_MS = 300;
export const HOLD_MS = 50;

const PARTIAL_TAIL = /^\[(?:<(?:\d+(?:;(?:\d+(?:;\d*)?)?)?)?)?$/;
const COMPLETE_TAIL = /^\[<\d+;\d+;\d+[Mm]/;
const CONFIRMED_TAIL = /^\[<\d/;
const REPORT_ANYWHERE = /\[<\d+;\d+;\d+[Mm]/;

export function containsMouseReport(text: string): boolean {
  return REPORT_ANYWHERE.test(text);
}

export function isMouseReport(data: string): boolean {
  if (!data.startsWith(ESC)) return false;
  const match = COMPLETE_TAIL.exec(data.slice(1));
  return match !== null && match[0].length === data.length - 1;
}

export type InputDecision = { consume: true } | { data: string } | undefined;

export type Cancel = () => void;

export interface GuardHost {
  now(): number;
  replay(data: string): void;
  after(ms: number, run: () => void): Cancel;
  afterPendingInput(run: () => void): Cancel;
}

interface Hold {
  tail: string;
  cancel: Cancel;
}

export class MouseEscapeGuard {
  private readonly host: GuardHost;
  private lastMouseAt = Number.NEGATIVE_INFINITY;
  private hold: Hold | undefined;
  private replaying: string | undefined;
  private disposed = false;

  constructor(host: GuardHost) {
    this.host = host;
  }

  observeRaw(chunk: string): void {
    if (!this.disposed && containsMouseReport(chunk)) this.noteMouse();
  }

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
    this.endHold();
    this.settle(hold.tail);
    return this.handleFree(data);
  }

  isHolding(): boolean {
    return this.hold !== undefined;
  }

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

export interface InputReplayTarget {
  handleTerminalInput(data: string): void;
}

export function isInputReplayTarget(tui: TUI): tui is TUI & InputReplayTarget {
  return "handleTerminalInput" in tui && isFunction(tui.handleTerminalInput);
}

export function rawInputText(chunk: string | Buffer): string {
  return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
}
