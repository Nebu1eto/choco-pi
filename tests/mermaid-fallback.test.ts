import assert from "node:assert/strict";
import test from "node:test";
import { renderNarrowMermaid } from "../.pi/extensions/mermaid-fallback.ts";

const SCREENSHOT_DIAGRAM = `\`\`\`mermaid
flowchart LR
  Claude["Claude Code hook event"] --> Script["zellaude-hook.sh"]
  Script --> Pipe["zellij pipe"]
  Pipe --> Plugin["Zellij plugin"]
  Plugin --> UI["Status display"]
\`\`\``;

test("main transcript retries an over-wide horizontal Mermaid diagram vertically", () => {
  const rendered = renderNarrowMermaid(SCREENSHOT_DIAGRAM, {
    messageType: "assistant",
    isStreaming: false,
    availableWidth: 100,
  });
  assert.doesNotMatch(rendered, /```mermaid/);
  assert.match(rendered, /Claude Code hook event/);
  assert.match(rendered, /Status display/);
});

test("non-assistant Markdown is unchanged", () => {
  const rendered = renderNarrowMermaid(SCREENSHOT_DIAGRAM, {
    messageType: "assistant-thinking",
    isStreaming: false,
    availableWidth: 100,
  });
  assert.equal(rendered, SCREENSHOT_DIAGRAM);
});
