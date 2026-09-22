import {
  isBoolean,
  isJsonRecord,
  isObject,
  isString,
  type RuntimeValue,
} from "./lib/runtime-values.ts";
import { isPrefixLocked, lockPrefix, publishPrefixLock, unlockPrefix } from "./lib/prefix-lock.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hasCanonicalSearch } from "../packages/choco-pi-web-search/index.ts";

const MAX_QUERY_LENGTH = 500;
const DEFAULT_LIMIT = 5;
const DISABLED_TOOL_NAMES = new Set<string>(["grep"]);
const LEGACY_SEARCH_TOOL_NAMES = new Set<string>([
  "web_run",
  "web__run",
  "synthetic_web_search",
  "agent_browser_web_search",
]);

function withoutDisabledTools(names: readonly string[]): string[] {
  return names.filter((name) => !DISABLED_TOOL_NAMES.has(name));
}

// Keep the minimum execution, orchestration, and discovery path available
// without requiring a preliminary tool search.
export const ALWAYS_ACTIVE_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "exec",
  "wait",
  "apply_patch",
  "exec_command",
  "write_stdin",
  // Starting a long-running command and reading its output is a serial,
  // decision-dependent flow. Keep those two calls native; terminal cleanup
  // and inventory remain available through the exec bridge.
  "shell_start",
  "shell_read",
  "find",
  "ls",
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "stop_subagent",
  "tool_search",
  // These tools can return native image artifacts or own an approval-gated
  // browser interaction, which cannot be represented faithfully by a plain
  // deferred schema call in every provider UI.
  "agent_browser",
  "view_image",
  "image_gen__imagegen",
] as const;
const ALWAYS_ACTIVE = new Set<string>(ALWAYS_ACTIVE_TOOL_NAMES);

/**
 * Where the lean tool surface is published for other packages.
 *
 * choco-pi-subagents has to apply the same surface to every sub-agent, and the
 * profile must not be imported by a package, so both sides type this boundary
 * independently over `Symbol.for` — the same arrangement the preferences and
 * Codex providers use.
 */
export const LEAN_SURFACE_SYMBOL = Symbol.for("choco-pi.tool-search.lean-surface");

/** Structural view of the surface a sub-agent starts with. */
export interface LeanSurfacePolicy {
  /** Tool names no session has to search for. */
  alwaysActive: () => string[];
}

function publishLeanSurface(): void {
  const policy: LeanSurfacePolicy = { alwaysActive: () => [...ALWAYS_ACTIVE_TOOL_NAMES] };
  Object.defineProperty(globalThis, LEAN_SURFACE_SYMBOL, {
    configurable: true,
    writable: true,
    value: policy,
  });
}

type SearchTarget =
  | { kind: "pi"; tool: ToolInfo }
  | {
      kind: "mcp";
      name: string;
      description: string;
      parameters?: unknown;
      server: string;
    };

type SearchDocument = {
  target: SearchTarget;
  nameTokens: string[];
  coreNameTokens: string[];
  descriptionTokens: string[];
  schemaTokens: string[];
  sourceTokens: string[];
  allTokens: string[];
};

type CachedMcpTool = {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  uiVisibility?: string[];
};

type CachedMcpResource = {
  name?: string;
  description?: string;
  uri?: string;
};

type McpMetadataCache = {
  version?: number;
  servers?: Record<string, { tools?: CachedMcpTool[]; resources?: CachedMcpResource[] }>;
};

type McpServerStatus = { name?: string; disabled?: boolean };

type McpStatusSnapshot = { servers?: McpServerStatus[] };

function parseMcpStatusSnapshot(value: RuntimeValue): McpStatusSnapshot {
  if (!isJsonRecord(value)) throw new TypeError("MCP status event must contain an object");
  if (value.servers === undefined) return {};
  if (!Array.isArray(value.servers))
    throw new TypeError("MCP status servers must contain an array");
  const servers: McpServerStatus[] = value.servers.map((server) => {
    if (!isJsonRecord(server)) throw new TypeError("MCP server status must contain an object");
    const parsed: McpServerStatus = {};
    if (server.name !== undefined) {
      if (!isString(server.name)) throw new TypeError("MCP server name must contain a string");
      parsed.name = server.name;
    }
    if (server.disabled !== undefined) {
      if (!isBoolean(server.disabled))
        throw new TypeError("MCP server disabled flag must contain a boolean");
      parsed.disabled = server.disabled;
    }
    return parsed;
  });
  return { servers };
}

