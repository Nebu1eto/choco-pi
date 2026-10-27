import assert from "node:assert/strict";
import test from "node:test";
import {
  executeAct,
  executeFind,
  executeObserve,
  shutdownComputerUseSession,
  type ActParams,
  type UiAction,
} from "../src/bridge.ts";
import { isString, type JsonObject } from "../src/json.ts";
import { createTestExtensionContext } from "./helpers/extension-context.ts";
import {
  isConnectedProbe,
  nodeObjectId,
  replaceWithForbiddenBackend,
  startFakeCdp,
  type FakeCdp,
  type FakeCdpCommand,
  type FakeCdpOptions,
} from "./helpers/fake-cdp.ts";

// Outline refs of this tree: @e2 button "Go" (backend 11), @e3 textbox "Name"
// (12), @e4 heading "Title" (in the outline, not actionable), @e5 link "Next" (14).
const AX_NODES: JsonObject[] = [
  {
    nodeId: "1",
    role: { value: "RootWebArea" },
    name: { value: "Fixture" },
    childIds: ["2", "3", "4", "5"],
  },
  {
    nodeId: "2",
    parentId: "1",
    role: { value: "button" },
    name: { value: "Go" },
    backendDOMNodeId: 11,
  },
  {
    nodeId: "3",
    parentId: "1",
    role: { value: "textbox" },
    name: { value: "Name" },
    backendDOMNodeId: 12,
  },
  {
    nodeId: "4",
    parentId: "1",
    role: { value: "heading" },
    name: { value: "Title" },
    backendDOMNodeId: 13,
  },
  {
    nodeId: "5",
    parentId: "1",
    role: { value: "link" },
    name: { value: "Next" },
    backendDOMNodeId: 14,
  },
];

type ActResult = Awaited<ReturnType<typeof executeAct>>;

interface Browser {
  fake: FakeCdp;
  observe(): Promise<string>;
  act(
    stateId: string,
    actions: UiAction[],
    extra?: Omit<ActParams, "stateId" | "actions">,
    signal?: AbortSignal,
  ): Promise<ActResult>;
}

async function withBrowser(
  options: FakeCdpOptions,
  run: (browser: Browser) => Promise<void>,
): Promise<void> {
  const restoreBackend = replaceWithForbiddenBackend();
  const fake = await startFakeCdp({ viewport: [800, 600], axNodes: AX_NODES, ...options });
  try {
    const ctx = await createTestExtensionContext(process.cwd());
    const roots = await executeFind("find", { kind: "browser_page" }, undefined, undefined, ctx);
    const root = roots.details?.windows[0]?.windowRef;
    assert.ok(root);
    await run({
      fake,
      async observe() {
        const result = await executeObserve(
          "observe",
          { root, mode: "semantic" },
          undefined,
          undefined,
          ctx,
        );
        if (!result.details || !("stateId" in result.details) || !isString(result.details.stateId))
          throw new Error("Missing browser state");
        return result.details.stateId;
      },
      async act(stateId, actions, extra = {}, signal) {
        return await executeAct("act", { stateId, actions, ...extra }, signal, undefined, ctx);
      },
    });
  } finally {
    await shutdownComputerUseSession();
    await fake.close();
    restoreBackend();
  }
}

/** A browser act_ui result (successor or terminal). */
function browserDetails(result: ActResult) {
  const details = result.details;
  assert.ok(details && "kind" in details && details.kind === "browser_page", "browser details");
  return details;
}

/** A browser act_ui result with a successor state. */
function successor(result: ActResult) {
  const details = browserDetails(result);
  assert.ok("stateId" in details, "a successor state");
  return details;
}

