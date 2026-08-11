import type { SettingsListTheme } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FuzzySelector } from "./fuzzy-selector";

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ENTER = "\r";
const ESC = "\u001b";

function createTheme(): SettingsListTheme {
  return {
    label: (text: string) => text,
    value: (text: string) => text,
    description: (text: string) => text,
    cursor: "→ ",
    hint: (text: string) => text,
  };
}

describe("FuzzySelector", () => {
  it("uses plain list mode at or below threshold and selects with arrows", () => {
    const onSelect = vi.fn();
    const onDone = vi.fn();

    const selector = new FuzzySelector({
      label: "Pick",
      items: ["Alpha", "Beta", "Gamma"],
      theme: createTheme(),
      onSelect,
      onDone,
      searchThreshold: 3,
    });

    const rendered = selector.render(80).join("\n");
    expect(rendered).not.toContain("Search:");
    expect(rendered).toContain("↑/↓: move · Enter: select · Esc: back");

    selector.handleInput(DOWN);
    selector.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith("Beta");
    selector.handleInput(ESC);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("uses fuzzy mode above threshold and filters", () => {
    const onSelect = vi.fn();

    const selector = new FuzzySelector({
      label: "Pick",
      items: ["Alpha", "Beta", "Gamma", "Delta"],
      theme: createTheme(),
      onSelect,
      onDone: () => {},
      searchThreshold: 3,
    });

    expect(selector.render(80).join("\n")).toContain("Search:");

    selector.handleInput("g");
    selector.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith("Gamma");
  });

  it("respects currentValue pre-selection in plain list mode", () => {
    const onSelect = vi.fn();

    const selector = new FuzzySelector({
      label: "Pick",
      items: ["Alpha", "Beta", "Gamma"],
      currentValue: "Gamma",
      theme: createTheme(),
      onSelect,
      onDone: () => {},
      searchThreshold: 7,
    });

    selector.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith("Gamma");
  });

  it("respects currentValue pre-selection in fuzzy mode when query is empty", () => {
    const onSelect = vi.fn();

    const selector = new FuzzySelector({
      label: "Pick",
      items: [
        "Alpha",
        "Beta",
        "Gamma",
        "Delta",
        "Epsilon",
        "Zeta",
        "Eta",
        "Theta",
      ],
      currentValue: "Theta",
      theme: createTheme(),
      onSelect,
      onDone: () => {},
      searchThreshold: 7,
    });

    selector.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith("Theta");

    selector.handleInput(UP);
    selector.handleInput(ENTER);
    expect(onSelect).toHaveBeenLastCalledWith("Eta");
  });
});
