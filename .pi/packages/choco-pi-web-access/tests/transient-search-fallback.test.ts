import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const runnerPath = fileURLToPath(new URL("./fixtures/transient-search-runner.ts", import.meta.url));

const TransportSchema = Type.Union([
  Type.Literal("exa-api"),
  Type.Literal("exa-mcp"),
  Type.Literal("kagi-api"),
  Type.Literal("openai-responses"),
]);
const ScenarioOutputSchema = Type.Object(
  {
    error: Type.Optional(
      Type.Object(
        {
          kind: Type.String({
            enum: ["auth", "cancelled", "invalid-request"],
          }),
          status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
        },
        { additionalProperties: false },
      ),
    ),
    fallbackCalls: Type.Integer({ minimum: 0 }),
    fetchCalls: Type.Integer({ minimum: 0 }),
    response: Type.Optional(
      Type.Object(
        {
          adapterId: Type.String({ minLength: 1 }),
          attempts: Type.Array(
            Type.Object(
              {
                adapterId: Type.String({ minLength: 1 }),
                errorKind: Type.Optional(Type.String({ enum: ["transient"] })),
                outcome: Type.String({ enum: ["error", "success"] }),
                transport: Type.String({ minLength: 1 }),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type TransportCase = Static<typeof TransportSchema>;
type FailureMode = "cancel" | number;
type ScenarioOutput = Static<typeof ScenarioOutputSchema>;

async function runScenario(
  transport: TransportCase,
  failure: FailureMode,
): Promise<ScenarioOutput> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-transient-search-"));
  const child = spawn(process.execPath, [runnerPath, JSON.stringify({ transport, failure })], {
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
    if (!Check(ScenarioOutputSchema, output)) {
      throw new Error(`transient search runner returned an invalid result: ${stdout}`);
    }
    return output;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const transientCases: ReadonlyArray<{ status: 500 | 503; transport: TransportCase }> = [
  { transport: "openai-responses", status: 503 },
  { transport: "exa-api", status: 500 },
  { transport: "exa-mcp", status: 503 },
  { transport: "kagi-api", status: 500 },
];

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

for (const { transport, status, kind } of [
  { transport: "openai-responses", status: 401, kind: "auth" },
  { transport: "exa-api", status: 400, kind: "invalid-request" },
  { transport: "exa-mcp", status: 400, kind: "invalid-request" },
  { transport: "kagi-api", status: 403, kind: "auth" },
] as const) {
  test(`${transport} HTTP ${status} remains a hard stop`, async () => {
    const output = await runScenario(transport, status);
    assert.deepEqual(output.error, { kind, status });
    assert.equal(output.fetchCalls, 1);
    assert.equal(output.fallbackCalls, 0);
    assert.equal(output.response, undefined);
  });
}

for (const transport of ["openai-responses", "exa-api", "exa-mcp", "kagi-api"] as const) {
  test(`${transport} cancellation stops without fallback`, async () => {
    const output = await runScenario(transport, "cancel");
    assert.deepEqual(output.error, { kind: "cancelled" });
    assert.equal(output.fetchCalls, 0);
    assert.equal(output.fallbackCalls, 0);
    assert.equal(output.response, undefined);
  });
}
