/**
 * Background Anthropic native preparation on a session whose every turn
 * carries an identical persona custom message (`choco-pi-agent-persona`), as
 * the runtime agent-preferences extension appends it.
 *
 * Drives a real `createAgentSession` with the INSTALLED Anthropic adapter and
 * fake transports (no network). Two failure mechanisms used to make the native
 * lane refuse `no-legal-cut` on this shape:
 * - the capture's tail cut was discarded although the branch retains the
 *   assistant reply appended after the capture was sent;
 * - every interior cut split the set of identical persona owners and was
 *   refused as `ambiguous-cut`.
 * Both tests below failed with `no-legal-cut` before the fix.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CompactionEntry,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { ANTHROPIC_BACKEND_ID } from "../src/anthropic/backend.ts";
import {
  capturesFor,
  parseWireBody,
  releaseSessionCaptures,
  type WireBody,
} from "../src/anthropic/capture.ts";
import { type AnthropicDetails, isAnthropicDetails } from "../src/anthropic/details.ts";
import type { CoordinatorStatus } from "../src/background/contract.ts";
import { getCoordinator } from "../src/background/registry.ts";
import type { TextSummarizer } from "../src/background/text-backend.ts";
import registerCompaction from "../src/index.ts";
import { mainOwnerKey } from "../src/ownership.ts";

const OAUTH_KEY = "sk-ant-oat01-persona-non-secret-placeholder";
const MODEL: Model<"anthropic-messages"> = {
  id: "claude-haiku-5-5",
  name: "Synthetic Haiku",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};
const PERSONA_TYPE = "choco-pi-agent-persona";
const PERSONA_TEXT = "Agent persona: pessimistic";
const BLOCK = {
  type: "compaction",
  content: "PERSONA synthetic native summary",
  signature: "persona-synthetic-signature",
};
const TURNS = 6;
/** Padding so each turn weighs a few hundred estimated tokens. */
const PADDING = "detail ".repeat(200);

type Frame = JsonObject & { readonly type: string };

function sse(frames: readonly Frame[]): Response {
  const body = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function response(content: JsonObject, stopReason: string): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: "persona",
        type: "message",
        role: "assistant",
        model: MODEL.id,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: content },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [{ type: "compaction", input_tokens: 90, output_tokens: 30 }],
      },
    },
    { type: "message_stop" },
  ]);
}

interface RecordingFetch {
  readonly sent: WireBody[];
  readonly fetch: typeof globalThis.fetch;
}

