import assert from "node:assert/strict";
import test from "node:test";
import {
  type CodexConversionConfig,
  DEFAULT_CODEX_CONVERSION_CONFIG,
} from "../src/adapter/activation/config.ts";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import { createCodexCompactionEligibility } from "../src/extension/compaction-eligibility.ts";
import {
  CODEX_ELIGIBILITY_SLOT,
  readCodexEligibility,
} from "../../choco-pi-compaction/src/ownership.ts";

type EligibilityState = Pick<AdapterState, "config" | "canonicalAliasEndpoint">;

/** A listener that re-subscribes itself stops doing so past this many calls (bounds a regression). */
const RESUBSCRIBE_LIMIT = 3;

function configWith(responsesCompaction: boolean): CodexConversionConfig {
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  config.compaction.responsesCompaction = responsesCompaction;
  return config;
}

/** Run `body` against a fresh process slot; the previous slot (if any) is restored after. */
async function withFreshSlot(body: () => void | Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, CODEX_ELIGIBILITY_SLOT);
  Reflect.deleteProperty(globalThis, CODEX_ELIGIBILITY_SLOT);
  try {
    await body();
  } finally {
    if (previous) Object.defineProperty(globalThis, CODEX_ELIGIBILITY_SLOT, previous);
    else Reflect.deleteProperty(globalThis, CODEX_ELIGIBILITY_SLOT);
  }
}

test("a local listener that unsubscribes and re-subscribes itself runs once per refresh", async () => {
  await withFreshSlot(() => {
    const state: EligibilityState = {
      config: configWith(true),
      canonicalAliasEndpoint: undefined,
    };
    const eligibility = createCodexCompactionEligibility(() => state);
    let calls = 0;
    let unsubscribe = (): void => {};
    const listener = (): void => {
      calls += 1;
      if (calls > RESUBSCRIBE_LIMIT) return;
      unsubscribe();
      unsubscribe = eligibility.onChange(listener);
    };
    unsubscribe = eligibility.onChange(listener);
    state.config = configWith(false);
    assert.equal(eligibility.refresh(), true);
    assert.equal(calls, 1, "re-subscribed listener must not run again in the same refresh");
    state.config = configWith(true);
    assert.equal(eligibility.refresh(), true);
    assert.equal(calls, 2, "still subscribed: runs once on the next refresh");
    assert.equal(eligibility.refresh(), false, "unchanged inputs notify nobody");
    assert.equal(calls, 2);
    unsubscribe();
  });
});

test("a global slot listener that unsubscribes and re-subscribes itself runs once per revision", async () => {
  await withFreshSlot(() => {
    const state: EligibilityState = {
      config: configWith(true),
      canonicalAliasEndpoint: undefined,
    };
    const eligibility = createCodexCompactionEligibility(() => state);
    eligibility.publish();
    const slot = readCodexEligibility();
    assert.ok(slot !== undefined, "publish creates the process slot");
    const revisions: number[] = [];
    let unsubscribe = (): void => {};
    const listener = (revision: number): void => {
      revisions.push(revision);
      if (revisions.length > RESUBSCRIBE_LIMIT) return;
      unsubscribe();
      unsubscribe = slot.subscribe(listener);
    };
    unsubscribe = slot.subscribe(listener);
    const start = slot.revision;
    state.config = configWith(false);
    assert.equal(eligibility.refresh(), true);
    assert.deepEqual(revisions, [start + 1], "one call for the bumped revision");
    state.config = configWith(true);
    assert.equal(eligibility.refresh(), true);
    assert.deepEqual(revisions, [start + 1, start + 2]);
    eligibility.unpublish();
    assert.deepEqual(revisions, [start + 1, start + 2, start + 3], "withdrawal notifies once");
    unsubscribe();
  });
});
