import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createSearchScope, registerSearchAdapter } from "../index.ts";

initTheme("dark", false);

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-web-search-pref-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { loadWebSearchConfig } = await import("../config-loader.ts");
const {
  buildPriorityChoices,
  buildWebSearchPreferencesSection,
  formatPrioritySummary,
  readWebSearchPreferencesState,
  waitForWebSearchPreferenceWrites,
} = await import("../preferences-section.ts");

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

test("buildPriorityChoices merges built-ins, aliases, custom families, and search models", () => {
  const scope = createSearchScope();
  registerSearchAdapter(scope, {
    id: "custom.searx",
    family: "searx",
    transport: "http",
    capabilities: { actions: ["search"] },
    availability: () => ({ status: "available" }),
    execute: async () => ({ answer: "", results: [] }),
  });
  const choices = buildPriorityChoices(
    scope,
    [
      { provider: "google-antigravity", id: "gemini-3.5-flash-lite" },
      { provider: "openai-codex", id: "gpt-6.1-terra" },
      { provider: "xai", id: "grok-4.3" },
      { provider: "anthropic", id: "claude-opus-5-5" },
    ],
    ["google/gemini-3.5-flash-lite"],
  );
  assert.ok(choices.includes("google/gemini-3.5-flash-lite"));
  assert.ok(choices.includes("openai-codex/gpt-6.1-terra"));
  assert.ok(choices.includes("xai/grok-4.3"));
  assert.ok(choices.includes("searx"));
  assert.ok(choices.includes("exa"));
  assert.ok(!choices.some((choice) => choice.startsWith("anthropic/")));
  assert.equal(choices.filter((choice) => choice === "google/gemini-3.5-flash-lite").length, 1);
});

test("web search preferences section edits and persists priority, summary, model, timeout, and billing", async () => {
  await loadWebSearchConfig({ fresh: true });
  const state = readWebSearchPreferencesState();
  assert.deepEqual(state.priority, []);
  assert.equal(state.summaryEnabled, true);
  assert.equal(state.summaryModel, "auto");
  assert.equal(state.attemptTimeoutSeconds, 25);
  assert.equal(state.allowBilledApiFallback, false);

  const section = buildWebSearchPreferencesSection({
    state,
    priorityChoices: ["google/gemini-3.5-flash-lite", "openai-codex/gpt-6.1-terra", "exa"],
    summaryModelChoices: [{ provider: "anthropic", id: "claude-haiku-5-5" }],
  });

  const items = section.buildItems();
  assert.deepEqual(
    items.map((item) => item.id),
    [
      "webSearch.priority",
      "webSearch.summary",
      "webSearch.summaryModel",
      "webSearch.attemptTimeoutSeconds",
      "webSearch.allowBilledApiFallback",
    ],
  );

  // Exercise PriorityEditorSubmenu: add entry, reorder, save on Esc
  const priorityItem = items[0];
  assert.ok(priorityItem?.submenu);
  let committed: string | undefined;
  const submenu = priorityItem.submenu("auto", (value) => {
    committed = value;
  });
  assert.ok(submenu.handleInput);
  assert.ok(submenu.render(100).some((line) => line.includes("Web search priority order")));
  // Open picker with "a", confirm first item ("google/gemini-3.5-flash-lite")
  submenu.handleInput("a");
  submenu.handleInput("\r");
  // Add second item ("openai-codex/gpt-6.1-terra")
  submenu.handleInput("a");
  submenu.handleInput("\r");
  // Move second item up to rank 1 using "u"
  submenu.handleInput("u");
  // Save with Escape
  submenu.handleInput("\x1b");
  assert.equal(committed, "openai-codex/gpt-6.1-terra, google/gemini-3.5-flash-lite");

  section.handleChange("webSearch.priority", committed ?? "");
  section.handleChange("webSearch.summary", "off");
  section.handleChange("webSearch.summaryModel", "anthropic/claude-haiku-5-5");
  section.handleChange("webSearch.attemptTimeoutSeconds", "15");
  section.handleChange("webSearch.allowBilledApiFallback", "on");
  await waitForWebSearchPreferenceWrites();

  const persisted = JSON.parse(await readFile(join(agentDir, "web-search.json"), "utf8"));
  assert.deepEqual(persisted.priority, [
    "openai-codex/gpt-6.1-terra",
    "google/gemini-3.5-flash-lite",
  ]);
  assert.deepEqual(persisted.summary, { enabled: false });
  assert.equal(persisted.summaryModel, "anthropic/claude-haiku-5-5");
  assert.equal(persisted.attemptTimeoutMs, 15_000);
  assert.equal(persisted.allowBilledApiFallback, true);
  assert.equal(
    formatPrioritySummary(state.priority),
    "openai-codex/gpt-6.1-terra -> google/gemini-3.5-flash...",
  );
  assert.equal(
    formatPrioritySummary(["google/gemini-3.5-pro", "exa"]),
    "google/gemini-3.5-pro -> exa",
  );

  // Reset priority back to auto
  section.handleChange("webSearch.priority", "auto");
  section.handleChange("webSearch.summaryModel", "auto");
  await waitForWebSearchPreferenceWrites();
  const afterReset = JSON.parse(await readFile(join(agentDir, "web-search.json"), "utf8"));
  assert.equal(afterReset.priority, undefined);
  assert.equal(afterReset.summaryModel, undefined);
});
