// The ACP adapter keeps its own copy of the sensitive-path rules (it may not import across the
// package boundary). Both classifiers must withhold the same paths: one sample per category.
import assert from "node:assert/strict";
import test from "node:test";
import { isSensitiveDiffPath } from "../.pi/packages/choco-pi-acp/src/acp/native-diff.ts";
import { isSensitivePath } from "../.pi/extensions/lib/changes/sensitive.ts";

test("the two rules agree on names, path words, case and separators", () => {
  const samples = [
    ".env",
    ".env.local",
    "a/.ENV",
    "x.pem",
    "k.key",
    "c.p12",
    "c.pfx",
    "id_rsa.pub",
    "id_ed25519",
    "r.keystore",
    "auth.json",
    ".npmrc",
    ".netrc",
    "docs/Client-Secret.md",
    "CREDENTIALS/aws.txt",
    "a\\b\\.env",
    "public.txt",
    "env",
    "my.env",
    "authjson",
    "src/app.ts",
  ];
  for (const sample of samples) {
    assert.equal(isSensitiveDiffPath(sample), isSensitivePath(sample), sample);
  }
});
