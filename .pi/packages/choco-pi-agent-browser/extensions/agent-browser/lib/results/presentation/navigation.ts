import {
  isNavigationObservableCommandName,
  isPageChangeSummaryCommand,
} from "../../command-taxonomy.ts";
import { hasRuntimeType, isRecord } from "../../parsing.ts";
import type { CommandInfo } from "../../runtime.ts";
import { detectConfirmationRequired } from "../confirmation.ts";
import type { AgentBrowserPageChangeSummary, FileArtifactMetadata } from "../contracts.ts";
import { omitUpstreamLifecycle, redactModelFacingText, stringifyModelFacing } from "./common.ts";

const NAVIGATION_SUMMARY_FIELD = "navigationSummary";

interface NavigationSummary {
  title?: string;
  url?: string;
}

interface PageChangeSummaryDraft {
  artifactCount?: number;
  changeType?: AgentBrowserPageChangeSummary["changeType"];
  command?: string;
  nextActionIds?: string[];
  savedFilePath?: string;
  summary?: string;
  title?: string;
  url?: string;
}

function isCompletePageChangeSummary(
  value: PageChangeSummaryDraft,
): value is AgentBrowserPageChangeSummary {
  return value.changeType !== undefined && value.summary !== undefined;
}

interface GetResultFields {
  [subcommand: string]: string;
}

const GET_RESULT_FIELDS: GetResultFields = {
  attr: "value",
  count: "count",
  html: "html",
  text: "text",
  title: "title",
  url: "url",
  value: "value",
};

function getScalarExtractionResult<Value>(
  commandInfo: CommandInfo,
  data: Record<string, Value>,
): string | undefined {
  const fallbackField =
    commandInfo.command === "get" && commandInfo.subcommand
      ? (GET_RESULT_FIELDS[commandInfo.subcommand] ?? "")
      : "";
  const resultField = Object.hasOwn(data, "result")
    ? "result"
    : fallbackField.length > 0 && Object.hasOwn(data, fallbackField)
      ? fallbackField
      : undefined;
  if (resultField === undefined) return undefined;
  const result = data[resultField];
  if (hasRuntimeType(result, "string")) return result.trim().length > 0 ? result : "(empty string)";
  if (hasRuntimeType(result, "number") || hasRuntimeType(result, "boolean")) return String(result);
  if (result === null || result === undefined) return "null";
  if (hasRuntimeType(result, "object")) return JSON.stringify(result);
  return undefined;
}

function getExtractionOrigin<Value>(data: Record<string, Value>): string | undefined {
  if (hasRuntimeType(data.origin, "string") && data.origin.trim().length > 0) {
    return data.origin.trim();
  }
  if (hasRuntimeType(data.url, "string") && data.url.trim().length > 0) {
    return data.url.trim();
  }
  return undefined;
}

function formatGetSummaryLabel(subcommand: string | undefined): string {
  if (!subcommand) {
    return "Get result";
  }
  if (subcommand.toLowerCase() === "url") {
    return "URL";
  }
  return `${subcommand.slice(0, 1).toUpperCase()}${subcommand.slice(1)}`;
}

export function formatExtractionSummary<Value>(
  commandInfo: CommandInfo,
  data: Record<string, Value>,
): string | undefined {
  const scalarResult = getScalarExtractionResult(commandInfo, data);
  if (!scalarResult) {
    return undefined;
  }
  const safeScalarResult = redactModelFacingText(scalarResult);
  const firstResultLine = safeScalarResult.split("\n", 1)[0] ?? safeScalarResult;
  if (commandInfo.command === "get") {
    return `${formatGetSummaryLabel(commandInfo.subcommand)}: ${firstResultLine}`;
  }
  if (commandInfo.command === "eval") {
    return `Eval result: ${firstResultLine}`;
  }
  return undefined;
}

export function formatExtractionText<Value>(
  commandInfo: CommandInfo,
  data: Record<string, Value>,
): string | undefined {
  if (commandInfo.command !== "get" && commandInfo.command !== "eval") {
    return undefined;
  }
  const scalarResult = getScalarExtractionResult(commandInfo, data);
  if (!scalarResult) {
    return undefined;
  }
  const origin = getExtractionOrigin(data);
  const safeScalarResult = redactModelFacingText(scalarResult);
  const safeOrigin = origin ? redactModelFacingText(origin) : undefined;
  return safeOrigin && safeOrigin !== safeScalarResult
    ? `${safeScalarResult}\n\nOrigin: ${safeOrigin}`
    : safeScalarResult;
}

export function isNavigationObservableCommand(command: string | undefined): boolean {
  return isNavigationObservableCommandName(command);
}

function isNavigationSummary<Value>(value: Value): value is Value & NavigationSummary {
  return (
    isRecord(value) &&
    (hasRuntimeType(value.title, "string") || hasRuntimeType(value.url, "string"))
  );
}

