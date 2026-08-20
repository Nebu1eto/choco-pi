import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEW_CHAT_FAILURE_PREFIX,
  buildReviewChatPrompt,
  createReviewChat,
  type ReviewChatContext,
  type ReviewChatMessage,
  type ReviewChatSession,
  type ReviewChatSessionEvent,
  type ReviewChatSessionRequest,
} from "../.pi/extensions/review/core/ask.ts";

/* ------------------------------------------------------------------ fixtures */

/** Text of a user or assistant entry; a tool entry has none and returns "". */
function textOf(message: ReviewChatMessage | undefined): string {
  return message && message.role !== "tool" ? message.text : "";
}

const HUNK_HEADER = "@@ -12,6 +12,9 @@ export function resolveTarget(input: string) {";

/** Content from elsewhere in the same review that must never reach the chat. */
const OTHER_FILE_HUNK = [
  "@@ -1,4 +1,4 @@ package secrets",
  "-const ROTATION_TOKEN = 'old-token-value';",
  "+const ROTATION_TOKEN = 'new-token-value';",
].join("\n");

function context(overrides: Partial<ReviewChatContext> = {}): ReviewChatContext {
  return {
    path: "src/target.ts",
    side: "RIGHT",
    line: 15,
    focusedLineText: "if (trimmed.startsWith('-')) throw new Error('flag as target');",
    hunkHeader: HUNK_HEADER,
    reviewRoot: "/tmp/review-worktree",
    ...overrides,
  };
}

function assistantMessage(text: string, extra: Record<string, RuntimeValue> = {}): RuntimeValue {
  return { role: "assistant", content: [{ type: "text", text }], ...extra };
}

type FakeSession = {
  session: ReviewChatSession;
  sent: string[];
  emit(event: ReviewChatSessionEvent): void;
  listenerCount(): number;
  readonly disposeCalls: number;
  readonly abortCalls: number;
};

/**
 * A session that never reaches a provider. `respond` receives the sent prompt
 * and an emitter for the events a real agent session would stream.
 */
function fakeSession(
  respond: (emit: (event: ReviewChatSessionEvent) => void, prompt: string) => Promise<void> | void,
): FakeSession {
  const listeners = new Set<(event: ReviewChatSessionEvent) => void>();
  const sent: string[] = [];
  let disposeCalls = 0;
  let abortCalls = 0;

  const emit = (event: ReviewChatSessionEvent): void => {
    for (const listener of Array.from(listeners)) listener(event);
  };

  return {
    session: {
      async sendUserMessage(content: string): Promise<void> {
        sent.push(content);
        await respond(emit, content);
      },
      subscribe(listener): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async abort(): Promise<void> {
        abortCalls += 1;
      },
      dispose(): void {
        disposeCalls += 1;
      },
    },
    sent,
    emit,
    listenerCount: () => listeners.size,
    get disposeCalls() {
      return disposeCalls;
    },
    get abortCalls() {
      return abortCalls;
    },
  };
}

