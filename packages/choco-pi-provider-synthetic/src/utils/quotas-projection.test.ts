import { describe, expect, it } from "vitest";
import type { QuotasResponse } from "../types/quotas";
import {
  buildProjectionHints,
  type ProjectionSnapshot,
  ROLLING_FIVE_HOUR_ID,
  WEEKLY_TOKEN_LIMIT_ID,
} from "./quotas-projection";

const MAX = 2250;
const TICK_PERCENT = 0.05;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function quotas(remaining: number): QuotasResponse {
  return {
    rollingFiveHourLimit: {
      nextTickAt: new Date(Date.now() + 10 * MINUTE).toISOString(),
      tickPercent: TICK_PERCENT,
      remaining,
      max: MAX,
      limited: false,
    },
  };
}

function snap(remaining: number, atMs: number): ProjectionSnapshot {
  return { quotas: quotas(remaining), updatedAt: atMs };
}

function weeklySnap(remaining: number, atMs: number, capacity = 15.12): ProjectionSnapshot {
  return {
    quotas: {
      weeklyTokenLimit: {
        nextRegenAt: new Date(atMs + DAY).toISOString(),
        percentRemaining: (remaining / capacity) * 100,
        maxCredits: `$${capacity.toFixed(2)}`,
        remainingCredits: `$${remaining.toFixed(4)}`,
        nextRegenCredits: "$2.16",
      },
    },
    updatedAt: atMs,
  };
}

