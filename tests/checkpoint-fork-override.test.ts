import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fileCheckpoints from "../.pi/extensions/file-checkpoints.ts";
import {
  isFunction,
  reinterpretHostValue,
  type RuntimeValue,
} from "../.pi/extensions/lib/runtime-values.ts";

type ForkSelectorPrototype = {
  showUserMessageSelector: () => void;
  __chocoPiCheckpointPickerApplied?: boolean;
};

const prototype = reinterpretHostValue<ForkSelectorPrototype>(InteractiveMode.prototype);

function stubExtensionApi(commands: Map<string, RuntimeValue>): ExtensionAPI {
  return reinterpretHostValue<ExtensionAPI>({
    on: () => {},
    registerCommand: (name: string, options: RuntimeValue) => commands.set(name, options),
    appendEntry: () => {},
  });
}

test("Pi still exposes the fork selector this extension redirects", () => {
  assert.ok(
    isFunction(
      Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "showUserMessageSelector")?.value,
    ),
    "interactive mode must keep showUserMessageSelector for the /fork override to apply",
  );
});

test("the extension registers /rewind and points Pi's fork selector at it", (t) => {
  const original = prototype.showUserMessageSelector;
  t.after(() => {
    prototype.showUserMessageSelector = original;
    prototype.__chocoPiCheckpointPickerApplied = undefined;
  });

  const commands = new Map<string, RuntimeValue>();
  fileCheckpoints(stubExtensionApi(commands));

  assert.deepEqual([...commands.keys()], ["rewind"]);
  assert.notEqual(prototype.showUserMessageSelector, original);

  const prompts: string[] = [];
  const host = { session: { prompt: async (text: string) => void prompts.push(text) } };
  prototype.showUserMessageSelector.call(host);
  assert.deepEqual(prompts, ["/rewind"]);
});
