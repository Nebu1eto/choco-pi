/**
 * Extension loaded into the Pi process under test by `run.ts` (via `-e`).
 *
 * - Registers a scripted faux model provider, so no request leaves the process
 *   and no model credit is spent. The script is chosen from the first user
 *   message of the transcript: the main session spawns one background
 *   subagent; a "sleep" child runs `bash sleep N` and then answers; a "quota"
 *   child fails with a usage-limit marker and answers after being resumed.
 * - Publishes a fake usage-limit policy in the same global registry shape the
 *   subagents manager reads (`usage-limit-seam.ts`), keyed by the session id.
 * - Registers `/e2e-reload`, which calls `ctx.reload()`.
 * - Appends an observation log (JSONL) the runner uses as mechanics evidence.
 */
import { appendFile } from "node:fs/promises";

import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
  Corroboration,
  UsageLimitClassification,
  UsageLimitClassifyInput,
  UsageLimitPolicy,
} from "../../src/usage-limit-seam.ts";
import {
  CHILD_CONTINUED_TEXT,
  CHILD_DONE_TEXT,
  CHILD_QUOTA,
  CHILD_QUOTA_RESUMED_TEXT,
  CHILD_REVIVED_TEXT,
  CHILD_SLEEP,
  DEFAULT_RESET_MS,
  DEFAULT_SLEEP_S,
  ENV_LOG,
  ENV_RESET_MS,
  ENV_REVIVAL_MARKER,
  ENV_SLEEP_S,
  FAUX_MODEL,
  FAUX_PROVIDER,
  MAIN_ACK_TEXT,
  MAIN_SPAWN_QUOTA,
  MAIN_SPAWN_SLEEP,
  QUOTA_MARKER,
  RELOAD_COMMAND,
} from "./protocol.ts";

const USAGE_LIMIT_POLICY_SYMBOL = Symbol.for("choco-pi.usage-limit-policy");

type LogValue = string | number | boolean | undefined;

const logPath = process.env[ENV_LOG];
let logWrites: Promise<void> = Promise.resolve();

