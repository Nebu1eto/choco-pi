import type { MouseButtonName, UiAction } from "./contract.ts";
import type { OutlineNode } from "./outline.ts";
import { toFiniteNumber } from "./platform/coerce.ts";

export type ActionTarget =
  | { ref: string }
  | { x: number; y: number }
  | { focus: { x: number; y: number } };

/**
 * `wantsForeground` records a capability need only: the action's most reliable
 * delivery would use system focus or pointer events. It never authorizes
 * foreground delivery; only a host-issued grant (see config.ts) can.
 */
export type PreparedAction =
  | {
      action: "press" | "click";
      target: ActionTarget;
      params: { button?: MouseButtonName; clickCount?: number };
      establishesFocus: boolean;
      wantsForeground: boolean;
      /**
       * A ref click on a node with no AX press action that is not a text
       * input: only pointer input can realize it, so a background `didnt` is
       * a foreground need (the helper refuses it up front when ungranted).
       */
      pointerOnly: boolean;
    }
  | {
      action: "setText";
      target: ActionTarget;
      params: { text: string };
      establishesFocus: false;
      wantsForeground: false;
    }
  | {
      action: "typeText";
      target: ActionTarget;
      params: { text: string };
      establishesFocus: false;
      wantsForeground: boolean;
    }
  | {
      action: "keypress";
      target: ActionTarget;
      params: { keys: string[] };
      establishesFocus: false;
      wantsForeground: boolean;
    }
  | {
      action: "scroll";
      target: ActionTarget;
      params: { scrollX: number; scrollY: number };
      establishesFocus: false;
      wantsForeground: false;
    }
  | {
      action: "drag";
      target: ActionTarget;
      params: { path: Array<{ x: number; y: number }> };
      establishesFocus: false;
      wantsForeground: false;
    }
  | {
      action: "moveMouse";
      target: ActionTarget;
      params: Record<string, never>;
      establishesFocus: false;
      wantsForeground: false;
    }
  | {
      action: "wait";
      params: { ms: number };
      establishesFocus: false;
      wantsForeground: false;
    };

export interface ActionState {
  currentFocus: boolean;
  /**
   * Model ref of the text input that the latest prepared ref click, press,
   * typeText, or keypress targeted. An outline-only look has no image for a
   * focus target, so later keyboard input without a ref goes to this ref.
   */
  focusRef?: string;
}

export interface ActionEnvironment {
  headless: boolean;
  image?: { width: number; height: number };
  node(ref: string): OutlineNode;
  center(node: OutlineNode): { x: number; y: number };
  validatePoint(x: number, y: number, label?: string): void;
}

function mouseButton(value: UiAction["button"]): MouseButtonName {
  return value === "right" || value === "middle" ? value : "left";
}

function clickCount(value: UiAction["clickCount"], fallback = 1): number {
  return Math.max(1, Math.min(3, Math.round(toFiniteNumber(value, fallback))));
}

function scrollDelta(value: UiAction["scrollX"]): number {
  return Math.max(-10_000, Math.min(10_000, Math.round(toFiniteNumber(value, 0))));
}

function keys(value: UiAction["keys"]): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("keypress.keys must contain at least one key.");
  return value.map((key) => String(key));
}

function path(value: UiAction["path"], env: ActionEnvironment): Array<{ x: number; y: number }> {
  if (!Array.isArray(value) || value.length < 2)
    throw new Error("drag.path must contain at least two points.");
  return value.map((point, index) => {
    const x = Array.isArray(point) ? toFiniteNumber(point[0], NaN) : toFiniteNumber(point?.x, NaN);
    const y = Array.isArray(point) ? toFiniteNumber(point[1], NaN) : toFiniteNumber(point?.y, NaN);
    env.validatePoint(x, y, `Drag point ${index + 1}`);
    return { x, y };
  });
}

function nativeTarget(
  action: UiAction,
  operation: PreparedAction["action"],
  env: ActionEnvironment,
): ActionTarget {
  if (action.ref?.trim()) {
    const node = env.node(action.ref.trim());
    const semanticClick = operation === "click" || operation === "press";
    // A text input keeps its ref: the helper focuses it through pid-scoped AX
    // instead of pointer input. Coordinates remain only for inputs without a
    // wire ref (and picture-only nodes below).
    if (semanticClick && node.isTextInput && !node.wireRef) {
      const point = env.center(node);
      env.validatePoint(point.x, point.y);
      return point;
    }
    const onlyIncidentalActions = node.actions.every(
      (candidate) => candidate === "AXShowMenu" || candidate === "AXScrollToVisible",
    );
    if (
      node.wireRef &&
      !node.pictureOnly &&
      (!semanticClick ||
        node.canPress ||
        node.canFocus ||
        node.canSetValue ||
        !onlyIncidentalActions)
    ) {
      return { ref: node.wireRef };
    }
    const point = env.center(node);
    env.validatePoint(point.x, point.y);
    return point;
  }
  const x = toFiniteNumber(action.x, NaN);
  const y = toFiniteNumber(action.y, NaN);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    env.validatePoint(x, y);
    return { x, y };
  }
  if (operation === "drag" && action.path?.length) return path(action.path, env)[0];
  throw new Error(`${operation} requires either ref or both x and y.`);
}

