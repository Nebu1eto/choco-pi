/**
 * A Codex-owned main session never gets a text candidate from the manual
 * route (`/compact`, RPC `compact`, extension `ctx.compact()`).
 *
 * Live cause: `manualLanes` listed the selected Codex lane plus the text lane,
 * and `followManual` retried the text lane after the Codex lane refused the
 * cut (`no-legal-cut` before the session's first recorded provider response),
 * so every manual request adopted a `local-reconciled` checkpoint over Codex
 * content. Real SDK session with an `openai-codex` model, the Codex lane
 * replaced by a probe that refuses every cut, no network.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Backend } from "../src/background/contract.ts";
import { getCoordinator, registerBackendFactory } from "../src/background/registry.ts";
import { CODEX_BACKEND_SETTING_ID } from "../src/background/settings.ts";
import type { TextSummarizer } from "../src/background/text-backend.ts";
import registerCompaction from "../src/index.ts";
import {
  CODEX_ELIGIBILITY_SLOT,
  type CodexEligibilityModel,
  mainOwnerKey,
} from "../src/ownership.ts";
import { compactionEntries, createHost, mentions, reply } from "./host-boundary-fixture.ts";

const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-codex-manual-agent-"));
// The Codex package's global config: Codex owns compaction of `openai-codex` models.
await writeFile(
  join(agentDir, "choco-pi-codex.json"),
  JSON.stringify({ compaction: { responsesCompaction: true } }),
);
process.env["PI_CODING_AGENT_DIR"] = agentDir;
test.after(async () => {
  if (previousAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const codexAttempts: string[] = [];
const codexFactory = { calls: 0 };
// First-wins registration: the probe replaces the real Codex lane for this process.
registerBackendFactory(CODEX_BACKEND_SETTING_ID, () => {
  codexFactory.calls += 1;
  const probe: Backend = {
    id: CODEX_BACKEND_SETTING_ID,
    capability: async () => ({ supported: true }),
    isLegalCut: () => {
      codexAttempts.push("isLegalCut");
      return { legal: false, reason: "no-legal-cut", detail: "no_state" };
    },
    prepare: async () => {
      codexAttempts.push("prepare");
      return { ok: false, reason: "no-legal-cut", retryable: false, detail: "no_state" };
    },
  };
  return probe;
});

interface Rig {
  readonly textCalls: string[];
  readonly notices: string[];
  ctx: ExtensionContext | undefined;
}

interface SessionHolder {
  session: AgentSession | undefined;
}

interface SettledHolder {
  ctx: ExtensionContext | undefined;
}

function rigExtension(rig: Rig, settingsFile: string) {
  return (pi: ExtensionAPI): void => {
    pi.on("session_start", (_event, ctx) => {
      rig.ctx = ctx;
      ctx.ui.notify = (message) => {
        rig.notices.push(message);
      };
    });
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
      background: {
        settingsPaths: () => [settingsFile],
        createTextSummarizer: (model: Model<Api>): TextSummarizer => ({
          scope: { provider: model.provider, model: model.id, baseUrl: model.baseUrl },
          summarize: async (request) => {
            rig.textCalls.push(request.promptText);
            throw new Error("a Codex-owned session must never be summarized on the text lane");
          },
        }),
      },
    });
  };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 5));
}

for (const instructions of [undefined, "focus on the plan"]) {
  test(`a Codex-owned main session's manual compaction never uses the text lane (instructions: ${String(instructions)})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "choco-pi-codex-manual-"));
    const settingsFile = join(dir, "background-compaction.json");
    await writeFile(
      settingsFile,
      JSON.stringify({ enabled: true, text: true, codexNative: true, anthropicNative: false }),
    );
    codexAttempts.length = 0;
    const rig: Rig = { textCalls: [], notices: [], ctx: undefined };
    const host = await createHost({
      dir,
      modelIdentity: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna" },
      respond: async (index) => reply(`R${index}`),
      extensions: [rigExtension(rig, settingsFile)],
    });
    try {
      const ownerKey = mainOwnerKey(host.manager.getSessionId());
      await host.session.prompt("CODEX-MAIN-GO");
      assert.ok(getCoordinator(ownerKey), "the main owner has a coordinator");
      // The programmatic route model-context-cap takes (`ctx.compact()` once idle).
      await host.session.compact(instructions);
      await settle();
      // Still inside the settling window (no prompt since the run ended): the host
      // compaction runs at the next prompt's input hook, before that prompt's request.
      assert.equal(compactionEntries(host.manager.getBranch()).length, 0, "deferred");
      await host.session.prompt("CODEX-MAIN-NEXT");
      assert.deepEqual(rig.textCalls, [], "no text preparation for a Codex-owned session");
      const candidates = host.manager
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "choco-compaction-candidate",
        );
      assert.deepEqual(candidates, [], "no candidate record");
      // The host's own compaction ran instead (Codex's foreground handler answers it in pi;
      // without the Codex extension loaded here, Pi's default summarizer stands in).
      assert.ok(host.summarizerCalls.length > 0, "the foreground compaction ran");
      assert.equal(compactionEntries(host.manager.getBranch()).length, 1);
      assert.equal(
        rig.notices.some((notice) => notice.includes("continuing in the background")),
        false,
        "the manual route did not take the request over",
      );
    } finally {
      await host.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
/** Publish a Codex eligibility slot answering `native` for every Codex model; returns the models asked. */
function installEligibility(native: boolean): string[] {
  const consulted: string[] = [];
  Object.defineProperty(globalThis, CODEX_ELIGIBILITY_SLOT, {
    value: {
      version: 1,
      revision: 0,
      isNativeCompactionOwner: (model: CodexEligibilityModel) => {
        consulted.push(`${model.provider}/${model.id}`);
        return native && model.provider === "openai-codex";
      },
      subscribe: () => () => undefined,
    },
    configurable: true,
  });
  return consulted;
}