function normalize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase();
}

function tokenize(value: string): string[] {
  return normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function schemaText(value: RuntimeValue, key = ""): string {
  if (isString(value)) return `${key} ${value}`;
  if (Array.isArray(value)) return value.map((item) => schemaText(item, key)).join(" ");
  if (!value || !isObject(value)) return key;
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  return Object.entries(value as Record<string, RuntimeValue>)
    .map(([childKey, child]) => schemaText(child, childKey))
    .join(" ");
}

function matchesTerm(tokens: string[], term: string): boolean {
  return tokens.some((token) => token === term || token.startsWith(term));
}

function termFrequency(tokens: string[], term: string): number {
  return tokens.reduce(
    (count, token) => count + (token === term ? 1 : token.startsWith(term) ? 0.5 : 0),
    0,
  );
}

function bm25FieldScore(
  tokens: string[],
  terms: string[],
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageLength: number,
): number {
  if (tokens.length === 0) return 0;
  const k1 = 1.2;
  const b = 0.75;
  return terms.reduce((score, term) => {
    const frequency = termFrequency(tokens, term);
    if (frequency === 0) return score;
    const matchingDocuments = documentFrequency.get(term) ?? 0;
    const inverseFrequency = Math.log(
      1 + (documentCount - matchingDocuments + 0.5) / (matchingDocuments + 0.5),
    );
    const normalizedFrequency =
      (frequency * (k1 + 1)) /
      (frequency + k1 * (1 - b + (b * tokens.length) / Math.max(1, averageLength)));
    return score + inverseFrequency * normalizedFrequency;
  }, 0);
}

function targetName(target: SearchTarget): string {
  return target.kind === "pi" ? target.tool.name : target.name;
}

function targetDescription(target: SearchTarget): string {
  return target.kind === "pi" ? target.tool.description : target.description;
}

function targetParameters(target: SearchTarget): RuntimeValue {
  return target.kind === "pi" ? target.tool.parameters : target.parameters;
}

/**
 * Name tokens that carry meaning, with the `mcp__<server>_` registration prefix removed.
 * Every tool on a server repeats that prefix, so keeping it would make name precision
 * look identical for all of them.
 */
function coreNameTokensOf(target: SearchTarget, nameTokens: string[]): string[] {
  if (target.kind !== "mcp") return nameTokens;
  const core = nameTokens.slice(1 + tokenize(target.server).length);
  return core.length > 0 ? core : nameTokens;
}

function makeDocument(target: SearchTarget, source: string): SearchDocument {
  const nameTokens = tokenize(targetName(target));
  const descriptionTokens = tokenize(targetDescription(target));
  const schemaTokens = tokenize(schemaText(targetParameters(target)));
  const sourceTokens = tokenize(source);
  return {
    target,
    nameTokens,
    coreNameTokens: coreNameTokensOf(target, nameTokens),
    descriptionTokens,
    schemaTokens,
    sourceTokens,
    allTokens: [...nameTokens, ...descriptionTokens, ...schemaTokens, ...sourceTokens],
  };
}

function buildPiDocuments(tools: ToolInfo[]): SearchDocument[] {
  return tools.flatMap((tool) =>
    DISABLED_TOOL_NAMES.has(tool.name)
      ? []
      : [makeDocument({ kind: "pi", tool }, `${tool.sourceInfo.source} ${tool.sourceInfo.path}`)],
  );
}

function formatMcpToolName(server: string, name: string): string {
  return `mcp__${server.replace(/-/g, "_")}_${name.replace(/\./g, "_")}`;
}

function formatResourceToolName(name: string): string {
  const sanitized = name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `read_${!sanitized || /^\d/.test(sanitized) ? `resource${sanitized ? `_${sanitized}` : ""}` : sanitized}`;
}

function loadMcpDocuments(enabledServers?: ReadonlySet<string>): SearchDocument[] {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    const cache = JSON.parse(
      readFileSync(path.join(agentDir, "mcp-cache.json"), "utf8"),
    ) as McpMetadataCache;
    if (cache.version !== 1 || !cache.servers) return [];
    const documents: SearchDocument[] = [];
    for (const [server, entry] of Object.entries(cache.servers)) {
      if (enabledServers && !enabledServers.has(server)) continue;
      for (const tool of entry.tools ?? []) {
        if (!tool.name || (tool.uiVisibility && !tool.uiVisibility.includes("model"))) continue;
        const target: SearchTarget = {
          kind: "mcp",
          server,
          name: formatMcpToolName(server, tool.name),
          description: tool.description ?? "",
          parameters: tool.inputSchema,
        };
        documents.push(makeDocument(target, `mcp ${server}`));
      }
      for (const resource of entry.resources ?? []) {
        if (!resource.name || !resource.uri) continue;
        const target: SearchTarget = {
          kind: "mcp",
          server,
          name: formatMcpToolName(server, formatResourceToolName(resource.name)),
          description: resource.description ?? `Read resource: ${resource.uri}`,
          parameters: { type: "object", properties: {} },
        };
        documents.push(makeDocument(target, `mcp resource ${server}`));
      }
    }
    return documents;
  } catch {
    return [];
  }
}

