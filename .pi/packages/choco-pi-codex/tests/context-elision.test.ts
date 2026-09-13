import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE } from "../src/adapter/compaction/request-shrink.ts";
import {
  assignTurnOrdinals,
  computeCut,
  eligibleToolResultChars,
  elideToolResults,
  ELISION_STEP_CHARS,
} from "../src/extension/context-elision.ts";
import { registerCodexEvents } from "../src/extension/events.ts";
import { createCodexExtensionRuntime } from "../src/extension/runtime.ts";
import {
  closeNativeSteering,
  openNativeSteering,
  steerNativeResponse,
} from "../src/providers/openai-codex/native-steering.ts";
import type {
  CodexStreamEvent,
  ResponsesBody,
  WebSocketEvent,
  WebSocketLike,
} from "../src/providers/openai-codex/types.ts";

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const result = (text: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "exec_command",
  isError: false,
  timestamp: 2,
  content: [{ type: "text", text }],
  ...overrides,
});
const history = (text = "x".repeat(ELISION_STEP_CHARS)): AgentMessage[] => [
  user("first"),
  result(text),
  user("second"),
  result(text),
  user("current"),
  result(text),
];
const cutFor = (messages: AgentMessage[], priorCut = 0) =>
  computeCut({
    ordinal: assignTurnOrdinals(messages),
    priorCut,
    eligibleChars: messages.map(eligibleToolResultChars),
  });

test("cut advances at the exact character step, stays monotonic and deterministic", () => {
  assert.equal(cutFor(history("x".repeat(ELISION_STEP_CHARS - 1))), 0);
  const messages = history();
  assert.deepEqual(assignTurnOrdinals(messages), [1, 1, 2, 2, 3, 3]);
  assert.equal(cutFor(messages), 2);
  assert.equal(cutFor(messages), cutFor(messages));
  assert.equal(cutFor(messages, 2), 2);
  assert.equal(cutFor([], 2), 2);
  const next = [...messages, user("next"), result("x".repeat(ELISION_STEP_CHARS - 1))];
  assert.equal(cutFor(next, 2), 4);
  assert.equal(cutFor(next, 4), 4);
  assert.equal(
    computeCut({
      ordinal: [1, 1, 1, 2, 3],
      priorCut: 0,
      eligibleChars: [0, 49, 50, 0, 0],
      stepChars: 100,
    }),
    0,
  );
  assert.equal(
    computeCut({
      ordinal: [1, 1, 1, 2, 3],
      priorCut: 0,
      eligibleChars: [0, 49, 51, 0, 0],
      stepChars: 100,
    }),
    3,
  );
  assert.equal(
    computeCut({
      ordinal: [1, 1, 1, 2, 3],
      priorCut: 2,
      eligibleChars: [0, 100, 99, 0, 0],
      stepChars: 100,
    }),
    2,
  );
});

test("request copies preserve pairing, non-text blocks, last two turns and input", () => {
  const text = [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "é".repeat(ELISION_STEP_CHARS),
    "tail-1",
    "tail-2",
    "tail-3",
    "tail-4",
    "tail-5",
  ].join("\n");
  const details = { exitCode: 0, nested: { retained: true } };
  const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
  const messages = history(text);
  messages[1] = result(text, { details, content: [{ type: "text", text }, image] });
  const original = structuredClone(messages);
  for (const message of messages) Object.freeze(message);
  Object.freeze(messages);
  const rewritten = elideToolResults(messages, 999);
  assert.deepEqual(messages, original);
  rewritten.forEach((message, index) => assert.notEqual(message, messages[index]));
  assert.deepEqual(rewritten.slice(2), messages.slice(2));
  const old = rewritten[1];
  assert.ok(old?.role === "toolResult");
  assert.equal(old.toolCallId, "call-1");
  assert.equal(old.toolName, "exec_command");
  assert.equal(old.isError, false);
  assert.equal(old.details, details);
  assert.equal(old.content[1], image);
  const content = old.content[0];
  assert.ok(content?.type === "text");
  assert.ok(content.text.includes(COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE));
  assert.ok(content.text.startsWith(`[exec_command: ${Buffer.byteLength(text)} bytes]`));
  assert.ok(content.text.includes("first\nsecond\nthird\nfourth\nfifth"));
  assert.ok(content.text.endsWith("tail-1\ntail-2\ntail-3\ntail-4\ntail-5"));
  assert.ok(content.text.length < 6_000);
  assert.deepEqual(elideToolResults(messages, 0), messages);
  assert.equal(cutFor([user("only"), result(text)]), 0);
  assert.deepEqual(elideToolResults([user("only"), result(text)], 999), [
    user("only"),
    result(text),
  ]);
});

