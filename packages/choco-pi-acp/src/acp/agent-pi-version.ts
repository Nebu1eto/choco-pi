/**
 * Pi installation probes: installed and latest versions, the update notice, the changelog path, and agent-directory folders.
 */
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { standaloneHome, piAgentDir } from "@choco-pi/shared/pi-paths";
import { resolvePiLaunch } from "../pi-rpc/command.ts";
import { join, dirname } from "node:path";

export function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v);
}

export function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number(n));
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export const execFileAsync = promisify(execFile);

/** Upper bound for `pi --version`; the previous blocking call had none. */
export const PI_VERSION_TIMEOUT_MS = 10_000;

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The command whose installation the version header, update notice and `/changelog` describe.
 * Legacy mode keeps the upstream lookup of `pi` on PATH; standalone mode uses the configured
 * command, which defaults to the `choco-pi` launcher that sessions run.
 */
export function piInfoCommand(
  piCommand: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return standaloneHome(env) === undefined ? "pi" : piCommand;
}

/**
 * The installed Pi version (without a leading `v`), read from `--version` of
 * {@link piInfoCommand}. Null when Pi cannot be run.
 */
export async function readPiVersion(
  piCommand?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const launch = await resolvePiLaunch(piInfoCommand(piCommand, env), env);
    const { stdout, stderr } = await execFileAsync(
      launch.command,
      [...launch.argsPrefix, "--version"],
      { encoding: "utf8", env, timeout: PI_VERSION_TIMEOUT_MS, windowsHide: true },
    );
    const installed = (stdout.trim() || stderr.trim()).replace(/^v/i, "");
    return installed || null;
  } catch {
    return null;
  }
}

/**
 * Locate Pi's CHANGELOG.md from {@link piInfoCommand}. A Node install of `pi` resolves to
 * `.../@earendil-works/pi-coding-agent/dist/cli.js`; the standalone launcher resolves to
 * `<app>/bin/choco-pi`, whose pinned Pi lives in `<app>/node_modules`. Only legacy mode falls
 * back to the global npm root, which in standalone mode would describe a different Pi.
 */
export async function findPiChangelog(
  piCommand?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const standalone = standaloneHome(env) !== undefined;
  try {
    const launch = await resolvePiLaunch(piInfoCommand(piCommand, env), env);
    const resolved = await realpath(launch.argsPrefix[0] ?? launch.command);
    const pkgRoot = standalone
      ? join(dirname(dirname(resolved)), "node_modules", "@earendil-works", "pi-coding-agent")
      : dirname(dirname(resolved));
    const p = join(pkgRoot, "CHANGELOG.md");
    if (await pathExists(p)) return p;
  } catch {
    // ignore
  }
  if (standalone) return null;

  // Fallback: ask npm where global modules live.
  try {
    const { stdout } = await execFileAsync("npm", ["root", "-g"], {
      encoding: "utf8",
      env,
      windowsHide: true,
    });
    const root = stdout.trim();
    if (root) {
      const p = join(root, "@earendil-works", "pi-coding-agent", "CHANGELOG.md");
      if (await pathExists(p)) return p;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Best-effort latest Pi version from the npm registry. Standalone mode runs the
 * lockfile-pinned Pi, which `npm i -g` cannot update, so it never asks.
 */
export async function readLatestPiVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
  // Important: keep it fast to not slow down session/new.
  if (standaloneHome(env) !== undefined) return null;
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["view", "@earendil-works/pi-coding-agent", "version"],
      { encoding: "utf8", env, timeout: 800, windowsHide: true },
    );
    return stdout.trim().replace(/^v/i, "") || null;
  } catch {
    return null;
  }
}

export function buildUpdateNotice(installed: string | null, latest: string | null): string | null {
  if (!installed || !isSemver(installed)) return null;
  if (!latest || !isSemver(latest)) return null;
  if (compareSemver(latest, installed) <= 0) return null;

  return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``;
}

/** The Pi version header and npm update notice for session/new, probed in parallel. */
export type PiStartupProbe = Readonly<{ piVersion: string | null; updateNotice: string | null }>;

export async function probePiStartup(
  piCommand: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiStartupProbe> {
  const [piVersion, latest] = await Promise.all([
    readPiVersion(piCommand, env),
    readLatestPiVersion(env),
  ]);
  return { piVersion, updateNotice: buildUpdateNotice(piVersion, latest) };
}

/** Agent-directory folders listed in the startup info. */
export type StartupInfoAgentDirs = Readonly<{ prompts: string; extensions: string }>;

/**
 * Agent-directory folders listed in the startup info: Pi's agent directory
 * (`PI_CODING_AGENT_DIR`, else `$CHOCO_PI_HOME/agent` in standalone mode, else `$HOME/.pi/agent`).
 */
export function startupInfoAgentDirs(env: NodeJS.ProcessEnv = process.env): StartupInfoAgentDirs {
  const agentDir = piAgentDir(env, env.HOME ?? "");
  return { prompts: join(agentDir, "prompts"), extensions: join(agentDir, "extensions") };
}
