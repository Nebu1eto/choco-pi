import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAppPolicySettings, getLoadedComputerUseConfig } from "./config.ts";
import { HELPER_BUNDLE_ID } from "./platform/macos/helper.ts";

const execFileAsync = promisify(execFile);

export type AppBlockReason =
  | "host_app"
  | "helper"
  | "terminal"
  | "password_manager"
  | "system_authentication"
  | "user_blocked";

type DefaultBlockReason = Extract<
  AppBlockReason,
  "terminal" | "password_manager" | "system_authentication"
>;

export interface DefaultBlockedApp {
  readonly bundleId: string;
  readonly name: string;
  readonly reason: DefaultBlockReason;
}

export const DEFAULT_BLOCKED_APPS: readonly DefaultBlockedApp[] = [
  { bundleId: "com.apple.Terminal", name: "Terminal", reason: "terminal" },
  { bundleId: "com.googlecode.iterm2", name: "iTerm2", reason: "terminal" },
  { bundleId: "dev.warp.Warp-Stable", name: "Warp", reason: "terminal" },
  { bundleId: "net.kovidgoyal.kitty", name: "kitty", reason: "terminal" },
  { bundleId: "net.kovidgoyal.kitty-quick-access", name: "kitty quick access", reason: "terminal" },
  { bundleId: "com.mitchellh.ghostty", name: "Ghostty", reason: "terminal" },
  { bundleId: "org.alacritty", name: "Alacritty", reason: "terminal" },
  { bundleId: "com.github.wez.wezterm", name: "WezTerm", reason: "terminal" },
  { bundleId: "co.zeit.hyper", name: "Hyper", reason: "terminal" },
  { bundleId: "org.tabby", name: "Tabby", reason: "terminal" },
  { bundleId: "com.agilebits.onepassword7", name: "1Password 7", reason: "password_manager" },
  { bundleId: "com.1password.1password", name: "1Password", reason: "password_manager" },
  { bundleId: "com.bitwarden.desktop", name: "Bitwarden", reason: "password_manager" },
  { bundleId: "com.apple.Passwords", name: "Passwords", reason: "password_manager" },
  { bundleId: "com.apple.keychainaccess", name: "Keychain Access", reason: "password_manager" },
  {
    bundleId: "com.apple.SecurityAgent",
    name: "macOS authentication dialog",
    reason: "system_authentication",
  },
];

export const HOST_BUNDLE_ENV = "__CFBundleIdentifier";

export interface AppBlock {
  reason: AppBlockReason;
  matched: string;
}

export interface AppPolicyTarget {
  appName: string;
  bundleId?: string;
  pid: number;
}

const REASON_TEXT = {
  host_app: "it hosts this Pi session",
  helper: "it is the computer-use helper",
  terminal: "it is a terminal emulator",
  password_manager: "it is a password manager",
  system_authentication: "it is the macOS authentication dialog",
  user_blocked: "it is in the user's blocked_apps list",
} satisfies Record<AppBlockReason, string>;

export function describeAppBlockReason(reason: AppBlockReason): string {
  return REASON_TEXT[reason];
}

export class AppBlockedError extends Error {
  readonly code = "app_blocked";
  readonly app: string;
  readonly bundleId?: string;
  readonly pid: number;
  readonly reason: AppBlockReason;

  constructor(target: AppPolicyTarget, block: AppBlock) {
    const identity = [target.bundleId, `pid ${target.pid}`].filter(Boolean).join(", ");
    super(
      `app_blocked: computer-use is not allowed to operate ${target.appName} (${identity}); ${describeAppBlockReason(block.reason)}. This is a user-level policy: nothing was observed or sent to this app, and computer-use will refuse it on every tool and delivery path.`,
    );
    this.name = "AppBlockedError";
    this.app = target.appName;
    this.bundleId = target.bundleId;
    this.pid = target.pid;
    this.reason = block.reason;
  }
}

export type HostAncestryProbe = (signal?: AbortSignal) => Promise<number[]>;

export type HostAncestryStatus = "pending" | "resolved" | "failed";

export interface HostProcessState {
  status: HostAncestryStatus;
  pids: number[];
  error?: string;
}

const PS_TIMEOUT_MS = 3_000;

function fallbackHostPids(): number[] {
  return [process.pid, process.ppid].filter((pid) => Number.isInteger(pid) && pid > 1);
}

export function ancestryFromPsOutput(output: string, selfPid: number): number[] {
  const parents = new Map<number, number>();
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid, ppid);
  }
  if (!parents.has(selfPid))
    throw new Error(`ps output did not list this process (pid ${selfPid})`);
  const chain: number[] = [];
  let current: number | undefined = selfPid;
  while (current !== undefined && current > 1 && !chain.includes(current)) {
    chain.push(current);
    current = parents.get(current);
  }
  return chain;
}

const psAncestry: HostAncestryProbe = async (signal) => {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
    encoding: "utf8",
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  return ancestryFromPsOutput(stdout, process.pid);
};

let ancestryProbe: HostAncestryProbe = psAncestry;
let hostState: HostProcessState = { status: "pending", pids: fallbackHostPids() };
let hostLookup: Promise<void> | undefined;
let hostGeneration = 0;

async function startHostLookup(): Promise<void> {
  const generation = hostGeneration;
  const probe = ancestryProbe;
  let pids: number[];
  try {
    pids = await probe();
  } catch (error) {
    if (generation !== hostGeneration) return;
    hostState = {
      status: "failed",
      pids: fallbackHostPids(),
      error: error instanceof Error ? error.message : String(error),
    };
    return;
  }
  if (generation !== hostGeneration) return;
  const valid = pids.filter((pid) => Number.isInteger(pid) && pid > 1);
  hostState = { status: "resolved", pids: [...new Set([...fallbackHostPids(), ...valid])] };
}

