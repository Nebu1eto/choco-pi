import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ensurePermissions,
  type PermissionKind,
  type PermissionStatus,
} from "../../permissions.ts";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type { PlatformReadyState } from "../types.ts";
import { HELPER_APP_PATH, macosHelper } from "./helper.ts";
import { assertPlatformArchitecture } from "../architecture.ts";

const GRANT_INSTRUCTIONS =
  "Grant Accessibility and Screen Recording to pi-computer-use.app in System Settings → Privacy & Security. " +
  "Screen Recording lets the agent see the window; Accessibility lets it interact with the window.";

const SIGNING_MIGRATION_WARNING =
  "If these permissions were enabled before this install/update, macOS invalidated the old grants because " +
  "pi-computer-use.app was re-signed. Re-enable both toggles for the newly signed helper. " +
  "If a toggle is already on, switch it off and on again.";

interface PermissionSourceResponse {
  attribution?: "helper-app" | string;
  pid?: number;
  parentPid?: number;
  executablePath?: string;
  parentPath?: string;
  parentBundleId?: string;
  macOS?: string;
}

interface PermissionCheckResponse {
  accessibility?: boolean;
  screenRecordingCapturable?: boolean;
  screenRecordingPreflight?: boolean;
  source?: PermissionSourceResponse;
}

const macosPermissionKinds = [
  { kind: "accessibility" as const, openOption: "Open Accessibility Settings (missing)" },
  { kind: "screenRecording" as const, openOption: "Open Screen Recording Settings (missing)" },
];

function permissionStatusSummary(status: PermissionStatus): string {
  const lines = [
    `Accessibility: ${status.accessibility ? "granted" : "missing"}`,
    `Screen Recording: ${status.screenRecording ? "granted" : "missing"}`,
  ];
  if (status.screenRecordingPreflight && !status.screenRecording) {
    lines.push(
      "(Screen Recording reads granted in the TCC database but a live capture probe failed — " +
        "the grant likely belongs to a different app identity, or the helper needs a restart.)",
    );
  }
  return lines.join("; ");
}

function permissionPrompt(status: PermissionStatus, helperPath: string, hint?: string): string {
  return [
    "pi-computer-use needs macOS permissions for its helper app.",
    permissionStatusSummary(status),
    "",
    `Helper: pi-computer-use.app (${helperPath})`,
    hint,
    "",
    `Important: ${SIGNING_MIGRATION_WARNING}`,
    "",
    "pi-computer-use.app is already listed in the pane(s) — enable its toggle, then choose Recheck.",
  ]
    .filter(Boolean)
    .join("\n");
}

function missingPermissionMessage(kinds: PermissionKind[]): string {
  return `Still missing after restart: ${kinds.join(" and ")}. ${SIGNING_MIGRATION_WARNING} Then choose Recheck again.`;
}

async function checkPermissions(signal?: AbortSignal): Promise<PermissionStatus> {
  const result = await macosHelper.command<PermissionCheckResponse>(
    "checkPermissions",
    {},
    { signal },
  );
  const rawSource = result?.source;
  return {
    accessibility: toBoolean(result?.accessibility),
    screenRecording: toBoolean(result?.screenRecordingCapturable),
    screenRecordingPreflight: toBoolean(result?.screenRecordingPreflight),
    source: rawSource
      ? {
          attribution: rawSource.attribution === "helper-app" ? "helper-app" : "caller",
          pid: Math.trunc(toFiniteNumber(rawSource.pid, 0)) || undefined,
          parentPid: Math.trunc(toFiniteNumber(rawSource.parentPid, 0)) || undefined,
          executablePath: toOptionalString(rawSource.executablePath),
          parentPath: toOptionalString(rawSource.parentPath),
          parentBundleId: toOptionalString(rawSource.parentBundleId),
          os: toOptionalString(rawSource.macOS),
        }
      : undefined,
  };
}

export async function releaseMacosOwnership(signal?: AbortSignal): Promise<boolean> {
  return await macosHelper.release(signal);
}

export async function macosForegroundSection(
  op: "acquire" | "release",
  waitMs: number,
  signal?: AbortSignal,
  acquireId?: string,
): Promise<boolean | undefined> {
  const result = await macosHelper.foregroundSection(op, waitMs, signal, acquireId);
  if (result === undefined) return undefined;
  return op === "acquire" ? result.acquired === true : result.released === true;
}

async function registerPermissions(signal?: AbortSignal): Promise<void> {
  await macosHelper.command("registerPermissions", {}, { signal, timeoutMs: 15_000 });
}

export async function ensureMacosReady(
  ctx: ExtensionContext,
  state: PlatformReadyState,
  signal?: AbortSignal,
): Promise<PlatformReadyState> {
  await macosHelper.ensureInstalled(signal);
  if (!(await macosHelper.ensureDaemon(signal))) {
    throw new Error(
      `pi-computer-use helper app daemon did not start. Helper app: ${HELPER_APP_PATH}`,
    );
  }
  const helperDiagnostics = await macosHelper.ensureProtocol(signal);
  assertPlatformArchitecture("macOS", helperDiagnostics);
  if (state.session && macosHelper.coordinatesSessions) macosHelper.adoptSession(state.session);
  await macosHelper.claim(signal);

  const now = Date.now();
  const cachedStatus = state.permissionStatus;
  const canUseCachedPermissions =
    cachedStatus?.accessibility &&
    cachedStatus.screenRecording &&
    now - state.lastPermissionCheckAt < 2_000;
  if (canUseCachedPermissions) {
    return { ...state, helperDiagnostics };
  }

  let permissionStatus = await checkPermissions(signal);
  let lastPermissionCheckAt = now;

  if (!permissionStatus.accessibility || !permissionStatus.screenRecording) {
    const attributionHint =
      permissionStatus.source?.attribution === "caller"
        ? `Warning: the helper is not running as the installed pi-computer-use.app (executable: ${permissionStatus.source?.executablePath ?? "unknown"}). Grants made now would attach to the launching app instead. Restart Pi so the canonical helper is used.`
        : undefined;
    permissionStatus = await ensurePermissions(
      ctx,
      {
        kinds: macosPermissionKinds,
        copy: {
          nonInteractiveError: (helperPath) =>
            `pi-computer-use setup requires an interactive session. Start pi in interactive mode. ${GRANT_INSTRUCTIONS}\nHelper path: ${helperPath}`,
          prompt: permissionPrompt,
          incompleteError: (helperPath) =>
            `pi-computer-use setup is incomplete. ${GRANT_INSTRUCTIONS} Helper path: ${helperPath}`,
          readyMessage: "pi-computer-use is ready.",
          stillMissing: missingPermissionMessage,
        },
        checkPermissions: (permissionSignal) => checkPermissions(permissionSignal ?? signal),
        registerPermissions: (permissionSignal) => registerPermissions(permissionSignal ?? signal),
        openPermissionPane: async (kind, permissionSignal) => {
          await macosHelper.command(
            "openPermissionPane",
            { kind },
            { signal: permissionSignal ?? signal },
          );
        },
        restartHelper: (permissionSignal) => macosHelper.restart(permissionSignal ?? signal),
        permissionHint: attributionHint,
      },
      HELPER_APP_PATH,
      signal,
    );
    lastPermissionCheckAt = Date.now();
  }

  return { permissionStatus, lastPermissionCheckAt, helperDiagnostics };
}
