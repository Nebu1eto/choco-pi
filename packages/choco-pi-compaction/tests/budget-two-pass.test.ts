import assert from "node:assert/strict";
import test from "node:test";

import {
  promptFits,
  RESPONSE_MARGIN_TOKENS,
  resolveMaxTokens,
  selectTailWithinBudget,
} from "../src/budget.ts";
import { serializeMessages } from "../src/serialize.ts";
import type { CompactionMessage } from "../src/types.ts";
import { ordinaryCut, partialThenFailure } from "./fixtures.ts";
import { compactionExtension, type CompactionHost, createCompactionHost } from "./host-harness.ts";

const HISTORY_PASS_TEXT = "## Goal\nhistory pass output marker";

async function hostFor(contextWindow: number, keepRecentTokens = 200): Promise<CompactionHost> {
  return await createCompactionHost({
    keepRecentTokens,
    reserveTokens: 1_000,
    contextWindow,
    maxTokens: 400,
    extensionFactories: [compactionExtension()],
    script: (_call, index) => ({ text: index === 0 ? HISTORY_PASS_TEXT : "## Goal\nreconciled" }),
  });
}

test("S7: a context window too small for one request produces two passes", async () => {
  const host = await hostFor(1_900);
  try {
    const fixture = ordinaryCut(host.sessionManager);
    await host.session.compact();

    assert.equal(host.calls.length, 2, "history pass and reconciliation pass");
    const first = host.calls[0]?.promptText ?? "";
    const second = host.calls[1]?.promptText ?? "";
    assert.equal(first.includes("<current-state-evidence>"), false);
    assert.ok(first.includes("<conversation>"));
    assert.ok(second.includes(`<history-summary>\n${HISTORY_PASS_TEXT}\n</history-summary>`));
    for (const sentinel of fixture.completionSentinels) {
      assert.ok(second.includes(sentinel), `newest tail evidence missing verbatim: ${sentinel}`);
    }
    const committed = host.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "compaction")
      .at(-1);
    assert.ok(committed);
    assert.ok(committed.summary.startsWith("## Goal\nreconciled"));
    assert.equal(committed.usage?.input, 22);
    assert.equal(committed.usage?.output, 14);
    assert.equal(committed.usage?.totalTokens, 36);
  } finally {
    await host.dispose();
  }
});

test("S7: a tail that cannot fit at all fails instead of summarizing history alone", async () => {
  const host = await hostFor(1_650);
  try {
    ordinaryCut(host.sessionManager);
    await assert.rejects(host.session.compact(), /Compaction cancelled/);
    assert.equal(host.calls.length, 1, "only the history pass was issued");
    assert.equal(
      host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
      false,
      "no checkpoint may be committed when the evidence does not fit",
    );
  } finally {
    await host.dispose();
  }
});

test("S7: history too large for even its own pass fails before any call", async () => {
  const host = await hostFor(1_500, 400);
  try {
    partialThenFailure(host.sessionManager);
    await assert.rejects(host.session.compact(), /Compaction cancelled/);
    assert.equal(host.calls.length, 0, "no request is issued when the history cannot fit");
    assert.equal(
      host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
      false,
    );
  } finally {
    await host.dispose();
  }
});

test("the tail selection drops oldest first and never the newest", () => {
  const model = { contextWindow: 1_000, maxTokens: 100 };
  const messages: CompactionMessage[] = ["oldest", "middle", "newest"].map((text) => ({
    role: "user",
    content: text,
    timestamp: 0,
  }));
  const render = (tail: readonly CompactionMessage[]): string =>
    serializeMessages(tail).padEnd(tail.length * 1_200, "-");

  const selected = selectTailWithinBudget(model, 100, "", render, messages);
  assert.equal(selected.length, 1);
  assert.ok(serializeMessages(selected).includes("newest"));
  assert.equal(serializeMessages(selected).includes("oldest"), false);

  assert.throws(
    () =>
      selectTailWithinBudget(
        model,
        100,
        "",
        (tail) => "x".repeat(Math.max(tail.length, 1) * 20_000),
        messages,
      ),
    /compaction evidence exceeds the model budget/,
  );
});

test("the fit test accounts for the output reserve and margin", () => {
  const model = { contextWindow: 1_000, maxTokens: 4_000 };
  assert.equal(
    resolveMaxTokens(model, { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 }),
    800,
  );
  assert.equal(
    resolveMaxTokens(
      { contextWindow: 524_288, maxTokens: 65_536, reasoning: true },
      { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 },
    ),
    32_768,
  );
  assert.equal(
    resolveMaxTokens(
      { contextWindow: 200_000, maxTokens: 8_192, reasoning: true },
      { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 },
    ),
    8_192,
  );
  assert.equal(
    resolveMaxTokens(
      { contextWindow: 1_000, maxTokens: 100 },
      {
        enabled: true,
        reserveTokens: 1_000,
        keepRecentTokens: 1,
      },
    ),
    100,
  );

  const budgetForPrompt = 1_000 - 100 - RESPONSE_MARGIN_TOKENS;
  assert.equal(promptFits(model, 100, "", "a".repeat(budgetForPrompt * 4)), true);
  assert.equal(promptFits(model, 100, "", "a".repeat((budgetForPrompt + 1) * 4)), false);
  assert.equal(
    promptFits({ contextWindow: 0, maxTokens: 0 }, 100, "", "a".repeat(100_000)),
    true,
    "an unknown context window imposes no limit",
  );
});
