import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { getImplementationContext } from "../figma/src/figma-summarizer.ts";
import { buildCssLayoutHints, buildResponsiveHints } from "../figma/src/figma-implementation.ts";
import { asFigmaRecord, parseFigmaJson, type FigmaValue } from "../figma/src/figma-values.ts";

async function fixture(name: string): Promise<FigmaValue> {
	return parseFigmaJson(await readFile(join(import.meta.dirname, "..", "figma", "fixtures", name), "utf8"));
}

test("buildCssLayoutHints maps auto-layout to CSS flex and grid hints", async () => {
	const node = await fixture("complex-auto-layout.json");
	const hints = buildCssLayoutHints(node);
	const css = asFigmaRecord(hints.css);
	assert.deepEqual(css.display, "flex");
	assert.equal(css.flexDirection, "column");
	assert.equal(css.gap, "16px");
	assert.equal(css.padding, "20px 24px 20px 24px");
	assert.ok(Array.isArray(css.layoutGrids));
});

test("buildResponsiveHints recommends fill, hug, fixed, and wrap behavior", async () => {
	const node = await fixture("complex-auto-layout.json");
	const hints = buildResponsiveHints(node);
	assert.ok(hints.some((hint) => String(hint.name) === "Header Row" && Array.isArray(hint.recommendations) && hint.recommendations.some((rec) => String(rec).includes("width: 100%"))));
	assert.ok(hints.some((hint) => String(hint.name) === "Dashboard Card" && Array.isArray(hint.recommendations) && hint.recommendations.some((rec) => String(rec).includes("Fixed width"))));
});

test("implementation context includes layout, responsive, accessibility, tokens, and snippets", async () => {
	const node = await fixture("variables-and-styles.json");
	const context = getImplementationContext(node, {
		framework: "react",
		styling: "styled-components",
		includeCodeSnippets: true,
		tokenMap: {
			styles: { "S:primary-fill": { name: "Color/Primary", type: "FILL" }, "S:text-button": { name: "Typography/Button", type: "TEXT" } },
			variables: { "VariableID:color-primary": { name: "color.primary" }, "VariableID:text-on-primary": { name: "color.onPrimary" }, "VariableID:radius-md": { name: "radius.md" } },
			collections: {},
			warnings: [],
		},
	});
	assert.ok(context.cssLayout);
	assert.ok(context.accessibility?.some((hint) => hint.role === "button"));
	const resolvedTokens = context.designTokens?.resolved;
	assert.ok(Array.isArray(resolvedTokens));
	assert.ok(resolvedTokens.some((token) => asFigmaRecord(token).name === "Color/Primary"));
	assert.equal(context.frameworkHints?.framework, "react");
	assert.match(String(context.frameworkHints?.snippet), /styled\.section/);
});
