/** Shared bearer-credential classifier (D10): API key first, then an Authorization: Bearer header. */
import assert from "node:assert/strict";
import test from "node:test";

import { bearerCredentialOf } from "../src/auth.ts";

test("a non-empty apiKey wins over an Authorization header", () => {
  assert.equal(
    bearerCredentialOf({ apiKey: " key-1 ", headers: { Authorization: "Bearer header-1" } }),
    "key-1",
  );
});

test("a header-only bearer token is the credential", () => {
  assert.equal(bearerCredentialOf({ headers: { authorization: "Bearer token-1" } }), "token-1");
  assert.equal(
    bearerCredentialOf({ headers: { authorization: "  bearer   token-2  " } }),
    "token-2",
  );
});

test("the header name is case-insensitive", () => {
  assert.equal(bearerCredentialOf({ headers: { AUTHORIZATION: "Bearer token-3" } }), "token-3");
});

test("a null or undefined header value carries no credential", () => {
  assert.equal(bearerCredentialOf({ headers: { Authorization: null } }), undefined);
  assert.equal(bearerCredentialOf({ headers: { Authorization: undefined } }), undefined);
});

test("an empty apiKey and no header carry no credential", () => {
  assert.equal(bearerCredentialOf({ apiKey: "" }), undefined);
  assert.equal(bearerCredentialOf({ apiKey: "   ", headers: {} }), undefined);
  assert.equal(bearerCredentialOf(undefined), undefined);
});

test("a non-Bearer scheme or an empty token carries no credential", () => {
  assert.equal(bearerCredentialOf({ headers: { Authorization: "Basic dXNlcjpwdw==" } }), undefined);
  assert.equal(bearerCredentialOf({ headers: { Authorization: "Bearer" } }), undefined);
  assert.equal(bearerCredentialOf({ headers: { Authorization: "Bearer a b" } }), undefined);
  assert.equal(bearerCredentialOf({ headers: { Authorization: "" } }), undefined);
});
