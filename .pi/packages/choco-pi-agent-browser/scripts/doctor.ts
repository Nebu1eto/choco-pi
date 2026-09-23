#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AGENT_BROWSER_LATEST_TESTED_VERSION,
  AGENT_BROWSER_TESTED_VERSIONS,
  resolveAgentBrowserCompatibility,
} from "../extensions/agent-browser/lib/upstream-version.ts";
import {
  hasRuntimeType,
  isRecord,
  type RuntimeValue,
} from "../extensions/agent-browser/lib/parsing.ts";
import { parseJsonPreviewString } from "../extensions/agent-browser/lib/results/presentation/common.ts";

const runFile = promisify(execFile);
const MINIMUM_PI_VERSION = "0.84.0";

interface DoctorOptions {
  agentDir: string;
  cwd: string;
  settingsPaths: string[];
  showHelp: boolean;
  skipSourceCheck: boolean;
}

interface DoctorCheck {
  lines: string[];
  status: "fail" | "pass" | "warn";
  title: string;
}

export function parseCliArgs(argv: string[] = process.argv.slice(2)): DoctorOptions {
  const options: DoctorOptions = {
    agentDir: resolve(homedir(), ".pi/agent"),
    cwd: process.cwd(),
    settingsPaths: [],
    showHelp: false,
    skipSourceCheck: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.showHelp = true;
    else if (argument === "--skip-source-check") options.skipSourceCheck = true;
    else if (["--agent-dir", "--cwd", "--settings"].includes(argument ?? "")) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path.`);
      index += 1;
      if (argument === "--agent-dir") options.agentDir = resolve(value);
      else if (argument === "--cwd") options.cwd = resolve(value);
      else options.settingsPaths.push(resolve(value));
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function printHelp(): void {
  console.log(`choco-pi agent-browser doctor

Usage: node scripts/doctor.ts [options]
  --cwd <path>          Project directory to inspect
  --agent-dir <path>    Pi agent directory (default: ~/.pi/agent)
  --settings <path>     Additional settings file (repeatable)
  --skip-source-check   Skip duplicate source inspection
  -h, --help            Show help

The doctor is read-only. Browser version drift is advisory; missing executables,
malformed configuration, and duplicate active extension sources remain failures.`);
}

async function runVersion(executable: string): Promise<string> {
  const result = await runFile(executable, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return result.stdout.trim();
}

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = /^(?:pi\s+)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function versionAtLeast(actual: string, minimum: string): boolean | undefined {
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (!left || !right) return undefined;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

export async function checkAgentBrowserVersion(
  options: {
    runAgentBrowser?: () => Promise<string>;
  } = {},
): Promise<DoctorCheck> {
  try {
    const output = await (options.runAgentBrowser ?? (() => runVersion("agent-browser")))();
    const compatibility = resolveAgentBrowserCompatibility(output);
    const version = compatibility.detectedVersion ?? "<unrecognized>";
    return {
      status: compatibility.warnings.length > 0 ? "warn" : "pass",
      title: compatibility.profileVersion
        ? `agent-browser ${version} uses source-verified profile ${compatibility.profileVersion}.`
        : `agent-browser ${version} will use conservative compatibility behavior.`,
      lines: compatibility.warnings.map((warning) => warning.message),
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    return {
      status: "fail",
      title: `agent-browser is unavailable on PATH${detail}.`,
      lines: [
        "Install agent-browser and verify `agent-browser --version` in the shell that launches Pi.",
      ],
    };
  }
}

async function checkPiVersion(): Promise<DoctorCheck> {
  let importedVersion: string | undefined;
  let identityError: string | undefined;
  try {
    const identity = await import("../../../extensions/lib/pi-runtime-identity.ts");
    importedVersion = (await identity.readImportedSdkVersion()).version;
  } catch (error: unknown) {
    const optionalModuleMissing =
      error instanceof Error &&
      error.message.includes("pi-runtime-identity.ts") &&
      /cannot find module|module not found/iu.test(error.message);
    if (!optionalModuleMissing)
      identityError = error instanceof Error ? error.message : String(error);
  }
  if (identityError)
    return {
      status: "fail",
      title: "Pi runtime identity helper failed to load.",
      lines: [identityError],
    };
  const importedSupported = importedVersion
    ? versionAtLeast(importedVersion, MINIMUM_PI_VERSION)
    : undefined;
  if (importedVersion && importedSupported !== true)
    return {
      status: importedSupported === false ? "fail" : "warn",
      title: `Imported Pi SDK does not establish the ${MINIMUM_PI_VERSION} package floor: ${importedVersion}.`,
      lines: [],
    };
  try {
    const output = await runVersion("pi");
    const supported = versionAtLeast(output, MINIMUM_PI_VERSION);
    if (supported === false && importedSupported !== true)
      return {
        status: "fail",
        title: `Pi ${MINIMUM_PI_VERSION} or newer is required; launcher reported ${output}.`,
        lines: [],
      };
    if (supported === false && importedSupported === true)
      return {
        status: "warn",
        title: `PATH launcher ${output} is below the package floor, while imported SDK ${importedVersion} is available.`,
        lines: [
          "The unrelated PATH launcher is advisory; use the active host/imported SDK identity for runtime diagnosis.",
        ],
      };
    if (supported === undefined)
      return {
        status: "warn",
        title: `Could not parse Pi launcher version: ${output}.`,
        lines: [],
      };
    return {
      status: "pass",
      title: `Pi launcher satisfies package floor: ${output}.`,
      lines: importedVersion ? [`Imported SDK observation: ${importedVersion}.`] : [],
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      status: "warn",
      title: "Could not inspect the Pi launcher; browser package checks can continue.",
      lines: [`Launcher observation: ${detail}`],
    };
  }
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        result += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) inString = false;
      continue;
    }
    if (character === '"' || character === "'") {
      inString = true;
      quote = character;
      result += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else result += character;
  }
  return result;
}

interface ConfiguredSource {
  location: string;
  source: string;
}

function entrySource(value: RuntimeValue): string | undefined {
  if (hasRuntimeType(value, "string")) return value;
  if (!isRecord(value)) return undefined;
  for (const key of ["source", "path", "package"])
    if (hasRuntimeType(value[key], "string")) return value[key];
  return undefined;
}

function sourceMatches(source: string, cwd: string, base: string): boolean {
  if (/^(?:npm:)?(?:choco-pi-agent-browser|pi-agent-browser-native)(?:@|$)/u.test(source))
    return true;
  if (source.includes("github.com/fitchmultz/pi-agent-browser-native")) return true;
  if (!source.startsWith(".") && !source.startsWith("/") && !source.startsWith("~")) return false;
  const expanded =
    source === "~"
      ? homedir()
      : source.startsWith("~/")
        ? resolve(homedir(), source.slice(2))
        : source;
  const candidate = resolve(base, expanded);
  const roots = [cwd, resolve(dirname(fileURLToPath(import.meta.url)), "..")];
  return roots.some(
    (root) =>
      candidate === root ||
      resolve(root, "extensions/agent-browser/index.ts").startsWith(`${candidate}${sep}`) ||
      candidate === resolve(root, "extensions/agent-browser/index.ts"),
  );
}

function collectConfiguredSources(
  parsed: RuntimeValue,
  path: string,
  cwd: string,
): ConfiguredSource[] {
  if (!isRecord(parsed)) return [];
  const sources: ConfiguredSource[] = [];
  for (const field of ["packages", "extensions"] as const) {
    const entries = parsed[field];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      const source = entrySource(entry);
      if (source && sourceMatches(source, cwd, dirname(path)))
        sources.push({ location: `${path} ${field}[${index}]`, source });
    });
  }
  return sources;
}

export async function checkSources(options: DoctorOptions): Promise<DoctorCheck> {
  const paths = [
    resolve(options.agentDir, "settings.json"),
    resolve(options.cwd, ".pi/settings.json"),
    ...options.settingsPaths,
  ];
  const activeSources: ConfiguredSource[] = [];
  for (const path of new Set(paths)) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      return { status: "fail", title: `Could not read ${path}.`, lines: [] };
    }
    try {
      activeSources.push(
        ...collectConfiguredSources(
          parseJsonPreviewString(stripJsonComments(text)),
          path,
          options.cwd,
        ),
      );
    } catch {
      return { status: "fail", title: `Malformed required settings file: ${path}.`, lines: [] };
    }
  }
  for (const candidate of [
    resolve(options.cwd, ".pi/extensions/agent-browser.ts"),
    resolve(options.cwd, ".pi/extensions/agent-browser/index.ts"),
  ]) {
    try {
      await access(candidate);
      activeSources.push({ location: `${candidate} repo-local autoload`, source: candidate });
    } catch {}
  }
  if (activeSources.length > 1)
    return {
      status: "fail",
      title: "Multiple settings sources register an agent-browser extension.",
      lines: activeSources.map((source) => `${source.source} from ${source.location}`),
    };
  return {
    status: "pass",
    title:
      activeSources.length === 1
        ? `One configured browser source: ${activeSources[0]?.source}`
        : "No duplicate browser source found.",
    lines: [],
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: DoctorOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (options.showHelp) {
    printHelp();
    return 0;
  }
  const checks = [await checkAgentBrowserVersion(), await checkPiVersion()];
  if (!options.skipSourceCheck) checks.push(await checkSources(options));
  for (const check of checks) {
    console.log(`[${check.status}] ${check.title}`);
    for (const line of check.lines) console.log(`  ${line}`);
  }
  console.log(
    `Source-verified browser profiles: ${AGENT_BROWSER_TESTED_VERSIONS.join(", ")}; latest ${AGENT_BROWSER_LATEST_TESTED_VERSION}. Live binary matrix validation is separate.`,
  );
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

export async function isDirectRun(
  metaUrl: string,
  argv1: string | undefined = process.argv[1],
  resolveRealPath: (path: string) => Promise<string> = realpath,
): Promise<boolean> {
  if (!argv1) return false;
  try {
    return (await resolveRealPath(argv1)) === (await resolveRealPath(fileURLToPath(metaUrl)));
  } catch {
    return false;
  }
}

if (await isDirectRun(import.meta.url)) process.exitCode = await main();
