import assert from "node:assert/strict";
import test from "node:test";

import {
  SnapshotRevisionStore,
  type SnapshotRevisionContext,
} from "../extensions/agent-browser/lib/snapshot-revisions.ts";
import { extractRefSnapshotFromData } from "../extensions/agent-browser/lib/session-page-state.ts";
import { formatRawSnapshotText } from "../extensions/agent-browser/lib/results/snapshot.ts";

function context(overrides: Partial<SnapshotRevisionContext> = {}): SnapshotRevisionContext {
  return {
    document: "document-1",
    namespace: "workspace",
    options: { compact: false, interactive: true },
    session: "session-1",
    tab: "tab-1",
    url: "https://example.test/page",
    ...overrides,
  };
}

function full(revision = 1) {
  return {
    origin: "https://example.test/page",
    snapshot: {
      kind: "full",
      refs: {
        e1: { name: "Save", role: "button" },
        e2: { name: "Old", role: "alert" },
      },
      revision,
      tree: '- button "Save" [ref=e1]\n- alert "Old" [ref=e2]\n- checkbox "Ready" [checked]',
    },
  };
}

test("reconstructs upstream 0.38.1 tree splice and ref operations", () => {
  const store = new SnapshotRevisionStore();
  assert.equal(store.normalize(full(), context()).kind, "normalized");

  const outcome = store.normalize(
    {
      origin: "https://example.test/page",
      snapshot: {
        baseRevision: 1,
        changes: [
          { field: "name", op: "replace", ref: "@e1", value: "Saved" },
          { op: "remove", ref: "@e2" },
          { node: { name: "Done", role: "status" }, op: "add", ref: "@e3" },
        ],
        kind: "delta",
        revision: 2,
        treeChange: {
          deleteCount: 2,
          lines: ['- button "Saved" [ref=e1]', '- status "Done" [ref=e3]'],
          startLine: 0,
        },
      },
    },
    context(),
  );

  assert.equal(outcome.kind, "normalized");
  if (outcome.kind !== "normalized") return;
  assert.equal(outcome.source, "delta");
  assert.equal(
    outcome.data.snapshot,
    '- button "Saved" [ref=e1]\n- status "Done" [ref=e3]\n- checkbox "Ready" [checked]',
  );
  assert.deepEqual(outcome.data.refs, {
    e1: { name: "Saved", role: "button" },
    e3: { name: "Done", role: "status" },
  });
  assert.match(formatRawSnapshotText(outcome.data), /Refs: 2/);
  assert.deepEqual(extractRefSnapshotFromData(outcome.data), {
    refIds: ["e1", "e3"],
    refs: {
      e1: { isEditable: false, name: "Saved", role: "button" },
      e3: { isEditable: false, name: "Done", role: "status" },
    },
    target: { title: undefined, url: "https://example.test/page" },
  });
});

test("unchanged retains the validated tree and refs", () => {
  const store = new SnapshotRevisionStore();
  store.normalize(full(4), context());
  const outcome = store.normalize(
    {
      origin: "https://example.test/page",
      snapshot: { baseRevision: 4, kind: "unchanged", revision: 5 },
    },
    context(),
  );
  assert.equal(outcome.kind, "normalized");
  if (outcome.kind !== "normalized") return;
  assert.equal(outcome.source, "unchanged");
  assert.equal(Object.keys(outcome.data.refs).length, 2);
  assert.match(outcome.data.snapshot, /checkbox "Ready" \[checked\]/);
});

test("requires refresh for changed tab, document, URL, or options", () => {
  const variants: Partial<SnapshotRevisionContext>[] = [
    { tab: "tab-2" },
    { document: "document-2" },
    { url: "https://example.test/next" },
    { options: { compact: true, interactive: true } },
  ];
  for (const variant of variants) {
    const store = new SnapshotRevisionStore();
    store.normalize(full(), context());
    const outcome = store.normalize(
      {
        origin: variant.url ?? "https://example.test/page",
        snapshot: { baseRevision: 1, kind: "unchanged", revision: 2 },
      },
      context(variant),
    );
    assert.deepEqual(outcome, { kind: "refresh-required", reason: "scope-mismatch" });
  }
});

test("isolates simultaneous namespace and session baselines", () => {
  const store = new SnapshotRevisionStore();
  const second = context({ namespace: "other", session: "session-2" });
  store.normalize(full(), context());
  store.normalize(full(), second);
  store.invalidateSession("workspace", "session-1");

  assert.deepEqual(
    store.normalize(
      {
        origin: "https://example.test/page",
        snapshot: { baseRevision: 1, kind: "unchanged", revision: 2 },
      },
      context(),
    ),
    { kind: "refresh-required", reason: "missing-baseline" },
  );
  assert.equal(
    store.normalize(
      {
        origin: "https://example.test/page",
        snapshot: { baseRevision: 1, kind: "unchanged", revision: 2 },
      },
      second,
    ).kind,
    "normalized",
  );
});

test("retains independent tab baselines in one session", () => {
  const store = new SnapshotRevisionStore();
  const otherTab = context({ document: "document-2", tab: "tab-2" });
  store.normalize(full(), context());
  store.normalize(full(), otherTab);
  assert.equal(
    store.normalize(
      {
        origin: "https://example.test/page",
        snapshot: { baseRevision: 1, kind: "unchanged", revision: 2 },
      },
      context(),
    ).kind,
    "normalized",
  );
});

test("rejects stale, malformed, and context-free deltas without stale refs", () => {
  const store = new SnapshotRevisionStore();
  store.normalize(full(), context());
  assert.deepEqual(
    store.normalize(
      {
        origin: "https://example.test/page",
        snapshot: { baseRevision: 0, kind: "unchanged", revision: 1 },
      },
      context(),
    ),
    { kind: "refresh-required", reason: "invalid-delta" },
  );
  assert.deepEqual(
    store.normalize(
      {
        origin: "https://example.test/page",
        snapshot: { baseRevision: 1, kind: "unchanged", revision: 2 },
      },
      context(),
    ),
    { kind: "refresh-required", reason: "missing-baseline" },
  );
  assert.deepEqual(
    store.normalize({
      origin: "https://example.test/page",
      snapshot: { baseRevision: 1, kind: "unchanged", revision: 2 },
    }),
    { kind: "refresh-required", reason: "missing-baseline" },
  );
  assert.equal(
    store.normalize({ origin: "https://example.test/page", snapshot: { kind: "future" } }).kind,
    "unrecognized",
  );
});

test("evicts old baselines at the configured bound", () => {
  const store = new SnapshotRevisionStore(1);
  store.normalize(full(), context());
  store.normalize(full(), context({ namespace: "other", session: "session-2" }));
  assert.deepEqual(
    store.normalize(
      {
        origin: "https://example.test/page",
        snapshot: { baseRevision: 1, kind: "unchanged", revision: 2 },
      },
      context(),
    ),
    { kind: "refresh-required", reason: "missing-baseline" },
  );
});
