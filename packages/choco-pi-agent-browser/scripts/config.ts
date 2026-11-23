#!/usr/bin/env node
/**
 * Purpose: Manage choco-pi-agent-browser package config under Pi-scoped config paths.
 * Responsibilities: Thin CLI argument parsing and config-file mutation around the shared config policy; preserve safe permissions and avoid echoing secrets.
 * Scope: Maintainer/user setup CLI only; canonical config validation, merge, provider descriptors, and status projection live in extensions/agent-browser/lib/config-policy.ts.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  AGENT_BROWSER_CONFIG_ENV,
  BRAVE_API_KEY_ENV,
  DEFAULT_WEB_SEARCH_PROVIDER,
  EXA_API_KEY_ENV,
  WEB_SEARCH_PROVIDERS,
  formatBrowserExecutableStatus,
  formatBrowserProfileStatus,
  getAgentBrowserConfigPaths,
  getCredentialSourceSummary,
  getWebSearchProviderConfigKey,
  getWebSearchProviderEnvVar,
  getWebSearchProviderLabel,
  loadAgentBrowserConfig,
  type AgentBrowserConfigState,
  type BrowserDefaultProfilePolicy,
  type WebSearchProvider,
} from "../extensions/agent-browser/lib/config.ts";
import { pathExists } from "../extensions/agent-browser/lib/fs-utils.ts";
import {
  hasRuntimeType,
  isRecord,
  type RuntimeRecord,
  type RuntimeValue,
} from "../extensions/agent-browser/lib/parsing.ts";

/** A config file's JSON object; unknown keys are preserved on rewrite. */
type ConfigDocument = RuntimeRecord<RuntimeValue>;
type ConfigWriteScope = "global" | "project";
type WebSearchProviderSelection = WebSearchProvider | "all";

function copyRecord(record: ConfigDocument): ConfigDocument {
  return { ...record };
}

interface CliFlags {
  global: boolean;
  help: boolean;
  policy?: string;
  project: boolean;
  provider?: string;
  stdin: boolean;
}

interface ParsedArgs {
  flags: CliFlags;
  positional: string[];
}

interface ConfigWriteTarget {
  path: string;
  scope: ConfigWriteScope;
}

interface ConfigFileStatus {
  exists: boolean;
  path: string;
  scope: string;
}

const DEFAULT_CONFIG_VERSION = 1;
const BROWSER_DEFAULT_PROFILE_POLICIES: readonly BrowserDefaultProfilePolicy[] = [
  "explicit-only",
  "authenticated-only",
  "always",
];
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function usage(): string {
  return `choco-pi-agent-browser config helper

Usage (from packages/choco-pi-agent-browser):
  node scripts/config.ts paths
  node scripts/config.ts show
  node scripts/config.ts web-search status
  node scripts/config.ts web-search set-key --stdin --provider <exa|brave> [--global|--project]
  node scripts/config.ts web-search set-env <ENV_VAR> [--provider brave|exa] [--global|--project]
  node scripts/config.ts web-search set-command <command> --provider <exa|brave> [--global|--project]
  node scripts/config.ts web-search clear --provider <exa|brave|all> [--global|--project]
  node scripts/config.ts web-search prefer <exa|brave|auto> [--global|--project]
  node scripts/config.ts web-search enable [--global|--project]
  node scripts/config.ts web-search disable [--global|--project]
  node scripts/config.ts browser profile status
  node scripts/config.ts browser profile set <name|path> [--policy explicit-only|authenticated-only|always] [--global|--project]
  node scripts/config.ts browser profile clear [--global|--project]
  node scripts/config.ts browser executable status
  node scripts/config.ts browser executable set <path> [--global|--project]
  node scripts/config.ts browser executable clear [--global|--project]

Notes:
  Global config:  ~/.pi/config/pi-agent-browser-native/config.json
  Project config: .pi/config/pi-agent-browser-native/config.json
  Override:       ${AGENT_BROWSER_CONFIG_ENV}=/path/to/config.json
  Loaded config may use plaintext, environment interpolation, or !command credential sources; displayed status redacts resolved keys.
  Use --provider for set-key, set-command, and clear; set-env infers exa/brave from ${EXA_API_KEY_ENV} or ${BRAVE_API_KEY_ENV}.
`;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: CliFlags = { global: false, help: false, project: false, stdin: false };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] ?? "";
    index += 1;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--global") flags.global = true;
    else if (arg === "--project") flags.project = true;
    else if (arg === "--stdin") flags.stdin = true;
    else if (arg === "--help") flags.help = true;
    else if (arg === "--policy" || arg === "--provider") {
      const value = argv[index];
      if (!value || value.startsWith("--")) throw new UsageError(`${arg} requires a value.`);
      if (arg === "--policy") flags.policy = value;
      else flags.provider = value;
      index += 1;
    } else throw new UsageError(`Unknown option: ${arg}`);
  }
  if (flags.global && flags.project) throw new UsageError("Use only one of --global or --project.");
  return { flags, positional };
}

