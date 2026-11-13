import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const exaUrl = new URL("../exa.ts", import.meta.url).href;
const kagiUrl = new URL("../kagi.ts", import.meta.url).href;

async function runChild(script: string, env: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-transport-capabilities-"));
  const child = spawn(process.execPath, ["--input-type=module"], {
    env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, ...env },
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
  assert.equal(status, 0, stderr);
  return stdout;
}

test("Exa API raw helper forwards hard filters and inline-content request", async () => {
  const stdout = await runChild(
    `
      let request;
      globalThis.fetch = async (url, init) => {
        request = { url: String(url), body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ results: [{ title: "Result", url: "https://example.test", text: "Full text", highlights: ["Highlight"] }] }), { status: 200 });
      };
      const { EXA_API_SEARCH_CAPABILITIES, searchWithExaApi } = await import(${JSON.stringify(exaUrl)});
      const response = await searchWithExaApi("query", { numResults: 7, recencyFilter: "week", domainFilter: ["example.test", "-blocked.test"], includeContent: true }, "exa-secret");
      console.log(JSON.stringify({ capabilities: EXA_API_SEARCH_CAPABILITIES, request, response }));
    `,
    {},
  );
  const output: {
    capabilities: { domainFilter: string; recencyFilter: string; inlineContent: boolean };
    request: {
      url: string;
      body: {
        numResults: number;
        includeDomains: string[];
        excludeDomains: string[];
        startPublishedDate: string;
        contents: { text: boolean; highlights: boolean };
      };
    };
    response: { inlineContent?: Array<{ content: string }> };
  } = JSON.parse(stdout.trim());
  assert.equal(output.capabilities.domainFilter, "hard");
  assert.equal(output.capabilities.recencyFilter, "hard");
  assert.equal(output.capabilities.inlineContent, true);
  assert.equal(output.request.url, "https://api.exa.ai/search");
  assert.equal(output.request.body.numResults, 7);
  assert.deepEqual(output.request.body.includeDomains, ["example.test"]);
  assert.deepEqual(output.request.body.excludeDomains, ["blocked.test"]);
  assert.match(output.request.body.startPublishedDate, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(output.request.body.contents, { text: true, highlights: true });
  assert.equal(output.response.inlineContent?.[0]?.content, "Full text");
});

test("Kagi capabilities expose unsupported filters while raw helper forwards result limit", async () => {
  const stdout = await runChild(
    `
      let request;
      globalThis.fetch = async (url, init) => {
        request = { url: String(url), body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      };
      const { KAGI_SEARCH_CAPABILITIES, searchWithKagiApi } = await import(${JSON.stringify(kagiUrl)});
      await searchWithKagiApi("query", { numResults: 9 }, "kagi-secret");
      console.log(JSON.stringify({ capabilities: KAGI_SEARCH_CAPABILITIES, request }));
    `,
    {},
  );
  const output: {
    capabilities: { domainFilter: string; recencyFilter: string; inlineContent: boolean };
    request: { url: string; body: { query: string; limit: number } };
  } = JSON.parse(stdout.trim());
  assert.deepEqual(output.capabilities, {
    answer: true,
    results: true,
    inlineContent: true,
    numResults: "hard",
    domainFilter: "unsupported",
    recencyFilter: "unsupported",
  });
  assert.equal(output.request.url, "https://kagi.com/api/v1/search");
  assert.deepEqual(output.request.body, { query: "query", limit: 9 });
});

test("Exa MCP advanced helper forwards exclusions without basic-tool degradation", async () => {
  const stdout = await runChild(
    `
      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      };
      const { EXA_MCP_SEARCH_CAPABILITIES, searchWithExaMcp } = await import(${JSON.stringify(exaUrl)});
      await searchWithExaMcp("query", { domainFilter: ["allowed.test", "-blocked.test"] });
      console.log(JSON.stringify({ capabilities: EXA_MCP_SEARCH_CAPABILITIES, requests }));
    `,
    {},
  );
  const output: {
    capabilities: { domainFilter: string; domainExclusions: string };
    requests: Array<{
      url: string;
      body: {
        params: { name: string; arguments: { includeDomains: string[]; excludeDomains: string[] } };
      };
    }>;
  } = JSON.parse(stdout.trim());
  assert.equal(output.capabilities.domainFilter, "hard");
  assert.equal(output.capabilities.domainExclusions, "hard");
  assert.equal(output.requests.length, 1);
  assert.match(output.requests[0]?.url ?? "", /web_search_advanced_exa/);
  assert.equal(output.requests[0]?.body.params.name, "web_search_advanced_exa");
  assert.deepEqual(output.requests[0]?.body.params.arguments.includeDomains, ["allowed.test"]);
  assert.deepEqual(output.requests[0]?.body.params.arguments.excludeDomains, ["blocked.test"]);
});

test("raw HTTP helpers expose typed auth and quota failures without credentials", async () => {
  const stdout = await runChild(
    `
      globalThis.fetch = async (url) => new Response(String(url).includes("exa") ? "exa-secret denied" : "kagi-secret limited", { status: String(url).includes("exa") ? 401 : 429 });
      const { searchWithExaApi } = await import(${JSON.stringify(exaUrl)});
      const { searchWithKagiApi } = await import(${JSON.stringify(kagiUrl)});
      const failures = [];
      for (const operation of [
        () => searchWithExaApi("query", {}, "exa-secret"),
        () => searchWithKagiApi("query", {}, "kagi-secret"),
      ]) {
        try { await operation(); }
        catch (error) { failures.push({ name: error.name, kind: error.kind, status: error.status, message: error.message }); }
      }
      console.log(JSON.stringify(failures));
    `,
    {},
  );
  assert.doesNotMatch(stdout, /exa-secret|kagi-secret/);
  const failures: Array<{ name: string; kind: string; status: number; message: string }> =
    JSON.parse(stdout.trim());
  assert.deepEqual(
    failures.map(({ name, kind, status }) => ({ name, kind, status })),
    [
      { name: "SearchTransportError", kind: "auth", status: 401 },
      { name: "SearchTransportError", kind: "quota", status: 429 },
    ],
  );
});