function rankTools(documents: SearchDocument[], query: string): SearchTarget[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(
      term,
      documents.filter((document) =>
        document.allTokens.some((token) => token === term || token.startsWith(term)),
      ).length,
    );
  }
  const averageLength =
    documents.reduce((sum, document) => sum + document.allTokens.length, 0) /
    Math.max(1, documents.length);
  const normalizedQuery = normalize(query).trim();

  return documents
    .map((document) => {
      // Coverage counts only name and description. Schema text used to count too, which
      // let a tool with a large parameter enum absorb unrelated query words and outrank
      // the tool the query actually names.
      const describedTokens = [...document.nameTokens, ...document.descriptionTokens];
      const coverage =
        terms.filter((term) => matchesTerm(describedTokens, term)).length / terms.length;
      if (coverage === 0) return { target: document.target, score: 0 };
      // Share of the tool's own name that the query accounts for, so a narrower name
      // beats a longer one that merely contains it.
      const precision =
        document.coreNameTokens.length === 0
          ? 0
          : document.coreNameTokens.filter((token) =>
              terms.some((term) => token.startsWith(term) || term.startsWith(token)),
            ).length / document.coreNameTokens.length;
      const name = normalize(targetName(document.target));
      const score =
        bm25FieldScore(
          document.nameTokens,
          terms,
          documentFrequency,
          documents.length,
          averageLength,
        ) *
          5 +
        bm25FieldScore(
          document.descriptionTokens,
          terms,
          documentFrequency,
          documents.length,
          averageLength,
        ) *
          2 +
        bm25FieldScore(
          document.schemaTokens,
          terms,
          documentFrequency,
          documents.length,
          averageLength,
        ) +
        bm25FieldScore(
          document.sourceTokens,
          terms,
          documentFrequency,
          documents.length,
          averageLength,
        ) +
        (name === normalizedQuery ? 50 : name.includes(normalizedQuery) ? 20 : 0) +
        coverage * 10 +
        precision * 15;
      return { target: document.target, score };
    })
    .filter((match) => match.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || targetName(left.target).localeCompare(targetName(right.target)),
    )
    .map((match) => match.target);
}

function parameterSummary(schema: RuntimeValue): string {
  if (!isJsonRecord(schema)) return "none";
  const value = schema;
  if (!isJsonRecord(value.properties)) return "see mcp describe";
  const required = new Set(
    Array.isArray(value.required)
      ? value.required.filter((item): item is string => isString(item))
      : [],
  );
  const entries = Object.entries(value.properties).map(([name, property]) => {
    const definition = isJsonRecord(property) ? property : {};
    const type = isString(definition.type)
      ? definition.type
      : Array.isArray(definition.enum)
        ? definition.enum.map(String).join(" | ")
        : "value";
    return `${name}${required.has(name) ? "*" : ""}: ${type}`;
  });
  if (entries.length === 0) return "none";
  const summary = entries.join("; ");
  return summary.length > 500 ? `${summary.slice(0, 497)}...` : summary;
}