function recordingFetch(respond: (index: number) => Response): RecordingFetch {
  const sent: WireBody[] = [];
  return {
    sent,
    fetch: async (_input, init) => {
      const body = parseWireBody(String(init?.body ?? ""));
      assert.ok(body, "a well-formed request body");
      sent.push(body);
      return respond(sent.length - 1);
    },
  };
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The text lane is enabled (as in production) but must never be the one that prepares. */
const textSummarizer: TextSummarizer = {
  scope: { provider: MODEL.provider, model: MODEL.id, baseUrl: MODEL.baseUrl },
  summarize: async () => ({
    text: "## Goal\nPERSONA-TEXT-SUMMARY",
    usage,
    stopReason: "stop",
    toolCallCount: 0,
  }),
};

interface Rig {
  readonly session: AgentSession;
  readonly manager: SessionManager;
  readonly foreground: RecordingFetch;
  readonly lane: RecordingFetch;
  dispose(): Promise<void>;
}

async function createRig(keepRecentTokens: number): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-anthropic-persona-"));
  const sidecar = join(dir, "background-compaction.json");
  // Background on with both lanes; the usage threshold is never crossed, so
  // only the explicit request below starts a preparation.
  await writeFile(
    sidecar,
    JSON.stringify({
      enabled: true,
      text: true,
      anthropicNative: true,
      prepareAt: 0.99,
      hysteresis: 0,
      reserveTokens: 0,
      retryBaseMs: 0,
      cooldownMs: 0,
      timeoutMs: 20_000,
      maxOutputTokens: 1_000,
    }),
  );
  const foreground = recordingFetch((index) =>
    response({ type: "text", text: `PERSONA-ACK-${index} ${PADDING}` }, "end_turn"),
  );
  const lane = recordingFetch(() => response(BLOCK, "compaction"));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerProvider("anthropic", {
    api: "anthropic-messages",
    apiKey: OAUTH_KEY,
    models: [MODEL],
    streamSimple: () => {
      throw new Error("unwrapped provider stream used");
    },
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens, reserveTokens: 16_384 },
    retry: { enabled: false },
  });
  const persona = (pi: ExtensionAPI): void => {
    // The runtime agent-preferences extension appends this identical message every turn.
    pi.on("before_agent_start", () => ({
      message: { customType: PERSONA_TYPE, content: PERSONA_TEXT, display: false },
    }));
  };
  const compaction = (pi: ExtensionAPI): void => {
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens, reserveTokens: 16_384 }),
      background: {
        settingsPaths: () => [sidecar],
        createTextSummarizer: () => textSummarizer,
        anthropic: {
          readMode: async () => "server-side",
          fetch: lane.fetch,
          capture: { fetch: foreground.fetch },
        },
      },
    });
  };
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [persona, compaction],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(dir);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: MODEL,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: settings,
    noTools: "builtin",
  });
  await session.bindExtensions({});
  const sessionId = manager.getSessionId();
  return {
    session,
    manager,
    foreground,
    lane,
    async dispose() {
      session.dispose();
      releaseSessionCaptures(sessionId);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function seedTurns(rig: Rig): Promise<void> {
  for (let turn = 0; turn < TURNS; turn++) {
    await rig.session.prompt(`PERSONA-SEED-${turn} ${PADDING}`);
  }
}

function personaEntryIds(manager: SessionManager): string[] {
  return manager
    .getBranch()
    .filter((entry) => entry.type === "custom_message" && entry.customType === PERSONA_TYPE)
    .map((entry) => entry.id);
}

/** Request a native preparation and wait for it to settle. */
async function prepareNative(rig: Rig): Promise<CoordinatorStatus> {
  const coordinator = getCoordinator(mainOwnerKey(rig.manager.getSessionId()));
  assert.ok(coordinator, "the main owner has a coordinator");
  const request = await coordinator.requestPreparation({
    trigger: "manual",
    backendId: ANTHROPIC_BACKEND_ID,
  });
  assert.ok(request.accepted, JSON.stringify(request));
  const deadline = Date.now() + 5_000;
  for (;;) {
    const status = coordinator.status();
    if (status.state !== "queued" && status.state !== "preparing") return status;
    assert.ok(Date.now() < deadline, `preparation did not settle: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Adopted {
  readonly entry: CompactionEntry;
  readonly details: AnthropicDetails;
}

/** Adopt the ready native candidate through the host's own compaction. */
async function adopt(rig: Rig): Promise<Adopted> {
  await rig.session.compact();
  const entries = rig.manager
    .getBranch()
    .filter((entry): entry is CompactionEntry => entry.type === "compaction");
  assert.equal(entries.length, 1, "exactly one compaction");
  const [entry] = entries;
  assert.ok(entry);
  assert.ok(isAnthropicDetails(entry.details), "a native checkpoint was adopted");
  return { entry, details: entry.details };
}

function personaCopies(body: WireBody | undefined): number {
  assert.ok(body);
  return body.messages.filter((message) => JSON.stringify(message.content).includes(PERSONA_TEXT))
    .length;
}

test(
  "repeated persona messages: the capture-tail cut retains the reply and is prepared natively",
  { timeout: 30_000 },
  async () => {
    const rig = await createRig(1);
    try {
      await seedTurns(rig);
      const personas = personaEntryIds(rig.manager);
      assert.equal(personas.length, TURNS, "one identical persona message per turn");
      const capture = capturesFor(rig.manager.getSessionId()).at(-1);
      assert.ok(capture?.mapping, "the last request was captured and mapped");
      // The capture was taken when the last request was sent: its last
      // projected entry is the last persona message, the reply came later.
      assert.equal(capture.mapping.projection.at(-1)?.entryId, personas.at(-1));
      const reply = rig.manager.getBranch().at(-1);
      assert.ok(reply?.type === "message" && reply.message.role === "assistant");

      const status = await prepareNative(rig);
      // Before the fix: { state: "failed", reason: "no-legal-cut", detail: "no-legal-cut" }.
      assert.equal(status.state, "ready", JSON.stringify(status));
      assert.equal(status.backendId, ANTHROPIC_BACKEND_ID);
      assert.equal(rig.lane.sent.length, 1, "one native lane request");

      const { entry, details } = await adopt(rig);
      assert.equal(rig.lane.sent.length, 1, "adoption sent no second request");
      assert.equal(details.cut.cutEntryId, personas.at(-1), "cut at the capture tail");
      assert.equal(details.wire.prefixLength, details.wire.capturedLength);
      assert.equal(details.wire.capturedLength, capture.body.messages.length);
      assert.equal(entry.firstKeptEntryId, reply.id, "the assistant reply is retained");
      assert.equal(details.cut.firstKeptEntryId, reply.id);
      assert.equal(personaCopies(rig.lane.sent[0]), TURNS, "the lane summarized every copy");
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "repeated persona messages: an interior cut resolves the copies by position",
  { timeout: 30_000 },
  async () => {
    // Keeps roughly the last two turns, so the cut falls among the persona copies.
    const rig = await createRig(700);
    try {
      await seedTurns(rig);
      const personas = personaEntryIds(rig.manager);
      assert.equal(personas.length, TURNS);
      const capture = capturesFor(rig.manager.getSessionId()).at(-1);
      assert.ok(capture?.mapping);
      // Each wire copy owns its own persona entry, in order, and none is ambiguous.
      const owners = capture.mapping.messages
        .filter((message) => message.entryIds.some((id) => personas.includes(id)))
        .map((message) => message.entryIds.find((id) => personas.includes(id)));
      assert.deepEqual(owners, personas);
      assert.ok(capture.mapping.messages.every((message) => message.ambiguous.length === 0));

      const status = await prepareNative(rig);
      // Before the fix: every interior cut was ambiguous-cut, so no-legal-cut.
      assert.equal(status.state, "ready", JSON.stringify(status));

      const { entry, details } = await adopt(rig);
      const branch = rig.manager.getBranch();
      const cutIndex = branch.findIndex((item) => item.id === details.cut.cutEntryId);
      assert.ok(cutIndex >= 0);
      assert.ok(details.wire.prefixLength < details.wire.capturedLength, "an interior cut");
      const summarizedPersonas = personas.filter((id) =>
        branch.slice(0, cutIndex + 1).some((item) => item.id === id),
      ).length;
      assert.ok(summarizedPersonas > 0 && summarizedPersonas < TURNS, "the cut splits the copies");
      // Positional: the lane prefix carries exactly the copies at or before the cut.
      assert.equal(personaCopies(rig.lane.sent[0]), summarizedPersonas);
      const laneBody = rig.lane.sent[0];
      assert.ok(laneBody);
      assert.deepEqual(
        laneBody.messages.slice(0, details.wire.prefixLength),
        capture.body.messages.slice(0, details.wire.prefixLength),
        "the lane carried the captured wire prefix unchanged",
      );
      // The first kept message is a user message the wire places right after the prefix.
      assert.equal(capture.body.messages[details.wire.prefixLength]?.role, "user");
      assert.equal(entry.firstKeptEntryId, branch[cutIndex + 1]?.id);
    } finally {
      await rig.dispose();
    }
  },
);
