import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { loadZentuiModule, SKIP_WITHOUT_ZENTUI } from "../../../tests/zentui-build.ts";
import {
  reinterpretHostValue,
  type RuntimeValue,
} from "../../../profile/extensions/lib/runtime-values.ts";

type SettingItem = {
  id: string;
  label: string;
  currentValue: string;
  values?: string[];
  submenu?: (currentValue: string, done: (value?: string) => void) => Component;
};

type ExtraSection = {
  id: string;
  label: string;
  buildItems: () => SettingItem[];
  handleChange: (id: string, newValue: string) => { kind: "update" };
};

type PanelHandle = {
  render: (width: number) => string[];
  handleInput: (data: string) => void;
  handleMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
  dispose: () => void;
  getActiveSection: () => string;
  hasOpenSubmenu: () => boolean;
};

type SettingsCommandModule = {
  createZentuiPreferencesComponent: (deps: RuntimeValue, options: RuntimeValue) => PanelHandle;
};

const WIDTH = 400;

const noopTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fgRgb: (text: string) => text,
  bg: (_color: string, text: string) => text,
};

const ROW_COUNT = 14;
const rowLabel = (index: number): string => `Row ${String(index).padStart(2, "0")}`;

async function makePanel(submenu?: SettingItem["submenu"]) {
  const module = reinterpretHostValue<SettingsCommandModule>(
    await loadZentuiModule("settings-command.js"),
  );
  const config = reinterpretHostValue<{ defaultConfig: RuntimeValue }>(
    await loadZentuiModule("config.js"),
  ).defaultConfig;
  const changes: [string, string][] = [];
  const rows: SettingItem[] = Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: `r${index + 1}`,
    label: rowLabel(index + 1),
    currentValue: "off",
    values: ["off", "on"],
  }));
  if (submenu) rows[0] = { id: "r1", label: rowLabel(1), currentValue: "pick", submenu };
  const source: ExtraSection = {
    id: "source",
    label: "Source",
    buildItems: () => rows,
    handleChange: (id, newValue) => {
      changes.push([id, newValue]);
      return { kind: "update" };
    },
  };
  const other: ExtraSection = {
    id: "other",
    label: "Other",
    buildItems: () => [{ id: "o1", label: "Other row", currentValue: "a", values: ["a", "b"] }],
    handleChange: () => ({ kind: "update" }),
  };
  const deps = {
    sessionLifecycle: { defer: () => () => {} },
    getConfig: () => config,
    getActiveExtensionStatuses: () => new Map<string, string>(),
    requestRender: () => {},
    settingsListTheme: {
      label: (text: string) => text,
      value: (text: string) => text,
      description: (text: string) => text,
      cursor: "> ",
      hint: (text: string) => text,
    },
  };
  const panel = module.createZentuiPreferencesComponent(deps, {
    ctx: { hasUI: true, ui: { notify: () => {}, theme: noopTheme } },
    tui: { requestRender: () => {} },
    theme: noopTheme,
    extraSections: [source, other],
    layout: [
      {
        id: "alpha",
        label: "Alpha",
        groups: [
          { label: "First group", rows: ["r1", "r2"] },
          { label: "Second group", rows: rows.slice(2).map((row) => row.id) },
        ],
      },
      { id: "beta", label: "Beta", groups: [{ rows: ["o1"] }] },
    ],
    onOutcome: () => {},
  });
  return { panel, changes };
}

function mouse(
  type: TuiMouseEvent["type"],
  x: number,
  y: number,
  extra: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
  return {
    type,
    button: type === "wheel" ? "none" : "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: WIDTH,
    height: 40,
    shift: false,
    alt: false,
    ctrl: false,
    ...extra,
  };
}

function find(panel: PanelHandle, text: string) {
  const lines = panel.render(WIDTH).map((line) => stripVTControlCharacters(line));
  const y = lines.findIndex((line) => line.includes(text));
  assert.ok(y >= 0, `${text} is on screen`);
  return { x: lines[y]?.indexOf(text) ?? -1, y };
}

function selected(panel: PanelHandle): string {
  const lines = panel.render(WIDTH).map((line) => stripVTControlCharacters(line));
  return (
    lines
      .find((line) => line.startsWith("> "))
      ?.slice(2)
      .trim()
      .split(/\s{2,}/)[0] ?? ""
  );
}

function click(panel: PanelHandle, at: ReturnType<typeof find>) {
  const press = panel.handleMouse(mouse("press", at.x, at.y));
  panel.render(WIDTH);
  const result = panel.handleMouse(mouse("click", at.x, at.y));
  return { press, click: result };
}

