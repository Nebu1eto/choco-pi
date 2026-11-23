import { logExtension } from "../clients/extension-log.ts";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { warmDispatchIntegration, loadDispatchIntegration } from "../clients/dispatch/lazy.ts";
import { initLSPConfig } from "../clients/lsp/config.ts";

type DispatchIntegration = Awaited<ReturnType<typeof loadDispatchIntegration>>;

export interface ProcessState {
  loadedDispatchIntegration: DispatchIntegration | undefined;
  lastLoggedLoopWorstMs: number;
  sessionWorstRealBlockMs: number;
  sessionSuspectedStalls: number;
  latestEventCtx: any;
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
