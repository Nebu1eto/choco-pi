import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  cdpEvaluateForContext,
  cdpNavigateContext,
  cdpSnapshotForContext,
  disconnectCdp,
  listCdpPageContexts,
  type CdpPageSnapshot,
} from "../cdp.ts";
import { getComputerUseConfig } from "../config.ts";
import type {
  EvaluateBrowserParams,
  LaunchBrowserParams,
  NavigateBrowserParams,
} from "../contract.ts";
import { isString } from "../json.ts";
import { foldToBudget, restoreOutline, type SerializedOutline } from "../outline.ts";
import { managedBrowserExecutableCandidates } from "../platform/index.ts";
import { changesBetween, renderChanges } from "../view.ts";
import {
  BROWSER_CONTEXT_PREFIX,
  MANAGED_BROWSER_READY_TIMEOUT_MS,
  isBrowserContextId,
  operationState,
  resourceScheduler,
  runtimeState,
  savedStates,
  sleep,
  storeBrowserRootRef,
  trimOrUndefined,
} from "./state-store.ts";
import type { BrowserObservationDetails, EvaluateBrowserDetails } from "./types.ts";

export function browserContextForOperation(): string | undefined {
  const contextId = operationState().contextId;
  return isBrowserContextId(contextId) ? contextId : undefined;
}

export function browserResourceKey(contextId: string): string {
  return `cdp:${contextId.slice(BROWSER_CONTEXT_PREFIX.length)}`;
}

export async function withBrowserWrite<T>(contextId: string, work: () => Promise<T>): Promise<T> {
  const state = operationState();
  const resourceKey = browserResourceKey(contextId);
  const baseEpoch = state.epoch ?? resourceScheduler.epoch(resourceKey);
  const result = await resourceScheduler.write(resourceKey, baseEpoch, async (nextEpoch) => {
    state.resourceKey = resourceKey;
    state.epoch = nextEpoch;
    return await work();
  });
  return result.value;
}

export function browserObservationResult(
  browser: CdpPageSnapshot,
  resourceKey: string,
  epoch: number,
  tool: string,
  base?: { stateId: string; outline: SerializedOutline },
  headline?: (stateId: string) => string,
): AgentToolResult<BrowserObservationDetails> {
  savedStates.set({
    stateId: browser.snapshotId,
    resourceKey,
    epoch,
    value: { kind: "browser", snapshot: browser, outline: browser.outline },
  });
  const currentOutline = restoreOutline(browser.outline);
  const transition = base
    ? changesBetween(restoreOutline(base.outline), currentOutline)
    : undefined;
  const useDiff = Boolean(transition && !transition.useFullView);
  const folded = foldToBudget(currentOutline);
  const root = {
    ref: storeBrowserRootRef(browser.contextId),
    kind: "browser_page" as const,
    title: browser.title,
    url: browser.url,
  };
  const details: BrowserObservationDetails = {
    tool,
    kind: "browser_page",
    stateId: browser.snapshotId,
    baseStateId: base?.stateId,
    view: useDiff ? "diff" : "full",
    changes: useDiff ? transition?.changes : undefined,
    root,
    outline: browser.outline,
    renderedOutline: folded.text,
  };
  const viewText = useDiff
    ? `Changes (${transition!.changedNodeCount}, ${base!.stateId} → ${browser.snapshotId}):\n${renderChanges(transition!.changes) || "(no element changes)"}\nUse state_id ${browser.snapshotId} for subsequent actions and queries.`
    : folded.text;
  return {
    content: [
      {
        type: "text",
        text: `${headline?.(browser.snapshotId) ?? `${tool} completed for ${root.ref} ${JSON.stringify(browser.title)}. State ${browser.snapshotId}.`}\n${viewText}`,
      },
    ],
    details,
  };
}

export async function refreshBrowserSnapshot(
  contextId: string,
  tool: string,
  base?: { stateId: string; outline: SerializedOutline },
  headline?: (stateId: string) => string,
): Promise<AgentToolResult<BrowserObservationDetails>> {
  const browser = await cdpSnapshotForContext(contextId);
  if (!browser)
    throw new Error(
      `Browser root '${contextId}' is no longer available. Call find_roots and observe_ui again.`,
    );
  const state = operationState();
  const resourceKey = state.resourceKey ?? `cdp:${browser.targetId}`;
  return browserObservationResult(
    browser,
    resourceKey,
    state.epoch ?? resourceScheduler.epoch(resourceKey),
    tool,
    base,
    headline,
  );
}

export async function managedBrowserExecutable(browser: "helium" | "chrome"): Promise<string> {
  const candidates = managedBrowserExecutableCandidates(browser);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  const overrideName =
    browser === "helium"
      ? "PI_COMPUTER_USE_HELIUM_EXECUTABLE"
      : "PI_COMPUTER_USE_CHROME_EXECUTABLE";
  if (trimOrUndefined(process.env[overrideName])) {
    throw new Error(
      `${browser} executable from ${overrideName} was not found or is not executable: ${candidates[0]}.`,
    );
  }
  throw new Error(`${browser} executable was not found. Set ${overrideName} to its absolute path.`);
}

export function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address instanceof Object ? address.port : 0;
      server.close(() =>
        port > 0 ? resolve(port) : reject(new Error("Could not allocate a local CDP port.")),
      );
    });
  });
}

