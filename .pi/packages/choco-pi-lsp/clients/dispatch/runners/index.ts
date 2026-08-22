/**
 * Runner definitions for choco-pi-lsp dispatch system
 */

import type { RunnerRegistry } from "../types.ts";
import actionlintRunner from "./actionlint.ts";
import astGrepNapiRunner from "./ast-grep-napi.ts";
import biomeCheckJsonRunner from "./biome-check.ts";
import cppCheckRunner from "./cpp-check.ts";
import credoRunner from "./credo.ts";
import cueVetRunner from "./cue-vet.ts";
import dartAnalyzeRunner from "./dart-analyze.ts";
import detektRunner from "./detekt.ts";
import dotnetBuildRunner from "./dotnet-build.ts";
import elixirCheckRunner from "./elixir-check.ts";
import eslintRunner from "./eslint.ts";
import factRulesRunner from "./fact-rules.ts";
import gleamCheckRunner from "./gleam-check.ts";
import goVetRunner from "./go-vet.ts";
import golangciRunner from "./golangci-lint.ts";
import hadolintRunner from "./hadolint.ts";
import helmLintRunner from "./helm-lint.ts";
import helmRenderRunner from "./helm-render.ts";
import htmlhintRunner from "./htmlhint.ts";
import javacRunner from "./javac.ts";
import ktlintRunner from "./ktlint.ts";
import lspRunner from "./lsp.ts";
import markdownlintRunner from "./markdownlint.ts";
import mypyRunner from "./mypy.ts";
import oxlintRunner from "./oxlint.ts";
import phpLintRunner from "./php-lint.ts";
import phpstanRunner from "./phpstan.ts";
import prismaValidateRunner from "./prisma-validate.ts";
import psScriptAnalyzerRunner from "./psscriptanalyzer.ts";
import pyrightRunner from "./pyright.ts";
import rubocopRunner from "./rubocop.ts";
import ruffRunner from "./ruff.ts";
import rustClippyRunner from "./rust-clippy.ts";
import spotbugsRunner from "./spotbugs.ts";
import shellcheckRunner from "./shellcheck.ts";
import fishIndentRunner from "./fish-indent.ts";
import shfmtRunner from "./shfmt.ts";
import spellcheckRunner from "./spellcheck.ts";
import sqlfluffRunner from "./sqlfluff.ts";
import stylelintRunner from "./stylelint.ts";
import swiftlintRunner from "./swiftlint.ts";
import taploRunner from "./taplo.ts";
import terragruntRunner from "./terragrunt.ts";
import tflintRunner from "./tflint.ts";
import valeRunner from "./vale.ts";
// Import tree-sitter runner
import treeSitterRunner from "./tree-sitter.ts";
import yamllintRunner from "./yamllint.ts";
import zigCheckRunner from "./zig-check.ts";

