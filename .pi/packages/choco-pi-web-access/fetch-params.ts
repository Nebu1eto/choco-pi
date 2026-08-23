export interface FetchContentParams {
  url?: unknown;
  urls?: unknown;
  forceClone?: unknown;
  prompt?: unknown;
  mode?: unknown;
  answerModel?: unknown;
  auth?: unknown;
}

export interface NormalizedFetchContentParams {
  urlList: string[];
  options: {
    forceClone?: boolean;
    prompt?: string;
    mode?: "readable" | "raw" | "answer";
    answerModel?: string;
    auth?: true | string;
  };
}

export function normalizeFetchContentParams(
  params: FetchContentParams,
): NormalizedFetchContentParams {
  const normalizedUrls = uniqueUrls(normalizeUrlArray(params.urls));
  const urlList = normalizedUrls.length > 0 ? normalizedUrls : normalizeSingleUrl(params.url);
  const prompt = normalizeOptionalString(params.prompt);
  const forceClone =
    params.forceClone === true ? true : params.forceClone === false ? false : undefined;
  const mode = normalizeMode(params.mode);
  const answerModel = normalizeOptionalString(params.answerModel);
  const auth = normalizeAuth(params.auth);

  const options: NormalizedFetchContentParams["options"] = {};
  if (forceClone !== undefined) options.forceClone = forceClone;
  if (prompt !== undefined) options.prompt = prompt;
  if (mode !== undefined) options.mode = mode;
  if (answerModel !== undefined) options.answerModel = answerModel;
  if (auth !== undefined) options.auth = auth;
  return { urlList, options };
}

function primitiveString<T>(value: T): string | null {
  return Object.prototype.toString.call(value) === "[object String]" && Object(value) !== value
    ? String(value)
    : null;
}

function normalizeUrlArray<T>(value: T): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(normalizeSingleUrl);
}

function normalizeSingleUrl<T>(value: T): string[] {
  const stringValue = primitiveString(value);
  if (stringValue === null) return [];
  const trimmed = stringValue.trim();
  return trimmed ? [trimmed] : [];
}

function normalizeOptionalString<T>(value: T): string | undefined {
  const stringValue = primitiveString(value);
  if (stringValue === null) return undefined;
  const trimmed = stringValue.trim();
  return trimmed || undefined;
}

function normalizeMode<T>(value: T): "readable" | "raw" | "answer" | undefined {
  if (value === undefined) return undefined;
  if (value === "readable") return "readable";
  if (value === "raw") return "raw";
  if (value === "answer") return "answer";
  throw new Error('mode must be "readable", "raw", or "answer"');
}

function normalizeAuth<T>(value: T): true | string | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return true;
  const stringValue = primitiveString(value);
  if (stringValue !== null) {
    const trimmed = stringValue.trim();
    if (trimmed) return trimmed;
  }
  throw new Error("auth must be a profile name, true, or false");
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls)];
}
