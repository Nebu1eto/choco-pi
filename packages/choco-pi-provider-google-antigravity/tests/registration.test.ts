import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  googleAntigravityProviderConfig,
  registerGoogleAntigravityProvider,
} from "../extensions/provider/index.ts";
import { buildAntigravityUserAgent } from "../src/config.ts";
import { parseAntigravityErrorMessage } from "../src/errors.ts";
import { collect, testModel, transcript } from "./fixtures/stream/harness.ts";

test("the provider registers as google with oauth, fallback models and its own transport", () => {
  const registered: [string, ProviderConfig][] = [];
  registerGoogleAntigravityProvider((name, config) => {
    registered.push([name, config]);
  });
  const [name, config] = registered[0] ?? [];
  assert.equal(name, "google");
  assert.equal(config?.name, "Google");
  assert.equal(config?.api, "google-generative-ai");
  assert.equal(config?.oauth?.name, "Google Antigravity");
  assert.equal(config?.oauth?.isSubscription, true);
  assert.ok(config?.streamSimple && config.refreshModels);
  assert.deepEqual(
    config?.models?.map((model) => model.id),
    ["gemini-4-neon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5"],
  );
});

test("the registered transport refuses a Gemini API key before any request", async () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => {
    requests += 1;
    return new Response("", { status: 500 });
  };
  const stream = googleAntigravityProviderConfig().streamSimple?.(
    testModel(),
    transcript({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
    { apiKey: "AIzaFAKE-gemini-api-key-for-tests", fetch },
  );
  assert.ok(stream);
  const { result } = await collect(stream);
  assert.equal(result.stopReason, "error");
  assert.equal(parseAntigravityErrorMessage(result.errorMessage ?? "")?.kind, "auth");
  assert.match(result.errorMessage ?? "", /\/login google and choose Google Antigravity/u);
  assert.doesNotMatch(result.errorMessage ?? "", /AIza/u);
  assert.equal(requests, 0);
});

test("the user agent mirrors agy 1.5.14 with the real OS and architecture", () => {
  assert.equal(
    buildAntigravityUserAgent({ platform: "darwin", arch: "arm64" }),
    "antigravity/cli/1.5.14 (aidev_client; os_type=darwin; arch=arm64; cl=1026970498; auth_method=consumer)",
  );
  assert.match(
    buildAntigravityUserAgent({ platform: "linux", arch: "x64" }),
    /os_type=linux; arch=amd64/u,
  );
  assert.match(buildAntigravityUserAgent({ platform: "win32", arch: "arm64" }), /os_type=windows/u);
});
