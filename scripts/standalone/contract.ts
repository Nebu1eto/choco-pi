import { readFile } from "node:fs/promises";
import path from "node:path";

export const PI_PACKAGE_RELATIVE = "node_modules/@earendil-works/pi-coding-agent";
export const PI_BIN_ENTRY = "dist/bundle/cli.js";
export const PI_CLI_RELATIVE = `${PI_PACKAGE_RELATIVE}/${PI_BIN_ENTRY}`;
export const ACP_ENTRY_RELATIVE = "packages/choco-pi-acp/bin/choco-pi-acp.ts";
export const BUNFIG_RELATIVE = "scripts/standalone/bunfig.toml";

export const RUNTIMES = ["node", "bun"] as const;
export type Runtime = (typeof RUNTIMES)[number];
export const DEFAULT_RUNTIME: Runtime = "node";

export function isRuntime(value: string): value is Runtime {
  return RUNTIMES.some((runtime) => runtime === value);
}

export function parseRuntime(value: string, origin: string): Runtime {
  if (!isRuntime(value)) {
    throw new Error(
      `${origin} must be one of ${RUNTIMES.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export const RUNTIME_SOURCES = ["env", "install.json", "default"] as const;

export const MANAGEMENT_VERBS = [
  "setup",
  "update",
  "uninstall",
  "env",
  "exec",
  "acp",
  "runtime",
  "help",
] as const;

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

export const CONTRACT_VARIABLES = [
  "CHOCO_PI_HOME",
  "CHOCO_PI_STANDALONE",
  "CHOCO_PI_LAUNCHER",
  "PI_CODING_AGENT_DIR",
  "CHOCO_PI_LSP_HOME",
  "PI_ACP_PI_COMMAND",
  "CHOCO_PI_HOOKS_PI_BIN",
  "CHOCO_PI_NODE",
  "PI_SKIP_VERSION_CHECK",
] as const;

export const RUNTIME_REPORT_VARIABLES = [
  "CHOCO_PI_RUNTIME",
  "CHOCO_PI_RUNTIME_SOURCE",
  "CHOCO_PI_BUN",
] as const;

export const UNSET_PI_VARIABLES = [
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_PACKAGE_DIR",
  "PI_MANAGED_INSTALL_ROOT",
  "PI_SELF_UPDATE_COMMAND",
  "PI_INSTALLER_API_BASE",
  "PI_SESSION_FILE",
] as const;

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

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type Contract = { home: string; launcher: string };

export function requireContract(): Contract {
  const home = process.env.CHOCO_PI_HOME;
  const launcher = process.env.CHOCO_PI_LAUNCHER;
  if (process.env.CHOCO_PI_STANDALONE !== "1" || home === undefined || launcher === undefined) {
    throw new UsageError("run this through the choco-pi launcher (bin/choco-pi self ...)");
  }
  if (!path.isAbsolute(home) || !path.isAbsolute(launcher))
    throw new Error("launcher contract paths must be absolute");
  return { home, launcher };
}
