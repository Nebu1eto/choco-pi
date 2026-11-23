import * as fs from "node:fs";
import * as path from "node:path";
import {
  getProjectIgnoreMatcher,
  isExcludedDirName,
  type ProjectIgnoreMatcher,
} from "./file-utils.ts";
import { isGeneratedArtifactDirectoryName, isGeneratedOrArtifact } from "./generated-artifacts.ts";
import {
  collectSourceFiles,
  collectSourceFilesAsync,
  collectSourceFilesWithBudgetAsync,
  type SourceCollectionOptions,
  type SourceCollectionResult,
} from "./source-filter.ts";

export interface ProjectPathPolicyOptions {
  rootDir: string;
  isDirectory?: boolean;
  includeGenerated?: boolean;
  includeDeclarationFiles?: boolean;
  inspectGeneratedHeaders?: boolean;
  ignoreMatcher?: ProjectIgnoreMatcher;
}

export interface ProjectSourceFilePolicyOptions extends Omit<
  ProjectPathPolicyOptions,
  "isDirectory"
> {}

export interface ProjectSourceCollectionOptions extends SourceCollectionOptions {}

export function shouldSkipProjectPath(
  filePath: string,
  options: ProjectPathPolicyOptions,
): boolean {
  const isDirectory = options.isDirectory === true;
  const matcher = options.ignoreMatcher ?? getProjectIgnoreMatcher(options.rootDir);
  if (matcher.isIgnored(filePath, isDirectory)) return true;

  const name = path.basename(filePath);
  if (isDirectory) {
    if (isExcludedDirName(name)) return true;
    return options.includeGenerated !== true && isGeneratedArtifactDirectoryName(name);
  }

  return (
    options.includeGenerated !== true &&
    isGeneratedOrArtifact(filePath, {
      readContentHeader: options.inspectGeneratedHeaders !== false,
      includeDeclarations: options.includeDeclarationFiles !== true,
    })
  );
}

export function shouldScanProjectSourceFile(
  filePath: string,
  options: ProjectSourceFilePolicyOptions,
): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
  } catch {
    return false;
  }
  return !shouldSkipProjectPath(filePath, {
    ...options,
    isDirectory: false,
  });
}

export function collectProjectSourceFiles(
  rootDir: string,
  options?: ProjectSourceCollectionOptions,
): string[] {
  return collectSourceFiles(rootDir, options);
}

export function collectProjectSourceFilesAsync(
  rootDir: string,
  options?: ProjectSourceCollectionOptions & { budgetMs?: number },
): Promise<string[]> {
  return collectSourceFilesAsync(rootDir, options);
}

export function collectProjectSourceFilesWithBudgetAsync(
  rootDir: string,
  options?: ProjectSourceCollectionOptions & { budgetMs?: number },
): Promise<SourceCollectionResult> {
  return collectSourceFilesWithBudgetAsync(rootDir, options);
}
