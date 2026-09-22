import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { registerWebAccessSearchAdapters } from "../../search-adapters.ts";
import {
  bindSearchSession,
  getSearchScope,
  registerSearchAdapter,
  search,
  SearchError,
  type SearchProviderFamily,
} from "../../../choco-pi-web-search/index.ts";

const TransportSchema = Type.Union([
  Type.Literal("exa-api"),
  Type.Literal("exa-mcp"),
  Type.Literal("kagi-api"),
  Type.Literal("openai-responses"),
]);
const ScenarioSchema = Type.Object(
  {
    transport: TransportSchema,
    failure: Type.Union([Type.Literal("cancel"), Type.Integer({ minimum: 100, maximum: 599 })]),
  },
  { additionalProperties: false },
);

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

const expectedUrlParts = {
  "openai-responses": "api.openai.com/v1/responses",
  "exa-api": "api.exa.ai/answer",
  "exa-mcp": "mcp.exa.ai/mcp",
  "kagi-api": "kagi.com/api/v1/search",
} satisfies Record<TransportCase, string>;

function parseScenario(): Scenario {
  const encoded = process.argv[2];
  if (encoded === undefined) throw new Error("missing transient search scenario argument");
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("transient search scenario must be valid JSON");
  }
  if (!Check(ScenarioSchema, value)) throw new Error("invalid transient search scenario");
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

const scenario = parseScenario();
const provider = providerFor(scenario.transport);
const responseStatus = scenario.failure === "cancel" ? 500 : scenario.failure;
const eventBus = createEventBus();
const manager = SessionManager.inMemory(process.cwd(), { id: "transient-search-session" });
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
  console.log(
    JSON.stringify({
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
    }),
  );
} catch (error) {
  if (!(error instanceof SearchError)) throw error;
  const failure: FailureOutput = { kind: error.kind };
  if (error.status !== undefined) failure.status = error.status;
  console.log(JSON.stringify({ error: failure, fallbackCalls, fetchCalls }));
}
