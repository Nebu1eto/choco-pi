import assert from "node:assert/strict";
import test from "node:test";

import {
  getEffectiveSnapshotOptions,
  normalizeSnapshotEnvelopeForBrowserRun,
} from "../extensions/agent-browser/lib/orchestration/browser-run/process-output.ts";
import type { AgentBrowserProcessResult } from "../extensions/agent-browser/lib/orchestration/browser-run/types.ts";
import type { RuntimeValue } from "../extensions/agent-browser/lib/parsing.ts";
import { extractRefSnapshotFromData } from "../extensions/agent-browser/lib/session-page-state.ts";
import {
  SnapshotRevisionStore,
  type SnapshotRevisionContext,
} from "../extensions/agent-browser/lib/snapshot-revisions.ts";
import {
  getAgentBrowserExecutableContext,
  withAgentBrowserExecutableContext,
} from "../extensions/agent-browser/lib/process.ts";
import {
  getUnsupportedCapabilityError,
  probeAgentBrowserCompatibility,
} from "../extensions/agent-browser/lib/runtime-extension.ts";
import { runAgentBrowserScript } from "../extensions/agent-browser/lib/input-modes/script.ts";

const context: SnapshotRevisionContext = {
  document: "document-1",
  namespace: "workspace",
  options: {
    compact: true,
    cursor: true,
    depth: 2,
    interactive: true,
    selector: "main",
    urls: true,
  },
  session: "session-1",
  tab: "tab-1",
  url: "https://example.test/page",
};

function full(revision = 1) {
  return {
    origin: context.url,
    snapshot: {
      kind: "full",
      refs: { e1: { name: "Save", role: "button" } },
      revision,
      tree: '- button "Save" [ref=e1]',
    },
  };
}

function processResult(stdout = ""): AgentBrowserProcessResult {
  return {
    aborted: false,
    agentBrowserStarted: true,
    exitCode: 0,
    stderr: "",
    stdout,
    timedOut: false,
  };
}

test("production option identity normalizes aliases and equals forms", () => {
  const long = getEffectiveSnapshotOptions([
    "snapshot",
    "--interactive",
    "--compact",
    "--cursor",
    "--urls",
    "--depth=2",
    "--selector=main",
  ]);
  const short = getEffectiveSnapshotOptions([
    "snapshot",
    "-i",
    "-c",
    "-C",
    "-u",
    "-d",
    "2",
    "-s",
    "main",
  ]);
  assert.deepEqual(long, short);
  assert.deepEqual(long, context.options);
  assert.notDeepEqual(getEffectiveSnapshotOptions(["snapshot", "--depth=3"]), long);
  assert.notDeepEqual(getEffectiveSnapshotOptions(["snapshot", "--selector=aside"]), long);
});

test("production normalization publishes full, delta, and unchanged refs", async () => {
  const store = new SnapshotRevisionStore();
  const runRefresh = async () => processResult();
  const parseRefresh = async () => ({ envelope: { success: true, data: full() } });
  const normalize = (data: RuntimeValue) =>
    normalizeSnapshotEnvelopeForBrowserRun({
      context,
      envelope: { success: true, data },
      isCurrent: () => true,
      parseRefresh,
      refreshArgs: ["snapshot", "--delta", "--full"],
      runRefresh,
      store,
    });
  const initial = await normalize(full());
  assert.deepEqual(extractRefSnapshotFromData(initial.data)?.refIds, ["e1"]);
  const delta = await normalize({
    origin: context.url,
    snapshot: {
      baseRevision: 1,
      changes: [{ field: "name", op: "replace", ref: "@e1", value: "Saved" }],
      kind: "delta",
      revision: 2,
      treeChange: { deleteCount: 1, lines: ['- button "Saved" [ref=e1]'], startLine: 0 },
    },
  });
  assert.equal(extractRefSnapshotFromData(delta.data)?.refs?.e1?.name, "Saved");
  const unchanged = await normalize({
    origin: context.url,
    snapshot: { baseRevision: 2, kind: "unchanged", revision: 3 },
  });
  assert.equal(extractRefSnapshotFromData(unchanged.data)?.refs?.e1?.name, "Saved");
});

test("production normalization retains legacy snapshot refs", async () => {
  const envelope = await normalizeSnapshotEnvelopeForBrowserRun({
    context,
    envelope: {
      success: true,
      data: {
        origin: context.url,
        refs: { e1: { name: "Legacy", role: "button" } },
        snapshot: '- button "Legacy" [ref=e1]',
      },
    },
    isCurrent: () => true,
    parseRefresh: async () => ({ envelope: undefined }),
    refreshArgs: [],
    runRefresh: async () => processResult(),
    store: new SnapshotRevisionStore(),
  });
  assert.equal(extractRefSnapshotFromData(envelope.data)?.refs?.e1?.name, "Legacy");
});

