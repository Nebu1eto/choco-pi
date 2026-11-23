/**
 * standalone.ts — Code Mode for every provider, without choco-pi-codex.
 *
 * Registers the `exec`/`wait` Code Mode tools over the provider-neutral ports
 * with no provider contributions: Code Mode is active for every model, the
 * nested tools are the core set (apply_patch, exec_command, write_stdin,
 * view_image) plus Pi's bridged session tools, and the top-level tool list is
 * `exec`, `wait` and every non-coding tool that was active. Pi's direct coding
 * tools (read, bash, edit, write) leave the top level but stay callable inside
 * Code Mode through the bridge.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";
import { registerCodeMode } from "./adapter/code-mode.ts";
import type { CodeModeHost, CodeModeToolConfig } from "./adapter/code-mode/ports.ts";
import { memoizedImport } from "./memoized-import.ts";
import { registerApplyPatchDisplayBroker } from "./tools/apply-patch/display-broker.ts";
import { clearApplyPatchRenderState } from "./tools/apply-patch/render-state.ts";
import { resetRegisteredToolCapture } from "./tools/code-mode/registered-tool-bridge.ts";
import type { CodeModeRegistration } from "./tools/code-mode/tools.ts";
import { createExecCommandTracker } from "./tools/exec/command-state.ts";
import { createLazyExecSessionManager } from "./tools/exec/lazy-session-manager.ts";
import { getBundledToolBinaryPath } from "./tools/native/binary.ts";
import type { BoundaryValue } from "./tools/boundary.ts";

const loadBash = memoizedImport(() => import("./shell/bash.ts"));

/** The top-level tools standalone Code Mode exposes, in order. */
export const STANDALONE_CODE_MODE_TOOL_NAMES: readonly string[] = ["exec", "wait"];

/** Tools Code Mode owns: never kept top-level beside `exec`/`wait`. */
const CODE_MODE_OWNED_TOOL_NAMES: readonly string[] = [
  ...STANDALONE_CODE_MODE_TOOL_NAMES,
  "notebook",
  "exec_command",
  "write_stdin",
  "apply_patch",
  "view_image",
];

/** Pi's direct coding tools; Code Mode replaces them at the top level. */
const REPLACED_DIRECT_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write"];

export const DEFAULT_STANDALONE_CODE_MODE_CONFIG: CodeModeToolConfig = {
  tools: { customRustBinariesDir: "", viewImageFallback: false },
  ui: { toolRenaming: true, compactTools: false, codeModeDetails: false },
  notebook: { maxHeapMiB: 4_096 },
};

export interface StandaloneCodeMode {
  host: CodeModeHost;
  registration: CodeModeRegistration;
  /** Put `exec`/`wait` first in the active tools; the session lifecycle events call it. */
  activate(): void;
}

function withLiveCtx<Result>(action: () => Result): Result | undefined {
  try {
    return action();
  } catch (error) {
    if (isStaleContextError(error)) return undefined;
    throw error;
  }
}

function isAbortError(error: BoundaryValue): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR");
}

function errorMessage(error: BoundaryValue): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Top-level tools for standalone Code Mode: `exec`, `wait`, then every
 * active tool Code Mode neither owns nor replaces, in its current order.
 */
export function standaloneCodeModeActiveTools(activeTools: readonly string[]): string[] {
  const preserved = activeTools.filter(
    (name) =>
      !CODE_MODE_OWNED_TOOL_NAMES.includes(name) && !REPLACED_DIRECT_TOOL_NAMES.includes(name),
  );
  return [...STANDALONE_CODE_MODE_TOOL_NAMES, ...preserved];
}

export async function registerStandaloneCodeMode(
  pi: ExtensionAPI,
  config: CodeModeToolConfig = DEFAULT_STANDALONE_CODE_MODE_CONFIG,
): Promise<StandaloneCodeMode> {
  registerApplyPatchDisplayBroker(pi);
  const tracker = createExecCommandTracker();
  const sessions = createLazyExecSessionManager({
    env: { ...process.env },
    bridgeBinaryPath: () =>
      getBundledToolBinaryPath("exec_bridge", {}, config.tools.customRustBinariesDir),
  });
  const host: CodeModeHost = {
    state: { config, executionMode: "code", previousToolNames: undefined },
    tracker,
    sessions,
    codeMode: {
      policy: { isActive: () => true, executionKind: () => "code" },
    },
  };
  const registration = await registerCodeMode(pi, host);
  sessions.onSessionExit((sessionId) => tracker.recordSessionFinished(sessionId));
  // Each lifecycle event takes a generation; a superseded handler stops after its await.
  let generation = 0;

  const activate = (): void => {
    const active = pi.getActiveTools();
    // The bridge scope is the session's own tool set, captured once before Code Mode hides it.
    host.state.previousToolNames ??= active.filter(
      (name) => !CODE_MODE_OWNED_TOOL_NAMES.includes(name),
    );
    const next = standaloneCodeModeActiveTools(active);
    if (next.length !== active.length || next.some((name, index) => name !== active[index]))
      pi.setActiveTools(next);
  };
  const prepare = (ctx: ExtensionContext): void => {
    const preparation = withLiveCtx(() => registration.prepare(ctx));
    if (!preparation) return;
    void preparation.catch((error: BoundaryValue) => {
      if (isAbortError(error) || isStaleContextError(error)) return;
      withLiveCtx(() =>
        ctx.ui.notify(`Code Mode host setup failed: ${errorMessage(error)}`, "error"),
      );
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    const owned = ++generation;
    const { initializeBashParser } = await loadBash();
    if (owned !== generation) return;
    initializeBashParser();
    sessions.setBaseEnv({ ...process.env });
    tracker.clear();
    clearApplyPatchRenderState();
    activate();
    prepare(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    generation += 1;
    activate();
    prepare(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    const owned = ++generation;
    await registration.shutdownHost();
    if (owned !== generation) return;
    activate();
    prepare(ctx);
  });
  pi.on("session_before_switch", (_event, ctx) => resetRegisteredToolCapture(ctx));
  pi.on("session_before_fork", (_event, ctx) => resetRegisteredToolCapture(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    generation += 1;
    resetRegisteredToolCapture(ctx);
    const results = await Promise.allSettled([sessions.shutdown(), registration.shutdown()]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Code Mode shutdown failed");
  });
  return { host, registration, activate };
}
