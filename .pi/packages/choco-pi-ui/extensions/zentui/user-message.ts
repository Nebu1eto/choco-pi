import { type Theme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ZentuiConfig } from "./config";
import { installPrototypePatch, removePrototypePatch } from "./prototype-patch-registry";
import {
  sanitizeRenderedUserMessageLines,
  sanitizeRenderedUserMessageText,
  sanitizeUserMessageSourceText,
} from "./user-message-osc";
import { renderUserMessageStyle, userMessageStyleCacheKey } from "./user-message-styles";
import {
  type BoundaryRecord,
  type BoundaryValue,
  invokeWithReceiver,
  isCallable,
  isNumber,
  isObjectValue,
  isString,
} from "./runtime-values";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

type PatchableUserMessagePrototype = {
  children?: BoundaryValue[];
};

type Cleanup = () => void;

type UserMessageRenderCache = {
  hasMarkdownText: boolean;
  text?: string;
  width?: number;
  theme?: Theme;
  configKey?: string;
  renderedLines?: string[];
};

const userMessageRenderCache = new WeakMap<object, UserMessageRenderCache>();

function isObject(value: BoundaryValue): value is object {
  return (isObjectValue(value) && value !== null) || isCallable(value);
}

function isRecord(value: BoundaryValue): value is BoundaryRecord {
  return isObjectValue(value) && value !== null && !Array.isArray(value);
}

function findMarkdownText(value: BoundaryValue): string | undefined {
  if (!isRecord(value)) return undefined;
  if (isString(value.text)) return value.text;

  const children = value.children;
  if (!Array.isArray(children)) return undefined;

  for (const child of children) {
    const text = findMarkdownText(child);
    if (text !== undefined) return text;
  }

  return undefined;
}

function getCachedMarkdownText(instance: PatchableUserMessagePrototype): string | undefined {
  const cached = userMessageRenderCache.get(instance);
  if (cached?.hasMarkdownText) return cached.text;

  const text = findMarkdownText(instance);
  if (text !== undefined) {
    userMessageRenderCache.set(instance, { ...cached, hasMarkdownText: true, text });
  }
  return text;
}

function renderZentuiUserMessage(
  instance: PatchableUserMessagePrototype,
  width: number,
  theme: Theme | undefined,
  config: ZentuiConfig,
): string[] | undefined {
  if (!isRecord(instance)) return undefined;

  const text = getCachedMarkdownText(instance);
  if (text === undefined) return undefined;
  const configKey = userMessageStyleCacheKey(config);
  const cached = userMessageRenderCache.get(instance);
  if (
    cached?.hasMarkdownText &&
    cached.width === width &&
    cached.theme === theme &&
    cached.configKey === configKey &&
    cached.renderedLines
  ) {
    return cached.renderedLines;
  }

  const lines = renderUserMessageStyle({
    text,
    width,
    theme,
    config,
  });
  userMessageRenderCache.set(instance, {
    hasMarkdownText: true,
    text,
    width,
    theme,
    configKey,
    renderedLines: lines,
  });
  return lines;
}

function withPromptZoneMarkers(lines: string[]): string[] {
  if (lines.length === 1) {
    return [`${OSC133_ZONE_START}${lines[0]}${OSC133_ZONE_END}${OSC133_ZONE_FINAL}`];
  }
  const markedLines = [...lines];
  markedLines[0] = OSC133_ZONE_START + markedLines[0];
  markedLines[markedLines.length - 1] =
    OSC133_ZONE_END + OSC133_ZONE_FINAL + markedLines[markedLines.length - 1];
  return markedLines;
}

function sanitizePredecessorRender(result: BoundaryValue): BoundaryValue {
  if (isString(result)) return sanitizeRenderedUserMessageText(result);
  if (!Array.isArray(result)) return result;
  const stringRows: string[] = [];
  for (const line of result) {
    if (!isString(line))
      return result.map((row) => (isString(row) ? sanitizeRenderedUserMessageText(row) : row));
    stringRows.push(line);
  }
  return sanitizeRenderedUserMessageLines(stringRows);
}

function renderSafeSourceFallback(
  instance: PatchableUserMessagePrototype,
  width: number,
): string[] | undefined {
  let text: string | undefined;
  try {
    text = isRecord(instance) ? getCachedMarkdownText(instance) : undefined;
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  const stripped = sanitizeUserMessageSourceText(text);
  if (stripped === text) return undefined;
  const lines = (width > 0 ? wrapTextWithAnsi(stripped, width) : [""]).map(
    sanitizeRenderedUserMessageText,
  );
  return withPromptZoneMarkers(lines.length > 0 ? lines : [""]);
}

export function removeUserMessageStyle(): void {
  const prototype = UserMessageComponent.prototype;
  removePrototypePatch(prototype, "render", "user-message-render");
  removePrototypePatch(prototype, "invalidate", "user-message-invalidate");
}

export function installUserMessageStyle(
  getTheme: () => Theme | undefined,
  getConfig: () => ZentuiConfig,
): Cleanup {
  const prototype = UserMessageComponent.prototype;
  const cleanupInvalidate = installPrototypePatch(
    prototype,
    "invalidate",
    "user-message-invalidate",
    ({ predecessor, receiver, args }) => {
      if (isObject(receiver)) userMessageRenderCache.delete(receiver);
      return invokeWithReceiver(predecessor, receiver, args);
    },
  );
  let cleanupRender: Cleanup;
  try {
    cleanupRender = installPrototypePatch(
      prototype,
      "render",
      "user-message-render",
      ({ predecessor, receiver, args }) => {
        const renderPredecessor = () =>
          sanitizePredecessorRender(invokeWithReceiver(predecessor, receiver, args));
        const width = args[0];
        if (!isNumber(width)) return renderPredecessor();
        try {
          const lines = renderZentuiUserMessage(
            // SAFETY: the host TUI runtime supplies this shape and adjacent capability checks validate accessed members.
            receiver as PatchableUserMessagePrototype,
            width,
            getTheme(),
            getConfig(),
          );
          if (!lines) return renderPredecessor();
          return lines.length ? withPromptZoneMarkers(lines) : lines;
        } catch {
          const safeFallback = renderSafeSourceFallback(
            // SAFETY: the host TUI runtime supplies this shape and adjacent capability checks validate accessed members.
            receiver as PatchableUserMessagePrototype,
            width,
          );
          return safeFallback ?? renderPredecessor();
        }
      },
    );
  } catch (error) {
    cleanupInvalidate();
    throw error;
  }
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    cleanupRender();
    cleanupInvalidate();
  };
}
