import { randomUUID } from "node:crypto";
import { isObject, isString, type RuntimeValue } from "./runtime-values.ts";

// Official wire contract (not a public, versioned REST API):
// https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs
const RESET_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export class CodexResetError extends Error {}

export type CodexReset = { id: string; expiresAt: string };
export type CodexResetClient = {
  accountId: string;
  list(): Promise<CodexReset[]>;
  consume(creditId: string, requestId: string): Promise<string>;
};

function record(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null && !Array.isArray(value);
}

export function createCodexResetClient(
  token: string,
  accountId: string,
  fetcher: typeof fetch = fetch,
): CodexResetClient {
  const request = async (body?: { credit_id: string; redeem_request_id: string }) => {
    let response: Response;
    try {
      response = await fetcher(body ? `${RESET_URL}/consume` : RESET_URL, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "ChatGPT-Account-ID": accountId,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch {
      throw new CodexResetError(
        body
          ? "Reset outcome unknown. Check usage before retrying."
          : "Could not load saved resets.",
      );
    }
    if (!response.ok)
      throw new CodexResetError(
        `Reset service returned HTTP ${response.status}.${body ? " Check usage before retrying." : ""}`,
      );
    try {
      const payload: RuntimeValue = await response.json();
      return payload;
    } catch {
      throw new CodexResetError(
        body
          ? "Reset outcome unknown. Check usage before retrying."
          : "Invalid saved-reset response.",
      );
    }
  };
  return {
    accountId,
    async list() {
      const payload = await request();
      if (!record(payload) || !Array.isArray(payload.credits))
        throw new CodexResetError("Invalid saved-reset response.");
      return payload.credits
        .flatMap((credit): CodexReset[] => {
          if (
            !record(credit) ||
            credit.status !== "available" ||
            !isString(credit.id) ||
            !credit.id
          )
            return [];
          if (credit.expires_at == null) return [{ id: credit.id, expiresAt: "not specified" }];
          if (
            !isString(credit.expires_at) ||
            !Number.isFinite(Date.parse(credit.expires_at)) ||
            Date.parse(credit.expires_at) <= Date.now()
          )
            return [];
          return [{ id: credit.id, expiresAt: new Date(credit.expires_at).toISOString() }];
        })
        .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    },
    async consume(creditId, requestId) {
      const payload = await request({ credit_id: creditId, redeem_request_id: requestId });
      if (!record(payload) || !isString(payload.code))
        throw new CodexResetError("Reset outcome unknown. Check usage before retrying.");
      return payload.code;
    },
  };
}

const activeAccounts = new Set<string>();
const pendingRequests = new Map<string, string>();
const OUTCOMES = new Map([
  ["reset", "Codex reset applied."],
  ["already_redeemed", "This Codex reset was already redeemed."],
  ["nothing_to_reset", "No eligible usage window to reset; no reset was spent."],
  ["no_credit", "No saved Codex reset is available."],
]);

async function refreshAfterReset(refresh: () => Promise<void>): Promise<void> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error("Usage refresh timed out.")), 10_000);
  try {
    await Promise.race([refresh(), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runCodexResetFlow(options: {
  client: CodexResetClient;
  select(title: string, choices: string[]): Promise<string | undefined>;
  isCurrent(): boolean;
  refresh(): Promise<void>;
}): Promise<string | undefined> {
  const { client, select, isCurrent, refresh } = options;
  const accountId = client.accountId;
  if (activeAccounts.has(accountId)) return "A Codex reset action is already in progress.";
  activeAccounts.add(accountId);
  try {
    const resets = await client.list();
    if (!isCurrent()) return;
    if (resets.length === 0) return "No saved Codex reset is available.";
    const labels = resets.map((reset, index) => `Reset ${index + 1} — expires ${reset.expiresAt}`);
    const selected = await select("Saved Codex resets (earliest expiry first)", [
      "Cancel",
      ...labels,
    ]);
    if (!isCurrent()) return;
    const reset = selected ? resets[labels.indexOf(selected)] : undefined;
    if (!reset) return;
    const confirmed = await select(
      `Spend this saved reset? Eligible Codex usage windows will reset. This cannot be undone.\nExpires ${reset.expiresAt}`,
      ["Cancel", "Use reset"],
    );
    if (!isCurrent() || confirmed !== "Use reset") return;
    const key = JSON.stringify([accountId, reset.id]);
    const requestId = pendingRequests.get(key) ?? randomUUID();
    pendingRequests.set(key, requestId);
    // No automatic POST retries. An explicit retry keeps the same idempotency key.
    let message: string;
    try {
      const code = await client.consume(reset.id, requestId);
      if (OUTCOMES.has(code)) pendingRequests.delete(key);
      message = OUTCOMES.get(code) ?? "Unknown reset outcome. Check usage before retrying.";
    } catch (error) {
      if (!(error instanceof CodexResetError)) throw error;
      message = error.message;
    }
    if (!isCurrent()) return;
    try {
      await refreshAfterReset(refresh);
    } catch {
      message += " Usage refresh failed; displayed data may be stale.";
    }
    if (!isCurrent()) return;
    return message;
  } finally {
    activeAccounts.delete(accountId);
  }
}
