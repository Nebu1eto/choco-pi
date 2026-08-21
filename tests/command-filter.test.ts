import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import commandFilter from "../.pi/extensions/command-filter.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

type Handler = (event: RuntimeValue, ctx: RuntimeValue) => void;
type AutocompleteFactory = (current: RuntimeValue) => RuntimeValue;

/** Collects what the extension registers, standing in for the host. */
function createPi(handlers: Handler[]) {
  return { on: (_event: string, handler: Handler) => handlers.push(handler) };
}

test("hides internal commands from completion without blocking execution", () => {
  // SAFETY: The fixture supplies every host member exercised by this test.
  const prototype = ExtensionRunner.prototype as any;
  const originalRegistered = prototype.getRegisteredCommands;
  const originalGetCommand = prototype.getCommand;
  const commands = [
    "llama",
    "apex-refresh",
    "codex",
    "synthetic:quotas",
    "lens-health",
    "usage",
  ].map((name) => ({ name, sourceInfo: { path: "test" } }));

  prototype.getRegisteredCommands = () => commands;
  prototype.__chocoPiCommandFilterApplied = false;
  try {
    // SAFETY: The fixture supplies every host member exercised by this test.
    commandFilter(createPi([]) as any);

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

test("hides built-in commands from the editor without blocking execution", async () => {
  const handlers: Handler[] = [];
  const prototype = reinterpretHostValue<Record<string, RuntimeValue>>(ExtensionRunner.prototype);
  const originalApplied = prototype["__chocoPiCommandFilterApplied"];
  prototype["__chocoPiCommandFilterApplied"] = true;
  try {
    // SAFETY: The fixture supplies every host member exercised by this test.
    commandFilter(createPi(handlers) as never);
    assert.equal(handlers.length, 1, "the filter must register a session_start handler");

    let factory: AutocompleteFactory | undefined;
    handlers[0]?.(undefined, {
      mode: "tui",
      ui: { addAutocompleteProvider: (value: AutocompleteFactory) => (factory = value) },
    });
    assert.ok(factory, "a TUI session must receive the wrapper");

    const base = {
      getSuggestions: async () => ({
        items: [
          { value: "model", label: "model" },
          { value: "scoped-models", label: "scoped-models" },
        ],
        prefix: "/mod",
      }),
      applyCompletion: () => ({ lines: ["done"], cursorLine: 0, cursorCol: 0 }),
    };
    // SAFETY: the wrapper returns the provider shape the editor calls, delegating to `base`.
    const wrapped = factory(base) as {
      getSuggestions: () => Promise<{ items: { value: string }[] } | null>;
      applyCompletion: () => { lines: string[] };
    };
    const suggestions = await wrapped.getSuggestions();
    assert.deepEqual(
      suggestions?.items.map((item) => item.value),
      ["model"],
    );
    assert.deepEqual(wrapped.applyCompletion().lines, ["done"], "completion still delegates");

    // A path completion shares the item shape, so only command prefixes filter.
    const paths = {
      ...base,
      getSuggestions: async () => ({ items: [{ value: "scoped-models" }], prefix: "./scoped" }),
    };
    // SAFETY: same wrapper shape, over a provider that answers a path prefix.
    const wrappedPaths = factory(paths) as { getSuggestions: () => Promise<RuntimeValue> };
    assert.deepEqual(await wrappedPaths.getSuggestions(), {
      items: [{ value: "scoped-models" }],
      prefix: "./scoped",
    });
  } finally {
    if (originalApplied === undefined) delete prototype["__chocoPiCommandFilterApplied"];
    else prototype["__chocoPiCommandFilterApplied"] = originalApplied;
  }
});