/** Stream one assistant reply in chunks, the way a real turn arrives. */
function streamed(chunks: string[]) {
  return async (emit: (event: ReviewChatSessionEvent) => void): Promise<void> => {
    emit({ type: "message_start", message: assistantMessage("") });
    let text = "";
    for (const chunk of chunks) {
      text += chunk;
      await Promise.resolve();
      emit({ type: "message_update", message: assistantMessage(text) });
    }
    emit({ type: "message_end", message: assistantMessage(text, { stopReason: "stop" }) });
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------------------- bounding */

test("only the bounded context reaches the model, and the rest of the diff cannot", async () => {
  const fake = fakeSession(streamed(["It throws on empty input."]));
  let requested: ReviewChatSessionRequest | undefined;
  const chat = createReviewChat({
    cwd: "/repo",
    createSession: async (request) => {
      requested = request;
      return fake.session;
    },
  });

  await chat.ask("Why does this throw now?", context());

  assert.equal(fake.sent.length, 1);
  const prompt = fake.sent[0] ?? "";

  // The location the reviewer is looking at, and the question, are present.
  assert.ok(prompt.includes(HUNK_HEADER), "the hunk header is sent");
  assert.ok(prompt.includes("Why does this throw now?"), "the question is sent");
  assert.ok(prompt.includes("src/target.ts"), "the file path is sent");
  assert.ok(prompt.includes("RIGHT"), "the side is sent");
  assert.ok(prompt.includes("15"), "the line is sent");
  assert.ok(prompt.includes("/tmp/review-worktree"), "the readable root is sent");

  // Nothing else from the review can be: there is no channel for it.
  assert.ok(!prompt.includes(OTHER_FILE_HUNK), "other hunks are not sent");
  assert.ok(!prompt.includes("ROTATION_TOKEN"), "content from other files is not sent");

  // The session is rooted at the review worktree, not the host cwd.
  assert.equal(requested?.reviewRoot, "/tmp/review-worktree");
  assert.equal(requested?.cwd, "/repo");

  chat.dispose();
});

test("the chat session is created with the caller's model", async () => {
  const fake = fakeSession(streamed(["Answer."]));
  let requested: ReviewChatSessionRequest | undefined;
  const chat = createReviewChat({
    cwd: "/repo",
    model: "anthropic/claude-fable-5",
    thinkingLevel: "high",
    createSession: async (request) => {
      requested = request;
      return fake.session;
    },
  });
  await chat.ask("Who calls this?", context());
  assert.equal(requested?.model, "anthropic/claude-fable-5");
  assert.equal(requested?.thinkingLevel, "high");
  chat.dispose();
});

test("model and effort set before the session exists shape its creation, and status tracks them", async () => {
  const fake = fakeSession(streamed(["Answer."]));
  let requested: ReviewChatSessionRequest | undefined;
  const chat = createReviewChat({
    cwd: "/repo",
    createSession: async (request) => {
      requested = request;
      return fake.session;
    },
  });
  assert.deepEqual(chat.status, {});
  await chat.setModel("openai/gpt-x");
  await chat.setThinkingLevel("low");
  assert.deepEqual(chat.status, { model: "openai/gpt-x", thinkingLevel: "low" });
  await assert.rejects(() => chat.setThinkingLevel("ultra"), /Unknown thinking level "ultra"/);
  await chat.ask("Who calls this?", context());
  assert.equal(requested?.model, "openai/gpt-x");
  assert.equal(requested?.thinkingLevel, "low");
  chat.dispose();
});

test("reload reloads the session's resources and keeps the transcript", async () => {
  let reloads = 0;
  const fake = fakeSession(streamed(["Answer."]));
  const chat = createReviewChat({
    cwd: "/repo",
    createSession: async () => ({
      ...fake.session,
      reload: async () => {
        reloads += 1;
      },
    }),
  });

  // Before a session exists there is nothing loaded; reload is a no-op.
  await chat.reload();
  assert.equal(reloads, 0);

  await chat.ask("First question?", context());
  assert.equal(chat.messages.length, 2);
  await chat.reload();
  assert.equal(reloads, 1, "the session's resource reload ran");
  assert.equal(chat.messages.length, 2, "the transcript is kept, like the main /reload");
  chat.dispose();
});

test("reload is refused while a reply is streaming", async () => {
  let releaseTurn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  let reloads = 0;
  const fake = fakeSession(async (emit) => {
    emit({ type: "message_start", message: assistantMessage("") });
    emit({ type: "message_update", message: assistantMessage("Thinking…") });
    await gate;
    emit({ type: "message_end", message: assistantMessage("Done.", { stopReason: "stop" }) });
  });
  const chat = createReviewChat({
    cwd: "/repo",
    createSession: async () => ({
      ...fake.session,
      reload: async () => {
        reloads += 1;
      },
    }),
  });
  const turn = chat.ask("Slow question?", context());
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => chat.reload(), /Wait for the current reply/);
  releaseTurn();
  await turn;
  await chat.reload();
  assert.equal(reloads, 1);
  chat.dispose();
});

test("session commands run through the session's prompt path and stream into the transcript", async () => {
  const commandTexts: string[] = [];
  const fake = fakeSession(streamed(["Ordinary answer."]));
  const emitFromCommand = (text: string) => {
    fake.emit({ type: "message_start", message: assistantMessage("") });
    fake.emit({ type: "message_update", message: assistantMessage(`Ran ${text}.`) });
    fake.emit({
      type: "message_end",
      message: assistantMessage(`Ran ${text}.`, { stopReason: "stop" }),
    });
  };
  const chat = createReviewChat({
    cwd: "/repo",
    createSession: async () => ({
      ...fake.session,
      runCommand: async (text: string) => {
        commandTexts.push(text);
        emitFromCommand(text);
      },
      listCommands: () => [{ name: "review-agent", description: "Adversarial review" }],
    }),
  });

  assert.deepEqual(chat.commands(), [], "no catalog before the session exists");
  await chat.prepare("/tmp/review-worktree");
  assert.deepEqual(chat.commands(), [{ name: "review-agent", description: "Adversarial review" }]);

  await chat.runCommand("/review-agent HEAD", "/tmp/review-worktree");
  assert.deepEqual(commandTexts, ["/review-agent HEAD"]);
  assert.deepEqual(
    chat.messages.map((message) =>
      message.role === "tool" ? "tool" : `${message.role}:${message.text}`,
    ),
    ["user:/review-agent HEAD", "assistant:Ran /review-agent HEAD."],
  );
  chat.dispose();
});

test("after the session exists, switches forward to it and status reads live values", async () => {
  const fake = fakeSession(streamed(["Answer."]));
  const modelQueries: string[] = [];
  const effortLevels: string[] = [];
  let liveModel = "anthropic/claude-fable-5";
  let liveThinking = "high";
  const session = {
    ...fake.session,
    describeModel: () => ({ model: liveModel, thinkingLevel: liveThinking }),
    setModel: async (query: string) => {
      modelQueries.push(query);
      liveModel = `resolved/${query}`;
      return liveModel;
    },
    setThinkingLevel: (level: string) => {
      effortLevels.push(level);
      liveThinking = level;
      return level;
    },
  };
  const chat = createReviewChat({ cwd: "/repo", createSession: async () => session });
  await chat.ask("Who calls this?", context());
  assert.deepEqual(chat.status, { model: "anthropic/claude-fable-5", thinkingLevel: "high" });
  assert.equal(await chat.setModel("sonnet"), "resolved/sonnet");
  assert.equal(await chat.setThinkingLevel("medium"), "medium");
  assert.deepEqual(modelQueries, ["sonnet"]);
  assert.deepEqual(effortLevels, ["medium"]);
  assert.deepEqual(chat.status, { model: "resolved/sonnet", thinkingLevel: "medium" });
  chat.dispose();
});

test("a turn that ends on a tool call without a final answer is named, not silent", async () => {
  const fake = fakeSession((emit) => {
    emit({ type: "message_start", message: assistantMessage("") });
    emit({ type: "message_update", message: assistantMessage("Let me check the callers.") });
    emit({
      type: "message_end",
      message: assistantMessage("Let me check the callers.", { stopReason: "toolUse" }),
    });
    emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "grep",
      args: { pattern: "resolveTarget" },
    });
    emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "grep",
      result: { content: [{ type: "text", text: "src/a.ts:1:resolveTarget()" }] },
      isError: false,
    });
    // The model never sends a follow-up message with text.
  });
  const chat = createReviewChat({ cwd: "/repo", createSession: async () => fake.session });
  await chat.ask("Who calls this?", context());
  assert.deepEqual(
    chat.messages.map((message) => message.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.match(
    textOf(chat.messages.at(-1)),
    /ended its turn after a tool call without a final answer/,
  );
  chat.dispose();
});

