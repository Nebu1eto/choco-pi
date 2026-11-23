import * as path from "node:path";

const HASH_COMMENT_EXTENSIONS = new Set([
  ".py",
  ".rb",
  ".sh",
  ".bash",
  ".zsh",
  ".yml",
  ".yaml",
  ".toml",
  ".r",
  ".pl",
  ".pm",
  ".ex",
  ".exs",
  ".elixir",
  ".dockerfile",
  ".gitignore",
  ".conf",
  ".cfg",
  ".ini",
]);

function commentPrefixFor(filePath: string): "#" | "//" {
  const ext = path.extname(filePath).toLowerCase();
  return HASH_COMMENT_EXTENSIONS.has(ext) ? "#" : "//";
}

export function insertSuppressComment(
  content: string,
  filePath: string,
  line: number,
  rule: string,
): string {
  const lines = content.split(/\r?\n/);
  if (line < 1 || line > lines.length) {
    throw new Error(`line ${line} is out of range (file has ${lines.length} lines)`);
  }
  const prefix = commentPrefixFor(filePath);
  const aboveIdx = line - 2;
  const existingAbove = aboveIdx >= 0 ? lines[aboveIdx] : undefined;
  const suppressRe = /((?:\/\/|#)\s*choco-pi-lsp-ignore:\s*)(.+)$/;
  const match = existingAbove !== undefined ? suppressRe.exec(existingAbove) : null;
  if (match && existingAbove !== undefined) {
    const rules = match[2]
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    if (!rules.includes(rule)) rules.push(rule);
    lines[aboveIdx] = existingAbove.slice(0, match.index) + match[1] + rules.join(", ");
    return lines.join("\n");
  }
  const targetLine = lines[line - 1] ?? "";
  const indent = /^\s*/.exec(targetLine)?.[0] ?? "";
  lines.splice(line - 1, 0, `${indent}${prefix} choco-pi-lsp-ignore: ${rule}`);
  return lines.join("\n");
}
