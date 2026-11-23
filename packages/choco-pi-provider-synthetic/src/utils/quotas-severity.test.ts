import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectionHint } from "../types/quotas";
import {
  assessWindow,
  getPacePercent,
  getProjectedPercent,
  getSeverityColor,
  parseCurrency,
  type QuotaWindow,
  safePercent,
  toWindows,
} from "./quotas-severity";

function makeWindow(
  overrides: Partial<QuotaWindow> & Pick<QuotaWindow, "usedPercent">,
): QuotaWindow {
  const windowSeconds = overrides.windowSeconds ?? 3600;
  const resetsAt = overrides.resetsAt ?? new Date(Date.now() + windowSeconds * 500);
  return {
    id: "test",
    label: "Test Window",
    resetsAt,
    windowSeconds,
    usedValue: 0,
    limitValue: 100,
    ...overrides,
  };
}

describe("safePercent", () => {
  it("returns 0 for zero/invalid limit", () => {
    expect(safePercent(50, 0)).toBe(0);
    expect(safePercent(50, -1)).toBe(0);
    expect(safePercent(50, NaN)).toBe(0);
    expect(safePercent(NaN, 100)).toBe(0);
  });

  it("computes correct percentage", () => {
    expect(safePercent(50, 100)).toBe(50);
    expect(safePercent(75, 100)).toBe(75);
    expect(safePercent(1, 3)).toBeCloseTo(33.33);
  });

  it("clamps to 0-100", () => {
    expect(safePercent(150, 100)).toBe(100);
    expect(safePercent(-10, 100)).toBe(0);
  });
});

describe("parseCurrency", () => {
  it("parses dollar amounts", () => {
    expect(parseCurrency("$1,234.56")).toBe(1234.56);
    expect(parseCurrency("$10.00")).toBe(10);
  });

  it("returns 0 for invalid input", () => {
    expect(parseCurrency("")).toBe(0);
    expect(parseCurrency("abc")).toBe(0);
  });
});

describe("getPacePercent", () => {
  it("returns null for zero window", () => {
    const w = makeWindow({ usedPercent: 50, windowSeconds: 0 });
    expect(getPacePercent(w)).toBeNull();
  });

  it("returns ~50 for a window 50% elapsed", () => {
    const w = makeWindow({
      usedPercent: 50,
      windowSeconds: 3600,
      resetsAt: new Date(Date.now() + 1800 * 1000),
    });
    const pace = getPacePercent(w);
    assert(pace, "pace should not be null");
    expect(pace).toBeCloseTo(50, 0);
  });

  it("clamps to 0-100", () => {
    const w = makeWindow({
      usedPercent: 50,
      windowSeconds: 3600,
      resetsAt: new Date(Date.now() + 7200 * 1000),
    });
    expect(getPacePercent(w)).toBe(0);
  });
});

describe("getProjectedPercent", () => {
  it("returns usedPercent when no pace", () => {
    expect(getProjectedPercent(42, null)).toBe(42);
  });

  it("projects based on pace", () => {
    expect(getProjectedPercent(50, 25)).toBe(200);
  });

  it("uses minimum pace of 5", () => {
    expect(getProjectedPercent(1, 0)).toBe(20);
    expect(getProjectedPercent(1, 1)).toBe(20);
  });
});

