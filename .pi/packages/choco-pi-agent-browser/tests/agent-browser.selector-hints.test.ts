import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRefSnapshot } from "../extensions/agent-browser/lib/session-page-state.ts";
import { compileAgentBrowserSemanticAction } from "../extensions/agent-browser/lib/input-modes/semantic-action.ts";
import { buildToolPromptGuidelines } from "../extensions/agent-browser/lib/playbook.ts";
import { buildAgentBrowserNextActions } from "../extensions/agent-browser/lib/results/action-recommendations.ts";
import {
  buildPlaywrightSelectorHint,
  buildUnicodeSelectorHint,
} from "../extensions/agent-browser/lib/results/selector-hints.ts";

void test("Playwright text selector compiles to an equivalent semantic click", () => {
  const [hint] = buildPlaywrightSelectorHint({ commandTokens: ["click", "text=Claude Haiku 5.5"] });
  assert.deepEqual(hint.params, {
    semanticAction: { action: "click", locator: "text", value: "Claude Haiku 5.5" },
  });
  assert.equal(hint.reason, "Playwright selector dialect is not supported by agent-browser");
  assert.deepEqual(compileAgentBrowserSemanticAction(hint.params?.semanticAction), {
    compiled: {
      action: "click",
      locator: "text",
      args: ["find", "text", "Claude Haiku 5.5", "click"],
    },
  });
});

void test("dialect hints preserve fill payload and explicit session", () => {
  const [hint] = buildPlaywrightSelectorHint({
    commandTokens: ["fill", "label=Search", "model"],
    sessionName: "session-a",
  });
  assert.deepEqual(hint.params?.semanticAction, {
    action: "fill",
    locator: "label",
    value: "Search",
    text: "model",
    session: "session-a",
  });
  for (const selector of ["role=button", "button:has-text('Close')"]) {
    const [candidate] = buildPlaywrightSelectorHint({ commandTokens: ["click", selector] });
    assert.ok(compileAgentBrowserSemanticAction(candidate.params?.semanticAction).compiled);
  }
});

void test("Unicode placeholder matches a unique current ref without CLI calls", () => {
  const snapshot = { refIds: ["e36"], refs: { e36: { name: "Search models…", role: "textbox" } } };
  for (const action of ["click", "fill"]) {
    const [hint] = buildUnicodeSelectorHint({
      commandTokens: [action, 'input[placeholder="Search models..."]', "model"],
      snapshot,
    });
    assert.deepEqual(
      hint.params?.args,
      action === "fill" ? ["fill", "@e36", "model"] : ["click", "@e36"],
    );
    assert.equal(hint.reason, "placeholder uses Unicode ellipsis");
  }
  assert.equal(
    buildUnicodeSelectorHint({
      commandTokens: ["click", 'input[placeholder="Owner\'s search"]'],
      snapshot: { refIds: ["e1"], refs: { e1: { name: "Owner’s search", role: "textbox" } } },
    }).length,
    1,
  );
});

void test("no selector hint for missing, unchanged, noncurrent, or ambiguous matches", () => {
  assert.deepEqual(buildPlaywrightSelectorHint({ commandTokens: ["click", "#missing"] }), []);
  const commandTokens = ["fill", 'input[placeholder="Search models..."]', "model"];
  const snapshots: SessionRefSnapshot[] = [
    { refIds: ["e1"], refs: { e1: { name: "Other", role: "textbox" } } },
    { refIds: ["e1"], refs: { e1: { name: "Search models...", role: "textbox" } } },
    { refIds: [], refs: { e1: { name: "Search models…", role: "textbox" } } },
    {
      refIds: ["e1", "e2"],
      refs: {
        e1: { name: "Search models…", role: "textbox" },
        e2: { name: "Search models…", role: "textbox" },
      },
    },
  ];
  for (const snapshot of snapshots)
    assert.deepEqual(buildUnicodeSelectorHint({ commandTokens, snapshot }), []);
  assert.deepEqual(buildUnicodeSelectorHint({ commandTokens }), []);
});

void test("guidance includes exact Unicode and Playwright warnings once", () => {
  const guidance = buildToolPromptGuidelines({ includeWebSearch: false }).join("\n");
  for (const sentence of [
    "Copy accessible names and placeholders exactly as the snapshot prints them (Unicode such as … ’ – is common)",
    "never use Playwright `text=`/`:has-text()` selectors — they fail as selector-not-found.",
  ])
    assert.equal(guidance.split(sentence).length - 1, 1);
  const actions = buildAgentBrowserNextActions({
    failureCategory: "stale-ref",
    resultCategory: "failure",
  });
  assert.ok(
    actions?.[0].reason.includes(
      "Any click that rerenders a React list can recycle refs; re-snapshot before the next ref action even without navigation.",
    ),
  );
});
