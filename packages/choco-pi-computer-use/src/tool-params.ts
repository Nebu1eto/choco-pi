import type {
  ActParams,
  EvaluateBrowserParams,
  ExpandUiParams,
  FindParams,
  InspectUiParams,
  MouseButtonName,
  NavigateBrowserParams,
  ReadTextParams,
  SearchUiParams,
  UiAction,
  UiCondition,
  WaitForParams,
} from "./contract.ts";

/**
 * Tool inputs and outputs use snake_case. The bridge, the action union and the
 * native helper protocol keep their camelCase names, so this module is the only
 * place that maps between the two: tool parameters are converted before they
 * reach the bridge, and action names are converted back when they are written
 * into model-visible text.
 */

/** Action names as the model spells them; the internal action union keeps its names. */
const WIRE_TO_INTERNAL_ACTION = {
  press: "press",
  click: "click",
  set_text: "setText",
  type_text: "typeText",
  keypress: "keypress",
  scroll: "scroll",
  drag: "drag",
  move_mouse: "moveMouse",
} as const satisfies Record<string, UiAction["action"]>;

type WireActionName = keyof typeof WIRE_TO_INTERNAL_ACTION;

const INTERNAL_TO_WIRE_ACTION = new Map([
  ["setText", "set_text"],
  ["typeText", "type_text"],
  ["moveMouse", "move_mouse"],
]);

/** The model-facing spelling of an internal action name; other names pass through. */
export function actionLabel(action: string): string {
  return INTERNAL_TO_WIRE_ACTION.get(action) ?? action;
}

export interface WireFindParams {
  text?: string;
  app?: string;
  bundle_id?: string;
  pid?: number;
  kind?: FindParams["kind"];
}

export interface WireStateParams {
  state_id?: string;
}

export interface WireNavigateBrowserParams extends WireStateParams {
  url: string;
}

export interface WireEvaluateBrowserParams {
  state_id: string;
  expression: string;
}

export interface WireSearchUiParams extends WireStateParams {
  text?: string;
  role?: string;
  capability?: string;
}

export interface WireExpandUiParams extends WireStateParams {
  ref: string;
  depth?: number;
}

export interface WireInspectUiParams extends WireStateParams {
  ref: string;
}

export interface WireReadTextParams extends WireStateParams {
  ref: string;
  offset?: number;
}

export interface WireCondition {
  ref?: string;
  scope_ref?: string;
  text?: string;
  role?: string;
  value?: string;
  until?: "present" | "absent";
  timeout_ms?: number;
}

export interface WireWaitForParams extends WireCondition, WireStateParams {}

export interface WireUiAction {
  action: WireActionName;
  ref?: string;
  x?: number;
  y?: number;
  text?: string;
  keys?: string[];
  scroll_x?: number;
  scroll_y?: number;
  path?: Array<{ x: number; y: number }>;
  button?: MouseButtonName;
  click_count?: number;
}

export interface WireActParams extends WireStateParams {
  actions: WireUiAction[];
  expect?: WireCondition;
}

export function toFindParams(params: WireFindParams): FindParams {
  return {
    ...(params.text !== undefined && { text: params.text }),
    ...(params.app !== undefined && { app: params.app }),
    ...(params.bundle_id !== undefined && { bundleId: params.bundle_id }),
    ...(params.pid !== undefined && { pid: params.pid }),
    ...(params.kind !== undefined && { kind: params.kind }),
  };
}

// Capability labels renamed to snake_case; reject the former spellings instead of letting
// them silently match nothing.
const RENAMED_CAPABILITIES = new Map([
  ["setvalue", "set_value"],
  ["settext", "set_text"],
  ["textinput", "text_input"],
]);

export function toSearchUiParams(params: WireSearchUiParams): SearchUiParams {
  const renamed =
    params.capability === undefined
      ? undefined
      : RENAMED_CAPABILITIES.get(params.capability.toLowerCase());
  if (renamed !== undefined)
    throw new Error(
      `search_ui capability "${params.capability}" is not supported; use "${renamed}".`,
    );
  return {
    ...(params.text !== undefined && { text: params.text }),
    ...(params.role !== undefined && { role: params.role }),
    ...(params.capability !== undefined && { capability: params.capability }),
    ...(params.state_id !== undefined && { stateId: params.state_id }),
  };
}

export function toExpandUiParams(params: WireExpandUiParams): ExpandUiParams {
  return {
    ref: params.ref,
    ...(params.depth !== undefined && { depth: params.depth }),
    ...(params.state_id !== undefined && { stateId: params.state_id }),
  };
}

export function toInspectUiParams(params: WireInspectUiParams): InspectUiParams {
  return {
    ref: params.ref,
    ...(params.state_id !== undefined && { stateId: params.state_id }),
  };
}

export function toReadTextParams(params: WireReadTextParams): ReadTextParams {
  return {
    ref: params.ref,
    ...(params.offset !== undefined && { offset: params.offset }),
    ...(params.state_id !== undefined && { stateId: params.state_id }),
  };
}

export function toNavigateBrowserParams(params: WireNavigateBrowserParams): NavigateBrowserParams {
  return {
    url: params.url,
    ...(params.state_id !== undefined && { stateId: params.state_id }),
  };
}

export function toEvaluateBrowserParams(params: WireEvaluateBrowserParams): EvaluateBrowserParams {
  return { stateId: params.state_id, expression: params.expression };
}

function toCondition(params: WireCondition): UiCondition {
  return {
    ...(params.ref !== undefined && { ref: params.ref }),
    ...(params.scope_ref !== undefined && { scopeRef: params.scope_ref }),
    ...(params.text !== undefined && { text: params.text }),
    ...(params.role !== undefined && { role: params.role }),
    ...(params.value !== undefined && { value: params.value }),
    ...(params.until !== undefined && { until: params.until }),
    ...(params.timeout_ms !== undefined && { timeoutMs: params.timeout_ms }),
  };
}

export function toWaitForParams(params: WireWaitForParams): WaitForParams {
  return {
    ...toCondition(params),
    ...(params.state_id !== undefined && { stateId: params.state_id }),
  };
}

function toAction(action: WireUiAction): UiAction {
  return {
    action: WIRE_TO_INTERNAL_ACTION[action.action],
    ...(action.ref !== undefined && { ref: action.ref }),
    ...(action.x !== undefined && { x: action.x }),
    ...(action.y !== undefined && { y: action.y }),
    ...(action.text !== undefined && { text: action.text }),
    ...(action.keys !== undefined && { keys: action.keys }),
    ...(action.scroll_x !== undefined && { scrollX: action.scroll_x }),
    ...(action.scroll_y !== undefined && { scrollY: action.scroll_y }),
    ...(action.path !== undefined && { path: action.path }),
    ...(action.button !== undefined && { button: action.button }),
    ...(action.click_count !== undefined && { clickCount: action.click_count }),
  };
}

export function toActParams(params: WireActParams): ActParams {
  return {
    actions: params.actions.map(toAction),
    ...(params.expect !== undefined && { expect: toCondition(params.expect) }),
    ...(params.state_id !== undefined && { stateId: params.state_id }),
  };
}
