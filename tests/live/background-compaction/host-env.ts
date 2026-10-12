import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";

/** An injected in-memory store; sealed before the session so refresh/write fails closed. */
export class ReadOnlyMemoryCredentials extends InMemoryCredentialStore {
  private locked = false;
  seal(): void {
    this.locked = true;
  }
  /** Stores the one live credential in memory, then seals the store. */
  async seedAndSeal(provider: string, credential: Credential): Promise<void> {
    if (this.locked) throw new Error("Credential store already sealed");
    await super.modify(provider, async () => structuredClone(credential));
    this.seal();
  }
  override async modify(
    provider: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (this.locked) throw new Error("Credential refresh/write prohibited in E2E");
    return super.modify(provider, fn);
  }
  override async delete(): Promise<void> {
    throw new Error("Credential deletion prohibited in E2E");
  }
}

export interface RuntimeDirs {
  readonly root: string;
  readonly agentDir: string;
  readonly projectDir: string;
  readonly sessionDir: string;
  readonly homeDir: string;
  /** True when this launch created the root (mkdtemp); reused roots are caller-owned. */
  readonly created: boolean;
}

/** Owned runtime tree: a fresh mkdtemp root, or a caller-provided root reused across launches. */
export async function prepareRuntimeDirs(
  scratchRoot: string,
  runtimeRoot?: string,
): Promise<RuntimeDirs> {
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const created = runtimeRoot === undefined;
  const root = runtimeRoot ?? (await mkdtemp(join(scratchRoot, "host-")));
  const dirs = {
    root,
    agentDir: join(root, "agent"),
    projectDir: join(root, "project"),
    sessionDir: join(root, "sessions"),
    homeDir: join(root, "home"),
    created,
  };
  await Promise.all([
    mkdir(dirs.agentDir, { recursive: true, mode: 0o700 }),
    mkdir(join(dirs.projectDir, ".pi", "extensions"), { recursive: true, mode: 0o700 }),
    mkdir(dirs.sessionDir, { recursive: true, mode: 0o700 }),
    mkdir(dirs.homeDir, { recursive: true, mode: 0o700 }),
  ]);
  return dirs;
}

const SCOPED_ENV = ["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE"] as const;
/** Proxy variables would route the Codex virtual socket or fetch elsewhere; cleared while owned. */
const CLEARED_ENV = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;

export interface EnvScope {
  restore(): void;
}

/**
 * Scopes process-global state for one launcher: agent dir, HOME (so extensions
 * such as hooks never read the user's real ~/.claude settings), proxies, and a
 * global fetch that refuses every call.
 */
export function scopeProcessEnv(
  dirs: RuntimeDirs,
  blockedFetch: typeof globalThis.fetch,
): EnvScope {
  const saved = new Map<string, string | undefined>();
  for (const key of [...SCOPED_ENV, ...CLEARED_ENV]) saved.set(key, process.env[key]);
  const originalFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dirs.agentDir;
  process.env.HOME = dirs.homeDir;
  process.env.USERPROFILE = dirs.homeDir;
  for (const key of CLEARED_ENV) delete process.env[key];
  globalThis.fetch = blockedFetch;
  return {
    restore() {
      globalThis.fetch = originalFetch;
      for (const [key, value] of saved) restoreEnv(key, value);
    },
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