export async function waitForCdpPort(port: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + MANAGED_BROWSER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Browser launch was aborted.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {}
    await sleep(200, signal);
  }
  throw new Error(
    `Managed browser did not expose CDP on port ${port} within ${MANAGED_BROWSER_READY_TIMEOUT_MS}ms.`,
  );
}

export async function performLaunchBrowser(
  params: LaunchBrowserParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<BrowserObservationDetails>> {
  const browser = getComputerUseConfig().managed_browser;
  const executable = await managedBrowserExecutable(browser);
  const port = await freeTcpPort();
  const requestedUrl = trimOrUndefined(params.url);
  if (requestedUrl && !/^https?:\/\//i.test(requestedUrl))
    throw new Error("launch_browser.url must be an absolute HTTP(S) URL.");
  const url = requestedUrl ?? "about:blank";
  const profileDir = path.join(os.tmpdir(), `pi-${browser}-cdp-${port}`);
  disconnectCdp();
  runtimeState.managedBrowser?.kill("SIGTERM");
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ];
  if (
    runtimeState.previousCdpPort === undefined &&
    runtimeState.managedBrowserCdpPort === undefined
  ) {
    runtimeState.previousCdpPort = process.env.PI_COMPUTER_USE_CDP_PORT;
  }
  const managedBrowser = spawn(executable, args, { stdio: "ignore", detached: false });
  managedBrowser.unref();
  runtimeState.managedBrowser = managedBrowser;
  runtimeState.managedBrowserCdpPort = String(port);
  process.env.PI_COMPUTER_USE_CDP_PORT = String(port);
  try {
    await waitForCdpPort(port, signal);
  } catch (error) {
    if (runtimeState.managedBrowser === managedBrowser) {
      runtimeState.managedBrowser = undefined;
      managedBrowser.kill("SIGTERM");
      if (runtimeState.previousCdpPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
      else process.env.PI_COMPUTER_USE_CDP_PORT = runtimeState.previousCdpPort;
      runtimeState.managedBrowserCdpPort = undefined;
      runtimeState.previousCdpPort = undefined;
    }
    throw error;
  }
  const page = (await listCdpPageContexts())[0];
  if (!page) throw new Error("Managed browser launched without a CDP page context.");
  const resourceKey = `cdp:${page.targetId}`;
  const scheduled = await resourceScheduler.read(
    resourceKey,
    async () => await cdpSnapshotForContext(page.contextId),
  );
  if (!scheduled.value) throw new Error("Managed browser page could not be observed after launch.");
  return browserObservationResult(scheduled.value, resourceKey, scheduled.epoch, "launch_browser");
}

export async function performNavigateBrowser(
  params: NavigateBrowserParams,
): Promise<AgentToolResult<BrowserObservationDetails>> {
  const contextId = browserContextForOperation();
  const url = trimOrUndefined(params.url);
  if (!contextId)
    throw new Error(
      "navigate_browser.state_id must belong to a CDP browser-page observation. Native browser windows use act_ui.",
    );
  if (!url || !/^https?:\/\//i.test(url))
    throw new Error("navigate_browser.url must be an absolute HTTP(S) URL.");
  const baseSnapshot = operationState().browserSnapshot;
  if (!baseSnapshot) throw new Error("Browser navigation requires a complete base observation.");
  return await withBrowserWrite(contextId, async () => {
    const ok = await cdpNavigateContext(contextId, url);
    if (!ok)
      throw new Error(`Browser context '${contextId}' is no longer available. Observe it again.`);
    return await refreshBrowserSnapshot(contextId, "navigate_browser", {
      stateId: baseSnapshot.snapshotId,
      outline: baseSnapshot.outline,
    });
  });
}

export async function performEvaluateBrowser(
  params: EvaluateBrowserParams,
): Promise<AgentToolResult<EvaluateBrowserDetails>> {
  const contextId = browserContextForOperation();
  const expression = isString(params.expression) ? params.expression : "";
  if (!contextId)
    throw new Error("evaluate_browser.state_id must belong to a browser observation.");
  if (!expression.trim())
    throw new Error("evaluate_browser.expression must be non-empty JavaScript.");
  const baseSnapshot = operationState().browserSnapshot;
  if (!baseSnapshot) throw new Error("Browser evaluation requires a complete base observation.");
  return await withBrowserWrite(contextId, async () => {
    const result = await cdpEvaluateForContext(contextId, expression);
    if (!result)
      throw new Error(`Browser context '${contextId}' is no longer available. Observe it again.`);
    const successor = await refreshBrowserSnapshot(contextId, "evaluate_browser", {
      stateId: baseSnapshot.snapshotId,
      outline: baseSnapshot.outline,
    });
    const details: EvaluateBrowserDetails = {
      tool: "evaluate_browser",
      baseStateId: baseSnapshot.snapshotId,
      stateId: successor.details.stateId,
      view: successor.details.view,
      changes: successor.details.changes,
      outline: successor.details.outline,
      renderedOutline: successor.details.renderedOutline,
    };
    return {
      content: [
        ...successor.content,
        { type: "text", text: `Evaluation value: ${JSON.stringify(result.value)}` },
      ],
      details,
    };
  });
}
