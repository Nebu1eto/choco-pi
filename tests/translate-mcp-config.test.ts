import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { translateMcpFile } from "../scripts/translate-mcp-config.ts";

async function fixture(t: test.TestContext, source: string) {
  const root = await mkdtemp(join(tmpdir(), "translate-mcp-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, "mcp.json");
  await writeFile(path, source, { mode: 0o600 });
  return { root, path };
}

const run = promisify(execFile);
const translatorPath = fileURLToPath(
  new URL("../scripts/translate-mcp-config.ts", import.meta.url),
);

const fakeConfig = {
  mcpServers: {
    github: {
      url: "https://example.test/mcp?secret=fake-url-token",
      auth: "bearer",
      bearerToken: "fake-bearer-token",
      protocolVersion: "legacy",
      requestTimeoutMs: 1500,
      disabled: true,
      headers: { "X-Token": "fake-header-token" },
    },
    notion: {
      url: "https://example.test/mcp",
      auth: "oauth",
      oauth: {
        clientSecret: "fake-oauth-secret",
        clientId: "fake-client-id",
        redirectUri: "http://localhost:1234/callback",
        grantType: "authorization_code",
      },
    },
    local: {
      command: "fake-executable",
      args: ["fake-arg-token"],
      env: { SECRET: "fake-env-token" },
    },
  },
};

test("CLI writes only with --apply and redacts both dry-run and apply output", async (t) => {
  const source = JSON.stringify(fakeConfig);
  const { root, path } = await fixture(t, source);
  const dry = await run(process.execPath, [translatorPath, "--file", path]);
  assert.equal(dry.stdout.includes("fake-"), false);
  assert.equal(dry.stderr, "");
  assert.equal(await readFile(path, "utf8"), source);
  assert.deepEqual(await readdir(root), ["mcp.json"]);
  const applied = await run(process.execPath, [translatorPath, "--file", path, "--apply"]);
  assert.equal(applied.stdout.includes("fake-"), false);
  assert.match(applied.stdout, /Applied/);
  assert.notEqual(await readFile(path, "utf8"), source);
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".bak")).length, 1);
});

test("dry-run redacts every string value and leaves the fixture untouched", async (t) => {
  const source = JSON.stringify(fakeConfig);
  const { root, path } = await fixture(t, source);
  const output = await translateMcpFile(path);
  for (const value of [
    "fake-bearer-token",
    "fake-oauth-secret",
    "fake-client-id",
    "fake-url-token",
    "fake-header-token",
    "fake-env-token",
    "fake-arg-token",
    "fake-executable",
  ])
    assert.equal(output.includes(value), false);
  assert.match(output, /DRY-RUN/);
  assert.match(output, /Authorization/);
  assert.match(output, /\[REDACTED\]/);
  assert.equal(await readFile(path, "utf8"), source);
  assert.deepEqual(await readdir(root), ["mcp.json"]);
});

