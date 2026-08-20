import { defineConfig } from "oxlint";

/**
 * Lint configuration for the choco-pi harness.
 *
 * Scope note: every package's vendored node_modules tree is tracked in git so
 * a fresh clone runs without an install step. That is third-party code, so it
 * is never linted.
 */
export default defineConfig({
  ignorePatterns: [
    "**/node_modules/**",
    ".pi/npm/**",
    ".pi/git/**",
    "tools/oxlint/anti-slop/**",
    // Build output, not authored source: linting a minified bundle is
    // meaningless, and editing one diverges it from whatever produced it.
    "**/*.bundle.js",
  ],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
