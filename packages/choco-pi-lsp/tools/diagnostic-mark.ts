import type { ProtocolDictionary } from "./runtime-values.ts";
import type { RuntimeValue } from "./runtime-values.ts";
import { isRuntimeNumber, isRuntimeString } from "./runtime-values.ts";

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { hostParams } from "./schema-bridge.ts";
import {
  markDisposition,
  normalizeMessage,
  type Disposition,
} from "../clients/diagnostic-dispositions.ts";
import { insertSuppressComment } from "../clients/dispatch/suppress-writer.ts";
import { getFileDiagnostics, type WidgetDiagnostic } from "../clients/widget-state.ts";

const DISPOSITIONS = ["false-positive", "suppress", "defer", "flagged"] as const;

const FUZZY_SEARCH_RADIUS = 5;

function isBlank(text: string | undefined): boolean {
  return text === undefined || text.trim().length === 0;
}

function widgetCrossCheck(
  absPath: string,
  tool: string | undefined,
  rule: string | undefined,
  message: string,
  callerLine: number,
): { line: number; ambiguous: boolean } | undefined {
  let diagnostics: WidgetDiagnostic[] | undefined;
  try {
    diagnostics = getFileDiagnostics(absPath);
  } catch {
    return undefined;
  }
  if (!diagnostics || diagnostics.length === 0) return undefined;
  const normalized = normalizeMessage(message);
  const matches = diagnostics.filter(
    (d): d is WidgetDiagnostic & { line: number } =>
      d.line !== undefined &&
      normalizeMessage(d.message) === normalized &&
      (rule === undefined || d.rule === rule) &&
      (tool === undefined || d.tool === tool),
  );
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return { line: matches[0].line, ambiguous: false };
  const closest = matches.reduce(
    (best, d) => (Math.abs(d.line - callerLine) < Math.abs(best.line - callerLine) ? d : best),
    matches[0],
  );
  return { line: closest.line, ambiguous: true };
}

function fuzzyReanchor(
  lines: string[],
  callerLine: number,
): { line: number; reanchored: boolean } | undefined {
  if (callerLine >= 1 && callerLine <= lines.length && !isBlank(lines[callerLine - 1])) {
    return { line: callerLine, reanchored: false };
  }
  for (let offset = 1; offset <= FUZZY_SEARCH_RADIUS; offset++) {
    for (const candidate of [callerLine - offset, callerLine + offset]) {
      if (candidate < 1 || candidate > lines.length) continue;
      if (!isBlank(lines[candidate - 1])) {
        return { line: candidate, reanchored: true };
      }
    }
  }
  return undefined;
}

type LineVerification = { line: number; reanchored: boolean; note?: string } | { error: string };

function verifyLine(
  content: string,
  absPath: string,
  tool: string | undefined,
  rule: string | undefined,
  message: string,
  callerLine: number,
): LineVerification {
  const lines = content.split(/\r?\n/);

  let widgetResult: { line: number; ambiguous: boolean } | undefined;
  try {
    widgetResult = widgetCrossCheck(absPath, tool, rule, message, callerLine);
  } catch {
    widgetResult = undefined;
  }
  if (widgetResult !== undefined) {
    const reanchored = widgetResult.line !== callerLine;
    return {
      line: widgetResult.line,
      reanchored,
      note: reanchored
        ? `reanchored from line ${callerLine} to ${widgetResult.line}` +
          (widgetResult.ambiguous ? " (multiple live matches, chose nearest)" : "") +
          " against current diagnostics"
        : undefined,
    };
  }

  try {
    const fuzzy = fuzzyReanchor(lines, callerLine);
    if (!fuzzy) {
      return {
        error:
          `line ${callerLine} looks stale (out of range or blank, and no diagnostic ` +
          "match was found nearby) — re-run diagnostics_report and retry with the current line.",
      };
    }
    return {
      line: fuzzy.line,
      reanchored: fuzzy.reanchored,
      note: fuzzy.reanchored
        ? `reanchored from line ${callerLine} to ${fuzzy.line} (nearest non-blank line)`
        : undefined,
    };
  } catch {
    return {
      error: `could not verify line ${callerLine} — re-run diagnostics_report and retry.`,
    };
  }
}

