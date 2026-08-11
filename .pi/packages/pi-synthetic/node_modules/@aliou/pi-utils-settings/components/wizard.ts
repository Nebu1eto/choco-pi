/**
 * A multi-step wizard component with tabbed navigation and bordered frame.
 *
 * Features:
 * - Box-drawing border around the entire wizard (╭╮╰╯ style)
 * - Step tabs at the top with progress indicators (●/○)
 * - Tab/Shift+Tab navigation between steps
 * - Each step renders its own inner Component
 * - Ctrl+S or Enter on the last step submits
 * - Esc cancels the entire wizard
 *
 * Use for first-time setup flows, multi-step configuration, or any
 * sequential data collection that benefits from back-and-forth navigation.
 */

import { Panel } from "@aliou/pi-utils-ui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";

class RenderLines implements Component {
  constructor(private renderLines: (width: number) => string[]) {}

  render(width: number): string[] {
    return this.renderLines(width);
  }

  invalidate(): void {}
}

export interface WizardStep {
  /** Tab label shown at the top. Keep it short (1-2 words). */
  label: string;
  /**
   * Build the inner component for this step.
   *
   * The component controls its own rendering and input handling.
   * Call `markComplete()` to mark the step as done (shows ● in tabs).
   * Call `markIncomplete()` to revert it (shows ○).
   *
   * The wizard handles borders, tabs, and step navigation externally.
   * The inner component should NOT handle Tab/Shift+Tab/Esc/Ctrl+S.
   */
  build: (ctx: WizardStepContext) => Component;
}

export interface WizardStepContext {
  /** Mark this step as complete (filled ● in progress). */
  markComplete: () => void;
  /** Mark this step as incomplete (empty ○ in progress). */
  markIncomplete: () => void;
  /** Advance to the next step (wraps around). */
  goNext: () => void;
  /** Go back to the previous step (wraps around). */
  goPrev: () => void;
}

export interface WizardOptions {
  /** Title shown at the top of the wizard. */
  title: string;
  /** Ordered list of steps. */
  steps: WizardStep[];
  /** Theme for rendering borders and chrome. */
  theme: Theme;
  /** Called when user submits (Ctrl+S). */
  onComplete: () => void;
  /** Called when user cancels (Esc). */
  onCancel: () => void;
  /** Hint text appended to the controls line. */
  hintSuffix?: string;
  /**
   * Minimum number of lines for the inner step content area.
   * If a step renders fewer lines, the wizard pads with blanks.
   * This keeps the wizard height stable across tabs.
   */
  minContentHeight?: number;
}

export class Wizard implements Component {
  private steps: WizardStep[];
  private theme: Theme;
  private onComplete: () => void;
  private onCancel: () => void;
  private title: string;
  private hintSuffix: string;

  private activeIndex = 0;
  private completed: boolean[];
  private components: Component[];
  private minContentHeight: number;

  constructor(options: WizardOptions) {
    this.steps = options.steps;
    this.theme = options.theme;
    this.onComplete = options.onComplete;
    this.onCancel = options.onCancel;
    this.title = options.title;
    this.hintSuffix = options.hintSuffix ?? "";
    this.minContentHeight = options.minContentHeight ?? 0;

    this.completed = new Array(options.steps.length).fill(false) as boolean[];
    this.components = options.steps.map((step, i) =>
      step.build({
        markComplete: () => {
          this.completed[i] = true;
        },
        markIncomplete: () => {
          this.completed[i] = false;
        },
        goNext: () => {
          this.activeIndex = (this.activeIndex + 1) % this.steps.length;
        },
        goPrev: () => {
          this.activeIndex =
            (this.activeIndex - 1 + this.steps.length) % this.steps.length;
        },
      }),
    );
  }

  /** Returns the index of the currently active step. */
  getActiveIndex(): number {
    return this.activeIndex;
  }

  /** Returns whether all steps are marked complete. */
  isAllComplete(): boolean {
    return this.completed.every(Boolean);
  }

  invalidate(): void {
    for (const component of this.components) {
      component.invalidate?.();
    }
  }

  render(width: number): string[] {
    const t = this.theme;

    const body = new RenderLines((contentWidth) => {
      const lines: string[] = [];

      lines.push(this.renderStepTabs(contentWidth));
      lines.push("");

      const innerComponent = this.components[this.activeIndex];
      const innerLines = innerComponent
        ? innerComponent.render(contentWidth)
        : [];
      lines.push(...innerLines);
      for (let i = innerLines.length; i < this.minContentHeight; i++) {
        lines.push("");
      }

      return lines;
    });

    const footer = new RenderLines(() => [this.buildControlsText()]);

    return new Panel({
      title: this.title,
      body,
      footer,
      border: "round",
      borderStyle: (text) => t.fg("border", text),
      titleStyle: (text) => t.fg("accent", t.bold(text)),
      padding: 1,
    }).render(width);
  }

  handleInput(data: string): void {
    // Ctrl+S: submit if all steps complete
    if (matchesKey(data, Key.ctrl("s"))) {
      this.onComplete();
      return;
    }

    // Esc: cancel
    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }

    // Tab / Shift+Tab: navigate steps
    if (matchesKey(data, Key.tab)) {
      this.activeIndex = (this.activeIndex + 1) % this.steps.length;
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.activeIndex =
        (this.activeIndex - 1 + this.steps.length) % this.steps.length;
      return;
    }

    // Delegate to inner component
    const innerComponent = this.components[this.activeIndex];
    innerComponent?.handleInput?.(data);
  }

  // --- Private rendering helpers ---

  private renderStepTabs(_contentWidth: number): string {
    const t = this.theme;
    const parts: string[] = [];

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      if (!step) continue;

      const dot = this.completed[i]
        ? t.fg("success", "●")
        : i === this.activeIndex
          ? t.fg("accent", "●")
          : t.fg("dim", "○");

      const label =
        i === this.activeIndex
          ? t.bg("selectedBg", t.fg("accent", ` ${step.label} `))
          : t.fg("dim", ` ${step.label} `);

      parts.push(`${dot} ${label}`);
    }

    return parts.join("  ");
  }

  private buildControlsText(): string {
    const t = this.theme;
    const parts: string[] = [
      "Tab/Shift+Tab navigate",
      "Ctrl+S submit",
      "Esc cancel",
    ];
    if (this.hintSuffix) {
      parts.push(this.hintSuffix);
    }
    return t.fg("dim", ` ${parts.join(" · ")}`);
  }
}