export function getNavigationSummary<Value>(
  data: Record<string, Value>,
): NavigationSummary | undefined {
  const candidate = data[NAVIGATION_SUMMARY_FIELD];
  return isNavigationSummary(candidate) ? candidate : undefined;
}

function getTopLevelNavigationSummary<Value>(
  data: Record<string, Value>,
): NavigationSummary | undefined {
  return isNavigationSummary(data)
    ? {
        title: hasRuntimeType(data.title, "string") ? data.title : undefined,
        url: hasRuntimeType(data.url, "string") ? data.url : undefined,
      }
    : undefined;
}

function getNormalizedNavigationSummary(
  summary: NavigationSummary | undefined,
): NavigationSummary | undefined {
  const title =
    summary?.title && summary.title.trim().length > 0 ? summary.title.trim() : undefined;
  const url = summary?.url && summary.url.trim().length > 0 ? summary.url.trim() : undefined;
  return title || url ? { title, url } : undefined;
}

export function formatNavigationSummary(summary: NavigationSummary): string | undefined {
  const normalized = getNormalizedNavigationSummary(summary);
  if (!normalized) return undefined;
  if (normalized.title && normalized.url) return `${normalized.title}\n${normalized.url}`;
  return normalized.title ?? normalized.url;
}

export function buildPageChangeSummary(options: {
  artifacts?: FileArtifactMetadata[];
  commandInfo: CommandInfo;
  data: unknown;
  nextActions?: Array<{ id: string }>;
  savedFilePath?: string;
  summary: string;
}): AgentBrowserPageChangeSummary | undefined {
  const { artifacts, commandInfo, data, nextActions, savedFilePath } = options;
  const artifactCount = artifacts?.length ?? 0;
  const navigation = isRecord(data)
    ? getNormalizedNavigationSummary(
        getNavigationSummary(data) ??
          (isPageChangeSummaryCommand(commandInfo.command)
            ? getTopLevelNavigationSummary(data)
            : undefined),
      )
    : undefined;
  const confirmationRequired = detectConfirmationRequired(data) !== undefined;
  if (
    !navigation &&
    !confirmationRequired &&
    artifactCount === 0 &&
    !savedFilePath &&
    !isPageChangeSummaryCommand(commandInfo.command)
  ) {
    return undefined;
  }
  const changeType: AgentBrowserPageChangeSummary["changeType"] =
    savedFilePath || artifactCount > 0
      ? "artifact"
      : navigation
        ? "navigation"
        : confirmationRequired
          ? "confirmation"
          : "mutation";
  const parts = [commandInfo.command ?? "agent-browser", changeType];
  if (navigation?.title) parts.push(navigation.title);
  if (navigation?.url) parts.push(navigation.url);
  if (savedFilePath) parts.push(savedFilePath);
  else if (artifactCount > 0)
    parts.push(`${artifactCount} artifact${artifactCount === 1 ? "" : "s"}`);
  const pageChangeSummary: PageChangeSummaryDraft = {};
  if (artifactCount > 0) pageChangeSummary.artifactCount = artifactCount;
  pageChangeSummary.changeType = changeType;
  if (commandInfo.command) pageChangeSummary.command = commandInfo.command;
  if (nextActions) pageChangeSummary.nextActionIds = nextActions.map((action) => action.id);
  if (savedFilePath) pageChangeSummary.savedFilePath = savedFilePath;
  pageChangeSummary.summary = parts.join(" → ");
  if (navigation?.title) pageChangeSummary.title = navigation.title;
  if (navigation?.url) pageChangeSummary.url = navigation.url;
  return isCompletePageChangeSummary(pageChangeSummary) ? pageChangeSummary : undefined;
}

function stripNavigationSummary<Value>(data: Record<string, Value>) {
  const { [NAVIGATION_SUMMARY_FIELD]: _navigationSummary, ...rest } = data;
  return rest;
}

export function formatNavigationActionResult<Value>(
  data: Record<string, Value>,
): string | undefined {
  const actionData = omitUpstreamLifecycle(stripNavigationSummary(data));
  const lines: string[] = [];
  if (
    hasRuntimeType(actionData.clicked, "string") ||
    hasRuntimeType(actionData.clicked, "boolean")
  ) {
    lines.push(`Clicked: ${String(actionData.clicked)}`);
  }
  if (hasRuntimeType(actionData.href, "string")) {
    lines.push(`Href: ${redactModelFacingText(actionData.href)}`);
  }
  if (hasRuntimeType(actionData.navigated, "boolean")) {
    lines.push(`Navigated: ${actionData.navigated}`);
  }
  if (lines.length > 0) {
    return lines.join("\n");
  }

  const actionText = stringifyModelFacing(actionData).trim();
  if (actionText.length === 0 || actionText === "{}") {
    return undefined;
  }
  return actionText;
}