test("apply requires explicit opt-in, translates fields, and creates an exact timestamped backup", async (t) => {
  const source = JSON.stringify(fakeConfig);
  const { root, path } = await fixture(t, source);
  const output = await translateMcpFile(path, true);
  assert.equal(output.includes("fake-bearer-token"), false);
  const result: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(result, {
    mcpServers: {
      github: {
        url: fakeConfig.mcpServers.github.url,
        headers: { "X-Token": "fake-header-token", Authorization: "Bearer fake-bearer-token" },
        enabled: false,
        timeout: 1.5,
      },
      notion: {
        url: "https://example.test/mcp",
        oauth: {
          clientSecret: "fake-oauth-secret",
          clientId: "fake-client-id",
          callbackUrl: "http://localhost:1234/callback",
        },
      },
      local: fakeConfig.mcpServers.local,
    },
  });
  const backup = (await readdir(root)).find((name) => /mcp\.json\.\d{4}-.*\.bak$/.test(name));
  assert.ok(backup);
  assert.equal(await readFile(join(root, backup), "utf8"), source);
  assert.equal(
    (await readdir(root)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("unsupported adapter settings and fields fail before backups or writes", async (t) => {
  for (const field of [
    "bearerTokenEnv",
    "directTools",
    "toolPrefix",
    "sampling",
    "elicitation",
    "oauthDir",
    "approveTools",
  ]) {
    const source = JSON.stringify({
      mcpServers: {
        test: { url: "https://example.test", [field]: "fake-sensitive-unsupported-value" },
      },
    });
    const { root, path } = await fixture(t, source);
    await assert.rejects(translateMcpFile(path, true), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(field));
      assert.equal(error.message.includes("fake-sensitive-unsupported-value"), false);
      return true;
    });
    assert.equal(await readFile(path, "utf8"), source);
    assert.deepEqual(await readdir(root), ["mcp.json"]);
  }
});

test("explicit auth/OAuth disablement is dropped with a notice", async (t) => {
  const { path } = await fixture(
    t,
    JSON.stringify({
      mcpServers: { local: { url: "http://127.0.0.1:3845/mcp", auth: false, oauth: false } },
    }),
  );
  const output = await translateMcpFile(path);
  assert.match(output, /Dropped explicit auth\/OAuth disablement for local/);
  const translatedSide = output.slice(output.indexOf("\n+ "));
  assert.equal(translatedSide.includes('"auth"'), false);
  assert.equal(translatedSide.includes('"oauth"'), false);
});

test("adapter-only top-level settings are dropped with a notice that names keys only", async (t) => {
  const { path } = await fixture(
    t,
    JSON.stringify({
      mcpServers: { test: { url: "https://example.test" } },
      settings: { directTools: ["fake-secret-tool"], toolPrefix: "fake-prefix" },
    }),
  );
  const output = await translateMcpFile(path);
  assert.match(output, /Dropped adapter-only top-level settings .*: directTools, toolPrefix/);
  assert.equal(output.includes("fake-secret-tool"), false);
  assert.equal(output.includes("fake-prefix"), false);
  const translatedSide = output.slice(output.indexOf("\n+ "));
  assert.equal(translatedSide.includes('"settings"'), false);
});

test("input and translated output validation fail without exposing values", async (t) => {
  for (const source of [
    '{"fake-invalid-json-secret":',
    JSON.stringify({ mcpServers: { "fake-invalid-secret.name": { url: "https://example.test" } } }),
    JSON.stringify({ mcpServers: { test: { url: 3, bearerToken: "fake-token" } } }),
    JSON.stringify({ mcpServers: { test: { url: "fake-invalid-url-secret" } } }),
    JSON.stringify({
      mcpServers: {
        test: {
          url: "https://example.test",
          auth: "oauth",
          oauth: { redirectUri: "https://fake-callback-secret.test" },
        },
      },
    }),
    JSON.stringify({
      mcpServers: {
        test: {
          url: "https://example.test",
          auth: "bearer",
          bearerToken: "fake-token",
          headers: { authorization: "fake-conflicting-secret" },
        },
      },
    }),
  ]) {
    const { path } = await fixture(t, source);
    await assert.rejects(translateMcpFile(path, true), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("fake-"), false);
      return true;
    });
    assert.equal(await readFile(path, "utf8"), source);
  }
});

test("OAuth defaults to an empty configuration and milliseconds become seconds", async (t) => {
  const { path } = await fixture(
    t,
    JSON.stringify({
      mcpServers: { test: { url: "https://example.test", auth: "oauth", requestTimeoutMs: 60000 } },
    }),
  );
  await translateMcpFile(path, true);
  const result: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(result, {
    mcpServers: { test: { url: "https://example.test", timeout: 60, oauth: {} } },
  });
});

test("--skip leaves a named server out with a notice and rejects unknown names", async (t) => {
  const { path } = await fixture(
    t,
    JSON.stringify({
      mcpServers: {
        keep: { url: "https://example.test" },
        drop: { url: "https://example.test", oauth: { skipIssuerMetadataValidation: true } },
      },
    }),
  );
  await assert.rejects(translateMcpFile(path), /Unsupported OAuth field for drop/);
  const output = await translateMcpFile(path, false, { skip: ["drop"] });
  assert.match(output, /Skipped server drop/);
  const translatedSide = output.slice(output.indexOf("\n+ "));
  assert.equal(translatedSide.includes('"drop"'), false);
  assert.equal(translatedSide.includes('"keep"'), true);
  await assert.rejects(translateMcpFile(path, false, { skip: ["missing"] }), /unknown server/);
});

