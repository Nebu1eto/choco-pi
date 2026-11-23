import { readFile } from "node:fs/promises";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { FetchLike } from "../src/client/http.ts";
import type { AntigravitySignInRegistry } from "../src/auth/sign-in.ts";

export type GoogleSignIn = "oauth" | "stored_api_key" | "env_api_key" | "none";

const SIGN_IN_MODEL: Model<Api> = {
  id: "gemini-3.8-flash",
  name: "Gemini 3.8 Flash",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 65_536,
};

export function signInRegistry(signIn: () => GoogleSignIn): AntigravitySignInRegistry {
  return {
    getProviderAuthStatus: (provider) => {
      const state = signIn();
      if (provider !== "google" || state === "none") return { configured: false };
      return { configured: true, source: state === "env_api_key" ? "environment" : "stored" };
    },
    getAll: () => [SIGN_IN_MODEL],
    isUsingOAuth: (model) => model.provider === "google" && signIn() === "oauth",
  };
}

export interface RecordedCall {
  url: string;
  body: string;
  headers: Headers;
}

export type Route = (call: RecordedCall) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: FetchLike;
  calls: RecordedCall[];
}

export function fakeFetch(route: Route): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    init.signal?.throwIfAborted();
    const call = {
      url: input,
      body: init.body === undefined || init.body === null ? "" : String(init.body),
      headers: new Headers(init.headers),
    };
    calls.push(call);
    return route(call);
  };
  return { fetch, calls };
}

export function json(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

export function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export function assistantError(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "google-generative-ai",
    provider: "google",
    model: "gemini-3.8-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: 0,
  };
}

export const FAKE_CLIENT_ID = `000000000000-${"fake".repeat(8)}.apps.googleusercontent.com`;
export const FAKE_CLIENT_SECRET = `GOCSPX-${"FAKE".repeat(7)}`;
export const FAKE_CLIENT_ID_2 = `111111111111-${"fake".repeat(8)}.apps.googleusercontent.com`;
export const FAKE_CLIENT_SECRET_2 = `GOCSPX-${"TEST".repeat(7)}`;
