import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { arr, compile, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

const runnerPath = fileURLToPath(new URL("./fixtures/transient-search-runner.ts", import.meta.url));

const TransportSchema = oneOf(["exa-api", "exa-mcp", "kagi-api", "openai-responses"]);
const ScenarioOutputSchema = obj({
  error: opt(
    obj({
      // Any kind parses so an unexpected one fails only its own test, by exact comparison.
      kind: str({ minLength: 1 }),
      status: opt(int({ minimum: 100, maximum: 599 })),
    }),
  ),
  fallbackCalls: int({ minimum: 0 }),
  fetchCalls: int({ minimum: 0 }),
  response: opt(
    obj({
      adapterId: str({ minLength: 1 }),
      attempts: arr(
        obj({
          adapterId: str({ minLength: 1 }),
          errorKind: opt(oneOf(["transient"])),
          outcome: oneOf(["error", "success"]),
          transport: str({ minLength: 1 }),
        }),
      ),
    }),
  ),
});
const isScenarioOutputList = compile(arr(ScenarioOutputSchema)).check;

type TransportCase = Static<typeof TransportSchema>;
type FailureMode = "cancel" | number;
type ScenarioOutput = Static<typeof ScenarioOutputSchema>;

const transientCases: ReadonlyArray<{ status: 500 | 503; transport: TransportCase }> = [
  { transport: "openai-responses", status: 503 },
  { transport: "exa-api", status: 500 },
  { transport: "exa-mcp", status: 503 },
  { transport: "kagi-api", status: 500 },
];

const hardStopCases = [
  { transport: "openai-responses", status: 401, kind: "auth" },
  { transport: "exa-api", status: 400, kind: "invalid-request" },
  { transport: "exa-mcp", status: 400, kind: "invalid-request" },
  { transport: "kagi-api", status: 403, kind: "auth" },
] as const;

const cancelTransports = ["openai-responses", "exa-api", "exa-mcp", "kagi-api"] as const;

// One runner child per transport runs all of that transport's scenarios: each child
// imports the SDK once, and its env carries only that transport's key.
const failuresByTransport = new Map<TransportCase, FailureMode[]>();
function addFailure(transport: TransportCase, failure: FailureMode): void {
  const failures = failuresByTransport.get(transport) ?? [];
  failures.push(failure);
  failuresByTransport.set(transport, failures);
}
for (const { transport, status } of transientCases) addFailure(transport, status);
for (const { transport, status } of hardStopCases) addFailure(transport, status);
for (const transport of cancelTransports) addFailure(transport, "cancel");

const transportRuns = new Map<TransportCase, Promise<ScenarioOutput[]>>();

async function runScenario(
  transport: TransportCase,
  failure: FailureMode,
): Promise<ScenarioOutput> {
  const failures = failuresByTransport.get(transport) ?? [];
  const index = failures.indexOf(failure);
  assert.notEqual(index, -1, `no scenario for ${transport} ${failure}`);
  let run = transportRuns.get(transport);
  if (!run) {
    run = runTransport(transport, failures);
    transportRuns.set(transport, run);
  }
  const outputs = await run;
  const output = outputs[index];
  assert.ok(output, `the runner returned no result for ${transport} ${failure}`);
  return output;
}

async function runTransport(
  transport: TransportCase,
  failures: readonly FailureMode[],
): Promise<ScenarioOutput[]> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-transient-search-"));
  const scenarios = failures.map((failure) => ({ transport, failure }));
  const child = spawn(process.execPath, [runnerPath, JSON.stringify(scenarios)], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PI_CODING_AGENT_DIR: root,
      EXA_API_KEY: transport === "exa-api" ? "fixture-exa-key" : "",
      KAGI_API_KEY: transport === "kagi-api" ? "fixture-kagi-key" : "",
      OPENAI_API_KEY: transport === "openai-responses" ? "fixture-openai-key" : "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(status, 0, stderr);
    let output: unknown;
    try {
      output = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`transient search runner returned invalid JSON: ${stdout}`);
    }
    if (!isScenarioOutputList(output) || output.length !== failures.length) {
      throw new Error(`transient search runner returned an invalid result: ${stdout}`);
    }
    return output;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const { transport, status } of transientCases) {
  test(`${transport} HTTP ${status} is transient and reaches router fallback`, async () => {
    const output = await runScenario(transport, status);
    assert.equal(output.error, undefined);
    assert.equal(output.fetchCalls, 1);
    assert.equal(output.fallbackCalls, 1);
    assert.equal(output.response?.adapterId, "fixture.fallback");
    const attempts = output.response?.attempts;
    assert.equal(attempts?.length, 2);
    assert.equal(
      attempts?.[0]?.adapterId,
      transport === "openai-responses"
        ? "web-access.openai"
        : transport.startsWith("exa")
          ? "web-access.exa"
          : "web-access.kagi",
    );
    assert.equal(
      attempts?.[0]?.transport,
      transport === "openai-responses" ? "responses-api" : transport,
    );
    assert.equal(attempts?.[0]?.outcome, "error");
    assert.equal(attempts?.[0]?.errorKind, "transient");
    assert.equal(attempts?.[1]?.adapterId, "fixture.fallback");
    assert.equal(attempts?.[1]?.transport, "fixture-fallback");
    assert.equal(attempts?.[1]?.outcome, "success");
  });
}

for (const { transport, status, kind } of hardStopCases) {
  test(`${transport} HTTP ${status} remains a hard stop`, async () => {
    const output = await runScenario(transport, status);
    assert.deepEqual(output.error, { kind, status });
    assert.equal(output.fetchCalls, 1);
    assert.equal(output.fallbackCalls, 0);
    assert.equal(output.response, undefined);
  });
}

for (const transport of cancelTransports) {
  test(`${transport} cancellation stops without fallback`, async () => {
    const output = await runScenario(transport, "cancel");
    assert.deepEqual(output.error, { kind: "cancelled" });
    assert.equal(output.fetchCalls, 0);
    assert.equal(output.fallbackCalls, 0);
    assert.equal(output.response, undefined);
  });
}
