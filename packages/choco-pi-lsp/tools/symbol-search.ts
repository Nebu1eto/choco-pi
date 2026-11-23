import { includePropertiesWhen } from "../clients/optional-properties.ts";
import type { RuntimeValue } from "./runtime-values.ts";

import * as path from "node:path";
import { arr, num, obj, opt, str } from "@earendil-works/pi-schema";
import { hostParams } from "./schema-bridge.ts";
import { symbolSearch, type SymbolSearchResult } from "../clients/lsp-engine.ts";
import { baseName, compactRenderResult } from "./render-compact.ts";
import { stringifySnakeCase } from "./output-keys.ts";

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
    parameters: hostParams(
      obj(
        {
          query: str({
            description: "Identifier query with optional lang, file, or ext filters.",
          }),
          limit: opt(
            num({
              description: "Max files to return (default 20).",
            }),
          ),
          paths: opt(
            arr(str(), {
              description: "Glob patterns limiting files searched before ranking.",
            }),
          ),
          lang: opt(
            str({
              description: "Language identifier limiting search results.",
            }),
          ),
        },
        { open: true },
      ),
    ),
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
          { type: "text" as const, text: `${lines.join("\n")}\n\n${stringifySnakeCase(payload)}` },
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

export { baseName };
