import { isExcludedDirName, isTestFile } from "./file-utils.ts";
import { collectSourceFiles, collectSourceFilesAsync, isBuildArtifact } from "./source-filter.ts";

export function parseAstGrepJson(raw: string): any[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  return trimmed.split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

export function shouldIgnoreFile(filePath: string, isTsProject: boolean): boolean {
  const relPath = filePath.replace(/\\/g, "/");
  if (isTsProject && isBuildArtifact(filePath)) return true;

  const isJs = relPath.endsWith(".js") || relPath.endsWith(".mjs") || relPath.endsWith(".cjs");
  if (isTsProject && isJs) return true;

  if (isTestFile(filePath)) return true;

  const pathParts = relPath.split("/").filter(Boolean);
  for (const segment of pathParts.slice(0, -1)) {
    if (isExcludedDirName(segment)) return true;
  }

  return false;
}

export function getSourceFiles(dir: string, _isTsProject?: boolean): string[] {
  return collectSourceFiles(dir);
}

export function getSourceFilesAsync(dir: string, _isTsProject?: boolean): Promise<string[]> {
  return collectSourceFilesAsync(dir);
}
