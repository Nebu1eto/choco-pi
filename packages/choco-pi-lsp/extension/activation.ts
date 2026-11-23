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

export interface ActivationState {
  ownEventCtx: any;
  renderInvalidator: (() => void) | undefined;
  lensEnabled: boolean;
  contextInjectionEnabled: boolean;
  lensWidgetVisible: boolean;
  mountedLensWidgetUi: LensWidgetUi | undefined;
  widgetMountFailureLogged: boolean;
  pendingForkSnapshot: PersistedWidgetState | undefined;
  pendingForkReadGuard: PersistedReadGuardState | undefined;
}

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
  readonly rememberOwnEventCtx: (ctx: any) => void;
  readonly refreshCtxDerivedPlumbing: () => void;
  readonly updateLspStatus: LspStatusUpdaters["updateLspStatus"];
  readonly captureLspStatusRepaint: LspStatusUpdaters["captureLspStatusRepaint"];
  readonly mountLensWidget: LensWidgetMount["mountLensWidget"];
  readonly unmountLensWidget: LensWidgetMount["unmountLensWidget"];
  readonly updateRuntimeIdentityFromCtx: (ctx: RuntimeValue) => void;
}

export function createActivation(
  hostPi: ExtensionAPI,
  runtime: RuntimeCoordinator,
): ExtensionActivation {
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
  installConsoleGuard();
  initI18n(pi);
  const refreshCtxDerivedPlumbing = (): void => {
    wireUserNotifier(hostPorts);
    const getLiveEmit = () => ({
      emit: hostPorts.emit.bus,
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
  wireAgentNudgeSubscriber({
    // SAFETY: The Pi host event bus supports the subscriber method shape consumed by this adapter.
    events: pi.events as Parameters<typeof wireAgentNudgeSubscriber>[0]["events"],
    getReadGuard: () => runtime.readGuard,
    dbg,
  });
  const astGrepClient = new AstGrepClient();
  const cacheManager = new CacheManager();

  const { updateLspStatus, captureLspStatusRepaint } = createLspStatusUpdaters(getLensFlag);

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
  activationState.contextInjectionEnabled = !getLensFlag("no-lens-context");
  activationState.lensWidgetVisible = globalConfig?.widget?.visible !== false;
  activationState.widgetMountFailureLogged = false;

  const { mountLensWidget, unmountLensWidget } = createLensWidgetMount(hostPorts, activationState);

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
