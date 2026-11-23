/**
 * Process-wide (module-graph) state of the extension. These were module-level
 * `let` bindings in `runtime-extension.ts`; they still live once per module graph
 * evaluation and survive factory re-activation exactly as before.
 */

import { logExtension } from "../clients/extension-log.ts";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { warmDispatchIntegration, loadDispatchIntegration } from "../clients/dispatch/lazy.ts";
import { initLSPConfig } from "../clients/lsp/config.ts";

type DispatchIntegration = Awaited<ReturnType<typeof loadDispatchIntegration>>;

/** Formerly module-level `let` bindings of `runtime-extension.ts`. */
export interface ProcessState {
  loadedDispatchIntegration: DispatchIntegration | undefined;
  // Worst event-loop block already persisted to latency.log (so we only log a
  // *new* worst freeze per turn, not the same growing max). (#192) A suspected
  // system stall (sleep/paging) never advances this high-water, so a machine
  // freeze can't permanently suppress logging of later genuine blocks. (#1122)
  lastLoggedLoopWorstMs: number;
  // Worst *genuine* (non-stall) block this session, for the health readout — the
  // per-turn histogram window (#1122) is reset each turn, so the session-scoped
  // worst is tracked here instead of read from the live histogram.
  sessionWorstRealBlockMs: number;
  // How many turns logged a suspected system stall (sleep/paging) this session —
  // surfaced in /lens-health so a machine freeze reads as environment, not a
  // choco-pi-lsp block (#1122).
  sessionSuspectedStalls: number;
  /**
   * The most recent event ctx, kept ONLY so `clients/user-notify.ts` can resolve
   * a live `ctx.ui.notify` at delivery time (#1333). Never dereferenced eagerly
   * and never captured by a long-lived closure — a session replacement swaps the
   * ctx, and `notifyUserDegradation` swallows the stale-ctx throw.
   */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
  latestEventCtx: any;
  // #484: the quiet-window task registry (clients/quiet-window.ts `_tasks`) is
  // module-level and survives factory re-activation in the same process (#473
  // in-process subagent re-binds, reload). Register the turn-summary emit task
  // ONCE (flag below, same pattern as registerCascadeTierReconcileTask) and
  // have it read the CURRENT activation's pi/flag closures through this
  // holder, refreshed on every activation — never a stale captured `pi`.
  readBridgeRegistered: boolean;
  readBridgeGetFlag: ((name: string) => boolean | string | undefined) | undefined;
  turnSummaryEmitRegistered: boolean;
  turnSummaryEmitCtx:
    | {
        pi: ExtensionAPI;
        getLensFlag: (name: string) => boolean | string | undefined;
        isLensEnabled: () => boolean;
      }
    | undefined;
}

export const processState: ProcessState = {
  loadedDispatchIntegration: undefined,
  lastLoggedLoopWorstMs: 0,
  sessionWorstRealBlockMs: 0,
  sessionSuspectedStalls: 0,
  latestEventCtx: undefined,
  readBridgeRegistered: false,
  readBridgeGetFlag: undefined,
  turnSummaryEmitRegistered: false,
  turnSummaryEmitCtx: undefined,
};

export function warmDispatchAtSessionStart(): void {
  void warmDispatchIntegration()
    .then((integration) => {
      processState.loadedDispatchIntegration = integration;
    })
    .catch((err) => {
      logExtension({
        subsystem: "dispatch",
        level: "warn",
        message: `dispatch warm failed: ${err}`,
      });
    });
}

export function resetDispatchBaselines(cwd?: string): void {
  void loadDispatchIntegration().then(({ resetDispatchBaselines }) => {
    resetDispatchBaselines(cwd);
  });
}

/** Refresh the notify target from whichever event ctx just arrived. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
export function rememberEventCtx(ctx: any): void {
  if (ctx) processState.latestEventCtx = ctx;
}

const _lspConfigInitializedCwds = new Set<string>();
const LSP_CONFIG_CWD_CAP = 128;

export async function ensureLSPConfigInitialized(cwd: string): Promise<void> {
  const normalizedCwd = path.resolve(cwd);
  if (_lspConfigInitializedCwds.has(normalizedCwd)) return;
  await initLSPConfig(normalizedCwd);
  _lspConfigInitializedCwds.add(normalizedCwd);
  while (_lspConfigInitializedCwds.size > LSP_CONFIG_CWD_CAP) {
    const oldest = _lspConfigInitializedCwds.values().next().value;
    if (oldest === undefined) break;
    _lspConfigInitializedCwds.delete(oldest);
  }
}
