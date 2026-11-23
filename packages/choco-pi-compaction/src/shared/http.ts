/** Response-body helpers shared by the Anthropic and xAI native lanes. */

/** Largest provider error body any native lane reads (characters). */
export const ERROR_BODY_LIMIT = 65_536;

/**
 * Read a response body as text until at least `limit` characters arrived or
 * the body ended, then cancel the rest. The text may exceed `limit` by the
 * last chunk; callers that need an exact cap slice it.
 */
export async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}