function focusedTarget(env: ActionEnvironment): ActionTarget {
  if (!env.image) throw new Error("Focused keyboard input requires an image-bearing state.");
  return { focus: { x: Math.floor(env.image.width / 2), y: Math.floor(env.image.height / 2) } };
}

/** The ref's node when it is a text input the helper can target by ref. */
function refTextInput(ref: string, env: ActionEnvironment): string | undefined {
  const node = env.node(ref);
  return node.isTextInput && node.wireRef && !node.pictureOnly ? ref : undefined;
}

/** No AX route for a click: no press action and no text-input focus path. */
function lacksAxClickAction(node: OutlineNode): boolean {
  return !node.canPress && !node.isTextInput;
}

function containsEditable(node: OutlineNode): boolean {
  if (node.canSetValue || node.role.toLowerCase().includes("text")) return true;
  return node.children.some(containsEditable);
}

export function prepareAction(
  action: UiAction,
  state: ActionState,
  env: ActionEnvironment,
): PreparedAction {
  const operation = action.action;
  const usesCurrentFocus =
    !env.headless &&
    state.currentFocus &&
    !action.ref &&
    (operation === "typeText" || operation === "keypress");
  // Without an image there is no focus point; keyboard input then targets the
  // text input that the preceding ref action focused, exactly as if the model
  // had named that ref.
  const focusRef = usesCurrentFocus && !env.image ? state.focusRef : undefined;
  const retargeted = focusRef ? { ...action, ref: focusRef } : action;
  const target =
    usesCurrentFocus && !focusRef ? focusedTarget(env) : nativeTarget(retargeted, operation, env);
  const ref = retargeted.ref?.trim();
  if (operation === "click" || operation === "press")
    state.focusRef = ref ? refTextInput(ref, env) : undefined;
  else if ((operation === "typeText" || operation === "keypress") && ref)
    state.focusRef = refTextInput(ref, env);
  const establishesFocus =
    !env.headless &&
    Boolean(action.ref) &&
    (operation === "click" || operation === "press") &&
    containsEditable(env.node(action.ref!));
  const wantsForeground =
    !env.headless && (operation === "click" || operation === "press") && "x" in target;
  const pointerOnly =
    (operation === "click" || operation === "press") &&
    "ref" in target &&
    ref !== undefined &&
    lacksAxClickAction(env.node(ref));

  switch (operation) {
    case "press":
    case "click":
      return {
        action: operation,
        target,
        params: { button: mouseButton(action.button), clickCount: clickCount(action.clickCount) },
        establishesFocus,
        wantsForeground,
        pointerOnly,
      };
    case "setText":
      return {
        action: operation,
        target,
        params: { text: action.text ?? "" },
        establishesFocus: false,
        wantsForeground: false,
      };
    case "typeText":
      return {
        action: operation,
        target,
        params: { text: action.text ?? "" },
        establishesFocus: false,
        wantsForeground: "focus" in target,
      };
    case "keypress":
      return {
        action: operation,
        target,
        params: { keys: keys(action.keys) },
        establishesFocus: false,
        wantsForeground: "focus" in target,
      };
    case "scroll":
      return {
        action: operation,
        target,
        params: { scrollX: scrollDelta(action.scrollX), scrollY: scrollDelta(action.scrollY) },
        establishesFocus: false,
        wantsForeground: false,
      };
    case "drag":
      return {
        action: operation,
        target,
        params: { path: path(action.path, env) },
        establishesFocus: false,
        wantsForeground: false,
      };
    case "moveMouse":
      return {
        action: operation,
        target,
        params: {},
        establishesFocus: false,
        wantsForeground: false,
      };
  }
}

export function outcomeAfterCheck(
  current: "worked" | "didnt" | "unknown",
  check: "verified" | "preexisting" | "failed",
): "worked" | "didnt" | "unknown" {
  if (check === "verified") return "worked";
  if (check === "failed") return "didnt";
  return current;
}

export function outcomeAfterObservedValues(
  current: "worked" | "didnt" | "unknown",
  actions: UiAction[],
  valueForRef: (ref: string) => string | undefined,
): "worked" | "didnt" | "unknown" {
  if (actions.length === 0 || actions.some((action) => action.action !== "setText" || !action.ref))
    return current;
  const matches = actions.every((action) => valueForRef(action.ref!) === (action.text ?? ""));
  return matches ? "worked" : current;
}
