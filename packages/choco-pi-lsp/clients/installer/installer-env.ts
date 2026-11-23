/**
 * Installer platform detection, the GitHub bin directory, and debug logging.
 */
import { isRuntimeString } from "../../tools/runtime-values.ts";
import { logExtension } from "../extension-log.ts";
import path from "node:path";
import { getGlobalPiLensDir } from "../file-utils.ts";

// Directory for GitHub-downloaded binaries
export const GITHUB_BIN_DIR = path.join(getGlobalPiLensDir(), "bin");

// Debug flag - set via CHOCO_PI_LSP_DEBUG=1 or --debug
const DEBUG = process.env.CHOCO_PI_LSP_DEBUG === "1" || process.argv.includes("--debug");

/** Test-only platform seam for Windows resource-layout coverage on Linux CI. */
export function installerPlatform(): NodeJS.Platform {
  const override = process.env.CHOCO_PI_LSP_TEST_PLATFORM;
  if (override === "win32" || override === "linux") {
    return override;
  }
  return process.platform;
}

/**
 * Log debug messages only when DEBUG is enabled
 */
export function debugLog(...args: unknown[]): void {
  if (DEBUG) {
    // #1333: DEBUG gate preserved; sink is extension.log, never the TUI.
    logExtension({
      subsystem: "auto-install",
      level: "debug",
      message: args.map((arg) => (isRuntimeString(arg) ? arg : JSON.stringify(arg))).join(" "),
    });
  }
}