function log(kind: string, details: Record<string, LogValue>): void {
  if (logPath === undefined) return;
  const line = `${JSON.stringify({ at: Date.now(), pid: process.pid, kind, ...details })}\n`;
  logWrites = logWrites
    .then(() => appendFile(logPath, line))
    .catch((error: Error) => {
      process.stderr.write(`e2e-revival log write failed: ${error.message}\n`);
    });
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const resetMs = positiveNumber(process.env[ENV_RESET_MS], DEFAULT_RESET_MS);
const sleepSeconds = positiveNumber(process.env[ENV_SLEEP_S], DEFAULT_SLEEP_S);
/** Line both revival prompt variants share; unset or empty disables revival detection. */
const revivalMarker = process.env[ENV_REVIVAL_MARKER]?.trim() ?? "";

function messageText(message: Message): string {
  if (message.role === "system") return "";
  if (message.role === "assistant") {
    return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  }
  if (message.role === "user") {
    if (Array.isArray(message.content)) {
      return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    }
    return message.content;
  }
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function excerpt(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** Harness-injected context (turn snapshots) is not task input. */
function isSubstantiveUser(message: Message): boolean {
  return (
    message.role === "user" && !messageText(message).trimStart().startsWith("<system-reminder>")
  );
}

/**
 * Decide the scripted reply from the transcript alone, so it survives restarts.
 * "New input" is every substantive user message after the last assistant turn.
 */
function scriptedReply(messages: readonly Message[]): AssistantMessage {
  const turns = messages.filter((message) => message.role !== "system");
  const userTexts = turns.filter((message) => message.role === "user").map(messageText);
  let lastAssistant = -1;
  turns.forEach((message, index) => {
    if (message.role === "assistant") lastAssistant = index;
  });
  const afterAssistant = turns.slice(lastAssistant + 1);
  const newInputs = afterAssistant.filter(isSubstantiveUser).map(messageText);
  const newestInput = newInputs.at(-1) ?? "";

  const isMain = userTexts.some(
    (text) => text.includes(MAIN_SPAWN_SLEEP) || text.includes(MAIN_SPAWN_QUOTA),
  );

  if (!isMain && userTexts.some((text) => text.includes(CHILD_SLEEP))) {
    const followUps = newInputs.filter((text) => !text.includes(CHILD_SLEEP));
    const interruption =
      revivalMarker === "" ? undefined : followUps.find((text) => text.includes(revivalMarker));
    if (interruption !== undefined) {
      log("provider_call", {
        role: "child-sleep",
        action: "revived-answer",
        prompt: excerpt(interruption),
      });
      return fauxAssistantMessage(fauxText(CHILD_REVIVED_TEXT));
    }
    if (afterAssistant.some((message) => message.role === "toolResult")) {
      log("provider_call", { role: "child-sleep", action: "done-answer" });
      return fauxAssistantMessage(fauxText(CHILD_DONE_TEXT));
    }
    if (lastAssistant === -1) {
      log("provider_call", { role: "child-sleep", action: "bash", seconds: sleepSeconds });
      return fauxAssistantMessage(
        fauxToolCall("bash", { command: `sleep ${sleepSeconds}`, timeout: sleepSeconds + 60 }),
      );
    }
    log("provider_call", {
      role: "child-sleep",
      action: "continued-answer",
      prompt: excerpt(followUps.at(-1) ?? ""),
    });
    return fauxAssistantMessage(fauxText(CHILD_CONTINUED_TEXT));
  }

  if (!isMain && userTexts.some((text) => text.includes(CHILD_QUOTA))) {
    const followUps = turns
      .filter(isSubstantiveUser)
      .map(messageText)
      .filter((text) => !text.includes(CHILD_QUOTA));
    if (followUps.length > 0) {
      log("provider_call", {
        role: "child-quota",
        action: "resumed-answer",
        prompt: excerpt(followUps.at(-1) ?? ""),
      });
      return fauxAssistantMessage(fauxText(CHILD_QUOTA_RESUMED_TEXT));
    }
    log("provider_call", { role: "child-quota", action: "quota-error" });
    return fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: `${QUOTA_MARKER}: scripted e2e quota failure`,
    });
  }

  const quota = newestInput.includes(MAIN_SPAWN_QUOTA);
  if (quota || newestInput.includes(MAIN_SPAWN_SLEEP)) {
    log("provider_call", { role: "main", action: "spawn", script: quota ? "quota" : "sleep" });
    return fauxAssistantMessage(
      fauxToolCall("Agent", {
        subagent_type: "general-purpose",
        description: "e2e revival child",
        name: "e2e-child",
        prompt: `${quota ? CHILD_QUOTA : CHILD_SLEEP}: scripted e2e revival task.`,
        run_in_background: true,
        model: `${FAUX_PROVIDER}/${FAUX_MODEL}`,
      }),
    );
  }
  const last = turns.at(-1);
  log("provider_call", {
    role: "main",
    action: "ack",
    lastRole: last?.role,
    prompt: excerpt(last === undefined ? "" : messageText(last)),
  });
  return fauxAssistantMessage(fauxText(MAIN_ACK_TEXT));
}

function fakePolicy(owner: string, generation: number): UsageLimitPolicy {
  const closures = new Map<string, number>();
  return {
    owner,
    generation,
    preference: async () => "auto-resume",
    classify: (input: UsageLimitClassifyInput): UsageLimitClassification | undefined => {
      if (!input.errorMessage.includes(QUOTA_MARKER)) return undefined;
      const resetAt = Date.now() + resetMs;
      log("policy_classify", { owner, resetAt });
      return {
        kind: "quota",
        provider: input.provider,
        modelId: input.modelId,
        resetAt,
        confidence: "parsed",
      };
    },
    corroborate: async (classification: UsageLimitClassification): Promise<Corroboration> => {
      const ready = classification.resetAt !== undefined && Date.now() >= classification.resetAt;
      log("policy_corroborate", { owner, ready, resetAt: classification.resetAt });
      return { ready, classification, evidence: ready ? "capacity" : "confirmed" };
    },
    pickFallback: () => undefined,
    closeProvider: (providerKey: string, accountId: string, untilMs: number) => {
      closures.set(`${providerKey}\u0000${accountId}`, untilMs);
    },
    isClosed: (providerKey: string, accountId: string, now: number = Date.now()) => {
      const until = closures.get(`${providerKey}\u0000${accountId}`);
      return until !== undefined && now < until;
    },
  };
}

function policyRegistry(): Map<string, UsageLimitPolicy> {
  const existing = Object.getOwnPropertyDescriptor(globalThis, USAGE_LIMIT_POLICY_SYMBOL)?.value;
  if (existing instanceof Map) return existing;
  const created = new Map<string, UsageLimitPolicy>();
  Object.defineProperty(globalThis, USAGE_LIMIT_POLICY_SYMBOL, {
    value: created,
    configurable: true,
    writable: true,
  });
  return created;
}

let policyGeneration = 0;

const OBSERVED_EVENTS = [
  "subagents:created",
  "subagents:started",
  "subagents:completed",
  "subagents:failed",
  "subagents:stopped",
  "subagents:usage_limit",
];

export default function e2eRevivalExtension(pi: ExtensionAPI): void {
  const faux = createFauxCore({
    provider: FAUX_PROVIDER,
    api: `${FAUX_PROVIDER}-api`,
    models: [{ id: FAUX_MODEL, contextWindow: 200_000, maxTokens: 8_192 }],
  });
  // One factory per provider call; the transcript, not this queue, carries state.
  faux.setResponses(
    Array.from(
      { length: 2_000 },
      () => (context: { messages: Message[] }) => scriptedReply(context.messages),
    ),
  );
  pi.registerProvider(FAUX_PROVIDER, {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "e2e-inert",
    api: faux.api,
    authHeader: false,
    models: faux.models.map((model) => ({ ...model, name: model.id })),
    streamSimple: faux.streamSimple,
  });

  pi.registerCommand(RELOAD_COMMAND, {
    description: "e2e revival harness: reload the extension runtime",
    handler: async (_args, ctx) => {
      log("reload_command", {});
      await ctx.reload();
    },
  });

  for (const channel of OBSERVED_EVENTS) {
    pi.events.on(channel, (data) => {
      log("event", { channel, data: JSON.stringify(data) });
    });
  }

  let ownedSession: string | undefined;
  let ownedPolicy: UsageLimitPolicy | undefined;

  pi.on("session_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const policy = fakePolicy(sessionId, ++policyGeneration);
    policyRegistry().set(sessionId, policy);
    ownedSession = sessionId;
    ownedPolicy = policy;
    log("session_start", {
      reason: event.reason,
      sessionId,
      sessionFile: ctx.sessionManager.getSessionFile(),
    });
  });

  pi.on("session_shutdown", (event, ctx) => {
    log("session_shutdown", {
      reason: event.reason,
      sessionId: ctx.sessionManager.getSessionId(),
    });
    const registry = policyRegistry();
    if (ownedSession !== undefined && registry.get(ownedSession) === ownedPolicy) {
      registry.delete(ownedSession);
    }
    ownedSession = undefined;
    ownedPolicy = undefined;
  });
}
