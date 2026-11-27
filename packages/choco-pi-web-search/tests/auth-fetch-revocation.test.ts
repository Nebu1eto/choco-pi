import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-auth-fetch-revocation-"));
const configPath = join(agentDir, "web-search.json");
process.env.PI_CODING_AGENT_DIR = agentDir;
await writeFile(
  configPath,
  JSON.stringify({ authFetch: { work: { hosts: ["docs.company.com"] } } }) + "\n",
  "utf8",
);

const { resolveAuthFetchProfile } = await import("../auth-fetch.ts");
const { getCachedWebSearchConfig } = await import("../config-loader.ts");

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

test("authFetch profile removed on disk is revoked without a cache refresh", async () => {
  await writeFile(
    configPath,
    JSON.stringify({ authFetch: { work: { hosts: ["docs.company.com"] } } }) + "\n",
    "utf8",
  );
  const profile = await resolveAuthFetchProfile("work");
  assert.deepEqual(profile.hosts, ["docs.company.com"]);

  await writeFile(
    configPath,
    JSON.stringify({ authFetch: { other: ["other.example"] } }) + "\n",
    "utf8",
  );
  assert.ok(JSON.stringify(getCachedWebSearchConfig()).includes("docs.company.com"));
  await assert.rejects(resolveAuthFetchProfile("work"), /Unknown authFetch profile: work/);

  await writeFile(configPath, JSON.stringify({}) + "\n", "utf8");
  await assert.rejects(resolveAuthFetchProfile(true), /requires at least one authFetch profile/);
});

test("malformed or non-object config fails closed for authenticated fetch", async () => {
  await writeFile(configPath, "{ not json", "utf8");
  await assert.rejects(resolveAuthFetchProfile("work"), /Failed to parse/);
  await assert.rejects(resolveAuthFetchProfile(true), /Failed to parse/);

  await writeFile(configPath, JSON.stringify(["not", "an", "object"]) + "\n", "utf8");
  await assert.rejects(resolveAuthFetchProfile("work"), /expected a JSON object/);
});

test("a missing config means no authFetch profiles are configured", async () => {
  await rm(configPath, { force: true });
  await assert.rejects(resolveAuthFetchProfile("work"), /requires at least one authFetch profile/);
});