test("bearer token commands become whole-value header commands and literal tokens keep Bearer", async (t) => {
  const { path } = await fixture(
    t,
    JSON.stringify({
      mcpServers: {
        cmd: { url: "https://example.test", auth: "bearer", bearerToken: "!fake-cli auth token" },
        bang: { url: "https://example.test", auth: "bearer", bearerToken: "!!fake-literal" },
        plain: { url: "https://example.test", auth: "bearer", bearerToken: "fake-token" },
      },
    }),
  );
  const output = await translateMcpFile(path);
  assert.match(output, /Wrapped the token command for cmd/);
  assert.equal(output.includes("fake-"), false);
  const { translateMcpConfig } = await import("../scripts/translate-mcp-config.ts");
  const { config } = translateMcpConfig({
    mcpServers: {
      cmd: { url: "https://example.test", auth: "bearer", bearerToken: "!fake-cli auth token" },
      bang: { url: "https://example.test", auth: "bearer", bearerToken: "!!fake-literal" },
      plain: { url: "https://example.test", auth: "bearer", bearerToken: "fake-token" },
    },
  });
  assert.equal(config.mcpServers.cmd.headers?.Authorization, "!echo Bearer $(fake-cli auth token)");
  assert.equal(config.mcpServers.bang.headers?.Authorization, "Bearer !fake-literal");
  assert.equal(config.mcpServers.plain.headers?.Authorization, "Bearer fake-token");
});

test("pre-registered OAuth clients keep the adapter's fixed redirect URI", async () => {
  const { translateMcpConfig } = await import("../scripts/translate-mcp-config.ts");
  const { config, notices } = translateMcpConfig({
    mcpServers: {
      registered: {
        url: "https://example.test",
        auth: "oauth",
        oauth: { clientId: "fake-id", clientSecret: "fake-secret" },
      },
      explicit: {
        url: "https://example.test",
        auth: "oauth",
        oauth: { clientId: "fake-id", redirectUri: "http://localhost:4242/callback" },
      },
      dynamic: { url: "https://example.test", auth: "oauth" },
    },
  });
  assert.equal(config.mcpServers.registered.oauth?.callbackUrl, "http://localhost:19876/callback");
  assert.equal(config.mcpServers.explicit.oauth?.callbackUrl, "http://localhost:4242/callback");
  assert.equal(config.mcpServers.dynamic.oauth?.callbackUrl, undefined);
  assert.ok(notices.some((notice) => /Pinned oauth.callbackUrl for registered/.test(notice)));
  assert.equal(
    notices.some((notice) => notice.includes("fake-")),
    false,
  );
});

test("the callback pin never clobbers an explicit callbackUrl or callbackPort and honors the env port", async (t) => {
  const { translateMcpConfig } = await import("../scripts/translate-mcp-config.ts");
  const previous = process.env.MCP_OAUTH_CALLBACK_PORT;
  t.after(() => {
    if (previous === undefined) delete process.env.MCP_OAUTH_CALLBACK_PORT;
    else process.env.MCP_OAUTH_CALLBACK_PORT = previous;
  });
  const legacy: Parameters<typeof translateMcpConfig>[0] = {
    mcpServers: {
      url: {
        url: "https://example.test",
        auth: "oauth",
        oauth: { clientId: "fake-id", callbackUrl: "http://localhost:8080/callback" },
      },
      port: {
        url: "https://example.test",
        auth: "oauth",
        oauth: { clientId: "fake-id", callbackPort: 8080 },
      },
      pinned: { url: "https://example.test", auth: "oauth", oauth: { clientId: "fake-id" } },
    },
  };
  delete process.env.MCP_OAUTH_CALLBACK_PORT;
  const { config } = translateMcpConfig(legacy);
  assert.equal(config.mcpServers.url.oauth?.callbackUrl, "http://localhost:8080/callback");
  assert.equal(config.mcpServers.port.oauth?.callbackUrl, undefined);
  assert.equal(config.mcpServers.port.oauth?.callbackPort, 8080);
  assert.equal(config.mcpServers.pinned.oauth?.callbackUrl, "http://localhost:19876/callback");
  process.env.MCP_OAUTH_CALLBACK_PORT = "4321";
  assert.equal(
    translateMcpConfig(legacy).config.mcpServers.pinned.oauth?.callbackUrl,
    "http://localhost:4321/callback",
  );
  process.env.MCP_OAUTH_CALLBACK_PORT = "not-a-port";
  assert.equal(
    translateMcpConfig(legacy).config.mcpServers.pinned.oauth?.callbackUrl,
    "http://localhost:19876/callback",
  );
});
