/**
 * LSP Configuration for choco-pi-lsp
 *
 * Allows users to define custom LSP servers and override initialization options
 * for built-in servers via configuration.
 *
 * Config file: .choco-pi-lsp/lsp.json (or .choco-pi-lsp.json, pi-lsp.json)
 *
 * Example — custom server:
 * {
 *   "servers": {
 *     "my-server": {
 *       "name": "My Custom LSP",
 *       "extensions": [".myext"],
 *       "command": "my-lsp-server",
 *       "args": ["--stdio"],
 *       "rootMarkers": ["package.json"]
 *     }
 *   }
 * }
 *
 * Example — override initializationOptions for a built-in server:
 * {
 *   "serverOverrides": {
 *     "rust": {
 *       "initializationOptions": {
 *         "check": { "command": "clippy", "allTargets": true },
 *         "cargo": { "features": "all", "targetDir": true }
 *       }
 *     },
 *     "nix": {
 *       "initializationOptions": {
 *         "nixpkgs": { "expr": "import <nixpkgs> {}" },
 *         "options": {
 *           "home_manager": { "expr": "(builtins.getFlake (toString ./.)).homeConfigurations.me.options" }
 *         }
 *       }
 *     }
 *   }
 * }
 *
 * The `initializationOptions` object is deep-merged onto the server's built-in
 * defaults, so you only need to specify the keys you want to change or add.
 * User-supplied values win on conflicts at every level of nesting.
 *
 * Server IDs match the `id` field of each built-in server definition in
 * clients/lsp/server.ts (e.g. "rust", "nix", "bash", "python", "go", "ts").
 */

import { logExtension } from "../extension-log.ts";
import { notifyUserDegradation } from "../user-notify.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { BoundedLruCache } from "../bounded-cache.ts";
import { getGlobalPiLensDir } from "../file-utils.ts";
import { launchLSP } from "./launch.ts";
import { createRootDetector, LSP_SERVERS, type LSPServerInfo } from "./server.ts";

// --- Types ---

export interface CustomServerConfig {
  name: string;
  extensions: string[];
  command: string;
  args?: string[];
  rootMarkers?: string[];
  env?: Record<string, string>;
}

/**
 * Per-server initializationOptions overrides for built-in servers.
 * Keys are built-in server IDs (e.g. "rust", "nix", "bash", "python", "go").
 */
export interface InitializationOptions {
  [key: string]: InitializationValue;
}

export type InitializationValue =
  | string
  | number
  | boolean
  | null
  | InitializationOptions
  | InitializationValue[];

export interface ServerInitOverride {
  /**
   * Deep-merged onto the server's built-in initializationOptions defaults.
   * User values win on key conflicts at every nesting level.
   */
  initializationOptions?: InitializationOptions;
}

export interface LSPConfig {
  servers?: Record<string, CustomServerConfig>;
  /**
   * Override initializationOptions for built-in servers.
   * Keys are built-in server IDs (e.g. "rust", "nix", "bash", "python").
   * Each entry's `initializationOptions` is deep-merged onto the server's
   * built-in defaults so you only need to specify the keys you want to change.
   */
  serverOverrides?: Record<string, ServerInitOverride>;
  disabledServers?: string[];
  /** Files to open at session start to seed lazy LSP indexing (e.g., clangd). */
  warmFiles?: string[];
}

interface RegisteredLSPConfig {
  customServers: LSPServerInfo[];
  disabledServerIds: Set<string>;
  serverOverrides: Map<string, ServerInitOverride>;
}

// --- Config Loading ---

const JsonObjectSchema = Type.Object({}, { additionalProperties: true });
const CustomServerConfigSchema = Type.Object({
  name: Type.String(),
  extensions: Type.Array(Type.String()),
  command: Type.String(),
  args: Type.Optional(Type.Array(Type.String())),
  rootMarkers: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
});
const ServerInitOverrideSchema = Type.Object({
  initializationOptions: Type.Optional(JsonObjectSchema),
});
function isJsonObject(value: InitializationValue | undefined): value is InitializationOptions {
  return Value.Check(JsonObjectSchema, value);
}

function stringArray(value: InitializationValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => Value.Check(Type.String(), entry))
    : [];
}

function sanitizeLspConfig(value: InitializationValue): LSPConfig | undefined {
  if (!isJsonObject(value)) return undefined;
  const config: LSPConfig = {};

  if (isJsonObject(value.servers)) {
    const servers: Record<string, CustomServerConfig> = {};
    for (const [id, server] of Object.entries(value.servers)) {
      if (Value.Check(CustomServerConfigSchema, server)) servers[id] = server;
    }
    config.servers = servers;
  }

  if (isJsonObject(value.serverOverrides)) {
    const overrides: Record<string, ServerInitOverride> = {};
    for (const [id, entry] of Object.entries(value.serverOverrides)) {
      if (!Value.Check(ServerInitOverrideSchema, entry)) continue;
      // SAFETY: The value came from parsed JSON and JsonObjectSchema rejected null and arrays.
      overrides[id] = entry as ServerInitOverride;
    }
    config.serverOverrides = overrides;
  }

  if (Object.hasOwn(value, "disabledServers")) {
    config.disabledServers = stringArray(value.disabledServers);
  }
  if (Object.hasOwn(value, "warmFiles")) config.warmFiles = stringArray(value.warmFiles);
  return config;
}

