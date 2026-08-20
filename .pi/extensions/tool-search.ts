import {
  isBoolean,
  isJsonRecord,
  isObject,
  isString,
  type RuntimeValue,
} from "./lib/runtime-values.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_QUERY_LENGTH = 500;
const DEFAULT_LIMIT = 5;

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
  "Agent",
  // Launching Agent inevitably leads to checking on or redirecting the
  // background agent it started; deferring these guarantees a mid-session
  // tool_search activation (and a full prompt-cache rewrite) in every
  // delegating session. Provided by choco-pi-subagents; if that package is
  // absent or renames a tool, these names simply never appear
  // in getActiveTools() and are dropped silently (see applyLeanSurface).
  "get_subagent_result",
  "steer_subagent",
  // choco-pi's cross-session tools are the same kind of coordination path:
  // listing, reading, waiting on, and steering another conversation happen
  // together, so deferring any of them costs a prompt-cache rewrite in the
  // middle of the coordination they support. Provided by session-bridge.ts.
  "session_create",
  "session_send",
  "session_list",
  "session_read",
  "session_wait",
  // choco-pi-lsp's own mandated funnel and completion gate (see .pi/SYSTEM.md
  // and the package's own runtime status line, which calls exactly this set
  // its "Key tools"): symbol_search finds candidates, module_report inspects
  // one, read_symbol/read_enclosing read a body before editing, and
  // lsp_diagnostics/diagnostics_report are required before declaring work
  // done. A session that reads or edits code with choco-pi-lsp active reaches
  // all six every time, so deferring any of them buys a mid-session
  // prompt-cache rewrite in the middle of that mandatory path. The package's
  // remaining tools (project_report, ast_grep_*, lsp_navigation,
  // diagnostic_mark) are choco-pi-lsp's own "situational" tools, gated behind
  // its own lsp_activate_tools call even when this extension's tool_search is
  // bypassed; they stay deferred here. Provided by choco-pi-lsp; if that
  // package is absent or renames a tool, these names simply never
  // appear in getActiveTools() and are dropped silently (see
  // applyLeanSurface).
  "symbol_search",
  "module_report",
  "read_symbol",
  "read_enclosing",
  "lsp_diagnostics",
  "diagnostics_report",
  "mcp",
  "tool_search",
] as const;
const ALWAYS_ACTIVE = new Set<string>(ALWAYS_ACTIVE_TOOL_NAMES);

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
  return tools.map((tool) =>
    makeDocument({ kind: "pi", tool }, `${tool.sourceInfo.source} ${tool.sourceInfo.path}`),
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

export default function toolSearch(pi: ExtensionAPI): void {
  let searchableNames = new Set<string>();
  let searchableDocuments: SearchDocument[] = [];
  let allowedNames = new Set<string>();
  const loadedNames = new Set<string>();
  let initializationScheduled = false;
  let sessionStarted = false;
  let mcpCatalogReady = false;
  let enabledMcpServers: Set<string> | undefined;

  const applyLeanSurface = (attempt = 0): void => {
    initializationScheduled = false;
    const allTools = pi.getAllTools();
    const allNames = new Set(allTools.map((tool) => tool.name));
    for (const name of pi.getActiveTools()) allowedNames.add(name);
    searchableNames = new Set(
      [...allNames].filter((name) => allowedNames.has(name) && !ALWAYS_ACTIVE.has(name)),
    );
    searchableDocuments = [
      ...buildPiDocuments(allTools.filter((tool) => searchableNames.has(tool.name))),
      ...loadMcpDocuments(enabledMcpServers),
    ];
    const active = pi.getActiveTools();
    const leanSurface = active.filter((name) => ALWAYS_ACTIVE.has(name) || loadedNames.has(name));
    pi.setActiveTools([...new Set([...leanSurface, "tool_search"])]);
    if (!mcpCatalogReady && attempt < 4) {
      initializationScheduled = true;
      setTimeout(() => applyLeanSurface(attempt + 1), 25 * (attempt + 1));
    }
  };

  const scheduleLeanSurface = (): void => {
    if (initializationScheduled) return;
    initializationScheduled = true;
    setImmediate(() => applyLeanSurface());
  };

  pi.registerTool({
    name: "tool_search",
    label: "Tool Search",
    description:
      "Search deferred Pi tools and cached MCP capabilities by natural language. Pi tools are activated; MCP matches are returned with compact parameters and called through the active mcp gateway.",
    promptSnippet: "Search for deferred tools when the active tools cannot perform the task",
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: MAX_QUERY_LENGTH,
        description:
          "Natural-language capability to find, such as 'search Slack messages' or 'render Figma nodes'",
      }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: DEFAULT_LIMIT })),
    }),
    async execute(_toolCallId, params) {
      const query = params.query.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "Tool search query cannot be empty." }],
          isError: true,
          details: { matches: [], added: [] },
        };
      }

      const active = pi.getActiveTools();
      const activeSet = new Set(active);
      const matches = rankTools(searchableDocuments, query).slice(0, params.limit ?? DEFAULT_LIMIT);
      const added = matches
        .filter((target): target is Extract<SearchTarget, { kind: "pi" }> => target.kind === "pi")
        .map((target) => target.tool.name)
        .filter((name) => !activeSet.has(name));
      if (added.length > 0) {
        for (const name of added) loadedNames.add(name);
        pi.setActiveTools([...new Set([...active, ...added])]);
      }

      const lines = matches.map((target) =>
        target.kind === "pi"
          ? `- ${target.tool.name} [Pi]: ${compactDescription(target.tool.description)}\n  Call: ${target.tool.name} directly (native Pi tool; never use mcp)`
          : `- ${target.name} [MCP: ${target.server}]: ${compactDescription(target.description)}\n  Parameters: ${parameterSummary(target.parameters)}\n  Call: mcp({ tool: "${target.name}", args: { ... } })`,
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
                : `Found ${matches.length} matching tool(s)${added.length > 0 ? `; activated ${added.length} Pi tool(s)` : ""}${mcpMatches > 0 ? `; ${mcpMatches} MCP tool(s) are callable through mcp` : ""}:\n${lines.join("\n")}${mcpHelp}`,
          },
        ],
        details: { matches: matches.map(targetName), added },
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
    sessionStarted = true;
    mcpCatalogReady = false;
    loadedNames.clear();
    allowedNames = new Set(pi.getActiveTools());
    scheduleLeanSurface();
  });
  pi.on("session_shutdown", () => {
    sessionStarted = false;
  });
  pi.on("model_select", scheduleLeanSurface);
}
