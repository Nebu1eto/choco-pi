import { createSubsystemLogger } from "./extension-log.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export interface FileMetrics {
  filePath: string;
  totalLines: number;
  entropyStart: number;
  entropyCurrent: number;
  entropyDelta: number;
}

export interface SessionMetrics {
  filesModified: number;
  avgEntropyDelta: number;
  fileDetails: Map<string, FileMetrics>;
}

export class MetricsClient {
  private log: (msg: string) => void;
  private fileBaselines: Map<string, { content: string; entropy: number }> = new Map();

  constructor(verbose = false) {
    this.log = verbose ? createSubsystemLogger("metrics") : () => {};
  }

  recordBaseline(filePath: string): void {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) return;
    if (this.fileBaselines.has(absolutePath)) return;

    const content = fs.readFileSync(absolutePath, "utf-8");
    const entropy = this.calculateEntropy(content);
    this.fileBaselines.set(absolutePath, { content, entropy });

    this.log(`Baseline recorded: ${path.basename(filePath)} (entropy: ${entropy.toFixed(2)})`);
  }

  getFileMetrics(filePath: string): FileMetrics | null {
    const absolutePath = path.resolve(filePath);
    const baseline = this.fileBaselines.get(absolutePath);
    if (!baseline) return null;

    if (!fs.existsSync(absolutePath)) return null;

    const currentContent = fs.readFileSync(absolutePath, "utf-8");
    const totalLines = currentContent.split("\n").length;

    const entropyCurrent = this.calculateEntropy(currentContent);
    const entropyDelta = entropyCurrent - baseline.entropy;

    return {
      filePath: path.relative(process.cwd(), absolutePath),
      totalLines,
      entropyStart: baseline.entropy,
      entropyCurrent,
      entropyDelta,
    };
  }

  getEntropyDeltas(): Array<{
    file: string;
    start: number;
    current: number;
    delta: number;
  }> {
    const results: Array<{
      file: string;
      start: number;
      current: number;
      delta: number;
    }> = [];

    for (const [filePath, baseline] of this.fileBaselines) {
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, "utf-8");
      const current = this.calculateEntropy(content);
      const delta = current - baseline.entropy;

      results.push({
        file: path.relative(process.cwd(), filePath),
        start: baseline.entropy,
        current,
        delta,
      });
    }

    return results.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }

  calculateEntropy(text: string): number {
    if (text.length === 0) return 0;

    const freq = new Map<string, number>();
    for (const char of text) {
      freq.set(char, (freq.get(char) || 0) + 1);
    }

    let entropy = 0;
    const len = text.length;
    for (const count of freq.values()) {
      const p = count / len;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    return entropy;
  }

  reset(): void {
    this.fileBaselines.clear();
    this.log("Session metrics reset");
  }
}
