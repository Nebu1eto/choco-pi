import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import dns from "node:dns";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates, TLSSocket } from "node:tls";
import { promisify } from "node:util";
import { constants, deflate, deflateRawSync, gzip, gzipSync, brotliCompressSync } from "node:zlib";
import { test } from "node:test";
import { approveRemoteUrl, fetchRemoteUrl } from "../ssrf-protection.ts";
import { pinnedLookup } from "../pinned-http.ts";
import { fetchAuthenticatedRemoteUrl, readPDFResponseBuffer } from "../extract.ts";

const run = promisify(execFile);
const allowed = [{ address: "127.0.0.1", family: 4 }];
const policy = { allowRanges: ["127.0.0.1/32"], lookup: async () => allowed };

function isBoundAddress(address: string | AddressInfo | null): address is AddressInfo {
  return address !== null && Object.prototype.toString.call(address) === "[object Object]";
}

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  assert.ok(isBoundAddress(address));
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("direct requests pin one immutable DNS snapshot and redirects reject rebinding", async (t) => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    assert.match(request.headers.host ?? "", /^pinned\.test:/);
    if (request.url === "/redirect") response.writeHead(302, { location: "/forbidden" });
    response.end("ok");
  });
  const port = await listen(server);
  let forbiddenContacts = 0;
  const forbidden = createServer((_request, response) => {
    forbiddenContacts++;
    response.end("forbidden");
  });
  try {
    forbidden.listen(port, "::1");
    await once(forbidden, "listening");
    // Any accidental connection-time DNS resolution receives the rebound address locally.
    t.mock.method(dns, "lookup", pinnedLookup("pinned.test", [{ address: "::1", family: 6 }]));
    let lookups = 0;
    const lookup = async () => {
      lookups++;
      return lookups === 1 ? allowed : [{ address: "127.0.0.2", family: 4 }];
    };
    const response = await fetchRemoteUrl(
      `http://pinned.test:${port}/one#fragment`,
      {},
      { ...policy, lookup },
    );
    assert.equal(await response.text(), "ok");
    assert.equal(lookups, 1);
    assert.equal(response.url, `http://pinned.test:${port}/one`);
    assert.equal(response.redirected, false);
    lookups = 0;
    await assert.rejects(
      fetchRemoteUrl(`http://pinned.test:${port}/redirect`, {}, { ...policy, lookup }),
      /Blocked internal address/,
    );
    assert.equal(lookups, 2);
    assert.deepEqual(paths, ["/one", "/redirect"]);
    const approval = await approveRemoteUrl(`http://pinned.test:${port}/one`, policy);
    assert.ok(Object.isFrozen(approval));
    assert.ok(Object.isFrozen(approval.addresses));
    assert.ok(Object.isFrozen(approval.addresses?.[0]));
    assert.equal(forbiddenContacts, 0);
  } finally {
    await close(server);
    await close(forbidden);
  }
});

test("lookup refuses unapproved hosts and families and supports all addresses", async () => {
  const lookup = pinnedLookup("pinned.test", [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ]);
  lookup("other.test", {}, (error) => assert.match(error?.message ?? "", /unapproved/));
  lookup("pinned.test", { family: 6, all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: "::1", family: 6 }]);
  });
  pinnedLookup("pinned.test", [{ address: "127.0.0.1", family: 4 }])(
    "pinned.test",
    { family: 6 },
    (error) => assert.ok(error),
  );
});