function isMissingFileError(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

async function readConfig(path: string): Promise<ConfigDocument> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && isMissingFileError(error)) {
      return { version: DEFAULT_CONFIG_VERSION };
    }
    throw error;
  }
  const parsed: RuntimeValue = JSON.parse(raw);
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return { version: DEFAULT_CONFIG_VERSION, ...copyRecord(parsed) };
}

async function writeConfig(path: string, config: ConfigDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(dirname(path), 0o700);
    await chmod(path, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support POSIX modes.
  }
}

/** Copy one top-level config section; a missing or non-object section starts empty. */
function copySection(config: ConfigDocument, key: string): ConfigDocument {
  const section = config[key];
  return isRecord(section) ? copyRecord(section) : {};
}

/** Remove one field from an existing object section, leaving other sections untouched. */
function deleteSectionField(config: ConfigDocument, sectionKey: string, field: string): void {
  const section = config[sectionKey];
  if (isRecord(section)) delete section[field];
}

function selectWritePath(flags: CliFlags): ConfigWriteTarget {
  const paths = getAgentBrowserConfigPaths();
  if (flags.project) return { path: paths.project, scope: "project" };
  return { path: paths.global, scope: "global" };
}

function findWebSearchProvider(value: string): WebSearchProvider | undefined {
  return WEB_SEARCH_PROVIDERS.find((provider) => provider === value);
}

function inferWebSearchProviderFromEnvName(envName: string): WebSearchProvider | undefined {
  return WEB_SEARCH_PROVIDERS.find((provider) => envName === getWebSearchProviderEnvVar(provider));
}

function requireWebSearchProvider(flags: CliFlags, envName?: string): WebSearchProvider {
  if (flags.provider) {
    const provider = findWebSearchProvider(flags.provider);
    if (provider) return provider;
    throw new UsageError(`--provider must be one of ${WEB_SEARCH_PROVIDERS.join(", ")}.`);
  }
  const inferred = envName ? inferWebSearchProviderFromEnvName(envName) : undefined;
  if (inferred) return inferred;
  throw new UsageError("--provider is required and must be exa or brave.");
}

function requireWebSearchProviderSelection(flags: CliFlags): WebSearchProviderSelection {
  if (flags.provider) {
    if (flags.provider === "all") return "all";
    const provider = findWebSearchProvider(flags.provider);
    if (provider) return provider;
    throw new UsageError(`--provider must be one of ${WEB_SEARCH_PROVIDERS.join(", ")}, all.`);
  }
  throw new UsageError("--provider is required and must be exa, brave, or all.");
}

function setWebSearchCredential(
  config: ConfigDocument,
  provider: WebSearchProvider,
  value: string,
): void {
  config.webSearch = {
    ...copySection(config, "webSearch"),
    [getWebSearchProviderConfigKey(provider)]: value,
  };
}

function clearWebSearchCredential(config: ConfigDocument, provider: WebSearchProvider): void {
  deleteSectionField(config, "webSearch", getWebSearchProviderConfigKey(provider));
}

function printPaths(): void {
  const paths = getAgentBrowserConfigPaths();
  console.log(`Global: ${paths.global}`);
  console.log(`Project: ${paths.project}`);
  console.log(`Override: ${paths.override ?? `${AGENT_BROWSER_CONFIG_ENV} not set`}`);
}

async function summarizeConfigFiles(state: AgentBrowserConfigState): Promise<ConfigFileStatus[]> {
  const files: ConfigFileStatus[] = [
    { exists: false, path: state.paths.global, scope: "global" },
    { exists: false, path: state.paths.project, scope: "project" },
  ];
  if (state.paths.override) {
    files.push({ exists: false, path: state.paths.override, scope: "override" });
  }
  return Promise.all(files.map(async (file) => ({ ...file, exists: await pathExists(file.path) })));
}

