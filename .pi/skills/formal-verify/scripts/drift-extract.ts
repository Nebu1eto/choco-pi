// Symbol extraction and hashing for the formal-artefact drift check.
//
// Parsing uses the TypeScript 7 compiler's own parser through its programmatic
// API (`typescript/unstable/async`), which runs the bundled tsgo binary as a
// child process. Sources are handed to it through an in-memory virtual file
// system, so the parser never reads the repository itself: the text that is
// hashed is exactly the text that was parsed. Locating a symbol and hashing
// its text are pure functions over an already parsed source file.

import { createHash } from "node:crypto";
import { extname } from "node:path";
import {
  type ClassDeclaration,
  type ClassElement,
  isClassDeclaration,
  isConstructorDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isPrivateIdentifier,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
  type Node,
  type PropertyName,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";

/** Prefix of every hash this tool writes; a recorded hash in any other form never matches. */
export const HASH_PREFIX = "sha256:";

/**
 * Normalise text before hashing: CRLF and lone CR become LF and trailing
 * whitespace is stripped from every line. Line-ending conversion and editor
 * trailing-space cleanup therefore do not count as a change, while every other
 * edit does, including indentation-only reformatting (leading whitespace is
 * kept), blank-line changes and comment edits inside the declaration.
 */
export function normaliseForHash(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n");
}

/** SHA-256 of the normalised text, as `sha256:<hex>`. */
export function hashText(text: string): string {
  return HASH_PREFIX + createHash("sha256").update(normaliseForHash(text), "utf8").digest("hex");
}

/** A parsed symbol reference: `name` for a top-level declaration, `Class.member` for a class member. */
export type SymbolRef =
  | { readonly kind: "top"; readonly name: string }
  | { readonly kind: "member"; readonly className: string; readonly member: string };

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
const SYMBOL_PATTERN = new RegExp(`^(${IDENT})(?:\\.(#?${IDENT}))?$`, "u");

/** Parse a coverage `symbol` string; undefined when it is not `name` or `Class.member` (ASCII identifiers only). */
export function parseSymbolRef(symbol: string): SymbolRef | undefined {
  const match = SYMBOL_PATTERN.exec(symbol);
  if (match === null) return undefined;
  const [, first, member] = match;
  if (first === undefined) return undefined;
  if (member === undefined) return { kind: "top", name: first };
  return { kind: "member", className: first, member };
}

/**
 * A located symbol. `start`/`end` delimit the declaration in the source and
 * `text` is what gets hashed. They agree except for one declarator of a
 * multi-variable statement, where `text` is the statement head (modifiers such
 * as `export`/`declare` plus the `const`/`let`/`var`/`using` keyword, exactly as
 * written up to the first declarator) followed by that declarator's own text, so
 * the keyword and modifiers are covered while a change to a sibling declarator
 * is not. Out of scope: a member entry does not cover its class's heritage
 * clauses (cover the class for that), and a separate `export { name }` list is
 * not part of the declaration's text.
 */
export type Located =
  | { readonly ok: true; readonly start: number; readonly end: number; readonly text: string }
  | { readonly ok: false; readonly reason: string };

interface Candidate {
  readonly node: Node;
  /** Position of the containing statement or member, used to recognise adjacent overloads. */
  readonly index: number;
  /** Declarations in the same family may be merged when adjacent (overloads, get/set pairs). */
  readonly family: "function" | "method" | "constructor" | "accessor" | "single";
  readonly isStatic: boolean;
  readonly hasBody: boolean;
  /** For one declarator of several: the statement whose head (up to the first declarator) is hashed with it. */
  readonly head?: { readonly statement: Node; readonly firstDeclarator: Node };
}

function hasStaticModifier(node: Node): boolean {
  if (
    !(
      isMethodDeclaration(node) ||
      isPropertyDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)
    )
  ) {
    return false;
  }
  return node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) ?? false;
}

function propertyNameText(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isPrivateIdentifier(name) || isStringLiteral(name)) return name.text;
  return undefined;
}

