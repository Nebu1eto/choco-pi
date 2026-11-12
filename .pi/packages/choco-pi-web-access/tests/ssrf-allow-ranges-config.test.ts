import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// The config path is captured when the modules load, so every case shares one agent dir,
// set before the imports below. Each case rewrites web-search.json in place.
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME"] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const root = await mkdtemp(join(tmpdir(), "pi-ssrf-config-"));
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.XDG_CONFIG_HOME;
const configPath = join(root, "web-search.json");

const { loadSsrfConfig } = await import("../extract.ts");
const { loadFetchContentDomainPolicy } = await import("../ssrf-protection.ts");

after(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

// The parsed config is cached by mtime and size, so every write gets a distinct mtime:
// two same-size writes inside one clock tick must never read as the cached file.
let mtimeSeconds = Math.floor(Date.now() / 1000);
async function writeConfig(content: string): Promise<void> {
  await writeFile(configPath, content, "utf8");
  mtimeSeconds += 10;
  await utimes(configPath, mtimeSeconds, mtimeSeconds);
}

async function removeConfig(): Promise<void> {
  await rm(configPath, { force: true });
}

function errorOf(load: () => void): string {
  try {
    load();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the config load to throw");
}

test("loadSsrfConfig defaults trustEnvProxy to false", async () => {
  await writeConfig(JSON.stringify({ ssrf: { allowRanges: ["198.18.0.0/15"] } }));
  assert.deepEqual(loadSsrfConfig(), { allowRanges: ["198.18.0.0/15"], trustEnvProxy: false });
});

test("loadFetchContentDomainPolicy reads normalized allow and deny hostnames", async () => {
  await writeConfig(
    JSON.stringify({
      fetchContent: { domainPolicy: { allow: [" Example.COM. "], deny: ["blocked.example.com"] } },
    }),
  );
  assert.deepEqual(loadFetchContentDomainPolicy(), {
    allow: ["example.com"],
    deny: ["blocked.example.com"],
  });
});

test("loadFetchContentDomainPolicy rejects malformed policy values", async () => {
  for (const domainPolicy of [
    { allow: "example.com" },
    { deny: ["*.example.com"] },
    { allow: ["example.com", 42] },
  ]) {
    await writeConfig(JSON.stringify({ fetchContent: { domainPolicy } }));
    assert.match(
      errorOf(loadFetchContentDomainPolicy),
      /fetchContent\.domainPolicy\.(allow|deny)/,
      JSON.stringify(domainPolicy),
    );
  }
});

test("loadSsrfConfig accepts an explicit trustEnvProxy opt-in", async () => {
  await writeConfig(JSON.stringify({ ssrf: { trustEnvProxy: true } }));
  assert.deepEqual(loadSsrfConfig(), { allowRanges: [], trustEnvProxy: true });
});

test("loadSsrfConfig rejects a non-boolean trustEnvProxy value", async () => {
  await writeConfig(JSON.stringify({ ssrf: { trustEnvProxy: "yes" } }));
  assert.match(errorOf(loadSsrfConfig), /ssrf\.trustEnvProxy in .* must be a boolean/);
});

test("loadSsrfConfig().allowRanges throws when ssrf.allowRanges is not an array", async () => {
  // Regression: a mistyped non-array value (bare string, object, number) must
  // fail loudly instead of being silently ignored as "no exemptions".
  for (const allowRanges of ["198.18.0.0/15", { "198.18.0.0/15": true }, 42]) {
    await writeConfig(JSON.stringify({ ssrf: { allowRanges } }));
    assert.match(
      errorOf(() => loadSsrfConfig().allowRanges),
      /ssrf\.allowRanges in .* must be an array of CIDR strings/,
      `expected throw for ${JSON.stringify(allowRanges)}`,
    );
  }
});

test("loadSsrfConfig().allowRanges throws when an ssrf.allowRanges entry is not a string", async () => {
  await writeConfig(JSON.stringify({ ssrf: { allowRanges: ["198.18.0.0/15", 123] } }));
  assert.match(
    errorOf(() => loadSsrfConfig().allowRanges),
    /ssrf\.allowRanges in .* must contain only CIDR strings; entry 2 is number/,
  );
});

test("loadSsrfConfig().allowRanges returns trimmed, non-empty CIDR strings for a valid array", async () => {
  await writeConfig(
    JSON.stringify({ ssrf: { allowRanges: ["198.18.0.0/15", "  fd00::/8  ", "", "   "] } }),
  );
  assert.deepEqual(loadSsrfConfig().allowRanges, ["198.18.0.0/15", "fd00::/8"]);
});

test("loadSsrfConfig().allowRanges returns [] when the config file is missing", async () => {
  await removeConfig();
  assert.deepEqual(loadSsrfConfig().allowRanges, []);
});

test("loadSsrfConfig().allowRanges returns [] when ssrf.allowRanges is unset", async () => {
  await writeConfig(JSON.stringify({ exaApiKey: "exa-x" }));
  assert.deepEqual(loadSsrfConfig().allowRanges, []);
});

test("loadSsrfConfig().allowRanges reports malformed config JSON", async () => {
  await writeConfig("{ not valid json");
  assert.match(errorOf(loadSsrfConfig), /Failed to parse .*web-search\.json/);
});
