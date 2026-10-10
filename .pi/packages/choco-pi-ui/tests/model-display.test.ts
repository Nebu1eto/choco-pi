import assert from "node:assert/strict";
import test from "node:test";
import { formatModelRef, formatProviderLabel } from "../extensions/zentui/model-display.ts";

test("formatProviderLabel maps provider ids to display names", () => {
  const cases: readonly { readonly input: string | undefined; readonly expected: string }[] = [
    { input: undefined, expected: "Unknown" },
    { input: "", expected: "Unknown" },
    { input: "anthropic", expected: "Anthropic" },
    { input: "openai-codex", expected: "OpenAI" },
    { input: "openai", expected: "OpenAI" },
    { input: "google", expected: "Google" },
    { input: "gemini", expected: "Google" },
    { input: "foo-bar", expected: "Foo Bar" },
    { input: "foo_bar", expected: "Foo Bar" },
  ];
  for (const { input, expected } of cases) {
    assert.equal(formatProviderLabel(input), expected, `input: ${String(input)}`);
  }
});

test("formatModelRef keeps the raw provider/id identifier form", () => {
  assert.equal(formatModelRef("openai-codex", "gpt-5"), "openai-codex/gpt-5");
});
