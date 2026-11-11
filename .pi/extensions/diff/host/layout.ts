/**
 * Runtime check of Pi's fullscreen layout root.
 *
 * Pi 1.5.1 builds the fullscreen layout in `modes/interactive/chat-viewport.js`
 * as `VStack[ScrollView(transcript), VStack(dock)]` and mounts it with
 * `setLayoutRoot`, which stores it in the renderer's private `layoutRoot`
 * field. Neither the field nor the two-entry layout is a public contract, so
 * every fact this module relies on is checked here; any mismatch makes the
 * caller fall back to the overlay host instead of touching the layout.
 */
import type { Component, StackEntry, StackEntryOptions } from "@earendil-works/pi-tui";
import { ScrollView, VStack } from "@earendil-works/pi-tui";
import { isNumber, isObject, type RuntimeValue } from "../../lib/runtime-values.ts";

export type DockableLayout = {
  root: VStack;
  transcript: ScrollView;
  /** The root's two entries exactly as they were, for restoring on uninstall. */
  entries: readonly [StackEntry, StackEntry];
};

/** Read the renderer's private layout root. Returns undefined when it is absent. */
export function readLayoutRoot<Host extends object>(tui: Host): RuntimeValue {
  return "layoutRoot" in tui ? tui.layoutRoot : undefined;
}

function optionalNumber(value: RuntimeValue): number | undefined | false {
  if (value === undefined) return undefined;
  return isNumber(value) ? value : false;
}

/** Validate one internal stack entry and copy it into a typed `StackEntry`. */
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
  // Pi 1.5.1 sets no visibility callback on these entries. One could not be
  // copied back with its exact identity and type, so its presence means the
  // layout is not the one this module knows.
  if ("visible" in value && value.visible !== undefined) return undefined;
  return { component, ...options };
}

/** Read the protected `entries` list of a stack through a plain component view. */
function readStackEntries(stack: Component): RuntimeValue {
  return "entries" in stack ? stack.entries : undefined;
}

/**
 * Accept the host root only when it is a `VStack` with exactly two children,
 * the first being the transcript `ScrollView`, and its internal entry list
 * matches those children. Pure over its input so tests can feed it fakes.
 */
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
