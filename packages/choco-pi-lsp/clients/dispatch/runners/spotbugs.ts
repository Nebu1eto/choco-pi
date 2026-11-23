import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BoundedLruCache } from "../../bounded-cache.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { findCompiledClassesDir } from "../../tool-policy.ts";
import { PRIORITY } from "../priorities.ts";
import type {
  DefectClass,
  Diagnostic,
  DispatchContext,
  RunnerDefinition,
  RunnerResult,
} from "../types.ts";
import { createAvailabilityChecker, resolveAvailableOrInstall } from "./utils/runner-helpers.ts";

const java = createAvailabilityChecker("java", ".exe", ["-version"]);
const spotbugs = createAvailabilityChecker("spotbugs", ".bat", ["-version"]);

const MAX_DIAGNOSTICS = 50;
const MAX_XML_BYTES = 4 * 1024 * 1024;

interface SpotbugsCacheEntry {
  signature: string;
  diagnostics: Diagnostic[];
}
const scanCache = new BoundedLruCache<string, SpotbugsCacheEntry>(32);

export function _resetSpotbugsCacheForTests(): void {
  scanCache.clear();
}

function classesSignature(classesDir: string): string {
  let count = 0;
  let newest = 0;
  const stack = [classesDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".class")) {
        count++;
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch {}
      }
    }
  }
  return `${count}:${newest}`;
}

function mapCategory(category: string): DefectClass {
  switch (category.toUpperCase()) {
    case "CORRECTNESS":
    case "MT_CORRECTNESS":
      return "correctness";
    case "SECURITY":
      return "safety";
    case "PERFORMANCE":
    case "BAD_PRACTICE":
    case "STYLE":
    case "I18N":
    case "EXPERIMENTAL":
      return "style";
    default:
      return "correctness";
  }
}

function mapSeverity(priority: string): Diagnostic["severity"] {
  switch (priority) {
    case "1":
      return "error";
    case "3":
      return "info";
    default:
      return "warning";
  }
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : undefined;
}

function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const dot = trimmed.indexOf(". ");
  return (dot > 0 ? trimmed.slice(0, dot + 1) : trimmed).slice(0, 300);
}

export function parseSpotbugsXml(raw: string): Diagnostic[] {
  const xml = raw.length > MAX_XML_BYTES ? raw.slice(0, MAX_XML_BYTES) : raw;
  const diagnostics: Diagnostic[] = [];
  const blockRe = /<BugInstance\b([^>]*)>([\s\S]*?)<\/BugInstance>/g;
  let block: RegExpExecArray | null;
  let index = 0;
  while ((block = blockRe.exec(xml)) !== null) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
    const headAttrs = block[1];
    const body = block[2];
    const type = attr(headAttrs, "type") || "SPOTBUGS";
    const priority = attr(headAttrs, "priority") || "2";
    const category = attr(headAttrs, "category") || "CORRECTNESS";

    let filePath: string | undefined;
    let line = 1;
    const slRe = /<SourceLine\b([^>]*?)\/?>/g;
    let sl: RegExpExecArray | null;
    while ((sl = slRe.exec(body)) !== null) {
      const slAttrs = sl[1];
      const start = attr(slAttrs, "start");
      const sourcepath = attr(slAttrs, "sourcepath");
      const sourcefile = attr(slAttrs, "sourcefile");
      if (!start || !(sourcepath || sourcefile)) continue;
      filePath = sourcepath || sourcefile;
      line = Number(start) || 1;
      if (attr(slAttrs, "primary") === "true") break;
    }
    if (!filePath) continue;

    const longMsgMatch = /<LongMessage>([\s\S]*?)<\/LongMessage>/.exec(body);
    const shortMsgMatch = /<ShortMessage>([\s\S]*?)<\/ShortMessage>/.exec(body);
    const longMsg = longMsgMatch ? decodeXmlEntities(longMsgMatch[1].trim()) : "";
    const shortMsg = shortMsgMatch ? decodeXmlEntities(shortMsgMatch[1].trim()) : "";
    const message = shortMsg || longMsg || type;
    const fixSuggestion = longMsg ? firstSentence(longMsg) : undefined;

    diagnostics.push({
      id: `spotbugs:${type}:${path.basename(filePath)}:${line}:${index}`,
      message: `[${type}] ${message}`,
      filePath,
      line,
      column: 1,
      severity: mapSeverity(priority),
      semantic: "warning",
      tool: "spotbugs",
      rule: type,
      defectClass: mapCategory(category),
      fixable: false,
      autoFixAvailable: false,
      fixKind: fixSuggestion ? "suggestion" : undefined,
      fixSuggestion,
    });
    index++;
  }
  return diagnostics;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const spotbugsRunner: RunnerDefinition = {
  id: "spotbugs",
  appliesTo: ["java", "kotlin"],
  priority: PRIORITY.DEEP_LANGUAGE_ANALYSIS,
  enabledByDefault: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();

    const classesDir = findCompiledClassesDir(cwd);
    if (!classesDir) {
      ctx.log?.(
        "spotbugs: Java project detected but no compiled .class files found — run `mvn compile` / `gradle build` first",
      );
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    if (!(await java.isAvailableAsync(cwd))) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const signature = classesSignature(classesDir);
    const cached = scanCache.get(classesDir);
    if (cached && cached.signature === signature) {
      return {
        status: "succeeded",
        diagnostics: cached.diagnostics,
        semantic: cached.diagnostics.length > 0 ? "warning" : "none",
      };
    }

    const cmd = await resolveAvailableOrInstall(spotbugs, "spotbugs", cwd);
    if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

    const tmpXml = path.join(os.tmpdir(), `choco-pi-lsp-spotbugs-${process.pid}-${Date.now()}.xml`);
    const result = await safeSpawnAsync(
      cmd,
      ["-textui", "-xml:withMessages", "-low", "-longBugCodes", "-output", tmpXml, classesDir],
      { cwd, timeout: 120000 },
    );

    let xml = "";
    try {
      xml = fs.readFileSync(tmpXml, "utf8");
    } catch {
      if (result.error || (result.status ?? 0) > 1) {
        return {
          status: "failed",
          diagnostics: [],
          semantic: "none",
          rawOutput: (result.stderr || "").slice(0, 500),
        };
      }
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    } finally {
      try {
        fs.rmSync(tmpXml, { force: true });
      } catch {}
    }

    const diagnostics = parseSpotbugsXml(xml);
    scanCache.set(classesDir, { signature, diagnostics });

    return {
      status: "succeeded",
      diagnostics,
      semantic: diagnostics.length > 0 ? "warning" : "none",
    };
  },
};

export default spotbugsRunner;