export function registerDefaultRunners(registry: RunnerRegistry): void {
  // Register all runners (ordered by priority)
  // Unified LSP runner for all languages (TypeScript, Python, Go, Rust, etc.) - priority 4
  registry.register(lspRunner); // Unified LSP type-checking for all languages (priority 4)
  registry.register(pyrightRunner); // Python type-checking (priority 5) - fallback when --lens-lsp disabled
  registry.register(biomeCheckJsonRunner); // Biome check with JSON output for diagnostic capture (priority 9)
  // DISABLED in post-write dispatch - ast-grep-napi can crash. Runs in the
  // project-wide pass via diagnostics_report mode=full (refreshRunners) instead.
  registry.register(astGrepNapiRunner); // TS/JS structural analysis via NAPI (priority 15, post-write disabled)
  registry.register(treeSitterRunner); // Tree-sitter structural analysis (priority 14)
  registry.register(ruffRunner); // Python linting (priority 10)
  registry.register(shellcheckRunner); // Shell script linting (priority 20)
  registry.register(spotbugsRunner); // SpotBugs bytecode bug-patterns for Java/Kotlin (flag-gated via withSpotbugsGroup, priority 50)
  // DISABLED: registerRunner(astGrepRunner); // Replaced by ast-grep-napi for dispatch
  // CLI ast-grep kept for ast_grep_search/ast_grep_replace tools only
  registry.register(eslintRunner); // ESLint (priority 12, jsts, config-gated)
  registry.register(oxlintRunner); // Oxlint (priority 12, jsts, config-aware default fallback)
  registry.register(golangciRunner); // golangci-lint (priority 20, go, config-gated)
  registry.register(rubocopRunner); // RuboCop lint (priority 10, ruby)
  registry.register(spellcheckRunner); // Spellcheck for markdown/docs (priority 30)
  registry.register(yamllintRunner); // YAML lint (priority 22)
  registry.register(actionlintRunner); // GitHub Actions workflow linting (priority 23)
  registry.register(sqlfluffRunner); // SQL lint (priority 24)
  registry.register(goVetRunner); // Go analysis (priority 50)
  registry.register(rustClippyRunner); // Rust analysis (priority 50)
  registry.register(markdownlintRunner); // Markdown lint (priority 30)
  registry.register(mypyRunner); // Python type checking — mypy (priority 20, config-gated)
  registry.register(stylelintRunner); // CSS/SCSS/Less lint (priority 10, config-gated)
  registry.register(swiftlintRunner); // Swift lint — out-of-the-box defaults (priority 20)
  registry.register(shfmtRunner); // Shell formatting check (priority 10)
  registry.register(fishIndentRunner); // Fish script formatting check (priority 10)
  registry.register(factRulesRunner); // FactRule pipeline — all registered rules (priority 21)
  registry.register(htmlhintRunner); // HTML linting — tag pairs, attribute rules (priority 20)
  registry.register(hadolintRunner); // Dockerfile linting — syntax, best practices (priority 20)
  registry.register(helmLintRunner); // Helm chart linting (priority 20)
  registry.register(helmRenderRunner); // Rendered-manifest validation (priority 20, helm.renderValidation.enabled-gated, off by default)
  registry.register(valeRunner); // Prose/style linting for Markdown — config-gated (.vale.ini) (priority 30)
  registry.register(phpLintRunner); // PHP syntax validation via php -l (priority 20)
  registry.register(psScriptAnalyzerRunner); // PowerShell linting via PSScriptAnalyzer module (priority 20)
  registry.register(prismaValidateRunner); // Prisma schema validation via CLI (priority 20)
  registry.register(ktlintRunner); // Kotlin linting via ktlint (priority 10)
  registry.register(detektRunner); // Kotlin static analysis via detekt (priority 20, config-gated)
  registry.register(tflintRunner); // Terraform linting via tflint (priority 20)
  registry.register(terragruntRunner); // Terragrunt linting via terragrunt hcl validate (priority 20)
  registry.register(taploRunner); // TOML linting/validation via taplo (priority 10)
  registry.register(dartAnalyzeRunner); // Dart analysis via dart analyze (priority 20)
  registry.register(javacRunner); // Java compile diagnostics via javac (priority 20)
  registry.register(dotnetBuildRunner); // C# compile diagnostics via dotnet build (priority 20)
  registry.register(cppCheckRunner); // C/C++ compile diagnostics via compiler syntax checks (priority 20)
  registry.register(zigCheckRunner); // Zig compile diagnostics via zig build-exe (priority 20)
  registry.register(gleamCheckRunner); // Gleam project diagnostics via gleam check (priority 20)
  registry.register(credoRunner); // Elixir static analysis via credo (priority 20, mix.exs-gated)
  registry.register(elixirCheckRunner); // Elixir compile/syntax diagnostics via mix/elixirc (priority 20)
  registry.register(phpstanRunner); // PHP static analysis via phpstan (priority 20, config-gated)
  registry.register(cueVetRunner); // CUE evaluation-error validation via cue vet (priority 20) — covers the class cuelsp doesn't publish
}
