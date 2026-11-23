import type { FactRule } from "../fact-provider-types.ts";
import type { Diagnostic } from "../types.ts";

export const corsWildcardRule: FactRule = {
  id: "cors-wildcard",
  requires: ["file.content"],
  appliesTo(ctx) {
    return /\.(tsx?|py|go)$/.test(ctx.filePath);
  },
  evaluate(ctx, store) {
    const content = store.getFileFact<string>(ctx.filePath, "file.content");
    if (!content) return [];
    const diagnostics: Diagnostic[] = [];

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:\/\/|\*|#|\/)/.test(line)) continue;
      const isWildcard =
        (/["']Access-Control-Allow-Origin["']/.test(line) && /["']\*["']/.test(line)) ||
        /origin\s*:\s*["']\*["']/.test(line) ||
        (/cors\s*\(/.test(line) && /\*/.test(line)) ||
        /(?:allow_origins|origins)\s*=\s*["']\*["']/.test(line) ||
        /(?:allow_origins|origins)\s*=\s*[[(]["']\*["']/.test(line) ||
        /AllowAllOrigins\s*:\s*true/.test(line) ||
        /Allow(?:ed)?Origins[^*\n]{0,60}\*/.test(line);

      if (isWildcard) {
        diagnostics.push({
          id: `cors-wildcard:${ctx.filePath}:${i + 1}`,
          tool: "fact-rules",
          rule: "cors-wildcard",
          filePath: ctx.filePath,
          line: i + 1,
          column: 1,
          severity: "error",
          semantic: "blocking",
          message:
            "CORS wildcard origin (*) allows any website to make credentialed requests — restrict to known origins",
        });
      }
    }
    return diagnostics;
  },
};