test("the prompt sends the location — file, hunk header, focused line — and no diff body", () => {
  const focusedLineText = "if (!trimmed) throw new Error('empty target');";
  const prompt = buildReviewChatPrompt(
    "What calls this?",
    context({
      side: "LEFT",
      line: 3,
      focusedLineText,
    }),
  );
  assert.ok(prompt.includes(`- file: src/target.ts`));
  assert.ok(prompt.includes(`- hunk: ${HUNK_HEADER}`));
  assert.ok(prompt.includes("LEFT (base revision)"));
  assert.ok(prompt.includes("- line: 3"));
  assert.ok(prompt.includes(`- focused row text: ${JSON.stringify(focusedLineText)}`));
  assert.ok(prompt.includes("What calls this?"));
  assert.ok(
    prompt.includes("the diff body is deliberately not included"),
    "the model is told the diff body is withheld on purpose",
  );
  assert.ok(
    prompt.includes("Explore the repository yourself from that location"),
    "the model is told to investigate with its own tools",
  );
  assert.ok(
    prompt.includes("LEFT line numbers refer to the base revision"),
    "the model is told how to reach the base side",
  );
  assert.ok(
    prompt.includes("Tag every fenced code block in your answer with its language"),
    "the model is told to tag code fences so the chat renders them highlighted",
  );
  assert.ok(
    prompt.includes("Be concise: lead with the answer"),
    "the model is told to answer concisely",
  );
  assert.ok(
    prompt.includes("Always end your turn with a text answer"),
    "the model is told to close every turn with text",
  );
  assert.ok(!prompt.includes(OTHER_FILE_HUNK));
});

/* -------------------------------------------------------------------- history */