test("with no sidecar the derived default binds the Codex lane through the eligibility slot; manual compaction still never uses text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-codex-derived-"));
  // No sidecar anywhere: the lanes derive from Codex's `responsesCompaction: true` (agent dir above).
  const absentSidecar = join(dir, "absent-background-compaction.json");
  const consulted = installEligibility(true);
  codexAttempts.length = 0;
  const factoryCallsBefore = codexFactory.calls;
  const rig: Rig = { textCalls: [], notices: [], ctx: undefined };
  const host = await createHost({
    dir,
    contextWindow: 100_000,
    modelIdentity: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna" },
    // Over the default prepareAt (0.7): the owner requests its selected lane at the turn end.
    respond: async (index) => reply(`R${index}`, { usageInput: 90_000 }),
    extensions: [rigExtension(rig, absentSidecar)],
  });
  try {
    const ownerKey = mainOwnerKey(host.manager.getSessionId());
    await host.session.prompt("CODEX-DERIVED-GO");
    assert.ok(getCoordinator(ownerKey), "the derived defaults enabled the background owner");
    const deadline = Date.now() + 3_000;
    while (codexAttempts.length === 0 && Date.now() < deadline) await settle();
    assert.ok(consulted.includes("openai-codex/gpt-6-luna"), "ownership asked the slot");
    assert.ok(codexFactory.calls > factoryCallsBefore, "the Codex lane was resolved");
    assert.ok(
      codexAttempts.includes("isLegalCut"),
      `the threshold request went to the Codex lane: ${JSON.stringify(getCoordinator(ownerKey)?.status())}`,
    );
    assert.equal(getCoordinator(ownerKey)?.status().backendId, CODEX_BACKEND_SETTING_ID);
    await host.session.compact();
    await settle();
    await host.session.prompt("CODEX-DERIVED-NEXT");
    assert.deepEqual(rig.textCalls, [], "the text lane never ran for the Codex-owned session");
  } finally {
    Reflect.deleteProperty(globalThis, CODEX_ELIGIBILITY_SLOT);
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("control: the slot, not the snapshot, decides; an ineligible slot keeps the Codex lane unselected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-codex-derived-off-"));
  // The snapshot (agent dir) still says `responsesCompaction: true`; the slot says no.
  const consulted = installEligibility(false);
  codexAttempts.length = 0;
  const rig: Rig = { textCalls: [], notices: [], ctx: undefined };
  const host = await createHost({
    dir,
    contextWindow: 100_000,
    modelIdentity: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna" },
    respond: async (index) => reply(`R${index}`, { usageInput: 90_000 }),
    extensions: [rigExtension(rig, join(dir, "absent-background-compaction.json"))],
  });
  try {
    const ownerKey = mainOwnerKey(host.manager.getSessionId());
    await host.session.prompt("CODEX-DERIVED-OFF-GO");
    const deadline = Date.now() + 3_000;
    while (rig.textCalls.length === 0 && Date.now() < deadline) await settle();
    assert.ok(consulted.includes("openai-codex/gpt-6-luna"));
    assert.deepEqual(codexAttempts, [], "the Codex lane was not selected");
    assert.equal(getCoordinator(ownerKey)?.status().backendId, "text");
  } finally {
    Reflect.deleteProperty(globalThis, CODEX_ELIGIBILITY_SLOT);
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

// The cap's handler runs after this extension's own agent_settled handler (the wrapped
// emission context) or before it (the agent_end window): both must defer.
for (const capOrder of ["after", "before"] as const) {
  test(`a prompt deferred during agent_settled is not lost to a context-cap compaction (cap loads ${capOrder})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "choco-pi-codex-settled-"));
    const settingsFile = join(dir, "background-compaction.json");
    await writeFile(
      settingsFile,
      JSON.stringify({ enabled: true, text: true, codexNative: true, anthropicNative: false }),
    );
    const rig: Rig = { textCalls: [], notices: [], ctx: undefined };
    const holder: SessionHolder = { session: undefined };
    const preflight: string[] = [];
    let deferredPrompt: Promise<void> | undefined;
    let deferredFailure: unknown;
    let compactions = 0;
    let capSettled: string | undefined;
    // Stands in for Codex's remote compaction (it took ~2.7 s live).
    const slowForeground = (pi: ExtensionAPI): void => {
      pi.on("session_before_compact", async () => {
        compactions += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return undefined;
      });
    };
    // model-context-cap's agent_settled `ctx.compact()`, then the RPC driver's next
    // prompt arriving while agent_settled is still being emitted (Pi defers it).
    const contextCapAndDriver = (pi: ExtensionAPI): void => {
      pi.on("agent_settled", (_event, ctx) => {
        const session = holder.session;
        if (session === undefined || deferredPrompt !== undefined) return;
        ctx.compact({
          onComplete: () => {
            capSettled = "complete";
          },
          onError: (error) => {
            capSettled = `error: ${error.message}`;
          },
        });
        deferredPrompt = session
          .prompt("NEXT-PROMPT", {
            source: "rpc",
            preflightResult: (disposition) => {
              preflight.push(disposition);
            },
          })
          .catch((cause: unknown) => {
            deferredFailure = cause;
          });
      });
      // Other agent_settled handlers (task lineage, status) keep the emission open
      // long enough for the host compaction to start inside it, as it did live.
      pi.on("agent_settled", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    const host = await createHost({
      dir,
      modelIdentity: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna" },
      respond: async (index) => reply(`R${index}`),
      extensions:
        capOrder === "after"
          ? [rigExtension(rig, settingsFile), slowForeground, contextCapAndDriver]
          : [contextCapAndDriver, rigExtension(rig, settingsFile), slowForeground],
    });
    holder.session = host.session;
    let firstFailure: unknown;
    try {
      // A deferred prompt's failure surfaces on the run that emitted agent_settled.
      await host.session.prompt("FIRST").catch((cause: unknown) => {
        firstFailure = cause;
      });
      const deadline = Date.now() + 3_000;
      while (preflight.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(
        firstFailure,
        undefined,
        "no deferred-prompt failure leaked into the settled run",
      );
      assert.deepEqual(preflight.length, 1, "the deferred prompt reached preflight");
      await deferredPrompt;
      assert.equal(deferredFailure, undefined);
      await host.session.waitForIdle();
      assert.equal(compactions, 1, "the context-cap compaction ran once");
      assert.equal(capSettled, "complete", "the cap's callback was answered (handled at request)");
      assert.equal(compactionEntries(host.manager.getBranch()).length, 1);
      const next = host.calls.findIndex((call) => JSON.stringify(call).includes("NEXT-PROMPT"));
      assert.ok(next >= 0, "the deferred prompt reached the provider");
      assert.deepEqual(rig.textCalls, []);
    } finally {
      await host.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
async function withCountingHost(
  extra: (pi: ExtensionAPI) => void,
  run: (
    host: Awaited<ReturnType<typeof createHost>>,
    counts: { compactions: number },
  ) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-codex-window-"));
  const settingsFile = join(dir, "background-compaction.json");
  await writeFile(
    settingsFile,
    JSON.stringify({ enabled: true, text: true, codexNative: true, anthropicNative: false }),
  );
  const counts = { compactions: 0 };
  const counting = (pi: ExtensionAPI): void => {
    pi.on("session_before_compact", () => {
      counts.compactions += 1;
      return undefined;
    });
  };
  const rig: Rig = { textCalls: [], notices: [], ctx: undefined };
  const host = await createHost({
    dir,
    modelIdentity: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna" },
    respond: async (index) => reply(`R${index}`),
    // Loaded after the compaction extension: its agent_settled ctx is the wrapped one.
    extensions: [rigExtension(rig, settingsFile), counting, extra],
  });
  try {
    await run(host, counts);
    assert.deepEqual(rig.textCalls, []);
  } finally {
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Resolve with the outcome of a ctx.compact(), or "pending" when it did not settle in time. */
function compactOutcome(ctx: ExtensionContext): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("pending"), 1_000);
    ctx.compact({
      onComplete: () => {
        clearTimeout(timer);
        resolve("complete");
      },
      onError: (error) => {
        clearTimeout(timer);
        resolve(`error: ${error.message}`);
      },
    });
  });
}

test("an idle RPC compact after a run settled is answered now and applied at the next prompt", async () => {
  await withCountingHost(
    () => undefined,
    async (host, counts) => {
      await host.session.prompt("FIRST");
      await host.session.waitForIdle();
      // Public events cannot tell this apart from a late agent_settled handler's
      // ctx.compact(): the window is open until the next input or turn_start.
      const answered = await host.session.compact();
      assert.equal(answered, undefined, "answered at once as handled");
      assert.equal(counts.compactions, 0, "not run yet");
      const calls = host.calls.length;
      await host.session.prompt("AFTER-RPC-COMPACT");
      assert.equal(counts.compactions, 1, "applied at the next prompt");
      assert.equal(compactionEntries(host.manager.getBranch()).length, 1);
      const next = host.calls.slice(calls).find((call) => mentions(call, "AFTER-RPC-COMPACT"));
      assert.ok(next && mentions(next, "HOST-SUMMARY"), "the prompt was sent after the compaction");
    },
  );
});

test("deferred requests are answered when made; a newer one supersedes an older one", async () => {
  const settled: SettledHolder = { ctx: undefined };
  const outcomes: string[] = [];
  await withCountingHost(
    (pi) => {
      pi.on("agent_settled", (_event, ctx) => {
        settled.ctx ??= ctx;
      });
    },
    async (host, counts) => {
      await host.session.prompt("FIRST");
      assert.ok(settled.ctx);
      for (const label of ["first", "second"]) {
        settled.ctx.compact({
          onComplete: () => outcomes.push(`${label}: complete`),
          onError: (error) => outcomes.push(`${label}: ${error.message}`),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The bridge answers each request as handled at once (Pi's ctx.compact() then
      // calls onComplete with no result), before it runs; a superseded one never runs.
      assert.deepEqual(outcomes, ["first: complete", "second: complete"]);
      assert.equal(counts.compactions, 0);
      await host.session.prompt("NEXT");
      assert.equal(counts.compactions, 1, "only the newest request ran");
    },
  );
});

test("the settling window is closed by the next input: a retained settled ctx compacts at once", async () => {
  const settled: SettledHolder = { ctx: undefined };
  let probe: Promise<string> | undefined;
  await withCountingHost(
    (pi) => {
      pi.on("agent_settled", (_event, ctx) => {
        settled.ctx ??= ctx;
      });
      pi.on("input", (event) => {
        if (event.text !== "PROBE" || settled.ctx === undefined) return { action: "continue" };
        // This extension's input handler already ran: the wrapped emission is closed.
        probe = compactOutcome(settled.ctx);
        return { action: "handled" };
      });
    },
    async (_host, counts) => {
      await _host.session.prompt("FIRST");
      await _host.session.prompt("PROBE");
      assert.ok(probe);
      assert.equal(await probe, "complete", "not deferred to a later prompt");
      assert.equal(counts.compactions, 1);
    },
  );
});

test("a compact during a run started without input (turn_start) is never deferred", async () => {
  const settled: SettledHolder = { ctx: undefined };
  let probe: Promise<string> | undefined;
  await withCountingHost(
    (pi) => {
      pi.on("agent_settled", (_event, ctx) => {
        settled.ctx ??= ctx;
      });
      pi.on("turn_start", () => {
        if (settled.ctx === undefined || probe !== undefined) return;
        // A run started without any input hook (a custom message): turn_start closed it.
        probe = compactOutcome(settled.ctx);
      });
    },
    async (host, counts) => {
      await host.session.prompt("FIRST");
      await host.session.sendCustomMessage(
        { customType: "probe", content: "CUSTOM-TURN", display: false },
        { triggerTurn: true },
      );
      await host.session.waitForIdle();
      assert.ok(probe);
      assert.equal(await probe, "complete", "not deferred to a later prompt");
      assert.equal(counts.compactions, 1);
    },
  );
});
