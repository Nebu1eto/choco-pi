import type { RuntimeValue } from "../tools/runtime-values.ts";
import { isRuntimeUndefined } from "../tools/runtime-values.ts";
import { logExtension } from "../clients/extension-log.ts";
import { recordDegradation } from "../clients/degradation-ledger.ts";
import { assertInstallAllowed, readProjectTrustFromContext } from "../clients/project-trust.ts";
import {
  modeSuppressionNote,
  readExtensionMode,
  suppressesUserNotify,
  supportsTuiWidget,
} from "../clients/extension-mode.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDefaultHostPorts, type HostPorts } from "../clients/host-ports.ts";
import { getStableSessionId } from "./shared.ts";

export interface CreateHostPortsOptions {
  getContext: () => RuntimeValue;
  getProjectRoot?: () => string | undefined;
  getRenderInvalidator?: () => (() => void) | undefined;
}

export function createHostPorts(pi: ExtensionAPI, options: CreateHostPortsOptions): HostPorts {
  // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
  const context = () => options.getContext() as any;
  const currentMode = () => readExtensionMode(context());
  const emit = <TPayload>(channel: string, payload: TPayload): void => {
    const bus = pi.events;
    bus?.emit?.call(bus, channel, payload);
  };
  // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
  const activeTools = pi as {
    getActiveTools?: () => string[];
    setActiveTools?: (names: string[]) => void;
  };
  return createDefaultHostPorts({
    notify: {
      user(message, level) {
        const mode = currentMode();
        if (mode === "print" || mode === "json") {
          recordDegradation({
            kind: "mode-suppression",
            subject: "user degradation notice",
            reason: modeSuppressionNote(mode),
          });
          return;
        }
        context()?.ui?.notify?.(message, level ?? "warning");
      },
    },
    trust: { isProjectTrusted: () => readProjectTrustFromContext(context()) },
    mode: {
      current: currentMode,
      supportsTuiWidget: () => supportsTuiWidget(currentMode()),
      suppressesUserNotify: () => suppressesUserNotify(currentMode()),
    },
    log: {
      extension: logExtension,
      debug: (message, metadata) =>
        logExtension({ subsystem: "host", level: "debug", message, metadata }),
      sink: (subsystem) => (entry) =>
        logExtension({
          subsystem,
          level: "debug",
          message: "host sink entry",
          metadata: { entry },
        }),
    },
    emit: { bus: emit },
    status: { set: (name, value) => context()?.ui?.setStatus?.(name, value) },
    spawn: { abortSignal: () => context()?.signal, isAllowed: assertInstallAllowed },
    render: { invalidate: () => options.getRenderInvalidator?.()?.() },
    session: { id: () => getStableSessionId(context()) },
    workspace: { cwd: () => context()?.cwd, projectRoot: () => options.getProjectRoot?.() },
    flags: { get: (name) => pi.getFlag(name) },
    tools: {
      has: async (name) =>
        // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
        !isRuntimeUndefined((pi as { getTool?: (tool: string) => RuntimeValue }).getTool?.(name)),
      getActive: () => activeTools.getActiveTools?.() ?? [],
      setActive: (names) => activeTools.setActiveTools?.(names),
    },
  });
}
