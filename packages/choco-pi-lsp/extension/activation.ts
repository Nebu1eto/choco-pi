/**
 * One extension activation: the wrapped host API, host ports, flag resolution,
 * shared clients, and the mutable per-activation state that the former
 * `activateExtension` closure held in local `let` bindings.
 *
 * Extracted from `runtime-extension.ts`; behavior is unchanged.
 */

import type { RuntimeValue } from "../tools/runtime-values.ts";
import { installConsoleGuard, withConsoleCaptureWindows } from "../clients/extension-log.ts";
import { wireUserNotifier } from "../clients/user-notify.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type HostPorts } from "../clients/host-ports.ts";
import { AstGrepClient } from "../clients/ast-grep-client.ts";
import { CacheManager } from "../clients/cache-manager.ts";
import { ContextInjectionHistory } from "../clients/context-injection-history.ts";
import { type PersistedWidgetState, setRenderCallback } from "../clients/widget-state.ts";
import type { PersistedReadGuardState } from "../clients/read-guard.ts";
import { registerReadBridge } from "../clients/read-bridge.ts";
import { isExternalOrVendorFile } from "../clients/path-utils.ts";
import { isPathIgnoredByProject } from "../clients/file-utils.ts";
import {
  loadPiLensGlobalConfig,
  resolvePiLensFlag,
  resolvePiLensFlagWithSource,
} from "../clients/lsp-config.ts";
import { LENS_FLAGS } from "../clients/lsp-flag-registry.ts";
import { loadPiLensProjectConfig } from "../clients/project-lsp-config.ts";
import { initLensEventsGetter } from "../clients/lsp-events.ts";
import { wireBusEmitterGetter } from "../clients/bus-publish.ts";
import { wireDiagnosticsBusEmitterGetter } from "../clients/diagnostics-publish.ts";
import { wireDispositionBusEmitterGetter } from "../clients/disposition-publish.ts";
import { wireFormatEventsBusEmitterGetter } from "../clients/format-events-publish.ts";
import { wireAgentNudgeSubscriber } from "../clients/agent-nudge.ts";
import { readHostModelIdentity, RuntimeCoordinator } from "../clients/runtime-coordinator.ts";
import { initI18n } from "../i18n.ts";
import { createHostPorts } from "./host-ports.ts";
import { processState, rememberEventCtx } from "./process-state.ts";
import { dbg } from "./shared.ts";
import {
  createLensWidgetMount,
  createLspStatusUpdaters,
  type LensWidgetMount,
  type LensWidgetUi,
  type LspStatusUpdaters,
} from "./widget-status.ts";

/** Mutable per-activation state (formerly `let` bindings in `activateExtension`). */
export interface ActivationState {
  /**
   * Event contexts belong to the activation that owns this factory closure.
   * The process-global latest ctx remains only a boot-window fallback.
   */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
  ownEventCtx: any;
  renderInvalidator: (() => void) | undefined;
  lensEnabled: boolean;
  /** Automatic context injection (the `context` hook); independent of `lensEnabled`. */
  contextInjectionEnabled: boolean;
  lensWidgetVisible: boolean;
  mountedLensWidgetUi: LensWidgetUi | undefined;
  widgetMountFailureLogged: boolean;
  /**
   * #190 Phase 2: snapshot of the source session's diagnostics, captured at
   * `session_before_fork` and adopted by the forked session at the subsequent
   * `session_start` (reason="fork"). In-memory hand-off (same process) — avoids
   * deriving the source id from a file path (the id lives in the file header).
   */
  pendingForkSnapshot: PersistedWidgetState | undefined;
  /**
   * #1041: the source session's read-guard read-set, stashed at
   * `session_before_fork` alongside the widget snapshot so a forked session
   * adopts its parent's read history (same in-memory hand-off pattern).
   */
  pendingForkReadGuard: PersistedReadGuardState | undefined;
}

