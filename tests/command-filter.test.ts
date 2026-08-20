import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import commandFilter from "../.pi/extensions/command-filter.ts";

test("hides internal commands from completion without blocking execution", () => {
  const prototype = ExtensionRunner.prototype as any;
  const originalRegistered = prototype.getRegisteredCommands;
  const originalGetCommand = prototype.getCommand;
  const commands = ["llama", "apex-refresh", "synthetic:quotas", "lens-health", "usage"].map(
    (name) => ({ name, sourceInfo: { path: "test" } }),
  );

  prototype.getRegisteredCommands = () => commands;
  prototype.__chocoPiCommandFilterApplied = false;
  try {
    commandFilter({} as any);

    assert.deepEqual(
      prototype.getRegisteredCommands.call({}).map((command: { name: string }) => command.name),
      ["usage"],
    );
    assert.equal(prototype.getCommand, originalGetCommand);
  } finally {
    prototype.getRegisteredCommands = originalRegistered;
    delete prototype.__chocoPiCommandFilterApplied;
  }
});