test("redirects re-pin, POST transitions discard body headers, 307 retains JSON, cross-origin strips credentials", async () => {
  const observed: {
    method: string;
    body: string;
    authorization?: string;
    cookie?: string;
    contentType?: string;
  }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    observed.push({
      method: request.method ?? "",
      body,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      contentType: request.headers["content-type"],
    });
    if (request.url === "/303") response.writeHead(303, { location: "/end" });
    else if (request.url === "/307") response.writeHead(307, { location: "/end" });
    else if (request.url === "/cross")
      response.writeHead(302, { location: `http://other.test:${port}/end` });
    response.end("ok");
  });
  const port = await listen(server);
  try {
    let lookups = 0;
    const options = {
      ...policy,
      lookup: async () => {
        lookups++;
        return allowed;
      },
    };
    const init = {
      method: "POST",
      body: '{"value":1}',
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
        cookie: "local=1",
      },
    };
    for (const path of ["303", "307", "cross"]) {
      const response = await fetchRemoteUrl(`http://pinned.test:${port}/${path}`, init, options);
      assert.equal(await response.text(), "ok");
    }
    assert.equal(lookups, 6);
    assert.equal(observed[1].method, "GET");
    assert.equal(observed[1].body, "");
    assert.equal(observed[1].contentType, undefined);
    assert.equal(observed[3].method, "POST");
    assert.equal(observed[3].body, init.body);
    assert.equal(observed[5].authorization, undefined);
    assert.equal(observed[5].cookie, undefined);
  } finally {
    await close(server);
  }
});

test("pinned decoding matches native fetch for raw/wrapped deflate and complete/sync-flushed gzip", async () => {
  const body = "decoded response body".repeat(100);
  const cases = [
    { name: "raw-deflate", encoding: "deflate", bytes: deflateRawSync(body) },
    { name: "wrapped-deflate", encoding: "deflate", bytes: await promisify(deflate)(body) },
    { name: "gzip", encoding: "gzip", bytes: await promisify(gzip)(body) },
    {
      name: "sync-flushed-gzip",
      encoding: "gzip",
      bytes: await promisify(gzip)(body, { finishFlush: constants.Z_SYNC_FLUSH }),
    },
  ];
  const server = createServer((request, response) => {
    const fixture = cases.find((entry) => request.url === `/${entry.name}`);
    assert.ok(fixture);
    response.writeHead(200, { "content-encoding": fixture.encoding });
    response.end(fixture.bytes);
  });
  const port = await listen(server);
  try {
    for (const fixture of cases) {
      const native = await fetch(`http://127.0.0.1:${port}/${fixture.name}`);
      assert.equal(await native.text(), body, `native ${fixture.name}`);
      const pinned = await fetchRemoteUrl(`http://pinned.test:${port}/${fixture.name}`, {}, policy);
      assert.equal(await pinned.text(), body, `pinned ${fixture.name}`);
    }
  } finally {
    await close(server);
  }
});

test("native response decompresses gzip/br, retains duplicate headers, cancels streams and enforces decoded limits", async () => {
  let streamClosed: Promise<void> | undefined;
  const server = createServer((request, response) => {
    if (request.url === "/empty") {
      response.writeHead(204);
      response.end();
    } else if (request.url === "/stream") {
      streamClosed = once(response, "close").then(() => undefined);
      response.writeHead(200);
      response.write("stream");
    } else {
      const compressed =
        request.url === "/br"
          ? brotliCompressSync(Buffer.from("decoded".repeat(100)))
          : gzipSync(Buffer.from("decoded".repeat(100)));
      response.writeHead(200, {
        "content-encoding": request.url === "/br" ? "br" : "gzip",
        "set-cookie": ["a=1", "b=2"],
        link: ["<a>; rel=next", "<b>; rel=last"],
      });
      response.end(compressed);
    }
  });
  const port = await listen(server);
  const fetchLocal = (path: string, init: RequestInit = {}) =>
    fetchRemoteUrl(`http://pinned.test:${port}${path}`, init, policy);
  try {
    for (const path of ["/gzip", "/br"]) {
      const response = await fetchLocal(path);
      assert.deepEqual(response.headers.getSetCookie(), ["a=1", "b=2"]);
      assert.match(response.headers.get("link") ?? "", /<a>.*<b>/);
      assert.equal(await response.text(), "decoded".repeat(100));
    }
    assert.equal((await fetchLocal("/empty")).body, null);
    await assert.rejects(
      readPDFResponseBuffer(await fetchLocal("/gzip"), 0.00001),
      /exceeds configured/,
    );
    const streaming = await fetchLocal("/stream");
    const reader = streaming.body?.getReader();
    assert.ok(reader);
    await reader.read();
    await reader.cancel();
    reader.releaseLock();
    await streamClosed;
    const controller = new AbortController();
    const aborted = await fetchLocal("/stream", { signal: controller.signal });
    controller.abort();
    await assert.rejects(aborted.text(), /abort/i);
    await assert.rejects(fetchLocal("/stream", { signal: AbortSignal.abort() }), /abort/i);
  } finally {
    await close(server);
  }
});

