import type { ActParams } from "./contract.ts";
import {
  performEvaluateBrowser,
  performLaunchBrowser,
  performNavigateBrowser,
} from "./bridge/browser-session.ts";
import {
  performExpandUi,
  performInspectUi,
  performObserve,
  performSearchUi,
} from "./bridge/observation.ts";
import { performReadText, performWaitFor } from "./bridge/read-wait.ts";
import {
  makeToolExecutor,
  performAct,
  reconstructStateFromBranch,
} from "./bridge/session-lifecycle.ts";
import { ensureComputerUseSetup, shutdownComputerUseSession } from "./bridge/state-store.ts";
import { performListWindows } from "./bridge/targets.ts";
import {
  ObservationRefreshRequiredError,
  type BrowserObservationDetails,
  type ComputerUseDetails,
  type ObservationRefreshRequirement,
  type TerminalBrowserActionDetails,
  type TerminalDesktopActionDetails,
} from "./bridge/types.ts";

export type {
  ActParams,
  EvaluateBrowserParams,
  ExpandUiParams,
  FindParams,
  ImageMode,
  InspectUiParams,
  LaunchBrowserParams,
  MouseButtonName,
  NavigateBrowserParams,
  ObserveParams,
  ObserveTargetParams,
  ReadTextParams,
  RootSelector,
  SearchUiParams,
  StateTargetParams,
  UiAction,
  WaitForParams,
} from "./contract.ts";

export {
  ObservationRefreshRequiredError,
  ensureComputerUseSetup,
  reconstructStateFromBranch,
  shutdownComputerUseSession,
  type ObservationRefreshRequirement,
};

export const executeFind = makeToolExecutor("find_roots", performListWindows);
export const executeReadText = makeToolExecutor("read_text", performReadText);
export const executeWaitFor = makeToolExecutor("wait_for", performWaitFor);
export const executeObserve = makeToolExecutor("observe_ui", performObserve);
export const executeSearchUi = makeToolExecutor("search_ui", performSearchUi);
export const executeExpandUi = makeToolExecutor("expand_ui", performExpandUi);
export const executeInspectUi = makeToolExecutor("inspect_ui", performInspectUi);
export const executeAct = makeToolExecutor<
  ActParams,
  | ComputerUseDetails
  | TerminalDesktopActionDetails
  | BrowserObservationDetails
  | TerminalBrowserActionDetails
>("act_ui", performAct);
export const executeNavigateBrowser = makeToolExecutor("navigate_browser", performNavigateBrowser);
export const executeEvaluateBrowser = makeToolExecutor("evaluate_browser", performEvaluateBrowser);
export const executeLaunchBrowser = makeToolExecutor("launch_browser", performLaunchBrowser);