export function createLensDiagnosticMarkTool(
  getCwd: () => string,
  getIdentity?: () => { model?: string; provider?: string },
) {
  return {
    name: "diagnostic_mark" as const,
    label: "Mark Diagnostic",
    description:
      "Record a disposition for a diagnostics_report finding, using the exact file_path/rule/message/line " +
      "it was reported with. false-positive/suppress persist across sessions; defer lasts only for the " +
      "current session (resurfaces next time); flagged marks it for you to come back and fix, and shows " +
      "up tagged in a later diagnostics_report mode=full. suppress additionally writes a `choco-pi-lsp-ignore: " +
      "<rule>` comment into the source above the flagged line — rule is required for suppress. " +
      "The line is verified/reanchored against current diagnostics before writing (#802): if a live " +
      "diagnostic for this tool/rule/message is now at a different line, that line is used instead of " +
      "the one you passed. When suppressing several findings in the SAME file in one turn, work " +
      "bottom-up (highest line number first) — each inserted comment shifts later lines down by one, " +
      "and reanchoring can't always disambiguate two nearby findings.",
    promptSnippet: "Record a diagnostic disposition or deferred fix.",
    parameters: hostParams(
      obj({
        file_path: str({
          description: "The file the diagnostic was reported on (relative or absolute).",
        }),
        line: num({
          description: "The 1-based line the diagnostic was reported at.",
        }),
        message: str({
          description: "The diagnostic's message, exactly as diagnostics_report reported it.",
        }),
        rule: opt(
          str({
            description:
              "The diagnostic's rule id, if it has one (shown in diagnostics_report as [rule]). Required for disposition=suppress.",
          }),
        ),
        tool: opt(str({ description: "The tool that produced the diagnostic, if known." })),
        disposition: oneOf(DISPOSITIONS, {
          description:
            "false-positive = the rule misfired. suppress = real finding, won't fix (writes an inline ignore comment). defer = fix later, this session only. flagged = mark for you to fix.",
        }),
        reason: opt(str({ description: "Optional short reason, kept alongside the disposition." })),
      }),
    ),
    async execute(
      _toolCallId: string,
      params: ProtocolDictionary,
      _signal: AbortSignal | undefined,
      _onUpdate: RuntimeValue,
      ctx: { cwd?: string },
    ) {
      const cwd = ctx.cwd ?? getCwd();
      const filePathArg = params.file_path;
      const line = params.line;
      const message = params.message;
      // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
      const disposition = params.disposition as Disposition;
      // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
      const rule = params.rule as string | undefined;
      // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
      const tool = params.tool as string | undefined;
      // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
      const reason = params.reason as string | undefined;

      if (
        !isRuntimeString(filePathArg) ||
        !isRuntimeNumber(line) ||
        !isRuntimeString(message) ||
        // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
        !DISPOSITIONS.includes(disposition as (typeof DISPOSITIONS)[number])
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "file_path, line, message, and a valid disposition are required.",
            },
          ],
          isError: true,
          details: {},
        };
      }
      if (disposition === "suppress" && !rule) {
        return {
          content: [
            {
              type: "text" as const,
              text: "disposition=suppress requires `rule` — the inline choco-pi-lsp-ignore comment names a rule id.",
            },
          ],
          isError: true,
          details: {},
        };
      }

      const absPath = path.isAbsolute(filePathArg) ? filePathArg : path.resolve(cwd, filePathArg);

      let content: string;
      try {
        content = await fs.readFile(absPath, "utf-8");
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not read ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      let verifiedLine = line;
      let reanchorNote: string | undefined;
      try {
        const verification = verifyLine(content, absPath, tool, rule, message, line);
        if ("error" in verification) {
          if (disposition === "suppress") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Refusing to suppress at ${path.relative(cwd, absPath)}:${line} — ${verification.error}`,
                },
              ],
              isError: true,
              details: {},
            };
          }
        } else {
          verifiedLine = verification.line;
          reanchorNote = verification.note;
        }
      } catch {
        if (disposition === "suppress") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Refusing to suppress at ${path.relative(cwd, absPath)}:${line} — could not verify the line; re-run diagnostics_report and retry.`,
              },
            ],
            isError: true,
            details: {},
          };
        }
      }

      if (disposition === "suppress") {
        let updated: string;
        try {
          updated = insertSuppressComment(content, absPath, verifiedLine, rule!);
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: err instanceof Error ? err.message : String(err),
              },
            ],
            isError: true,
            details: {},
          };
        }
        await fs.writeFile(absPath, updated, "utf-8");
      }

      const anchor = markDisposition(
        cwd,
        {
          cwd,
          filePath: absPath,
          tool,
          rule,
          message,
          line: verifiedLine,
          content,
        },
        disposition,
        reason,
        getIdentity?.(),
      );

      const verb =
        disposition === "suppress"
          ? `suppressed (inline choco-pi-lsp-ignore comment written above line ${verifiedLine})`
          : disposition === "defer"
            ? "deferred for this session"
            : disposition === "flagged"
              ? "flagged to fix"
              : "marked false-positive";
      const reanchorSuffix = reanchorNote ? ` (${reanchorNote})` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `${path.relative(cwd, absPath)}:${verifiedLine} ${verb}.${reanchorSuffix}`,
          },
        ],
        details: { anchor, disposition, line: verifiedLine },
      };
    },
  };
}
