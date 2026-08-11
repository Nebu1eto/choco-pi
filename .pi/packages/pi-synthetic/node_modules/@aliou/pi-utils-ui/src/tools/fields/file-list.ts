import { homedir } from "node:os";
import { relative } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { TruncatedText } from "@earendil-works/pi-tui";
import type { ToolTheme } from "../theme";

export class FileListField implements Component {
  constructor(
    private files: string[],
    private theme: ToolTheme,
    private cwd?: string,
  ) {}

  handleInput(_data: string): boolean {
    return false;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.files.length === 0) return [];

    const lines: string[] = [this.theme.fg("muted", "Files:")];
    for (const file of this.files) {
      const display = shortenPath(file, this.cwd);
      lines.push(...new TruncatedText(`  ${display}`).render(width));
    }
    return lines;
  }
}

function shortenPath(filePath: string, cwd?: string): string {
  if (!filePath.startsWith("/")) return filePath;

  if (cwd) {
    const rel = relative(cwd, filePath);
    if (!rel.startsWith("../../..")) {
      return rel || ".";
    }
  }

  const home = homedir();
  if (home && filePath.startsWith(home)) {
    return `~${filePath.slice(home.length)}`;
  }

  return filePath;
}
