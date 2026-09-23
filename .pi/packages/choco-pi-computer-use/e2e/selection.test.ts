import { test } from "node:test";
import assert from "node:assert/strict";
import { list, selectModels, selectScenarios } from "./selection.ts";

const pairs = [
  { original: "anthropic/claude-opus-5-5", resolved: "anthropic/claude-opus-5-5" },
  { original: "openai-codex/gpt-6-sol", resolved: "openai-codex/gpt-6-astra" },
];

test("list rejects empty and duplicate entries", () => {
  assert.deepEqual(list("--scenarios", "S1, S3"), ["S1", "S3"]);
  assert.throws(() => list("--scenarios", "S1,,S3"), /comma-separated/);
  assert.throws(() => list("--scenarios", "S1,S1"), /comma-separated/);
});

test("selectModels defaults to all and matches original or substitute ids", () => {
  assert.deepEqual(selectModels(pairs, undefined), [
    "anthropic/claude-opus-5-5",
    "openai-codex/gpt-6-astra",
  ]);
  assert.deepEqual(selectModels(pairs, ["openai-codex/gpt-6-sol"]), ["openai-codex/gpt-6-astra"]);
  assert.deepEqual(selectModels(pairs, ["openai-codex/gpt-6-astra"]), ["openai-codex/gpt-6-astra"]);
  assert.throws(() => selectModels(pairs, ["x/y"]), /unknown model x\/y/);
});

test("selectScenarios keeps canonical order and requires S1", () => {
  assert.equal(selectScenarios("a", undefined).length, 7);
  assert.equal(selectScenarios("b", undefined).includes("S7"), false);
  assert.deepEqual(selectScenarios("a", ["S3", "S1"]), ["S1", "S3"]);
  assert.throws(() => selectScenarios("a", ["S3"]), /must include S1/);
  assert.throws(() => selectScenarios("b", ["S1", "S7"]), /unknown scenario S7/);
  assert.throws(() => selectScenarios("a", ["S1", "S9"]), /unknown scenario S9/);
});
