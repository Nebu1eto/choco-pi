import { createHash } from "node:crypto";
import { isJsonRecord, isString, type RuntimeValue } from "./runtime-values.ts";

export const CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** Minimal model metadata shape for identifying Codex, OpenAI Responses, and Copilot GPT transports. */
export interface CodexLikeModelDescriptor {
  provider: string;
  api: string;
  id: string;
  baseUrl: string;
}

/** Extension context projection exposing the active model descriptor for transport predicate checks. */
export interface ModelContextLike {
  readonly model?: Partial<CodexLikeModelDescriptor> | null | undefined;
}

export function isOpenAICodexModel(
  model: Partial<CodexLikeModelDescriptor> | null | undefined,
): boolean {
  if (!model) return false;
  return (model.provider ?? "").toLowerCase() === "openai-codex";
}

export function isCanonicalCodexBaseUrl(value: string | null | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, "");
    return (
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (pathname === "/backend-api" || pathname === "/backend-api/codex")
    );
  } catch {
    return false;
  }
}

export function isCanonicalCodexSubscriptionModel(
  model: Partial<CodexLikeModelDescriptor> | null | undefined,
): boolean {
  return Boolean(
    model && model.api === "openai-codex-responses" && isCanonicalCodexBaseUrl(model.baseUrl),
  );
}

export function isCanonicalCodexAliasModel(
  model: Partial<CodexLikeModelDescriptor> | null | undefined,
): boolean {
  return !isOpenAICodexModel(model) && isCanonicalCodexSubscriptionModel(model);
}

export function canonicalCodexAliasModelKey(model: Partial<CodexLikeModelDescriptor>): string {
  return JSON.stringify([model.provider, model.api, model.id, model.baseUrl]);
}

export function isCodexTransportModel(
  model: Partial<CodexLikeModelDescriptor> | null | undefined,
): boolean {
  return isOpenAICodexModel(model) || isCanonicalCodexSubscriptionModel(model);
}

export function isResponsesModel(
  model: Partial<CodexLikeModelDescriptor> | null | undefined,
): boolean {
  if (!model) return false;
  return (model.api ?? "").toLowerCase().includes("responses");
}

export function isCodexLikeModel(
  model: Partial<CodexLikeModelDescriptor> | null | undefined,
): boolean {
  if (!model) return false;
  const provider = (model.provider ?? "").toLowerCase();
  const api = (model.api ?? "").toLowerCase();
  const id = (model.id ?? "").toLowerCase();
  const isCopilotGpt =
    (provider.includes("copilot") || api.includes("copilot")) && id.includes("gpt");
  return (
    provider.includes("codex") ||
    api.includes("codex") ||
    id.includes("codex") ||
    (provider.includes("openai") && id.includes("gpt")) ||
    isCopilotGpt
  );
}

export function isCanonicalCodexSubscriptionContext(ctx: ModelContextLike): boolean {
  return isCanonicalCodexSubscriptionModel(ctx.model);
}

export function isOpenAICodexContext(ctx: ModelContextLike): boolean {
  return isOpenAICodexModel(ctx.model);
}

export function isCodexTransportContext(ctx: ModelContextLike): boolean {
  return isOpenAICodexContext(ctx) || isCanonicalCodexSubscriptionContext(ctx);
}

export function isResponsesContext(ctx: ModelContextLike): boolean {
  return isResponsesModel(ctx.model);
}

export function isOpenAIResponsesContext(ctx: ModelContextLike): boolean {
  return (ctx.model?.api ?? "").trim().toLowerCase() === "openai-responses";
}

export function codexBackgroundAccountScope(accountId: string): string {
  return `sha256:${createHash("sha256").update(accountId).digest("hex")}`;
}

export function extractCodexAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const parsed: RuntimeValue = JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString("utf8"));
    if (!isJsonRecord(parsed)) throw new Error("No account ID in token");
    const authClaim = parsed[CODEX_JWT_CLAIM_PATH];
    if (!isJsonRecord(authClaim)) throw new Error("No account ID in token");
    const accountId = authClaim["chatgpt_account_id"];
    if (!isString(accountId) || accountId.length === 0) throw new Error("No account ID in token");
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from token");
  }
}
