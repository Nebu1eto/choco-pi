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

export const STANDALONE_CODE_MODE_TOOL_NAMES: readonly string[] = ["exec", "wait"];

const CODE_MODE_OWNED_TOOL_NAMES: readonly string[] = [
  ...STANDALONE_CODE_MODE_TOOL_NAMES,
  "notebook",
  "exec_command",
  "write_stdin",
  "apply_patch",
  "view_image",
];

const REPLACED_DIRECT_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write"];

export const DEFAULT_STANDALONE_CODE_MODE_CONFIG: CodeModeToolConfig = {
  tools: { customRustBinariesDir: "", viewImageFallback: false },
  ui: { toolRenaming: true, compactTools: false, codeModeDetails: false },
  notebook: { maxHeapMiB: 4_096 },
};

export interface StandaloneCodeMode {
  host: CodeModeHost;
  registration: CodeModeRegistration;
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

export function standaloneCodeModeActiveTools(activeTools: readonly string[]): string[] {
  const preserved = activeTools.filter(
    (name) =>
      !CODE_MODE_OWNED_TOOL_NAMES.includes(name) && !REPLACED_DIRECT_TOOL_NAMES.includes(name),
  );
  return [...STANDALONE_CODE_MODE_TOOL_NAMES, ...preserved];
}

function withoutCodeModeTools(names: readonly string[]): string[] {
  return names.filter((name) => !CODE_MODE_OWNED_TOOL_NAMES.includes(name));
}

function addedSince(observed: readonly string[], current: readonly string[]): string[] | undefined {
  const observedNames = new Set(observed);
  const currentNames = new Set(current);
  if ([...observedNames].some((name) => !currentNames.has(name))) return undefined;
  if (current.some((name) => REPLACED_DIRECT_TOOL_NAMES.includes(name))) return undefined;
  return [...currentNames].filter((name) => !observedNames.has(name));
}

function refreshStandalonePermissionSnapshot(
  previous: readonly string[] | undefined,
  lastObserved: readonly string[] | undefined,
  active: readonly string[],
): string[] {
  if (previous === undefined || lastObserved === undefined) return withoutCodeModeTools(active);
  const added = addedSince(lastObserved, active);
  if (added === undefined) return withoutCodeModeTools(active);
  const extended = [...previous];
  for (const name of withoutCodeModeTools(added)) if (!extended.includes(name)) extended.push(name);
  return extended;
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
  let generation = 0;
  let lastObserved: string[] | undefined;

  const activate = (): void => {
    const active = pi.getActiveTools();
    host.state.previousToolNames = refreshStandalonePermissionSnapshot(
      host.state.previousToolNames,
      lastObserved,
      active,
    );
    const next = standaloneCodeModeActiveTools(active);
    if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
      pi.setActiveTools(next);
      lastObserved = pi.getActiveTools();
    } else {
      lastObserved = [...active];
    }
  };
  const prepare = (ctx: ExtensionContext): void => {
    const prepGeneration = generation;
    const preparation = withLiveCtx(() => registration.prepare(ctx));
    if (!preparation) return;
    void preparation.catch((error: BoundaryValue) => {
      if (generation !== prepGeneration) return;
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