test("giant single lines retain their beginning and ending without defeating elision", () => {
  const messages = history(`BEGIN${"x".repeat(ELISION_STEP_CHARS)}END`);
  const output = elideToolResults(messages, 2)[1];
  assert.ok(output?.role === "toolResult" && output.content[0]?.type === "text");
  assert.ok(output.content[0].text.includes("BEGIN"));
  assert.ok(output.content[0].text.endsWith("END"));
  assert.ok(output.content[0].text.length < 2_000);
});

test("errors, encrypted web outputs and small results neither count nor change", () => {
  for (const message of [
    result("x".repeat(ELISION_STEP_CHARS), { isError: true }),
    result("x".repeat(ELISION_STEP_CHARS), { details: { webRun: { encrypted_output: "opaque" } } }),
    result("short"),
  ]) {
    const messages = [user("old"), message, user("recent"), user("current")];
    assert.equal(eligibleToolResultChars(message), 0);
    assert.equal(cutFor(messages), 0);
    assert.deepEqual(elideToolResults(messages, 2), messages);
  }
});

type FixtureValue = {} | null | undefined;
type Handler = (event: FixtureValue, ctx: ExtensionContext) => FixtureValue | Promise<FixtureValue>;
function fixture<T>(value: FixtureValue): T {
  // SAFETY: Fixtures provide the host members reached by registered handlers only.
  return value as T;
}

function harness(manager = SessionManager.inMemory()) {
  const handlers = new Map<string, Handler>();
  const pi = fixture<ExtensionAPI>({
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    appendEntry(name: string, data: FixtureValue) {
      manager.appendCustomEntry(name, data);
    },
    getActiveTools: () => [],
    setActiveTools() {},
  });
  const runtime = createCodexExtensionRuntime(pi);
  runtime.configureDiagnostics = () => Promise.resolve();
  runtime.startPrewarm = () => undefined;
  runtime.execEnv = () => ({});
  const ctx = fixture<ExtensionContext>({
    sessionManager: manager,
    cwd: process.cwd(),
    hasUI: false,
    isProjectTrusted: () => false,
    getSystemPrompt: () => "system",
    modelRegistry: {},
    model: undefined,
  });
  registerCodexEvents(
    pi,
    runtime,
    fixture({ ensureOptionalTools() {} }),
    fixture({ invalidateUsageStatus() {}, refreshUsageStatus: () => Promise.resolve() }),
    fixture({
      prepare: () => Promise.resolve(),
      shutdownHost: () => Promise.resolve(),
      refreshPromptTools: (prompt: string) => prompt,
    }),
    fixture({ applyConfig() {} }),
  );
  const invoke = (name: string, event: FixtureValue = {}) => {
    const handler = handlers.get(name);
    assert.ok(handler);
    return handler(event, ctx);
  };
  const activate = () => {
    ctx.model = fixture({
      provider: "openai-codex",
      api: "openai-codex-responses",
      id: "gpt-6-astra",
      input: ["text", "image"],
    });
    runtime.state.config.voiceFeaturesOnly = false;
  };
  const context = () => {
    const response = invoke("context", { messages: manager.buildSessionContext().messages });
    assert.ok(!(response instanceof Promise), "context elision must stay synchronous");
    return fixture<{ messages: AgentMessage[] }>(response).messages;
  };
  return { manager, runtime, ctx, invoke, activate, context };
}

