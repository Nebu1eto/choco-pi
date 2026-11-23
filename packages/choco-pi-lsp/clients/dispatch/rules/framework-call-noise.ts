const EXPECT_CHAIN_PREFIX = "expect(";

const TEST_LIFECYCLE_NAMES = new Set([
  "it",
  "test",
  "describe",
  "beforeeach",
  "aftereach",
  "beforeall",
  "afterall",
]);

const TEST_LIFECYCLE_PREFIXES = ["it.", "test.", "describe."];

const MOCK_LIBRARY_PREFIXES = ["vi.", "jest."];

export function isTestFrameworkNoiseCall(call: string): boolean {
  const lower = call.toLowerCase();
  if (lower === "expect" || lower.startsWith(EXPECT_CHAIN_PREFIX)) return true;
  if (TEST_LIFECYCLE_NAMES.has(lower)) return true;
  if (TEST_LIFECYCLE_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (MOCK_LIBRARY_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return false;
}

export function isTestSuiteOrganizer(calls: readonly string[]): boolean {
  return calls.some((call) => {
    const lower = call.toLowerCase();
    const base = lower.split("(")[0].split(".")[0];
    return base === "it" || base === "test" || base === "describe";
  });
}
