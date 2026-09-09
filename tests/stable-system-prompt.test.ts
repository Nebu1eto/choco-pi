import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  COMPOSED_PROMPT_MARKER,
  registerStableSystemPrompt,
  restoreComposedPrompt,
} from "../.pi/extensions/stable-system-prompt.ts";

type Handler = (event: RuntimeValue, ctx: ExtensionContext) => RuntimeValue | Promise<RuntimeValue>;

const BASE = "Base prompt\n\nGuidelines:\n- read";
const COMPOSED = `${BASE}\n\n${COMPOSED_PROMPT_MARKER}\nguidance\n</choco_pi_model_guidance>`;

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  let sessionId = "session-one";
  let livePrompt = BASE;
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: Handler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  });
  registerStableSystemPrompt(pi);
  const ctx = reinterpretHostValue<ExtensionContext>({
    sessionManager: { getSessionId: () => sessionId },
    getSystemPrompt: () => livePrompt,
  });
  const emit = async (event: string, payload: RuntimeValue = { type: event }) => {
    let result: RuntimeValue;
    for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
    return result;
  };
  const request = (payload: RuntimeValue) =>
    emit("before_provider_request", { type: "before_provider_request", payload });
  return {
    emit,
    request,
    setLivePrompt: (value: string) => {
      livePrompt = value;
    },
    setSessionId: (value: string) => {
      sessionId = value;
    },
  };
}

/** Mirrors the host: a user turn composes the prompt, then the run starts. */
async function userTurn(harness: ReturnType<typeof createHarness>) {
  await harness.emit("before_agent_start");
  harness.setLivePrompt(COMPOSED);
  await harness.emit("agent_start");
}

test("restoreComposedPrompt rewrites every provider shape and preserves structure", () => {
  const anthropic = restoreComposedPrompt(
    {
      system: [
        { type: "text", text: "You are Claude Code", cache_control: { type: "ephemeral" } },
        { type: "text", text: BASE, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: BASE }],
    },
    BASE,
    COMPOSED,
  );
  assert.deepEqual(anthropic?.system, [
    { type: "text", text: "You are Claude Code", cache_control: { type: "ephemeral" } },
    { type: "text", text: COMPOSED, cache_control: { type: "ephemeral" } },
  ]);
  assert.deepEqual(anthropic?.messages, [{ role: "user", content: BASE }]);

  const completions = restoreComposedPrompt(
    {
      messages: [
        { role: "developer", content: BASE },
        { role: "user", content: "hi" },
      ],
    },
    BASE,
    COMPOSED,
  );
  assert.deepEqual(completions?.messages, [
    { role: "developer", content: COMPOSED },
    { role: "user", content: "hi" },
  ]);

  const responses = restoreComposedPrompt(
    { input: [{ role: "system", content: [{ type: "input_text", text: BASE }] }] },
    BASE,
    COMPOSED,
  );
  assert.deepEqual(responses?.input, [
    { role: "system", content: [{ type: "input_text", text: COMPOSED }] },
  ]);

  assert.equal(
    restoreComposedPrompt({ instructions: BASE }, BASE, COMPOSED)?.instructions,
    COMPOSED,
  );
  assert.equal(
    restoreComposedPrompt({ systemInstruction: BASE }, BASE, COMPOSED)?.systemInstruction,
    COMPOSED,
  );
});

test("restoreComposedPrompt leaves non-matching payloads untouched", () => {
  assert.equal(restoreComposedPrompt({ instructions: "Summarize" }, BASE, COMPOSED), undefined);
  assert.equal(restoreComposedPrompt({ instructions: BASE }, BASE, BASE), undefined);
  assert.equal(restoreComposedPrompt("not a record", BASE, COMPOSED), undefined);
});

test("a host-triggered run that fell back to the base prompt sends the composed prompt", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  assert.equal(await harness.request({ instructions: BASE }), undefined);

  await userTurn(harness);
  assert.equal(await harness.request({ instructions: COMPOSED }), undefined);

  // The run ended, a tool-set change reset the live prompt, and a custom message started a run.
  harness.setLivePrompt(BASE);
  assert.deepEqual(await harness.request({ instructions: BASE }), { instructions: COMPOSED });
});

test("side requests with their own system prompt are not rewritten", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await userTurn(harness);
  harness.setLivePrompt(BASE);
  assert.equal(
    await harness.request({
      messages: [{ role: "system", content: "Summarize the conversation" }],
    }),
    undefined,
  );
});

test("a run that never composed a prompt records nothing", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.emit("agent_start");
  harness.setLivePrompt(BASE);
  assert.equal(await harness.request({ instructions: BASE }), undefined);
});

test("a new session forgets the previous session's composed prompt", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await userTurn(harness);
  harness.setLivePrompt(BASE);
  harness.setSessionId("session-two");
  assert.equal(await harness.request({ instructions: BASE }), undefined);
  await harness.emit("session_start");
  assert.equal(await harness.request({ instructions: BASE }), undefined);
});
