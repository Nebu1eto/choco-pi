import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { arr, compile, int, lit, obj, oneOf, union } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { registerWebAccessSearchAdapters } from "../../search-adapters.ts";
import {
  bindSearchSession,
  getSearchScope,
  registerSearchAdapter,
  search,
  SearchError,
  type SearchProviderFamily,
} from "../../../choco-pi-web-search/index.ts";

const TransportSchema = oneOf(["exa-api", "exa-mcp", "kagi-api", "openai-responses"]);
const ScenarioSchema = obj({
  transport: TransportSchema,
  failure: union([lit("cancel"), int({ minimum: 100, maximum: 599 })]),
});
// One child runs every scenario of one transport, so that transport's key env stays per child.
const isScenarioList = compile(arr(ScenarioSchema, { minItems: 1 })).check;

type Scenario = Static<typeof ScenarioSchema>;
type TransportCase = Static<typeof TransportSchema>;

interface AttemptOutput {
  adapterId: string;
  errorKind?: string;
  outcome: string;
  transport: string;
}

interface FailureOutput {
  kind: string;
  status?: number;
}

interface ScenarioResult {
  error?: FailureOutput;
  fallbackCalls: number;
  fetchCalls: number;
  response?: { adapterId: string; attempts: AttemptOutput[] };
}

const expectedUrlParts = {
  "openai-responses": "api.openai.com/v1/responses",
  "exa-api": "api.exa.ai/answer",
  "exa-mcp": "mcp.exa.ai/mcp",
  "kagi-api": "kagi.com/api/v1/search",
} satisfies Record<TransportCase, string>;

function parseScenarios(): Scenario[] {
  const encoded = process.argv[2];
  if (encoded === undefined) throw new Error("missing transient search scenario argument");
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("transient search scenarios must be valid JSON");
  }
  if (!isScenarioList(value)) throw new Error("invalid transient search scenarios");
  return value;
}

function providerFor(transport: TransportCase): SearchProviderFamily {
  if (transport === "exa-api" || transport === "exa-mcp") return "exa";
  if (transport === "kagi-api") return "kagi";
  return "openai";
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

// Each scenario gets a fresh event bus, search scope, session, abort controller and counters.
async function runScenario(scenario: Scenario, index: number): Promise<ScenarioResult> {
  const provider = providerFor(scenario.transport);
  const responseStatus = scenario.failure === "cancel" ? 500 : scenario.failure;
  const eventBus = createEventBus();
  const manager = SessionManager.inMemory(process.cwd(), {
    id: `transient-search-session-${index}`,
  });
  const controller = new AbortController();
  let fetchCalls = 0;
  let fallbackCalls = 0;

  globalThis.fetch = async (input) => {
    fetchCalls += 1;
    const url = requestUrl(input);
    if (!url.includes(expectedUrlParts[scenario.transport])) {
      throw new Error(`unexpected transport URL: ${url}`);
    }
    return new Response("fixture failure", { status: responseStatus });
  };

  registerWebAccessSearchAdapters({ events: eventBus });
  const scope = getSearchScope(eventBus);
  bindSearchSession(scope, manager);
  registerSearchAdapter(scope, {
    id: "fixture.fallback",
    family: provider,
    transport: "fixture-fallback",
    priority: 100,
    billing: "free",
    capabilities: { actions: ["search"] },
    availability: () => ({ status: "available" }),
    execute: async () => {
      fallbackCalls += 1;
      return { answer: "fallback", results: [] };
    },
  });

  if (scenario.failure === "cancel") controller.abort();
  try {
    const response = await search(
      { query: "fixture query", provider },
      { scope, signal: controller.signal },
    );
    return {
      fallbackCalls,
      fetchCalls,
      response: {
        adapterId: response.adapterId,
        attempts: response.attempts.map((attempt) => {
          const output: AttemptOutput = {
            adapterId: attempt.adapterId,
            outcome: attempt.outcome,
            transport: attempt.transport,
          };
          if (attempt.errorKind !== undefined) output.errorKind = attempt.errorKind;
          return output;
        }),
      },
    };
  } catch (error) {
    if (!(error instanceof SearchError)) throw error;
    const failure: FailureOutput = { kind: error.kind };
    if (error.status !== undefined) failure.status = error.status;
    return { error: failure, fallbackCalls, fetchCalls };
  }
}

const results: ScenarioResult[] = [];
for (const [index, scenario] of parseScenarios().entries()) {
  results.push(await runScenario(scenario, index));
}
console.log(JSON.stringify(results));
