import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
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

test("several candidates require an explicit choice; no choice cancels", async () => {
  const scan = async () => ({
    clientIds: [FAKE_CLIENT_ID, FAKE_CLIENT_ID_2],
    clientSecrets: [FAKE_CLIENT_SECRET, FAKE_CLIENT_SECRET_2],
  });
  const labels: string[][] = [];
  const chosen = await resolveClientCredentials({
    env: {},
    confirmAgyDiscovery: async () => true,
    findAgyBinary: async () => "/fake/agy",
    scanAgyBinary: scan,
    chooseCandidate: async (choice) => {
      labels.push(choice.labels);
      return 1;
    },
  });
  assert.deepEqual(chosen, {
    clientId: FAKE_CLIENT_ID_2,
    clientSecret: FAKE_CLIENT_SECRET_2,
    source: "agy",
  });
  assert.equal(
    labels[1]?.some((label) => label.includes("GOCSPX")),
    false,
  );
  await assert.rejects(
    resolveClientCredentials({
      env: {},
      confirmAgyDiscovery: async () => true,
      findAgyBinary: async () => "/fake/agy",
      scanAgyBinary: scan,
      chooseCandidate: async () => undefined,
    }),
    AntigravityConfigError,
  );
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
