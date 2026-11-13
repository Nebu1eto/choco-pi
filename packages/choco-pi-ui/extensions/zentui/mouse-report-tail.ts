/**
 * Keeps the tail of a split mouse report out of the prompt editor's text.
 *
 * pi-tui's stdin buffer holds an incomplete escape sequence for a fixed time,
 * 10 ms after a bare ESC and 50 ms otherwise, and then hands it on as it is.
 * When the event loop stays busy for longer, as it can while the mouse wheel
 * scrolls the transcript, the time runs out before the rest of a mouse report
 * has been read. The rest then arrives one character at a time as if typed:
 * `1;47M` after `ESC [<64;19`, or `[<64;191;47M` after a bare ESC.
 *
 * A fragment that already reads `ESC [<` can only be a mouse report, so it and
 * the characters that continue it are dropped. A bare `ESC` or `ESC [` is also
 * a key, so the `[` and `<` after it are held back until a digit shows a mouse
 * report; when a character breaks the pattern, or the burst of input that
 * brought them ends first, they are handed on as typed. A report stays open
 * only until the end of the burst that continued it.
 */

const ESC = "\x1b";
/** What may follow ESC in a report not yet finished: `[`, `[<`, `[<64;19`, … */
const PARTIAL_TAIL = /^(?:\[(?:<(?:\d+(?:;(?:\d+(?:;\d*)?)?)?)?)?)?$/;
/** What follows ESC in a whole SGR mouse report. */
const COMPLETE_TAIL = /^\[<\d+;\d+;\d+[Mm]$/;
/** What follows ESC once the text can only be a mouse report. */
const CONFIRMED_TAIL = /^\[<\d/;

function partial(report: string): boolean {
  return report.startsWith(ESC) && PARTIAL_TAIL.test(report.slice(1));
}

function complete(report: string): boolean {
  return report.startsWith(ESC) && COMPLETE_TAIL.test(report.slice(1));
}

export class MouseReportTailFilter {
  /** The report read so far, from its ESC; undefined while none is open. */
  private report: string | undefined;
  /** Characters after a bare ESC or ESC [ that may still be typed input. */
  private held = "";
  /** Whether the end of the current burst is already being waited for. */
  private burstEndPending = false;

  /** `release` hands held characters on as typed input, outside this filter. */
  constructor(private readonly release: (text: string) => void) {}

  /** The part of `data` that is input; "" when all of it was a mouse report's tail. */
  filter(data: string): string {
    if (data.startsWith(ESC)) {
      this.releaseHeld();
      this.report = partial(data) ? data : undefined;
      // ESC and ESC [ are keys; a longer fragment can only be a mouse report.
      return data.startsWith(`${ESC}[<`) ? "" : data;
    }
    const report = this.report;
    if (report === undefined) return data;
    let read = report;
    let index = 0;
    for (const char of data) {
      const next = read + char;
      if (!partial(next) && !complete(next)) break;
      read = next;
      index += char.length;
      if (complete(read)) break;
    }
    if (index === 0) {
      this.releaseHeld();
      this.report = undefined;
      return data;
    }
    const taken = data.slice(0, index);
    if (complete(read)) {
      this.report = undefined;
      this.held = "";
      return data.slice(index);
    }
    if (index < data.length) {
      const held = CONFIRMED_TAIL.test(read.slice(1)) ? "" : this.held + taken;
      this.report = undefined;
      this.held = "";
      return held + data.slice(index);
    }
    this.report = read;
    this.held = CONFIRMED_TAIL.test(read.slice(1)) ? "" : this.held + taken;
    this.closeAtBurstEnd();
    return "";
  }

  /** Close the open report once the input of this burst has all been handled. */
  private closeAtBurstEnd(): void {
    if (this.burstEndPending) return;
    this.burstEndPending = true;
    queueMicrotask(() => {
      this.burstEndPending = false;
      this.report = undefined;
      this.releaseHeld();
    });
  }

  private releaseHeld(): void {
    const held = this.held;
    this.held = "";
    if (held) this.release(held);
  }
}