test("redirect and redirect-error bodies are disposed before returning", async () => {
  const closures: Promise<void>[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/end") response.end("final");
    else {
      closures.push(once(response, "close").then(() => undefined));
      response.writeHead(302, { location: "/end" });
      response.write("unbounded redirect body");
    }
  });
  const port = await listen(server);
  try {
    const url = `http://pinned.test:${port}/start`;
    assert.equal(await (await fetchRemoteUrl(url, {}, policy)).text(), "final");
    await assert.rejects(
      fetchRemoteUrl(url, {}, { ...policy, maxRedirects: 0 }),
      /Too many redirects/,
    );
    await Promise.all(closures);
    assert.equal(closures.length, 2);
  } finally {
    await close(server);
  }
});

test("trusted environment proxy keeps the native fetch path without local DNS", async (t) => {
  const previousProxy = process.env.HTTPS_PROXY;
  const previousNoProxy = process.env.NO_PROXY;
  const previousLowerNoProxy = process.env.no_proxy;
  process.env.HTTPS_PROXY = "http://proxy.test:8080";
  process.env.NO_PROXY = "";
  process.env.no_proxy = "";
  t.after(() => {
    if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previousProxy;
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
    if (previousLowerNoProxy === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = previousLowerNoProxy;
  });
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requested.push(String(input));
    assert.equal(init?.redirect, "manual");
    return requested.length === 1
      ? new Response("", { status: 302, headers: { location: "/next" } })
      : new Response("proxied");
  });
  const response = await fetchRemoteUrl(
    "https://proxy-target.test/start",
    {},
    {
      trustEnvProxy: true,
      lookup: async () => {
        throw new Error("No local DNS for trusted proxy");
      },
    },
  );
  assert.equal(await response.text(), "proxied");
  assert.deepEqual(requested, [
    "https://proxy-target.test/start",
    "https://proxy-target.test/next",
  ]);
});

test("IPv6 snapshots connect without hostname DNS", async () => {
  const server = createServer((_request, response) => response.end("ipv6"));
  const port = await listen(server, "::1");
  try {
    const response = await fetchRemoteUrl(
      `http://pinned.test:${port}/`,
      {},
      { allowRanges: ["::1/128"], lookup: async () => [{ address: "::1", family: 6 }] },
    );
    assert.equal(await response.text(), "ipv6");
    const local = await fetchRemoteUrl(
      `http://localhost:${port}/`,
      {},
      {
        allowLoopback: true,
        lookup: async () => [{ address: "::1", family: 6 }],
      },
    );
    assert.equal(await local.text(), "ipv6");
  } finally {
    await close(server);
  }
});

