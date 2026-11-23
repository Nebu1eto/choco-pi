import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { arr, bool, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import { hostParams } from "../schema-bridge.ts";
import { rejectLegacyParamNames } from "../snake-params.ts";
import { isNumberValue } from "../value-guards.ts";
import type { ExtractedContent, ExtractOptions } from "../extract.ts";
import { normalizeFetchContentParams } from "../fetch-params.ts";
import { resolveAuthFetchProfile, type AuthFetchProfile } from "../auth-fetch.ts";
import { answerFromPage } from "../page-query.ts";
import { formatMultiUrlFetchSummary, type FetchSummaryRetrieval } from "../fetch-continuation.ts";
import { generateId, type StoredSearchData } from "../storage.ts";
import { buildSearchErrorPlan } from "../render-search-error.ts";
import {
  getMaxInlineContentChars,
  initialContentSlice,
  storeFetchResult,
  stripThumbnails,
  type DetailObject,
  type ToolNames,
} from "../extension-config.ts";
import { renderSearchErrorPlan } from "../search-formatting.ts";
import { fetchAllContent } from "../curator-lifecycle.ts";

export function registerFetchContentTool(
  pi: ExtensionAPI,
  toolNames: ToolNames,
  getSearchContentEnabled: boolean,
): void {
  pi.registerTool({
    name: toolNames.fetchContent,
    label: "Fetch Content",
    description: `Fetch readable, raw, or question-focused URL content; long or multi-URL output is stored and its footer gives the exact ${toolNames.getSearchContent} response_id/url_index/offset call to continue.`,
    promptSnippet: "Fetch readable or raw content from URLs.",
    parameters: hostParams(
      obj({
        url: opt(str({ description: "Single URL to fetch" })),
        urls: opt(arr(str(), { description: "Multiple URLs (parallel)" })),
        force_clone: opt(
          bool({
            description: "Force cloning large GitHub repositories that exceed the size threshold",
          }),
        ),
        prompt: opt(
          str({
            description: "Page-local question required by mode answer.",
          }),
        ),
        mode: opt(
          oneOf(["readable", "raw", "answer"], {
            description: "Output readable, raw, or source-grounded answer content.",
          }),
        ),
        answer_model: opt(
          str({
            description: "Provider/model override for answer mode.",
          }),
        ),
        auth: opt(
          union([str(), bool()], {
            description: "Authentication profile name, or true for the sole profile.",
          }),
        ),
      }),
    ),

    async execute(
      _toolCallId,
      params,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<DetailObject>> {
      rejectLegacyParamNames(Object.keys(params), ["forceClone", "answerModel"]);
      let normalized: ReturnType<typeof normalizeFetchContentParams>;
      try {
        normalized = normalizeFetchContentParams(params);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
      }
      const { urlList, options } = normalized;
      const mode = options.mode ?? "readable";
      if (mode === "answer" && !options.prompt) {
        return {
          content: [{ type: "text", text: "Error: mode answer requires prompt." }],
          details: { error: "mode answer requires prompt" },
        };
      }
      if (
        mode === "raw" &&
        (options.forceClone === true || options.prompt || options.answerModel)
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Error: mode raw cannot be combined with force_clone, prompt, or answer_model.",
            },
          ],
          details: { error: "Incompatible raw mode options" },
        };
      }
      if (mode !== "answer" && options.answerModel) {
        return {
          content: [{ type: "text", text: "Error: answer_model requires mode answer." }],
          details: { error: "answer_model requires mode answer" },
        };
      }
      if (mode === "answer" && options.auth !== undefined) {
        return {
          content: [{ type: "text", text: "Error: auth cannot be combined with mode answer." }],
          details: { error: "auth cannot be combined with mode answer" },
        };
      }
      let authFetchProfile: AuthFetchProfile | undefined;
      if (options.auth !== undefined) {
        try {
          authFetchProfile = await resolveAuthFetchProfile(options.auth);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
        }
      }
      if (urlList.length === 0) {
        return {
          content: [{ type: "text", text: "Error: No URL provided." }],
          details: { error: "No URL provided" },
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
        details: { phase: "fetch", progress: 0 },
      });

      const { answerModel: _answerModel, auth: _auth, ...extractionOptions } = options;
      let fetchOptions: ExtractOptions;
      if (mode === "answer") {
        const { prompt: _prompt, ...rest } = extractionOptions;
        fetchOptions = rest;
      } else {
        fetchOptions = extractionOptions;
      }
      if (authFetchProfile) fetchOptions.authFetchProfile = authFetchProfile;
      const fetchResults = await fetchAllContent(urlList, signal, fetchOptions);
      const presentedResults =
        mode === "answer"
          ? await Promise.all(
              fetchResults.map(async (result) => {
                if (result.error) return result;
                if (result.thumbnail || result.mimeType?.startsWith("image/")) {
                  return { ...result, error: "Page answer requires textual fetched content" };
                }
                try {
                  const answerOptions: Parameters<typeof answerFromPage>[0] = {
                    question: options.prompt!,
                    pageText: result.content,
                    sourceUrl: result.url,
                  };
                  if (options.answerModel) answerOptions.model = options.answerModel;
                  const answer = await answerFromPage(answerOptions, ctx, signal);
                  return { ...result, content: answer.text };
                } catch (err) {
                  return {
                    ...result,
                    error: `Page answer failed: ${err instanceof Error ? err.message : String(err)}`,
                  };
                }
              }),
            )
          : fetchResults;
      const successful = presentedResults.filter((r) => !r.error).length;
      const totalChars = presentedResults.reduce((sum, r) => sum + r.content.length, 0);

      const responseId = generateId();
      const data = {
        id: responseId,
        type: "fetch",
        timestamp: Date.now(),
        urls: stripThumbnails(fetchResults),
      } satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
      const storedContent = storeFetchResult(pi, responseId, data, authFetchProfile);

      // Single URL: return content directly (possibly truncated) with responseId
      if (urlList.length === 1) {
        const result = presentedResults[0];
        if (result.error) {
          const errorDetails: DetailObject = {
            urls: urlList,
            urlCount: 1,
            successful: 0,
            error: result.error,
            prompt: params.prompt,
          };
          if (storedContent) errorDetails.responseId = responseId;
          return {
            content: [{ type: "text", text: `Error: ${result.error}` }],
            details: errorDetails,
          };
        }

        const fullLength = result.content.length;
        const slice = initialContentSlice(result.content, getMaxInlineContentChars());
        const truncated = slice.endOffset < fullLength;
        let output = slice.text;

        if (truncated) {
          output += `\n\n---\nShowing ${slice.endOffset} of ${fullLength} chars, ${slice.shownBytes} of ${slice.totalBytes} bytes, and ${slice.shownLines} of ${slice.totalLines} lines. `;
          output += storedContent
            ? getSearchContentEnabled
              ? `Use ${toolNames.getSearchContent}({ response_id: "${responseId}", url_index: 0, offset: ${slice.endOffset} }) for the next slice.`
              : "Content retrieval is not registered."
            : "Authenticated fetch cache is off; repeat the fetch to read more.";
        }

        const content: Array<TextContent | ImageContent> = [];
        if (result.thumbnail) {
          content.push({
            type: "image",
            data: result.thumbnail.data,
            mimeType: result.thumbnail.mimeType,
          });
        }
        content.push({ type: "text", text: output });

        const imageCount = result.thumbnail ? 1 : 0;
        const successDetails: DetailObject = {
          urls: urlList,
          urlCount: 1,
          successful: 1,
          totalChars: fullLength,
          title: result.title,
          truncated,
          hasImage: imageCount > 0,
          imageCount,
          prompt: params.prompt,
          mode,
          mimeType: result.mimeType,
          status: result.status,
          totalBytes: slice.totalBytes,
          totalLines: slice.totalLines,
          shownBytes: slice.shownBytes,
          shownLines: slice.shownLines,
        };
        if (storedContent) successDetails.responseId = responseId;
        return { content, details: successDetails };
      }

      // Multi-URL: summary with per-URL stored length and exact continuation calls.
      // Offsets index the stored content (data.urls), which answer mode does not replace.
      let retrieval: FetchSummaryRetrieval = { kind: "cache-off" };
      if (storedContent && getSearchContentEnabled) {
        retrieval = {
          kind: "stored",
          toolName: toolNames.getSearchContent,
          responseId,
          maxSliceChars: getMaxInlineContentChars(),
        };
      } else if (storedContent) {
        retrieval = { kind: "unregistered" };
      }
      const output = formatMultiUrlFetchSummary(
        presentedResults.map((result, index) => ({
          url: result.url,
          title: result.title,
          error: result.error,
          content: data.urls[index]?.content ?? result.content,
        })),
        retrieval,
      );

      const details: DetailObject = {
        urls: urlList,
        urlCount: urlList.length,
        successful,
        totalChars,
      };
      if (storedContent) details.responseId = responseId;
      return {
        content: [{ type: "text", text: output }],
        details,
      };
    },

    renderCall(args, theme) {
      const { urlList, options } = normalizeFetchContentParams(args);
      const { prompt, mode, answerModel, auth } = options;
      if (urlList.length === 0) {
        return new Text(
          theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"),
          0,
          0,
        );
      }
      const lines: string[] = [];
      if (urlList.length === 1) {
        const display = urlList[0].length > 60 ? urlList[0].slice(0, 57) + "..." : urlList[0];
        lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
      } else {
        lines.push(
          theme.fg("toolTitle", theme.bold("fetch ")) +
            theme.fg("accent", `${urlList.length} URLs`),
        );
        for (const u of urlList.slice(0, 5)) {
          const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
          lines.push(theme.fg("muted", "  " + display));
        }
        if (urlList.length > 5) {
          lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
        }
      }
      if (mode && mode !== "readable") {
        lines.push(theme.fg("dim", "  mode: ") + theme.fg("warning", mode));
      }
      if (prompt) {
        const display = prompt.length > 250 ? prompt.slice(0, 247) + "..." : prompt;
        lines.push(theme.fg("dim", "  prompt: ") + theme.fg("muted", `"${display}"`));
      }
      if (answerModel) {
        lines.push(theme.fg("dim", "  answer model: ") + theme.fg("warning", answerModel));
      }
      if (auth !== undefined) {
        lines.push(
          theme.fg("dim", "  auth: ") + theme.fg("warning", auth === true ? "true" : auth),
        );
      }
      return new Text(lines.join("\n"), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      // SAFETY: Fetch results and partial updates are created by this tool with the fields declared below.
      const details = result.details as {
        urls?: string[];
        urlCount?: number;
        successful?: number;
        totalChars?: number;
        error?: string;
        title?: string;
        truncated?: boolean;
        responseId?: string;
        phase?: string;
        progress?: number;
        hasImage?: boolean;
        imageCount?: number;
        prompt?: string;
      };

      if (isPartial) {
        const progress = details?.progress ?? 0;
        const bar =
          "\u2588".repeat(Math.floor(progress * 10)) +
          "\u2591".repeat(10 - Math.floor(progress * 10));
        return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
      }

      if (details?.error) {
        const extras: string[] = [];
        if (isNumberValue(details.urlCount) || isNumberValue(details.successful)) {
          extras.push(`urls: ${details.successful ?? 0}/${details.urlCount ?? 0} succeeded`);
        }
        if (details.responseId) extras.push(`response id: ${details.responseId}`);
        if (details.urls && details.urls.length > 0) {
          for (const u of details.urls.slice(0, 8)) extras.push(`  \u25b8 ${u}`);
          if (details.urls.length > 8) extras.push(`  ... and ${details.urls.length - 8} more`);
        }
        const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
        if (plan) return renderSearchErrorPlan(plan, expanded, theme);
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      if (details?.urlCount === 1) {
        const title = details?.title || "Untitled";
        const imgCount = details?.imageCount ?? (details?.hasImage ? 1 : 0);
        const imageBadge =
          imgCount > 1
            ? theme.fg("accent", ` [${imgCount} images]`)
            : imgCount === 1
              ? theme.fg("accent", " [image]")
              : "";
        let statusLine =
          theme.fg("success", title) +
          theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`) +
          imageBadge;
        if (details?.truncated) {
          statusLine += theme.fg("warning", " [truncated]");
        }
        const textContent = result.content.find((c) => c.type === "text")?.text || "";
        if (!expanded) {
          const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
          return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
        }
        const lines = [statusLine];
        if (details?.prompt) {
          const display =
            details.prompt.length > 250 ? details.prompt.slice(0, 247) + "..." : details.prompt;
          lines.push(theme.fg("dim", `  prompt: "${display}"`));
        }
        const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
        lines.push(theme.fg("dim", preview));
        return new Text(lines.join("\n"), 0, 0);
      }

      const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
      const statusLine =
        theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`) +
        theme.fg("muted", getSearchContentEnabled ? " (content stored)" : " (content fetched)");
      if (!expanded) {
        return new Text(statusLine, 0, 0);
      }
      const textContent = result.content.find((c) => c.type === "text")?.text || "";
      const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
      return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });
}
