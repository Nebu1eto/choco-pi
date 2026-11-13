import { describe, expect, it, vi } from "vitest";
import {
  countSyntheticTokens,
  type CountSyntheticTokensOptions,
  DEFAULT_SYNTHETIC_API_BASE_URL,
  resolveSyntheticAnthropicBaseUrl,
  resolveSyntheticUtilityApiBaseUrl,
} from "./index";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(respond: (request: CapturedRequest) => Response | Promise<Response>) {
  const calls: CapturedRequest[] = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: String(input), init: init ?? {} };
    calls.push(request);
    return respond(request);
  });
  return { calls, fetch: fetchStub };
}

/** A fetch that never resolves until its signal aborts, then rejects like undici. */
function hangingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
}

function baseOptions(
  overrides: Partial<CountSyntheticTokensOptions> = {},
): CountSyntheticTokensOptions {
  return {
    apiKey: "syn-key",
    model: "hf:zai-org/GLM-5.3",
    system: "You summarize.",
    promptText: "Summarize this conversation.",
    ...overrides,
  };
}

describe("resolveSyntheticAnthropicBaseUrl", () => {
  it("defaults to the Synthetic Anthropic-compatible base", () => {
    expect(resolveSyntheticAnthropicBaseUrl()).toBe("https://api.synthetic.new/anthropic/v1");
  });

  it("maps the OpenAI-compatible chat base to the Anthropic base on the same host", () => {
    expect(resolveSyntheticAnthropicBaseUrl("https://api.synthetic.new/openai/v1")).toBe(
      "https://api.synthetic.new/anthropic/v1",
    );
    expect(resolveSyntheticAnthropicBaseUrl("https://api.synthetic.new/openai/v1/")).toBe(
      "https://api.synthetic.new/anthropic/v1",
    );
    expect(resolveSyntheticAnthropicBaseUrl("http://localhost:8080/openai")).toBe(
      "http://localhost:8080/anthropic/v1",
    );
  });

  it("maps the utility API base and proxy roots, preserving path prefixes", () => {
    expect(resolveSyntheticAnthropicBaseUrl(DEFAULT_SYNTHETIC_API_BASE_URL)).toBe(
      "https://api.synthetic.new/anthropic/v1",
    );
    const proxyBase = resolveSyntheticUtilityApiBaseUrl("https://proxy.example.com/synthetic/");
    expect(resolveSyntheticAnthropicBaseUrl(proxyBase)).toBe(
      "https://proxy.example.com/synthetic/anthropic/v1",
    );
  });

  it("keeps an Anthropic base idempotent", () => {
    expect(resolveSyntheticAnthropicBaseUrl("https://api.synthetic.new/anthropic/v1")).toBe(
      "https://api.synthetic.new/anthropic/v1",
    );
  });

  it("drops query strings and fragments", () => {
    expect(resolveSyntheticAnthropicBaseUrl("https://api.synthetic.new/openai/v1?x=1#y")).toBe(
      "https://api.synthetic.new/anthropic/v1",
    );
  });

  it("throws on invalid URLs and protocols", () => {
    expect(() => resolveSyntheticAnthropicBaseUrl("not-a-url")).toThrow(/invalid baseUrl/);
    expect(() => resolveSyntheticAnthropicBaseUrl("ftp://api.synthetic.new")).toThrow(
      /http or https/,
    );
  });
});

