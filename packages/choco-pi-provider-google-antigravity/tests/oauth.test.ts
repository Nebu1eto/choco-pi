import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthSelectPrompt,
} from "@earendil-works/pi-ai";
import {
  ANTIGRAVITY_TERMS_WARNING,
  antigravityAccountKey,
  buildAuthorizationUrl,
  createAntigravityOAuth,
  parseAntigravityApiKey,
  type AntigravityOAuthDeps,
} from "../src/auth/oauth.ts";
import { GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, OAUTH_SCOPES } from "../src/config.ts";
import { AntigravityError } from "../src/errors.ts";
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  fakeFetch,
  fixture,
  json,
  type RecordedCall,
} from "./helpers.ts";

const ENDPOINT = "https://cloudcode.test";
const REDIRECT = "https://antigravity.google/oauth-callback";
const FAKE_CODE = "4/0fake-authorization-code";
const FAKE_EMAIL = "fake.user@example.com";

async function agentDirWith(config?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-oauth-"));
  if (config !== undefined) await writeFile(path.join(dir, "google-antigravity.json"), config);
  return dir;
}

/** What the user pastes, given the authorize URL the login showed. */
type Paste = (authorizeUrl: URL) => string | Promise<string>;

interface LoginHarness {
  callbacks: OAuthLoginCallbacks;
  selects: OAuthSelectPrompt[];
  auths: OAuthAuthInfo[];
  prompts: OAuthPrompt[];
  manualInputs: number;
}

/**
 * Callbacks that answer the selects in order and paste `paste`'s text: through
 * onManualCodeInput when `manual` is set (the host has one), else through onPrompt.
 */
function harness(
  answers: readonly (string | undefined)[],
  paste: Paste,
  options: { signal?: AbortSignal; manual?: boolean } = {},
): LoginHarness {
  let answer = 0;
  const h: LoginHarness = {
    selects: [],
    auths: [],
    prompts: [],
    manualInputs: 0,
    callbacks: {
      onAuth(info) {
        h.auths.push(info);
      },
      onDeviceCode() {},
      onPrompt: async (prompt) => {
        h.prompts.push(prompt);
        return paste(new URL(h.auths[0]?.url ?? "https://invalid.test/"));
      },
      onSelect: async (prompt) => {
        h.selects.push(prompt);
        return answers[answer++];
      },
      signal: options.signal,
    },
  };
  if (options.manual) {
    h.callbacks.onManualCodeInput = async () => {
      h.manualInputs++;
      return paste(new URL(h.auths[0]?.url ?? "https://invalid.test/"));
    };
  }
  return h;
}

interface RouteOptions {
  refreshTokens?: string[];
  userinfo?: (call: RecordedCall) => Response;
}

function googleRoute(loadCodeAssist: string, options: RouteOptions = {}) {
  const refreshTokens = options.refreshTokens ?? ["fake-refresh-1"];
  let issued = 0;
  return (call: RecordedCall): Response => {
    if (call.url === GOOGLE_TOKEN_URL) {
      const form = new URLSearchParams(call.body);
      issued++;
      const refresh = refreshTokens[issued - 1];
      const refreshField = refresh === undefined ? "" : `,"refresh_token":"${refresh}"`;
      assert.ok(form.get("client_id") && form.get("client_secret"));
      return json(
        200,
        `{"access_token":"fake-access-${issued}","expires_in":3600,"token_type":"Bearer"${refreshField}}`,
      );
    }
    if (call.url === GOOGLE_USERINFO_URL) {
      return options.userinfo
        ? options.userinfo(call)
        : json(200, `{"id":"0","email":"${FAKE_EMAIL}","verified_email":true}`);
    }
    if (call.url === `${ENDPOINT}/v1internal:loadCodeAssist`) return json(200, loadCodeAssist);
    return json(404, '{"error":{"code":404,"status":"NOT_FOUND","message":"no route"}}');
  };
}