async function printStatus(): Promise<void> {
  const state = await loadAgentBrowserConfig({ cwd: process.cwd(), env: process.env });
  const files = await summarizeConfigFiles(state);
  printPaths();
  console.log("");
  console.log("Config files:");
  for (const file of files) {
    console.log(`  ${file.scope}: ${file.path} ${file.exists ? "[exists]" : "[missing]"}`);
  }
  console.log("");
  console.log("Effective config:");
  console.log(`  webSearch.enabled: ${state.webSearchEnabled ? "true" : "false"}`);
  console.log(
    `  webSearch.preferredProvider: ${state.config.webSearch?.preferredProvider ?? `auto (default ${DEFAULT_WEB_SEARCH_PROVIDER})`}`,
  );
  for (const provider of WEB_SEARCH_PROVIDERS) {
    const field = getWebSearchProviderConfigKey(provider);
    console.log(
      `  webSearch.${field}: ${getCredentialSourceSummary(state.webSearchCredentialSources[provider], provider)}`,
    );
  }
  console.log(`  browser.defaultProfile: ${formatBrowserProfileStatus(state)}`);
  console.log(`  browser.executablePath: ${formatBrowserExecutableStatus(state)}`);
  if (state.layers.length === 0) console.log("  layers: none");
  if (state.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of state.warnings) console.log(`  - ${warning}`);
  }
  if (state.errors.length > 0) {
    console.log("");
    console.log("Validation errors:");
    for (const error of state.errors) console.log(`  - ${error}`);
  }
}

async function readSecretFromStdin(useStdin: boolean): Promise<string> {
  if (!useStdin)
    throw new UsageError(
      "set-key requires --stdin so the key is not passed through argv or an echoed prompt.",
    );
  let input = "";
  for await (const chunk of process.stdin) {
    input += hasRuntimeType(chunk, "string") ? chunk : String(chunk);
  }
  const value = input.trim();
  if (!value) throw new UsageError("No key was provided on stdin.");
  return value;
}

async function mutateConfig(path: string, mutate: (config: ConfigDocument) => void): Promise<void> {
  const config = await readConfig(path);
  mutate(config);
  await writeConfig(path, config);
}

async function handleWebSearch(args: readonly string[], flags: CliFlags): Promise<void> {
  const action = args[0];
  if (action === "status") {
    await printStatus();
    return;
  }
  if (action === "set-key") {
    const provider = requireWebSearchProvider(flags);
    const key = await readSecretFromStdin(flags.stdin);
    const { path, scope } = selectWritePath(flags);
    await mutateConfig(path, (config) => {
      setWebSearchCredential(config, provider, key);
    });
    console.log(`Saved ${getWebSearchProviderLabel(provider)} key to ${scope} config: ${path}`);
    return;
  }
  if (action === "set-env") {
    const envName = args[1];
    if (!envName || !ENV_NAME_PATTERN.test(envName))
      throw new UsageError("set-env requires a valid environment variable name.");
    const provider = requireWebSearchProvider(flags, envName);
    const envReference = `$${envName}`;
    const { path, scope } = selectWritePath(flags);
    await mutateConfig(path, (config) => {
      setWebSearchCredential(config, provider, envReference);
    });
    console.log(`Saved ${getWebSearchProviderLabel(provider)} ${scope} env reference to: ${path}`);
    return;
  }
  if (action === "set-command") {
    const provider = requireWebSearchProvider(flags);
    const command = args.slice(1).join(" ").trim();
    if (!command) throw new UsageError("set-command requires a command string.");
    const { path, scope } = selectWritePath(flags);
    await mutateConfig(path, (config) => {
      setWebSearchCredential(config, provider, `!${command}`);
    });
    console.log(`Saved ${getWebSearchProviderLabel(provider)} ${scope} command source to: ${path}`);
    return;
  }
  if (action === "clear") {
    const selection = requireWebSearchProviderSelection(flags);
    const { path, scope } = selectWritePath(flags);
    await mutateConfig(path, (config) => {
      if (selection === "all") {
        for (const provider of WEB_SEARCH_PROVIDERS) clearWebSearchCredential(config, provider);
      } else {
        clearWebSearchCredential(config, selection);
      }
    });
    console.log(
      `Cleared ${selection === "all" ? "all web-search" : getWebSearchProviderLabel(selection)} credential source in ${scope} config: ${path}`,
    );
    return;
  }
  if (action === "prefer") {
    const requested = args[1] ?? "";
    const provider = findWebSearchProvider(requested);
    if (!provider && requested !== "auto")
      throw new UsageError("prefer requires exa, brave, or auto.");
    const { path, scope } = selectWritePath(flags);
    await mutateConfig(path, (config) => {
      const webSearch = copySection(config, "webSearch");
      if (provider) webSearch.preferredProvider = provider;
      else delete webSearch.preferredProvider;
      config.webSearch = webSearch;
    });
    console.log(
      `${provider ? "Saved" : "Cleared"} web-search preferred provider in ${scope} config: ${path}`,
    );
    return;
  }
  if (action === "enable" || action === "disable") {
    const { path, scope } = selectWritePath(flags);
    await mutateConfig(path, (config) => {
      config.webSearch = { ...copySection(config, "webSearch"), enabled: action === "enable" };
    });
    console.log(
      `${action === "enable" ? "Enabled" : "Disabled"} agent_browser_web_search in ${scope} config: ${path}`,
    );
    return;
  }
  throw new UsageError(`Unsupported web-search action: ${action ?? ""}`);
}