test("wire hooks persist once, restore maximum epoch cut, and reset after compaction", async () => {
  const first = harness();
  for (const message of history()) first.manager.appendMessage(fixture(message));
  await first.invoke("session_start", { reason: "resume" });
  first.activate();
  const originals = first.manager.buildSessionContext().messages;
  assert.equal(first.invoke("turn_start"), undefined);
  const persisted = first.manager.getLeafEntry();
  assert.ok(persisted?.type === "custom");
  assert.equal(persisted.customType, "codex-context-elision");
  assert.deepEqual(persisted.data, { epoch: "", cut: 2 });
  const rewritten = first.context();
  assert.notDeepEqual(rewritten[1], originals[1]);
  first.invoke("turn_start");
  assert.equal(first.manager.getLeafEntry(), persisted);
  assert.deepEqual(first.manager.buildSessionContext().messages, originals);
  first.manager.appendCustomEntry("codex-context-elision", { epoch: "", cut: 0 });
  first.manager.appendCustomEntry("codex-context-elision", { epoch: "unrelated", cut: 999 });
  const resumed = harness(first.manager);
  await resumed.invoke("session_start", { reason: "resume" });
  resumed.activate();
  assert.deepEqual(resumed.context(), rewritten);
  const kept = first.manager.getBranch().find((entry) => entry.type === "message");
  assert.ok(kept);
  const compactionId = first.manager.appendCompaction("summary", kept.id, 100);
  await resumed.invoke("session_compact", {
    compactionEntry: first.manager.getEntry(compactionId),
    fromExtension: false,
  });
  assert.deepEqual(resumed.context(), first.manager.buildSessionContext().messages);
  resumed.invoke("turn_start");
  const next = first.manager.getLeafEntry();
  assert.ok(next?.type === "custom");
  assert.deepEqual(next.data, { epoch: compactionId, cut: 3 });
  const afterCompaction = harness(first.manager);
  await afterCompaction.invoke("session_start", { reason: "resume" });
  afterCompaction.activate();
  assert.deepEqual(afterCompaction.context(), resumed.context());
});

test("branch navigation cannot carry a cut from a different branch", async () => {
  const host = harness();
  for (const message of history()) host.manager.appendMessage(fixture(message));
  const branchPoint = host.manager.getLeafId();
  assert.ok(branchPoint);
  host.activate();
  host.invoke("turn_start");
  const elidedLeaf = host.manager.getLeafId();
  assert.ok(elidedLeaf);
  const rewritten = host.context();
  host.manager.branch(branchPoint);
  await host.invoke("session_tree");
  assert.deepEqual(host.context(), host.manager.buildSessionContext().messages);
  host.manager.branch(elidedLeaf);
  await host.invoke("session_tree");
  assert.deepEqual(host.context(), rewritten);
});

class Socket implements WebSocketLike {
  private readonly listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();
  send(): void {}
  close(): void {}
  addEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(event: CodexStreamEvent): void {
    for (const listener of this.listeners.get("message") ?? [])
      listener({ data: JSON.stringify(event) });
  }
}

test("pending native steering preserves frozen elision and blocks cut advancement", async () => {
  const host = harness();
  for (const message of history()) host.manager.appendMessage(fixture(message));
  host.activate();
  host.invoke("turn_start");
  const rewritten = host.context();
  const owner = host.manager.getSessionId();
  const socket = new Socket();
  const connection = openNativeSteering(socket, owner);
  const body: ResponsesBody = {
    model: "gpt-6-astra",
    store: false,
    stream: true,
    input: [],
    text: { verbosity: "low" },
    include: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  let pending: AgentMessage[] | undefined;
  try {
    connection.begin(body);
    const events = connection.responseEvents(undefined, 1000)[Symbol.asyncIterator]();
    socket.emit({ type: "response.created", response: { id: "response-1" } });
    await events.next();
    assert.equal(steerNativeResponse(owner, "follow up"), true);
    pending = host.context();
    assert.deepEqual(pending, rewritten);
    host.manager.appendMessage(fixture(user("next")));
    const leaf = host.manager.getLeafEntry();
    host.invoke("turn_start");
    assert.equal(host.manager.getLeafEntry(), leaf);
  } finally {
    closeNativeSteering(owner);
  }
  const cleared = host.context().slice(0, rewritten.length);
  assert.deepEqual(cleared, rewritten);
  assert.ok(pending);
  const sequenceEligibleChars = [rewritten, pending, cleared].map((messages) =>
    messages.reduce((total, message) => total + eligibleToolResultChars(message), 0),
  );
  assert.deepEqual(
    sequenceEligibleChars,
    [...sequenceEligibleChars].sort((a, b) => b - a),
  );
});

test("inactive runtimes bypass context elision and cut advancement", () => {
  const host = harness();
  for (const message of history()) host.manager.appendMessage(fixture(message));
  host.activate();
  host.invoke("turn_start");
  host.ctx.model = fixture({
    provider: "anthropic",
    api: "anthropic-messages",
    id: "claude-sonnet-4-5",
    input: ["text"],
  });
  host.runtime.state.config.scope.allProviders = "off";
  assert.deepEqual(host.context(), host.manager.buildSessionContext().messages);
  const leaf = host.manager.getLeafEntry();
  host.invoke("turn_start");
  assert.equal(host.manager.getLeafEntry(), leaf);
});