function deps(
  route: (call: RecordedCall) => Response,
  agentDir: string,
  env: Record<string, string | undefined>,
  extra: Partial<AntigravityOAuthDeps> = {},
) {
  const fake = fakeFetch(route);
  const value: AntigravityOAuthDeps = {
    fetch: fake.fetch,
    env,
    agentDir: async () => agentDir,
    endpoints: [ENDPOINT],
    now: () => 1_000_000,
    findAgyBinary: async () => undefined,
    ...extra,
  };
  return { fake, deps: value };
}

const ENV = {
  CHOCO_PI_ANTIGRAVITY_CLIENT_ID: FAKE_CLIENT_ID,
  CHOCO_PI_ANTIGRAVITY_CLIENT_SECRET: FAKE_CLIENT_SECRET,
};

const bareCode: Paste = () => FAKE_CODE;

function redirectWith(code: string, state?: string): Paste {
  return (url) =>
    `${REDIRECT}?state=${state ?? url.searchParams.get("state") ?? ""}&code=${encodeURIComponent(code)}&scope=openid`;
}

function legacyAccountKey(refresh: string): string {
  return createHash("sha256")
    .update(`google-antigravity-account:${refresh}`)
    .digest("hex")
    .slice(0, 32);
}

test("authorize URL: agy's endpoint, parameter order, scope list and encoding", () => {
  assert.equal(
    buildAuthorizationUrl(FAKE_CLIENT_ID, "fake-challenge", "fake-state"),
    "https://accounts.google.com/o/oauth2/auth?access_type=offline" +
      `&client_id=${FAKE_CLIENT_ID}` +
      "&code_challenge=fake-challenge&code_challenge_method=S256&prompt=consent" +
      "&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code" +
      "&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform" +
      "+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email" +
      "+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile" +
      "+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcclog" +
      "+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fexperimentsandconfigs" +
      "+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Faicode+openid" +
      "&state=fake-state",
  );
  assert.deepEqual(OAUTH_SCOPES, [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
    "https://www.googleapis.com/auth/aicode",
    "openid",
  ]);
});

test("terms warning has no hard line breaks, so the host can wrap it", () => {
  assert.equal(ANTIGRAVITY_TERMS_WARNING.includes("\n"), false);
  assert.match(ANTIGRAVITY_TERMS_WARNING, /consumer \(personal Google account\) OAuth access/u);
});

