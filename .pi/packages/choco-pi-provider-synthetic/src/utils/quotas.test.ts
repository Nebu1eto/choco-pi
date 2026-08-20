import { describe, expect, it } from "vitest";
import { detectBillingMode } from "./quotas";

describe("detectBillingMode", () => {
  it.each([
    { subscription: { limit: 1, requests: 0, renewsAt: "later" } },
    {
      weeklyTokenLimit: {
        nextRegenAt: "later",
        percentRemaining: 50,
        maxCredits: "$10",
        remainingCredits: "$5",
        nextRegenCredits: "$1",
      },
    },
    {
      rollingFiveHourLimit: {
        nextTickAt: "later",
        tickPercent: 50,
        remaining: 5,
        max: 10,
        limited: false,
      },
    },
  ])("recognizes subscription quota windows", (quotas) => {
    expect(detectBillingMode(quotas)).toBe("subscription");
  });

  it("recognizes empty and missing quotas as pay-as-you-go", () => {
    expect(detectBillingMode({})).toBe("pay-as-you-go");
    expect(detectBillingMode(undefined)).toBe("pay-as-you-go");
  });

  it("rejects malformed subscription quota windows", () => {
    expect(detectBillingMode(JSON.parse('{"subscription":{}}'))).toBe("pay-as-you-go");
    expect(detectBillingMode(JSON.parse('{"weeklyTokenLimit":true}'))).toBe("pay-as-you-go");
  });
});