function compactDescription(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 140 ? `${singleLine.slice(0, 137)}...` : singleLine;
}

function usesNativeToolSearch(context: ExtensionContext | undefined): boolean {
  const model = context?.model;
  if (model?.provider !== "openai-codex" || !isJsonRecord(model.compat)) return false;
  return model.compat.supportsAdditionalTools !== true && model.compat.supportsToolSearch === true;
}

export default function toolSearch(pi: ExtensionAPI): void {
  publishLeanSurface();
  publishPrefixLock();
  let searchableNames = new Set<string>();
  let searchableDocuments: SearchDocument[] = [];
  let allowedNames = new Set<string>();
  const loadedNames = new Set<string>();
  let initializationScheduled = false;
  let scheduledImmediate: ReturnType<typeof setImmediate> | undefined;
  let scheduledTimeout: ReturnType<typeof setTimeout> | undefined;
  let leanSurfaceInitialized = false;
  let sessionStarted = false;
  let mcpCatalogReady = false;
  let enabledMcpServers: Set<string> | undefined;

  const withoutUnavailableTools = (names: readonly string[]): string[] => {
    const canonicalSearch = hasCanonicalSearch(pi.events);
    return withoutDisabledTools(names).filter(
      (name) => !canonicalSearch || !LEGACY_SEARCH_TOOL_NAMES.has(name),
    );
  };

  const computeLeanSurface = (): string[] => {
    const allNames = new Set(withoutUnavailableTools(pi.getAllTools().map((tool) => tool.name)));
    const alwaysActive = ALWAYS_ACTIVE_TOOL_NAMES.filter(
      (name) => name !== "tool_search" && allNames.has(name),
    );
    const included = new Set<string>(alwaysActive);
    const currentlyActive = leanSurfaceInitialized
      ? withoutUnavailableTools(pi.getActiveTools()).filter(
          (name) => name !== "tool_search" && !included.has(name),
        )
      : [];
    for (const name of currentlyActive) included.add(name);
    const loaded = [...loadedNames].filter(
      (name) => allNames.has(name) && name !== "tool_search" && !included.has(name),
    );
    return [...alwaysActive, ...currentlyActive, ...loaded, "tool_search"];
  };

  const commitLeanSurface = (names: string[], allowLocked = false): void => {
    if (isPrefixLocked() && !allowLocked) return;
    const activeNames = pi.getActiveTools();
    const active = withoutUnavailableTools(activeNames);
    leanSurfaceInitialized = true;
    if (
      active.length === activeNames.length &&
      active.length === names.length &&
      active.every((name, index) => name === names[index])
    ) {
      return;
    }
    pi.setActiveTools(names);
  };

  const refreshSearchCatalog = (): void => {
    const allTools = pi
      .getAllTools()
      .filter((tool) => withoutUnavailableTools([tool.name]).length > 0);
    const allNames = new Set(allTools.map((tool) => tool.name));
    for (const name of withoutUnavailableTools(pi.getActiveTools())) allowedNames.add(name);
    searchableNames = new Set(
      [...allNames].filter(
        (name) =>
          !DISABLED_TOOL_NAMES.has(name) && allowedNames.has(name) && !ALWAYS_ACTIVE.has(name),
      ),
    );
    searchableDocuments = [
      ...buildPiDocuments(allTools.filter((tool) => searchableNames.has(tool.name))),
      ...loadMcpDocuments(enabledMcpServers),
    ];
  };

  const applyLeanSurface = (attempt = 0): void => {
    initializationScheduled = false;
    scheduledImmediate = undefined;
    scheduledTimeout = undefined;
    refreshSearchCatalog();
    commitLeanSurface(computeLeanSurface());
    if (!mcpCatalogReady && attempt < 4) {
      initializationScheduled = true;
      scheduledTimeout = setTimeout(() => applyLeanSurface(attempt + 1), 25 * (attempt + 1));
    }
  };

  const cancelScheduledLeanSurface = (): void => {
    if (scheduledImmediate !== undefined) clearImmediate(scheduledImmediate);
    if (scheduledTimeout !== undefined) clearTimeout(scheduledTimeout);
    scheduledImmediate = undefined;
    scheduledTimeout = undefined;
    initializationScheduled = false;
  };

  const scheduleLeanSurface = (): void => {
    if (initializationScheduled) return;
    initializationScheduled = true;
    scheduledImmediate = setImmediate(() => applyLeanSurface());
  };

  pi.registerTool({
    name: "tool_search",
    label: "Tool Search",
    description:
      "Search deferred Pi tools and cached MCP capabilities by natural language. Results include compact exec bridge call snippets without changing the provider tool list.",
    promptSnippet: "Discover deferred tools and call them through exec without activating them",
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: MAX_QUERY_LENGTH,
        description:
          "Natural-language capability to find, such as 'search Slack messages' or 'render Figma nodes'",
      }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: DEFAULT_LIMIT })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const query = params.query.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "Tool search query cannot be empty." }],
          isError: true,
          details: { matches: [], added: [] },
        };
      }

      const active = withoutUnavailableTools(pi.getActiveTools());
      const activeSet = new Set(active);
      const matches = rankTools(searchableDocuments, query).slice(0, params.limit ?? DEFAULT_LIMIT);
      const added = matches
        .filter((target): target is Extract<SearchTarget, { kind: "pi" }> => target.kind === "pi")
        .map((target) => target.tool.name)
        .filter((name) => !activeSet.has(name));
      const nativeToolSearch = usesNativeToolSearch(context);
      const activated = isPrefixLocked() && !nativeToolSearch ? [] : withoutUnavailableTools(added);
      if (activated.length > 0) {
        for (const name of activated) loadedNames.add(name);
        commitLeanSurface(computeLeanSurface(), nativeToolSearch);
      }

      const lines = matches.map((target) =>
        target.kind === "pi"
          ? `- ${target.tool.name} [Pi]: ${compactDescription(target.tool.description)}\n  Call: ${nativeToolSearch ? `${target.tool.name} directly (native provider tool search)` : `await tools.${target.tool.name}({ ...args })`}`
          : `- ${target.name} [MCP: ${target.server}]: ${compactDescription(target.description)}\n  Parameters: ${parameterSummary(target.parameters)}\n  Call: await tools.mcp({ tool: "${target.name}", args: { ...args } })`,
      );
      const mcpMatches = matches.filter((target) => target.kind === "mcp").length;
      const mcpHelp =
        mcpMatches > 0
          ? '\n\nUse mcp({ describe: "<tool>" }) only for matched MCP tools that need full parameter details.'
          : "";
      return {
        content: [
          {
            type: "text",
            text:
              matches.length === 0
                ? `No deferred tools found for: ${query}`
                : `Found ${matches.length} matching tool(s)${activated.length > 0 ? `; activated ${activated.length} Pi tool(s) before the provider prefix was locked` : ""}${mcpMatches > 0 ? `; ${mcpMatches} MCP tool(s) are callable through mcp` : ""}:\n${lines.join("\n")}${mcpHelp}`,
          },
        ],
        details: { matches: matches.map(targetName), added: activated },
      };
    },
  });

  pi.events.on("pi-mcp-adapter/status/v1", (payload) => {
    const snapshot = parseMcpStatusSnapshot(payload);
    enabledMcpServers = new Set(
      (snapshot.servers ?? []).flatMap((server) =>
        server.disabled !== true && isString(server.name) ? [server.name] : [],
      ),
    );
    mcpCatalogReady = true;
    if (sessionStarted) scheduleLeanSurface();
  });
  pi.on("session_start", () => {
    unlockPrefix();
    sessionStarted = true;
    mcpCatalogReady = false;
    loadedNames.clear();
    leanSurfaceInitialized = false;
    allowedNames = new Set(withoutUnavailableTools(pi.getActiveTools()));
    scheduleLeanSurface();
  });
  pi.on("before_agent_start", () => {
    cancelScheduledLeanSurface();
    refreshSearchCatalog();
    commitLeanSurface(computeLeanSurface());
    lockPrefix();
  });
  pi.on("session_shutdown", () => {
    sessionStarted = false;
  });
  pi.on("model_select", () => {
    unlockPrefix();
    scheduleLeanSurface();
  });
}
