import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import chocoPiHooks from "../src/extension.ts";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each double supplies the members the /add-dir path reads before session start.
  return fixture as T;
}

function registerCommands(): Map<string, CommandOptions> {
  const commands = new Map<string, CommandOptions>();
  chocoPiHooks(
    partialFixture<ExtensionAPI>({
      registerFlag() {},
      registerCommand(name, options) {
        commands.set(name, options);
      },
      registerTool() {},
      registerMarkdownTransformer() {},
      on: () => () => {},
      events: { on: () => () => {}, emit() {} },
    }),
  );
  return commands;
}

test("/add-dir confirms with a notice outside the TUI and stays quiet inside it", async () => {
  const command = registerCommands().get("add-dir");
  assert.ok(command);
  for (const mode of ["tui", "rpc"] as const) {
    const notices: { message: string; level: string | undefined }[] = [];
    const ctx = partialFixture<ExtensionCommandContext>({
      cwd: process.cwd(),
      mode,
      thinkingLevel: "off",
      ui: partialFixture<ExtensionCommandContext["ui"]>({
        notify: (message, level) => {
          notices.push({ message, level });
        },
      }),
    });
    await command.handler("/tmp/extra", ctx);
    assert.deepEqual(
      notices,
      mode === "tui"
        ? []
        : [{ message: "Ran DirectoryAdded hooks for /tmp/extra.", level: "info" }],
    );
  }
});