test("missing baseline performs one read-only refresh and never replays mutation", async () => {
  const calls: string[][] = [];
  const envelope = await normalizeSnapshotEnvelopeForBrowserRun({
    context,
    envelope: {
      success: true,
      data: { origin: context.url, snapshot: { baseRevision: 4, kind: "unchanged", revision: 5 } },
    },
    isCurrent: () => true,
    parseRefresh: async () => ({ envelope: { success: true, data: full(5) } }),
    refreshArgs: ["--session", context.session, "snapshot", "--delta", "--full"],
    runRefresh: async (args) => {
      calls.push(args);
      return processResult();
    },
    store: new SnapshotRevisionStore(),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["--session", context.session, "snapshot", "--delta", "--full"]);
  assert.deepEqual(extractRefSnapshotFromData(envelope.data)?.refIds, ["e1"]);
});

test("owner invalidation during refresh discards parsed data and cannot repopulate cache", async () => {
  let current = true;
  const store = new SnapshotRevisionStore();
  const envelope = await normalizeSnapshotEnvelopeForBrowserRun({
    context,
    envelope: {
      success: true,
      data: { origin: context.url, snapshot: { baseRevision: 1, kind: "unchanged", revision: 2 } },
    },
    isCurrent: () => current,
    parseRefresh: async () => ({ envelope: { success: true, data: full() } }),
    refreshArgs: ["snapshot", "--delta", "--full"],
    runRefresh: async () => {
      current = false;
      return processResult();
    },
    store,
  });
  assert.equal(envelope.success, false);
  current = true;
  assert.equal(
    store.normalize(
      { origin: context.url, snapshot: { baseRevision: 1, kind: "unchanged", revision: 2 } },
      context,
    ).kind,
    "refresh-required",
  );
});

test("owner invalidation during refresh parsing discards data before cache publication", async () => {
  let current = true;
  const store = new SnapshotRevisionStore();
  const envelope = await normalizeSnapshotEnvelopeForBrowserRun({
    context,
    envelope: {
      success: true,
      data: { origin: context.url, snapshot: { baseRevision: 1, kind: "unchanged", revision: 2 } },
    },
    isCurrent: () => current,
    parseRefresh: async () => {
      current = false;
      return { envelope: { success: true, data: full() } };
    },
    refreshArgs: ["snapshot", "--delta", "--full"],
    runRefresh: async () => processResult(),
    store,
  });
  assert.equal(envelope.success, false);
  current = true;
  assert.equal(
    store.normalize(
      { origin: context.url, snapshot: { baseRevision: 1, kind: "unchanged", revision: 2 } },
      context,
    ).kind,
    "refresh-required",
  );
});

test("unrecognized snapshot contracts cannot become zero-ref successes", async () => {
  const envelope = await normalizeSnapshotEnvelopeForBrowserRun({
    context,
    envelope: { success: true, data: { origin: context.url, snapshot: { kind: "future" } } },
    isCurrent: () => true,
    parseRefresh: async () => ({ envelope: undefined }),
    refreshArgs: [],
    runRefresh: async () => processResult(),
    store: new SnapshotRevisionStore(),
  });
  assert.equal(envelope.success, false);
  assert.match(String(envelope.error ?? ""), /did not match/u);
});

test("runtime compatibility gate warns for future versions and preserves pinned executable", async () => {
  const fingerprint = {
    executablePath: "/first/agent-browser",
    modifiedAtMs: 1,
    platform: "darwin" as const,
    realPath: "/resolved/agent-browser",
    size: 42,
  };
  const originalPath = process.env.PATH;
  try {
    const profile = await withAgentBrowserExecutableContext(fingerprint, async () => {
      const observed = await probeAgentBrowserCompatibility({
        fingerprint,
        runVersion: async () => processResult("agent-browser 1.0.0"),
      });
      process.env.PATH = "/changed-after-probe";
      assert.equal(getAgentBrowserExecutableContext()?.realPath, fingerprint.realPath);
      return observed;
    });
    assert.ok(profile);
    assert.equal(getUnsupportedCapabilityError(profile, ["snapshot"]), undefined);
    assert.equal(profile.warnings[0]?.code, "newer-than-tested");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("script sandbox starts under Node permissions and dispatches before completion", async () => {
  const run = await runAgentBrowserScript({
    code: 'const result = await browser({ args: ["get", "title"] }); emit(result.summary);',
    dispatch: async () => ({
      data: { title: "Fixture" },
      ok: true,
      resultCategory: "success",
      successCategory: "inspection",
      summary: "Fixture",
      text: "Fixture",
    }),
    timeoutMs: 5_000,
  });
  assert.equal(run.ok, true);
  assert.equal(run.callCount, 1);
  assert.equal(run.data, "Fixture");
});