/** Everything the registration modules share from one activation. */
export interface ExtensionActivation {
  readonly pi: ExtensionAPI;
  readonly hostPorts: HostPorts;
  readonly runtime: RuntimeCoordinator;
  readonly contextInjectionHistory: ContextInjectionHistory<{ role: string; content: unknown }>;
  readonly astGrepClient: AstGrepClient;
  readonly cacheManager: CacheManager;
  readonly activationState: ActivationState;
  readonly getLensFlag: (name: string, editedFilePath?: string) => boolean | string | undefined;
  readonly getLensFlagSource: (
    name: string,
    editedFilePath?: string,
  ) => ReturnType<typeof resolvePiLensFlagWithSource>["source"];
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
  readonly rememberOwnEventCtx: (ctx: any) => void;
  readonly refreshCtxDerivedPlumbing: () => void;
  readonly updateLspStatus: LspStatusUpdaters["updateLspStatus"];
  readonly captureLspStatusRepaint: LspStatusUpdaters["captureLspStatusRepaint"];
  readonly mountLensWidget: LensWidgetMount["mountLensWidget"];
  readonly unmountLensWidget: LensWidgetMount["unmountLensWidget"];
  readonly updateRuntimeIdentityFromCtx: (ctx: RuntimeValue) => void;
}

/**
 * Build one activation: the first part of the former `activateExtension`, in
 * its original order (capture-window wrap, host ports, plumbing, flags, read
 * bridge, per-activation state).
 */
