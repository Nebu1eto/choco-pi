import { createSubsystemLogger } from "./extension-log.ts";
import * as path from "node:path";
import {
  type ToolchainAvailability,
  createToolchainAvailability,
} from "./dispatch/runners/utils/toolchain-availability.ts";

export interface RustDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "note" | "help";
  message: string;
  code?: string;
  file: string;
}

const CARGO_WINDOWS_PATHS = [
  path.join(process.env.USERPROFILE || "", ".cargo", "bin", "cargo.exe"),
  path.join(process.env.SYSTEMDRIVE || "C:", "\\cargo", "bin", "cargo.exe"),
  "cargo.exe",
];

const PROBE_TIMEOUT_MS = 3_000;

const CARGO_UNIX_PATHS = [
  path.join(process.env.HOME || "", ".cargo", "bin", "cargo"),
  "/usr/local/cargo/bin/cargo",
  "/usr/bin/cargo",
  "cargo",
];

export class RustClient {
  private readonly availability: ToolchainAvailability;
  private log: (msg: string) => void;

  constructor(verbose = false) {
    this.log = verbose ? createSubsystemLogger("rust") : () => {};
    this.availability = createToolchainAvailability({
      tool: "cargo",
      label: "Cargo",
      windowsPaths: CARGO_WINDOWS_PATHS,
      unixPaths: CARGO_UNIX_PATHS,
      probeArgs: ["--version"],
      budgetMs: PROBE_TIMEOUT_MS,
      log: (msg) => this.log(msg),
    });
  }

  async findCargoPathAsync(): Promise<string | null> {
    return this.availability.findPath();
  }

  async isAvailableAsync(): Promise<boolean> {
    return this.availability.isAvailable();
  }

  isRustFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".rs";
  }
}
