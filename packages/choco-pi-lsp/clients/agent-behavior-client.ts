import { normalizeMapKey } from "./path-utils.ts";

export type BehaviorWarning = {
  type: "blind-write" | "thrashing";
  message: string;
  severity: "warning" | "error";
  details: {
    filePath?: string;
    callCount?: number;
    toolName?: string;
    windowSize?: number;
  };
};

interface ToolCallRecord {
  toolName: string;
  filePath?: string;
  timestamp: number;
}

const WRITE_OPS = new Set(["edit", "write", "multiedit"]);
const READ_OPS = new Set(["read", "bash", "grep", "glob", "find", "rg"]);

const BLIND_WRITE_WINDOW = 5;
const THRASH_THRESHOLD = 3;
const THRASH_TIMEOUT_MS = 30_000;

export class AgentBehaviorClient {
  private toolHistory: ToolCallRecord[] = [];
  private consecutiveCount = 0;
  private lastToolName: string | null = null;
  private lastToolFilePath: string | null = null;
  private lastToolTimestamp = 0;

  private fileEditCount = new Map<string, { count: number; lastUsedAt: number }>();
  private static readonly FILE_EDIT_IDLE_MS = 30 * 60_000;

  recordToolCall(toolName: string, filePath?: string): BehaviorWarning[] {
    const warnings: BehaviorWarning[] = [];
    const now = Date.now();

    const normalizedPath = filePath ? normalizeMapKey(filePath) : null;
    if (
      toolName === this.lastToolName &&
      normalizedPath === this.lastToolFilePath &&
      now - this.lastToolTimestamp < THRASH_TIMEOUT_MS
    ) {
      this.consecutiveCount++;
    } else {
      this.consecutiveCount = 1;
    }
    this.lastToolName = toolName;
    this.lastToolFilePath = normalizedPath;
    this.lastToolTimestamp = now;

    if (this.consecutiveCount === THRASH_THRESHOLD) {
      const fileLabel = filePath ? ` on \`${filePath}\`` : "";
      warnings.push({
        type: "thrashing",
        message: `🔴 THRASHING — ${THRASH_THRESHOLD} consecutive \`${toolName}\`${fileLabel} calls with no progress. Consider fixing the root cause instead of re-running.`,
        severity: "error",
        details: {
          toolName,
          filePath,
          callCount: this.consecutiveCount,
        },
      });
    }

    if (WRITE_OPS.has(toolName)) {
      const recentWindow = this.toolHistory.slice(-BLIND_WRITE_WINDOW);
      const hasRecentRead = recentWindow.some(
        (r) =>
          READ_OPS.has(r.toolName) ||
          (WRITE_OPS.has(r.toolName) &&
            r.filePath !== undefined &&
            normalizedPath !== null &&
            normalizeMapKey(r.filePath) === normalizedPath),
      );

      if (!hasRecentRead && recentWindow.length > 0) {
        const writesWithoutRead = recentWindow.filter((r) => WRITE_OPS.has(r.toolName)).length;

        if (writesWithoutRead >= 2) {
          warnings.push({
            type: "blind-write",
            message: `⚠ BLIND WRITE — editing \`${filePath ?? "file"}\` without reading in the last ${BLIND_WRITE_WINDOW} tool calls. Read the file first to avoid assumptions.`,
            severity: "warning",
            details: {
              filePath,
              windowSize: recentWindow.length,
            },
          });
        }
      }

      if (filePath) {
        const key = normalizeMapKey(filePath);
        this.fileEditCount.set(key, {
          count: (this.fileEditCount.get(key)?.count ?? 0) + 1,
          lastUsedAt: now,
        });
        for (const [pathKey, entry] of this.fileEditCount) {
          if (now - entry.lastUsedAt > AgentBehaviorClient.FILE_EDIT_IDLE_MS) {
            this.fileEditCount.delete(pathKey);
          }
        }
      }
    }

    this.toolHistory.push({ toolName, filePath, timestamp: now });
    if (this.toolHistory.length > 50) {
      this.toolHistory = this.toolHistory.slice(-50);
    }

    return warnings;
  }

  formatWarnings(warnings: BehaviorWarning[]): string {
    if (warnings.length === 0) return "";

    return warnings.map((w) => w.message).join("\n");
  }

  getEditCount(filePath: string): number {
    return this.fileEditCount.get(normalizeMapKey(filePath))?.count ?? 0;
  }

  reset(): void {
    this.toolHistory = [];
    this.consecutiveCount = 0;
    this.lastToolName = null;
    this.lastToolTimestamp = 0;
    this.fileEditCount.clear();
  }
}
