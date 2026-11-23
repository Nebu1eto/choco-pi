import type { QuotaSource, QuotasResponse } from "../types/quotas";

export interface QuotaSnapshot {
  quotas: QuotasResponse;
  source: QuotaSource;
  updatedAt: number;
}

type Listener = (snapshot: QuotaSnapshot) => void;

export class QuotaStore {
  private snapshot: QuotaSnapshot | undefined;
  private listeners = new Set<Listener>();
  private lastHeaderIngestAt = 0;
  private inFlightRefresh: Promise<QuotaSnapshot | undefined> | undefined;
  private inFlightId = 0;

  headerThrottleMs = 5_000;

  getSnapshot(): QuotaSnapshot | undefined {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(snapshot: QuotaSnapshot): void {
    for (const l of this.listeners) l(snapshot);
  }

  ingest(quotas: QuotasResponse, source: QuotaSource): boolean {
    const now = Date.now();

    if (source === "header") {
      if (now - this.lastHeaderIngestAt < this.headerThrottleMs) return false;
      this.lastHeaderIngestAt = now;
    }

    this.snapshot = { quotas, source, updatedAt: now };
    this.emit(this.snapshot);
    return true;
  }

  async refreshFromApi(
    fetcher: () => Promise<QuotasResponse | undefined>,
  ): Promise<QuotaSnapshot | undefined> {
    if (this.inFlightRefresh) return this.inFlightRefresh;

    this.inFlightId++;
    const id = this.inFlightId;

    this.inFlightRefresh = (async () => {
      try {
        const quotas = await fetcher();
        if (quotas && id === this.inFlightId) {
          this.ingest(quotas, "api");
        }
        return this.snapshot;
      } finally {
        if (id === this.inFlightId) {
          this.inFlightRefresh = undefined;
        }
      }
    })();

    return this.inFlightRefresh;
  }

  get isRefreshing(): boolean {
    return !!this.inFlightRefresh;
  }

  clear(): void {
    this.inFlightId++;
    this.snapshot = undefined;
    this.lastHeaderIngestAt = 0;
    this.inFlightRefresh = undefined;
  }
}
