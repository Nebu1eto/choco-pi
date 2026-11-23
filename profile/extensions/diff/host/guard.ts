import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../lib/changes/terminal-text.ts";
import type { RuntimeValue } from "../../lib/runtime-values.ts";
import type {
  HostCallbacks,
  PaneScroller,
  PaneSurface,
  PointerGesture,
} from "../../lib/changes/view/surface.ts";

export type FailureKind = "render" | "input";

export function failureText(error: RuntimeValue): string {
  const raw = error instanceof Error ? error.message : String(error);
  const first = raw.split(/\r?\n/u)[0] ?? "";
  return sanitizeTerminalText(first.trim() || "unknown error");
}

export function fallbackLines(error: RuntimeValue, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  return [
    truncateToWidth(`The changes view could not be drawn: ${failureText(error)}`, columns, "…"),
  ];
}

export type GuardedSurface = PaneSurface & {
  readonly renderFailure: RuntimeValue | undefined;
  contain<Value>(run: () => Value, fallback: Value): Value;
  pointer(gesture: PointerGesture): boolean;
  stickyRows(top: number, height: number): string[];
};

export function pinRows(lines: string[], top: number, rows: readonly string[]): string[] {
  if (rows.length === 0 || top <= 0 || top >= lines.length) return lines;
  const pinned = [...lines];
  rows.forEach((row, index) => {
    if (top + index < pinned.length) pinned[top + index] = row;
  });
  return pinned;
}

export function guardSurface(surface: PaneSurface, callbacks: HostCallbacks): GuardedSurface {
  let renderFailure: { error: RuntimeValue } | undefined;
  let reported = false;

  function report(kind: FailureKind, error: RuntimeValue): void {
    queueMicrotask(() => {
      try {
        callbacks.failed?.(kind, error);
      } catch {}
    });
  }

  function renderFailed(error: RuntimeValue): void {
    if (!renderFailure) renderFailure = { error };
    if (reported) return;
    reported = true;
    report("render", error);
  }

  function render(width: number, draw: () => string[]): string[] {
    if (renderFailure) return fallbackLines(renderFailure.error, width);
    try {
      return draw();
    } catch (error) {
      renderFailed(error);
      return fallbackLines(error, width);
    }
  }

  return {
    get renderFailure() {
      return renderFailure?.error;
    },
    renderHeader: (width, focused) => render(width, () => surface.renderHeader(width, focused)),
    renderBody: (width, focused) =>
      renderFailure ? [] : render(width, () => surface.renderBody(width, focused)),
    handleKey(data) {
      if (renderFailure) return;
      try {
        surface.handleKey(data);
      } catch (error) {
        report("input", error);
      }
    },
    pointer(gesture) {
      if (renderFailure) return false;
      try {
        return surface.pointer?.(gesture) ?? false;
      } catch (error) {
        report("input", error);
        return false;
      }
    },
    attachScroller(scroller: PaneScroller) {
      surface.attachScroller(scroller);
    },
    stickyRows(top, height) {
      if (renderFailure) return [];
      try {
        return surface.stickyRows?.(top, height) ?? [];
      } catch (error) {
        renderFailed(error);
        return [];
      }
    },
    invalidate() {
      if (renderFailure) return;
      try {
        surface.invalidate();
      } catch (error) {
        renderFailed(error);
      }
    },
    contain(run, fallback) {
      try {
        return run();
      } catch (error) {
        renderFailed(error);
        return fallback;
      }
    },
  };
}
