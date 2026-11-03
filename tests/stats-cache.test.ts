import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createStatsCache,
  loadStatsSnapshot,
  peekStatsSnapshot,
  STATS_CACHE_TTL_MS,
  type StatsDataOptions,
} from "../.pi/extensions/lib/stats/report.ts";
import { scanSessions } from "../.pi/extensions/lib/stats/scan.ts";

/** One session file holding one billed call from a minute ago. */
async function writeSession(root: string, id: string): Promise<void> {
  const project = path.join(root, "--work-app--");
  await mkdir(project, { recursive: true });
  const at = Date.now() - 60_000;
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date(at).toISOString(), cwd: process.cwd() },
    {
      type: "message",
      id: `a-${id}`,
      parentId: null,
      timestamp: new Date(at + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-5-5",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 40,
          totalTokens: 100,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
        },
        stopReason: "stop",
        timestamp: at,
        durationMs: 1000,
      },
    },
  ];
  await writeFile(
    path.join(project, `2026-10-27T10-00-00-000Z_${id}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}

test("one scan serves every period and scope until its TTL ends, then the logs are read again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-stats-cache-"));
  try {
    await writeSession(root, "s1");
    let clock = 1_000;
    let scans = 0;
    const cache = createStatsCache({
      clock: () => clock,
      scan: (roots) => {
        scans += 1;
        return scanSessions(roots, new Map());
      },
    });
    const view = (period: StatsDataOptions["period"], scope: StatsDataOptions["scope"]) => ({
      cwd: process.cwd(),
      projectDirs: [process.cwd()],
      roots: [root],
      cache,
      period,
      scope,
    });
    assert.equal(peekStatsSnapshot(view("30d", "all")), undefined, "nothing before the first load");
    const [first, again] = await Promise.all([
      loadStatsSnapshot(view("30d", "all")),
      loadStatsSnapshot(view("30d", "all")),
    ]);
    assert.equal(scans, 1, "concurrent loads share one scan");
    assert.equal(first, again, "and one computation");
    assert.equal(first.scan.sessions, 1);
    assert.equal(peekStatsSnapshot(view("30d", "all")), first, "a computed view is ready at once");

    await writeSession(root, "s2");
    clock += STATS_CACHE_TTL_MS - 1;
    const week = await loadStatsSnapshot(view("24h", "project"));
    assert.equal(scans, 1, "another period and scope reuse the scan inside the TTL");
    assert.equal(week.scan.sessions, 1, "so the new file is not read yet");
    assert.equal(week.report.calls, 1);
    assert.equal(week.now, first.now, "every view of one scan ends its period at the scan");
    assert.equal(await loadStatsSnapshot(view("30d", "all")), first, "a computed view is reused");

    clock += 1;
    assert.equal(peekStatsSnapshot(view("30d", "all")), undefined, "the TTL has ended");
    const fresh = await loadStatsSnapshot(view("30d", "all"));
    assert.equal(scans, 2, "the logs are read again");
    assert.equal(fresh.scan.sessions, 2);
    assert.equal(
      peekStatsSnapshot(view("24h", "project")),
      undefined,
      "older views expire with their scan",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed scan is not cached", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-stats-cache-"));
  try {
    await writeSession(root, "s1");
    let scans = 0;
    const cache = createStatsCache({
      scan: (roots) => {
        scans += 1;
        return scans === 1 ? Promise.reject(new Error("disk")) : scanSessions(roots, new Map());
      },
    });
    const options = {
      cwd: process.cwd(),
      roots: [root],
      cache,
      period: "7d",
      scope: "all",
    } as const;
    await assert.rejects(loadStatsSnapshot(options), /disk/);
    const snapshot = await loadStatsSnapshot(options);
    assert.equal(scans, 2, "the next load scans again");
    assert.equal(snapshot.report.calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