describe("buildProjectionHints", () => {
  it("returns no hints for empty snapshots", () => {
    expect(buildProjectionHints([]).size).toBe(0);
  });

  it("returns no hints for a single snapshot (needs >= 2)", () => {
    expect(buildProjectionHints([snap(2000, 0)]).size).toBe(0);
  });

  it("returns no hint when samples are < 5 min apart", () => {
    const snapshots = [snap(2000, 0), snap(2000, 4 * MINUTE)];
    expect(buildProjectionHints(snapshots).size).toBe(0);
  });

  it("returns no hint when rollingFiveHourLimit is absent", () => {
    const snapshots: ProjectionSnapshot[] = [
      { quotas: {}, updatedAt: 0 },
      { quotas: {}, updatedAt: 10 * MINUTE },
    ];
    expect(buildProjectionHints(snapshots).size).toBe(0);
  });

  it("skips snapshots whose tickPercent is not a fraction (> 1)", () => {
    const bad: QuotasResponse = {
      rollingFiveHourLimit: {
        nextTickAt: new Date().toISOString(),
        tickPercent: 10,
        remaining: 2000,
        max: MAX,
        limited: false,
      },
    };
    const snapshots: ProjectionSnapshot[] = [
      { quotas: bad, updatedAt: 0 },
      { quotas: bad, updatedAt: 10 * MINUTE },
    ];
    expect(buildProjectionHints(snapshots).size).toBe(0);
  });

  it("reports stable when remaining is flat (refill covers usage)", () => {
    const snapshots = [snap(2000, 0), snap(2000, 10 * MINUTE)];
    const hints = buildProjectionHints(snapshots);
    expect(hints.get(ROLLING_FIVE_HOUR_ID)).toEqual({ kind: "stable" });
  });

  it("reports stable when remaining grew (recovering)", () => {
    const snapshots = [snap(2000, 0), snap(2200, 20 * MINUTE)];
    const hints = buildProjectionHints(snapshots);
    expect(hints.get(ROLLING_FIVE_HOUR_ID)).toEqual({ kind: "stable" });
  });

  it("projects rising usage when burning faster than refill", () => {
    const snapshots = [snap(405, 0), snap(300, 20 * MINUTE)];
    const hint = buildProjectionHints(snapshots).get(ROLLING_FIVE_HOUR_ID);
    expect(hint?.kind).toBe("projected");
    if (hint?.kind === "projected") {
      expect(hint.usedPercent).toBe(100);
      expect(hint.horizonMs).toBe(FIVE_HOUR_MS / 5);
    }
  });

  it("projects a partial rise (warning band) for a slow drain", () => {
    const snapshots = [snap(2000, 0), snap(1900, 20 * MINUTE)];
    const hint = buildProjectionHints(snapshots).get(ROLLING_FIVE_HOUR_ID);
    expect(hint?.kind).toBe("projected");
    if (hint?.kind === "projected") {
      expect(hint.usedPercent).toBe(29);
    }
  });

  it("uses the most recent sample >= 5 min older as the baseline", () => {
    const now = 30 * MINUTE;
    const snapshots = [
      snap(2000, now - 15 * MINUTE),
      snap(1900, now - 3 * MINUTE),
      snap(1800, now),
    ];
    const hint = buildProjectionHints(snapshots).get(ROLLING_FIVE_HOUR_ID);
    expect(hint?.kind).toBe("projected");
    if (hint?.kind === "projected") {
      expect(hint.usedPercent).toBeGreaterThan(50);
      expect(hint.usedPercent).toBeLessThan(60);
    }
  });

  it("ignores out-of-order snapshots (sorts by timestamp)", () => {
    const current = snap(300, 20 * MINUTE);
    const previous = snap(405, 0);
    const a = buildProjectionHints([previous, current]);
    const b = buildProjectionHints([current, previous]);
    expect(a.get(ROLLING_FIVE_HOUR_ID)).toEqual(b.get(ROLLING_FIVE_HOUR_ID));
  });

  it("returns no hint when the only older sample exceeds max history age", () => {
    const snapshots = [snap(2000, 0), snap(2000, 73 * 60 * MINUTE + 1)];
    expect(buildProjectionHints(snapshots).size).toBe(0);
  });

  describe("weekly credits", () => {
    it("requires at least one day of history", () => {
      const hints = buildProjectionHints([
        weeklySnap(4.536, 0),
        weeklySnap(2.8728, 6 * 60 * MINUTE),
      ]);
      expect(hints.has(WEEKLY_TOKEN_LIMIT_ID)).toBe(false);
    });

    it("reports stable when daily regen covers daily usage", () => {
      const hints = buildProjectionHints([weeklySnap(2.8728, 0), weeklySnap(2.8728, DAY)]);
      expect(hints.get(WEEKLY_TOKEN_LIMIT_ID)).toEqual({ kind: "stable" });
    });

    it("projects one day ahead from the net daily drain", () => {
      const hints = buildProjectionHints([weeklySnap(4.536, 0), weeklySnap(2.8728, DAY)]);
      const hint = hints.get(WEEKLY_TOKEN_LIMIT_ID);
      expect(hint).toMatchObject({
        kind: "projected",
        usedPercent: 92,
        horizonMs: DAY,
      });
      if (hint?.kind === "projected") {
        expect(hint.timeToEmptyMs).toBeGreaterThan(DAY);
      }
    });

    it("skips a sparse interval whose refill may have hit capacity", () => {
      const hints = buildProjectionHints([weeklySnap(6, 0), weeklySnap(3, 7 * DAY)]);
      expect(hints.has(WEEKLY_TOKEN_LIMIT_ID)).toBe(false);
    });

    it("uses a daily median so one noisy reading does not dominate", () => {
      const hour = 60 * MINUTE;
      const hints = buildProjectionHints([
        weeklySnap(6, 0),
        weeklySnap(6, hour),
        weeklySnap(0, DAY),
        weeklySnap(4.5, DAY + hour),
        weeklySnap(4.5, DAY + 2 * hour),
      ]);
      expect(hints.get(WEEKLY_TOKEN_LIMIT_ID)).toMatchObject({
        kind: "projected",
        usedPercent: 80,
        horizonMs: DAY,
      });
    });

    it("does not extrapolate a sample less than one day old", () => {
      const currentAt = 2 * DAY;
      const hints = buildProjectionHints([
        weeklySnap(4.5, currentAt - DAY),
        weeklySnap(15, currentAt - 23 * 60 * MINUTE),
        weeklySnap(3, currentAt),
      ]);
      expect(hints.get(WEEKLY_TOKEN_LIMIT_ID)).toMatchObject({
        kind: "projected",
        usedPercent: 90,
        horizonMs: DAY,
      });
    });

    it("uses older-capacity burn with the current capacity refill rate", () => {
      const oldCapacity = 10;
      const oldRemainingAfterOneDay = 8 + oldCapacity / 7 - 4;
      const hints = buildProjectionHints([
        weeklySnap(8, 0, oldCapacity),
        weeklySnap(oldRemainingAfterOneDay, DAY, oldCapacity),
        weeklySnap(3, DAY + DAY / 2),
      ]);
      expect(hints.get(WEEKLY_TOKEN_LIMIT_ID)).toMatchObject({
        kind: "projected",
        usedPercent: 92,
        horizonMs: DAY,
      });
    });

    it("does not treat a capacity transition as credit burn", () => {
      const currentAt = 2 * DAY;
      const hints = buildProjectionHints([weeklySnap(6, 0, 10), weeklySnap(3, currentAt)]);
      expect(hints.has(WEEKLY_TOKEN_LIMIT_ID)).toBe(false);
    });

    it("does not infer burn from refill hidden by a full quota", () => {
      const hints = buildProjectionHints([
        weeklySnap(100, 0, 100),
        weeklySnap(100, DAY, 100),
        weeklySnap(10, DAY + DAY / 2, 50),
      ]);
      expect(hints.has(WEEKLY_TOKEN_LIMIT_ID)).toBe(false);
    });

    it("rejects weekly samples older than the retained 14-day window", () => {
      const hints = buildProjectionHints([weeklySnap(6, 0), weeklySnap(3, 14 * DAY + 1)]);
      expect(hints.has(WEEKLY_TOKEN_LIMIT_ID)).toBe(false);
    });
  });
});
