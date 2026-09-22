import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const openaiUrl = new URL("../openai-search.ts", import.meta.url).href;

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runChild(
  script: string,
  options: { config?: object; env?: Readonly<Record<string, string>> } = {},
): Promise<ChildResult> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-openai-transport-"));
  if (options.config) {
    await writeFile(join(root, "web-search.json"), JSON.stringify(options.config), "utf8");
  }
  const child = spawn(process.execPath, ["--input-type=module"], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: root,
      HOME: root,
      USERPROFILE: root,
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(script);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

for (const conversationProvider of ["anthropic", "synthetic"] as const) {
  test(`${conversationProvider} conversation uses configured OpenAI API auth after unauthenticated Codex catalog entry`, async () => {
    const result = await runChild(
      `
        const calls = [];
        const attempted = [];
        globalThis.fetch = async (url, init) => {
          calls.push({ url: String(url), authorization: init.headers.Authorization });
          return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }] }), { status: 200 });
        };
        const ctx = {
          model: { provider: ${JSON.stringify(conversationProvider)}, id: "conversation-model" },
          modelRegistry: {
            getAll: () => [
              { provider: ${JSON.stringify(conversationProvider)}, id: "conversation-model" },
              { provider: "openai-codex", id: "gpt-5.6-terra" },
              { provider: "openai", id: "gpt-5.6-terra" },
            ],
            getApiKeyAndHeaders: async (model) => {
              attempted.push(model.provider);
              if (model.provider === ${JSON.stringify(conversationProvider)}) throw new Error("conversation credential requested");
              return model.provider === "openai"
                ? { ok: true, apiKey: "openai-only-secret", headers: { "x-registry": "fixture" } }
                : { ok: true, headers: {} };
            },
          },
        };
        const { resolveOpenAIAuth, searchWithResolvedOpenAIAuth } = await import(${JSON.stringify(openaiUrl)});
        const auth = await resolveOpenAIAuth(ctx);
        await searchWithResolvedOpenAIAuth("query", {}, auth);
        console.log(JSON.stringify({ attempted, auth: { providerId: auth.providerId, transport: auth.transport, billing: auth.billing }, calls }));
      `,
      { config: { openaiResponsesUrl: "https://responses.example.test/v1/responses" } },
    );
    assert.equal(result.status, 0, result.stderr);
    const output: {
      attempted: string[];
      auth: { providerId: string; transport: string; billing: string };
      calls: Array<{ url: string; authorization: string }>;
    } = JSON.parse(result.stdout.trim());
    assert.deepEqual(output.attempted, ["openai-codex", "openai"]);
    assert.deepEqual(output.auth, {
      providerId: "openai",
      transport: "responses-api",
      billing: "api",
    });
    assert.equal(output.calls[0]?.url, "https://responses.example.test/v1/responses");
    assert.equal(output.calls[0]?.authorization, "Bearer openai-only-secret");
  });
}

test("cancellation during registry auth prevents the HTTP request", async () => {
  const result = await runChild(`
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error("fetch must not run"); };
    const controller = new AbortController();
    const ctx = { modelRegistry: {
      getAll: () => [{ provider: "openai-codex", id: "gpt-5.6-terra" }],
      getApiKeyAndHeaders: async () => {
        controller.abort(new DOMException("cancelled", "AbortError"));
        await Promise.resolve();
        return { ok: true, apiKey: "must-not-be-used", headers: {} };
      },
    } };
    const { searchWithOpenAI } = await import(${JSON.stringify(openaiUrl)});
    let failure;
    try { await searchWithOpenAI("query", { signal: controller.signal }, ctx); }
    catch (error) { failure = { name: error.name, kind: error.kind, message: error.message }; }
    console.log(JSON.stringify({ fetchCalls, failure }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output: {
    fetchCalls: number;
    failure: { name: string; kind: string; message: string };
  } = JSON.parse(result.stdout.trim());
  assert.equal(output.fetchCalls, 0);
  assert.equal(output.failure.name, "AbortError");
  assert.equal(output.failure.kind, "cancelled");
  assert.doesNotMatch(output.failure.message, /must-not-be-used/);
});

test("stale context during registry auth remains a typed hard stop", async () => {
  const result = await runChild(`
    let current = true;
    const ctx = { modelRegistry: {
      getAll: () => [{ provider: "openai", id: "gpt-5.6-terra" }],
      getApiKeyAndHeaders: async () => {
        current = false;
        await Promise.resolve();
        return { ok: true, apiKey: "must-not-be-used", headers: {} };
      },
    } };
    const { resolveOpenAIAuth } = await import(${JSON.stringify(openaiUrl)});
    let failure;
    try { await resolveOpenAIAuth(ctx, { isCurrent: () => current }); }
    catch (error) { failure = { name: error.name, kind: error.kind, message: error.message }; }
    console.log(JSON.stringify({ failure }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output: { failure: { name: string; kind: string; message: string } } = JSON.parse(
    result.stdout.trim(),
  );
  assert.equal(output.failure.name, "SearchTransportError");
  assert.equal(output.failure.kind, "stale");
  assert.doesNotMatch(output.failure.message, /must-not-be-used/);
});

test("resolved-auth request failures redact credentials", async () => {
  const result = await runChild(`
    globalThis.fetch = async () => { throw new Error("network rejected api-super-secret"); };
    const { searchWithResolvedOpenAIAuth } = await import(${JSON.stringify(openaiUrl)});
    const auth = {
      providerId: "openai",
      transport: "responses-api",
      billing: "api",
      apiKey: "api-super-secret",
      model: "gpt-5.6-terra",
      headers: {},
      responsesUrl: "https://api.openai.com/v1/responses",
    };
    try { await searchWithResolvedOpenAIAuth("query", {}, auth); }
    catch (error) { console.log(JSON.stringify({ name: error.name, kind: error.kind, message: error.message })); }
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /api-super-secret/);
  const failure: { name: string; kind: string; message: string } = JSON.parse(result.stdout.trim());
  assert.equal(failure.name, "SearchTransportError");
  assert.equal(failure.kind, "network");
  assert.match(failure.message, /\[redacted\]/);
});

test("environment API auth survives a fully unauthenticated built-in OpenAI catalog", async () => {
  const result = await runChild(
    `
      const attempted = [];
      const ctx = { modelRegistry: {
        getAll: () => [
          { provider: "openai-codex", id: "gpt-5.6-terra" },
          { provider: "openai", id: "gpt-5.6-terra" },
        ],
        getApiKeyAndHeaders: async (model) => {
          attempted.push(model.provider);
          return { ok: true, headers: {} };
        },
      } };
      const { resolveOpenAIAuth } = await import(${JSON.stringify(openaiUrl)});
      const auth = await resolveOpenAIAuth(ctx);
      console.log(JSON.stringify({ attempted, auth: { providerId: auth.providerId, billing: auth.billing } }));
    `,
    { env: { OPENAI_API_KEY: "environment-api-secret" } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /environment-api-secret/);
  const output: { attempted: string[]; auth: { providerId: string; billing: string } } = JSON.parse(
    result.stdout.trim(),
  );
  assert.deepEqual(output.attempted, ["openai-codex", "openai"]);
  assert.deepEqual(output.auth, { providerId: "openai", billing: "api" });
});

test("registry ok:false is a typed auth hard stop", async () => {
  const result = await runChild(
    `
      const attempted = [];
      const ctx = { modelRegistry: {
        getAll: () => [
          { provider: "openai-codex", id: "gpt-5.6-terra" },
          { provider: "openai", id: "gpt-5.6-terra" },
        ],
        getApiKeyAndHeaders: async (model) => {
          attempted.push(model.provider);
          return model.provider === "openai"
            ? { ok: true, apiKey: "must-not-be-used", headers: {} }
            : { ok: false, error: "Codex login expired" };
        },
      } };
      const { resolveOpenAIAuth } = await import(${JSON.stringify(openaiUrl)});
      let failure;
      try { await resolveOpenAIAuth(ctx); }
      catch (error) { failure = { name: error.name, kind: error.kind, message: error.message }; }
      console.log(JSON.stringify({ attempted, failure }));
    `,
    { env: { OPENAI_API_KEY: "must-not-be-used" } },
  );
  assert.equal(result.status, 0, result.stderr);
  const output: {
    attempted: string[];
    failure: { name: string; kind: string; message: string };
  } = JSON.parse(result.stdout.trim());
  assert.deepEqual(output.attempted, ["openai-codex"]);
  assert.equal(output.failure.name, "SearchTransportError");
  assert.equal(output.failure.kind, "auth");
  assert.match(output.failure.message, /Codex login expired/);
});

test("thrown registry credential failure is a typed auth hard stop", async () => {
  const result = await runChild(`
    const ctx = { modelRegistry: {
      getAll: () => [{ provider: "openai", id: "gpt-5.6-terra" }],
      getApiKeyAndHeaders: async () => { throw new Error("credential store unavailable"); },
    } };
    const { resolveOpenAIAuth } = await import(${JSON.stringify(openaiUrl)});
    let failure;
    try { await resolveOpenAIAuth(ctx); }
    catch (error) { failure = { name: error.name, kind: error.kind, message: error.message }; }
    console.log(JSON.stringify(failure));
  `);
  assert.equal(result.status, 0, result.stderr);
  const failure: { name: string; kind: string; message: string } = JSON.parse(result.stdout.trim());
  assert.equal(failure.name, "SearchTransportError");
  assert.equal(failure.kind, "auth");
  assert.match(failure.message, /credential store unavailable/);
});

test("thrown registry enumeration failure is a typed config hard stop", async () => {
  const result = await runChild(`
    const ctx = { modelRegistry: {
      getAll: () => { throw new Error("registry unavailable"); },
      getApiKeyAndHeaders: async () => ({ ok: true, headers: {} }),
    } };
    const { resolveOpenAIAuth } = await import(${JSON.stringify(openaiUrl)});
    let failure;
    try { await resolveOpenAIAuth(ctx); }
    catch (error) { failure = { name: error.name, kind: error.kind, message: error.message }; }
    console.log(JSON.stringify(failure));
  `);
  assert.equal(result.status, 0, result.stderr);
  const failure: { name: string; kind: string; message: string } = JSON.parse(result.stdout.trim());
  assert.equal(failure.name, "SearchTransportError");
  assert.equal(failure.kind, "config");
  assert.match(failure.message, /registry unavailable/);
});
