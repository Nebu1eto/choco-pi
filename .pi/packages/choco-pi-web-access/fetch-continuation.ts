export interface FetchSummaryEntry {
  url: string;
  title: string;
  content: string;
  error: string | null;
}

export type FetchSummaryRetrieval =
  | { kind: "stored"; toolName: string; responseId: string; maxSliceChars: number }
  | { kind: "unregistered" }
  | { kind: "cache-off" };

export interface ContinuationSlice {
  toolName: string;
  responseId: string;
  urlIndex: number;
  offset: number;
  limit: number;
}

/** Exact continuation call for one stored fetch URL slice. */
export function continuationCall(slice: ContinuationSlice): string {
  return `${slice.toolName}({ responseId: ${JSON.stringify(slice.responseId)}, urlIndex: ${slice.urlIndex}, offset: ${slice.offset}, limit: ${slice.limit} })`;
}

/**
 * Multi-URL fetch summary. Content is not inlined; every successful URL lists its index,
 * stored length, and the exact call that reads its first slice, so one URL can be chosen.
 */
export function formatMultiUrlFetchSummary(
  results: readonly FetchSummaryEntry[],
  retrieval: FetchSummaryRetrieval,
): string {
  let output = "## Fetched URLs\n\n";
  results.forEach(({ url, title, content, error }, index) => {
    if (error) {
      output += `- [${index}] ${url}: Error - ${error}\n`;
      return;
    }
    output += `- [${index}] ${title || url} (${url}) offset 0, length ${content.length} chars\n`;
    if (retrieval.kind === "stored" && content.length > 0) {
      const limit = Math.min(content.length, retrieval.maxSliceChars);
      const call = continuationCall({
        toolName: retrieval.toolName,
        responseId: retrieval.responseId,
        urlIndex: index,
        offset: 0,
        limit,
      });
      output += `  Continue with ${call}\n`;
    }
  });
  if (retrieval.kind === "stored") {
    output += `\n---\nContent is stored, not inlined. Slices are at most ${retrieval.maxSliceChars} chars; each slice footer names the next offset.`;
  } else if (retrieval.kind === "unregistered") {
    output += "\n---\nContent retrieval is not registered.";
  } else {
    output += "\n---\nAuthenticated fetch cache is off; repeat the fetch to read content.";
  }
  return output;
}
