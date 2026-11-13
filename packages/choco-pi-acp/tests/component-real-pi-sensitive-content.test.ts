import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createRealPiRpcHarness } from "./component-rpc-harness.ts";

// Opt-in: drives a real Pi process. The repository is a scratch one whose diffs contain
// every-day credential words and a .env file whose contents must never leave Pi.
const ENV_MARKER_COMMITTED = "ENV-MARKER-COMMITTED-51a7";
const ENV_MARKER_UNCOMMITTED = "ENV-MARKER-UNCOMMITTED-83c0";
const AUTH_WARNING = /Pi requested sensitive authentication or credential input/u;

const execFileAsync = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, env: GIT_ENV });
}

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

test(
  "real Pi: /review-assist and /diff show code with credential words and never send .env contents",
  { skip: process.env.PI_ACP_REAL_PI !== "1", timeout: 90_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "choco-pi-acp-sensitive-")));
    try {
      await git(root, "init", "-q", "-b", "main");
      await put(root, "src/auth.ts", "export const ready = true;\n");
      await put(root, ".env", "PLACEHOLDER=1\n");
      await git(root, "add", "-A");
      await git(root, "commit", "-q", "-m", "base");
      await git(root, "checkout", "-q", "-b", "feature");
      await put(
        root,
        "src/auth.ts",
        "export async function login(password: string, token: string) {\n  return { secret: password, api_key: token };\n}\n",
      );
      await put(root, ".env", `API_TOKEN=${ENV_MARKER_COMMITTED}\n`);
      await git(root, "commit", "-q", "-am", "change");
      await put(root, "src/token-store.ts", "export const credential = 'private key';\n");
      await put(root, ".env", `API_TOKEN=${ENV_MARKER_UNCOMMITTED}\n`);

      const harness = createRealPiRpcHarness(root);
      try {
        const { sessionId } = await harness.agent.newSession({ cwd: root, mcpServers: [] });
        const prompt = (text: string) =>
          harness.agent.prompt({ sessionId, prompt: [{ type: "text", text }] });

        const reviewFrom = harness.client.updates.length;
        assert.deepEqual(await prompt("/review-assist branch main HEAD"), {
          stopReason: "end_turn",
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const reviewText = harness.client.updates
          .slice(reviewFrom)
          .flatMap(({ update }) =>
            update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
              ? [update.content.text]
              : [],
          )
          .join("\n");
        assert.doesNotMatch(
          reviewText,
          AUTH_WARNING,
          "/review-assist must not be replaced by an auth warning",
        );
        assert.match(reviewText, /Review:/u);
        assert.match(reviewText, /login\(password: string, token: string\)/u, "the diff is shown");

        const diffFrom = harness.client.updates.length;
        assert.deepEqual(await prompt("/diff"), { stopReason: "end_turn" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const diffUpdates = JSON.stringify(harness.client.updates.slice(diffFrom));
        assert.doesNotMatch(
          diffUpdates,
          AUTH_WARNING,
          "/diff must not be replaced by an auth warning",
        );
        assert.match(diffUpdates, /token-store\.ts/u, "/diff lists the changed files");

        const everything = JSON.stringify(harness.client.updates);
        assert.ok(
          !everything.includes(ENV_MARKER_COMMITTED),
          "committed .env contents never reach ACP",
        );
        assert.ok(
          !everything.includes(ENV_MARKER_UNCOMMITTED),
          "uncommitted .env contents never reach ACP",
        );
      } finally {
        await harness.agent.shutdown(1_000);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