test("tool executions enter the transcript between assistant messages, in event order", async () => {
  const fake = fakeSession((emit) => {
    emit({ type: "message_start", message: assistantMessage("") });
    emit({ type: "message_update", message: assistantMessage("Let me check the caller.") });
    emit({
      type: "message_end",
      message: assistantMessage("Let me check the caller.", { stopReason: "stop" }),
    });
    emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "src/target.ts" },
    });
    emit({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "src/target.ts" },
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });
    emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "const parsed = parse(trimmed);" }] },
      isError: false,
    });
    emit({ type: "message_start", message: assistantMessage("") });
    emit({ type: "message_update", message: assistantMessage("The caller handles it.") });
    emit({
      type: "message_end",
      message: assistantMessage("The caller handles it.", { stopReason: "stop" }),
    });
  });
  const chat = createReviewChat({ cwd: "/repo", createSession: async () => fake.session });

  await chat.ask("Is this safe?", context());
  assert.deepEqual(
    chat.messages.map((message) => message.role),
    ["user", "assistant", "tool", "assistant"],
  );
  const tool = chat.messages[2];
  assert.ok(tool?.role === "tool");
  assert.equal(tool.toolName, "read");
  assert.deepEqual(tool.args, { path: "src/target.ts" });
  assert.equal(tool.done, true);
  assert.equal(tool.isError, false);
  assert.deepEqual(tool.result, {
    content: [{ type: "text", text: "const parsed = parse(trimmed);" }],
  });
  chat.dispose();
});

test("history accumulates across questions on one reused session", async () => {
  const fake = fakeSession(streamed(["Because the caller relies on it."]));
  let created = 0;
  const chat = createReviewChat({
    cwd: "/repo",
    createSession: async () => {
      created += 1;
      return fake.session;
    },
  });

  await chat.ask("Why does this throw now?", context());
  await chat.ask("And is that a breaking change?", context({ line: 16 }));

  assert.equal(created, 1, "one session carries the whole chat, so follow-ups keep context");
  assert.equal(fake.sent.length, 2);
  assert.ok(fake.sent[1]?.includes("And is that a breaking change?"));

  assert.deepEqual(
    chat.messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(textOf(chat.messages[0]), "Why does this throw now?");
  assert.equal(textOf(chat.messages[1]), "Because the caller relies on it.");
  assert.equal(textOf(chat.messages[2]), "And is that a breaking change?");
  assert.equal(textOf(chat.messages[3]), "Because the caller relies on it.");

  chat.dispose();
});

/* ------------------------------------------------------------------ streaming */

test("the reply streams: onUpdate fires repeatedly and the transcript grows", async () => {
  const fake = fakeSession(streamed(["The guard ", "rejects empty ", "input."]));
  const chat = createReviewChat({ cwd: "/repo", createSession: async () => fake.session });

  let updates = 0;
  const assistantSnapshots: string[] = [];
  chat.onUpdate(() => {
    updates += 1;
    const last = chat.messages[chat.messages.length - 1];
    // The final notification flips `pending`, so drop the repeated tail.
    if (last?.role === "assistant" && assistantSnapshots.at(-1) !== last.text) {
      assistantSnapshots.push(last.text);
    }
  });

  const pending = chat.ask("What does the guard do?", context());
  assert.equal(chat.pending, true, "the view can show activity while the turn runs");
  await pending;

  assert.ok(updates > 1, `onUpdate fired ${updates} times, expected more than once`);
  assert.deepEqual(assistantSnapshots, [
    "The guard ",
    "The guard rejects empty ",
    "The guard rejects empty input.",
  ]);
  assert.equal(chat.messages.length, 2, "streamed chunks update one entry, not many");
  assert.equal(textOf(chat.messages[1]), "The guard rejects empty input.");
  assert.equal(chat.pending, false);

  chat.dispose();
});

test("onUpdate returns an unsubscribe that stops further notifications", async () => {
  const fake = fakeSession(streamed(["one", "two"]));
  const chat = createReviewChat({ cwd: "/repo", createSession: async () => fake.session });

  let updates = 0;
  const unsubscribe = chat.onUpdate(() => {
    updates += 1;
  });
  unsubscribe();

  await chat.ask("Anything?", context());
  assert.equal(updates, 0);

  chat.dispose();
});

/* -------------------------------------------------------------------- failure */

test("a rejected request becomes a transcript message rather than a throw", async () => {
  const fake = fakeSession(() => {
    throw new Error("provider is unreachable");
  });
  const chat = createReviewChat({ cwd: "/repo", createSession: async () => fake.session });

  await chat.ask("Is this safe?", context());

  assert.equal(chat.messages.length, 2);
  assert.equal(textOf(chat.messages[1]), `${REVIEW_CHAT_FAILURE_PREFIX}provider is unreachable`);
  assert.equal(chat.pending, false, "a failure still clears the pending flag");

  chat.dispose();
});

test("a provider error carried on the final message becomes a transcript message", async () => {
  const fake = fakeSession((emit) => {
    emit({ type: "message_start", message: assistantMessage("") });
    emit({
      type: "message_end",
      message: assistantMessage("", { stopReason: "error", errorMessage: "rate limited" }),
    });
  });
  const chat = createReviewChat({ cwd: "/repo", createSession: async () => fake.session });

  await chat.ask("Why is this here?", context());

  assert.equal(textOf(chat.messages[1]), `${REVIEW_CHAT_FAILURE_PREFIX}rate limited`);

  chat.dispose();
});

test("a cancelled request becomes a transcript message, keeping partial text", async () => {
  const fake = fakeSession((emit) => {
    emit({ type: "message_start", message: assistantMessage("") });
    emit({ type: "message_update", message: assistantMessage("It reads the ") });
    emit({
      type: "message_end",
      message: assistantMessage("It reads the ", { stopReason: "aborted" }),
    });
  });
  const chat = createReviewChat({ cwd: "/repo", createSession: async () => fake.session });

  await chat.ask("What does it read?", context());

  assert.equal(textOf(chat.messages[1]), "It reads the ");
  assert.equal(textOf(chat.messages[2]), `${REVIEW_CHAT_FAILURE_PREFIX}the request was cancelled.`);

  chat.dispose();
});

test("no configured model surfaces in the transcript and a later question retries", async () => {
  let attempts = 0;
  const fake = fakeSession(streamed(["Now I can answer."]));
  const chat = createReviewChat({
    cwd: "/repo",
    model: "nonexistent/model",
    createSession: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("No model matched nonexistent/model.");
      return fake.session;
    },
  });

  await chat.ask("Why does this throw now?", context());
  assert.equal(
    textOf(chat.messages[1]),
    `${REVIEW_CHAT_FAILURE_PREFIX}No model matched nonexistent/model.`,
  );

  await chat.ask("Try again?", context());
  assert.equal(attempts, 2, "a session failure is not cached");
  assert.equal(textOf(chat.messages[3]), "Now I can answer.");

  chat.dispose();
});