test("login: pasted code, PKCE exchange with the Antigravity redirect, userinfo email, project", async () => {
  const dir = await agentDirWith();
  const { fake, deps: d } = deps(googleRoute(await fixture("load-code-assist.json")), dir, ENV);
  const h = harness(["accept"], () => `  ${FAKE_CODE}\n`, { manual: true });
  const credentials = await createAntigravityOAuth(d).login(h.callbacks);

  assert.equal(h.selects[0]?.message, ANTIGRAVITY_TERMS_WARNING);
  assert.equal(h.auths.length, 1);
  assert.match(h.auths[0]?.instructions ?? "", /Antigravity page/u);
  assert.equal(h.manualInputs, 1);
  assert.equal(h.prompts.length, 0, "the manual code input is the only prompt");
  const auth = new URL(h.auths[0]?.url ?? "");
  assert.equal(`${auth.origin}${auth.pathname}`, "https://accounts.google.com/o/oauth2/auth");
  assert.deepEqual(
    [...auth.searchParams.keys()],
    [
      "access_type",
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "prompt",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ],
  );
  assert.equal(auth.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(auth.searchParams.get("scope"), OAUTH_SCOPES.join(" "));
  assert.ok((auth.searchParams.get("state") ?? "").length >= 32);

  assert.deepEqual(
    fake.calls.map((call) => call.url),
    [GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, `${ENDPOINT}/v1internal:loadCodeAssist`],
  );
  const exchange = new URLSearchParams(fake.calls[0]?.body);
  assert.equal(exchange.get("grant_type"), "authorization_code");
  assert.equal(exchange.get("code"), FAKE_CODE, "surrounding whitespace is trimmed");
  assert.equal(exchange.get("redirect_uri"), REDIRECT);
  const verifier = exchange.get("code_verifier") ?? "";
  assert.ok(verifier.length >= 43);
  assert.equal(
    createHash("sha256").update(verifier).digest("base64url"),
    auth.searchParams.get("code_challenge"),
  );
  assert.equal(fake.calls[1]?.headers.get("authorization"), "Bearer fake-access-1");
  assert.equal(fake.calls[2]?.body, '{"metadata":{"ideType":"ANTIGRAVITY"}}');
  assert.equal(fake.calls[2]?.headers.get("authorization"), "Bearer fake-access-1");
  assert.match(
    fake.calls[2]?.headers.get("user-agent") ?? "",
    /^antigravity\/cli\/1\.5\.14 \(aidev_client; os_type=/u,
  );

  assert.equal(credentials.refresh, "fake-refresh-1");
  assert.equal(credentials.access, "fake-access-1");
  assert.equal(credentials.expires, 1_000_000 + 3600_000 - 300_000);
  assert.equal(credentials["email"], FAKE_EMAIL);
  assert.equal(credentials["project_id"], "aicode-consumers");
  assert.equal(credentials["tier_id"], "free-tier");
  assert.equal(credentials["paid_tier_name"], "Google AI Ultra");
  assert.equal(credentials["client_source"], "env");
  assert.equal(credentials["client_secret"], undefined);
  assert.equal(JSON.stringify(credentials).includes(FAKE_CLIENT_SECRET), false);
  assert.equal(JSON.stringify(credentials).includes(FAKE_CODE), false);

  const oauth = createAntigravityOAuth(d);
  const key = parseAntigravityApiKey(oauth.getApiKey(credentials));
  assert.deepEqual(key, {
    token: "fake-access-1",
    projectId: "aicode-consumers",
    accountKey: antigravityAccountKey({ refresh: "fake-refresh-1", email: FAKE_EMAIL }),
  });
  assert.match(key.accountKey ?? "", /^[0-9a-f]{32}$/u);
  assert.equal(oauth.getApiKey(credentials).includes(FAKE_EMAIL), false);
  assert.notEqual(key.accountKey, legacyAccountKey("fake-refresh-1"));
  await rm(dir, { recursive: true });
});

test("login: a pasted redirect URL with the right state works through the one onPrompt", async () => {
  const dir = await agentDirWith();
  const { fake, deps: d } = deps(googleRoute(await fixture("load-code-assist.json")), dir, ENV);
  const h = harness(["accept"], redirectWith(FAKE_CODE));
  const credentials = await createAntigravityOAuth(d).login(h.callbacks);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.manualInputs, 0);
  assert.equal(new URLSearchParams(fake.calls[0]?.body).get("code"), FAKE_CODE);
  assert.equal(credentials.refresh, "fake-refresh-1");
  await rm(dir, { recursive: true });
});

test("login: a percent-encoded bare code is decoded", async () => {
  const dir = await agentDirWith();
  const { fake, deps: d } = deps(googleRoute(await fixture("load-code-assist.json")), dir, ENV);
  const h = harness(["accept"], () => encodeURIComponent(FAKE_CODE), { manual: true });
  await createAntigravityOAuth(d).login(h.callbacks);
  assert.equal(new URLSearchParams(fake.calls[0]?.body).get("code"), FAKE_CODE);
  await rm(dir, { recursive: true });
});

test("login: state mismatch, empty paste and a denied redirect fail as auth errors with no token request", async () => {
  const dir = await agentDirWith();
  const cases: { paste: Paste; message: RegExp }[] = [
    { paste: redirectWith(FAKE_CODE, "wrong-state"), message: /state mismatch/u },
    { paste: () => "   \n", message: /no authorization code was pasted/u },
    {
      paste: () => `${REDIRECT}?error=access_denied`,
      message: /authorization failed: access_denied/u,
    },
    { paste: () => `${REDIRECT}?scope=openid`, message: /contains no authorization code/u },
  ];
  for (const manual of [true, false]) {
    for (const { paste, message } of cases) {
      const { fake, deps: d } = deps(googleRoute("{}"), dir, ENV);
      const h = harness(["accept"], paste, { manual });
      await assert.rejects(createAntigravityOAuth(d).login(h.callbacks), (error) => {
        assert.ok(error instanceof AntigravityError);
        assert.equal(error.kind, "auth");
        assert.match(error.message, message);
        assert.equal(error.message.includes(FAKE_CODE), false, "the code is never echoed");
        return true;
      });
      assert.equal(h.prompts.length + h.manualInputs, 1);
      assert.equal(fake.calls.length, 0);
    }
  }
  await rm(dir, { recursive: true });
});

test("login: declining the terms aborts before any network or browser step", async () => {
  const dir = await agentDirWith();
  const { fake, deps: d } = deps(googleRoute("{}"), dir, ENV);
  for (const answer of ["decline", undefined]) {
    const h = harness([answer], bareCode);
    await assert.rejects(
      createAntigravityOAuth(d).login(h.callbacks),
      /terms warning was not accepted/u,
    );
    assert.equal(h.auths.length, 0);
    assert.equal(h.prompts.length + h.manualInputs, 0);
  }
  assert.equal(fake.calls.length, 0);
  await rm(dir, { recursive: true });
});

test("login: abort during the code prompt rejects once and never requests a token", async () => {
  const dir = await agentDirWith();
  for (const manual of [true, false]) {
    // Count raw attempts: fakeFetch drops an aborted call before recording it.
    let attempts = 0;
    const { fake } = deps(googleRoute("{}"), dir, ENV);
    const { deps: d } = deps(googleRoute("{}"), dir, ENV, {
      fetch: (input, init) => {
        attempts++;
        return fake.fetch(input, init);
      },
    });
    const controller = new AbortController();
    let release: (value: string) => void = () => {};
    const pasted = new Promise<string>((resolve) => {
      release = resolve;
    });
    const h = harness(
      ["accept"],
      () => {
        setTimeout(() => controller.abort(new Error("user cancelled")), 5);
        return pasted;
      },
      { signal: controller.signal, manual },
    );
    let settlements = 0;
    const login = createAntigravityOAuth(d)
      .login(h.callbacks)
      .finally(() => {
        settlements++;
      });
    await assert.rejects(login, /user cancelled/u);
    // The host prompt answering after the abort changes nothing.
    release(FAKE_CODE);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settlements, 1);
    assert.equal(h.prompts.length + h.manualInputs, 1);
    assert.equal(attempts, 0);
  }
  await rm(dir, { recursive: true });
});

