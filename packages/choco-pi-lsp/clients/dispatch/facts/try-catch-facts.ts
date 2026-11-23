import type { FactProvider } from "../fact-provider-types.ts";
import { extractFactsFromTree, firstChildOfType, type TsNode, walk } from "./tree-sitter-facts.ts";

export interface TryCatchSummary {
  line: number;
  column: number;
  catchParam: string | null;
  bodyText: string;
  isEmpty: boolean;
  hasRethrow: boolean;
  hasLogging: boolean;
  catchLogsOnly: boolean;
  catchReturnsDefault: boolean;
  catchReturnsStructuredError: boolean;
  isDocumentedLocalFallback: boolean;
  catchHasFallbackAssignment: boolean;
  tryResolvesLocalValues: boolean;
  isFilesystemExistenceProbe: boolean;
  boundaryCategory: "db" | "network" | "fs" | "process" | "unknown" | "none";
}

function hasAssignmentExpression(node: TsNode | undefined): boolean {
  if (!node) return false;
  let found = false;
  walk(node, (n) => {
    if (n.type === "assignment_expression") found = true;
  });
  return found;
}

function isOnlyWhitespaceOrComments(text: string): boolean {
  let stripped = text.replace(/\/\*[\s\S]*?\*\//g, "");
  stripped = stripped.replace(/\/\/[^\n]*/g, "");
  return stripped.trim().length === 0;
}

const DEFAULT_VALUE_PATTERN =
  /\breturn\s+(null|undefined|false|true|0|""|''|``|\[\]|\{\}|new\s+\w+\(\))/;

const STRUCTURED_ERROR_PATTERN = /\breturn\s+\{[^}]*(?:success\s*:\s*false|error\s*:)/;

const EXPLAINING_COMMENT_PATTERN = /(?:\/\/\s*\S.{3,}|\/\*\s*\S[\s\S]{3,}?\*\/)/;

const FS_PROBE_PATTERN = /\b(?:existsSync|statSync|lstatSync|readFileSync|accessSync)\b/;

const DB_PATTERN =
  /\b(?:query|execute|findOne|findMany|findById|insert|update|delete|select|prisma\.|knex\.|sequelize\.)/;
const NETWORK_PATTERN = /\b(?:fetch|axios|http\.|https\.|request\.|got\.|undici\.)/;
const FS_PATTERN =
  /\b(?:readFileSync?|writeFileSync?|appendFileSync?|readdirSync?|mkdirSync?|statSync?|unlinkSync?|existsSync|accessSync?|copyFileSync?|renameSync?)\b/;
const PROCESS_PATTERN = /\b(?:spawn|exec|execSync|spawnSync|child_process\.)\b/;

function detectBoundaryCategory(tryText: string): TryCatchSummary["boundaryCategory"] {
  if (DB_PATTERN.test(tryText)) return "db";
  if (NETWORK_PATTERN.test(tryText)) return "network";
  if (FS_PATTERN.test(tryText)) return "fs";
  if (PROCESS_PATTERN.test(tryText)) return "process";
  return "none";
}

function detectTryResolvesLocalValues(tryText: string): boolean {
  const hasAwait = /\bawait\b/.test(tryText);
  const hasIO =
    DB_PATTERN.test(tryText) ||
    NETWORK_PATTERN.test(tryText) ||
    FS_PATTERN.test(tryText) ||
    PROCESS_PATTERN.test(tryText);
  return !hasAwait && !hasIO;
}

export const tryCatchFactProvider: FactProvider = {
  id: "tryCatchFacts",
  provides: ["file.tryCatchSummaries"],
  requires: ["file.content"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath);
  },
  async run(ctx, store) {
    await extractFactsFromTree(ctx, store, { "file.tryCatchSummaries": [] }, (root) => {
      const summaries: TryCatchSummary[] = [];

      walk(root, (node) => {
        if (node.type !== "try_statement") return;
        const tryBlock = firstChildOfType(node, "statement_block");
        const catchClause = firstChildOfType(node, "catch_clause");
        if (!tryBlock || !catchClause) return;

        const tryText = tryBlock.text;
        const tryResolvesLocalValues = detectTryResolvesLocalValues(tryText);
        const boundaryCategory = detectBoundaryCategory(tryText);

        const paramNode = firstChildOfType(catchClause, "identifier");
        const catchParam = paramNode ? paramNode.text : null;

        const catchBody = firstChildOfType(catchClause, "statement_block");
        const bodyText = catchBody
          ? catchBody.text.replace(/^\{/, "").replace(/\}$/, "").trim()
          : "";

        const isEmpty = isOnlyWhitespaceOrComments(bodyText);
        const hasRethrow = /\bthrow\b/.test(bodyText);
        const hasLogging =
          /\bconsole\.(log|warn|error)\b/.test(bodyText) || /\blogger\./.test(bodyText);

        const catchReturnsDefault = DEFAULT_VALUE_PATTERN.test(bodyText);
        const catchReturnsStructuredError = STRUCTURED_ERROR_PATTERN.test(bodyText);
        const isDocumentedLocalFallback = EXPLAINING_COMMENT_PATTERN.test(bodyText);
        const catchHasFallbackAssignment = hasAssignmentExpression(catchBody);

        const catchLogsOnly =
          hasLogging &&
          !hasRethrow &&
          !catchReturnsDefault &&
          !catchReturnsStructuredError &&
          !/\b(?:set|update|notify|emit|dispatch|resolve|reject)\b/.test(bodyText);

        const isFilesystemExistenceProbe =
          boundaryCategory === "fs" && FS_PROBE_PATTERN.test(tryText) && catchReturnsDefault;

        summaries.push({
          line: catchClause.startPosition.row + 1,
          column: catchClause.startPosition.column + 1,
          catchParam,
          bodyText,
          isEmpty,
          hasRethrow,
          hasLogging,
          catchLogsOnly,
          catchReturnsDefault,
          catchReturnsStructuredError,
          isDocumentedLocalFallback,
          catchHasFallbackAssignment,
          tryResolvesLocalValues,
          isFilesystemExistenceProbe,
          boundaryCategory,
        });
      });

      return { "file.tryCatchSummaries": summaries };
    });
  },
};