test("a click on a section in the strip shows it", { skip: SKIP_WITHOUT_ZENTUI }, async () => {
  const { panel } = await makePanel();
  try {
    assert.equal(panel.getActiveSection(), "alpha");
    const { press, click: result } = click(panel, find(panel, "Beta"));
    assert.deepEqual(press, { handled: true, render: false });
    assert.deepEqual(result, { handled: true, render: true });
    assert.equal(panel.getActiveSection(), "beta");
    assert.equal(selected(panel), "Other row");
    const strip = find(panel, "Alpha");
    assert.equal(panel.handleMouse(mouse("press", strip.x - 1, strip.y)), undefined);
  } finally {
    panel.dispose();
  }
});

test(
  "a click on a row changes that row, also when the list has scrolled",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { panel, changes } = await makePanel();
    try {
      const { press, click: result } = click(panel, find(panel, rowLabel(2)));
      assert.deepEqual(press, { handled: true });
      assert.deepEqual(result, { handled: true });
      assert.deepEqual(changes, [["r2", "on"]]);
      assert.equal(selected(panel), rowLabel(2));

      for (let step = 0; step < 9; step += 1) panel.handleInput("\u001b[B");
      assert.equal(selected(panel), rowLabel(11));
      assert.ok(!panel.render(WIDTH).join("\n").includes("First group"), "the list scrolled");
      click(panel, find(panel, rowLabel(12)));
      assert.deepEqual(changes.at(-1), ["r12", "on"]);
      assert.equal(selected(panel), rowLabel(12));
      panel.handleInput("\u001b[B");
      assert.equal(selected(panel), rowLabel(13));
    } finally {
      panel.dispose();
    }
  },
);

test(
  "a heading takes no press, and the wheel and Page keys skip headings",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { panel, changes } = await makePanel();
    try {
      assert.equal(selected(panel), rowLabel(1));
      const heading = find(panel, "First group");
      assert.equal(panel.handleMouse(mouse("press", heading.x, heading.y)), undefined);
      assert.equal(selected(panel), rowLabel(1));

      const list = find(panel, rowLabel(2));
      panel.handleMouse(mouse("wheel", list.x, list.y, { wheelDelta: 1 }));
      panel.handleMouse(mouse("wheel", list.x, list.y, { wheelDelta: 1 }));
      assert.equal(selected(panel), rowLabel(3), "the wheel steps over Second group");
      panel.handleMouse(mouse("wheel", list.x, list.y, { wheelDelta: -3 }));
      assert.equal(selected(panel), rowLabel(2));

      panel.handleInput("\u001b[5~");
      assert.equal(selected(panel), rowLabel(1));
      panel.handleInput("\u001b[6~");
      assert.equal(selected(panel), rowLabel(8));
      assert.deepEqual(changes, []);
    } finally {
      panel.dispose();
    }
  },
);

test(
  "a click opens a row's submenu, which then takes the mouse over the list",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const seen: TuiMouseEvent[] = [];
    const picker: Component = {
      render: () => ["  Choice one", "  Choice two"],
      invalidate: () => {},
      handleMouse: (event) => {
        seen.push(event);
        return { handled: true, focus: true };
      },
    };
    const { panel } = await makePanel(() => picker);
    try {
      click(panel, find(panel, rowLabel(1)));
      assert.equal(panel.hasOpenSubmenu(), true);
      const choice = find(panel, "Choice two");
      const result = panel.handleMouse(mouse("press", choice.x, choice.y));
      assert.deepEqual(result, { handled: true }, "the host keeps keyboard focus");
      assert.equal(seen.at(-1)?.y, 1, "the submenu sees its own row");
      const strip = find(panel, "Beta");
      assert.equal(panel.handleMouse(mouse("click", strip.x, strip.y)), undefined);
      assert.equal(panel.getActiveSection(), "alpha");
    } finally {
      panel.dispose();
    }
  },
);

test(
  "a narrow strip shows the sections around the active one, and its markers step past the edge",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { panel } = await makePanel();
    const width = 40;
    const strip = (): string => stripVTControlCharacters(panel.render(width)[1] ?? "");
    const at = (text: string) => ({ x: strip().indexOf(text), y: 1 });
    const clickStrip = (text: string): void => {
      const cell = at(text);
      assert.ok(cell.x >= 0, `${text} is in ${strip()}`);
      panel.handleMouse(mouse("press", cell.x, cell.y, { width }));
      panel.render(width);
      panel.handleMouse(mouse("click", cell.x, cell.y, { width }));
      panel.render(width);
    };
    panel.render(width);
    assert.match(strip(), /^ {2}Alpha \/ Beta \/ .* ›$/, strip());
    assert.ok(stripVTControlCharacters(panel.render(width).join("\n")).length > 0);
    clickStrip("Beta");
    assert.equal(panel.getActiveSection(), "beta");
    const hiddenAfter = panel.getActiveSection();
    clickStrip("›");
    assert.notEqual(panel.getActiveSection(), hiddenAfter);
    assert.match(strip(), /^ {2}‹ /, strip());
    clickStrip("‹");
    assert.ok(strip().includes(" / ") || strip().includes("›"));
    for (const line of panel.render(width))
      assert.ok(stripVTControlCharacters(line).length <= width);
  },
);
