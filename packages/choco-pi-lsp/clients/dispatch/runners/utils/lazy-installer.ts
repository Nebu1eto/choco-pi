import { safeSpawnAsync, type SpawnResult } from "../../../safe-spawn.ts";
import { assertInstallAllowed } from "../../../project-trust.ts";
import { logExtension } from "../../../extension-log.ts";
import {
  classifyProbeFailure,
  installRetryDelayMs,
  type InstallAttemptFact,
} from "./availability-policy.ts";

export type LazyInstallTool = "rubocop" | "rust-clippy" | "rustfmt";

interface LazyInstallSpec {
  command: string;
  args: string[];
}

type LazyInstallSpecs = Record<LazyInstallTool, LazyInstallSpec>;

const LAZY_INSTALL_SPECS = {
  rubocop: { command: "gem", args: ["install", "rubocop", "--no-document"] },
  "rust-clippy": { command: "rustup", args: ["component", "add", "clippy"] },
  rustfmt: { command: "rustup", args: ["component", "add", "rustfmt"] },
} satisfies LazyInstallSpecs;

const LAZY_INSTALL_IGNORES_AMBIENT_SIGNAL = true;

const LAZY_INSTALL_TIMEOUT_MS = 180_000;

interface LazyInstallState {
  fact: InstallAttemptFact;
  retryAtMs: number;
  transientAttempts: number;
}

const attempts = new Map<string, LazyInstallState>();

function key(cwd: string, tool: LazyInstallTool): string {
  return `${cwd}:${tool}`;
}

export function getLazyInstallAttempt(
  tool: LazyInstallTool,
  cwd: string,
): InstallAttemptFact | undefined {
  return attempts.get(key(cwd, tool))?.fact;
}

export function resetLazyInstallAttempts(): void {
  attempts.clear();
}

type Suppression = "succeeded" | "cooling" | "held";

function suppressionFor(state: LazyInstallState | undefined): Suppression | null {
  if (!state) return null;
  if (state.fact.outcome === "succeeded") return "succeeded";
  if (state.retryAtMs === 0) return "held";
  return Date.now() < state.retryAtMs ? "cooling" : null;
}

const inFlight = new Map<string, Promise<boolean>>();

async function runLazyInstall(
  tool: LazyInstallTool,
  cwd: string,
  spec: LazyInstallSpec,
): Promise<boolean> {
  const k = key(cwd, tool);
  const running = inFlight.get(k);
  if (running) return running;

  const previous = attempts.get(k);
  const suppressed = suppressionFor(previous);
  if (suppressed !== null) {
    logExtension({
      subsystem: "install",
      message: `lazy-install ${tool} suppressed (${suppressed})`,
      metadata: {
        tool,
        cwd,
        suppressed,
        outcome: previous?.fact.outcome,
        ...(previous?.fact.reason && { reason: previous.fact.reason }),
        ...(suppressed === "cooling" && {
          retryAfterMs: Math.max(0, (previous?.retryAtMs ?? 0) - Date.now()),
        }),
      },
    });
    return false;
  }

  const started = performInstall(k, tool, cwd, spec);
  inFlight.set(k, started);
  try {
    return await started;
  } finally {
    inFlight.delete(k);
  }
}

async function performInstall(
  k: string,
  tool: LazyInstallTool,
  cwd: string,
  spec: LazyInstallSpec,
): Promise<boolean> {
  let result: SpawnResult;
  try {
    result = await safeSpawnAsync(spec.command, spec.args, {
      timeout: LAZY_INSTALL_TIMEOUT_MS,
      cwd,
      ...(LAZY_INSTALL_IGNORES_AMBIENT_SIGNAL && { ignoreAmbientSignal: true }),
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    result = {
      stdout: "",
      stderr: error.message,
      status: null,
      error,
      failure: "spawn",
    };
  }

  if (!result.error && result.status === 0) {
    attempts.set(k, {
      fact: { outcome: "succeeded" },
      retryAtMs: 0,
      transientAttempts: 0,
    });
    return true;
  }

  const classified = classifyProbeFailure(result, {
    command: spec.command,
    unclassifiedFailureOutcome: "transient",
  });
  const durable = classified.outcome === "missing";
  const reason = (result.error?.message ?? result.stderr ?? `exit ${result.status}`)
    .trim()
    .slice(0, 200);

  const settledPrevious = attempts.get(k);
  const transientAttempts = durable ? 0 : (settledPrevious?.transientAttempts ?? 0) + 1;
  const cooldownMs = durable ? 0 : installRetryDelayMs(transientAttempts);
  const retryAtMs = cooldownMs === 0 ? 0 : Date.now() + cooldownMs;

  attempts.set(k, {
    fact: { outcome: "failed", reason },
    retryAtMs,
    transientAttempts,
  });
  logExtension({
    subsystem: "install",
    message: `lazy-install ${tool} failed: ${reason}`,
    metadata: {
      tool,
      cwd,
      command: spec.command,
      cause: classified.cause,
      durable,
      transientAttempts,
      held: retryAtMs === 0,
      ...(retryAtMs > 0 && { retryAfterMs: retryAtMs - Date.now() }),
      evidence: { ...classified.evidence },
    },
  });
  return false;
}

export async function tryLazyInstall(tool: LazyInstallTool, cwd: string): Promise<boolean> {
  if (!assertInstallAllowed(`runner lazy install: ${tool}`)) return false;
  return runLazyInstall(tool, cwd, LAZY_INSTALL_SPECS[tool]);
}

export async function tryLazyInstallForFormatter(
  tool: "rubocop" | "rustfmt",
  cwd: string,
): Promise<boolean> {
  if (!assertInstallAllowed(`formatter lazy install: ${tool}`)) return false;
  return runLazyInstall(tool, cwd, LAZY_INSTALL_SPECS[tool]);
}
