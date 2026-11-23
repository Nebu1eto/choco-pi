import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGY_CONSUMER_CLIENT,
  findAgyBinary,
  resolveClientCredentials,
  scanAgyBinary,
} from "../src/auth/client-credentials.ts";
import { AntigravityConfigError } from "../src/config.ts";
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_ID_2,
  FAKE_CLIENT_SECRET,
  FAKE_CLIENT_SECRET_2,
} from "./helpers.ts";

async function fakeBinary(dir: string, parts: readonly string[]): Promise<string> {
  const file = path.join(dir, "agy");
  const noise = Buffer.alloc(3 << 20, 0x41);
  // Place the second value across the 1 MiB read-chunk boundary to prove the overlap scan.
  const head = Buffer.from(`\u0000${parts[0] ?? ""}\u0000`, "latin1");
  const chunks = [head, noise.subarray(0, (1 << 20) - head.length - 20)];
  for (const part of parts.slice(1))
    chunks.push(Buffer.from(`\u0000${part}\u0000`, "latin1"), noise.subarray(0, 4096));
  await writeFile(file, Buffer.concat(chunks));
  await chmod(file, 0o755);
  return file;
}

test("scanAgyBinary streams the binary and finds values across chunk boundaries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-scan-"));
  const file = await fakeBinary(dir, [FAKE_CLIENT_ID, `${FAKE_CLIENT_SECRET}tail`, FAKE_CLIENT_ID]);
  const scan = await scanAgyBinary(file);
  assert.deepEqual(scan, { clientIds: [FAKE_CLIENT_ID], clientSecrets: [FAKE_CLIENT_SECRET] });
  await rm(dir, { recursive: true });
});

test("findAgyBinary honors the env override and then PATH", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-path-"));
  const file = await fakeBinary(dir, [FAKE_CLIENT_ID]);
  assert.equal(await findAgyBinary({ CHOCO_PI_ANTIGRAVITY_AGY_PATH: file }, undefined), file);
  assert.equal(await findAgyBinary({ PATH: dir }, undefined), file);
  assert.equal(await findAgyBinary({ PATH: path.join(dir, "missing") }, undefined), undefined);
  await rm(dir, { recursive: true });
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("login selects the fingerprinted client pair among several, asking nothing", async () => {
  // Fingerprinted pair listed second, as in agy, where file order does not identify it.
  const scan = async () => ({
    clientIds: [FAKE_CLIENT_ID, FAKE_CLIENT_ID_2],
    clientSecrets: [FAKE_CLIENT_SECRET, FAKE_CLIENT_SECRET_2],
  });
  const agyClient = {
    clientIdSha256: sha256(FAKE_CLIENT_ID_2),
    clientSecretSha256: sha256(FAKE_CLIENT_SECRET_2),
  };
  const chosen = await resolveClientCredentials({
    env: {},
    discoverFromAgy: true,
    agyClient,
    findAgyBinary: async () => "/fake/agy",
    scanAgyBinary: scan,
  });
  assert.deepEqual(chosen, {
    clientId: FAKE_CLIENT_ID_2,
    clientSecret: FAKE_CLIENT_SECRET_2,
    source: "agy",
  });
});

test("a binary without the fingerprinted pair fails without falling back to another client", async () => {
  const scan = async () => ({
    clientIds: [FAKE_CLIENT_ID, FAKE_CLIENT_ID_2],
    clientSecrets: [FAKE_CLIENT_SECRET, FAKE_CLIENT_SECRET_2],
  });
  for (const agyClient of [
    AGY_CONSUMER_CLIENT,
    // The right id with a secret from another client is still no match.
    { clientIdSha256: sha256(FAKE_CLIENT_ID), clientSecretSha256: sha256("GOCSPX-other") },
  ]) {
    await assert.rejects(
      resolveClientCredentials({
        env: {},
        discoverFromAgy: true,
        agyClient,
        findAgyBinary: async () => "/fake/agy",
        scanAgyBinary: scan,
      }),
      {
        name: AntigravityConfigError.name,
        message: /^(?!.*GOCSPX).*does not hold the agy consumer OAuth client/u,
      },
    );
  }
});

test("the shipped fingerprint is two SHA-256 digests, never a raw client value", () => {
  assert.match(AGY_CONSUMER_CLIENT.clientIdSha256, /^[0-9a-f]{64}$/u);
  assert.match(AGY_CONSUMER_CLIENT.clientSecretSha256, /^[0-9a-f]{64}$/u);
});

test("a half-configured source is an error, not a silent fallthrough", async () => {
  await assert.rejects(
    resolveClientCredentials({ env: { CHOCO_PI_ANTIGRAVITY_CLIENT_ID: FAKE_CLIENT_ID } }),
    /both/u,
  );
  await assert.rejects(
    resolveClientCredentials({ env: {}, config: { client_secret: "x" } }),
    /both/u,
  );
  assert.equal(await resolveClientCredentials({ env: {} }), undefined);
});