function parseBrowserDefaultProfilePolicy(value: string): BrowserDefaultProfilePolicy {
  const policy = BROWSER_DEFAULT_PROFILE_POLICIES.find((candidate) => candidate === value);
  if (!policy) throw new UsageError("Invalid --policy value.");
  return policy;
}

async function handleBrowserProfile(args: readonly string[], flags: CliFlags): Promise<void> {
  const action = args[1];
  if (action === "status") {
    await printStatus();
    return;
  }
  if (action === "set") {
    const name = args.slice(2).join(" ").trim();
    if (!name)
      throw new UsageError(
        "browser profile set requires a profile name or profile directory path.",
      );
    const policy = parseBrowserDefaultProfilePolicy(flags.policy ?? "authenticated-only");
    const { path, scope } = selectWritePath(flags);
    await mutateConfig(path, (config) => {
      config.browser = { ...copySection(config, "browser"), defaultProfile: { name, policy } };
    });
    console.log(`Saved browser default profile in ${scope} config: ${path}`);
    return;
  }
  if (action === "clear") {
    const { path, scope } = selectWritePath(flags);
    await mutateConfig(path, (config) => {
      deleteSectionField(config, "browser", "defaultProfile");
    });
    console.log(`Cleared browser default profile in ${scope} config: ${path}`);
    return;
  }
  throw new UsageError(`Unsupported browser profile action: ${action ?? ""}`);
}

async function handleBrowserExecutable(args: readonly string[], flags: CliFlags): Promise<void> {
  const action = args[1];
  if (action === "status") {
    await printStatus();
    return;
  }
  if (action === "set") {
    const executablePath = args.slice(2).join(" ").trim();
    if (!executablePath)
      throw new UsageError("browser executable set requires a browser executable path.");
    const { path, scope } = selectWritePath(flags);
    await mutateConfig(path, (config) => {
      config.browser = { ...copySection(config, "browser"), executablePath };
    });
    console.log(`Saved browser executable path in ${scope} config: ${path}`);
    return;
  }
  if (action === "clear") {
    const { path, scope } = selectWritePath(flags);
    await mutateConfig(path, (config) => {
      deleteSectionField(config, "browser", "executablePath");
    });
    console.log(`Cleared browser executable path in ${scope} config: ${path}`);
    return;
  }
  throw new UsageError(`Unsupported browser executable action: ${action ?? ""}`);
}

async function handleBrowser(args: readonly string[], flags: CliFlags): Promise<void> {
  const target = args[0];
  if (target === "profile") return handleBrowserProfile(args, flags);
  if (target === "executable") return handleBrowserExecutable(args, flags);
  throw new UsageError(`Unsupported browser action: ${target ?? ""}`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  if (flags.help || command === undefined) {
    console.log(usage());
    return 0;
  }
  if (command === "paths") {
    printPaths();
    return 0;
  }
  if (command === "show") {
    await printStatus();
    return 0;
  }
  if (command === "web-search") {
    await handleWebSearch(positional.slice(1), flags);
    return 0;
  }
  if (command === "browser") {
    await handleBrowser(positional.slice(1), flags);
    return 0;
  }
  throw new UsageError(`Unknown command: ${command}`);
}

function isEntrypoint(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;
}

if (isEntrypoint()) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: Error) => {
      if (error instanceof UsageError) {
        console.error(error.message);
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