test("login: an abort before the browser step never shows the URL or prompts", async () => {
  const dir = await agentDirWith();
  const controller = new AbortController();
  const { fake, deps: d } = deps(googleRoute("{}"), dir, ENV, {
    readFile: async () => {
      controller.abort(new Error("cancelled early"));
      return "{}";
    },
  });
  const h = harness(["accept"], bareCode, { signal: controller.signal, manual: true });
  await assert.rejects(createAntigravityOAuth(d).login(h.callbacks), /cancelled early/u);
  assert.equal(h.auths.length, 0);
  assert.equal(h.manualInputs, 0);
  assert.equal(fake.calls.length, 0);
  await rm(dir, { recursive: true });
});

test("login: a userinfo failure is not fatal; the account key falls back to the refresh token", async () => {
  const dir = await agentDirWith();
  const load = await fixture("load-code-assist.json");
  const failures: ((call: RecordedCall) => Response)[] = [
    () => json(401, '{"error":{"code":401,"message":"fake"}}'),
    () => json(200, "not json"),
    () => json(200, '{"email":"not an email"}'),
    () => {
      throw new TypeError("fake network failure");
    },
  ];
  for (const userinfo of failures) {
    const { fake, deps: d } = deps(googleRoute(load, { userinfo }), dir, ENV);
    const credentials = await createAntigravityOAuth(d).login(
      harness(["accept"], bareCode).callbacks,
    );
    assert.equal(credentials["email"], undefined);
    assert.equal(credentials["project_id"], "aicode-consumers");
    assert.equal(fake.calls.length, 3);
    assert.equal(
      parseAntigravityApiKey(createAntigravityOAuth(d).getApiKey(credentials)).accountKey,
      legacyAccountKey("fake-refresh-1"),
    );
  }
  await rm(dir, { recursive: true });
});

