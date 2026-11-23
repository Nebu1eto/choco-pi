import { isRuntimeString } from "../../tools/runtime-values.ts";
import { logExtension } from "../extension-log.ts";
import path from "node:path";
import { getGlobalPiLensDir } from "../file-utils.ts";

export const GITHUB_BIN_DIR = path.join(getGlobalPiLensDir(), "bin");

const DEBUG = process.env.CHOCO_PI_LSP_DEBUG === "1" || process.argv.includes("--debug");

export function installerPlatform(): NodeJS.Platform {
  const override = process.env.CHOCO_PI_LSP_TEST_PLATFORM;
  if (override === "win32" || override === "linux") {
    return override;
  }
  return process.platform;
}

export function debugLog(...args: unknown[]): void {
  if (DEBUG) {
    logExtension({
      subsystem: "auto-install",
      level: "debug",
      message: args.map((arg) => (isRuntimeString(arg) ? arg : JSON.stringify(arg))).join(" "),
    });
  }
}
