import { execFile } from "node:child_process";

export type FileListLoader = (cwd: string) => Promise<string[]>;

export function loadRgFileList(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // Deliberately use `rg --files` without `--hidden` or ignore overrides: the
    // cache must have the same ignore behavior as the command users already run.
    execFile(
      "rg",
      ["--files", "-0"],
      { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.split("\0").filter((path) => path.length > 0));
      },
    );
  });
}

/**
 * Ignore-aware file cache with a short TTL. Requests within the TTL share one
 * `rg --files` result; after the TTL the first request refreshes it and peers
 * share that in-flight refresh. Session shutdown invalidates it immediately.
 */
export class IgnoreAwareFileCache {
  private readonly cwd: string;
  private readonly ttlMs: number;
  private readonly load: FileListLoader;
  private readonly now: () => number;
  private files: string[] | undefined;
  private loadedAt = 0;
  private pending: Promise<string[]> | undefined;
  private generation = 0;

  constructor(
    cwd: string,
    ttlMs = 5_000,
    load: FileListLoader = loadRgFileList,
    now: () => number = Date.now,
  ) {
    this.cwd = cwd;
    this.ttlMs = ttlMs;
    this.load = load;
    this.now = now;
  }

  invalidate(): void {
    this.generation++;
    this.files = undefined;
    this.loadedAt = 0;
    this.pending = undefined;
  }

  async getFiles(): Promise<readonly string[]> {
    const requestGeneration = this.generation;
    const now = this.now();
    if (this.files && now - this.loadedAt < this.ttlMs) return this.files;

    const pending = this.pending ?? this.startRefresh(requestGeneration);
    const files = await pending;
    if (requestGeneration !== this.generation) return [];
    return files;
  }

  private startRefresh(generation: number): Promise<string[]> {
    const pending = this.load(this.cwd).then(
      (files) => {
        if (generation === this.generation) {
          this.files = files;
          this.loadedAt = this.now();
          this.pending = undefined;
        }
        return files;
      },
      (error: Error) => {
        if (generation === this.generation) this.pending = undefined;
        throw error;
      },
    );
    this.pending = pending;
    return pending;
  }
}
