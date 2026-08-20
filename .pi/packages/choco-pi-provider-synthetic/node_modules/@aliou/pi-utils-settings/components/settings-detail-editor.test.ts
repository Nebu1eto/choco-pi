import type { Component, SettingsListTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  SettingsDetailEditor,
  type SettingsDetailField,
} from "./settings-detail-editor";

const ENTER = "\r";
const ESC = "\u001b";

function createTheme(): SettingsListTheme {
  return {
    cursor: "> ",
    label: (text: string) => text,
    value: (text: string) => text,
    hint: (text: string) => text,
    description: (text: string) => text,
  } as unknown as SettingsListTheme;
}

describe("SettingsDetailEditor", () => {
  it("navigates with j/k and returns summary on Esc", () => {
    const doneCalls: Array<string | undefined> = [];

    const fields: SettingsDetailField[] = [
      {
        id: "first",
        type: "boolean",
        label: "First",
        getValue: () => false,
        setValue: () => {},
      },
      {
        id: "second",
        type: "boolean",
        label: "Second",
        getValue: () => true,
        setValue: () => {},
      },
    ];

    const editor = new SettingsDetailEditor({
      title: "Details",
      fields,
      theme: createTheme(),
      onDone: (summary) => doneCalls.push(summary),
      getDoneSummary: () => "2 fields",
    });

    editor.handleInput("k");

    const rendered = editor.render(80).join("\n");
    expect(rendered).toContain("> Second");
    expect(rendered).toContain("on");

    editor.handleInput(ESC);
    expect(doneCalls).toEqual(["2 fields"]);
  });

  it("commits text and enum field callbacks", () => {
    let themeName = "";
    let tabSize = "2";

    const fields: SettingsDetailField[] = [
      {
        id: "theme",
        type: "text",
        label: "Theme",
        getValue: () => themeName,
        setValue: (value) => {
          themeName = value;
        },
      },
      {
        id: "tabSize",
        type: "enum",
        label: "Tab size",
        getValue: () => tabSize,
        setValue: (value) => {
          tabSize = value;
        },
        options: ["2", "4", "8"],
      },
    ];

    const editor = new SettingsDetailEditor({
      title: "Details",
      fields,
      theme: createTheme(),
      onDone: () => {},
    });

    editor.handleInput(ENTER);
    for (const ch of "light") {
      editor.handleInput(ch);
    }
    editor.handleInput(ENTER);

    editor.handleInput("j");
    editor.handleInput(ENTER);
    editor.handleInput("j");
    editor.handleInput(ENTER);

    expect(themeName).toBe("light");
    expect(tabSize).toBe("4");
  });

  it("toggles boolean and confirms destructive action", () => {
    let enabled = false;
    let cleared = false;

    const fields: SettingsDetailField[] = [
      {
        id: "enabled",
        type: "boolean",
        label: "Enabled",
        getValue: () => enabled,
        setValue: (value) => {
          enabled = value;
        },
      },
      {
        id: "clear",
        type: "action",
        label: "Clear",
        onConfirm: () => {
          cleared = true;
        },
      },
    ];

    const editor = new SettingsDetailEditor({
      title: "Details",
      fields,
      theme: createTheme(),
      onDone: () => {},
    });

    editor.handleInput(ENTER);
    editor.handleInput("j");
    editor.handleInput(ENTER);
    editor.handleInput("y");

    expect(enabled).toBe(true);
    expect(cleared).toBe(true);
  });

  it("opens nested submenu and returns cleanly", () => {
    let summaryFromNested: string | undefined;

    const nested: Component = {
      render: () => ["nested"],
      handleInput: () => {},
      invalidate: () => {},
    };

    const fields: SettingsDetailField[] = [
      {
        id: "nested",
        type: "submenu",
        label: "Nested",
        getValue: () => "open",
        submenu: (done) => ({
          ...nested,
          handleInput: (data: string) => {
            if (data === "x") {
              done("updated");
            }
          },
        }),
        onSubmenuDone: (summary) => {
          summaryFromNested = summary;
        },
      },
    ];

    const editor = new SettingsDetailEditor({
      title: "Details",
      fields,
      theme: createTheme(),
      onDone: () => {},
    });

    editor.handleInput(ENTER);
    expect(editor.render(80).join("\n")).toContain("nested");

    editor.handleInput("x");

    const rendered = editor.render(80).join("\n");
    expect(rendered).toContain("> Nested");
    expect(rendered).toContain("› open");
    expect(summaryFromNested).toBe("updated");
  });
});
