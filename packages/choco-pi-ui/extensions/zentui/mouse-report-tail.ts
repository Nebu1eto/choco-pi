const ESC = "\x1b";
const PARTIAL_TAIL = /^(?:\[(?:<(?:\d+(?:;(?:\d+(?:;\d*)?)?)?)?)?)?$/;
const COMPLETE_TAIL = /^\[<\d+;\d+;\d+[Mm]$/;
const CONFIRMED_TAIL = /^\[<\d/;

function partial(report: string): boolean {
  return report.startsWith(ESC) && PARTIAL_TAIL.test(report.slice(1));
}

function complete(report: string): boolean {
  return report.startsWith(ESC) && COMPLETE_TAIL.test(report.slice(1));
}

export class MouseReportTailFilter {
  private report: string | undefined;
  private held = "";
  private burstEndPending = false;

  constructor(private readonly release: (text: string) => void) {}

  filter(data: string): string {
    if (data.startsWith(ESC)) {
      this.releaseHeld();
      this.report = partial(data) ? data : undefined;
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
