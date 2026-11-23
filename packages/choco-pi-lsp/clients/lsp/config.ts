import { logExtension } from "../extension-log.ts";
import { notifyUserDegradation } from "../user-notify.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { arr, map, obj, opt, str, compile } from "@earendil-works/pi-schema";
import { isRuntimeString } from "../../tools/runtime-values.ts";
import { BoundedLruCache } from "../bounded-cache.ts";
import { getGlobalPiLensDir } from "../file-utils.ts";
import { launchLSP } from "./launch.ts";
import { createRootDetector, LSP_SERVERS, type LSPServerInfo } from "./server.ts";

export interface CustomServerConfig {
  name: string;
  extensions: string[];
  command: string;
  args?: string[];
  rootMarkers?: string[];
  env?: Record<string, string>;
}

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
  initializationOptions?: InitializationOptions;
}

export interface LSPConfig {
  servers?: Record<string, CustomServerConfig>;
  serverOverrides?: Record<string, ServerInitOverride>;
  disabledServers?: string[];
  warmFiles?: string[];
}

interface RegisteredLSPConfig {
  customServers: LSPServerInfo[];
  disabledServerIds: Set<string>;
  serverOverrides: Map<string, ServerInitOverride>;
}

const JsonObjectSchema = obj({}, { open: true });
const isJsonRecord = compile(JsonObjectSchema).check;
const CustomServerConfigSchema = obj(
  {
    name: str(),
    extensions: arr(str()),
    command: str(),
    args: opt(arr(str())),
    rootMarkers: opt(arr(str())),
    env: opt(map(str())),
  },
  { open: true },
);
const isCustomServerConfig = compile(CustomServerConfigSchema).check;
const ServerInitOverrideSchema = obj(
  {
    initializationOptions: opt(JsonObjectSchema),
  },
  { open: true },
);
const isServerInitOverride = compile(ServerInitOverrideSchema).check;
function isJsonObject(value: InitializationValue | undefined): value is InitializationOptions {
  return isJsonRecord(value);
}

function stringArray(value: InitializationValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => isRuntimeString(entry))
    : [];
}

function sanitizeLspConfig(value: InitializationValue): LSPConfig | undefined {
  if (!isJsonObject(value)) return undefined;
  const config: LSPConfig = {};

  if (isJsonObject(value.servers)) {
    const servers: Record<string, CustomServerConfig> = {};
    for (const [id, server] of Object.entries(value.servers)) {
      if (isCustomServerConfig(server)) servers[id] = server;
    }
    config.servers = servers;
  }

  if (isJsonObject(value.serverOverrides)) {
    const overrides: Record<string, ServerInitOverride> = {};
    for (const [id, entry] of Object.entries(value.serverOverrides)) {
      if (!isServerInitOverride(entry)) continue;
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

const EMPTY_CONFIG: RegisteredLSPConfig = {
  customServers: [],
  disabledServerIds: new Set(),
  serverOverrides: new Map(),
};

const workspaceConfigs = new BoundedLruCache<string, RegisteredLSPConfig>(32);
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
        } catch {}
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

export function getAllServers(filePath?: string): LSPServerInfo[] {
  const config = filePath ? getConfigForFile(filePath) : EMPTY_CONFIG;
  const all = [...LSP_SERVERS, ...config.customServers];
  return all.filter((s) => !config.disabledServerIds.has(s.id));
}

export function isServerDisabled(serverId: string, filePath?: string): boolean {
  const config = filePath ? getConfigForFile(filePath) : EMPTY_CONFIG;
  return config.disabledServerIds.has(serverId);
}

export function getServersForFileWithConfig(filePath: string): LSPServerInfo[] {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  return getAllServers(filePath).filter((server) => {
    const extensions = server.extensions.map((value) => value.toLowerCase());
    const extensionMatch = extensions.includes(ext) || extensions.includes(base);
    if (!extensionMatch) return false;
    return server.pathFilter ? server.pathFilter(filePath) : true;
  });
}

export function primaryServerId(filePath: string): string | undefined {
  return getServersForFileWithConfig(filePath).find((s) => s.role !== "auxiliary")?.id;
}

export function getServerInitOverride(
  serverId: string,
  filePath: string,
): ServerInitOverride | undefined {
  return getConfigForFile(filePath).serverOverrides.get(serverId);
}

export function resetLSPConfigStateForTests(): void {
  workspaceConfigs.clear();
}

export { getAllServers as getServersForFile };
