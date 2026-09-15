import type { RuntimeValue } from "./runtime-values.ts";
/**
 * symbol_search pi tool (#348) — the entry point of the discovery funnel:
 * symbol_search finds ranked candidate files by identifier, module_report
 * explains one, read_symbol reads the exact body. Thin wrapper over the
 * existing symbolSearch() engine seam (clients/lsp-engine.ts), mirroring the
 * MCP pilens_symbol_search tool with the same #517-slimmed payload.
 */

import * as path from "node:path";
import { Type } from "../clients/deps/typebox.ts";
import { symbolSearch, type SymbolSearchResult } from "../clients/lsp-engine.ts";
import { baseName, compactRenderResult } from "./render-compact.ts";

/**
 * Machine-actionable follow-up hint (#771) — mirrors ast-grep-search.ts's
 * `suggestedDump` pattern. Cheap enough to attach per hit rather than only the
 * top one: it's a pure derivation of `relPath`, no extra computation. Points
 * the discovery funnel's next step (module_report explains the file; from
 * there read_symbol reads a body).
 */
function suggestedNext(relPath: string) {
  return { tool: "module_report", path: relPath };
}

export function createSymbolSearchTool(getProjectRoot: () => string) {
  return {
    name: "symbol_search" as const,
    label: "Symbol Search",
    description: "Find relevant files with a ranked identifier index.",
    promptSnippet: "Find relevant files by identifier.",
    renderResult: compactRenderResult<{
      available?: boolean;
      query?: string;
      count?: number;
      hint?: string;
      unavailableReason?: string;
    }>(({ details, isError }) => {
      if (isError || details?.available === false) {
        return `symbol_search "${details?.query ?? ""}" — unavailable${details?.hint ? `: ${details.hint}` : ""}`;
      }
      return `symbol_search "${details?.query ?? ""}"  ${details?.count ?? 0} file(s)`;
    }),
    parameters: Type.Object({
      query: Type.String({
        description: "Identifier query with optional lang, file, or ext filters.",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max files to return (default 20).",
        }),
      ),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Glob patterns limiting files searched before ranking.",
        }),
      ),
      lang: Type.Optional(
        Type.String({
          description: "Language identifier limiting search results.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { query: string; limit?: number; paths?: string[]; lang?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: RuntimeValue,
      ctx: { cwd?: string },
    ) {
      const cwd = getProjectRoot() || ctx.cwd || ".";
      let result: SymbolSearchResult;
      try {
        result = await symbolSearch(params.query, cwd, params.limit, {
          paths: params.paths,
          lang: params.lang,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Symbol search failed for "${params.query}": ${message}`,
            },
          ],
          isError: true,
          details: { available: false, query: params.query },
        };
      }
      if (!result.available) {
        return {
          content: [
            {
              type: "text" as const,
              text: result.hint ?? "No word index for this workspace yet — retry shortly.",
            },
          ],
          isError: true,
          details: {
            available: false,
            query: result.query,
            hint: result.hint,
            unavailableReason: result.unavailableReason,
          },
        };
      }
      if (result.results.length === 0) {
        const coverageLine = result.coverage
          ? `Index covers ${result.coverage.files} files${result.coverage.truncated ? " (capped — results may be incomplete)" : ""}.`
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `No files matched "${params.query}".${coverageLine ? `\n${coverageLine}` : ""}`,
            },
          ],
          details: {
            available: true,
            query: result.query,
            count: 0,
            coverage: result.coverage,
          },
        };
      }
      const lines = [
        `Top ${result.results.length} file(s) for "${result.query}":`,
        ...result.results.map(
          (hit, i) =>
            `  ${i + 1}. ${path.relative(cwd, hit.file)} ` +
            `(score ${hit.score.toFixed(2)}, ${hit.hits} hit(s), line ${hit.startLine})`,
        ),
        ...(result.coverage
          ? [
              `Index covers ${result.coverage.files} files${result.coverage.truncated ? " (capped — results may be incomplete)" : ""}.`,
            ]
          : []),
      ];
      // Compact (unindented) JSON payload, matching module_report/read_symbol
      // (#517): path relative-to-cwd once per hit, no per-hit `read` block —
      // startLine/endLine already derive offset/limit for a one-line peek.
      const payload = {
        available: true,
        query: result.query,
        coverage: result.coverage,
        results: result.results.map((hit) => {
          const relFile = path.relative(cwd, hit.file);
          return {
            file: relFile,
            score: hit.score,
            hits: hit.hits,
            startLine: hit.startLine,
            endLine: hit.endLine,
            ...includePropertiesWhen(hit.annotations, () => ({ annotations: hit.annotations })),
            suggestedNext: suggestedNext(relFile),
          };
        }),
      };
      return {
        content: [
          { type: "text" as const, text: `${lines.join("\n")}\n\n${JSON.stringify(payload)}` },
        ],
        details: {
          available: true,
          query: result.query,
          count: result.results.length,
          coverage: result.coverage,
        },
      };
    },
  };
}

// Re-exported so tests importing from this module can reach baseName without
// a second import path.
export { baseName };

function includePropertiesWhen<T extends object, TInclude>(
  include: TInclude,
  createProperties: () => T,
): Partial<T> {
  const properties: Partial<T> = {};
  if (include) Object.assign(properties, createProperties());
  return properties;
}
