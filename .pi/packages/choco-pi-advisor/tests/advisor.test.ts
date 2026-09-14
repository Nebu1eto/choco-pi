import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildAdvisorPrompt } from "../src/consult.ts";
import { buildAdvisorExcerpt, countAdvisorCallsThisTurn } from "../src/excerpt.ts";
import { resolveAdvisorManager } from "../src/manager-slot.ts";
import { isSameModel, sameModelDisabledMessage } from "../src/model-gate.ts";
import {
  buildAdvisorPreferencesSection,
  drainWriteQueueForTests,
} from "../src/preferences-section.ts";
import {
  DEFAULT_SETTINGS,
  loadAdvisorSettings,
  writeGlobalAdvisorSettings,
} from "../src/settings.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "advisor-test-"));
  const global = join(root, "global");
  const project = join(root, "project");
  await Promise.all([mkdir(global), mkdir(join(project, ".pi"), { recursive: true })]);
  return { root, global, project };
}

function user(text: string, id = "user"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  };
}
function result(toolName: string, text = "result"): SessionEntry {
  return {
    type: "message",
    id: toolName,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolName,
      toolCallId: "call",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 2,
    },
  };
}

test("settings defaults, layering, unknown keys, and positive maxUses", async () => {
  const dirs = await fixture();
  try {
    assert.deepEqual(await loadAdvisorSettings(dirs.global, dirs.project), {
      settings: DEFAULT_SETTINGS,
      warnings: [],
    });
    await writeFile(
      join(dirs.global, "advisor.json"),
      JSON.stringify({ enabled: true, effort: "high", maxUses: 3, ignored: "value" }),
    );
    await writeFile(
      join(dirs.project, ".pi/advisor.json"),
      JSON.stringify({ model: "provider/model", effort: "low" }),
    );
    assert.deepEqual((await loadAdvisorSettings(dirs.global, dirs.project)).settings, {
      enabled: true,
      model: "provider/model",
      effort: "low",
      maxUses: 3,
    });
    await writeGlobalAdvisorSettings(dirs.global, { model: "global/new", maxUses: undefined });
    const loaded = await loadAdvisorSettings(dirs.global, dirs.project);
    assert.equal(loaded.settings.maxUses, undefined);
    assert.equal(loaded.settings.enabled, true);
    assert.equal(loaded.settings.model, "provider/model");
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("malformed and invalid layers fall back and warn once per layer", async () => {
  const dirs = await fixture();
  try {
    for (const invalid of [
      "{",
      "null",
      "[]",
      '{"maxUses":0}',
      '{"maxUses":-1}',
      '{"maxUses":1.5}',
      '{"enabled":"yes"}',
      '{"effort":"extreme"}',
    ]) {
      await writeFile(join(dirs.global, "advisor.json"), invalid);
      const loaded = await loadAdvisorSettings(dirs.global, dirs.project);
      assert.deepEqual(loaded.settings, DEFAULT_SETTINGS);
      assert.equal(loaded.warnings.length, 1);
    }
    await writeFile(join(dirs.global, "advisor.json"), '{"enabled":true,"maxUses":3}');
    await writeFile(join(dirs.project, ".pi/advisor.json"), "{");
    const loaded = await loadAdvisorSettings(dirs.global, dirs.project);
    assert.equal(loaded.settings.enabled, false);
    assert.equal(loaded.settings.maxUses, undefined);
    assert.equal(loaded.warnings.length, 1);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("settings writes default missing files, reject malformed files, and preserve invalid objects", async () => {
  const dirs = await fixture();
  try {
    await writeGlobalAdvisorSettings(dirs.global, { enabled: true });
    assert.deepEqual(JSON.parse(await readFile(join(dirs.global, "advisor.json"), "utf8")), {
      ...DEFAULT_SETTINGS,
      enabled: true,
    });

    for (const invalid of ["{", "null", "[]"]) {
      await writeFile(join(dirs.global, "advisor.json"), invalid);
      await assert.rejects(
        writeGlobalAdvisorSettings(dirs.global, { enabled: true }),
        /Could not update advisor settings/,
      );
      assert.equal(await readFile(join(dirs.global, "advisor.json"), "utf8"), invalid);
    }

    const raw = { model: "mine/model", maxUses: 0, note: { keep: ["me"] } };
    await writeFile(join(dirs.global, "advisor.json"), JSON.stringify(raw));
    await writeGlobalAdvisorSettings(dirs.global, { enabled: true });
    assert.deepEqual(JSON.parse(await readFile(join(dirs.global, "advisor.json"), "utf8")), {
      ...raw,
      enabled: true,
    });
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("excerpt caps entries and tool results, drops oldest first, includes live last turn", () => {
  const entries = Array.from({ length: 25 }, (_, i) =>
    user(`entry-${i} ${"x".repeat(3000)}`, String(i)),
  );
  entries.push(user("current in-flight turn"));
  const excerpt = buildAdvisorExcerpt(entries);
  assert.ok(excerpt.length <= 12000);
  assert.ok(!excerpt.includes("entry-0 "));
  assert.ok(!excerpt.includes("entry-19 "));
  assert.ok(excerpt.includes("entry-20 "));
  assert.ok(excerpt.endsWith("current in-flight turn"));
  assert.equal(buildAdvisorExcerpt([user("x".repeat(4000))]).length, 2000);
  assert.equal(buildAdvisorExcerpt([result("read", "x".repeat(1000))]).length, 500);
  assert.equal(buildAdvisorExcerpt(entries, { maxMessages: 0 }), "");
  assert.equal(
    buildAdvisorExcerpt([user("first"), user("last")], { maxTotalChars: 10 }),
    "user: last",
  );
});

test("turn cap counts only advisor tool results after the last user", () => {
  const entries: SessionEntry[] = [
    user("old"),
    result("advisor"),
    user("new"),
    result("read"),
    result("advisor"),
    {
      type: "label",
      id: "label",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      targetId: "new",
      label: "label",
    },
    result("advisor"),
  ];
  assert.equal(countAdvisorCallsThisTurn(entries), 2);
  assert.equal(countAdvisorCallsThisTurn([...entries, user("next")]), 0);
  assert.equal(DEFAULT_SETTINGS.maxUses, undefined);
});

test("same-model gate matches provider and id case-insensitively", () => {
  assert.equal(
    isSameModel(
      { provider: "Anthropic", id: "Claude-Fable" },
      { provider: "anthropic", id: "claude-fable" },
    ),
    true,
  );
});

test("same-model gate rejects a different id", () => {
  assert.equal(
    isSameModel(
      { provider: "anthropic", id: "claude-fable" },
      { provider: "anthropic", id: "claude-opus" },
    ),
    false,
  );
});

test("same-model gate rejects a different provider with the same id", () => {
  assert.equal(
    isSameModel(
      { provider: "anthropic", id: "shared-id" },
      { provider: "openai", id: "shared-id" },
    ),
    false,
  );
});

test("same-model gate permits an undefined session model", () => {
  assert.equal(isSameModel(undefined, { provider: "anthropic", id: "claude-fable" }), false);
});

test("same-model skips do not consume the per-turn cap", () => {
  const message = sameModelDisabledMessage({ provider: "anthropic", id: "claude-fable" });
  assert.equal(
    message,
    "advisor is disabled for this session: the advisor model (anthropic/claude-fable) is the same as the session model; pick a different advisor model in /preferences",
  );
  assert.equal(countAdvisorCallsThisTurn([user("question"), result("advisor", message)]), 0);
});

test("prompt cache prefix is stable and question is last", () => {
  const excerpt = buildAdvisorExcerpt([user("live turn")]);
  const first = buildAdvisorPrompt(excerpt, "context", "First question?");
  const second = buildAdvisorPrompt(excerpt, "context", "Second question?");
  assert.equal(
    first.slice(0, -"First question?".length),
    second.slice(0, -"Second question?".length),
  );
  assert.ok(second.endsWith("Question:\nSecond question?"));
  assert.ok(first.indexOf(excerpt) < first.indexOf("Context:\ncontext"));
});

test("preferences expose four rows and serialize global writes", async () => {
  const dirs = await fixture();
  try {
    const section = buildAdvisorPreferencesSection({
      agentDir: dirs.global,
      settings: { ...DEFAULT_SETTINGS },
      models: ["p/m"],
    });
    assert.equal(section.label, "Advisor Agent");
    assert.ok(!("mergeInto" in section));
    const rows = section.buildItems();
    assert.deepEqual(
      rows.map((row) => row.currentValue),
      ["off", DEFAULT_SETTINGS.model, "low", "0"],
    );
    assert.ok(rows[3]?.submenu);
    section.handleChange("advisor.enabled", "on");
    section.handleChange("advisor.model", "p/m");
    section.handleChange("advisor.effort", "max");
    section.handleChange("advisor.maxUses", "4");
    await drainWriteQueueForTests();
    assert.equal((await loadAdvisorSettings(dirs.global, dirs.project)).settings.maxUses, 4);
    section.handleChange("advisor.maxUses", "0");
    await drainWriteQueueForTests();
    assert.deepEqual((await loadAdvisorSettings(dirs.global, dirs.project)).settings, {
      enabled: true,
      model: "p/m",
      effort: "max",
    });
    assert.ok(!(await readFile(join(dirs.global, "advisor.json"), "utf8")).includes("maxUses"));
    assert.equal(section.handleChange("advisor.maxUses", "-1").kind, "rebuild");
    section.handleChange("advisor.maxUses", "");
    await drainWriteQueueForTests();
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("preferences notify immediately and revert after a failed write", async () => {
  const dirs = await fixture();
  try {
    await writeFile(join(dirs.global, "advisor.json"), "{");
    const notifications: string[] = [];
    const settings = { ...DEFAULT_SETTINGS };
    const section = buildAdvisorPreferencesSection({
      agentDir: dirs.global,
      settings,
      models: [],
      ctx: {
        hasUI: true,
        ui: { notify: (message) => notifications.push(message) },
      },
      isActive: () => true,
    });
    assert.equal(section.handleChange("advisor.enabled", "on").kind, "rebuild");
    await drainWriteQueueForTests();
    assert.equal(section.buildItems()[0]?.currentValue, "off");
    assert.equal(settings.enabled, false);
    assert.match(notifications[0] ?? "", /Could not save advisor settings/);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("manager slot is resolved lazily and rejects non-callable shapes", () => {
  const symbol = Symbol.for("pi-subagents:manager");
  const previous = Object.getOwnPropertyDescriptor(globalThis, symbol);
  try {
    Reflect.deleteProperty(globalThis, symbol);
    assert.equal(resolveAdvisorManager(), undefined);
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      value: { spawn: "invalid", getRecord: () => undefined },
    });
    assert.equal(resolveAdvisorManager(), undefined);
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      value: { spawn: () => "id", getRecord: () => undefined },
    });
    assert.ok(resolveAdvisorManager());
  } finally {
    if (previous) Object.defineProperty(globalThis, symbol, previous);
    else Reflect.deleteProperty(globalThis, symbol);
  }
});
