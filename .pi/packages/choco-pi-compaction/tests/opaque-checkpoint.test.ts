/** Opaque-history guard predicates and the process-global consent slot (D2/D3). */
import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { LaneId } from "../src/background/lane-journal.ts";
import {
  laneMayAnswerOverOpaque,
  lossAuthorized,
  lossAuthorizedFor,
  OPAQUE_CONSENT_SYMBOL,
  OPAQUE_GUARD_NOTICE,
  OPAQUE_STRATEGIES,
  opaqueCheckpointOf,
  publishOpaqueConsent,
} from "../src/opaque-checkpoint.ts";

function message(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: id, timestamp: 1 },
  };
}

function compaction(id: string, strategy: string | undefined): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "summary",
    firstKeptEntryId: id,
    tokensBefore: 10,
    details: strategy === undefined ? undefined : { strategy, other: 1 },
  };
}

test("each opaque strategy maps to its owner", () => {
  const cases = [
    ["xai-responses-compaction-v1", "xai-native"],
    ["openai-responses-compaction-v2", "codex-native"],
    ["openai-native-compact-v1", "codex-native"],
  ] as const;
  assert.deepEqual([...OPAQUE_STRATEGIES].sort(), cases.map(([strategy]) => strategy).sort());
  for (const [strategy, owner] of cases) {
    assert.deepEqual(opaqueCheckpointOf([message("m1"), compaction("c1", strategy)]), {
      entryId: "c1",
      strategy,
      owner,
    });
  }
});

test("the newest compaction entry decides", () => {
  const olderOpaque = compaction("c1", "xai-responses-compaction-v1");
  assert.equal(
    opaqueCheckpointOf([olderOpaque, message("m1"), compaction("c2", "local-reconciled")]),
    undefined,
  );
  assert.equal(opaqueCheckpointOf([olderOpaque, compaction("c2", undefined)]), undefined);
  assert.equal(
    opaqueCheckpointOf([compaction("c0", "local-reconciled"), olderOpaque, message("m2")])?.entryId,
    "c1",
  );
  assert.equal(opaqueCheckpointOf([message("m1")]), undefined);
});

test("only the owning lane may answer over an opaque checkpoint", () => {
  const lanes: readonly LaneId[] = [
    "anthropic-native",
    "xai-native",
    "codex-native-v2",
    "codex-foreground",
    "text",
    "local",
    "host-default",
  ];
  const allowed = (owner: "xai-native" | "codex-native") =>
    lanes.filter((lane) => laneMayAnswerOverOpaque(lane, { owner }));
  assert.deepEqual(allowed("xai-native"), ["xai-native"]);
  assert.deepEqual(allowed("codex-native"), ["codex-native-v2", "codex-foreground"]);
});

test("loss is authorized by the setting or by a consent for exactly that checkpoint", () => {
  assert.equal(
    lossAuthorized({ opaqueHistory: "allow-loss", opaqueConsent: new Map() }, "s1", "A"),
    true,
  );
  const consent = new Map([["s1", "A"]]);
  assert.equal(
    lossAuthorized({ opaqueHistory: "preserve", opaqueConsent: consent }, "s1", "A"),
    true,
  );
  assert.equal(
    lossAuthorized({ opaqueHistory: "preserve", opaqueConsent: consent }, "s1", "B"),
    false,
  );
  assert.equal(
    lossAuthorized({ opaqueHistory: "preserve", opaqueConsent: consent }, "s2", "A"),
    false,
  );
});

test("the guard notice names the checkpoint and every exit", () => {
  const text = OPAQUE_GUARD_NOTICE("xai", "entry-7");
  assert.ok(text.includes("entry-7"));
  assert.ok(text.includes("/compaction-allow-loss"));
  assert.ok(text.includes("compactionOpaqueHistory=allow-loss"));
});

test("the consent slot fails closed when absent or foreign and honours published resolvers", () => {
  Reflect.deleteProperty(globalThis, OPAQUE_CONSENT_SYMBOL);
  assert.equal(lossAuthorizedFor("s1", "A"), false);

  const remove = publishOpaqueConsent(
    (sessionId, entryId) => sessionId === "s1" && entryId === "A",
  );
  assert.equal(lossAuthorizedFor("s1", "A"), true);
  assert.equal(lossAuthorizedFor("s1", "B"), false);
  const second = publishOpaqueConsent((sessionId) => sessionId === "s2");
  assert.equal(lossAuthorizedFor("s2", "anything"), true);
  remove();
  assert.equal(lossAuthorizedFor("s1", "A"), false);
  second();
  assert.equal(lossAuthorizedFor("s2", "anything"), false);

  Reflect.deleteProperty(globalThis, OPAQUE_CONSENT_SYMBOL);
  Object.defineProperty(globalThis, OPAQUE_CONSENT_SYMBOL, {
    value: { lossAuthorizedFor: () => true },
    configurable: true,
  });
  assert.equal(lossAuthorizedFor("s1", "A"), false, "a foreign slot is refused");
  const noop = publishOpaqueConsent(() => true);
  assert.equal(lossAuthorizedFor("s1", "A"), false, "nothing is published into a foreign slot");
  noop();
  Reflect.deleteProperty(globalThis, OPAQUE_CONSENT_SYMBOL);
});
