import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { arr, int, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { hostParams } from "../schema-bridge.ts";
import { rejectLegacyParamNames } from "../snake-params.ts";
import { isNumberValue } from "../value-guards.ts";
import type { ExtractedContent } from "../extract.ts";
import { findContent } from "../content-find.ts";
import { getResearchArtifact } from "../source-check.ts";
import { resolveStoredResult, type QueryResultData } from "../storage.ts";
import { buildSearchErrorPlan } from "../render-search-error.ts";
import {
  formatInputValue,
  getMaxInlineContentChars,
  normalizeFindMode,
  normalizeFindQueries,
  type DetailObject,
  type ToolNames,
  type WebSearchConfig,
} from "../extension-config.ts";
import {
  formatFullResults,
  formatSearchDiagnostics,
  renderSearchErrorPlan,
  searchDiagnosticDetails,
} from "../search-formatting.ts";

export function registerGetSearchContentTool(
  pi: ExtensionAPI,
  initConfig: WebSearchConfig,
  toolNames: ToolNames,
  storedContentSources: string,
  searchQueryDescription: string,
): void {
  const maxInlineContentChars = getMaxInlineContentChars(initConfig);
  pi.registerTool({
    name: toolNames.getSearchContent,
    label: "Get Search Content",
    description: `Retrieve bounded content slices or find matching passages in a previous ${storedContentSources} call.`,
    promptSnippet: "Retrieve slices or matching passages from stored content.",
    parameters: hostParams(
      obj({
        response_id: str({ description: `The response_id from ${storedContentSources}` }),
        query: opt(str({ description: searchQueryDescription })),
        query_index: opt(int({ minimum: 0, description: "Get content for query at index" })),
        url: opt(str({ description: "Get content for this URL" })),
        url_index: opt(int({ minimum: 0, description: "Get content for URL at index" })),
        offset: opt(
          int({
            minimum: 0,
            description: "Slice offset; cannot be combined with find_text.",
          }),
        ),
        limit: opt(
          int({
            minimum: 1,
            maximum: maxInlineContentChars,
            description: "Slice length; cannot be combined with find_text.",
          }),
        ),
        find_text: opt(
          union(
            [
              str({ minLength: 1, maxLength: 500 }),
              arr(str({ minLength: 1, maxLength: 500 }), {
                minItems: 1,
                maxItems: 10,
              }),
            ],
            {
              description:
                "Text or texts to find in the selected stored content. Cannot be combined with offset or limit.",
            },
          ),
        ),
        find_mode: opt(
          oneOf(["exact", "case-insensitive", "fuzzy"], {
            description:
              "Matching mode for find_text (default: case-insensitive). Requires find_text.",
          }),
        ),
      }),
    ),

    async execute(_toolCallId, params): Promise<AgentToolResult<DetailObject>> {
      rejectLegacyParamNames(Object.keys(params), [
        "responseId",
        "queryIndex",
        "urlIndex",
        "findText",
        "findMode",
      ]);
      if (
        params.find_text !== undefined &&
        (params.offset !== undefined || params.limit !== undefined)
      ) {
        const offset = formatInputValue(params.offset);
        const limit = formatInputValue(params.limit);
        return {
          content: [
            {
              type: "text",
              text: `find_text cannot be combined with offset or limit. Received offset=${offset}, limit=${limit}; omit offset and limit when using find_text.`,
            },
          ],
          details: { error: "Incompatible find options" },
        };
      }
      if (params.find_mode !== undefined && params.find_text === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `find_mode ${formatInputValue(params.find_mode)} requires find_text; provide find_text or omit find_mode.`,
            },
          ],
          details: { error: "find_mode requires find_text" },
        };
      }
      const lookup = await resolveStoredResult(params.response_id);
      if (!lookup.data) {
        return {
          content: [
            {
              type: "text",
              text: `Error: No stored results for response_id ${formatInputValue(params.response_id)}: ${lookup.message}. Use a response_id returned by ${storedContentSources}.`,
            },
          ],
          details: {
            error: "Not found",
            responseId: params.response_id,
            reset: lookup.reset,
            disk: lookup.disk,
          },
        };
      }
      const data = lookup.data;

      if (data.type === "research") {
        const artifact = getResearchArtifact(params.response_id);
        if (!artifact) {
          return {
            content: [
              {
                type: "text",
                text: `Error: stored research artifact for response_id ${formatInputValue(params.response_id)} was not found. Use a response_id returned by ${storedContentSources}.`,
              },
            ],
            details: { error: "Artifact not found", responseId: params.response_id },
          };
        }
        const serialized = JSON.stringify(artifact, null, 2);
        const offset = params.offset ?? 0;
        const limit = params.limit ?? maxInlineContentChars;
        if (!Number.isInteger(offset) || offset < 0) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid offset: received ${formatInputValue(offset)} for response_id ${formatInputValue(params.response_id)}; offset must be a non-negative integer. Use 0 or a larger integer.`,
              },
            ],
            details: { error: "Invalid offset", offset },
          };
        }
        if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid limit: received ${formatInputValue(limit)} for response_id ${formatInputValue(params.response_id)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.`,
              },
            ],
            details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
          };
        }
        if (offset > serialized.length) {
          return {
            content: [
              {
                type: "text",
                text: `Offset ${offset} is out of range for response_id ${formatInputValue(params.response_id)}. Received offset ${offset}; valid range is 0-${serialized.length}. Use an offset within that range.`,
              },
            ],
            details: { error: "Offset out of range", offset, contentLength: serialized.length },
          };
        }
        const endOffset = Math.min(offset + limit, serialized.length);
        const artifactSlice = serialized.slice(offset, endOffset);
        const hasMore = endOffset < serialized.length;
        return {
          content: [{ type: "text", text: artifactSlice }],
          details: {
            responseId: artifact.id,
            type: "research",
            contentLength: serialized.length,
            offset,
            limit,
            returnedChars: artifactSlice.length,
            nextOffset: hasMore ? endOffset : null,
            truncated: hasMore,
          },
        };
      }

      if (data.type === "search" && data.queries) {
        let queryData: QueryResultData | undefined;

        if (params.query !== undefined) {
          queryData = data.queries.find((q) => q.query === params.query);
          if (!queryData) {
            const available = data.queries.map((q) => `"${q.query}"`).join(", ");
            return {
              content: [
                {
                  type: "text",
                  text: `Query ${formatInputValue(params.query)} was not found for response_id ${formatInputValue(params.response_id)}. Received query=${formatInputValue(params.query)}. Available queries: ${available || "none"}. Use one of the available queries or query_index.`,
                },
              ],
              details: { error: "Query not found" },
            };
          }
        } else if (params.query_index === undefined) {
          if (data.queries.length === 1) {
            queryData = data.queries[0];
          } else if (data.queries.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No queries were stored for response_id ${formatInputValue(params.response_id)}.`,
                },
              ],
              details: { error: "No queries stored" },
            };
          } else {
            const combined = data.queries
              .map((entry, index) =>
                entry.error
                  ? `## Query ${index}: "${entry.query}"\n\nError: ${entry.error}`
                  : formatFullResults(entry),
              )
              .join("\n\n---\n\n");
            if (params.find_text !== undefined) {
              try {
                const found = findContent(
                  combined,
                  normalizeFindQueries(params.find_text),
                  normalizeFindMode(params.find_mode),
                );
                const { text, ...findDetails } = found;
                return {
                  content: [{ type: "text", text }],
                  details: {
                    queryCount: data.queries.length,
                    findMode: params.find_mode ?? "case-insensitive",
                    ...findDetails,
                  },
                };
              } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                return {
                  content: [
                    {
                      type: "text",
                      text: `Unable to find ${formatInputValue(params.find_text)} for response_id ${formatInputValue(params.response_id)}: ${error}. Check find_text and use a supported find_mode.`,
                    },
                  ],
                  details: { error },
                };
              }
            }
            const offset = params.offset ?? 0;
            const limit = params.limit ?? maxInlineContentChars;
            const slice = combined.slice(offset, offset + limit);
            const truncated = offset + limit < combined.length;
            return {
              content: [{ type: "text", text: slice }],
              details: {
                queryCount: data.queries.length,
                contentLength: combined.length,
                offset,
                limit,
                returnedChars: slice.length,
                nextOffset: truncated ? offset + limit : null,
                truncated,
              },
            };
          }
        } else {
          queryData = data.queries[params.query_index];
          if (!queryData) {
            const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
            return {
              content: [
                {
                  type: "text",
                  text: `Query index ${formatInputValue(params.query_index)} is out of range for response_id ${formatInputValue(params.response_id)}. Received query_index=${formatInputValue(params.query_index)}; valid indexes are 0-${data.queries.length - 1}. Available queries: ${available || "none"}. Use one of the available indexes.`,
                },
              ],
              details: { error: "Index out of range" },
            };
          }
        }

        if (queryData.error) {
          const diagnostics = formatSearchDiagnostics(queryData);
          const diagnosticText =
            diagnostics.length > 0 ? `\n\nSearch diagnostics:\n${diagnostics.join("\n")}` : "";
          return {
            content: [
              {
                type: "text",
                text: `Error retrieving query ${formatInputValue(queryData.query)} from response_id ${formatInputValue(params.response_id)}: ${queryData.error}. Check the stored search result and retry with another query or query_index if needed.${diagnosticText}`,
              },
            ],
            details: {
              error: queryData.error,
              query: queryData.query,
              searchDiagnostics: searchDiagnosticDetails(queryData),
            },
          };
        }

        const fullResults = formatFullResults(queryData);
        if (params.find_text !== undefined) {
          try {
            const found = findContent(
              fullResults,
              normalizeFindQueries(params.find_text),
              normalizeFindMode(params.find_mode),
            );
            const { text, ...findDetails } = found;
            return {
              content: [{ type: "text", text }],
              details: {
                query: queryData.query,
                resultCount: queryData.results.length,
                searchDiagnostics: searchDiagnosticDetails(queryData),
                findMode: params.find_mode ?? "case-insensitive",
                ...findDetails,
              },
            };
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return {
              content: [
                {
                  type: "text",
                  text: `Unable to find ${formatInputValue(params.find_text)} in query ${formatInputValue(queryData.query)} for response_id ${formatInputValue(params.response_id)}: ${error}. Check find_text and use a supported find_mode.`,
                },
              ],
              details: { error, query: queryData.query },
            };
          }
        }

        return {
          content: [{ type: "text", text: fullResults }],
          details: {
            query: queryData.query,
            resultCount: queryData.results.length,
            searchDiagnostics: searchDiagnosticDetails(queryData),
          },
        };
      }

      if (data.type === "fetch" && data.urls) {
        let urlData: ExtractedContent | undefined;
        let selectedUrlIndex = -1;

        if (params.url !== undefined) {
          selectedUrlIndex = data.urls.findIndex((u) => u.url === params.url);
          urlData = data.urls[selectedUrlIndex];
          if (!urlData) {
            const available = data.urls.map((u) => u.url).join("\n  ");
            return {
              content: [
                {
                  type: "text",
                  text: `URL ${formatInputValue(params.url)} was not found for response_id ${formatInputValue(params.response_id)}. Received url=${formatInputValue(params.url)}. Available URLs:\n  ${available || "  none"}\nUse one of the available URLs or url_index.`,
                },
              ],
              details: { error: "URL not found" },
            };
          }
        } else if (params.url_index === undefined) {
          const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
          return {
            content: [
              {
                type: "text",
                text: `Specify url or url_index for response_id ${formatInputValue(params.response_id)}. Available URLs:\n  ${available || "  none"}`,
              },
            ],
            details: { error: "No URL specified" },
          };
        } else {
          selectedUrlIndex = params.url_index;
          urlData = data.urls[selectedUrlIndex];
          if (!urlData) {
            const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
            return {
              content: [
                {
                  type: "text",
                  text: `URL index ${formatInputValue(params.url_index)} is out of range for response_id ${formatInputValue(params.response_id)}. Received url_index=${formatInputValue(params.url_index)}; valid indexes are 0-${data.urls.length - 1}. Available URLs:\n  ${available || "  none"}\nUse one of the available indexes.`,
                },
              ],
              details: { error: "Index out of range" },
            };
          }
        }

        if (urlData.error) {
          return {
            content: [
              {
                type: "text",
                text: `Error retrieving URL ${formatInputValue(urlData.url)} from response_id ${formatInputValue(params.response_id)}: ${urlData.error}. Check the stored fetch result and retry with another URL or url_index if needed.`,
              },
            ],
            details: { error: urlData.error, url: urlData.url },
          };
        }

        if (params.find_text !== undefined) {
          try {
            const found = findContent(
              urlData.content,
              normalizeFindQueries(params.find_text),
              normalizeFindMode(params.find_mode),
            );
            const { text, ...findDetails } = found;
            return {
              content: [{ type: "text", text: `# ${urlData.title || urlData.url}\n\n${text}` }],
              details: {
                url: urlData.url,
                title: urlData.title,
                contentLength: urlData.content.length,
                findMode: params.find_mode ?? "case-insensitive",
                ...findDetails,
              },
            };
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return {
              content: [
                {
                  type: "text",
                  text: `Unable to find ${formatInputValue(params.find_text)} in URL ${formatInputValue(urlData.url)} for response_id ${formatInputValue(params.response_id)}: ${error}. Check find_text and use a supported find_mode.`,
                },
              ],
              details: { error, url: urlData.url },
            };
          }
        }

        const offset = params.offset ?? 0;
        const limit = params.limit ?? maxInlineContentChars;
        if (!Number.isInteger(offset) || offset < 0) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid offset: received ${formatInputValue(offset)} for URL ${formatInputValue(urlData.url)}; offset must be a non-negative integer. Use 0 or a larger integer.`,
              },
            ],
            details: { error: "Invalid offset", offset },
          };
        }
        if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid limit: received ${formatInputValue(limit)} for URL ${formatInputValue(urlData.url)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.`,
              },
            ],
            details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
          };
        }
        if (offset > urlData.content.length) {
          return {
            content: [
              {
                type: "text",
                text: `Offset ${offset} is out of range for URL ${formatInputValue(urlData.url)} in response_id ${formatInputValue(params.response_id)}. Received offset ${offset}; valid range is 0-${urlData.content.length}. Use an offset within that range.`,
              },
            ],
            details: {
              error: "Offset out of range",
              offset,
              contentLength: urlData.content.length,
            },
          };
        }

        const endOffset = Math.min(offset + limit, urlData.content.length);
        const contentSlice = urlData.content.slice(offset, endOffset);
        const hasMore = endOffset < urlData.content.length;
        let text = `# ${urlData.title || urlData.url}\n\n${contentSlice}`;
        if (hasMore || offset > 0) {
          text += `\n\n---\nShowing chars ${offset}-${endOffset} of ${urlData.content.length}.`;
          if (hasMore) {
            text += ` Use ${toolNames.getSearchContent}({ response_id: "${params.response_id}", url_index: ${selectedUrlIndex}, offset: ${endOffset}, limit: ${limit} }) for the next slice.`;
          }
        }

        return {
          content: [{ type: "text", text }],
          details: {
            url: urlData.url,
            title: urlData.title,
            contentLength: urlData.content.length,
            offset,
            limit,
            returnedChars: contentSlice.length,
            nextOffset: hasMore ? endOffset : null,
            truncated: hasMore,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Invalid stored data for response_id ${formatInputValue(params.response_id)}: received type ${formatInputValue(data.type)}. Use a response_id returned by ${storedContentSources}.`,
          },
        ],
        details: { error: "Invalid data" },
      };
    },

    renderCall(args, theme) {
      const { response_id, query, query_index, url, url_index, offset, find_text } = args;
      let target = "";
      if (query) target = `query="${query}"`;
      else if (query_index !== undefined) target = `query_index=${query_index}`;
      else if (url) target = url.length > 30 ? url.slice(0, 27) + "..." : url;
      else if (url_index !== undefined) target = `url_index=${url_index}`;
      if (offset !== undefined) target += target ? ` @ ${offset}` : `offset=${offset}`;
      if (find_text !== undefined) {
        const queries = Array.isArray(find_text) ? find_text : [find_text];
        target += `${target ? " · " : ""}find ${queries.length}`;
      }
      return new Text(
        theme.fg("toolTitle", theme.bold("get_content ")) +
          theme.fg("accent", target || response_id.slice(0, 8)),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      // SAFETY: Get-search-content results are created by this tool with the fields declared below.
      const details = result.details as {
        error?: string;
        query?: string;
        url?: string;
        title?: string;
        resultCount?: number;
        contentLength?: number;
        offset?: number;
        returnedChars?: number;
        nextOffset?: number | null;
        matchCount?: number;
        returnedMatches?: number;
      };

      if (details?.error) {
        const extras: string[] = [];
        if (details.query) extras.push(`query: ${details.query}`);
        if (details.url) extras.push(`url: ${details.url}`);
        else if (details.title) extras.push(`resource: ${details.title}`);
        const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
        if (plan) return renderSearchErrorPlan(plan, expanded, theme);
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      let statusLine: string;
      if (isNumberValue(details?.matchCount)) {
        statusLine =
          theme.fg("success", details?.title || details?.query || "Content") +
          theme.fg(
            "muted",
            ` (${details.matchCount} matches, ${details.returnedMatches ?? 0} shown)`,
          );
      } else if (details?.query) {
        statusLine =
          theme.fg("success", `"${details.query}"`) +
          theme.fg("muted", ` (${details.resultCount} results)`);
      } else {
        const start = details?.offset ?? 0;
        const returned = details?.returnedChars ?? details?.contentLength ?? 0;
        const end = start + returned;
        const slice =
          details?.nextOffset !== undefined || start > 0 ? `, showing ${start}-${end}` : "";
        statusLine =
          theme.fg("success", details?.title || "Content") +
          theme.fg("muted", ` (${details?.contentLength ?? 0} chars${slice})`);
      }

      if (!expanded) {
        return new Text(statusLine, 0, 0);
      }

      const textContent = result.content.find((c) => c.type === "text")?.text || "";
      const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
      return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });
}
