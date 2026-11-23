import { logExtension } from "./extension-log.ts";
import * as path from "node:path";
import { recordFormatter } from "./widget-state.ts";
import { FileTime } from "./file-time.ts";
import type { FormatterInfo, FormatterResult } from "./formatters.ts";
import { loadFormatters } from "./formatters-lazy.ts";

const DEFAULT_FORMATTER_CONCURRENCY = 1;

export interface FormatOptions {
  skip?: boolean;
  formatters?: string[];
}

export interface FormatSummary {
  filePath: string;
  formatters: Array<{
    name: string;
    success: boolean;
    changed: boolean;
    error?: string;
  }>;
  anyChanged: boolean;
  allSucceeded: boolean;
}

export class FormatService {
  private fileTime: FileTime;
  private enabled: boolean;

  constructor(sessionID: string, enabled: boolean = true) {
    this.fileTime = new FileTime(sessionID);
    this.enabled = enabled;
  }

  async formatFile(filePath: string, options: FormatOptions = {}): Promise<FormatSummary> {
    const absolutePath = path.resolve(filePath);
    const cwd = path.dirname(absolutePath);

    if (options.skip || !this.enabled) {
      return {
        filePath: absolutePath,
        formatters: [],
        anyChanged: false,
        allSucceeded: true,
      };
    }

    if (this.fileTime.hasChanged(absolutePath)) {
      logExtension({
        subsystem: "format",
        level: "warn",
        message: `File ${absolutePath} modified externally, skipping format`,
        metadata: { filePath: absolutePath },
      });
      return {
        filePath: absolutePath,
        formatters: [],
        anyChanged: false,
        allSucceeded: false,
      };
    }

    const formatters = options.formatters
      ? await this.getFormattersByName(options.formatters)
      : await (await loadFormatters()).getFormattersForFile(absolutePath, cwd);

    if (formatters.length === 0) {
      return {
        filePath: absolutePath,
        formatters: [],
        anyChanged: false,
        allSucceeded: true,
      };
    }

    const results = await this.runFormattersWithConcurrency(absolutePath, formatters);

    this.fileTime.read(absolutePath);

    for (const [index, result] of results.entries()) {
      recordFormatter(
        absolutePath,
        formatters[index]?.name ?? "unknown",
        result.changed,
        result.success,
      );
    }

    const anyChanged = results.some((r) => r.changed);
    const allSucceeded = results.every((r) => r.success);

    return {
      filePath: absolutePath,
      formatters: results.map((r, i) => ({
        name: formatters[i].name,
        success: r.success,
        changed: r.changed,
        error: r.error,
      })),
      anyChanged,
      allSucceeded,
    };
  }

  private async runFormattersWithConcurrency(
    filePath: string,
    formatters: FormatterInfo[],
    _concurrency = DEFAULT_FORMATTER_CONCURRENCY,
  ): Promise<FormatterResult[]> {
    const results: FormatterResult[] = [];

    for (const formatter of formatters) {
      let formatTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutMs = 30000;
        const timeoutPromise = new Promise<FormatterResult>((_, reject) => {
          formatTimer = setTimeout(
            () => reject(new Error(`Formatter ${formatter.name} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        });

        const result = await Promise.race([
          loadFormatters().then(({ formatFile }) => formatFile(filePath, formatter)),
          timeoutPromise,
        ]);
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          changed: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (formatTimer) clearTimeout(formatTimer);
      }
    }

    return results;
  }

  private async getFormattersByName(names: string[]): Promise<FormatterInfo[]> {
    const { listAllFormatters, ...formatters } = await loadFormatters();
    const allNames = listAllFormatters();

    return names
      .filter((name) => allNames.includes(name))
      .map((name) => {
        const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        // SAFETY: listAllFormatters supplied this name, and formatter exports follow the
        const key = `${camel}Formatter` as keyof typeof formatters;
        // SAFETY: The validated registry entry is a FormatterInfo export.
        return formatters[key] as FormatterInfo;
      })
      .filter(Boolean);
  }

  assertUnchanged(filePath: string): void {
    this.fileTime.assert(filePath);
  }

  hasChanged(filePath: string): boolean {
    return this.fileTime.hasChanged(filePath);
  }

  recordRead(filePath: string): void {
    this.fileTime.read(filePath);
  }

  clearCache(): void {
    void loadFormatters().then(({ clearFormatterRuntimeState }) => clearFormatterRuntimeState());
  }
}

let globalFormatService: FormatService | null = null;
let currentSessionID: string | null = null;

export function getFormatService(sessionID?: string, enabled: boolean = true): FormatService {
  const shouldCreateNew = !globalFormatService || (sessionID && sessionID !== currentSessionID);

  if (shouldCreateNew) {
    globalFormatService = new FormatService(sessionID ?? "default", enabled);
    currentSessionID = sessionID ?? "default";
  }
  return globalFormatService!;
}

export function resetFormatService(): void {
  void loadFormatters().then(({ clearFormatterRuntimeState }) => clearFormatterRuntimeState());
  globalFormatService = null;
  currentSessionID = null;
}

export function clearFormatServiceAndFileState(): void {
  resetFormatService();
}

export { clearAllSessions } from "./file-time.ts";
