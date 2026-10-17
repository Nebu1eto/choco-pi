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
import { mainOwnerKey } from "../src/ownership.ts";
import { compactionEntries, createHost, reply } from "./host-boundary-fixture.ts";

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
// First-wins registration: the probe replaces the real Codex lane for this process.
registerBackendFactory(CODEX_BACKEND_SETTING_ID, () => {
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
test("a prompt deferred during agent_settled is not lost to a context-cap compaction", async () => {
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
      ctx.compact({});
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
    extensions: [rigExtension(rig, settingsFile), slowForeground, contextCapAndDriver],
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
    assert.equal(firstFailure, undefined, "no deferred-prompt failure leaked into the settled run");
    assert.deepEqual(preflight.length, 1, "the deferred prompt reached preflight");
    await deferredPrompt;
    assert.equal(deferredFailure, undefined);
    await host.session.waitForIdle();
    assert.equal(compactions, 1, "the context-cap compaction ran once");
    assert.equal(compactionEntries(host.manager.getBranch()).length, 1);
    const next = host.calls.findIndex((call) => JSON.stringify(call).includes("NEXT-PROMPT"));
    assert.ok(next >= 0, "the deferred prompt reached the provider");
    assert.deepEqual(rig.textCalls, []);
  } finally {
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
