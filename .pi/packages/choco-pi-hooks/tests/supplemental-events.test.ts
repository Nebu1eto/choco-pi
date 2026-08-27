import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSupplementalEvents } from "../src/index.ts";
import type { MergedHookResult } from "../src/index.ts";
import type { RuntimeValue } from "../src/validation.ts";

type Handler = (...args: RuntimeValue[]) => RuntimeValue;

interface SupplementalApiDouble {
  on(channel: string, handler: Handler): void;
  registerMarkdownTransformer(): void;
  events: {
    on(channel: string, handler: Handler): () => void;
    emit(channel: string): void;
  };
}

interface SupplementalContextDouble {
  readonly mode?: "tui";
}

interface SupplementalTestApi {
  api: ExtensionAPI;
  extensionHandlers: Map<string, Handler[]>;
  eventHandlers: Map<string, Handler[]>;
  emitted: string[];
}

function extensionApi(value: SupplementalApiDouble): ExtensionAPI {
  // SAFETY: The focused supplemental tests invoke only the registration methods supplied by the double.
  const api = {} as ExtensionAPI;
  Object.assign(api, value);
  return api;
}

function extensionContext(value: SupplementalContextDouble): ExtensionContext {
  // SAFETY: Each focused test supplies every ExtensionContext member exercised by its dispatch double.
  return value as ExtensionContext;
}

function supplementalTestApi(): SupplementalTestApi {
  const extensionHandlers = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Handler[]>();
  const emitted: string[] = [];
  const addHandler = (handlers: Map<string, Handler[]>, channel: string, handler: Handler) => {
    const registered = handlers.get(channel) ?? [];
    registered.push(handler);
    handlers.set(channel, registered);
    return () => {
      handlers.set(
        channel,
        registered.filter((candidate) => candidate !== handler),
      );
    };
  };
  const api = extensionApi({
    on(channel: string, handler: Handler) {
      addHandler(extensionHandlers, channel, handler);
    },
    registerMarkdownTransformer() {},
    events: {
      on(channel: string, handler: Handler) {
        return addHandler(eventHandlers, channel, handler);
      },
      emit(channel: string) {
        emitted.push(channel);
      },
    },
  });
  return { api, extensionHandlers, eventHandlers, emitted };
}

function emptyResult(): MergedHookResult {
  return {
    invocations: [],
    blocked: false,
    continue: true,
    systemMessages: [],
    terminalSequences: [],
    additionalContext: [],
  };
}

test("in-flight supplemental event stops without touching a disposed context", async () => {
  const { api, eventHandlers, emitted } = supplementalTestApi();
  let resolveIdle!: (result: MergedHookResult) => void;
  const idle = new Promise<MergedHookResult>((resolve) => {
    resolveIdle = resolve;
  });
  const dispatched: string[] = [];
  let stale = false;
  let contextAccesses = 0;
  const oldContext = extensionContext({
    get mode() {
      contextAccesses += 1;
      if (stale) throw new Error("stale getter was touched");
      return "tui" as const;
    },
  });
  const supplemental = registerSupplementalEvents(api, (event, ctx) => {
    void ctx.mode;
    dispatched.push(event);
    return event === "TeammateIdle" ? idle : Promise.resolve(emptyResult());
  });
  supplemental.setContext(oldContext);

  const stopped = eventHandlers.get("subagents:completed")?.[0];
  assert.ok(stopped);
  stopped({ id: "agent-1", workflowId: "flow-1", workflowStepId: "step-1" });
  assert.deepEqual(dispatched, ["TeammateIdle"]);
  supplemental.dispose();
  stale = true;
  resolveIdle(emptyResult());
  await idle;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(dispatched, ["TeammateIdle"]);
  assert.deepEqual(emitted, []);
  assert.equal(contextAccesses, 1);
  assert.equal(supplemental.getContext(), undefined);
});

