import { Panel } from "@aliou/pi-utils-ui";
import type { Component, SettingsListTheme } from "@earendil-works/pi-tui";

class RenderBody implements Component {
  constructor(private renderBody: (width: number) => string[]) {}

  render(width: number): string[] {
    return this.renderBody(width);
  }

  invalidate(): void {}
}

export function renderSettingsPanel(
  width: number,
  title: string,
  theme: SettingsListTheme,
  renderBody: (width: number) => string[],
): string[] {
  return new Panel({
    title,
    body: new RenderBody(renderBody),
    border: "round",
    borderStyle: theme.hint,
    titleStyle: (text) => theme.label(text, true),
    padding: 1,
  }).render(width);
}
