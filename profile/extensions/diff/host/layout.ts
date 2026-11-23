import type { Component, StackEntry, StackEntryOptions } from "@earendil-works/pi-tui";
import { ScrollView, VStack } from "@earendil-works/pi-tui";
import { isNumber, isObject, type RuntimeValue } from "../../lib/runtime-values.ts";

export type DockableLayout = {
  root: VStack;
  transcript: ScrollView;
  entries: readonly [StackEntry, StackEntry];
};

export function readLayoutRoot<Host extends object>(tui: Host): RuntimeValue {
  return "layoutRoot" in tui ? tui.layoutRoot : undefined;
}

function optionalNumber(value: RuntimeValue): number | undefined | false {
  if (value === undefined) return undefined;
  return isNumber(value) ? value : false;
}

function stackEntryOf(value: RuntimeValue, component: Component): StackEntry | undefined {
  if (!isObject(value) || value === null) return undefined;
  if (!("component" in value) || value.component !== component) return undefined;
  const options: StackEntryOptions = {};
  if ("basis" in value && value.basis !== undefined) {
    if (value.basis === "auto") options.basis = "auto";
    else if (isNumber(value.basis)) options.basis = value.basis;
    else return undefined;
  }
  const grow = "grow" in value ? optionalNumber(value.grow) : undefined;
  const shrink = "shrink" in value ? optionalNumber(value.shrink) : undefined;
  const minSize = "minSize" in value ? optionalNumber(value.minSize) : undefined;
  const maxSize = "maxSize" in value ? optionalNumber(value.maxSize) : undefined;
  if (grow === false || shrink === false || minSize === false || maxSize === false) {
    return undefined;
  }
  if (grow !== undefined) options.grow = grow;
  if (shrink !== undefined) options.shrink = shrink;
  if (minSize !== undefined) options.minSize = minSize;
  if (maxSize !== undefined) options.maxSize = maxSize;
  if ("visible" in value && value.visible !== undefined) return undefined;
  return { component, ...options };
}

function readStackEntries(stack: Component): RuntimeValue {
  return "entries" in stack ? stack.entries : undefined;
}

export function inspectHostRoot(root: RuntimeValue): DockableLayout | undefined {
  if (!(root instanceof VStack)) return undefined;
  if (root.children.length !== 2) return undefined;
  const [first, second] = root.children;
  if (!(first instanceof ScrollView) || second === undefined) return undefined;
  const rawEntries = readStackEntries(root);
  if (!Array.isArray(rawEntries) || rawEntries.length !== 2) return undefined;
  const transcriptEntry = stackEntryOf(rawEntries[0], first);
  const dockEntry = stackEntryOf(rawEntries[1], second);
  if (!transcriptEntry || !dockEntry) return undefined;
  return { root, transcript: first, entries: [transcriptEntry, dockEntry] };
}
