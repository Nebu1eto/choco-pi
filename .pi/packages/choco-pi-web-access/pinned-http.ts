import { request as httpRequest, type IncomingMessage, type ClientRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export interface ApprovedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface ApprovedRemoteUrl {
  readonly url: string;
  /** null means the explicitly trusted environment proxy owns resolution. */
  readonly addresses: readonly ApprovedAddress[] | null;
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

export function pinnedLookup(
  hostname: string,
  addresses: readonly ApprovedAddress[],
): LookupFunction {
  return (requested, options, callback) => {
    const family = options.family ?? 0;
    const approved = addresses.filter((entry) => family === 0 || entry.family === family);
    if (requested !== hostname || approved.length === 0) {
      callback(new Error("Connection requested an unapproved hostname or address family"), "", 0);
    } else if (options.all) {
      callback(
        null,
        approved.map((entry) => ({ ...entry })),
      );
    } else {
      callback(null, approved[0].address, approved[0].family);
    }
  };
}

class RemoteResponse extends Response {
  readonly #remoteUrl: string;

  constructor(body: BodyInit | null, init: ResponseInit, url: string) {
    super(body, init);
    this.#remoteUrl = url;
  }

  override get url(): string {
    return this.#remoteUrl;
  }
}

function responseFromMessage(message: IncomingMessage, method: string, url: string): Response {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    headers.append(message.rawHeaders[index], message.rawHeaders[index + 1]);
  }
  const status = message.statusCode ?? 500;
  const init = { status, statusText: message.statusMessage ?? "", headers };
  if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
    message.resume();
    return new RemoteResponse(null, init, url);
  }
  let body: Readable = message;
  const encodings = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);
  if (encodings.every((encoding) => ["gzip", "x-gzip", "deflate", "br"].includes(encoding))) {
    for (const encoding of encodings.toReversed()) {
      const decoder = decoderFor(encoding);
      const source = body;
      source.on("error", (error: Error) => decoder.destroy(error));
      decoder.on("close", () => source.destroy());
      body = source.pipe(decoder);
    }
  }
  return new RemoteResponse(responseBody(body), init, url);
}

function decoderFor(encoding: string) {
  if (encoding === "br") return createBrotliDecompress();
  if (encoding === "deflate") return createInflate();
  return createGunzip();
}

function responseBody(body: Readable): ReadableStream<Uint8Array> {
  const reader = Readable.toWeb(body).getReader();
  let active = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (!active) return;
      if (chunk.done) {
        active = false;
        controller.close();
      } else if (chunk.value instanceof Uint8Array) {
        controller.enqueue(chunk.value);
      } else {
        active = false;
        body.destroy();
        controller.error(new Error("HTTP response produced a non-byte chunk"));
      }
    },
    async cancel() {
      active = false;
      await reader.cancel();
    },
  });
}

async function writeRequestBody(
  request: ClientRequest,
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (!body) {
    request.end();
    return;
  }
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch((error) => {
      request.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  };
  request.once("close", cancel);
  try {
    while (!request.destroyed) {
      const chunk = await reader.read();
      if (request.destroyed) break;
      if (chunk.done) {
        request.end();
        break;
      }
      await new Promise<void>((resolve, reject) => {
        request.write(chunk.value, (error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    request.off("close", cancel);
    reader.releaseLock();
  }
}

/** Every direct socket uses only this approval; no pooled socket or second DNS lookup is allowed. */
export async function fetchApprovedRemoteUrl(
  approval: ApprovedRemoteUrl,
  init: RequestInit = {},
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(approval.url);
  } catch {
    throw new Error("Invalid approved remote URL");
  }
  if (approval.addresses === null) return fetch(url, { ...init, redirect: "manual" });
  url.hash = "";
  const hostname = hostnameOf(url);
  const addresses = approval.addresses.map((entry) => ({ ...entry }));
  const input = new Request(url, { ...init, redirect: "manual" });
  input.signal.throwIfAborted();
  const headers = Object.fromEntries(input.headers);
  if (!input.headers.has("accept-encoding")) headers["accept-encoding"] = "gzip, deflate, br";
  return new Promise<Response>((resolve, reject) => {
    const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
    const options: RequestOptions = {
      method: input.method,
      headers,
      agent: false,
      lookup: pinnedLookup(hostname, addresses),
    };
    if (url.protocol === "https:" && !isIP(hostname)) options.servername = hostname;
    const request = requestImpl(url, options);
    const abort = () =>
      request.destroy(new DOMException("The operation was aborted", "AbortError"));
    input.signal.addEventListener("abort", abort, { once: true });
    request.once("close", () => input.signal.removeEventListener("abort", abort));
    request.once("error", reject);
    request.once("response", (message) => {
      try {
        resolve(responseFromMessage(message, input.method, url.href));
      } catch (error) {
        message.destroy();
        reject(error);
      }
    });
    if (input.signal.aborted) abort();
    void writeRequestBody(request, input.body).catch((error) => {
      request.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel();
}
