import type { MouseButtonName, UiAction } from "./contract.ts";
import type { OutlineNode } from "./outline.ts";
import { toFiniteNumber } from "./platform/coerce.ts";
import { actionLabel } from "./tool-params.ts";

export type ActionTarget =
  | { ref: string }
  | { x: number; y: number }
  | { focus: { x: number; y: number } | Record<string, never> };

export type PreparedAction =
  | {
      action: "press" | "click";
      target: ActionTarget;
      params: { button?: MouseButtonName; clickCount?: number };
      establishesFocus: boolean;
      wantsForeground: boolean;
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
      implicitFocus: boolean;
    }
  | {
      action: "keypress";
      target: ActionTarget;
      params: { keys: string[] };
      establishesFocus: false;
      wantsForeground: boolean;
      implicitFocus: boolean;
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
    const x = toFiniteNumber(point.x, NaN);
    const y = toFiniteNumber(point.y, NaN);
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
  if (operation === "typeText" || operation === "keypress")
    throw new Error(
      `${actionLabel(operation)} has no usable ref; omit ref to use the app's focused element, or pass an @e ref.`,
    );
  throw new Error(`${actionLabel(operation)} requires either ref or both x and y.`);
}

function focusedTarget(env: ActionEnvironment): ActionTarget {
  if (!env.image) return { focus: {} };
  return { focus: { x: Math.floor(env.image.width / 2), y: Math.floor(env.image.height / 2) } };
}

export function headlessKeyboardRefusal(operation: "typeText" | "keypress"): string {
  return `${actionLabel(operation)} without ref is unavailable in headless mode: headless delivery cannot send keys to the app's focused element. Pass the @e ref of the control that should receive the input.`;
}

function refTextInput(ref: string, env: ActionEnvironment): string | undefined {
  const node = env.node(ref);
  return node.isTextInput && node.wireRef && !node.pictureOnly ? ref : undefined;
}

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
  const keyboard = operation === "typeText" || operation === "keypress";
  const targetless = keyboard && !action.ref?.trim();
  if (targetless && env.headless) throw new Error(headlessKeyboardRefusal(operation));
  const usesCurrentFocus = targetless && state.currentFocus;
  const implicitFocus = targetless && !state.currentFocus;
  const focusRef = usesCurrentFocus && !env.image ? state.focusRef : undefined;
  const retargeted = focusRef ? { ...action, ref: focusRef } : action;
  const target =
    (usesCurrentFocus && !focusRef) || implicitFocus
      ? focusedTarget(env)
      : nativeTarget(retargeted, operation, env);
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
        wantsForeground: "focus" in target && !implicitFocus,
        implicitFocus,
      };
    case "keypress":
      return {
        action: operation,
        target,
        params: { keys: keys(action.keys) },
        establishesFocus: false,
        wantsForeground: "focus" in target && !implicitFocus,
        implicitFocus,
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

export function focusEstablishedBy(prepared: PreparedAction, headless: boolean): boolean {
  return (
    !headless &&
    (prepared.establishesFocus || (prepared.action === "click" && "x" in prepared.target))
  );
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
