import assert from "node:assert/strict";
import test from "node:test";
import type { SettingItem } from "@earendil-works/pi-tui";
import {
  describeAgentResult,
  editSettingsWithDialogs,
  pickAgentType,
  type HeadlessUI,
} from "../src/ui/headless-menus.ts";
import type { AgentRecord } from "../src/types.ts";

type Answer = string | undefined;

function scriptedUI(selects: Answer[], inputs: Answer[] = []) {
  const prompts: string[] = [];
  const notices: string[] = [];
  const ui: HeadlessUI = {
    select: async (title, options) => {
      prompts.push(`select:${title}`);
      const wanted = selects.shift();
      return wanted === undefined ? undefined : options.find((option) => option.includes(wanted));
    },
    input: async (title) => {
      prompts.push(`input:${title}`);
      return inputs.shift();
    },
    notify: (message) => {
      notices.push(message);
    },
  };
  return { ui, prompts, notices };
}

test("agent types are chosen from a numbered dialog", async () => {
  const items: SettingItem[] = [
    { id: "explore", label: "   explore", currentValue: "inherit" },
    { id: "review", label: "◦  review", currentValue: "openai/gpt" },
  ];
  const { ui } = scriptedUI(["review · openai/gpt"]);
  assert.equal(await pickAgentType(ui, items), "review");
  assert.equal(await pickAgentType(scriptedUI([undefined]).ui, items), undefined);
});

test("settings dialogs apply picked values and validated numbers until cancelled", async () => {
  const state = new Map([
    ["mode", "on"],
    ["limit", "4"],
  ]);
  const build = (): SettingItem[] => [
    { id: "mode", label: "Mode", currentValue: state.get("mode") ?? "", values: ["on", "off"] },
    { id: "limit", label: "Limit", currentValue: state.get("limit") ?? "", values: ["4"] },
  ];
  const applied: string[] = [];
  const { ui, notices } = scriptedUI(["Mode: on", "off", "Limit: 4", undefined], ["x", " 7 "]);
  await editSettingsWithDialogs(
    ui,
    build,
    (id, value) => {
      applied.push(`${id}=${value}`);
      state.set(id, value);
    },
    { ids: new Set(["limit"]), label: () => "Limit (1-10)" },
  );
  assert.deepEqual(applied, ["mode=off", "limit=7"]);
  assert.deepEqual(notices, ["Limit needs a whole number."]);
});

test("agent result text explains a missing answer", () => {
  const base: AgentRecord = {
    id: "a",
    type: "general",
    description: "d",
    status: "running",
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
  assert.equal(describeAgentResult(base), "No answer yet.");
  assert.equal(describeAgentResult({ ...base, status: "completed" }), "No answer was recorded.");
  assert.equal(describeAgentResult({ ...base, status: "error", error: "boom" }), "Error: boom");
  assert.equal(describeAgentResult({ ...base, result: " done " }), "done");
});
