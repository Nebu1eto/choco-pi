import { buildFrameworkHints, type FigmaFramework, type FigmaStyling } from "./figma-implementation.ts";
import type { FigmaImplementationContext, FigmaNodeSummary } from "./figma-summarizer.ts";
import type { CodeConnectScanResult } from "./code-connect.ts";
import { asFigmaRecord, type FigmaRecord } from "./figma-values.ts";

export interface FigmaComponentHintOptions {
	framework?: FigmaFramework;
	styling?: FigmaStyling;
	includeSnippet?: boolean;
	includeCodeConnect?: boolean;
}

export interface FigmaComponentImplementationHints {
	componentName: string;
	suggestedFiles: string[];
	suggestedProps: FigmaRecord[];
	statesAndVariants: FigmaRecord[];
	accessibilityRequirements: FigmaRecord[];
	tokenDependencies: FigmaRecord[];
	assetDependencies: FigmaRecord[];
	codeConnect?: CodeConnectScanResult;
	frameworkHints?: FigmaRecord;
	metadata: { truncated: boolean; truncatedReasons: string[]; nextSteps: string[] };
}

export function buildComponentImplementationHints(
	summary: FigmaNodeSummary,
	implementationContext: FigmaImplementationContext,
	options: FigmaComponentHintOptions = {},
	codeConnect?: CodeConnectScanResult,
): FigmaComponentImplementationHints {
	const componentName = toPascalCase(summary.name || "FigmaComponent");
	const suggestedProps = inferProps(summary);
	const statesAndVariants = collectVariants(summary);
	const frameworkHints = buildFrameworkHints(summary, { framework: options.framework, styling: options.styling, includeCodeSnippets: options.includeSnippet });
	// SAFETY: buildFrameworkHints constructs fileHints exclusively from string template literals.
	const suggestedFiles = frameworkHints?.fileHints as string[] | undefined;
	const resolvedTokens = implementationContext.designTokens?.resolved;
	const nextSteps = ["Use these hints as starter guidance; map to existing app components and design tokens before coding."];
	if (!codeConnect?.matches.length && options.includeCodeConnect) nextSteps.push("No Code Connect match was found; search local component names before creating a new component.");
	return {
		componentName,
		suggestedFiles: suggestedFiles ?? [`${componentName}.tsx`],
		suggestedProps,
		statesAndVariants,
		accessibilityRequirements: (implementationContext.accessibility ?? []).slice(0, 40),
		tokenDependencies: (Array.isArray(resolvedTokens) ? resolvedTokens.map(asFigmaRecord) : []).slice(0, 40),
		assetDependencies: (implementationContext.assets ?? []).slice(0, 40).map((asset) => ({ ...asset })),
		codeConnect: options.includeCodeConnect ? codeConnect : undefined,
		frameworkHints,
		metadata: { truncated: false, truncatedReasons: [], nextSteps },
	};
}

function inferProps(summary: FigmaNodeSummary): FigmaRecord[] {
	const props: FigmaRecord[] = [];
	const texts = summary.visibleText ?? [];
	if (texts.length) props.push({ name: "children", type: "ReactNode/string", source: "visible text", example: texts[0] });
	if (hasRole(summary, "button")) props.push({ name: "onClick", type: "() => void", source: "button-like layer" });
	if (hasRole(summary, "form-control")) props.push({ name: "value", type: "string", source: "form-control-like layer" });
	return props;
}

function collectVariants(summary: FigmaNodeSummary): FigmaRecord[] {
	const out: FigmaRecord[] = [];
	for (const node of flatten(summary)) {
		const properties = asFigmaRecord(node.component?.componentProperties);
		if (!Object.keys(properties).length) continue;
		for (const [name, raw] of Object.entries(properties)) out.push({ nodeId: node.id, nodeName: node.name, name, ...asFigmaRecord(raw) });
	}
	return out.slice(0, 40);
}

function hasRole(summary: FigmaNodeSummary, role: string): boolean {
	return flatten(summary).some((node) => node.roleGuess === role || String(node.name).toLowerCase().includes(role));
}

function flatten(summary: FigmaNodeSummary): FigmaNodeSummary[] {
	const out: FigmaNodeSummary[] = [];
	function visit(node: FigmaNodeSummary): void {
		out.push(node);
		for (const child of node.children ?? []) visit(child);
	}
	visit(summary);
	return out;
}

function toPascalCase(value: string): string {
	const result = value.replace(/[^a-z0-9]+/gi, " ").trim().split(/\s+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
	return /^[A-Z]/.test(result) ? result : `Figma${result || "Component"}`;
}
