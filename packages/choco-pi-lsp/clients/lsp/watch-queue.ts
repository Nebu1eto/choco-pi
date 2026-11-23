export interface WatchedFileChange {
  uri: string;
  type: number;
}

export const WATCH_DEBOUNCE_MS = 100;

export class WatchedFilesQueue {
  private readonly pending = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushFn: (changes: WatchedFileChange[]) => void;
  private readonly debounceMs: number;

  constructor(
    flushFn: (changes: WatchedFileChange[]) => void,
    debounceMs: number = WATCH_DEBOUNCE_MS,
  ) {
    this.flushFn = flushFn;
    this.debounceMs = debounceMs;
  }

  enqueue(uri: string, type: number): void {
    this.pending.set(uri, type);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const changes: WatchedFileChange[] = [...this.pending.entries()].map(([uri, type]) => ({
      uri,
      type,
    }));
    this.pending.clear();
    this.flushFn(changes);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
