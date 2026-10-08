import { open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type, type Static } from "typebox";
import { isJsonRecord, isString, type JsonValue } from "../.pi/extensions/lib/runtime-values.ts";
import { Value } from "typebox/value";

class McpTranslationError extends Error {}

const strings = Type.Record(Type.String(), Type.String());
const optionalString = Type.Optional(Type.String());
const oauth = Type.Object(
  {
    clientId: optionalString,
    clientSecret: optionalString,
    scope: optionalString,
    clientName: optionalString,
    callbackUrl: optionalString,
    callbackPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    clientRegistration: Type.Optional(Type.Union([Type.Literal("dcr"), Type.Literal("cimd")])),
    authServerMetadataUrl: optionalString,
  },
  { additionalProperties: false },
);
const exposure = Type.Union([
  Type.Literal("codemode"),
  Type.Literal("deferred"),
  Type.Literal("direct"),
  Type.Literal("hidden"),
]);
const common = {
  command: optionalString,
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(strings),
  cwd: optionalString,
  url: optionalString,
  headers: Type.Optional(strings),
  type: Type.Optional(
    Type.Union([Type.Literal("stdio"), Type.Literal("http"), Type.Literal("streamable-http")]),
  ),
  enabled: Type.Optional(Type.Boolean()),
  timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  exposure: Type.Optional(exposure),
  toolExposure: Type.Optional(Type.Record(Type.String(), exposure)),
  description: optionalString,
};
const builtinServer = Type.Object(
  {
    ...common,
    oauth: Type.Optional(oauth),
    auth: Type.Optional(
      Type.Object({ provider: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);
const unsupported = [
  "directTools",
  "toolPrefix",
  "sampling",
  "elicitation",
  "oauthDir",
  "bearerTokenEnv",
  "socket",
  "requestHeadersCommand",
  "lifecycle",
  "idleTimeout",
  "exposeResources",
  "includeTools",
  "excludeTools",
  "searchKeywords",
  "approveTools",
  "debug",
  "trace",
  "httpTransport",
  "pluginDataDir",
  "literalEnv",
];
const legacyOauth = Type.Object(
  {
    clientId: optionalString,
    clientSecret: optionalString,
    scope: optionalString,
    clientName: optionalString,
    redirectUri: optionalString,
    grantType: Type.Optional(
      Type.Union([Type.Literal("authorization_code"), Type.Literal("client_credentials")]),
    ),
    authorizationParams: Type.Optional(strings),
    clientUri: optionalString,
    logoUri: optionalString,
    skipIssuerMetadataValidation: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const legacyServer = Type.Object(
  {
    ...common,
    auth: Type.Optional(
      Type.Union([
        Type.Literal("oauth"),
        Type.Literal("bearer"),
        Type.Literal(false),
        Type.Object({ provider: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      ]),
    ),
    oauth: Type.Optional(Type.Union([legacyOauth, oauth, Type.Literal(false)])),
    bearerToken: optionalString,
    protocolVersion: optionalString,
    disabled: Type.Optional(Type.Boolean()),
    requestTimeoutMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    ...Object.fromEntries(unsupported.map((field) => [field, Type.Optional(Type.Unknown())])),
  },
  { additionalProperties: false },
);
const legacySchema = Type.Object(
  {
    mcpServers: Type.Record(Type.String({ pattern: "^[A-Za-z0-9_-]+$" }), legacyServer, {
      additionalProperties: false,
    }),
    settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
const builtinSchema = Type.Object(
  {
    mcpServers: Type.Record(Type.String({ pattern: "^[A-Za-z0-9_-]+$" }), builtinServer, {
      additionalProperties: false,
    }),
  },
  { additionalProperties: false },
);

type LegacyConfig = Static<typeof legacySchema>;

/** The retired adapter always listened here (mcp-oauth-provider.ts DEFAULT_OAUTH_CALLBACK_PORT). */
const LEGACY_CALLBACK_PORT = 19876;

/** The adapter also honored MCP_OAUTH_CALLBACK_PORT; a valid value overrides the default port. */
function legacyCallbackUrl(): string {
  const raw = process.env.MCP_OAUTH_CALLBACK_PORT;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  const port =
    Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : LEGACY_CALLBACK_PORT;
  return `http://localhost:${port}/callback`;
}

export type McpTranslation = Readonly<{
  config: Static<typeof builtinSchema>;
  notices: readonly string[];
}>;

export type McpTranslationOptions = Readonly<{
  /** Servers to leave out of the translated output (recorded as a notice). */
  skip?: readonly string[];
}>;

/**
 * The adapter's top-level `settings` block only configured the retired adapter itself (generated
 * direct tools, tool prefixes, host discovery). Pi's built-in MCP has no top-level equivalent and
 * uses per-server `exposure`/`toolExposure` instead, so the block is dropped with a notice that
 * names only its keys.
 */
export function translateMcpConfig(
  raw: LegacyConfig,
  options: McpTranslationOptions = {},
): McpTranslation {
  const notices: string[] = [];
  const skip = new Set(options.skip ?? []);
  for (const name of skip) {
    if (!Object.hasOwn(raw.mcpServers, name))
      throw new McpTranslationError(`Cannot skip unknown server ${name}`);
    notices.push(`Skipped server ${name}: not translated; configure it manually for Pi`);
  }
  const droppedSettings = Object.keys(raw.settings ?? {});
  if (droppedSettings.length) {
    notices.push(
      `Dropped adapter-only top-level settings (no built-in equivalent): ${droppedSettings.join(", ")}`,
    );
  }
  const servers = Object.fromEntries(
    Object.entries(raw.mcpServers)
      .filter(([name]) => !skip.has(name))
      .map(([name, server]) => {
        const fields = unsupported.filter((field) => Object.hasOwn(server, field));
        if (fields.length)
          throw new McpTranslationError(`Unsupported fields for ${name}: ${fields.join(", ")}`);
        const {
          auth,
          bearerToken,
          protocolVersion: _protocol,
          disabled,
          requestTimeoutMs,
          oauth: oldOauth,
          ...rest
        } = server;
        const translated = { ...rest };
        // Unsupported adapter fields have already been rejected; retain only validated built-in fields.
        for (const field of unsupported) Reflect.deleteProperty(translated, field);
        if (disabled !== undefined) translated.enabled = !disabled;
        if (requestTimeoutMs !== undefined) translated.timeout = requestTimeoutMs / 1000;
        if (auth === "bearer") {
          if (!bearerToken || !server.url)
            throw new McpTranslationError(
              `Bearer authentication for ${name} requires bearerToken and url`,
            );
          if (
            Object.keys(server.headers ?? {}).some((key) => key.toLowerCase() === "authorization")
          )
            throw new McpTranslationError(`Conflicting Authorization header for ${name}`);
          // The adapter ran "!command" values and used the output as the token. Pi runs a
          // "!command" only when it is the whole header value, so wrap it to keep the scheme.
          // "!!" was the adapter's escape for a literal leading "!".
          const authorization = bearerToken.startsWith("!!")
            ? `Bearer ${bearerToken.slice(1)}`
            : bearerToken.startsWith("!")
              ? `!echo Bearer $(${bearerToken.slice(1)})`
              : `Bearer ${bearerToken}`;
          if (authorization.startsWith("!"))
            notices.push(`Wrapped the token command for ${name} so Pi runs it as the whole header`);
          translated.headers = { ...server.headers, Authorization: authorization };
        } else if (bearerToken !== undefined)
          throw new McpTranslationError(`Unsupported bearerToken without bearer auth for ${name}`);
        if (auth instanceof Object) Object.assign(translated, { auth });
        if (oldOauth === false || auth === false) {
          // Pi has no "no authentication" switch for URL servers: OAuth is attempted only when
          // the server answers with a 401 challenge. Omitting both fields is the closest
          // equivalent; a server that never challenges is never prompted.
          notices.push(
            `Dropped explicit auth/OAuth disablement for ${name}: Pi only starts OAuth on a 401 challenge`,
          );
        }
        if (auth === "bearer" && oldOauth)
          throw new McpTranslationError(`Conflicting bearer and OAuth authentication for ${name}`);
        if (oldOauth || auth === "oauth") {
          if (!server.url) throw new McpTranslationError(`OAuth for ${name} requires url`);
          const config = oldOauth || {};
          for (const field of [
            "authorizationParams",
            "clientUri",
            "logoUri",
            "skipIssuerMetadataValidation",
          ]) {
            if (Object.hasOwn(config, field))
              throw new McpTranslationError(`Unsupported OAuth field for ${name}: ${field}`);
          }
          if ("grantType" in config && config.grantType !== "authorization_code")
            throw new McpTranslationError(`Unsupported OAuth grantType for ${name}`);
          const {
            grantType: _grant,
            redirectUri,
            ...remaining
          } = "grantType" in config || "redirectUri" in config
            ? config
            : { ...config, grantType: undefined, redirectUri: undefined };
          const mapped = { ...remaining };
          if (redirectUri !== undefined) Object.assign(mapped, { callbackUrl: redirectUri });
          else if (
            mapped.clientId !== undefined &&
            !Object.hasOwn(config, "callbackUrl") &&
            !Object.hasOwn(config, "callbackPort")
          ) {
            // A pre-registered client has the adapter's fixed redirect URI on file; Pi would
            // otherwise pick a random port and the authorization server would reject it.
            Object.assign(mapped, { callbackUrl: legacyCallbackUrl() });
            notices.push(
              `Pinned oauth.callbackUrl for ${name} to the adapter's registered redirect URI`,
            );
          }
          Object.assign(translated, { oauth: mapped });
        }
        return [name, translated];
      }),
  );
  const result = { mcpServers: servers };
  if (!Value.Check(builtinSchema, result))
    throw new McpTranslationError(
      "Translated MCP configuration failed built-in schema validation (values withheld)",
    );
  for (const [name, server] of Object.entries(result.mcpServers)) {
    if (server.url) {
      if (server.type === "stdio")
        throw new McpTranslationError(`Invalid transport type for ${name}`);
      if (!URL.canParse(server.url) || !["http:", "https:"].includes(new URL(server.url).protocol))
        throw new McpTranslationError(`Invalid HTTP URL for ${name}`);
      if (
        server.auth &&
        new URL(server.url).protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(new URL(server.url).hostname)
      )
        throw new McpTranslationError(
          `Provider authentication requires HTTPS or loopback for ${name}`,
        );
      const config = server.oauth;
      if (config?.clientName !== undefined && !config.clientName.trim())
        throw new McpTranslationError(`Invalid OAuth clientName for ${name}`);
      if (
        config?.clientRegistration === "cimd" &&
        (config.clientId !== undefined || config.clientName !== undefined)
      )
        throw new McpTranslationError(`Conflicting OAuth CIMD fields for ${name}`);
      const metadata = config?.authServerMetadataUrl;
      if (metadata !== undefined) {
        if (!URL.canParse(metadata))
          throw new McpTranslationError(`Invalid OAuth authServerMetadataUrl for ${name}`);
        const url = new URL(metadata);
        if (
          url.protocol !== "https:" &&
          !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
          throw new McpTranslationError(`Invalid OAuth authServerMetadataUrl for ${name}`);
      }
      const callback = config?.callbackUrl;
      if (callback !== undefined) {
        if (!URL.canParse(callback))
          throw new McpTranslationError(`Invalid OAuth callbackUrl for ${name}`);
        const url = new URL(callback);
        if (
          url.protocol !== "http:" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
          url.search ||
          url.hash
        )
          throw new McpTranslationError(`Invalid OAuth callbackUrl for ${name}`);
        if (
          url.port &&
          config?.callbackPort !== undefined &&
          Number(url.port) !== config.callbackPort
        )
          throw new McpTranslationError(`Conflicting OAuth callback port for ${name}`);
        if (
          config?.clientRegistration === "cimd" &&
          (url.hostname === "[::1]" || url.pathname !== "/callback")
        )
          throw new McpTranslationError(`Invalid OAuth CIMD callbackUrl for ${name}`);
      }
    } else {
      if (!server.command) throw new McpTranslationError(`Server ${name} requires command or url`);
      if (server.type !== undefined && server.type !== "stdio")
        throw new McpTranslationError(`Invalid transport type for ${name}`);
    }
  }
  return { config: result, notices };
}

/** All strings are withheld, including credentials embedded in URLs, args, and environment values. */
function redact(value: JsonValue): JsonValue {
  if (isString(value)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(redact);
  if (isJsonRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
  return value;
}

export async function translateMcpFile(
  path: string,
  apply = false,
  options: McpTranslationOptions = {},
): Promise<string> {
  const file = resolve(path);
  const source = await readFile(file, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new McpTranslationError("Invalid MCP JSON (values withheld)");
  }
  if (!isJsonRecord(raw) || !Value.Check(legacySchema, raw))
    throw new McpTranslationError("Invalid legacy MCP configuration shape (values withheld)");
  const { config: translated, notices } = translateMcpConfig(raw, options);
  const noticeText = notices.length ? `${notices.join("\n")}\n` : "";
  const diff = `${noticeText}DRY-RUN structural diff (all string values redacted)\n- ${JSON.stringify(redact(raw), null, 2)}\n+ ${JSON.stringify(redact(translated), null, 2)}`;
  if (!apply) return diff;
  if ((await readFile(file, "utf8")) !== source)
    throw new McpTranslationError("MCP configuration changed during translation; retry");
  const suffix = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
  const backup = `${file}.${suffix}.bak`;
  const temporary = `${file}.${suffix}.tmp`;
  const backupHandle = await open(backup, "wx", 0o600);
  try {
    await backupHandle.writeFile(source);
  } finally {
    await backupHandle.close();
  }
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(translated, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    if ((await readFile(file, "utf8")) !== source)
      throw new McpTranslationError("MCP configuration changed during translation; retry");
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
  return `${diff}\nApplied; timestamped backup created next to the configuration.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf("--file");
  const path = fileIndex < 0 ? resolve(homedir(), ".pi/agent/mcp.json") : args[fileIndex + 1];
  const skip: string[] = [];
  const valueIndexes = new Set<number>();
  if (fileIndex >= 0) valueIndexes.add(fileIndex + 1);
  args.forEach((arg, index) => {
    if (arg !== "--skip") return;
    const value = args[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      skip.push(value);
      valueIndexes.add(index + 1);
    }
  });
  const valid = args.every(
    (arg, index) =>
      arg === "--apply" ||
      arg === "--file" ||
      arg === "--skip" ||
      (valueIndexes.has(index) && !arg.startsWith("--")),
  );
  const skipCount = args.filter((arg) => arg === "--skip").length;
  if (!path || !valid || skipCount !== skip.length) {
    console.error(
      "Usage: node scripts/translate-mcp-config.ts [--file path] [--skip server]... [--apply]",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(await translateMcpFile(path, args.includes("--apply"), { skip }));
    } catch (error) {
      console.error(
        error instanceof McpTranslationError
          ? error.message
          : "MCP translation failed (filesystem details and values withheld).",
      );
      process.exitCode = 1;
    }
  }
}
