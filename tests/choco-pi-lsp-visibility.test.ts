import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installChocoPiLspVisibility } from "../.pi/extensions/choco-pi-lsp-visibility.ts";

type Ui = ExtensionContext["ui"];

function testUi() {
  const statuses = new Map<string, string>();
  const widgets = new Map<string, unknown>();
  const ui = {
    setStatus: (key: string, value: string | undefined) => {
      if (value === undefined) statuses.delete(key);
      else statuses.set(key, value);
    },
    setWidget: (key: string, value: unknown) => {
      if (value === undefined) widgets.delete(key);
      else widgets.set(key, value);
    },
  } as unknown as Ui;
  return { ui, statuses, widgets };
}

test("choco-pi-lsp UI stays hidden while LSP is inactive and appears when active", () => {
  const { ui, statuses, widgets } = testUi();
  installChocoPiLspVisibility(ui);
  const widget = () => ({ render: () => ["choco-pi-lsp"], invalidate: () => {} });

  ui.setStatus("choco-pi-lsp", "LSP Inactive");
  ui.setWidget("choco-pi-lsp", widget as never, { placement: "belowEditor" });
  assert.equal(statuses.has("choco-pi-lsp"), false);
  assert.equal(widgets.has("choco-pi-lsp"), false);

  ui.setStatus("choco-pi-lsp", "LSP Active: typescript");
  assert.equal(statuses.get("choco-pi-lsp"), "LSP Active: typescript");
  assert.equal(widgets.get("choco-pi-lsp"), widget);

  ui.setStatus("choco-pi-lsp", "LSP Inactive");
  assert.equal(statuses.has("choco-pi-lsp"), false);
  assert.equal(widgets.has("choco-pi-lsp"), false);
});

test("choco-pi-lsp failures remain visible and unrelated UI is unchanged", () => {
  const { ui, statuses, widgets } = testUi();
  installChocoPiLspVisibility(ui);

  ui.setStatus("choco-pi-lsp", "LSP Failed: typescript");
  ui.setStatus("other", "ready");
  ui.setWidget("other", ["content"]);

  assert.equal(statuses.get("choco-pi-lsp"), "LSP Failed: typescript");
  assert.equal(statuses.get("other"), "ready");
  assert.deepEqual(widgets.get("other"), ["content"]);
});