test("in-flight instruction loading stops before dispatching again with a disposed context", async () => {
  const { api, extensionHandlers } = supplementalTestApi();
  let resolveFirst!: (result: MergedHookResult) => void;
  const first = new Promise<MergedHookResult>((resolve) => {
    resolveFirst = resolve;
  });
  const dispatched: string[] = [];
  const ctx = extensionContext({});
  const supplemental = registerSupplementalEvents(api, (_event, dispatchContext, extra) => {
    assert.equal(dispatchContext, ctx);
    dispatched.push(String(extra?.file_path));
    return first;
  });
  const beforeAgentStart = extensionHandlers.get("before_agent_start")?.[0];
  assert.ok(beforeAgentStart);

  const completion = Promise.resolve(
    beforeAgentStart(
      {
        systemPromptOptions: {
          contextFiles: [{ path: "/one/AGENTS.md" }, { path: "/two/AGENTS.md" }],
        },
      },
      ctx,
    ),
  );
  assert.deepEqual(dispatched, ["/one/AGENTS.md"]);

  supplemental.dispose();
  resolveFirst(emptyResult());
  await completion;

  assert.deepEqual(dispatched, ["/one/AGENTS.md"]);
  assert.equal(supplemental.getContext(), undefined);
});

test("awaited supplemental handlers propagate unrelated dispatch errors", async () => {
  const { api, extensionHandlers } = supplementalTestApi();
  const failure = new Error("unrelated dispatch failure");
  registerSupplementalEvents(api, async () => {
    throw failure;
  });
  const turnEnd = extensionHandlers.get("turn_end")?.[0];
  assert.ok(turnEnd);

  await assert.rejects(
    Promise.resolve(turnEnd({ toolResults: [] }, extensionContext({}))),
    (error) => error === failure,
  );
});

test("elicitation resolves a successful hook response exactly once", async () => {
  const { api, eventHandlers } = supplementalTestApi();
  const result = emptyResult();
  result.elicitationAction = "accept";
  result.elicitationContent = { answer: "yes" };
  const supplemental = registerSupplementalEvents(api, async () => result);
  supplemental.setContext(extensionContext({}));
  const elicitation = eventHandlers.get("choco-pi-hooks:elicitation")?.[0];
  assert.ok(elicitation);
  let claims = 0;
  const resolutions: RuntimeValue[] = [];

  await Promise.resolve(
    elicitation({
      event: "Elicitation",
      claim: () => (claims += 1),
      resolve: (value: RuntimeValue) => resolutions.push(value),
      params: { message: "Continue?" },
    }),
  );

  assert.equal(claims, 1);
  assert.deepEqual(resolutions, [{ action: "accept", content: { answer: "yes" } }]);
});

test("elicitation resolves undefined once when its context changes or is disposed", async () => {
  for (const cancellation of ["context", "dispose"] as const) {
    const { api, eventHandlers } = supplementalTestApi();
    let finishDispatch!: (result: MergedHookResult) => void;
    const dispatched = new Promise<MergedHookResult>((resolve) => {
      finishDispatch = resolve;
    });
    const supplemental = registerSupplementalEvents(api, async () => dispatched);
    supplemental.setContext(extensionContext({}));
    const elicitation = eventHandlers.get("choco-pi-hooks:elicitation")?.[0];
    assert.ok(elicitation);
    let claims = 0;
    const resolutions: RuntimeValue[] = [];
    const completion = Promise.resolve(
      elicitation({
        event: "Elicitation",
        claim: () => (claims += 1),
        resolve: (value: RuntimeValue) => resolutions.push(value),
        params: {},
      }),
    );

    if (cancellation === "context") supplemental.setContext(extensionContext({}));
    else supplemental.dispose();
    finishDispatch(emptyResult());
    await completion;

    assert.equal(claims, 1, cancellation);
    assert.deepEqual(resolutions, [undefined], cancellation);
  }
});

test("elicitation resolves cancellation once and only rethrows unrelated dispatch failures", async () => {
  for (const [name, dispatchError] of [
    ["stale", new Error("This extension ctx is stale after session replacement or reload.")],
    ["failure", new Error("unrelated dispatch failure")],
  ] as const) {
    const { api, eventHandlers } = supplementalTestApi();
    const supplemental = registerSupplementalEvents(api, async () => {
      throw dispatchError;
    });
    supplemental.setContext(extensionContext({}));
    const elicitation = eventHandlers.get("choco-pi-hooks:elicitation")?.[0];
    assert.ok(elicitation);
    let claims = 0;
    const resolutions: RuntimeValue[] = [];
    const completion = Promise.resolve(
      elicitation({
        event: "ElicitationResult",
        claim: () => (claims += 1),
        resolve: (value: RuntimeValue) => resolutions.push(value),
        params: {},
        current: { action: "cancel" },
      }),
    );

    if (name === "failure") await assert.rejects(completion, (error) => error === dispatchError);
    else await completion;
    assert.equal(claims, 1, name);
    assert.deepEqual(resolutions, [undefined], name);
  }
});
