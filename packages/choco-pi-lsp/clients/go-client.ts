import { createSubsystemLogger } from "./extension-log.ts";
import * as path from "node:path";
import {
  type ToolchainAvailability,
  createToolchainAvailability,
} from "./dispatch/runners/utils/toolchain-availability.ts";

export interface GoDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "info";
  message: string;
  rule?: string;
  file: string;
}

const GO_WINDOWS_PATHS = ["C:\\Program Files\\Go\\bin\\go.exe", "C:\\Go\\bin\\go.exe", "go.exe"];

const PROBE_TIMEOUT_MS = 3_000;

const GO_UNIX_PATHS = ["/usr/local/go/bin/go", "/usr/bin/go", "go"];

export class GoClient {
  private readonly availability: ToolchainAvailability;
  private log: (msg: string) => void;

  constructor(verbose = false) {
    this.log = verbose ? createSubsystemLogger("go") : () => {};
    this.availability = createToolchainAvailability({
      tool: "go",
      label: "Go",
      windowsPaths: GO_WINDOWS_PATHS,
      unixPaths: GO_UNIX_PATHS,
      probeArgs: ["version"],
      budgetMs: PROBE_TIMEOUT_MS,
      log: (msg) => this.log(msg),
    });
  }

  async findGoPathAsync(): Promise<string | null> {
    return this.availability.findPath();
  }

  async isGoAvailableAsync(): Promise<boolean> {
    return this.availability.isAvailable();
  }

  isGoFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".go";
  }
}
