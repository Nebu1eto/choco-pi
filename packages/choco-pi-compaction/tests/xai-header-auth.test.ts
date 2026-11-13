/**
 * Header-only xAI auth (D10): a provider configured with only an
 * `Authorization: Bearer` header classifies like its API key would (an
 * `xai-` key is api-key mode, anything else OAuth), and the foreground and
 * the backend agree, so the native lane runs instead of a credential cancel.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { xaiAuthModeFromAuth } from "../src/xai/capability.ts";
import { isXaiDetails } from "../src/xai/details.ts";
import {
  compactionsOf,
  compactResponse,
  createXaiRig,
  recordingFetch,
  textForeground,
} from "./xai-rig.ts";

const API_KEY_TOKEN = "xai-header-only-non-secret-placeholder";
const OAUTH_TOKEN = "eyJheader-only-non-secret-placeholder";

test("classification: the bearer header counts when no API key is resolved", () => {
  assert.equal(
    xaiAuthModeFromAuth({ headers: { Authorization: `Bearer ${API_KEY_TOKEN}` } }),
    "api-key",
  );
  assert.equal(
    xaiAuthModeFromAuth({ headers: { authorization: `Bearer ${OAUTH_TOKEN}` } }),
    "oauth",
  );
  assert.equal(xaiAuthModeFromAuth({ apiKey: API_KEY_TOKEN }), "api-key");
  assert.equal(xaiAuthModeFromAuth({ headers: {} }), undefined);
  assert.equal(xaiAuthModeFromAuth({}), undefined);
});

for (const [token, mode] of [
  [API_KEY_TOKEN, "api-key"],
  [OAUTH_TOKEN, "oauth"],
] as const) {
  test(
    `header-only Bearer ${mode} token: the native lane runs in ${mode} mode`,
    { timeout: 30_000 },
    async () => {
      const foreground = textForeground();
      const lane = recordingFetch(() => compactResponse());
      const rig = await createXaiRig({
        foreground,
        lane,
        auth: () => ({ ok: true, headers: { Authorization: `Bearer ${token}` } }),
      });
      try {
        await rig.session.prompt("XR-GO");
        await rig.session.compact();
        assert.equal(lane.sent.length, 1, "the compact endpoint was called");
        assert.equal(lane.sent[0]?.headers.get("authorization"), `Bearer ${token}`);
        const latest = compactionsOf(rig.manager).at(-1);
        assert.ok(latest && isXaiDetails(latest.details), "a native checkpoint, no cancel");
        // The backend's resolveRequest classified the same mode the foreground admitted.
        assert.equal(latest.details.scope.authMode, mode);
        assert.equal(
          rig.notices.some((notice) => /credentials/u.test(notice)),
          false,
          "no credential failure",
        );
      } finally {
        await rig.dispose();
      }
    },
  );
}