export async function ensureAppPolicyReady(): Promise<void> {
  retryFailedHostLookup();
  hostLookup ??= startHostLookup();
  await hostLookup;
}

export function retryFailedHostLookup(): void {
  if (hostState.status !== "failed") return;
  hostGeneration += 1;
  hostLookup = undefined;
  hostState = { status: "pending", pids: fallbackHostPids() };
}

export function hostProcessState(): HostProcessState {
  return { ...hostState, pids: [...hostState.pids] };
}

export function replaceHostAncestryProbeForTest(probe: HostAncestryProbe): () => void {
  const previous = ancestryProbe;
  const reset = (next: HostAncestryProbe) => {
    ancestryProbe = next;
    hostGeneration += 1;
    hostLookup = undefined;
    hostState = { status: "pending", pids: fallbackHostPids() };
  };
  reset(probe);
  return () => reset(previous);
}

function hostBundleId(): string | undefined {
  const value = process.env[HOST_BUNDLE_ENV]?.trim();
  return value ? value : undefined;
}

function key(bundleId: string): string {
  return bundleId.trim().toLowerCase();
}

function includesBundle(list: readonly string[], bundleId: string): boolean {
  const wanted = key(bundleId);
  return list.some((entry) => key(entry) === wanted);
}

export function appBlockFor(target: { bundleId?: string; pid: number }): AppBlock | undefined {
  if (hostState.pids.includes(target.pid))
    return { reason: "host_app", matched: `pid ${target.pid}` };
  const bundleId = target.bundleId?.trim();
  if (!bundleId) return undefined;
  const host = hostBundleId();
  if (host && key(host) === key(bundleId)) return { reason: "host_app", matched: host };
  if (key(bundleId) === key(HELPER_BUNDLE_ID))
    return { reason: "helper", matched: HELPER_BUNDLE_ID };
  const settings = getAppPolicySettings();
  if (includesBundle(settings.blockedApps, bundleId))
    return { reason: "user_blocked", matched: bundleId };
  const builtIn = DEFAULT_BLOCKED_APPS.find((app) => key(app.bundleId) === key(bundleId));
  if (builtIn && !includesBundle(settings.unblockedApps, builtIn.bundleId))
    return { reason: builtIn.reason, matched: builtIn.bundleId };
  return undefined;
}

export function assertAppAllowed(target: AppPolicyTarget): void {
  const block = appBlockFor(target);
  if (block) throw new AppBlockedError(target, block);
}

export interface EffectiveAppBlocklist {
  bundleIds: string[];
  pids: number[];
  clientPid: number;
}

export function effectiveAppBlocklist(): EffectiveAppBlocklist {
  const settings = getAppPolicySettings();
  const bundleIds: string[] = [];
  const add = (bundleId: string | undefined) => {
    if (bundleId && !includesBundle(bundleIds, bundleId)) bundleIds.push(bundleId);
  };
  add(hostBundleId());
  add(HELPER_BUNDLE_ID);
  for (const app of DEFAULT_BLOCKED_APPS)
    if (!includesBundle(settings.unblockedApps, app.bundleId)) add(app.bundleId);
  for (const bundleId of settings.blockedApps) add(bundleId);
  return { bundleIds, pids: [...hostState.pids], clientPid: process.pid };
}

export function appPolicyStatusLines(): string[] {
  const settings = getAppPolicySettings();
  const loaded = getLoadedComputerUseConfig();
  const host = hostProcessState();
  const hostBundle = hostBundleId();
  const isHostBundle = (bundleId: string) =>
    hostBundle !== undefined && key(hostBundle) === key(bundleId);
  const lifted = DEFAULT_BLOCKED_APPS.filter(
    (app) => includesBundle(settings.unblockedApps, app.bundleId) && !isHostBundle(app.bundleId),
  );
  const noEffect = settings.unblockedApps.filter(
    (bundleId) =>
      isHostBundle(bundleId) ||
      !DEFAULT_BLOCKED_APPS.some((app) => key(app.bundleId) === key(bundleId)),
  );
  const ancestry =
    host.status === "resolved"
      ? `pids ${host.pids.join(", ")}`
      : host.status === "pending"
        ? `lookup pending; blocking pids ${host.pids.join(", ")} meanwhile`
        : `lookup failed (${host.error ?? "unknown error"}); blocking only pids ${host.pids.join(", ")} plus the static rules`;
  const lines = [
    `blocked apps (default): ${DEFAULT_BLOCKED_APPS.filter((app) => !lifted.includes(app))
      .map((app) => app.bundleId)
      .join(", ")}`,
    `blocked_apps: ${settings.blockedApps.join(", ") || "none"}`,
    `unblocked_apps (user file only): ${lifted.map((app) => app.bundleId).join(", ") || "none"}`,
    `host app (never unblockable): ${hostBundle ?? `no ${HOST_BUNDLE_ENV}`}; ${ancestry}`,
    `helper (never unblockable): ${HELPER_BUNDLE_ID}`,
  ];
  if (noEffect.length > 0)
    lines.push(
      `unblocked_apps with no effect (not a default block or never unblockable): ${noEffect.join(", ")}`,
    );
  for (const ignored of settings.ignoredUnblocks)
    lines.push(
      `ignored unblocked_apps from ${ignored.source}: ${ignored.bundleIds.join(", ")} (only the user file ${loaded.sources[0]?.path ?? ""} can unblock apps)`,
    );
  return lines;
}
