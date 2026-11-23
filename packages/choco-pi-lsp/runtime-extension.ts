import "./clients/console-guard-install.ts";
import {
  closeModuleLoadConsoleWindow,
  runInConsoleCaptureWindow,
} from "./clients/extension-log.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RuntimeCoordinator } from "./clients/runtime-coordinator.ts";
import { logLatency } from "./clients/latency-logger.ts";
import {
  getPiLensEvalMs,
  markPiLensLoaded,
  CHOCO_PI_LSP_HOST_BOOT_MS,
  CHOCO_PI_LSP_LOADED_FROM,
} from "./clients/startup-timing.ts";
import { startEventLoopMonitor } from "./clients/event-loop-monitor.ts";
import { createActivation } from "./extension/activation.ts";
import { registerReadGuardCommands, registerToggleCommands } from "./extension/commands.ts";
import { registerCacheUsageHook, registerContextHook } from "./extension/context-hook.ts";
import {
  registerQuietWindowHooks,
  registerTurnSummaryRenderer,
} from "./extension/quiet-window-hooks.ts";
import { registerReportCommands } from "./extension/report-commands.ts";
import {
  registerSessionShutdown,
  registerSessionStartHooks,
} from "./extension/session-lifecycle.ts";
import { dbg } from "./extension/shared.ts";
import { registerToolHooks } from "./extension/tool-hooks.ts";
import { registerTools } from "./extension/tool-registrations.ts";
import { registerTurnHooks } from "./extension/turn-hooks.ts";

export { createHostPorts, type CreateHostPortsOptions } from "./extension/host-ports.ts";

// First executable statement: every import above has been evaluated, so the
// full load/transpile cost has been paid. Capture it now.
const CHOCO_PI_LSP_LOAD_MS = markPiLensLoaded();
const CHOCO_PI_LSP_EVAL_MS = getPiLensEvalMs() ?? 0;
// Start the event-loop occupancy monitor as early as possible so startup
// blocks are captured. Native histogram — no per-event overhead. (#192)
startEventLoopMonitor();

// Log how long pi took to load choco-pi-lsp — the jiti transpile of every module is
// paid by now. Source mode includes transpiling ~200 .ts files; the precompiled
// dist build does not, so the delta is the #182 startup win. One line per load.
dbg(
  `choco-pi-lsp loaded: ${CHOCO_PI_LSP_LOAD_MS}ms after process start (from ${CHOCO_PI_LSP_LOADED_FROM})`,
);
logLatency({
  type: "phase",
  filePath: "<choco-pi-lsp>",
  phase: "extension_loaded",
  durationMs: CHOCO_PI_LSP_LOAD_MS,
  metadata: { loadedFrom: CHOCO_PI_LSP_LOADED_FROM },
});
logLatency({
  type: "phase",
  filePath: "<choco-pi-lsp>",
  phase: "host_boot",
  durationMs: CHOCO_PI_LSP_HOST_BOOT_MS,
  metadata: { loadedFrom: CHOCO_PI_LSP_LOADED_FROM },
});
logLatency({
  type: "phase",
  filePath: "<choco-pi-lsp>",
  phase: "extension_eval",
  durationMs: CHOCO_PI_LSP_EVAL_MS,
  metadata: { loadedFrom: CHOCO_PI_LSP_LOADED_FROM },
});

// --- State ---

const runtime = new RuntimeCoordinator();

// --- Extension ---

/**
 * The extension activation. Always reached through the default export below,
 * which runs it inside a console capture window (#1434).
 */
function activateExtension(hostPi: ExtensionAPI) {
  // Order matters and mirrors the former single closure: activation setup
  // (capture-window wrap, host ports, plumbing, flags, read bridge, state),
  // then renderer, commands, tools, and event hooks in registration order.
  const activation = createActivation(hostPi, runtime);
  registerTurnSummaryRenderer(activation);
  registerToggleCommands(activation);
  registerReportCommands(activation);
  registerReadGuardCommands(activation);
  const lazyTools = registerTools(activation);
  registerSessionStartHooks(activation, lazyTools);
  registerToolHooks(activation);
  registerTurnHooks(activation);
  registerQuietWindowHooks(activation);
  registerSessionShutdown(activation);
  registerCacheUsageHook(activation);
  registerContextHook(activation);
}

export default function (pi: ExtensionAPI) {
  return runInConsoleCaptureWindow(() => activateExtension(pi));
}

// #1434: the import graph has finished evaluating, so the module window closes
// here. Everything after this point is host-owned execution, until one of
// choco-pi-lsp's own entry points opens its own window. This must stay the last
// statement in index.ts.
closeModuleLoadConsoleWindow();
