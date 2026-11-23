import { RequestError } from "@agentclientprotocol/sdk";
import { type BoundaryValue, isBoundaryRecord } from "../boundary.ts";
import { getAuthMethods } from "./auth.ts";

export function maybeAuthRequiredError(err: BoundaryValue): RequestError | null {
  const message = isBoundaryRecord(err) ? err.message : undefined;
  const msg = String(message ?? err ?? "");
  const s = msg.toLowerCase();

  const patterns = [
    "api key",
    "apikey",
    "missing key",
    "no key",
    "not configured",
    "unauthorized",
    "authentication",
    "permission denied",
    "forbidden",
    "401",
    "403",
  ];

  const hit = patterns.some((p) => s.includes(p));
  if (!hit) return null;

  return RequestError.authRequired(
    {
      authMethods: getAuthMethods(),
    },
    "Configure an API key or log in with an OAuth provider.",
  );
}
