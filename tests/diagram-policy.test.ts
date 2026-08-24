import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import diagramPolicy, {
  containsDrawnDiagram,
  DIAGRAM_REMINDER,
} from "../.pi/extensions/diagram-policy.ts";

type Handler = (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue;

function createApi() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    api: { on: (event: string, handler: Handler) => handlers.set(event, handler) },
  };
}

// The exact sketch from session 01a03293, which the mermaid rule failed to prevent.
const REAL_VIOLATION = [
  "Topology:",
  "",
  "```",
  "browser :5173  \u2500\u2500/api proxy\u2500\u2500\u25ba  validation-api :22200 \u2500\u2500HTTP\u2500\u2500\u25ba  NovaID :22000",
  "                                    \u2514\u2500\u2500\u2500\u2500\u2500\u2500 same PostgreSQL \u2500\u2500\u2500\u2500\u2500\u2518",
  "```",
].join("\n");

test("the real ASCII sketch from the reported session is caught", () => {
  assert.equal(containsDrawnDiagram(REAL_VIOLATION), true);
});

test("plain ASCII box and arrow art is caught", () => {
  const art = [
    "```",
    "+-----+     +-----+",
    "|  a  | --> |  b  |",
    "+-----+     +-----+",
    "```",
  ].join("\n");
  assert.equal(containsDrawnDiagram(art), true);
});

test("mermaid blocks are the compliant form and never flagged", () => {
  const mermaid = ["```mermaid", "flowchart TD", "  browser --> api", "  api --> db", "```"].join(
    "\n",
  );
  assert.equal(containsDrawnDiagram(mermaid), false);
});

test("prose, tables, and pasted output are not diagrams", () => {
  assert.equal(containsDrawnDiagram("The request goes browser \u2192 api \u2192 db."), false);
  const table = ["| step | port |", "| ---- | ---- |", "| api  | 2200 |"].join("\n");
  assert.equal(containsDrawnDiagram(table), false);
  const tree = [
    "```sh",
    "node_modules",
    "\u251c\u2500\u2500 pi-tui",
    "\u2514\u2500\u2500 typebox",
    "```",
  ].join("\n");
  assert.equal(containsDrawnDiagram(tree), false, "pasted command output stays exempt");
  const diff = ["```diff", "-  old --> path", "+  new --> path", "```"].join("\n");
  assert.equal(containsDrawnDiagram(diff), false);
});

test("a violation arms exactly one reminder on the next request context", () => {
  const { handlers, api } = createApi();
  // SAFETY: the stub implements the single on member this extension uses.
  diagramPolicy(api as never);
  const messageEnd = handlers.get("message_end");
  const context = handlers.get("context");
  assert.ok(messageEnd && context);

  const baseline = context({ messages: [{ role: "user", content: "hi" }] }, {});
  assert.equal(baseline, undefined, "no reminder without a violation");

  messageEnd(
    { message: { role: "assistant", content: [{ type: "text", text: REAL_VIOLATION }] } },
    {},
  );
  // SAFETY: the handler returns the documented { messages } patch once armed.
  const patched = context({ messages: [{ role: "user", content: "hi" }] }, {}) as {
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(patched.messages.length, 2);
  assert.equal(patched.messages[1]?.content, DIAGRAM_REMINDER);
  assert.match(DIAGRAM_REMINDER, /^<system-reminder>/);
  assert.match(DIAGRAM_REMINDER, /mermaid/);

  assert.equal(
    context({ messages: [{ role: "user", content: "hi" }] }, {}),
    undefined,
    "the reminder fires once, not on every later request",
  );
});

test("a compliant answer never arms the reminder", () => {
  const { handlers, api } = createApi();
  // SAFETY: the stub implements the single on member this extension uses.
  diagramPolicy(api as never);
  handlers.get("message_end")?.(
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "browser \u2192 api. Done." }],
      },
    },
    {},
  );
  assert.equal(handlers.get("context")?.({ messages: [] }, {}), undefined);
});
