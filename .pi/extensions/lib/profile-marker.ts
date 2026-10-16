import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { PI_SDK_TARGET } from "./pi-target.ts";

export const ProfileMarkerSchema = Type.Object(
  {
    schema: Type.Literal(1),
    name: Type.Literal("choco-pi"),
    checkout: Type.String(),
    revision: Type.Union([Type.String(), Type.Null()]),
    installedAt: Type.String(),
    pi: Type.Object(
      {
        version: Type.Union([Type.String(), Type.Null()]),
        launcher: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    hostBridge: Type.Object(
      {
        schema: Type.Literal(1),
        entryPrefix: Type.Literal("choco-pi:host-bridge"),
        statusKey: Type.Literal("choco-pi.host-bridge"),
        // Optional so markers written before structured reports stay valid.
        reportStatusKey: Type.Optional(Type.Literal("choco-pi.report")),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ProfileMarker = Static<typeof ProfileMarkerSchema>;
export type ProfileMarkerObservation =
  | {
      path: string;
      status: "valid";
      marker: ProfileMarker;
      observedPiVersion: string | null;
      warning?: string;
    }
  | { path: string; status: "missing" | "invalid" | "unreadable"; reason: string };

export function profileMarkerPath(
  agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"),
): string {
  return path.resolve(agentDir, "choco-pi", "profile.json");
}

const runFile = promisify(execFile);
export async function checkoutRevision(checkout: string): Promise<string | null> {
  try {
    const { stdout } = await runFile("git", ["-C", checkout, "rev-parse", "--short", "HEAD"], {
      timeout: 5000,
      maxBuffer: 4096,
    });
    const revision = stdout.trim();
    return /^[a-f0-9]{7,64}$/.test(revision) ? revision : null;
  } catch {
    return null;
  }
}

export const PROFILE_PI_TARGET = PI_SDK_TARGET;

export async function launcherVersion(launcher: string): Promise<string | null> {
  try {
    const { stdout } = await runFile(launcher, ["--version"], { timeout: 5000, maxBuffer: 4096 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function resolvePiLauncher(override?: string): Promise<ProfileMarker["pi"]> {
  const selected = override ?? process.env.CHOCO_PI_LAUNCHER;
  if (selected !== undefined) {
    const launcher = path.resolve(selected);
    return { launcher, version: await launcherVersion(launcher) };
  }
  const candidates = new Set(
    (process.env.PATH ?? "")
      .split(path.delimiter)
      .map((directory) => path.resolve(directory, "pi")),
  );
  for (const launcher of candidates) {
    const version = await launcherVersion(launcher);
    if (version === PROFILE_PI_TARGET) return { launcher, version };
  }
  return { launcher: null, version: null };
}

export async function writeProfileMarker(
  agentDir: string,
  checkout: string,
  pi: ProfileMarker["pi"],
): Promise<string> {
  const target = profileMarkerPath(agentDir);
  const root = path.resolve(checkout);
  const marker: ProfileMarker = {
    schema: 1,
    name: "choco-pi",
    checkout: root,
    revision: await checkoutRevision(root),
    installedAt: new Date().toISOString(),
    pi,
    hostBridge: {
      schema: 1,
      entryPrefix: "choco-pi:host-bridge",
      statusKey: "choco-pi.host-bridge",
      reportStatusKey: "choco-pi.report",
    },
  };
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(target), 0o700);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

export async function readProfileMarker(agentDir?: string): Promise<ProfileMarkerObservation> {
  const target = profileMarkerPath(agentDir);
  let contents: string;
  try {
    contents = await readFile(target, "utf8");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return {
      path: target,
      status: missing ? "missing" : "unreadable",
      reason: missing ? "Profile marker is absent" : "Profile marker could not be read",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { path: target, status: "invalid", reason: "Profile marker is not valid JSON" };
  }
  if (
    !Value.Check(ProfileMarkerSchema, parsed) ||
    !path.isAbsolute(parsed.checkout) ||
    (parsed.pi.launcher !== null && !path.isAbsolute(parsed.pi.launcher)) ||
    !Number.isFinite(Date.parse(parsed.installedAt))
  ) {
    return { path: target, status: "invalid", reason: "Profile marker does not match schema 1" };
  }
  try {
    if (!(await stat(parsed.checkout)).isDirectory()) {
      return {
        path: target,
        status: "invalid",
        reason: "Profile marker checkout is not a directory",
      };
    }
  } catch {
    return { path: target, status: "invalid", reason: "Profile marker checkout is unavailable" };
  }
  const observedPiVersion =
    parsed.pi.launcher === null ? null : await launcherVersion(parsed.pi.launcher);
  const warning =
    parsed.pi.launcher === null
      ? `No compatible Pi launcher recorded (requires ${PROFILE_PI_TARGET})`
      : observedPiVersion !== PROFILE_PI_TARGET
        ? `Recorded Pi launcher reports ${observedPiVersion ?? "unavailable"}; requires ${PROFILE_PI_TARGET}`
        : undefined;
  const observation: ProfileMarkerObservation = {
    path: target,
    status: "valid",
    marker: parsed,
    observedPiVersion,
  };
  if (warning) observation.warning = warning;
  return observation;
}
