import { logExtension } from "./extension-log.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BoundedLruCache } from "./bounded-cache.ts";
import { normalizeMapKey } from "./path-utils.ts";
import { TERRAGRUNT_FILENAMES } from "./file-kinds.ts";
import { detectIndentation, hasDetectableIndentation } from "./dispatch/indent-detect.ts";
import { logLatency } from "./latency-logger.ts";
import {
  isIgnoredFileExit,
  OXFMT_IGNORED_FILE_EXIT,
  type IgnoredFileExit,
} from "./formatter-exit.ts";
import {
  type AvailabilityLatch,
  classifyProbeFailure,
  createAvailabilityLatch,
  logAvailabilityDecision,
  startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.ts";
import { findGlobalBinary, findLocalBinUpwards } from "./package-manager.ts";
import { safeSpawnAsync } from "./safe-spawn.ts";
import { assertInstallAllowed } from "./project-trust.ts";
import { tryLazyInstallForFormatter } from "./dispatch/runners/utils/lazy-installer.ts";
import {
  findPSScriptAnalyzerConfigPath,
  getAutoInstallToolIdForFormatter,
  getFormatterPolicyForFile,
  getSmartDefaultFormatterName,
  hasBiomeConfig,
  hasBlackConfig,
  hasClangFormatConfig,
  hasCljfmtConfig,
  hasCmakeFormatConfig,
  hasCsharpierConfig,
  hasFantomasConfig,
  hasGoogleJavaFormatConfig,
  hasKtfmtConfig,
  hasKtlintConfig,
  hasMixFormatConfig,
  hasNearestPackageJsonDependency,
  hasNearestPackageJsonField,
  hasOcamlformatConfig,
  hasOrmoluConfig,
  hasOxfmtConfig,
  hasOxfmtSvelteConfig,
  hasPhpCsFixerConfig,
  hasPrettierConfig,
  hasPSScriptAnalyzerConfig,
  hasRubocopConfig,
  hasRuffConfig,
  hasSqlfluffConfig,
  hasStandardrbConfig,
  hasStyluaConfig,
  hasSwiftformatConfig,
  hasTaploConfig,
  hasTerraformConfig,
  hasVitePlusConfig,
  OXFMT_SUPPORTED_EXTENSIONS,
} from "./tool-policy.ts";

export async function tryLazyInstallFormatterTool(
  tool: "rubocop" | "rustfmt",
  cwd: string,
): Promise<boolean> {
  const ok = await tryLazyInstallForFormatter(tool, cwd);
  if (ok) resetWhichLatches();
  return ok;
}

export const SKIP_FORMATTING = "skip-formatting" as const;
export type ResolvedFormatterCommand = string[] | null | typeof SKIP_FORMATTING;

export interface FormatterInfo {
  name: string;
  command: string[];
  extensions: string[];
  filenames?: readonly string[];
  detect(cwd: string): Promise<boolean>;
  resolveCommand?(filePath: string, cwd: string): Promise<ResolvedFormatterCommand>;
  lenientExitCode?: string;
  lenientStatuses?: number[];
  ignoredFileExit?: IgnoredFileExit;
}

export interface FormatterResult {
  success: boolean;
  changed: boolean;
  error?: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findUp(
  targets: string[],
  startDir: string,
  stopDir: string = path.parse(startDir).root,
): Promise<string[]> {
  const found: string[] = [];
  let currentDir = startDir;

  while (currentDir !== stopDir) {
    for (const target of targets) {
      const checkPath = path.join(currentDir, target);
      if (await fileExists(checkPath)) {
        found.push(checkPath);
      }
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return found;
}

const WHICH_BUDGET_MS = 5000;

const whichLatchByCommand = new Map<
  string,
  { latch: AvailabilityLatch; resolved: string | null }
>();

const whichTransientCommands = new Set<string>();

const probedCommandsStorage = new AsyncLocalStorage<Set<string>>();

type CandidateVerdict = "available" | "missing" | "unreachable";

interface CandidateOutcome {
  name: string;
  verdict: CandidateVerdict;
  stalledCommands: string[];
}

async function detectCandidate(
  formatter: FormatterInfo,
  cwd: string,
): Promise<{ detected: boolean; error?: unknown; outcome: CandidateOutcome }> {
  const probed = new Set<string>();
  let detected = false;
  let error: unknown;
  try {
    detected = await probedCommandsStorage.run(probed, () => formatter.detect(cwd));
  } catch (err) {
    error = err;
  }
  const stalledCommands = [...probed].filter((command) => whichTransientCommands.has(command));
  return {
    detected,
    ...(error !== undefined && { error }),
    outcome: {
      name: formatter.name,
      verdict: detected ? "available" : stalledCommands.length > 0 ? "unreachable" : "missing",
      stalledCommands,
    },
  };
}

function resetWhichLatches(): void {
  whichLatchByCommand.clear();
  whichTransientCommands.clear();
  cooldownRecordedForRetryAtMs.clear();
}

const cooldownRecordedForRetryAtMs = new Map<string, number>();

function noteCooldownServedVerdict(command: string, latch: AvailabilityLatch): void {
  if (latch.getOutcome() !== "transient") return;
  const retryAtMs = latch.getRetryAtMs();
  if (retryAtMs <= 0) return;
  if (cooldownRecordedForRetryAtMs.get(command) === retryAtMs) return;
  cooldownRecordedForRetryAtMs.set(command, retryAtMs);
  const cause = latch.getCause();
  if (cause === null) {
    logExtension({
      subsystem: "format",
      message: `which latch: transient outcome with no cause for ${command}; cooldown-served record dropped`,
      metadata: { tool: command, retryAtMs },
    });
    return;
  }
  logAvailabilityDecision({
    tool: command,
    verdict: "unavailable",
    outcome: "transient",
    cause,
    elapsedMs: 0,
    latched: false,
    retryAfterMs: Math.max(1, retryAtMs - Date.now()),
    budgetMs: WHICH_BUDGET_MS,
    servedFromCooldown: true,
  });
}

async function which(command: string): Promise<string | null> {
  probedCommandsStorage.getStore()?.add(command);
  let entry = whichLatchByCommand.get(command);
  if (!entry) {
    entry = { latch: createAvailabilityLatch(), resolved: null };
    whichLatchByCommand.set(command, entry);
  }
  const memo = entry.latch.read();
  if (memo !== null) {
    if (!memo) noteCooldownServedVerdict(command, entry.latch);
    return memo ? entry.resolved : null;
  }

  const stallSampler = startHostStallSampler();
  const startedAt = Date.now();
  const result = await safeSpawnAsync(process.platform === "win32" ? "where" : "which", [command], {
    timeout: WHICH_BUDGET_MS,
  });
  const hostStallMs = stallSampler.stop();
  const elapsedMs = Date.now() - startedAt;

  const resolved =
    !result.error && result.status === 0 ? (result.stdout?.trim().split(/\r?\n/)[0] ?? null) : null;
  if (resolved) {
    entry.resolved = resolved;
    entry.latch.noteAvailable();
    whichTransientCommands.delete(command);
    cooldownRecordedForRetryAtMs.delete(command);
    logAvailabilityDecision({
      tool: command,
      verdict: "available",
      outcome: "success",
      cause: "ok",
      elapsedMs,
      latched: true,
      hostStallMs,
      budgetMs: WHICH_BUDGET_MS,
    });
    return resolved;
  }

  entry.resolved = null;
  const proberRan = !result.error;
  const classified = classifyProbeFailure(result, {
    hostStallMs,
    ...(proberRan && { unclassifiedFailureOutcome: "missing" as const }),
  });
  let { outcome, cause } = classified;
  if (!proberRan && outcome !== "transient") {
    outcome = "transient";
    cause = "probe-rejected";
  }
  const retryAfterMs = entry.latch.noteUnavailable(outcome, cause);
  if (outcome === "transient") whichTransientCommands.add(command);
  else whichTransientCommands.delete(command);
  cooldownRecordedForRetryAtMs.delete(command);
  logAvailabilityDecision({
    tool: command,
    verdict: "unavailable",
    outcome,
    cause,
    elapsedMs,
    latched: retryAfterMs === 0,
    hostStallMs,
    ...(retryAfterMs > 0 && { retryAfterMs }),
    budgetMs: WHICH_BUDGET_MS,
  });
  return null;
}

async function resolveGoFmtBinary(): Promise<string | null> {
  const inPath = await which("gofmt");
  if (inPath) return inPath;

  const goCheck = await safeSpawnAsync("go", ["env", "GOROOT"], {
    timeout: 5000,
  });
  if (goCheck.error || goCheck.status !== 0) return null;

  const goroot = (goCheck.stdout ?? "").trim();
  if (!goroot) return null;

  const binary = path.join(goroot, "bin", process.platform === "win32" ? "gofmt.exe" : "gofmt");
  return (await fileExists(binary)) ? binary : null;
}

async function findInVenv(binary: string, cwd: string): Promise<string | null> {
  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [
        `.venv/Scripts/${binary}.exe`,
        `venv/Scripts/${binary}.exe`,
        `.venv/Scripts/${binary}`,
        `venv/Scripts/${binary}`,
      ]
    : [`.venv/bin/${binary}`, `venv/bin/${binary}`];

  let dir = cwd;
  const root = path.parse(dir).root;
  while (dir !== root) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (await fileExists(full)) return full;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function findInVendorBin(binary: string, cwd: string): Promise<string | null> {
  const isWin = process.platform === "win32";
  const names = isWin ? [`${binary}.bat`, binary] : [binary];
  let dir = cwd;
  const root = path.parse(dir).root;
  while (dir !== root) {
    for (const name of names) {
      const full = path.join(dir, "vendor", "bin", name);
      if (await fileExists(full)) return full;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function findInNodeModules(binary: string, cwd: string): Promise<string | null> {
  const isWin = process.platform === "win32";
  let dir = cwd;
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidates = isWin
      ? [
          path.join(dir, "node_modules", ".bin", `${binary}.cmd`),
          path.join(dir, "node_modules", ".bin", binary),
        ]
      : [path.join(dir, "node_modules", ".bin", binary)];
    for (const full of candidates) {
      if (await fileExists(full)) return full;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function canUseBundleExec(cwd: string): Promise<boolean> {
  if ((await which("bundle")) === null) return false;
  const lockfiles = await findUp(["Gemfile.lock"], cwd);
  return lockfiles.length > 0;
}

async function resolveManagedSmartDefaultCommand(
  formatterName: string,
  filePath: string,
  args: string[],
): Promise<string[] | null> {
  const toolId = getAutoInstallToolIdForFormatter(formatterName);
  if (!toolId) return null;
  const { ensureTool } = await import("./installer/index.ts");
  const installed = await ensureTool(toolId);
  if (!installed) return null;
  return [installed, ...args, filePath];
}

const EXPLICIT_FORMATTER_CONFIG_CHECKS = new Map<string, (cwd: string, ext: string) => boolean>([
  ["biome", (cwd) => hasBiomeConfig(cwd)],
  ["prettier", (cwd) => hasPrettierConfig(cwd) || hasNearestPackageJsonField(cwd, "prettier")],
  [
    "oxfmt",
    (cwd, ext) =>
      ext === ".svelte"
        ? hasOxfmtSvelteConfig(cwd)
        : hasOxfmtConfig(cwd) ||
          hasVitePlusConfig(cwd) ||
          hasNearestPackageJsonDependency(cwd, "oxfmt") ||
          hasNearestPackageJsonDependency(cwd, "@oxc-project/oxfmt"),
  ],
  ["ruff", (cwd) => hasRuffConfig(cwd)],
  ["black", (cwd) => hasBlackConfig(cwd)],
  ["sqlfluff", (cwd) => hasSqlfluffConfig(cwd)],
  ["rubocop", (cwd) => hasRubocopConfig(cwd)],
  ["standardrb", (cwd) => hasStandardrbConfig(cwd)],
  ["clang-format", (cwd) => hasClangFormatConfig(cwd)],
  ["php-cs-fixer", (cwd) => hasPhpCsFixerConfig(cwd)],
  ["stylua", (cwd) => hasStyluaConfig(cwd)],
  ["ocamlformat", (cwd) => hasOcamlformatConfig(cwd)],
  ["google-java-format", (cwd) => hasGoogleJavaFormatConfig(cwd)],
  ["ktfmt", (cwd) => hasKtfmtConfig(cwd)],
  ["ktlint", (cwd) => hasKtlintConfig(cwd)],
  ["cljfmt", (cwd) => hasCljfmtConfig(cwd)],
  ["cmake-format", (cwd) => hasCmakeFormatConfig(cwd)],
  ["psscriptanalyzer-format", (cwd) => hasPSScriptAnalyzerConfig(cwd)],
  ["csharpier", (cwd) => hasCsharpierConfig(cwd)],
  ["ormolu", (cwd) => hasOrmoluConfig(cwd)],
  ["taplo", (cwd) => hasTaploConfig(cwd)],
  ["terraform", (cwd) => hasTerraformConfig(cwd)],
  ["swiftformat", (cwd) => hasSwiftformatConfig(cwd)],
  ["fantomas", (cwd) => hasFantomasConfig(cwd)],
  ["mix", (cwd) => hasMixFormatConfig(cwd)],
]);

function hasExplicitFormatterConfig(formatterName: string, cwd: string, ext: string): boolean {
  return EXPLICIT_FORMATTER_CONFIG_CHECKS.get(formatterName)?.(cwd, ext) ?? false;
}

export const FORMATTERS_WITH_EXPLICIT_CONFIG_CHECK = new Set<string>(
  EXPLICIT_FORMATTER_CONFIG_CHECKS.keys(),
);

async function hasEditorConfig(cwd: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, ".editorconfig"));
    return true;
  } catch {
    return false;
  }
}

async function indentationArgs(
  filePath: string,
  tool: "biome" | "prettier" | "ruff" | "shfmt",
  cwd: string,
): Promise<string[] | null> {
  if (
    (await hasEditorConfig(cwd)) ||
    hasExplicitFormatterConfig(tool, cwd, path.extname(filePath))
  ) {
    return [];
  }
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  if (!hasDetectableIndentation(content)) return null;
  const indentation = detectIndentation(content);
  if (tool === "shfmt")
    return indentation.style === "tab" ? ["-i", "0"] : ["-i", String(indentation.width)];
  if (tool === "prettier") {
    return [
      indentation.style === "tab" ? "--use-tabs" : "--no-use-tabs",
      "--tab-width",
      String(indentation.width),
    ];
  }
  if (tool === "ruff") {
    return [
      "--config",
      `indent-width=${indentation.width}`,
      "--config",
      `format.indent-style='${indentation.style}'`,
    ];
  }
  return ["--indent-style", indentation.style, "--indent-width", String(indentation.width)];
}

const BIOME_UNMATCHED_FLAG = "--no-errors-on-unmatched";

export const biomeFormatter: FormatterInfo = {
  name: "biome",
  command: ["npx", "@biomejs/biome", "format", "--write", BIOME_UNMATCHED_FLAG, "$FILE"],
  async resolveCommand(filePath, cwd) {
    const editorConfigFlag = (await hasEditorConfig(cwd)) ? ["--use-editorconfig=true"] : [];
    const styleArgs = await indentationArgs(filePath, "biome", cwd);
    if (styleArgs === null) return SKIP_FORMATTING;
    const args = ["format", "--write", BIOME_UNMATCHED_FLAG, ...editorConfigFlag, ...styleArgs];
    const local = await findInNodeModules("biome", cwd);
    if (local) return [local, ...args, filePath];
    const global = await findGlobalBinary("biome");
    if (global) return [global, ...args, filePath];
    const toolId = getAutoInstallToolIdForFormatter("biome");
    if (!toolId) return null;
    const { ensureTool } = await import("./installer/index.ts");
    const installed = await ensureTool(toolId);
    if (installed) return [installed, ...args, filePath];
    return null;
  },
  extensions: [
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".json",
    ".jsonc",
    ".css",
    ".scss",
    ".sass",
    ".vue",
    ".svelte",
    ".html",
    ".htm",
  ],
  async detect(cwd: string) {
    return hasBiomeConfig(cwd) || hasNearestPackageJsonDependency(cwd, "@biomejs/biome");
  },
};

export const prettierFormatter: FormatterInfo = {
  name: "prettier",
  command: ["npx", "prettier", "--write", "$FILE"],
  async resolveCommand(filePath, cwd) {
    const styleArgs = await indentationArgs(filePath, "prettier", cwd);
    if (styleArgs === null) return SKIP_FORMATTING;
    const args = ["--write", ...styleArgs];
    const local = await findInNodeModules("prettier", cwd);
    if (local) return [local, ...args, filePath];
    const global = await findGlobalBinary("prettier");
    if (global) return [global, ...args, filePath];
    return resolveManagedSmartDefaultCommand("prettier", filePath, args);
  },
  extensions: [
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".json",
    ".jsonc",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",
    ".html",
    ".htm",
    ".md",
    ".mdx",
    ".yaml",
    ".yml",
    ".graphql",
    ".gql",
  ],
  async detect(cwd: string) {
    return (
      hasPrettierConfig(cwd) ||
      hasNearestPackageJsonDependency(cwd, "prettier") ||
      hasNearestPackageJsonField(cwd, "prettier")
    );
  },
};

export const oxfmtFormatter: FormatterInfo = {
  name: "oxfmt",
  command: ["oxfmt", "$FILE"],
  ignoredFileExit: OXFMT_IGNORED_FILE_EXIT,
  async resolveCommand(filePath, cwd) {
    if (hasVitePlusConfig(cwd)) {
      const localVp = await findInNodeModules("vp", cwd);
      if (localVp) return [localVp, "fmt", filePath, "--write"];
      const globalVp = await which("vp");
      if (globalVp) return [globalVp, "fmt", filePath, "--write"];
    }
    const local = await findInNodeModules("oxfmt", cwd);
    if (local) return [local, filePath];
    const found = await which("oxfmt");
    if (found) return [found, filePath];
    return null;
  },
  extensions: [...OXFMT_SUPPORTED_EXTENSIONS],
  async detect(cwd: string) {
    return (
      hasOxfmtConfig(cwd) ||
      hasVitePlusConfig(cwd) ||
      hasNearestPackageJsonDependency(cwd, "oxfmt") ||
      hasNearestPackageJsonDependency(cwd, "@oxc-project/oxfmt")
    );
  },
};

export const ruffFormatter: FormatterInfo = {
  name: "ruff",
  command: ["ruff", "format", "$FILE"],
  extensions: [".py", ".pyi"],
  async resolveCommand(filePath, cwd) {
    const styleArgs = await indentationArgs(filePath, "ruff", cwd);
    if (styleArgs === null) return SKIP_FORMATTING;
    const args = ["format", ...styleArgs];
    const venv = await findInVenv("ruff", cwd);
    if (venv) return [venv, ...args, filePath];
    const toolId = getAutoInstallToolIdForFormatter("ruff");
    if (!toolId) return null;
    const { ensureTool } = await import("./installer/index.ts");
    const installed = await ensureTool(toolId);
    if (installed) return [installed, ...args, filePath];
    return null;
  },
  async detect(cwd: string) {
    if (hasRuffConfig(cwd)) return true;
    const { getToolPath } = await import("./installer/index.ts");
    const installed = await getToolPath("ruff");
    return Boolean(installed);
  },
};

export const blackFormatter: FormatterInfo = {
  name: "black",
  command: ["black", "$FILE"],
  extensions: [".py", ".pyi"],
  async resolveCommand(filePath, cwd) {
    const venv = await findInVenv("black", cwd);
    if (venv) return [venv, filePath];
    return null;
  },
  async detect(cwd: string) {
    return hasBlackConfig(cwd);
  },
};

export const sqlfluffFormatter: FormatterInfo = {
  name: "sqlfluff",
  command: ["sqlfluff", "fix", "--force", "$FILE"],
  extensions: [".sql"],
  lenientExitCode:
    "lint-autofix: `sqlfluff fix` writes the corrected file and then exits 1 " +
    "when unfixable violations remain (its documented exit codes are 0 = all " +
    "clean, 1 = violations remain, 2 = command/config failure), so a nonzero " +
    "exit routinely accompanies a successful rewrite.",
  lenientStatuses: [1],
  async resolveCommand(filePath, cwd) {
    const venv = await findInVenv("sqlfluff", cwd);
    if (venv) return [venv, "fix", "--force", filePath];
    return null;
  },
  async detect(cwd: string) {
    return hasSqlfluffConfig(cwd);
  },
};

export const gofmtFormatter: FormatterInfo = {
  name: "gofmt",
  command: ["gofmt", "-w", "$FILE"],
  extensions: [".go"],
  async resolveCommand(filePath, _cwd) {
    const gofmtBinary = await resolveGoFmtBinary();
    if (!gofmtBinary) return null;
    return [gofmtBinary, "-w", filePath];
  },
  async detect(_cwd: string) {
    return (await resolveGoFmtBinary()) !== null;
  },
};

export const rustfmtFormatter: FormatterInfo = {
  name: "rustfmt",
  command: ["rustfmt", "$FILE"],
  extensions: [".rs"],
  async detect(cwd: string) {
    if ((await which("rustfmt")) !== null) return true;
    const rustProject = (await findUp(["Cargo.toml"], cwd)).length > 0;
    if (!rustProject) return false;
    if ((await which("rustup")) === null) return false;
    await tryLazyInstallFormatterTool("rustfmt", cwd);
    return (await which("rustfmt")) !== null;
  },
};

export const zigFormatter: FormatterInfo = {
  name: "zig",
  command: ["zig", "fmt", "$FILE"],
  extensions: [".zig", ".zon"],
  async detect(_cwd: string) {
    return (await which("zig")) !== null;
  },
};

export const dartFormatter: FormatterInfo = {
  name: "dart",
  command: ["dart", "format", "$FILE"],
  extensions: [".dart"],
  async detect(_cwd: string) {
    return (await which("dart")) !== null;
  },
};

export const shfmtFormatter: FormatterInfo = {
  name: "shfmt",
  command: ["shfmt", "-w", "$FILE"],
  extensions: [".sh", ".bash"],
  async resolveCommand(filePath, cwd) {
    const styleArgs = await indentationArgs(filePath, "shfmt", cwd);
    if (styleArgs === null) return SKIP_FORMATTING;
    const inPath = await which("shfmt");
    if (inPath) return [inPath, "-w", ...styleArgs, filePath];
    return resolveManagedSmartDefaultCommand("shfmt", filePath, ["-w", ...styleArgs]);
  },
  async detect(_cwd: string) {
    if ((await which("shfmt")) !== null) return true;
    const { getToolPath } = await import("./installer/index.ts");
    return Boolean(await getToolPath("shfmt"));
  },
};

export const nixfmtFormatter: FormatterInfo = {
  name: "nixfmt",
  command: ["nixfmt", "$FILE"],
  extensions: [".nix"],
  async detect(_cwd: string) {
    return (await which("nixfmt")) !== null;
  },
};

export const mixFormatter: FormatterInfo = {
  name: "mix",
  command: ["mix", "format", "$FILE"],
  extensions: [".ex", ".exs", ".eex", ".heex", ".leex"],
  async detect(_cwd: string) {
    return (await which("mix")) !== null;
  },
};

export const ocamlformatFormatter: FormatterInfo = {
  name: "ocamlformat",
  command: ["ocamlformat", "-i", "$FILE"],
  extensions: [".ml", ".mli"],
  async detect(cwd: string) {
    const hasBinary = (await which("ocamlformat")) !== null;
    if (!hasBinary) return false;
    const configs = [".ocamlformat"];
    const found = await findUp(configs, cwd);
    return found.length > 0;
  },
};

export const clangFormatFormatter: FormatterInfo = {
  name: "clang-format",
  command: ["clang-format", "-i", "$FILE"],
  extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".ino"],
  async detect(cwd: string) {
    const hasBinary = (await which("clang-format")) !== null;
    if (!hasBinary) return false;
    const configs = [".clang-format", "_clang-format"];
    const found = await findUp(configs, cwd);
    return found.length > 0;
  },
};

export const ktlintFormatter: FormatterInfo = {
  name: "ktlint",
  command: ["ktlint", "-F", "$FILE"],
  extensions: [".kt", ".kts"],
  lenientExitCode:
    "lint-autofix: `ktlint -F` autocorrects what it can and then exits 1 if " +
    "any lint error remains unfixed — the documented CLI contract (ktlint " +
    "exits nonzero whenever violations are reported, and -F does not suppress " +
    "the ones it cannot correct).",
  lenientStatuses: [1],
  async resolveCommand(filePath, _cwd) {
    const inPath = await which("ktlint");
    if (inPath) return [inPath, "-F", filePath];
    return resolveManagedSmartDefaultCommand("ktlint", filePath, ["-F"]);
  },
  async detect(_cwd: string) {
    if ((await which("ktlint")) !== null) return true;
    const { getToolPath } = await import("./installer/index.ts");
    return Boolean(await getToolPath("ktlint"));
  },
};

export const ktfmtFormatter: FormatterInfo = {
  name: "ktfmt",
  command: ["ktfmt", "$FILE"],
  extensions: [".kt", ".kts"],
  async resolveCommand(filePath, _cwd) {
    const inPath = await which("ktfmt");
    if (inPath) return [inPath, filePath];
    const { ensureTool } = await import("./installer/index.ts");
    const installed = await ensureTool("ktfmt");
    return installed ? [installed, filePath] : null;
  },
  async detect(cwd: string) {
    return hasKtfmtConfig(cwd);
  },
};

export const rubocopFormatter: FormatterInfo = {
  name: "rubocop",
  command: ["rubocop", "-a", "--no-color", "$FILE"],
  extensions: [".rb", ".rake", ".gemspec", ".ru"],
  lenientExitCode:
    "lint-autofix: `rubocop -a` exits 1 whenever ANY offense remains after it " +
    "has already rewritten the file. Verified locally (rubocop on Ruby 3.4): a " +
    "file with an unfixable Lint/UselessAssignment exits 1, and even a " +
    "tidy file exits 1 on an unfixable Style/Documentation offense — nonzero " +
    "is the normal outcome, not a failure.",
  lenientStatuses: [1],
  async resolveCommand(filePath, cwd) {
    if (await canUseBundleExec(cwd))
      return ["bundle", "exec", "rubocop", "-a", "--no-color", filePath];
    return null;
  },
  async detect(cwd: string) {
    if (!hasRubocopConfig(cwd)) return false;
    if ((await which("rubocop")) !== null) return true;
    await tryLazyInstallFormatterTool("rubocop", cwd);
    return (await which("rubocop")) !== null;
  },
};

export const standardrbFormatter: FormatterInfo = {
  name: "standardrb",
  command: ["standardrb", "--fix", "$FILE"],
  extensions: [".rb", ".rake"],
  lenientExitCode:
    "lint-autofix: standardrb is a RuboCop wrapper and inherits its exit " +
    "contract — `--fix` exits 1 when offenses remain after the rewrite.",
  lenientStatuses: [1],
  async resolveCommand(filePath, cwd) {
    if (await canUseBundleExec(cwd)) return ["bundle", "exec", "standardrb", "--fix", filePath];
    return null;
  },
  async detect(cwd: string) {
    if (!hasStandardrbConfig(cwd)) return false;
    return (await which("standardrb")) !== null;
  },
};

export const gleamFormatter: FormatterInfo = {
  name: "gleam",
  command: ["gleam", "format", "$FILE"],
  extensions: [".gleam"],
  async detect(cwd: string) {
    const found = await findUp(["gleam.toml"], cwd);
    if (found.length > 0) return (await which("gleam")) !== null;
    return false;
  },
};

export const terraformFormatter: FormatterInfo = {
  name: "terraform",
  command: ["terraform", "fmt", "$FILE"],
  extensions: [".tf", ".tfvars"],
  async detect(_cwd: string) {
    return (await which("terraform")) !== null;
  },
};

export const terragruntHclFormatter: FormatterInfo = {
  name: "terragrunt-hcl",
  command: ["terragrunt", "hcl", "fmt", "--file", "$FILE"],
  extensions: [],
  filenames: TERRAGRUNT_FILENAMES,
  async detect(_cwd: string) {
    return (await which("terragrunt")) !== null;
  },
};

export const phpCsFixerFormatter: FormatterInfo = {
  name: "php-cs-fixer",
  command: ["php-cs-fixer", "fix", "$FILE"],
  extensions: [".php"],
  async resolveCommand(filePath, cwd) {
    const vendor = await findInVendorBin("php-cs-fixer", cwd);
    if (vendor) return [vendor, "fix", filePath];
    return null;
  },
  async detect(cwd: string) {
    const vendorBin = await findInVendorBin("php-cs-fixer", cwd);
    const globalBin = await which("php-cs-fixer");
    if (!vendorBin && !globalBin) return false;
    const configs = [".php-cs-fixer.php", ".php-cs-fixer.dist.php"];
    const found = await findUp(configs, cwd);
    return found.length > 0;
  },
};

export const csharpierFormatter: FormatterInfo = {
  name: "csharpier",
  command: ["csharpier", "format", "$FILE"],
  extensions: [".cs"],
  async resolveCommand(filePath, _cwd) {
    if ((await which("csharpier")) !== null) {
      return ["csharpier", "format", filePath];
    }
    if ((await which("dotnet")) !== null) {
      const legacy = await safeSpawnAsync("dotnet", ["csharpier", "--version"], {
        timeout: 5000,
      });
      if (!legacy.error && legacy.status === 0) {
        return ["dotnet", "csharpier", filePath];
      }
    }
    return null;
  },
  async detect(_cwd: string) {
    if ((await which("csharpier")) !== null) return true;
    if ((await which("dotnet")) === null) return false;
    const result = await safeSpawnAsync("dotnet", ["csharpier", "--version"], {
      timeout: 5000,
    });
    return !result.error && result.status === 0;
  },
};

export const fantomasFormatter: FormatterInfo = {
  name: "fantomas",
  command: ["fantomas", "$FILE"],
  extensions: [".fs", ".fsi", ".fsx"],
  async detect(_cwd: string) {
    return (await which("fantomas")) !== null;
  },
};

export const swiftformatFormatter: FormatterInfo = {
  name: "swiftformat",
  command: ["swiftformat", "$FILE"],
  extensions: [".swift"],
  async detect(_cwd: string) {
    return (await which("swiftformat")) !== null;
  },
};

export const styluaFormatter: FormatterInfo = {
  name: "stylua",
  command: ["stylua", "$FILE"],
  extensions: [".lua"],
  async resolveCommand(filePath, cwd) {
    const local = findLocalBinUpwards("stylua", cwd);
    return local ? [local, filePath] : null;
  },
  async detect(cwd: string) {
    const local = findLocalBinUpwards("stylua", cwd);
    if (!local && (await which("stylua")) === null) return false;
    const configs = ["stylua.toml", ".stylua.toml"];
    const found = await findUp(configs, cwd);
    return found.length > 0;
  },
};

export const ormoluFormatter: FormatterInfo = {
  name: "ormolu",
  command: ["ormolu", "--mode", "inplace", "$FILE"],
  extensions: [".hs", ".lhs"],
  async detect(_cwd: string) {
    return (await which("ormolu")) !== null;
  },
};

export const taploFormatter: FormatterInfo = {
  name: "taplo",
  command: ["taplo", "fmt", "$FILE"],
  extensions: [".toml"],
  async resolveCommand(filePath, _cwd) {
    const inPath = await which("taplo");
    if (inPath) return [inPath, "fmt", filePath];
    return resolveManagedSmartDefaultCommand("taplo", filePath, ["fmt"]);
  },
  async detect(_cwd: string) {
    if ((await which("taplo")) !== null) return true;
    const { getToolPath } = await import("./installer/index.ts");
    return Boolean(await getToolPath("taplo"));
  },
};

export const googleJavaFormatFormatter: FormatterInfo = {
  name: "google-java-format",
  command: ["google-java-format", "--replace", "$FILE"],
  extensions: [".java"],
  async detect(cwd: string) {
    if ((await which("google-java-format")) === null) return false;
    return hasGoogleJavaFormatConfig(cwd);
  },
};

export const cljfmtFormatter: FormatterInfo = {
  name: "cljfmt",
  command: ["cljfmt", "fix", "$FILE"],
  extensions: [".clj", ".cljc", ".cljs"],
  async detect(cwd: string) {
    if ((await which("cljfmt")) === null) return false;
    return hasCljfmtConfig(cwd);
  },
};

export const cmakeFormatFormatter: FormatterInfo = {
  name: "cmake-format",
  command: ["cmake-format", "-i", "$FILE"],
  extensions: [".cmake"],
  async detect(cwd: string) {
    if ((await which("cmake-format")) === null) return false;
    return hasCmakeFormatConfig(cwd);
  },
};

export const cueFormatter: FormatterInfo = {
  name: "cue",
  command: ["cue", "fmt", "$FILE"],
  extensions: [".cue"],
  async detect(_cwd: string) {
    return (await which("cue")) !== null;
  },
};

function psScriptAnalyzerCommand(filePath: string, settingsPath?: string): string {
  const quoted = filePath.replace(/'/g, "''");
  const settingsArg = settingsPath ? ` -Settings '${settingsPath.replace(/'/g, "''")}'` : "";
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = '${quoted}'`,
    "$content = Get-Content -Raw -LiteralPath $p",
    "if ([string]::IsNullOrWhiteSpace($content)) { exit 0 }",
    `$formatted = Invoke-Formatter -ScriptDefinition $content${settingsArg}`,
    "if ($null -eq $formatted) { throw 'Invoke-Formatter returned no output' }",
    "Set-Content -LiteralPath $p -Value $formatted",
  ].join("; ");
}

export const psscriptanalyzerFormatFormatter: FormatterInfo = {
  name: "psscriptanalyzer-format",
  command: ["pwsh", "-NoProfile", "-Command", psScriptAnalyzerCommand("$FILE")],
  extensions: [".ps1", ".psm1", ".psd1"],
  async resolveCommand(filePath, cwd) {
    const pwsh = (await which("pwsh")) ?? (await which("powershell"));
    if (!pwsh) return null;
    const settingsPath = findPSScriptAnalyzerConfigPath(cwd);
    return [pwsh, "-NoProfile", "-Command", psScriptAnalyzerCommand(filePath, settingsPath)];
  },
  async detect(_cwd: string) {
    const pwsh = (await which("pwsh")) ?? (await which("powershell"));
    if (!pwsh) return false;
    const result = await safeSpawnAsync(
      pwsh,
      [
        "-NoProfile",
        "-Command",
        "Get-Module -ListAvailable PSScriptAnalyzer | Select-Object -First 1 -ExpandProperty Name",
      ],
      { timeout: 5_000 },
    );
    return (result.stdout ?? "").includes("PSScriptAnalyzer");
  },
};

export const ALL_FORMATTERS: FormatterInfo[] = [
  biomeFormatter,
  prettierFormatter,
  oxfmtFormatter,
  ruffFormatter,
  blackFormatter,
  sqlfluffFormatter,
  gofmtFormatter,
  rustfmtFormatter,
  zigFormatter,
  dartFormatter,
  shfmtFormatter,
  nixfmtFormatter,
  mixFormatter,
  ocamlformatFormatter,
  clangFormatFormatter,
  ktlintFormatter,
  ktfmtFormatter,
  terraformFormatter,
  terragruntHclFormatter,
  phpCsFixerFormatter,
  csharpierFormatter,
  fantomasFormatter,
  swiftformatFormatter,
  styluaFormatter,
  ormoluFormatter,
  rubocopFormatter,
  standardrbFormatter,
  gleamFormatter,
  taploFormatter,
  googleJavaFormatFormatter,
  cljfmtFormatter,
  cmakeFormatFormatter,
  cueFormatter,
  psscriptanalyzerFormatFormatter,
];

const FILENAME_FORMATTER_BASENAMES = new Set(ALL_FORMATTERS.flatMap((f) => f.filenames ?? []));

const detectionCache = new BoundedLruCache<
  string,
  { signature: string; entries: Map<string, string[]> }
>(32);

const FORMATTER_CONFIG_FILES = [
  "package.json",
  "biome.json",
  "biome.jsonc",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
  "pyproject.toml",
  "ruff.toml",
  ".ruff.toml",
  "black.toml",
  ".black",
  "tox.ini",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  ".sqlfluff",
  ".rubocop.yml",
  ".rubocop.yaml",
  "Gemfile",
  ".clang-format",
  "_clang-format",
  ".php-cs-fixer.php",
  ".php-cs-fixer.dist.php",
  "stylua.toml",
  ".stylua.toml",
  ".ocamlformat",
  ".editorconfig",
  ".google-java-format",
  ".ktfmt",
  ".ktfmt.kts",
  "build.gradle.kts",
  "build.gradle",
  "settings.gradle.kts",
  "settings.gradle",
  ".cljfmt.edn",
  "cljfmt.edn",
  ".cljfmt",
  ".cmake-format",
  ".cmake-format.yaml",
  ".cmake-format.yml",
  ".cmake-format.json",
  ".cmake-format.py",
  "cmake-format.py",
  "cmake-format.yaml",
  "cmake-format.yml",
  "oxfmt.toml",
  ".oxfmtrc.json",
  "vite-plus.json",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "PSScriptAnalyzerSettings.psd1",
  "ScriptAnalyzerSettings.psd1",
  ".csharpierrc",
  ".csharpierrc.json",
  ".csharpierrc.yaml",
  ".csharpierrc.yml",
  ".ormolu",
  "taplo.toml",
  ".taplo.toml",
  ".terraform.lock.hcl",
  ".swiftformat",
  ".fantomasignore",
  ".formatter.exs",
];

async function formatterConfigSignature(cwd: string): Promise<string> {
  const paths = await findUp(FORMATTER_CONFIG_FILES, cwd);
  const parts = await Promise.all(
    paths
      .sort((a, b) => a.localeCompare(b))
      .map(async (filePath) => {
        try {
          const stat = await fs.stat(filePath);
          return `${filePath}:${stat.mtimeMs}:${stat.size}`;
        } catch {
          return `${filePath}:missing`;
        }
      }),
  );
  return parts.join("|");
}

export async function getFormattersForFile(
  filePath: string,
  cwd: string,
): Promise<FormatterInfo[]> {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  const normalizedCwd = normalizeMapKey(cwd);
  const cacheKey = FILENAME_FORMATTER_BASENAMES.has(base)
    ? `${normalizedCwd}:${ext}:${base}`
    : `${normalizedCwd}:${ext}`;

  const configSignature = await formatterConfigSignature(cwd);
  let cached = detectionCache.get(normalizedCwd);
  if (cached && cached.signature !== configSignature) {
    detectionCache.delete(normalizedCwd);
    cached = undefined;
    resetWhichLatches();
  }
  if (!cached) {
    cached = { signature: configSignature, entries: new Map() };
    detectionCache.set(normalizedCwd, cached);
  }

  if (cached.entries.has(cacheKey)) {
    const enabledNames = cached.entries.get(cacheKey);
    if (!enabledNames || enabledNames.length === 0) return [];
    return ALL_FORMATTERS.filter((f) => enabledNames.includes(f.name));
  }

  const matching = ALL_FORMATTERS.filter(
    (f) => f.extensions.includes(ext) || f.filenames?.includes(base),
  );
  const formatterPolicy = getFormatterPolicyForFile(filePath);
  const smartDefaultFormatterName = getSmartDefaultFormatterName(filePath);

  const candidateFormatters = formatterPolicy?.formatterNames?.length
    ? matching.filter((f) => formatterPolicy.formatterNames.includes(f.name))
    : matching;

  let selected: FormatterInfo | undefined;
  const candidateOutcomes: CandidateOutcome[] = [];
  if (formatterPolicy) {
    const explicitlyConfigured = candidateFormatters.filter((formatter) =>
      hasExplicitFormatterConfig(formatter.name, cwd, ext),
    );
    if (explicitlyConfigured.length > 0) {
      selected = formatterPolicy.defaultFormatter
        ? (explicitlyConfigured.find((f) => f.name === formatterPolicy.defaultFormatter) ??
          explicitlyConfigured[0])
        : explicitlyConfigured[0];
    } else if (smartDefaultFormatterName) {
      const smartDefaultFormatter = candidateFormatters.find(
        (f) => f.name === smartDefaultFormatterName,
      );
      if (smartDefaultFormatter) {
        const autoInstallToolId = getAutoInstallToolIdForFormatter(smartDefaultFormatter.name);
        if (autoInstallToolId) {
          selected = smartDefaultFormatter;
        } else {
          const { detected, error, outcome } = await detectCandidate(smartDefaultFormatter, cwd);
          candidateOutcomes.push(outcome);
          if (error !== undefined) throw error;
          if (detected) selected = smartDefaultFormatter;
        }
      }
    }
  } else {
    for (const formatter of candidateFormatters) {
      const { detected, error, outcome } = await detectCandidate(formatter, cwd);
      candidateOutcomes.push(outcome);
      if (error !== undefined) {
        logExtension({
          subsystem: "format",
          message: `Detection failed for ${formatter.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          metadata: { formatter: formatter.name, cwd },
        });
        continue;
      }
      if (detected) {
        selected = formatter;
        break;
      }
    }
  }

  const enabled = selected ? [selected] : [];
  const stalledCandidateCommands = [
    ...new Set(candidateOutcomes.flatMap((outcome) => outcome.stalledCommands)),
  ];
  const poisonedByTransientProbe = enabled.length === 0 && stalledCandidateCommands.length > 0;

  const winnerIndex = selected
    ? candidateOutcomes.findIndex((outcome) => outcome.name === selected.name)
    : -1;
  const unreachablePreferred = candidateOutcomes
    .slice(0, winnerIndex === -1 ? 0 : winnerIndex)
    .filter((outcome) => outcome.verdict === "unreachable")
    .map((outcome) => outcome.name);
  const degradedSelection = unreachablePreferred.length > 0;

  let selectionReason: string;
  if (poisonedByTransientProbe) {
    selectionReason = "probe-timeout";
  } else if (degradedSelection) {
    selectionReason = "preferred-unreachable";
  } else if (!selected) {
    selectionReason = "none";
  } else if (!formatterPolicy) {
    selectionReason = "detect";
  } else {
    selectionReason = candidateFormatters.some((f) => hasExplicitFormatterConfig(f.name, cwd, ext))
      ? "explicit-config"
      : "smart-default";
  }
  const provisional = poisonedByTransientProbe || degradedSelection;
  logLatency({
    type: "phase",
    phase: "formatter_selected",
    filePath: filePath,
    durationMs: 0,
    metadata: {
      formatter: selected?.name ?? null,
      reason: selectionReason,
      cwd,
      ...(provisional && {
        cached: false,
        stalledProbes: stalledCandidateCommands,
      }),
      ...(degradedSelection && { unreachablePreferred }),
    },
  });

  if (provisional) return enabled;

  const enabledNames = enabled.map((f) => f.name);
  cached.entries.set(cacheKey, enabledNames);
  return enabled;
}

export function clearFormatterCache(): void {
  detectionCache.clear();
  resetWhichLatches();
}

export function clearFormatterRuntimeState(): void {
  detectionCache.clear();
  resetWhichLatches();
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const BOX_DRAWING_GLOBAL = /[\u2500-\u257F]/g;
const HAS_BOX_DRAWING = /[\u2500-\u257F]/;

export function firstDiagnosticLine(text: string | undefined): string | undefined {
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.replace(ANSI_ESCAPE, "").trimEnd();
    const stripped = line.replace(BOX_DRAWING_GLOBAL, "").trim();
    if (!stripped) continue;
    if (HAS_BOX_DRAWING.test(line) && stripped.length <= 24) continue;
    return stripped.slice(0, 300);
  }
  return undefined;
}

async function resolveFormatterCommand(
  formatter: FormatterInfo,
  absolutePath: string,
  cwd: string,
): Promise<string[] | typeof SKIP_FORMATTING> {
  const resolved = formatter.resolveCommand
    ? await formatter.resolveCommand(absolutePath, cwd)
    : null;
  if (resolved === SKIP_FORMATTING) return SKIP_FORMATTING;
  if (resolved !== null) return resolved;
  const fallback = formatter.command.map((c) => c.replace("$FILE", absolutePath));
  if (fallback[0] === "npx" && !assertInstallAllowed(`formatter npx fallback: ${formatter.name}`)) {
    return SKIP_FORMATTING;
  }
  return fallback;
}

export async function formatFile(
  filePath: string,
  formatter: FormatterInfo,
): Promise<FormatterResult> {
  try {
    const absolutePath = path.resolve(filePath);
    const cwd = path.dirname(absolutePath);
    const contentBefore = await fs.readFile(absolutePath, "utf-8");

    const cmd = await resolveFormatterCommand(formatter, absolutePath, cwd);
    if (cmd === SKIP_FORMATTING) {
      return { success: true, changed: false };
    }
    const result = await safeSpawnAsync(cmd[0], cmd.slice(1), {
      timeout: 15000,
      cwd,
    });

    const lenientOk =
      formatter.lenientExitCode !== undefined &&
      result.status !== null &&
      (formatter.lenientStatuses ?? []).includes(result.status);
    if (isIgnoredFileExit(formatter.ignoredFileExit, result)) {
      return { success: true, changed: false };
    }
    if (result.error || (result.status !== 0 && !lenientOk)) {
      return {
        success: false,
        changed: false,
        error:
          result.error?.message ||
          firstDiagnosticLine(result.stderr) ||
          firstDiagnosticLine(result.stdout) ||
          `${formatter.name} exited with status ${result.status}`,
      };
    }

    const contentAfter = await fs.readFile(absolutePath, "utf-8");
    const changed = contentBefore !== contentAfter;

    return {
      success: true,
      changed,
    };
  } catch (err) {
    return {
      success: false,
      changed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function listAllFormatters(): string[] {
  return ALL_FORMATTERS.map((f) => f.name);
}
