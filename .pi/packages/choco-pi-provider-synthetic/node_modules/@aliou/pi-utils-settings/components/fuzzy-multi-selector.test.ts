import type { SettingsListTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  FuzzyMultiSelector as CheckboxList,
  type FuzzyMultiSelectorItem as CheckItem,
} from "./fuzzy-multi-selector";

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const SPACE = " ";
const CTRL_A = "\x01";
const CTRL_X = "\x18";

function createTheme(): SettingsListTheme {
  return {
    label: (text: string) => text,
    value: (text: string) => text,
    description: (text: string) => text,
    cursor: "→ ",
    hint: (text: string) => text,
  };
}

function makeItems(
  names: string[],
  subOpts?: Record<string, string[]>,
): CheckItem[] {
  return names.map((name) => ({
    label: name,
    checked: false,
    subOptions: (subOpts?.[name] ?? []).map((s) => ({
      label: s,
      checked: false,
    })),
  }));
}

describe("CheckboxList", () => {
  it("No sub-options, nothing checked: render should not contain 'Selected:'", () => {
    const selector = new CheckboxList({
      label: "Test",
      items: makeItems(["Alpha", "Beta", "Gamma"]),
      theme: createTheme(),
    });

    const rendered = selector.render(80).join("\n");
    expect(rendered).not.toContain("Selected:");
  });

  it("Checking moves item to Selected section", () => {
    const selector = new CheckboxList({
      label: "Test",
      items: makeItems(["Alpha", "Beta"]),
      theme: createTheme(),
    });

    // Initial state - no Selected section
    let rendered = selector.render(80).join("\n");
    expect(rendered).not.toContain("Selected:");
    expect(rendered).toContain("[ ] Alpha");
    expect(rendered).toContain("[ ] Beta");

    // Check Alpha - cursor is at Alpha
    selector.handleInput(SPACE);

    rendered = selector.render(80).join("\n");
    expect(rendered).toContain("Selected:");
    expect(rendered).toContain("[x] Alpha");
    expect(rendered).toContain("[ ] Beta");

    // Uncheck Alpha
    selector.handleInput(SPACE);

    // Selected section should disappear
    rendered = selector.render(80).join("\n");
    expect(rendered).not.toContain("Selected:");
    expect(rendered).toContain("[ ] Alpha");
    expect(rendered).toContain("[ ] Beta");
  });

  it("Sub-options appear indented under checked items", () => {
    const selector = new CheckboxList({
      label: "Test",
      items: makeItems(["Alpha", "Beta"], { Alpha: ["Sub1", "Sub2"] }),
      theme: createTheme(),
    });

    // Check Alpha
    selector.handleInput(SPACE);

    const rendered = selector.render(80).join("\n");
    expect(rendered).toContain("Selected:");
    expect(rendered).toContain("[x] Alpha");
    expect(rendered).toContain("    [ ] Sub1");
    expect(rendered).toContain("    [ ] Sub2");
  });

  it("Space on sub-option toggles it without affecting parent", () => {
    const selector = new CheckboxList({
      label: "Test",
      items: makeItems(["Alpha"], { Alpha: ["Sub1"] }),
      theme: createTheme(),
    });

    // Check Alpha
    selector.handleInput(SPACE);

    // Navigate down to Sub1
    selector.handleInput(DOWN);

    // Toggle Sub1
    selector.handleInput(SPACE);

    const items = selector.getItems();
    expect(items[0]!.checked).toBe(true);
    expect(items[0]!.subOptions?.[0]!.checked).toBe(true);

    const rendered = selector.render(80).join("\n");
    expect(rendered).toContain("    [x] Sub1");
  });

  it("Unchecking parent hides sub-options", () => {
    const selector = new CheckboxList({
      label: "Test",
      items: makeItems(["Alpha"], { Alpha: ["Sub1"] }),
      theme: createTheme(),
    });

    // Check Alpha
    selector.handleInput(SPACE);

    let rendered = selector.render(80).join("\n");
    expect(rendered).toContain("Selected:");
    expect(rendered).toContain("    [ ] Sub1");

    // Navigate to Sub1 and check it
    selector.handleInput(DOWN);
    selector.handleInput(SPACE);

    rendered = selector.render(80).join("\n");
    expect(rendered).toContain("    [x] Sub1");

    // Navigate back up to Alpha and uncheck it
    selector.handleInput(UP);
    selector.handleInput(SPACE);

    // Alpha and its sub-options should no longer be visible
    rendered = selector.render(80).join("\n");
    expect(rendered).not.toContain("Selected:");
    expect(rendered).not.toContain("Sub1");
  });

  it("Fuzzy search only filters unchecked items", () => {
    const selector = new CheckboxList({
      label: "Test",
      items: makeItems(["Alpha", "Beta", "Gamma"]),
      theme: createTheme(),
    });

    // Check Alpha
    selector.handleInput(SPACE);

    // Type search for "Bet"
    selector.handleInput("B");
    selector.handleInput("e");
    selector.handleInput("t");

    const rendered = selector.render(80).join("\n");
    // Alpha should still be in Selected section even though it doesn't match
    expect(rendered).toContain("Selected:");
    expect(rendered).toContain("[x] Alpha");
    // Beta should appear in the main list
    expect(rendered).toContain("[ ] Beta");
    // Gamma should not appear (filtered out)
    expect(rendered).not.toContain("Gamma");
  });

  it("showHints false suppresses footer", () => {
    const selector = new CheckboxList({
      label: "Test",
      items: makeItems(["Alpha"]),
      theme: createTheme(),
      showHints: false,
    });

    const rendered = selector.render(80).join("\n");
    expect(rendered).not.toContain("Space toggle");
  });

  it("showHints true (default) shows footer", () => {
    const selector = new CheckboxList({
      label: "Test",
      items: makeItems(["Alpha"]),
      theme: createTheme(),
    });

    const rendered = selector.render(80).join("\n");
    expect(rendered).toContain("Space toggle");
  });

  it("getCheckedItems returns only checked top-level items", () => {
    const selector = new CheckboxList({
      label: "Test",
      items: makeItems(["Alpha", "Beta", "Gamma"]),
      theme: createTheme(),
    });

    // Check Alpha and Gamma
    selector.handleInput(SPACE); // Check Alpha
    selector.handleInput(DOWN);
    selector.handleInput(DOWN);
    selector.handleInput(SPACE); // Check Gamma

    const checked = selector.getCheckedItems();
    expect(checked).toHaveLength(2);
    expect(checked[0]!.label).toBe("Alpha");
    expect(checked[1]!.label).toBe("Gamma");
  });

  it("Ctrl+A/Ctrl+X only affect top-level items", () => {
    const selector = new CheckboxList({
      label: "Test",
      items: makeItems(["Alpha", "Beta"], { Alpha: ["Sub1"] }),
      theme: createTheme(),
    });

    // Check Alpha
    selector.handleInput(SPACE);

    // Navigate to sub-option and check it
    selector.handleInput(DOWN);
    selector.handleInput(SPACE);

    let items = selector.getItems();
    expect(items[0]!.checked).toBe(true);
    expect(items[0]!.subOptions?.[0]!.checked).toBe(true);

    // Ctrl+A to select all
    selector.handleInput(CTRL_A);

    items = selector.getItems();
    expect(items[0]!.checked).toBe(true); // Alpha
    expect(items[0]!.subOptions?.[0]!.checked).toBe(true); // Sub1 unchanged
    expect(items[1]!.checked).toBe(true); // Beta

    // Ctrl+X to clear all
    selector.handleInput(CTRL_X);

    items = selector.getItems();
    expect(items[0]!.checked).toBe(false); // Alpha
    expect(items[0]!.subOptions?.[0]!.checked).toBe(true); // Sub1 unchanged
    expect(items[1]!.checked).toBe(false); // Beta
  });
});