test("a silent turn reports that no answer arrived instead of leaving the pane empty", async () => {
  const fake = fakeSession(() => undefined);
  const chat = createReviewChat({ cwd: "/repo", createSession: async () => fake.session });

  await chat.ask("Anything?", context());

  assert.equal(
    textOf(chat.messages[1]),
    `${REVIEW_CHAT_FAILURE_PREFIX}the model returned no answer.`,
  );

  chat.dispose();
});

/* -------------------------------------------------------------------- disposal */

test("dispose releases listeners, unsubscribes from the session, and stops it", async () => {
  let release: (() => void) | undefined;
  const fake = fakeSession(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const chat = createReviewChat({ cwd: "/repo", createSession: async () => fake.session });

  let updates = 0;
  chat.onUpdate(() => {
    updates += 1;
  });

  const pending = chat.ask("What calls this?", context());
  await settle();
  assert.equal(fake.listenerCount(), 1, "the chat is subscribed while the turn runs");
  const updatesBeforeDispose = updates;

  chat.dispose();

  assert.equal(fake.listenerCount(), 0, "the session subscription is removed");

  // Events the session still emits reach nothing.
  fake.emit({ type: "message_update", message: assistantMessage("late text") });
  assert.equal(updates, updatesBeforeDispose, "released listeners are not called");
  assert.ok(
    !chat.messages.some((message) => textOf(message).includes("late text")),
    "the transcript is not mutated after disposal",
  );

  release?.();
  await pending;
  await settle();

  assert.equal(fake.abortCalls, 1, "the session is aborted");
  assert.equal(fake.disposeCalls, 1, "the session is disposed");

  // Disposal is idempotent and later questions are inert.
  chat.dispose();
  await chat.ask("Still there?", context());
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.disposeCalls, 1);
});

test("a session created after disposal is stopped rather than adopted", async () => {
  const fake = fakeSession(streamed(["never seen"]));
  let resolveCreation: ((session: ReviewChatSession) => void) | undefined;
  const chat = createReviewChat({
    cwd: "/repo",
    createSession: () =>
      new Promise<ReviewChatSession>((resolve) => {
        resolveCreation = resolve;
      }),
  });

  const pending = chat.ask("What calls this?", context());
  await settle();
  chat.dispose();
  resolveCreation?.(fake.session);
  await pending;
  await settle();

  assert.equal(fake.sent.length, 0, "nothing is sent after disposal");
  assert.equal(fake.disposeCalls, 1, "the late session is disposed");
});