describe("countSyntheticTokens", () => {
  it("posts an Anthropic-shaped body and returns input_tokens", async () => {
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ input_tokens: 1234 })));

    const result = await countSyntheticTokens(baseOptions({ fetch: stub.fetch }));

    expect(result).toEqual({ ok: true, inputTokens: 1234 });
    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call.url).toBe("https://api.synthetic.new/anthropic/v1/messages/count_tokens");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-api-key": "syn-key",
      Authorization: "Bearer syn-key",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: "hf:zai-org/GLM-5.3",
      system: "You summarize.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Summarize this conversation." }] },
      ],
    });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("targets the mapped Anthropic base when given the OpenAI base", async () => {
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ input_tokens: 1 })));
    await countSyntheticTokens(
      baseOptions({ fetch: stub.fetch, baseUrl: "https://api.synthetic.new/openai/v1" }),
    );
    expect(stub.calls[0].url).toBe("https://api.synthetic.new/anthropic/v1/messages/count_tokens");
  });

  it("targets the mapped Anthropic base when given a utility proxy base", async () => {
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ input_tokens: 1 })));
    await countSyntheticTokens(
      baseOptions({
        fetch: stub.fetch,
        baseUrl: resolveSyntheticUtilityApiBaseUrl("https://proxy.example.com/synthetic"),
      }),
    );
    expect(stub.calls[0].url).toBe(
      "https://proxy.example.com/synthetic/anthropic/v1/messages/count_tokens",
    );
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [402, "quota"],
    [429, "rate-limit"],
    [500, "http"],
    [503, "http"],
    [404, "http"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const stub = stubFetch(() =>
      jsonResponse(JSON.stringify({ error: `failure ${status}` }), status),
    );
    const result = await countSyntheticTokens(baseOptions({ fetch: stub.fetch }));
    expect(result).toEqual({ ok: false, code, status, message: `failure ${status}` });
  });

  it("does not leak the API key into error messages and truncates long bodies", async () => {
    const stub = stubFetch(() => new Response("x".repeat(5000), { status: 500 }));
    const result = await countSyntheticTokens(baseOptions({ fetch: stub.fetch }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.length).toBeLessThanOrEqual(501);
    expect(result.message).not.toContain("syn-key");
  });

  it("returns timeout when the request exceeds timeoutMs", async () => {
    const result = await countSyntheticTokens(
      baseOptions({ fetch: hangingFetch(), timeoutMs: 20 }),
    );
    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });

  it("returns aborted when the caller aborts mid-request", async () => {
    const controller = new AbortController();
    const pending = countSyntheticTokens(
      baseOptions({ fetch: hangingFetch(), signal: controller.signal, timeoutMs: 10_000 }),
    );
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "aborted" });
  });

  it("returns aborted without calling fetch when the signal is already aborted", async () => {
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ input_tokens: 1 })));
    const result = await countSyntheticTokens(
      baseOptions({ fetch: stub.fetch, signal: AbortSignal.abort() }),
    );
    expect(result).toMatchObject({ ok: false, code: "aborted" });
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["non-JSON", "<html>oops</html>"],
    ["missing field", JSON.stringify({ tokens: 5 })],
    ["string count", JSON.stringify({ input_tokens: "5" })],
    ["negative count", JSON.stringify({ input_tokens: -1 })],
    ["fractional count", JSON.stringify({ input_tokens: 1.5 })],
    ["null body", "null"],
  ])("returns malformed for a %s body", async (_label, body) => {
    const stub = stubFetch(() => jsonResponse(body));
    const result = await countSyntheticTokens(baseOptions({ fetch: stub.fetch }));
    expect(result).toMatchObject({ ok: false, code: "malformed", status: 200 });
  });

  it("returns network when fetch rejects", async () => {
    const stub = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const result = await countSyntheticTokens(baseOptions({ fetch: stub.fetch }));
    expect(result).toEqual({ ok: false, code: "network", message: "fetch failed" });
  });

  it("throws only on programmer errors", async () => {
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ input_tokens: 1 })));
    await expect(
      countSyntheticTokens(baseOptions({ fetch: stub.fetch, apiKey: " " })),
    ).rejects.toThrow(/apiKey is required/);
    await expect(
      countSyntheticTokens(baseOptions({ fetch: stub.fetch, model: "" })),
    ).rejects.toThrow(/model is required/);
    await expect(
      countSyntheticTokens(baseOptions({ fetch: stub.fetch, timeoutMs: 0 })),
    ).rejects.toThrow(/timeoutMs/);
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});