export function createActivation(
  hostPi: ExtensionAPI,
  runtime: RuntimeCoordinator,
): ExtensionActivation {
  // #1434: every choco-pi-lsp entry point registered through this API runs inside a
  // capture window, so a dependency writing to console during our work reaches
  // the log instead of pi's frame. Host-initiated output stays on the real
  // console, because it runs outside every window.
  const pi = withConsoleCaptureWindows(hostPi);
  const contextInjectionHistory = new ContextInjectionHistory<{ role: string; content: unknown }>();
  const activationState: ActivationState = {
    ownEventCtx: undefined,
    renderInvalidator: undefined,
    lensEnabled: false,
    contextInjectionEnabled: false,
    lensWidgetVisible: false,
    mountedLensWidgetUi: undefined,
    widgetMountFailureLogged: false,
    pendingForkSnapshot: undefined,
    pendingForkReadGuard: undefined,
  };
  // Event contexts belong to the activation that owns this factory closure.
  // The process-global latest ctx remains only a boot-window fallback.
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
  const rememberOwnEventCtx = (ctx: any): void => {
    if (!ctx) return;
    activationState.ownEventCtx = ctx;
    rememberEventCtx(ctx);
  };
  const hostPorts = createHostPorts(pi, {
    getContext: () => processState.latestEventCtx,
    getProjectRoot: () => runtime.projectRoot,
    getRenderInvalidator: () => activationState.renderInvalidator,
  });
  // #1333 — defense in depth, the pi-side mirror of `mcp/server.ts`'s
  // `console.log = console.error` guard. pi owns the terminal (raw mode +
  // cursor-addressed diff repaints), so a raw byte from ANY transitively
  // loaded module desyncs its screen model. choco-pi-lsp's own sites are migrated
  // to real ndjson sinks; this net catches everything else. The REAL install
  // happens at import time via `clients/console-guard-install.js` (index.ts's
  // first import) so module-init writes are covered too; this call is an
  // idempotent re-install for tests that invoke the factory directly. No-op
  // under test mode and under `CHOCO_PI_LSP_CONSOLE_GUARD=0`.
  installConsoleGuard();
  initI18n(pi);
  // #1333 HUMAN channel: user-facing degradations found deep in clients/
  // (invalid config, offline grammar fetch, WASM abort) reach the user
  // through the host's own render path. Per the #338/#798 detached-callback
  // rule the notifier is resolved from the LATEST event ctx at delivery time,
  // never captured once — a session replacement invalidates the old ctx.ui.
  // #1334 S2: the ports notifier owns mode suppression + live-ctx resolution
  // (per-call, never captured -- the #338/#798 detached-callback rule).
  const refreshCtxDerivedPlumbing = (): void => {
    // These targets are module singletons, while hostPorts is scoped to this
    // extension activation. A sibling activation can overwrite them and then
    // become stale; every session_start must reclaim them before #473 can
    // return early for a concurrent in-process subagent. (#1383)
    wireUserNotifier(hostPorts);
    const getLiveEmit = () => ({
      emit: hostPorts.emit.bus,
      // H2 (#1415 review): NOT `?? latestEventCtx`. The global belongs to
      // whichever activation last received an event — a SIBLING activation
      // after a replacement, with no relation to this closure's `pi.events`.
      // Falling back to it pairs a live emitter with a foreign ctx, which
      // the stale-session probe cannot catch (it looks live) and silently
      // drops every publish until this activation's own first handler
      // fires. An unset `ownEventCtx` (this activation's own boot window)
      // must probe undefined -> "ready" -> delivery attempted, exactly like
      // today, not borrow a sibling's ctx.
      ctx: activationState.ownEventCtx,
    });
    initLensEventsGetter(getLiveEmit);
    wireBusEmitterGetter(getLiveEmit);
    wireDiagnosticsBusEmitterGetter(getLiveEmit);
    wireDispositionBusEmitterGetter(getLiveEmit);
    wireFormatEventsBusEmitterGetter(getLiveEmit);
    setRenderCallback(() => hostPorts.render.invalidate());
  };
  refreshCtxDerivedPlumbing();
  // #485: read-only bus subscriber — never publishes, so the #482 loop guard
  // (ingest -> write -> publish) has no write side to trip here.
  // #1434 residual risk, accepted not fixed: `pi.events` is the raw host bus,
  // not `pi` itself, so `withConsoleCaptureWindows` does not wrap its
  // `subscribe`. A future subscriber body that logs would bypass the capture
  // window. Subscribers registered on this bus are subscribe-only today
  // (never publish), so nothing currently exercises that gap — revisit if
  // `pi.events` grows a subscriber that does real work inside its callback.
  wireAgentNudgeSubscriber({
    // SAFETY: The Pi host event bus supports the subscriber method shape consumed by this adapter.
    events: pi.events as Parameters<typeof wireAgentNudgeSubscriber>[0]["events"],
    getReadGuard: () => runtime.readGuard,
    dbg,
  });
  const astGrepClient = new AstGrepClient();
  const cacheManager = new CacheManager();

  const { updateLspStatus, captureLspStatusRepaint } = createLspStatusUpdaters(getLensFlag);

  // --- Flags ---

  // #166: registration is driven by clients/lsp-flag-registry.ts, the same
  // declarative array that drives config parsing and precedence resolution, so
  // a flag cannot exist on the CLI without a config key (or vice versa).
  for (const spec of LENS_FLAGS) {
    pi.registerFlag(spec.name, {
      description: spec.description,
      type: "boolean",
      default: spec.default,
    });
  }

  const globalConfig = loadPiLensGlobalConfig();
  function getLensFlag(name: string, editedFilePath?: string): boolean | string | undefined {
    const projectConfig = loadPiLensProjectConfig(runtime.projectRoot);
    return resolvePiLensFlag(
      name,
      pi.getFlag(name),
      globalConfig,
      projectConfig,
      editedFilePath,
      runtime.projectRoot,
    );
  }

  // #792: sibling of getLensFlag reporting WHICH config tier decided the
  // value, so mutation-skip dbg lines can name it (e.g. "source=project")
  // instead of a bare boolean. Threaded to pipeline/agent_end via the
  // optional `getFlagSource` field — zero effect on getLensFlag itself.
  function getLensFlagSource(
    name: string,
    editedFilePath?: string,
  ): ReturnType<typeof resolvePiLensFlagWithSource>["source"] {
    const projectConfig = loadPiLensProjectConfig(runtime.projectRoot);
    return resolvePiLensFlagWithSource(
      name,
      pi.getFlag(name),
      globalConfig,
      projectConfig,
      editedFilePath,
      runtime.projectRoot,
    ).source;
  }

  activationState.lensEnabled = !getLensFlag("no-lens");

  // Read-bridge: refresh the flag getter on every factory activation so the
  // live getLensFlag closure is always used (same pattern as _turnSummaryEmitCtx).
  // Register the singleton once — subsequent activations only refresh the getter.
  processState.readBridgeGetFlag = getLensFlag;
  if (!processState.readBridgeRegistered) {
    processState.readBridgeRegistered = true;
    registerReadBridge({
      getReadGuard: () => runtime.readGuard,
      getTurnIndex: () => runtime.turnIndex,
      peekWriteIndex: () => runtime.peekWriteIndex(),
      isRecordable(filePath: string): boolean {
        if (processState.readBridgeGetFlag?.("no-read-guard")) return false;
        if (isPathIgnoredByProject(filePath, runtime.projectRoot, false)) return false;
        if (isExternalOrVendorFile(filePath, runtime.projectRoot)) return false;
        return true;
      },
    });
  }
  // Automatic context injection (the `context` hook). Independent of lensEnabled
  // so tools/LSP/read-guard/formatting keep running when it is off. Precedence:
  // env override → CLI flag → global config, all resolved inside getLensFlag
  // from the registry's CHOCO_PI_LSP_NO_CONTEXT_INJECTION env binding (#166).
  activationState.contextInjectionEnabled = !getLensFlag("no-lens-context");
  activationState.lensWidgetVisible = globalConfig?.widget?.visible !== false;
  activationState.widgetMountFailureLogged = false;

  const { mountLensWidget, unmountLensWidget } = createLensWidgetMount(hostPorts, activationState);

  /**
   * Adopt this activation's telemetry identity from the host CONTEXT (#1655
   * item 2).
   *
   * This used to read `provider`/`model`/`sessionId`/`session.id`/`id` off the
   * EVENT. pi sets none of them on either event that called it: `session_start`
   * is `{ type, reason }`
   * (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:152`,
   * `:2072`), and `tool_result` is exactly
   * `type`/`toolName`/`toolCallId`/`input`/`content`/`details`/`isError`/`usage`
   * (`dist/core/agent-session.js:243-256`, source
   * `src/core/agent-session.ts:502-516`). So every call passed all-undefined,
   * `setTelemetryIdentity` ignored it, and `runtime.telemetryModel` stayed
   * `"unknown"` for the whole session against a real host.
   *
   * The ctx DOES carry the model. `ExtensionContext.model` is the live `Model`
   * (`dist/core/extensions/runner.js:488-491` → `AgentSession.model`, `:580-582`)
   * with `id` and `provider` (`@earendil-works/pi-ai/dist/types.d.ts:661-667`).
   *
   * SESSION ID IS DELIBERATELY NOT SET HERE. `runtime.setSessionLifecycle`
   * already pins it from `ctx.sessionManager.getSessionId()` inside
   * `session_start`, behind the #473 concurrent-secondary guard. Adopting it
   * again from a `tool_result` ctx would let a concurrent in-process secondary
   * session overwrite the parent's identity on every tool result — the exact
   * clobber that guard exists to prevent.
   */
  const updateRuntimeIdentityFromCtx = (ctx: RuntimeValue): void => {
    runtime.setTelemetryIdentity(readHostModelIdentity(ctx));
  };

  return {
    pi,
    hostPorts,
    runtime,
    contextInjectionHistory,
    astGrepClient,
    cacheManager,
    activationState,
    getLensFlag,
    getLensFlagSource,
    rememberOwnEventCtx,
    refreshCtxDerivedPlumbing,
    updateLspStatus,
    captureLspStatusRepaint,
    mountLensWidget,
    unmountLensWidget,
    updateRuntimeIdentityFromCtx,
  };
}
