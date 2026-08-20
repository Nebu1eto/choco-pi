import { describe, expect, it } from "vitest";
import { defaultChangeHandler } from "./settings-command";

interface TestConfig {
  feature?: string;
  nested?: { value?: string };
}

describe("defaultChangeHandler", () => {
  it("stores raw string values as-is", () => {
    const config: TestConfig = {};
    const result = defaultChangeHandler("feature", "disabled", config);
    expect(result.feature).toBe("disabled");
  });

  it("does not convert on/off to booleans", () => {
    const config: TestConfig = {};
    const resultOn = defaultChangeHandler("feature", "on", config);
    expect(resultOn.feature).toBe("on");

    const resultOff = defaultChangeHandler("feature", "off", config);
    expect(resultOff.feature).toBe("off");
  });

  it("does not convert enabled/disabled to booleans", () => {
    const config: TestConfig = {};
    const resultEnabled = defaultChangeHandler("feature", "enabled", config);
    expect(resultEnabled.feature).toBe("enabled");

    const resultDisabled = defaultChangeHandler("feature", "disabled", config);
    expect(resultDisabled.feature).toBe("disabled");
  });

  it("stores enum strings as-is", () => {
    const config: TestConfig = {};
    const result = defaultChangeHandler("feature", "pnpm", config);
    expect(result.feature).toBe("pnpm");
  });

  it("sets nested values via dotted path", () => {
    const config: TestConfig = {};
    const result = defaultChangeHandler("nested.value", "test", config);
    expect(result.nested).toEqual({ value: "test" });
  });

  it("does not mutate the original config", () => {
    const config: TestConfig = { feature: "original" };
    const result = defaultChangeHandler("feature", "changed", config);
    expect(config.feature).toBe("original");
    expect(result.feature).toBe("changed");
  });
});