test("login: Google returning no refresh token is an auth error", async () => {
  const dir = await agentDirWith();
  const { deps: d } = deps(
    googleRoute(await fixture("load-code-assist.json"), { refreshTokens: [] }),
    dir,
    ENV,
  );
  await assert.rejects(
    createAntigravityOAuth(d).login(harness(["accept"], bareCode).callbacks),
    (error) => {
      assert.ok(error instanceof AntigravityError);
      assert.equal(error.kind, "auth");
      assert.match(error.message, /no refresh token/u);
      return true;
    },
  );
  await rm(dir, { recursive: true });
});

test("account key: prefers the email, is stable across refresh-token rotation, keeps old credentials", () => {
  const withEmail = antigravityAccountKey({ refresh: "fake-refresh-1", email: FAKE_EMAIL });
  assert.equal(antigravityAccountKey({ refresh: "fake-refresh-2", email: FAKE_EMAIL }), withEmail);
  assert.equal(
    antigravityAccountKey({ refresh: "fake-refresh-1", email: " Fake.User@Example.com " }),
    withEmail,
  );
  assert.notEqual(
    antigravityAccountKey({ refresh: "fake-refresh-1", email: "other.fake@example.com" }),
    withEmail,
  );
  assert.equal(
    antigravityAccountKey({ refresh: "fake-refresh-1" }),
    legacyAccountKey("fake-refresh-1"),
  );
  assert.notEqual(
    antigravityAccountKey({ refresh: "fake-refresh-2" }),
    legacyAccountKey("fake-refresh-1"),
  );
  assert.equal(withEmail.includes("fake"), false);
});

test("client source order: env beats config, config beats agy; agy needs opt-in", async () => {
  const config = JSON.stringify({
    client_id: "222222222222-config.apps.googleusercontent.com",
    client_secret: "config-secret-fake",
  });
  const dir = await agentDirWith(config);
  const load = await fixture("load-code-assist.json");

  const envRun = deps(googleRoute(load), dir, ENV);
  const envCreds = await createAntigravityOAuth(envRun.deps).login(
    harness(["accept"], bareCode).callbacks,
  );
  assert.equal(envCreds["client_source"], "env");
  assert.equal(new URLSearchParams(envRun.fake.calls[0]?.body).get("client_id"), FAKE_CLIENT_ID);

  const configRun = deps(googleRoute(load), dir, {});
  const configCreds = await createAntigravityOAuth(configRun.deps).login(
    harness(["accept"], bareCode).callbacks,
  );
  assert.equal(configCreds["client_source"], "config");
  assert.equal(configCreds["client_secret"], undefined);
  assert.equal(JSON.stringify(configCreds).includes("config-secret-fake"), false);

  const empty = await agentDirWith();
  let scanned = 0;
  const agyRun = deps(
    googleRoute(load),
    empty,
    {},
    {
      findAgyBinary: async () => "/fake/agy",
      scanAgyBinary: async () => {
        scanned++;
        return { clientIds: [FAKE_CLIENT_ID], clientSecrets: [FAKE_CLIENT_SECRET] };
      },
    },
  );
  const declined = harness(["accept", "cancel"], bareCode);
  await assert.rejects(
    createAntigravityOAuth(agyRun.deps).login(declined.callbacks),
    /No Google Antigravity OAuth client/u,
  );
  assert.equal(scanned, 0);
  assert.equal(agyRun.fake.calls.length, 0);

  const agyCreds = await createAntigravityOAuth(agyRun.deps).login(
    harness(["accept", "scan"], bareCode).callbacks,
  );
  assert.equal(scanned, 1);
  assert.equal(agyCreds["client_source"], "agy");
  assert.equal(agyCreds["client_id"], FAKE_CLIENT_ID);
  assert.equal(agyCreds["client_secret"], FAKE_CLIENT_SECRET);
  await rm(dir, { recursive: true });
  await rm(empty, { recursive: true });
});

