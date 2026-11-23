import { finite } from "./runtime-guards.ts";
import { bool, compile, obj, opt, str } from "@earendil-works/pi-schema";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Diagnostic } from "./dispatch/types.ts";
import { getProjectDataDir } from "./file-utils.ts";
import { redactSecrets } from "./redact/secrets.ts";

export interface WorklogEntry {
  timestamp: string;
  filePath: string;
  rule: string;
  tool: string;
  message: string;
  line: number;
  column?: number;
  fixable: boolean;
  fixSuggestion?: string;
  autoFixed: boolean;
  model?: string;
  provider?: string;
}

const WorklogEntrySchema = obj(
  {
    timestamp: str(),
    filePath: str(),
    rule: str(),
    tool: str(),
    message: str(),
    line: finite(),
    column: opt(finite()),
    fixable: bool(),
    fixSuggestion: opt(str()),
    autoFixed: bool(),
    model: opt(str()),
    provider: opt(str()),
  },
  { open: true },
);
const isWorklogEntry = compile(WorklogEntrySchema).check;

export interface WorklogIdentity {
  model?: string;
  provider?: string;
}

export function getWorklogPath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "worklog.jsonl");
}

export function appendToWorklog(
  cwd: string,
  diagnostics: Diagnostic[],
  autoFixed: boolean,
  identity?: WorklogIdentity,
): void {
  if (diagnostics.length === 0) return;

  const worklogPath = getWorklogPath(cwd);
  try {
    fs.mkdirSync(path.dirname(worklogPath), { recursive: true });
    const timestamp = new Date().toISOString();
    const model = identity?.model?.trim() || undefined;
    const provider = identity?.provider?.trim() || undefined;
    const lines =
      diagnostics
        .map((d) => {
          const entry: WorklogEntry = {
            timestamp,
            filePath: d.filePath,
            rule: d.rule ?? d.id ?? "unknown",
            tool: d.tool,
            message: d.message,
            line: d.line ?? 1,
            column: d.column,
            fixable: d.fixable ?? false,
            fixSuggestion: d.fixSuggestion,
            autoFixed,
            model,
            provider,
          };
          return JSON.stringify(entry);
        })
        .join("\n") + "\n";
    fs.appendFileSync(worklogPath, redactSecrets(lines), "utf8");
  } catch {}
}

export function readWorklog(cwd: string): WorklogEntry[] {
  const worklogPath = getWorklogPath(cwd);
  try {
    const raw = fs.readFileSync(worklogPath, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return isWorklogEntry(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export interface WorklogStats {
  totalAutoFixed: number;
  totalFixable: number;
  byRule: { rule: string; count: number; autoFixed: number }[];
}

export function summarizeWorklog(cwd: string): WorklogStats {
  const entries = readWorklog(cwd);
  const byRule = new Map<string, { count: number; autoFixed: number }>();
  let totalAutoFixed = 0;
  let totalFixable = 0;

  for (const e of entries) {
    const r = byRule.get(e.rule) ?? { count: 0, autoFixed: 0 };
    r.count++;
    if (e.autoFixed) {
      r.autoFixed++;
      totalAutoFixed++;
    }
    if (e.fixable) totalFixable++;
    byRule.set(e.rule, r);
  }

  return {
    totalAutoFixed,
    totalFixable,
    byRule: [...byRule.entries()]
      .map(([rule, v]) => ({ rule, ...v }))
      .sort((a, b) => b.count - a.count),
  };
}