test("HTTPS preserves Host/SNI, verifies certificates, and auth retains approval across cookie awaits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinned-http-"));
  const previousCAs = getCACertificates("default");
  let server: Server | undefined;
  try {
    const keyPath = join(root, "key.pem");
    const certPath = join(root, "cert.pem");
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=pinned.test",
      "-addext",
      "subjectAltName=DNS:pinned.test",
    ]);
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath, "utf8")]);
    let requests = 0;
    const cookies: string[] = [];
    server = createTlsServer({ key, cert }, (request, response) => {
      requests++;
      assert.ok(request.socket instanceof TLSSocket);
      assert.equal(request.socket.servername, "pinned.test");
      assert.match(request.headers.host ?? "", /^pinned\.test:/);
      cookies.push(request.headers.cookie ?? "");
      if (request.url === "/start") response.writeHead(302, { location: "/next" });
      response.end("secure");
    });
    const port = await listen(server);
    const url = `https://pinned.test:${port}`;
    await assert.rejects(fetchRemoteUrl(`${url}/`, {}, policy), /self-signed certificate/);
    setDefaultCACertificates([...previousCAs, cert]);
    assert.equal(await (await fetchRemoteUrl(`${url}/`, {}, policy)).text(), "secure");
    await assert.rejects(
      fetchRemoteUrl(`https://wrong.test:${port}/`, {}, policy),
      /certificate|Hostname\/IP/,
    );
    const profile = {
      name: "local",
      hosts: ["pinned.test"],
      redirects: "same-origin",
      cache: "off",
    } as const;
    let lookups = 0;
    let acquired = false;
    const lookup = async () => {
      lookups++;
      return acquired ? [{ address: "127.0.0.2", family: 4 }] : allowed;
    };
    const cookieProvider = async () => {
      await Promise.resolve();
      acquired = true;
      return "session=local";
    };
    const auth = await fetchAuthenticatedRemoteUrl(
      `${url}/private`,
      { headers: {} },
      {
        ssrf: { allowRanges: policy.allowRanges, trustEnvProxy: false },
        domainPolicy: { allow: [], deny: [] },
        lookup,
      },
      { ...profile, hosts: [...profile.hosts] },
      cookieProvider,
    );
    assert.equal(await auth.text(), "secure");
    assert.equal(lookups, 1);
    acquired = false;
    lookups = 0;
    await assert.rejects(
      fetchAuthenticatedRemoteUrl(
        `${url}/start`,
        { headers: {} },
        {
          ssrf: { allowRanges: policy.allowRanges, trustEnvProxy: false },
          domainPolicy: { allow: [], deny: [] },
          lookup,
        },
        { ...profile, hosts: [...profile.hosts] },
        cookieProvider,
      ),
      /Blocked internal address/,
    );
    assert.equal(lookups, 2);
    assert.equal(requests, 3);
    assert.deepEqual(cookies, ["", "session=local", "session=local"]);
    const validation = {
      ssrf: { allowRanges: policy.allowRanges, trustEnvProxy: false },
      domainPolicy: { allow: [], deny: [] },
      lookup: policy.lookup,
    };
    const cookiePaths: string[] = [];
    const redirected = await fetchAuthenticatedRemoteUrl(
      `${url}/start`,
      { headers: {} },
      validation,
      { ...profile, hosts: [...profile.hosts] },
      async (target) => {
        const path = target instanceof URL ? target.pathname : new URL(target).pathname;
        cookiePaths.push(path);
        await Promise.resolve();
        return `path=${path}`;
      },
    );
    assert.equal(await redirected.text(), "secure");
    assert.equal(redirected.url, `${url}/next`);
    assert.equal(redirected.redirected, false);
    assert.deepEqual(cookiePaths, ["/start", "/next"]);
    assert.deepEqual(cookies.slice(-2), ["path=/start", "path=/next"]);
    const controller = new AbortController();
    await assert.rejects(
      fetchAuthenticatedRemoteUrl(
        `${url}/private`,
        { headers: {}, signal: controller.signal },
        validation,
        { ...profile, hosts: [...profile.hosts] },
        async () => {
          controller.abort();
          await Promise.resolve();
          return "late=cookie";
        },
      ),
      /abort/i,
    );
    assert.equal(requests, 5);
  } finally {
    if (server) await close(server);
    setDefaultCACertificates(previousCAs);
    await rm(root, { recursive: true, force: true });
  }
});
