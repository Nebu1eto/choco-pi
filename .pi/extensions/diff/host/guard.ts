/**
 * Containment at the pane hosts' boundary with pi-tui.
 *
 * pi-tui calls a component's `render` and `handleInput` from its render
 * timer and its stdin handler, with nothing around them; Pi's interactive
 * mode turns any throw that escapes into an `uncaughtException` and exits
 * (`uncaughtCrash` in modes/interactive/interactive-mode.js). The pane draws
 * repository data and opens by itself after an agent's edit, so every call a
 * host makes into the view, and every host callback pi-tui runs outside one
 * (overlay size getters, the border's relayout), goes through this guard.
 *
 * After a render failure the guard never calls the view again: each later
 * frame gets the fallback lines, and `failed` is reported once, after the
 * frame, so the controller can close the pane. An input failure is reported
 * each time (input is paced by the user) and the view stays drawable.
 */
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

/** The first line of an error's message, safe to draw. */
export function failureText(error: RuntimeValue): string {
  const raw = error instanceof Error ? error.message : String(error);
  const first = raw.split(/\r?\n/u)[0] ?? "";
  return sanitizeTerminalText(first.trim() || "unknown error");
}

/** At most `width` columns: the fallback a failed render draws instead. */
export function fallbackLines(error: RuntimeValue, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  return [
    truncateToWidth(`The changes view could not be drawn: ${failureText(error)}`, columns, "…"),
  ];
}

export type GuardedSurface = PaneSurface & {
  /** The render failure, once one happened; the view is not called again. */
  readonly renderFailure: RuntimeValue | undefined;
  /** Run host code pi-tui calls outside a view call; a throw counts as a render failure. */
  contain<Value>(run: () => Value, fallback: Value): Value;
  /** The view's answer to a mouse gesture; false when it has none or it threw (reported as input). */
  pointer(gesture: PointerGesture): boolean;
  /** The view's pinned row; undefined when it has none or it threw (reported as render). */
  stickyRow(top: number): string | undefined;
};

/**
 * `lines` with `row` drawn over line `top`, the first visible one. The view's
 * lines are left alone (they may be cached); a row past the end is ignored.
 */
export function pinRow(lines: string[], top: number, row: string | undefined): string[] {
  if (row === undefined || top <= 0 || top >= lines.length) return lines;
  const pinned = [...lines];
  pinned[top] = row;
  return pinned;
}

export function guardSurface(surface: PaneSurface, callbacks: HostCallbacks): GuardedSurface {
  let renderFailure: { error: RuntimeValue } | undefined;
  let reported = false;

  function report(kind: FailureKind, error: RuntimeValue): void {
    // After the frame or key: the controller may close the pane, which must
    // not happen while pi-tui is still inside this component's call.
    queueMicrotask(() => {
      try {
        callbacks.failed?.(kind, error);
      } catch {
        // The controller's report never throws; this is the last place to stop it.
      }
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
    stickyRow(top) {
      if (renderFailure) return undefined;
      try {
        return surface.stickyRow?.(top);
      } catch (error) {
        renderFailed(error);
        return undefined;
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