const CONFIG_PATHS = [".choco-pi-lsp/lsp.json", ".choco-pi-lsp.json", "pi-lsp.json"];

function warnInvalidLSPConfig<T>(configPath: string, error: T): void {
  const reason = error instanceof Error ? error.message : String(error);
  const message = `ignoring invalid LSP config ${configPath}: ${reason}`;
  logExtension({
    subsystem: "lsp-config",
    level: "warn",
    message,
    metadata: { configPath, reason },
  });
  // HUMAN-audience too: the user's own lsp.json is being ignored (#1333).
  notifyUserDegradation(`choco-pi-lsp: ${message}`);
}

async function readLSPConfig(configPath: string): Promise<LSPConfig | undefined> {
  let content: string;
  try {
    content = await fs.readFile(configPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    warnInvalidLSPConfig(configPath, error);
    return undefined;
  }

  try {
    const parsed = sanitizeLspConfig(JSON.parse(content));
    if (!parsed) throw new TypeError("expected a valid LSP configuration object");
    return parsed;
  } catch (error) {
    warnInvalidLSPConfig(configPath, error);
    return undefined;
  }
}

function mergeLSPConfigs(globalConfig: LSPConfig, projectConfig: LSPConfig): LSPConfig {
  const merged: LSPConfig = { ...globalConfig, ...projectConfig };

  const servers = { ...globalConfig.servers, ...projectConfig.servers };
  if (Object.keys(servers).length > 0) merged.servers = servers;

  const serverOverrides = {
    ...globalConfig.serverOverrides,
    ...projectConfig.serverOverrides,
  };
  if (Object.keys(serverOverrides).length > 0) {
    merged.serverOverrides = serverOverrides;
  }

  if (!Object.hasOwn(projectConfig, "disabledServers")) {
    merged.disabledServers = globalConfig.disabledServers;
  }
  if (!Object.hasOwn(projectConfig, "warmFiles")) {
    merged.warmFiles = globalConfig.warmFiles;
  }

  return merged;
}

/**
 * Load LSP configuration, with project settings overriding machine-global
 * settings from ~/.choco-pi-lsp/lsp.json.
 */
export async function loadLSPConfig(cwd: string): Promise<LSPConfig> {
  let projectConfig: LSPConfig | undefined;
  let dir = path.resolve(cwd);
  while (true) {
    for (const configPath of CONFIG_PATHS) {
      const fullPath = path.join(dir, configPath);
      const config = await readLSPConfig(fullPath);
      if (config) {
        projectConfig = config;
        break;
      }
    }
    if (projectConfig) break;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const globalConfig = (await readLSPConfig(path.join(getGlobalPiLensDir(), "lsp.json"))) ?? {};
  return mergeLSPConfigs(globalConfig, projectConfig ?? {});
}

// --- Custom Server Factory ---

/**
 * Create LSPServerInfo from user configuration
 */
export function createCustomServer(config: CustomServerConfig, id: string): LSPServerInfo {
  return {
    id,
    name: config.name,
    extensions: config.extensions,
    root: config.rootMarkers ? createRootDetector(config.rootMarkers) : async () => process.cwd(),
    async spawn(root) {
      const proc = await launchLSP(config.command, config.args ?? ["--stdio"], {
        cwd: root,
        env: config.env ? { ...process.env, ...config.env } : process.env,
      });
      return { process: proc };
    },
  };
}

// --- Registry Management ---

const EMPTY_CONFIG: RegisteredLSPConfig = {
  customServers: [],
  disabledServerIds: new Set(),
  serverOverrides: new Map(),
};

const workspaceConfigs = new BoundedLruCache<string, RegisteredLSPConfig>(32);
/** In-flight config initialization promises to prevent duplicate concurrent loads */
const configInFlight = new Map<string, Promise<void>>();

function normalizeWorkspacePath(cwd: string): string {
  return path.resolve(cwd);
}

function isSameOrChildPath(filePath: string, candidateRoot: string): boolean {
  if (filePath === candidateRoot) return true;
  return filePath.startsWith(`${candidateRoot}${path.sep}`);
}

function getConfigForFile(filePath: string): RegisteredLSPConfig {
  const resolvedFilePath = path.resolve(filePath);
  let bestMatch: { root: string; config: RegisteredLSPConfig } | undefined;

  for (const [root, config] of workspaceConfigs) {
    if (!isSameOrChildPath(resolvedFilePath, root)) continue;
    if (!bestMatch || root.length > bestMatch.root.length) {
      bestMatch = { root, config };
    }
  }

  return bestMatch?.config ?? EMPTY_CONFIG;
}

/**
 * Initialize LSP configuration (call at session start)
 * Deduplicates concurrent calls for the same workspace.
 */
export async function initLSPConfig(cwd: string): Promise<void> {
  const normalizedCwd = normalizeWorkspacePath(cwd);

  const existing = configInFlight.get(normalizedCwd);
  if (existing) return existing;

  const promise = (async () => {
    const config = await loadLSPConfig(cwd);
    const customServers: LSPServerInfo[] = [];
    const disabledServerIds = new Set(config.disabledServers ?? []);

    if (config.servers) {
      for (const [id, serverConfig] of Object.entries(config.servers)) {
        try {
          const server = createCustomServer(serverConfig, id);
          customServers.push(server);
        } catch {
          // choco-pi-lsp-ignore: missing-error-propagation — per-server registration, skip bad entries
        }
      }
    }

    const serverOverrides = new Map<string, ServerInitOverride>();
    if (config.serverOverrides) {
      for (const [id, entry] of Object.entries(config.serverOverrides)) {
        if (entry.initializationOptions !== undefined) {
          serverOverrides.set(id, entry);
        }
      }
    }

    workspaceConfigs.set(normalizedCwd, {
      customServers,
      disabledServerIds,
      serverOverrides,
    });
  })();

  configInFlight.set(normalizedCwd, promise);
  try {
    await promise;
  } finally {
    configInFlight.delete(normalizedCwd);
  }
}

/**
 * Get all available servers (built-in + custom, minus disabled)
 */
export function getAllServers(filePath?: string): LSPServerInfo[] {
  const config = filePath ? getConfigForFile(filePath) : EMPTY_CONFIG;
  const all = [...LSP_SERVERS, ...config.customServers];
  return all.filter((s) => !config.disabledServerIds.has(s.id));
}

/**
 * Check if a server is disabled
 */
export function isServerDisabled(serverId: string, filePath?: string): boolean {
  const config = filePath ? getConfigForFile(filePath) : EMPTY_CONFIG;
  return config.disabledServerIds.has(serverId);
}

// --- Override getServersForFile to include custom servers

export function getServersForFileWithConfig(filePath: string): LSPServerInfo[] {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  return getAllServers(filePath).filter((server) => {
    const extensions = server.extensions.map((value) => value.toLowerCase());
    const extensionMatch = extensions.includes(ext) || extensions.includes(base);
    if (!extensionMatch) return false;
    // #636: a server's extension match can be intentionally broader than what
    // it can usefully act on (zizmor attaches to "yaml" but only ever reports
    // on GitHub Actions workflow/action/dependabot paths). `pathFilter`, when
    // present, is an ADDITIONAL narrowing gate — never a widening one.
    return server.pathFilter ? server.pathFilter(filePath) : true;
  });
}

/**
 * The primary language server for a file (e.g. "typescript"), as opposed to a
 * cross-cutting auxiliary scanner attached via clientScope "all"/
 * "with-auxiliary" (ast-grep, opengrep, zizmor, typos, marksman, ...). `role`
 * is only ever set to "auxiliary" on those auxiliary entries (see
 * clients/lsp/server.ts) — undefined means a real language server. Used to
 * split a file's diagnostics into "primary confirmation" vs "auxiliary
 * findings" so a page of ast-grep/opengrep/marksman noise never buries
 * whether the actual type checker/compiler confirmed the file clean.
 *
 * #646: extracted from `tools/lsp-diagnostics.ts` (where it originated) so
 * `tools/diagnostics-report.ts`'s `mode=full` sweep can share the exact same
 * primary/auxiliary classification instead of hand-copying it — both tools
 * now report the same primary-vs-auxiliary split for the same file.
 */
export function primaryServerId(filePath: string): string | undefined {
  return getServersForFileWithConfig(filePath).find((s) => s.role !== "auxiliary")?.id;
}

/**
 * Look up an initializationOptions override for a built-in server.
 * Returns undefined when no config was loaded or no override was specified
 * for this server ID.
 *
 * @param serverId  Built-in server id (e.g. "rust", "nix", "bash")
 * @param filePath  Any file path within the project (used to locate the
 *                  workspace config that was loaded for this directory tree)
 */
export function getServerInitOverride(
  serverId: string,
  filePath: string,
): ServerInitOverride | undefined {
  return getConfigForFile(filePath).serverOverrides.get(serverId);
}

export function resetLSPConfigStateForTests(): void {
  workspaceConfigs.clear();
}

// Re-export with config support
export { getAllServers as getServersForFile };
