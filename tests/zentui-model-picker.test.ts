import assert from "node:assert/strict";
import test from "node:test";
import { getSettingsListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList, stripTerminalSequences } from "@earendil-works/pi-tui";
import { modelPickerSubmenu } from "../.pi/extensions/lib/model-picker.ts";

initTheme("dark", false);

const choices = [
  { provider: "zeta", id: "last" },
  { provider: "alpha", id: "second" },
  { provider: "alpha", id: "first" },
  { provider: "alpha", id: "first" },
];

test("model picker sorts and deduplicates full labels and preselects case-insensitively", () => {
  const events: string[] = [];
  const picker = modelPickerSubmenu({
    choices,
    onPick: (value) => events.push(`pick:${value}`),
  })("ALPHA/SECOND", (value) => events.push(`done:${value}`));
  const lines = picker.render(100).map(stripTerminalSequences);
  assert.deepEqual(lines.slice(1), ["  alpha/first", "→ alpha/second", "  zeta/last"]);
  assert.match(lines[0] ?? "", /Filter models:/);
  picker.handleInput?.("\r");
  picker.handleInput?.("\r");
  picker.handleInput?.("\x1b");
  assert.deepEqual(events, ["pick:alpha/second", "done:alpha/second"]);
});

test("model picker defaults missing current values to the first sorted choice", () => {
  const picked: string[] = [];
  const picker = modelPickerSubmenu({ choices, onPick: (value) => picked.push(value) })(
    "missing/model",
    () => {},
  );
  picker.handleInput?.("\r");
  assert.deepEqual(picked, ["alpha/first"]);
});

test("model picker filters typed text, accepts navigation and preserves slashes in model ids", () => {
  const picked: string[] = [];
  const picker = modelPickerSubmenu({
    choices: [...choices, { provider: "synthetic", id: "hf:Qwen/Qwen3.8-27B" }],
    onPick: (value) => picked.push(value),
  })("alpha/first", () => {});
  picker.handleInput?.("synthetic/");
  assert.deepEqual(picker.render(100).map(stripTerminalSequences).slice(1), [
    "→ synthetic/hf:Qwen/Qwen3.8-27B",
  ]);
  picker.handleInput?.("\r");
  assert.deepEqual(picked, ["synthetic/hf:Qwen/Qwen3.8-27B"]);
});

test("model picker edits the filter and leaves unmatched Enter inert", () => {
  const picked: string[] = [];
  const closed: (string | undefined)[] = [];
  const picker = modelPickerSubmenu({ choices, onPick: (value) => picked.push(value) })(
    "alpha/second",
    (value) => closed.push(value),
  );
  picker.handleInput?.("x");
  assert.match(picker.render(100).map(stripTerminalSequences).join("\n"), /No matching models/);
  picker.handleInput?.("\r");
  assert.deepEqual(closed, []);
  picker.handleInput?.("\x7f");
  picker.handleInput?.("\x1b[B");
  picker.handleInput?.("\r");
  assert.deepEqual(picked, ["alpha/second"]);
  assert.deepEqual(closed, ["alpha/second"]);
});

test("model picker cancels without writing, including the empty placeholder", () => {
  for (const models of [choices, []]) {
    for (const key of models.length === 0 ? ["\r", "\x1b"] : ["\x1b"]) {
      const picked: string[] = [];
      const closed: (string | undefined)[] = [];
      const picker = modelPickerSubmenu({ choices: models, onPick: (value) => picked.push(value) })(
        "alpha/first",
        (value) => closed.push(value),
      );
      if (models.length === 0) {
        assert.match(
          picker.render(100).map(stripTerminalSequences).join("\n"),
          /no models available/,
        );
        picker.handleInput?.("typed text");
      }
      picker.handleInput?.(key);
      picker.handleInput?.("\x1b");
      assert.deepEqual(picked, []);
      assert.deepEqual(closed, [undefined]);
    }
  }
});

test("SettingsList opens the picker in place and forwards typing, confirmation and cancellation", () => {
  const picked: string[] = [];
  const changes: string[] = [];
  const list = new SettingsList(
    [
      {
        id: "model",
        label: "Model",
        currentValue: "alpha/second",
        submenu: modelPickerSubmenu({ choices, onPick: (value) => picked.push(value) }),
      },
    ],
    8,
    getSettingsListTheme(),
    (_id, value) => changes.push(value),
    () => assert.fail("submenu cancellation must not close preferences"),
  );
  list.handleInput("\r");
  list.handleInput("zeta/");
  list.handleInput("\r");
  assert.deepEqual(picked, ["zeta/last"]);
  assert.deepEqual(changes, ["zeta/last"]);
  assert.match(list.render(100).map(stripTerminalSequences).join("\n"), /Model.*zeta\/last/);
  list.handleInput("\r");
  list.handleInput("\x1b");
  assert.deepEqual(changes, ["zeta/last"]);
});
