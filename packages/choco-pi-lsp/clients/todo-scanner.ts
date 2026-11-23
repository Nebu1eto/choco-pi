import * as fs from "node:fs";
import * as path from "node:path";
import { collectSourceFiles } from "./source-filter.ts";

export interface TodoItem {
  type: "TODO" | "FIXME" | "HACK" | "XXX" | "BUG";
  message: string;
  file: string;
  line: number;
  column: number;
}

export interface TodoScanResult {
  items: TodoItem[];
  byType: Map<string, TodoItem[]>;
  byFile: Map<string, TodoItem[]>;
}

const MAX_SCAN_FILE_BYTES = 512 * 1024;

const MARKDOWN_FILE_RE = /\.(?:md|mdx|markdown)$/i;

export class TodoScanner {
  private readonly pattern = /\b(TODO|FIXME|HACK|XXX|BUG)\b\s*[(:]?\s*(.+)/g;

  private isInComment(line: string, matchIndex: number, markdown = false): boolean {
    if (markdown) {
      const beforeMatch = line.slice(0, matchIndex);
      const open = beforeMatch.lastIndexOf("<!--");
      return open !== -1 && beforeMatch.lastIndexOf("-->") < open;
    }

    const trimmed = line.trimStart();

    if (/^\/\/|^\/\*|^\*|^#/.test(trimmed)) return true;

    const beforeMatch = line.slice(0, matchIndex);
    const lineCommentPos = beforeMatch.lastIndexOf("//");
    if (lineCommentPos !== -1) {
      const beforeComment = beforeMatch.slice(0, lineCommentPos);
      const singleQuotes = (beforeComment.match(/'/g) || []).length;
      const doubleQuotes = (beforeComment.match(/"/g) || []).length;
      const backticks = (beforeComment.match(/`/g) || []).length;
      if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0 && backticks % 2 === 0) {
        return true;
      }
    }

    const blockOpen = beforeMatch.lastIndexOf("/*");
    const blockClose = beforeMatch.lastIndexOf("*/");
    if (blockOpen !== -1 && blockClose < blockOpen) return true;

    const hashPos = beforeMatch.lastIndexOf("#");
    if (hashPos !== -1) {
      const beforeHash = beforeMatch.slice(0, hashPos);
      const singleQuotes = (beforeHash.match(/'/g) || []).length;
      const doubleQuotes = (beforeHash.match(/"/g) || []).length;
      if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
        return true;
      }
    }

    return false;
  }

  scanFile(filePath: string): TodoItem[] {
    const absolutePath = path.resolve(filePath);

    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) return [];
    } catch {
      return [];
    }

    let content: string;
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      return [];
    }
    const markdown = MARKDOWN_FILE_RE.test(absolutePath);
    const lines = content.split("\n");
    const items: TodoItem[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const matches = line.matchAll(this.pattern);

      for (const match of matches) {
        if (!this.isInComment(line, match.index ?? 0, markdown)) continue;

        // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
        const type = match[1] as TodoItem["type"];
        const message = (match[2] || "").trim().replace(/\s*\*\/\s*$/, "");

        items.push({
          type,
          message: message.slice(0, 200),
          file: path.relative(process.cwd(), absolutePath),
          line: i + 1,
          column: match.index || 0,
        });
      }
    }

    return items;
  }

  scanFiles(filePaths: string[]): TodoScanResult {
    const items: TodoItem[] = [];

    for (const filePath of filePaths) {
      if (filePath.endsWith("todo-scanner.ts") || filePath.endsWith("todo-scanner.js")) continue;
      if (/\.(test|spec)\.[jt]sx?$/.test(filePath)) continue;

      items.push(...this.scanFile(filePath));
    }

    return this.groupResults(items);
  }

  scanDirectory(dirPath: string): TodoScanResult {
    const sourceFiles = collectSourceFiles(dirPath);
    return this.scanFiles(sourceFiles);
  }

  private groupResults(items: TodoItem[]): TodoScanResult {
    const byType = new Map<string, TodoItem[]>();
    for (const item of items) {
      const existing = byType.get(item.type) || [];
      existing.push(item);
      byType.set(item.type, existing);
    }

    const byFile = new Map<string, TodoItem[]>();
    for (const item of items) {
      const existing = byFile.get(item.file) || [];
      existing.push(item);
      byFile.set(item.file, existing);
    }

    return { items, byType, byFile };
  }

  formatResult(result: TodoScanResult, maxItems = 30): string {
    if (result.items.length === 0) return "";

    let output = `[TODOs] ${result.items.length} annotation(s) found`;

    const typeCounts: string[] = [];
    for (const [type, items] of result.byType) {
      typeCounts.push(`${items.length} ${type}`);
    }
    if (typeCounts.length > 0) {
      output += ` (${typeCounts.join(", ")})`;
    }
    output += ":\n";

    const priorityOrder: TodoItem["type"][] = ["FIXME", "HACK", "BUG", "TODO", "XXX"];
    const sorted = [...result.items].sort((a, b) => {
      const aIdx = priorityOrder.indexOf(a.type);
      const bIdx = priorityOrder.indexOf(b.type);
      return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
    });

    for (const item of sorted.slice(0, maxItems)) {
      const icon = this.getIcon(item.type);
      output += `  ${icon} ${item.file}:${item.line} — ${item.type}: ${item.message}\n`;
    }

    if (result.items.length > maxItems) {
      output += `  ... and ${result.items.length - maxItems} more\n`;
    }

    return output;
  }

  private getIcon(type: TodoItem["type"]): string {
    switch (type) {
      case "FIXME":
        return "🔴";
      case "HACK":
        return "🟠";
      case "BUG":
        return "🐛";
      case "TODO":
        return "📝";
      case "XXX":
        return "❌";
      default:
        return "•";
    }
  }
}
