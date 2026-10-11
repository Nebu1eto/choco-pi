import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import { registerCodexCommand } from "../src/ui/settings/command.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

type Notice = { message: string; level: string | undefined };

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: The handler reads only cwd, trust, mode, and the notify/custom UI slice supplied here.
  return fixture as T;
}

test("/codex reports settings as a notice in RPC mode instead of opening a terminal screen", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-settings-rpc-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });

  const fixture = await createSdkFixture();
  t.after(() => fixture.session.dispose());
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  // SAFETY: The wrapper inherits the live host API and only replaces command registration.
  const pi = Object.create(fixture.pi) as ExtensionAPI;
  Object.defineProperty(pi, "registerCommand", {
    value(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
      commands.set(name, options);
    },
  });
  const state: AdapterState = {
    enabled: false,
    cwd: process.cwd(),
    promptSkills: [],
    config: structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG),
    executionMode: DEFAULT_CODEX_CONVERSION_CONFIG.executionMode,
    codexTurnState: createCodexTurnState(),
  };
  registerCodexCommand(pi, state);
  const command = commands.get("codex");
  assert.ok(command, "codex command registered");

  const notices: Notice[] = [];
  let customCalls = 0;
  const ctx = partialFixture<ExtensionCommandContext>({
    ...fixture.ctx,
    mode: "rpc",
    hasUI: true,
    ui: {
      ...fixture.ctx.ui,
      notify: (message, level) => {
        notices.push({ message, level });
      },
      custom: () => {
        customCalls++;
        return Promise.reject(new Error("RPC has no terminal components"));
      },
    },
  });

  await command.handler("", ctx);
  assert.equal(customCalls, 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.level, "info");
  assert.match(notices[0]?.message ?? "", /^Codex settings: /);

  await command.handler("openai", ctx);
  assert.equal(customCalls, 0);
  assert.equal(notices.length, 2);
  assert.match(notices[1]?.message ?? "", /^Codex settings: /);
});