function storedCredential(extra: Record<string, string>): OAuthCredentials {
  return {
    refresh: "old-refresh",
    access: "old-access",
    expires: 0,
    project_id: "aicode-consumers",
    ...extra,
  };
}

test("refresh: rotation keeps the new refresh token, absence keeps the old one, agy pair never rescans", async () => {
  const dir = await agentDirWith();
  let scanned = 0;
  const run = deps(
    googleRoute("{}", { refreshTokens: ["rotated-refresh"] }),
    dir,
    {},
    {
      scanAgyBinary: async () => {
        scanned++;
        return { clientIds: [], clientSecrets: [] };
      },
    },
  );
  const oauth = createAntigravityOAuth(run.deps);
  const agy = {
    client_source: "agy",
    client_id: FAKE_CLIENT_ID,
    client_secret: FAKE_CLIENT_SECRET,
  };
  const rotated = await oauth.refreshToken(storedCredential(agy), new AbortController().signal);
  assert.equal(rotated.refresh, "rotated-refresh");
  assert.equal(rotated.access, "fake-access-1");
  assert.equal(rotated["client_secret"], FAKE_CLIENT_SECRET);
  const form = new URLSearchParams(run.fake.calls[0]?.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "old-refresh");
  const kept = await oauth.refreshToken(storedCredential(agy), new AbortController().signal);
  assert.equal(kept.refresh, "old-refresh");
  assert.equal(kept["project_id"], "aicode-consumers");
  assert.equal(scanned, 0);
  assert.equal(run.fake.calls.length, 2);
  await rm(dir, { recursive: true });
});

test("refresh: the stored email survives refresh-token rotation, and so does the account key", async () => {
  const dir = await agentDirWith();
  const run = deps(googleRoute("{}", { refreshTokens: ["rotated-refresh"] }), dir, ENV);
  const oauth = createAntigravityOAuth(run.deps);
  const before = storedCredential({
    client_source: "env",
    client_id: FAKE_CLIENT_ID,
    email: FAKE_EMAIL,
  });
  const after = await oauth.refreshToken(before, new AbortController().signal);
  assert.equal(after.refresh, "rotated-refresh");
  assert.equal(after["email"], FAKE_EMAIL);
  assert.equal(
    run.fake.calls.some((call) => call.url === GOOGLE_USERINFO_URL),
    false,
    "refresh does not call userinfo",
  );
  assert.equal(
    parseAntigravityApiKey(oauth.getApiKey(after)).accountKey,
    parseAntigravityApiKey(oauth.getApiKey(before)).accountKey,
  );
  await rm(dir, { recursive: true });
});

test("refresh: env client is re-read; a changed client id or a revoked token needs /login", async () => {
  const dir = await agentDirWith();
  const run = deps(
    (call) =>
      call.url === GOOGLE_TOKEN_URL
        ? json(
            400,
            '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
          )
        : json(404, "{}"),
    dir,
    ENV,
  );
  const oauth = createAntigravityOAuth(run.deps);
  await assert.rejects(
    oauth.refreshToken(
      storedCredential({
        client_source: "env",
        client_id: "999999-other.apps.googleusercontent.com",
      }),
      new AbortController().signal,
    ),
    /configured OAuth client changed/u,
  );
  assert.equal(run.fake.calls.length, 0);
  await assert.rejects(
    oauth.refreshToken(
      storedCredential({ client_source: "env", client_id: FAKE_CLIENT_ID }),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof AntigravityError &&
      error.kind === "auth" &&
      /revoked or expired/u.test(error.message),
  );
  await rm(dir, { recursive: true });
});

test("api key: malformed values are rejected without echoing them", () => {
  for (const input of ["not json", '{"token":"t"}', '{"token":"a b","project_id":"p"}']) {
    assert.throws(
      () => parseAntigravityApiKey(input),
      (error) => error instanceof Error && !error.message.includes(input),
    );
  }
  assert.throws(
    () => createAntigravityOAuth().getApiKey({ refresh: "r", access: "a", expires: 0 }),
    /no project/u,
  );
});