function topLevelCandidates(sourceFile: SourceFile, name: string): Candidate[] {
  const found: Candidate[] = [];
  sourceFile.statements.forEach((statement, index) => {
    if (isFunctionDeclaration(statement)) {
      if (statement.name?.text === name) {
        found.push({
          node: statement,
          index,
          family: "function",
          isStatic: false,
          hasBody: statement.body !== undefined,
        });
      }
      return;
    }
    if (
      isClassDeclaration(statement) ||
      isInterfaceDeclaration(statement) ||
      isTypeAliasDeclaration(statement) ||
      isEnumDeclaration(statement)
    ) {
      if (statement.name?.text === name) {
        found.push({ node: statement, index, family: "single", isStatic: false, hasBody: true });
      }
      return;
    }
    if (isVariableStatement(statement)) {
      const declarations = statement.declarationList.declarations;
      for (const declaration of declarations) {
        if (isIdentifier(declaration.name) && declaration.name.text === name) {
          // A single declarator is hashed as its whole statement. One of several
          // declarators is hashed as the statement head plus its own text.
          const [firstDeclarator] = declarations;
          if (declarations.length === 1 || firstDeclarator === undefined) {
            found.push({
              node: statement,
              index,
              family: "single",
              isStatic: false,
              hasBody: true,
            });
          } else {
            found.push({
              node: declaration,
              index,
              family: "single",
              isStatic: false,
              hasBody: true,
              head: { statement, firstDeclarator },
            });
          }
        }
      }
    }
  });
  return found;
}

function memberCandidates(declaration: ClassDeclaration, member: string): Candidate[] {
  const found: Candidate[] = [];
  declaration.members.forEach((element: ClassElement, index) => {
    if (isConstructorDeclaration(element)) {
      if (member === "constructor") {
        found.push({
          node: element,
          index,
          family: "constructor",
          isStatic: false,
          hasBody: element.body !== undefined,
        });
      }
      return;
    }
    if (isMethodDeclaration(element)) {
      if (propertyNameText(element.name) === member) {
        found.push({
          node: element,
          index,
          family: "method",
          isStatic: hasStaticModifier(element),
          hasBody: element.body !== undefined,
        });
      }
      return;
    }
    if (isGetAccessorDeclaration(element) || isSetAccessorDeclaration(element)) {
      if (propertyNameText(element.name) === member) {
        found.push({
          node: element,
          index,
          family: "accessor",
          isStatic: hasStaticModifier(element),
          hasBody: true,
        });
      }
      return;
    }
    if (isPropertyDeclaration(element) && propertyNameText(element.name) === member) {
      found.push({
        node: element,
        index,
        family: "single",
        isStatic: hasStaticModifier(element),
        hasBody: true,
      });
    }
  });
  return found;
}

/**
 * Several declarations of one name form a single symbol only when they are
 * adjacent and of one overloadable family: function or method overload
 * signatures followed by at most one implementation (which must be last), or
 * a get/set accessor pair. Anything else is ambiguous.
 */
function mergeable(candidates: readonly Candidate[]): boolean {
  const [first] = candidates;
  if (first === undefined || first.family === "single") return false;
  for (let i = 1; i < candidates.length; i += 1) {
    const current = candidates[i];
    const previous = candidates[i - 1];
    if (current === undefined || previous === undefined) return false;
    if (current.family !== first.family || current.isStatic !== first.isStatic) return false;
    if (current.index !== previous.index + 1) return false;
  }
  if (first.family === "accessor") return candidates.length === 2;
  const bodies = candidates.filter((candidate) => candidate.hasBody);
  if (bodies.length > 1) return false;
  return bodies.length === 0 || candidates.at(-1)?.hasBody === true;
}

function spanOf(sourceFile: SourceFile, candidates: readonly Candidate[], label: string): Located {
  if (candidates.length === 0) return { ok: false, reason: `no declaration named ${label}` };
  if (candidates.length > 1 && !mergeable(candidates)) {
    return { ok: false, reason: `ambiguous: ${candidates.length} declarations named ${label}` };
  }
  const first = candidates[0];
  const last = candidates.at(-1);
  if (first === undefined || last === undefined) {
    return { ok: false, reason: `no declaration named ${label}` };
  }
  // getStart skips leading trivia, including JSDoc, and includes decorators and modifiers.
  const start = first.node.getStart(sourceFile);
  const end = last.node.end;
  const ownText = sourceFile.text.slice(start, end);
  if (candidates.length === 1 && first.head !== undefined) {
    const headText = sourceFile.text.slice(
      first.head.statement.getStart(sourceFile),
      first.head.firstDeclarator.getStart(sourceFile),
    );
    return { ok: true, start, end, text: headText + ownText };
  }
  return { ok: true, start, end, text: ownText };
}

/**
 * Locate a symbol in a parsed source file. Top-level names match function,
 * class, interface, type alias, enum, and const/let/var declarations; members
 * match methods (including private, static and async ones), constructors,
 * accessors and property declarations of one top-level class. Zero matches
 * and non-overload duplicates are errors.
 */