function resultText(result: ActResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function insertedTexts(commands: FakeCdpCommand[]): string[] {
  return commands
    .filter((command) => command.method === "Input.insertText")
    .map((command) => (isString(command.params.text) ? command.params.text : ""));
}

/** The stateId is still current: a following act on it is accepted and delivered. */
async function assertUsable(browser: Browser, stateId: string): Promise<void> {
  const start = browser.fake.commands.length;
  await browser.act(stateId, [{ action: "typeText", text: "still-usable" }]);
  assert.deepEqual(insertedTexts(browser.fake.commands.slice(start)), ["still-usable"]);
}

/** The stateId was invalidated: the next act is refused before delivery. */
async function assertStale(browser: Browser, stateId: string): Promise<void> {
  const start = browser.fake.commands.length;
  await assert.rejects(
    browser.act(stateId, [{ action: "typeText", text: "stale" }]),
    (error: Error) =>
      error.message.includes("observation_refresh_required") && error.message.includes('"stale"'),
  );
  assert.deepEqual(browser.fake.inputCommands(start), []);
}

/** An assert.rejects validator that matches the error message itself. */
function messageMatches(pattern: RegExp): (error: Error) => boolean {
  return (error) => {
    assert.match(error.message, pattern);
    return true;
  };
}

const NOTHING_SENT = /^act_ui action (\d+) \((\w+)\): .* Nothing was sent\.$/s;

test("browser batches are validated before anything is sent and keep the state usable", async () => {
  await withBrowser({}, async (browser) => {
    const cases: Array<{ actions: UiAction[]; message: RegExp }> = [
      {
        actions: [
          { action: "typeText", text: "a" },
          { action: "press", ref: "@e4" },
        ],
        message:
          /^act_ui action 2 \(press\): Browser press ref '@e4' is in state \S+ but is not an actionable control/,
      },
      {
        actions: [
          { action: "typeText", text: "a" },
          { action: "click", ref: "@e99" },
        ],
        message: /^act_ui action 2 \(click\): Browser click ref '@e99' is not in state /,
      },
      {
        actions: [
          { action: "typeText", text: "a" },
          { action: "click", ref: "@e2", button: "right" },
        ],
        message: /^act_ui action 2 \(click\): Browser ref clicks support only the left button/,
      },
      {
        actions: [
          { action: "typeText", text: "a" },
          { action: "moveMouse", ref: "@e2" },
        ],
        message: /^act_ui action 2 \(moveMouse\): Browser moveMouse takes x and y only/,
      },
      {
        actions: [
          { action: "typeText", text: "a" },
          { action: "scroll", x: 10, y: 10, scrollY: 50 },
        ],
        message: /^act_ui action 2 \(scroll\): Browser scroll does not take x\/y/,
      },
      {
        actions: [
          { action: "typeText", text: "a" },
          { action: "keypress", keys: ["option", "right"] },
        ],
        message:
          /^act_ui action 2 \(keypress\): Browser keypress cannot send "right": browser pages take DOM key values/,
      },
      {
        actions: [
          { action: "typeText", text: "a" },
          { action: "keypress", keys: ["cmd+a"] },
        ],
        message: /^act_ui action 2 \(keypress\): Browser keypress cannot send "cmd\+a"/,
      },
      {
        actions: [
          { action: "typeText", text: "a" },
          { action: "keypress", keys: ["cmd", "Shift"] },
        ],
        message:
          /^act_ui action 2 \(keypress\): Browser keypress keys \["cmd","Shift"\] are only modifiers/,
      },
      {
        actions: [
          { action: "typeText", text: "a" },
          { action: "click", x: 800, y: 10 },
        ],
        message:
          /^act_ui action 2 \(click\): click \(800, 10\) is outside the page viewport, 800x600 CSS pixels/,
      },
      {
        actions: [
          { action: "typeText", text: "a" },
          {
            action: "drag",
            path: [
              { x: 10, y: 10 },
              { x: 10, y: -1 },
            ],
          },
        ],
        message: /^act_ui action 2 \(drag\): Drag point 2 \(10, -1\) is outside the page viewport/,
      },
      {
        actions: [
          { action: "typeText", text: "a" },
          {
            action: "drag",
            path: [
              { x: 10, y: 10 },
              { x: Number.NaN, y: 5 },
            ],
          },
        ],
        message: /^act_ui action 2 \(drag\): Drag point 2 requires finite x and y coordinates/,
      },
      {
        actions: [
          { action: "typeText", text: "a" },
          { action: "moveMouse", x: 5, y: 700 },
        ],
        message:
          /^act_ui action 2 \(moveMouse\): moveMouse \(5, 700\) is outside the page viewport/,
      },
    ];
    for (const { actions, message } of cases) {
      const stateId = await browser.observe();
      const start = browser.fake.commands.length;
      await assert.rejects(browser.act(stateId, actions), (error: Error) => {
        assert.match(error.message, message);
        assert.match(error.message, NOTHING_SENT);
        return true;
      });
      assert.deepEqual(browser.fake.inputCommands(start), [], "nothing was sent");
      await assertUsable(browser, stateId);
    }
    // A single action keeps its original message.
    const stateId = await browser.observe();
    await assert.rejects(
      browser.act(stateId, [{ action: "moveMouse", ref: "@e2" }]),
      messageMatches(
        /^Browser moveMouse takes x and y only; browser outlines carry no element coordinates\.$/,
      ),
    );
    await assertUsable(browser, stateId);
  });
});

test("browser coordinates are not bounds-checked when the state recorded no viewport", async () => {
  await withBrowser({ viewport: undefined }, async (browser) => {
    const stateId = await browser.observe();
    const start = browser.fake.commands.length;
    const result = await browser.act(stateId, [{ action: "click", x: 5000, y: 5000 }]);
    assert.equal(successor(result).execution?.steps?.length, 1);
    assert.deepEqual(
      browser.fake.inputCommands(start).map((command) => command.params.type),
      ["mousePressed", "mouseReleased"],
    );
  });
});

test("the read-only preflight refuses stale refs and a missing page before sending", async () => {
  await withBrowser({}, async (browser) => {
    let stateId = await browser.observe();
    browser.fake.respond = (command) =>
      command.method === "DOM.resolveNode" && command.params.backendNodeId === 12
        ? { error: "No node with given id found" }
        : undefined;
    let start = browser.fake.commands.length;
    await assert.rejects(
      browser.act(stateId, [
        { action: "press", ref: "@e2" },
        { action: "setText", ref: "@e3", text: "x" },
      ]),
      messageMatches(
        /^act_ui action 2 \(setText\): Ref '@e3' no longer resolves to an element on the page; .* Nothing was sent\.$/,
      ),
    );
    assert.deepEqual(browser.fake.inputCommands(start), []);
    assert.ok(
      browser.fake.commands
        .slice(start)
        .some((command) => command.method === "Runtime.releaseObjectGroup"),
      "preflight handles are released",
    );
    browser.fake.respond = undefined;
    await assertUsable(browser, stateId);

    stateId = await browser.observe();
    browser.fake.pages = [];
    start = browser.fake.commands.length;
    await assert.rejects(
      browser.act(stateId, [{ action: "typeText", text: "x" }]),
      messageMatches(/^The browser page of state \S+ is no longer available\. Nothing was sent\./),
    );
    assert.equal(browser.fake.commands.length, start, "no CDP connection was opened");
    browser.fake.pages = [{ id: "fixture", title: "Fixture", url: "about:blank" }];
    await assertUsable(browser, stateId);

    // An abort during the preflight sends nothing and leaves the state current.
    stateId = await browser.observe();
    const controller = new AbortController();
    browser.fake.hold = (command) => {
      if (command.method !== "DOM.resolveNode") return false;
      queueMicrotask(() => controller.abort());
      return true;
    };
    start = browser.fake.commands.length;
    await assert.rejects(
      browser.act(stateId, [{ action: "press", ref: "@e2" }], {}, controller.signal),
      /abort/i,
    );
    browser.fake.hold = undefined;
    assert.deepEqual(browser.fake.inputCommands(start), []);
    await assertUsable(browser, stateId);
  });
});

test("a mid-batch failure returns a partial successor and invalidates the base state", async () => {
  await withBrowser({}, async (browser) => {
    const stateId = await browser.observe();
    // The preflight resolves node 12; the delivery-time resolve fails.
    let resolves = 0;
    browser.fake.respond = (command) => {
      if (command.method !== "DOM.resolveNode" || command.params.backendNodeId !== 12)
        return undefined;
      resolves += 1;
      return resolves === 1 ? undefined : { error: "No node with given id found" };
    };
    const start = browser.fake.commands.length;
    const result = await browser.act(stateId, [
      { action: "press", ref: "@e2" },
      { action: "setText", ref: "@e3", text: "x" },
      { action: "typeText", text: "late" },
    ]);
    const details = successor(result);
    assert.equal(details.status, "partial");
    assert.notEqual(details.stateId, stateId);
    assert.equal(details.baseStateId, stateId);
    const execution = details.execution;
    assert.ok(execution);
    assert.equal(execution.strategy, "cdp_act");
    assert.equal(execution.stoppedAt, 1);
    assert.equal(execution.actionCount, 2);
    assert.equal(execution.outcome, "didnt");
    assert.deepEqual(
      execution.steps?.map((step) => step.outcome),
      ["unknown", "didnt"],
    );
    assert.deepEqual(execution.steps?.[1]?.error, {
      code: "cdp_failed",
      message: "CDP error: No node with given id found",
      effectPossible: false,
    });
    assert.deepEqual(execution.error, execution.steps?.[1]?.error);
    assert.match(
      resultText(result),
      /^act_ui stopped at action 2 \(setText\) in "Fixture": CDP error: No node with given id found\. Action 1 was delivered; action 2 \(setText\) delivered nothing; later actions were not sent\. Returned state [0-9a-f-]{36}\./,
    );
    assert.deepEqual(
      insertedTexts(browser.fake.commands.slice(start)),
      [],
      "later actions were not sent",
    );
    browser.fake.respond = undefined;
    await assertStale(browser, stateId);
    await assertUsable(browser, details.stateId);
  });
});

test("a failure after input was sent is reported as a possible effect", async () => {
  await withBrowser({}, async (browser) => {
    // A protocol error on keyDown: the key-up still goes out.
    let stateId = await browser.observe();
    browser.fake.respond = (command) =>
      command.method === "Input.dispatchKeyEvent" && command.params.type === "keyDown"
        ? { error: "Internal error" }
        : undefined;
    let start = browser.fake.commands.length;
    let result = await browser.act(stateId, [
      { action: "typeText", text: "a" },
      { action: "keypress", keys: ["Enter"] },
    ]);
    let execution = successor(result).execution;
    assert.equal(successor(result).status, "partial");
    assert.deepEqual(execution?.steps?.[1]?.error, {
      code: "cdp_failed",
      message: "CDP error: Internal error",
      effectPossible: true,
    });
    assert.equal(execution?.steps?.[1]?.outcome, "unknown");
    assert.match(resultText(result), /action 2 \(keypress\) may have reached the page;/);
    assert.deepEqual(
      browser.fake.inputCommands(start).map((command) => command.params.type ?? command.method),
      ["Input.insertText", "keyDown", "keyUp"],
    );
    await assertStale(browser, stateId);

    // The connection closes after the text was sent.
    stateId = await browser.observe();
    browser.fake.respond = (command) =>
      command.method === "Input.insertText" && command.params.text === "boom" ? "close" : undefined;
    result = await browser.act(stateId, [
      { action: "press", ref: "@e2" },
      { action: "typeText", text: "boom" },
    ]);
    execution = successor(result).execution;
    assert.equal(successor(result).status, "partial");
    assert.deepEqual(execution?.steps?.[1]?.error, {
      code: "cdp_failed",
      message: "CDP connection closed.",
      effectPossible: true,
    });

    // A page script that throws is a failed step, not a delivered one.
    stateId = await browser.observe();
    browser.fake.respond = (command) =>
      command.method === "Runtime.callFunctionOn" &&
      isString(command.params.functionDeclaration) &&
      command.params.functionDeclaration.includes("this.click()")
        ? {
            result: {
              result: { type: "object" },
              exceptionDetails: {
                text: "Uncaught",
                exception: { description: "TypeError: boom\n    at <anonymous>" },
              },
            },
          }
        : undefined;
    start = browser.fake.commands.length;
    result = await browser.act(stateId, [
      { action: "typeText", text: "a" },
      { action: "click", ref: "@e5" },
      { action: "typeText", text: "never" },
    ]);
    execution = successor(result).execution;
    assert.deepEqual(execution?.steps?.[1]?.error, {
      code: "page_script_exception",
      message: "Page script threw: TypeError: boom",
      effectPossible: true,
    });
    assert.deepEqual(insertedTexts(browser.fake.commands.slice(start)), ["a"]);
    browser.fake.respond = undefined;
  });
});

test("a failure of the first action still rejects the call and invalidates the base state", async () => {
  await withBrowser({}, async (browser) => {
    const stateId = await browser.observe();
    let resolves = 0;
    browser.fake.respond = (command) => {
      if (command.method !== "DOM.resolveNode") return undefined;
      resolves += 1;
      return resolves === 1 ? undefined : { error: "No node with given id found" };
    };
    await assert.rejects(
      browser.act(stateId, [
        { action: "setText", ref: "@e3", text: "x" },
        { action: "typeText", text: "late" },
      ]),
      messageMatches(/^CDP error: No node with given id found$/),
    );
    browser.fake.respond = undefined;
    assert.deepEqual(insertedTexts(browser.fake.commands), []);
    await assertStale(browser, stateId);
  });
});

test("a page that disappears mid-batch gives target_closed without a successor", async () => {
  await withBrowser({}, async (browser) => {
    const stateId = await browser.observe();
    browser.fake.respond = (command) => {
      if (command.method === "Input.insertText" && command.params.text === "b")
        browser.fake.pages = [];
      return undefined;
    };
    const result = await browser.act(stateId, [
      { action: "typeText", text: "a" },
      { action: "typeText", text: "b" },
      { action: "typeText", text: "c" },
    ]);
    const details = browserDetails(result);
    assert.ok(!("stateId" in details), "no successor state");
    assert.equal(details.status, "target_closed");
    assert.equal(details.baseStateId, stateId);
    assert.equal(details.execution.stoppedAt, 2);
    assert.deepEqual(
      details.execution.steps?.map((step) => step.outcome),
      ["unknown", "unknown", "didnt"],
    );
    assert.equal(details.execution.steps?.[2]?.error?.code, "browser_page_unavailable");
    assert.deepEqual(insertedTexts(browser.fake.commands), ["a", "b"]);
    assert.match(
      resultText(result),
      /^act_ui stopped at action 3 \(typeText\) in "Fixture": .* Actions 1-2 were delivered; action 3 \(typeText\) delivered nothing; later actions were not sent\. Then the browser page "Fixture" closed before a successor observation could be captured\.\nNo successor state was created\./,
    );
  });
});

test("an unobservable page after delivery gives post_action_observation_failed", async () => {
  await withBrowser({}, async (browser) => {
    const stateId = await browser.observe();
    browser.fake.respond = (command) => {
      if (command.method === "Input.insertText") browser.fake.listBroken = true;
      return undefined;
    };
    const result = await browser.act(stateId, [{ action: "typeText", text: "a" }]);
    browser.fake.listBroken = false;
    browser.fake.respond = undefined;
    const details = browserDetails(result);
    assert.equal(details.status, "post_action_observation_failed");
    assert.ok(!("stateId" in details));
    assert.deepEqual(
      details.execution.steps?.map((step) => step.outcome),
      ["unknown"],
    );
    assert.match(
      resultText(result),
      /^The actions were delivered, and the browser page "Fixture" could not be observed afterward: /,
    );
    await assertStale(browser, stateId);
  });
});

test("browser results carry the step record; a failed postcondition returns a successor", async () => {
  await withBrowser({}, async (browser) => {
    let stateId = await browser.observe();
    let result = await browser.act(stateId, [
      { action: "press", ref: "@e2" },
      { action: "typeText", text: "x" },
    ]);
    let details = successor(result);
    assert.equal(details.status, undefined);
    assert.equal(details.execution?.strategy, "cdp_act");
    assert.equal(details.execution?.outcome, "unknown");
    assert.deepEqual(
      details.execution?.steps?.map((step) => step.outcome),
      ["unknown", "unknown"],
    );

    stateId = details.stateId;
    result = await browser.act(stateId, [{ action: "press", ref: "@e2" }], {
      expect: { text: "Never shown", timeoutMs: 150 },
    });
    details = successor(result);
    assert.notEqual(details.stateId, stateId);
    assert.equal(details.execution?.verification?.status, "failed");
    assert.equal(details.execution?.outcome, "didnt");
    assert.deepEqual(details.execution?.error, {
      code: "postcondition_failed",
      message: "The action was delivered but its postcondition was not satisfied within 150ms.",
    });
    assert.match(
      resultText(result),
      /^The action was delivered but its postcondition was not satisfied within 150ms\. Returned state /,
    );

    result = await browser.act(details.stateId, [{ action: "press", ref: "@e2" }], {
      expect: { text: "Go" },
    });
    assert.equal(successor(result).execution?.verification?.status, "preexisting");
  });
});

test("browser keypress with a ref focuses the node first; keyboard input without ref works in headless mode", async () => {
  await withBrowser({}, async (browser) => {
    let stateId = await browser.observe();
    let start = browser.fake.commands.length;
    await browser.act(stateId, [{ action: "keypress", ref: "@e3", keys: ["shift", "Tab"] }]);
    const sent = browser.fake.inputCommands(start);
    assert.equal(sent[0]?.method, "Runtime.callFunctionOn");
    assert.match(String(sent[0]?.params.functionDeclaration), /this\.focus\(\)/);
    assert.deepEqual(
      sent
        .slice(1)
        .map((command) => [command.params.type, command.params.key, command.params.modifiers]),
      [
        ["keyDown", "Tab", 8],
        ["keyUp", "Tab", 8],
      ],
    );

    // A node that does not take focus gets no keys.
    stateId = await browser.observe();
    browser.fake.respond = (command) =>
      command.method === "Runtime.callFunctionOn" &&
      isString(command.params.functionDeclaration) &&
      command.params.functionDeclaration.includes("this.focus()")
        ? {
            result: {
              result: { type: "object" },
              exceptionDetails: {
                text: "Uncaught",
                exception: { description: "Error: The element did not take keyboard focus." },
              },
            },
          }
        : undefined;
    start = browser.fake.commands.length;
    await assert.rejects(
      browser.act(stateId, [{ action: "keypress", ref: "@e2", keys: ["Enter"] }]),
      messageMatches(/^Page script threw: Error: The element did not take keyboard focus\.$/),
    );
    browser.fake.respond = undefined;
    assert.deepEqual(
      browser.fake.inputCommands(start).map((command) => command.method),
      ["Runtime.callFunctionOn"],
    );

    const previous = process.env.PI_COMPUTER_USE_HEADLESS;
    process.env.PI_COMPUTER_USE_HEADLESS = "1";
    try {
      stateId = await browser.observe();
      start = browser.fake.commands.length;
      await browser.act(stateId, [
        { action: "typeText", text: "headless" },
        { action: "keypress", keys: ["Enter"] },
      ]);
      assert.deepEqual(insertedTexts(browser.fake.commands.slice(start)), ["headless"]);
    } finally {
      if (previous === undefined) delete process.env.PI_COMPUTER_USE_HEADLESS;
      else process.env.PI_COMPUTER_USE_HEADLESS = previous;
    }
  });
});

test("an abort after delivered actions still rejects and invalidates the base state", async () => {
  await withBrowser({}, async (browser) => {
    const stateId = await browser.observe();
    const controller = new AbortController();
    browser.fake.respond = (command) => {
      if (command.method === "Input.insertText" && command.params.text === "a")
        queueMicrotask(() => controller.abort());
      return undefined;
    };
    await assert.rejects(
      browser.act(
        stateId,
        [
          { action: "typeText", text: "a" },
          { action: "typeText", text: "b" },
        ],
        {},
        controller.signal,
      ),
      /abort/i,
    );
    browser.fake.respond = undefined;
    assert.deepEqual(insertedTexts(browser.fake.commands), ["a"]);
    await assertStale(browser, stateId);
  });
});

/** Key events sent from \`start\`: [type, key, code, windowsVirtualKeyCode, text, modifiers]. */
function keyEvents(fake: FakeCdp, start: number) {
  return fake
    .inputCommands(start)
    .filter((command) => command.method === "Input.dispatchKeyEvent")
    .map((command) => [
      command.params.type,
      command.params.key,
      command.params.code,
      command.params.windowsVirtualKeyCode,
      command.params.text,
      command.params.modifiers,
    ]);
}

test("browser keypress sends the virtual key code and code that default editing actions need", async () => {
  await withBrowser({}, async (browser) => {
    const cases: Array<{ keys: string[]; events: unknown[][] }> = [
      {
        keys: ["ArrowLeft"],
        events: [
          ["keyDown", "ArrowLeft", "ArrowLeft", 37, undefined, 0],
          ["keyUp", "ArrowLeft", "ArrowLeft", 37, undefined, 0],
        ],
      },
      {
        keys: ["Backspace"],
        events: [
          ["keyDown", "Backspace", "Backspace", 8, undefined, 0],
          ["keyUp", "Backspace", "Backspace", 8, undefined, 0],
        ],
      },
      {
        keys: ["Enter"],
        events: [
          ["keyDown", "Enter", "Enter", 13, "\r", 0],
          ["keyUp", "Enter", "Enter", 13, undefined, 0],
        ],
      },
      {
        keys: ["shift", "Tab"],
        events: [
          ["keyDown", "Tab", "Tab", 9, undefined, 8],
          ["keyUp", "Tab", "Tab", 9, undefined, 8],
        ],
      },
      {
        keys: ["F5"],
        events: [
          ["keyDown", "F5", "F5", 116, undefined, 0],
          ["keyUp", "F5", "F5", 116, undefined, 0],
        ],
      },
      {
        keys: ["ctrl", "a"],
        events: [
          ["keyDown", "a", "KeyA", 65, undefined, 2],
          ["keyUp", "a", "KeyA", 65, undefined, 2],
        ],
      },
      {
        keys: ["7", " "],
        events: [
          ["keyDown", "7", "Digit7", 55, "7", 0],
          ["keyUp", "7", "Digit7", 55, undefined, 0],
          ["keyDown", " ", "Space", 32, " ", 0],
          ["keyUp", " ", "Space", 32, undefined, 0],
        ],
      },
    ];
    for (const { keys, events } of cases) {
      const stateId = await browser.observe();
      const start = browser.fake.commands.length;
      await browser.act(stateId, [{ action: "keypress", keys }]);
      assert.deepEqual(keyEvents(browser.fake, start), events, JSON.stringify(keys));
    }
  });
});

/** Answers the connectivity probe for \`backendNodeId\` with "removed" once \`detached()\` is true. */
function detachAfter(backendNodeId: number, detached: () => boolean) {
  return (command: FakeCdpCommand) =>
    isConnectedProbe(command) &&
    command.params.objectId === nodeObjectId(backendNodeId) &&
    detached()
      ? { result: { result: { type: "boolean", value: false } } }
      : undefined;
}

/** Whether a command is the page-side click of a ref action. */
function isRefClick(command: FakeCdpCommand): boolean {
  return (
    command.method === "Runtime.callFunctionOn" &&
    isString(command.params.functionDeclaration) &&
    command.params.functionDeclaration.includes("this.click()")
  );
}

test("a ref whose element was removed mid-batch returns partial instead of a silent click", async () => {
  await withBrowser({}, async (browser) => {
    // The first click removes the element; the second click of the same ref
    // must not report success.
    let stateId = await browser.observe();
    let clicks = 0;
    browser.fake.respond = (command) => {
      if (isRefClick(command)) clicks += 1;
      return detachAfter(11, () => clicks >= 1)(command);
    };
    let start = browser.fake.commands.length;
    let result = await browser.act(stateId, [
      { action: "click", ref: "@e2" },
      { action: "click", ref: "@e2" },
      { action: "typeText", text: "after-vanish" },
    ]);
    let details = successor(result);
    assert.equal(details.status, "partial");
    assert.equal(details.execution?.stoppedAt, 1);
    assert.deepEqual(
      details.execution?.steps?.map((step) => step.outcome),
      ["unknown", "didnt"],
    );
    assert.deepEqual(details.execution?.steps?.[1]?.error, {
      code: "element_detached",
      message:
        "The target element is no longer in the page; it was removed after the state was observed.",
      effectPossible: false,
    });
    assert.equal(browser.fake.commands.slice(start).filter(isRefClick).length, 1, "one click sent");
    assert.deepEqual(insertedTexts(browser.fake.commands.slice(start)), []);
    assert.match(
      resultText(result),
      /action 2 \(click\) delivered nothing; later actions were not sent\./,
    );
    await assertStale(browser, stateId);

    // A double press whose element vanishes after its first click may have taken effect.
    stateId = await browser.observe();
    clicks = 0;
    start = browser.fake.commands.length;
    result = await browser.act(stateId, [
      { action: "typeText", text: "a" },
      { action: "press", ref: "@e2", clickCount: 2 },
    ]);
    details = successor(result);
    assert.equal(details.status, "partial");
    assert.deepEqual(details.execution?.steps?.[1]?.error, {
      code: "element_detached",
      message:
        "The target element is no longer in the page; it was removed after the state was observed.",
      effectPossible: true,
    });
    assert.match(resultText(result), /action 2 \(press\) may have reached the page;/);
    browser.fake.respond = undefined;
  });
});

test("the preflight refuses a ref whose element was removed from the page", async () => {
  await withBrowser({}, async (browser) => {
    const stateId = await browser.observe();
    browser.fake.respond = detachAfter(12, () => true);
    const start = browser.fake.commands.length;
    await assert.rejects(
      browser.act(stateId, [
        { action: "typeText", text: "a" },
        { action: "setText", ref: "@e3", text: "x" },
      ]),
      messageMatches(
        /^act_ui action 2 \(setText\): Ref '@e3' no longer resolves to an element on the page; .* Nothing was sent\.$/,
      ),
    );
    assert.deepEqual(browser.fake.inputCommands(start), [], "nothing was sent");
    browser.fake.respond = undefined;
    await assertUsable(browser, stateId);
  });
});