describe("assessWindow", () => {
  describe("no pace (showPace: false)", () => {
    it("returns none for low usage", () => {
      const w = makeWindow({ usedPercent: 10, showPace: false });
      expect(assessWindow(w).severity).toBe("none");
    });

    it("returns warning at 80% projected", () => {
      const w = makeWindow({ usedPercent: 85, showPace: false });
      expect(assessWindow(w).severity).toBe("warning");
    });

    it("returns high at 90% projected", () => {
      const w = makeWindow({ usedPercent: 92, showPace: false });
      expect(assessWindow(w).severity).toBe("high");
    });

    it("returns critical at 100% projected", () => {
      const w = makeWindow({ usedPercent: 100, showPace: false });
      expect(assessWindow(w).severity).toBe("critical");
    });

    it("returns critical for limited window regardless of usage", () => {
      const w = makeWindow({ usedPercent: 5, showPace: false, limited: true });
      expect(assessWindow(w).severity).toBe("critical");
    });
  });

  describe("with pace (showPace: true)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns none when usage is low and pace is normal", () => {
      const w = makeWindow({
        usedPercent: 20,
        showPace: true,
        paceScale: 1,
        windowSeconds: 3600,
        resetsAt: new Date(Date.now() + 1800 * 1000),
      });
      expect(assessWindow(w).severity).toBe("none");
    });

    it("returns warning when projected exceeds warn threshold", () => {
      const w = makeWindow({
        usedPercent: 50,
        showPace: true,
        paceScale: 1,
        windowSeconds: 3600,
        resetsAt: new Date(Date.now() + 1800 * 1000),
      });
      const result = assessWindow(w);
      expect(result.severity).toBe("none");
    });

    it("returns warning when projected exceeds dynamic warn threshold", () => {
      const w = makeWindow({
        usedPercent: 95,
        showPace: true,
        paceScale: 1,
        windowSeconds: 3600,
        resetsAt: new Date(Date.now() + 1800 * 1000),
      });
      const result = assessWindow(w);
      expect(result.severity).toBe("warning");
    });

    it("uses paceScale when a fixed window opts into pace", () => {
      const w = makeWindow({
        usedPercent: 95,
        showPace: true,
        paceScale: 1 / 7,
        windowSeconds: 7 * 24 * 3600,
        resetsAt: new Date(Date.now() + 6 * 24 * 3600 * 1000),
      });
      const result = assessWindow(w);
      assert(result.pacePercent, "pacePercent should not be null");
      expect(result.pacePercent).toBeLessThan(15);
      expect(result.projectedPercent).toBeGreaterThan(500);
      expect(result.severity).toBe("critical");
    });

    it("does not treat the next weekly regen as weekly elapsed time", () => {
      const windows = toWindows({
        weeklyTokenLimit: {
          nextRegenAt: new Date(Date.now() + (2 * 60 + 36) * 60 * 1000).toISOString(),
          percentRemaining: 19,
          maxCredits: "$15.12",
          remainingCredits: "$2.87",
          nextRegenCredits: "$2.16",
        },
      });
      const weekly = windows.find((window) => window.id === "weeklyTokenLimit");
      assert(weekly, "weekly window should exist");

      const result = assessWindow(weekly);
      expect(result.pacePercent).toBeNull();
      expect(result.projectedPercent).toBe(81);
      expect(result.severity).toBe("warning");
    });

    it("does not use pace when showPace is false", () => {
      const w = makeWindow({
        usedPercent: 50,
        showPace: false,
        windowSeconds: 5 * 3600,
        resetsAt: new Date(Date.now() + 2.5 * 3600 * 1000),
      });
      const result = assessWindow(w);
      expect(result.pacePercent).toBeNull();
      expect(result.progress).toBeNull();
      expect(result.severity).toBe("none");
    });

    it("suppresses warning when usage is below usedFloor", () => {
      const w = makeWindow({
        usedPercent: 15,
        showPace: true,
        paceScale: 1,
        windowSeconds: 3600,
        resetsAt: new Date(Date.now() + 54 * 60 * 1000),
      });
      const result = assessWindow(w);
      expect(result.severity).toBe("none");
    });

    it("allows warning when usage exceeds usedFloor", () => {
      const w = makeWindow({
        usedPercent: 50,
        showPace: true,
        paceScale: 1,
        windowSeconds: 3600,
        resetsAt: new Date(Date.now() + 54 * 60 * 1000),
      });
      const result = assessWindow(w);
      expect(result.severity).toBe("critical");
    });
  });

  describe("limited flag", () => {
    it("overrides severity to critical even with low usage", () => {
      const w = makeWindow({
        usedPercent: 5,
        showPace: false,
        limited: true,
      });
      expect(assessWindow(w).severity).toBe("critical");
    });

    it("overrides severity to critical even with pace showing none", () => {
      const w = makeWindow({
        usedPercent: 5,
        showPace: true,
        paceScale: 1,
        limited: true,
        windowSeconds: 3600,
        resetsAt: new Date(Date.now() + 54 * 60 * 1000),
      });
      expect(assessWindow(w).severity).toBe("critical");
    });
  });

  describe("refill-aware projection (no pace)", () => {
    const stable: ProjectionHint = { kind: "stable" };
    const projected = (usedPercent: number): ProjectionHint => ({
      kind: "projected",
      usedPercent,
      horizonMs: 60 * 60 * 1000,
    });

    it("suppresses warning when projection is stable (refill covers burn)", () => {
      const w = makeWindow({
        id: "rollingFiveHourLimit",
        usedPercent: 92,
        showPace: false,
      });
      expect(assessWindow(w, stable).severity).toBe("none");
    });

    it("uses projected usedPercent for the threshold decision", () => {
      const w = makeWindow({
        id: "rollingFiveHourLimit",
        usedPercent: 82,
        showPace: false,
      });
      const result = assessWindow(w, projected(86));
      expect(result.severity).toBe("warning");
      expect(result.projectedPercent).toBe(86);
      expect(result.projectionHorizonMs).toBe(60 * 60 * 1000);
    });

    it("maps projected >= 90 to high", () => {
      const w = makeWindow({
        id: "rollingFiveHourLimit",
        usedPercent: 82,
        showPace: false,
      });
      expect(assessWindow(w, projected(93)).severity).toBe("high");
    });

    it("maps projected >= 100 to critical", () => {
      const w = makeWindow({
        id: "rollingFiveHourLimit",
        usedPercent: 82,
        showPace: false,
      });
      expect(assessWindow(w, projected(100)).severity).toBe("critical");
    });

    it("does not warn when projected is below the warning threshold", () => {
      const w = makeWindow({
        id: "rollingFiveHourLimit",
        usedPercent: 82,
        showPace: false,
      });
      expect(assessWindow(w, projected(79)).severity).toBe("none");
    });

    it("ignores a projection for an unrelated window id", () => {
      const w = makeWindow({
        id: "rollingFiveHourLimit",
        usedPercent: 50,
        showPace: false,
      });
      expect(assessWindow(w, projected(50)).severity).toBe("none");
    });

    it("still falls back to raw thresholds when no projection is given", () => {
      const w = makeWindow({
        id: "rollingFiveHourLimit",
        usedPercent: 92,
        showPace: false,
      });
      expect(assessWindow(w).severity).toBe("high");
    });

    it("limited overrides even a stable projection", () => {
      const w = makeWindow({
        id: "rollingFiveHourLimit",
        usedPercent: 5,
        showPace: false,
        limited: true,
      });
      expect(assessWindow(w, stable).severity).toBe("critical");
    });
  });
});

describe("getSeverityColor", () => {
  it("maps severity levels to display colors", () => {
    expect(getSeverityColor("none")).toBe("success");
    expect(getSeverityColor("warning")).toBe("warning");
    expect(getSeverityColor("high")).toBe("error");
    expect(getSeverityColor("critical")).toBe("error");
  });
});