export function locateSymbol(sourceFile: SourceFile, symbol: string): Located {
  const ref = parseSymbolRef(symbol);
  if (ref === undefined) return { ok: false, reason: `invalid symbol reference "${symbol}"` };
  if (ref.kind === "top") {
    return spanOf(sourceFile, topLevelCandidates(sourceFile, ref.name), ref.name);
  }
  const classes = topLevelCandidates(sourceFile, ref.className).filter((candidate) =>
    isClassDeclaration(candidate.node),
  );
  const others = topLevelCandidates(sourceFile, ref.className).length - classes.length;
  if (classes.length === 0) return { ok: false, reason: `no class named ${ref.className}` };
  if (classes.length > 1 || others > 0) {
    return {
      ok: false,
      reason: `ambiguous: several top-level declarations named ${ref.className}`,
    };
  }
  const classNode = classes[0]?.node;
  if (classNode === undefined || !isClassDeclaration(classNode)) {
    return { ok: false, reason: `no class named ${ref.className}` };
  }
  return spanOf(sourceFile, memberCandidates(classNode, ref.member), symbol);
}

/** File extensions the parser accepts for symbol entries. */
export const PARSEABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export type ParseOutcome =
  | { readonly ok: true; readonly sourceFile: SourceFile }
  | { readonly ok: false; readonly reason: string };

/** Thrown when the parser itself cannot run; callers must not treat this as a per-entry result. */
export class ParserUnavailableError extends Error {
  override readonly name = "ParserUnavailableError";
}

/**
 * Parse every source in one parser session. Keys are caller identifiers;
 * `fileName` only supplies the extension, which selects the script kind.
 * A file with syntax errors is reported as a failure: recovery could move
 * declaration boundaries, so nothing in it is trusted.
 */
export async function parseSources(
  sources: ReadonlyMap<string, { readonly fileName: string; readonly text: string }>,
): Promise<Map<string, ParseOutcome>> {
  const results = new Map<string, ParseOutcome>();
  const virtualFiles: Record<string, string> = {};
  const virtualPathByKey = new Map<string, string>();
  let counter = 0;
  for (const [key, source] of sources) {
    const extension = extname(source.fileName).toLowerCase();
    if (!PARSEABLE_EXTENSIONS.has(extension)) {
      results.set(key, {
        ok: false,
        reason: `cannot extract symbols from ${extension || "extensionless"} files`,
      });
      continue;
    }
    const virtualPath = `/drift-virtual/source-${counter}${extension}`;
    counter += 1;
    virtualFiles[virtualPath] = source.text;
    virtualPathByKey.set(key, virtualPath);
  }
  if (virtualPathByKey.size === 0) return results;

  let api: API;
  try {
    api = new API({ cwd: "/drift-virtual", fs: createVirtualFileSystem(virtualFiles) });
  } catch (error) {
    throw new ParserUnavailableError(`cannot start the TypeScript parser: ${String(error)}`);
  }
  try {
    const snapshot = await api.updateSnapshot({ openFiles: [...virtualPathByKey.values()] });
    for (const [key, virtualPath] of virtualPathByKey) {
      const project = await snapshot.getDefaultProjectForFile(virtualPath);
      if (project === undefined) {
        results.set(key, { ok: false, reason: "parser did not load the file" });
        continue;
      }
      const sourceFile = await project.program.getSourceFile(virtualPath);
      if (sourceFile === undefined) {
        results.set(key, { ok: false, reason: "parser did not load the file" });
        continue;
      }
      if (sourceFile.text !== virtualFiles[virtualPath]) {
        results.set(key, { ok: false, reason: "parser returned different text than was read" });
        continue;
      }
      const diagnostics = await project.program.getSyntacticDiagnostics(virtualPath);
      if (diagnostics.length > 0) {
        const first = diagnostics[0];
        results.set(key, {
          ok: false,
          reason: `syntax errors (${diagnostics.length}), first: ${first?.text ?? "unknown"}`,
        });
        continue;
      }
      results.set(key, { ok: true, sourceFile });
    }
    return results;
  } catch (error) {
    if (error instanceof ParserUnavailableError) throw error;
    throw new ParserUnavailableError(`TypeScript parser failed: ${String(error)}`);
  } finally {
    await api.close().catch(() => undefined);
  }
}

/** Parse one source text and locate one symbol in it; convenience for tests and single lookups. */
export async function extractSymbol(
  fileName: string,
  text: string,
  symbol: string,
): Promise<Located> {
  const parsed = (await parseSources(new Map([["source", { fileName, text }]]))).get("source");
  if (parsed === undefined) return { ok: false, reason: "parser returned no result" };
  if (!parsed.ok) return parsed;
  return locateSymbol(parsed.sourceFile, symbol);
}
