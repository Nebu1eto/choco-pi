/**
 * The standalone launcher contract shared by `bin/choco-pi`, the management
 * verbs and the tests. `bin/choco-pi` is POSIX sh and cannot import this
 * module; tests/standalone-launcher.test.ts asserts both stay identical.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Relative to the app root. Must equal the `bin.pi` entry of Pi's package.json. */
export const PI_PACKAGE_RELATIVE = "node_modules/@earendil-works/pi-coding-agent";
export const PI_BIN_ENTRY = "dist/bundle/cli.js";
export const PI_CLI_RELATIVE = `${PI_PACKAGE_RELATIVE}/${PI_BIN_ENTRY}`;
export const ACP_ENTRY_RELATIVE = "packages/choco-pi-acp/bin/choco-pi-acp.ts";

/** `choco-pi self <verb>`; anything else goes to Pi unchanged. */
export const MANAGEMENT_VERBS = [
  "setup",
  "update",
  "uninstall",
  "env",
  "exec",
  "acp",
  "help",
] as const;

/** Pi 1.5.2 top-level subcommands; the management namespace must not shadow them. */
export const PI_SUBCOMMANDS = [
  "install",
  "remove",
  "uninstall",
  "update",
  "list",
  "config",
  "auth",
  "mcp",
] as const;

/** Set unconditionally by the launcher (`PI_SKIP_VERSION_CHECK` only when unset). */
export const CONTRACT_VARIABLES = [
  "CHOCO_PI_HOME",
  "CHOCO_PI_STANDALONE",
  "CHOCO_PI_LAUNCHER",
  "PI_CODING_AGENT_DIR",
  "CHOCO_PI_LSP_HOME",
  "PI_ACP_PI_COMMAND",
  "CHOCO_PI_HOOKS_PI_BIN",
  "PI_SKIP_VERSION_CHECK",
] as const;

/**
 * Pi 1.5.2 variables that point at Pi state or at Pi's own install location.
 * The launcher unsets exactly these; the classification table lives in
 * bin/choco-pi.
 */
export const UNSET_PI_VARIABLES = [
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_PACKAGE_DIR",
  "PI_MANAGED_INSTALL_ROOT",
  "PI_SELF_UPDATE_COMMAND",
  "PI_INSTALLER_API_BASE",
  "PI_SESSION_FILE",
] as const;

/** Fails when Pi's `bin.pi` moved away from the path the launcher executes. */
export async function assertPiBinEntry(appRoot: string): Promise<string> {
  const manifestFile = path.join(appRoot, PI_PACKAGE_RELATIVE, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch {
    throw new Error(`cannot read Pi's package manifest at ${manifestFile}; is the app installed?`);
  }
  const entry =
    parsed instanceof Object &&
    "bin" in parsed &&
    parsed.bin instanceof Object &&
    "pi" in parsed.bin
      ? parsed.bin.pi
      : undefined;
  if (entry !== PI_BIN_ENTRY) {
    throw new Error(
      `Pi's bin entry is ${JSON.stringify(entry)}, but bin/choco-pi executes ${PI_BIN_ENTRY}; update the launcher`,
    );
  }
  return path.join(appRoot, PI_CLI_RELATIVE);
}

/** The `version` of the installed Pi package. */
export async function installedPiVersion(appRoot: string): Promise<string> {
  const parsed: unknown = JSON.parse(
    await readFile(path.join(appRoot, PI_PACKAGE_RELATIVE, "package.json"), "utf8"),
  );
  const version = parsed instanceof Object && "version" in parsed ? parsed.version : undefined;
  if (version === undefined || version === null || String(version) === "") {
    throw new Error("Pi's package manifest has no version");
  }
  return String(version);
}
