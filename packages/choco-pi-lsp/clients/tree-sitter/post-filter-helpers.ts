/**
 * Syntax helpers used by rule post-filters (bindings, fallthrough, termination, fixed URL and SQLAlchemy checks).
 */
import type { TreeSitterNode } from "./shared.ts";

export function hasChildToken(node: TreeSitterNode, token: string): boolean {
  return node.children?.some((child) => child.type === token || child.text === token);
}

/**
 * Collect names introduced by a parameter binding pattern.
 *
 * Binding-aware: only identifiers in a *binding* position are counted.
 * Two node shapes hold reference expressions rather than bindings and
 * must not be descended into:
 *  - `assignment_pattern` / `object_assignment_pattern` (`pattern = default`,
 *    e.g. `[a = b]` or `{a = b}`) — the `value`/`right` side is a default
 *    *expression*, not a new name (`b` in `{a = b}` is a reference).
 *  - `computed_property_name` (`[expr]:` in a destructuring pattern,
 *    e.g. `{[key]: a}`) — `expr` is a reference, not a binding.
 * Nested binding positions (destructured sub-patterns) are still walked
 * so renamed/duplicate collisions inside them are found.
 */
export function bindingNames(node: TreeSitterNode | undefined): Set<string> {
  const names = new Set<string>();
  if (!node) return names;
  const stack: TreeSitterNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === "identifier") names.add(current.text);
    else if (current.type === "shorthand_property_identifier_pattern") {
      names.add(current.text);
    }
    if (
      current.type === "property_identifier" ||
      current.type === "type_identifier" ||
      current.type === "computed_property_name"
    )
      continue;
    if (current.type === "assignment_pattern" || current.type === "object_assignment_pattern") {
      const left = current.childForFieldName?.("left");
      if (left) stack.push(left);
      continue;
    }
    stack.push(...(current.children ?? []));
  }
  return names;
}

export function containsYieldInFunctionBody(
  node: TreeSitterNode,
  root: TreeSitterNode = node,
): boolean {
  for (const child of node.children ?? []) {
    if (child.type === "yield") return true;
    if (
      child !== root &&
      ["function_definition", "class_definition", "lambda"].includes(child.type)
    ) {
      continue;
    }
    if (containsYieldInFunctionBody(child, root)) return true;
  }
  return false;
}

export function isLikelySqlAlchemyReceiver(text: string): boolean {
  const tail = text.split(".").pop() ?? text;
  return new Set(["session", "db_session", "async_session", "sync_session"]).has(
    tail.toLowerCase(),
  );
}

/**
 * The body statements of a `switch_case`, in order. A switch_case's named
 * children are `[value, ...statements]` (its statements are direct children,
 * not a wrapping statement_block), so drop the leading `case <value>` and any
 * comments.
 */
export function switchCaseBodyStatements(caseNode: TreeSitterNode): TreeSitterNode[] {
  // biome-ignore lint/suspicious/noExplicitAny: AST child iteration
  const named = (caseNode.children ?? []).filter(
    (c: any) => c.isNamed && !c.type.includes("comment"),
  );
  // First named child is the case's value expression (`case <value>`).
  return named.slice(1);
}

/**
 * Whether a case body carries an intentional fallthrough marker comment
 * (`// fallthrough`, `// falls through`, …). Only a *trailing* marker is
 * honored: a comment attached to the case node after its body statements
 * (TypeScript), the case's next sibling in the switch body (JavaScript), or
 * one inside the trailing body statement's block. A comment in a nested
 * function or an earlier statement is not a marker for this case and must
 * not suppress a genuine fall-through. Only comment nodes are checked, never
 * the case value or statement text.
 */
export function hasFallthroughMarker(caseNode: TreeSitterNode): boolean {
  const comments: TreeSitterNode[] = [];
  const body = switchCaseBodyStatements(caseNode);
  const last = body[body.length - 1];
  const lastEnd = last?.endIndex ?? caseNode.startIndex;
  // TypeScript attaches a trailing `// fallthrough` as a direct child of the
  // case node, after the body statements.
  for (const c of caseNode.children ?? []) {
    if (c.type.includes("comment") && c.startIndex >= lastEnd) {
      comments.push(c);
    }
  }
  // JavaScript attaches it to the switch body as the case's next sibling.
  const siblings = (caseNode.parent?.children ?? []).filter((c) => c.isNamed);
  const index = siblings.findIndex((c) => c.startIndex === caseNode.startIndex);
  const next = index >= 0 ? siblings[index + 1] : undefined;
  if (next?.type.includes("comment")) comments.push(next);
  // A marker inside the trailing body statement's block (e.g. `{ work();
  // /* fallthrough */ }`). Only the trailing statement is walked, and nested
  // functions are not descended into, so a comment in a nested function or
  // an earlier statement can't suppress a genuine fall-through.
  if (last) {
    const NESTED_FN = new Set([
      "function_declaration",
      "function_expression",
      "arrow_function",
      "method_definition",
      "generator_function",
      "generator_function_declaration",
      "class_declaration",
    ]);
    const stack: TreeSitterNode[] = [last];
    for (let visited = 0; stack.length > 0 && visited < 500; visited++) {
      const node = stack.pop();
      if (!node) break;
      if (node.type.includes("comment")) comments.push(node);
      if (!NESTED_FN.has(node.type)) {
        stack.push(...(node.children ?? []));
      }
    }
  }
  return comments.some((c) => /falls?\s?through/i.test(c.text));
}

/**
 * Whether a statement terminates control flow (does not fall through to the
 * next statement). Handles terminators, trailing blocks, try/catch/finally,
 * and exhaustive if/else. Fail-safe: any unrecognized shape returns false
 * (falls through), so a blocking rule never under-reports. Depth-bounded so a
 * pathological nesting cannot blow the stack.
 */
export function statementTerminates(node: TreeSitterNode, depth = 0): boolean {
  if (depth > 20) return false;
  const t = node.type;
  const TERMINATORS = new Set([
    "break_statement",
    "return_statement",
    "throw_statement",
    "continue_statement",
  ]);
  if (TERMINATORS.has(t)) return true;
  // Wrapper nodes whose trailing statement decides termination: a block, an
  // `else` clause, a `catch` clause, or a `finally` clause.
  if (
    t === "statement_block" ||
    t === "else_clause" ||
    t === "catch_clause" ||
    t === "finally_clause"
  ) {
    const inner = (node.children ?? []).filter((c) => c.isNamed && !c.type.includes("comment"));
    const last = inner[inner.length - 1];
    if (!last) return false; // empty wrapper falls through
    return statementTerminates(last, depth + 1);
  }
  if (t === "try_statement") {
    // The try body is the first statement_block child. A returning/throwing
    // try completes after finally, so only a catch that handles a thrown try
    // and falls through can still reach the end. A try body that completes
    // normally reaches the end unless a finally terminates it.
    const tryBody = (node.children ?? []).find((c) => c.type === "statement_block");
    const tryTerminates = tryBody ? statementTerminates(tryBody, depth + 1) : false;
    const catches = (node.children ?? []).filter((c) => c.type === "catch_clause");
    const fin = (node.children ?? []).find((c) => c.type === "finally_clause");
    if (tryTerminates) {
      return catches.every((c) => statementTerminates(c, depth + 1));
    }
    return !!fin && statementTerminates(fin, depth + 1);
  }
  if (t === "if_statement") {
    // An if only terminates when it has an else and both branches do.
    const named = (node.children ?? []).filter((c) => c.isNamed && !c.type.includes("comment"));
    // named = [condition, consequence, (else_clause)]
    const consequence = named[1];
    const alternative = named[2];
    if (!consequence || !alternative) return false;
    return (
      statementTerminates(consequence, depth + 1) && statementTerminates(alternative, depth + 1)
    );
  }
  return false;
}

/**
 * Whether a `switch_case`'s next sibling is another label — `case "a": case
 * "b": handle()` groups two labels onto one body, which is idiomatic, not a
 * dead case.
 */
export function nextSiblingIsSwitchLabel(caseNode: TreeSitterNode): boolean {
  const siblings = (caseNode.parent?.children ?? []).filter(
    (c) => c.isNamed && !c.type.includes("comment"),
  );
  // Match by source offset: web-tree-sitter hands out fresh node wrappers per
  // access, so identity comparison against `caseNode` is not reliable.
  const index = siblings.findIndex((c) => c.startIndex === caseNode.startIndex);
  const next = index >= 0 ? siblings[index + 1] : undefined;
  return next?.type === "switch_case" || next?.type === "switch_default";
}

/**
 * Whether a loop body contains a statement that can terminate the loop:
 * `return`/`throw` anywhere (they unwind past the loop), or a `break` that is
 * not swallowed by a nested loop/switch. Does not descend into nested
 * functions, whose `return` exits the function rather than the loop.
 */
export function bodyHasLoopExit(node: TreeSitterNode, insideNestedLoop: boolean): boolean {
  const NESTS_BREAK = new Set([
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "switch_statement",
  ]);
  const NESTED_FN = new Set([
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "generator_function",
    "generator_function_declaration",
    "class_declaration",
  ]);
  for (const child of node.children ?? []) {
    const t = child.type;
    if (NESTED_FN.has(t)) continue;
    if (t === "return_statement" || t === "throw_statement") return true;
    // A labeled `break outer;` is not swallowed by the nested loop it sits
    // in. Which label it targets isn't resolved here — counting any labeled
    // break as an exit errs toward not flagging, the safe direction for a
    // blocking rule.
    if (t === "break_statement") {
      const labeled = (child.children ?? []).some((c) => c.isNamed);
      if (!insideNestedLoop || labeled) return true;
    }
    if (bodyHasLoopExit(child, insideNestedLoop || NESTS_BREAK.has(t))) {
      return true;
    }
  }
  return false;
}

/**
 * Name of the binding a node's value flows into: the declared name of an
 * enclosing `variable_declarator`, or the left-hand side of an enclosing
 * `assignment_expression`. Returns "" if the node is not part of a binding
 * (the walk stops at function/block/program boundaries so it never reaches
 * out to an unrelated outer binding).
 */
export function enclosingBindingName(node: TreeSitterNode | undefined): string {
  let cur: TreeSitterNode | null | undefined = node?.parent;
  for (let depth = 0; cur && depth < 12; depth++) {
    const t = cur.type;
    if (t === "variable_declarator") {
      const name = cur.children?.find((c) => c.isNamed);
      return name?.text ?? "";
    }
    if (t === "assignment_expression") {
      return cur.children?.[0]?.text ?? "";
    }
    if (
      t === "statement_block" ||
      t === "program" ||
      t === "function_declaration" ||
      t === "function_expression" ||
      t === "arrow_function" ||
      t === "method_definition"
    ) {
      return "";
    }
    cur = cur.parent;
  }
  return "";
}

/**
 * Resolves `name` (as used in the *same file*) to a provably fixed URL:
 * a `const` declarator whose initializer is a string literal, or a
 * template literal with no `${...}` substitutions.
 *
 * This is deliberately conservative — naming convention (e.g.
 * SCREAMING_SNAKE_CASE) proves nothing about provenance, so it is never
 * consulted here. Any of the following makes resolution fail (and the
 * caller must then treat the identifier as potentially tainted):
 *   - no declarator found for `name` in this file;
 *   - more than one declarator for `name` (ambiguous/shadowed — refuse
 *     rather than guess which one applies at the use site);
 *   - declared with `let`/`var` (not `const`);
 *   - the identifier is reassigned anywhere in the file
 *     (`name = ...`), even if the declaration itself is `const`-like in
 *     spirit — this also catches destructuring/compound-assignment
 *     edge cases conservatively since we only special-case a clean
 *     assignment_expression;
 *   - the initializer is not a plain string/no-substitution template
 *     literal (e.g. `process.env.X`, a function call, a member
 *     expression, another identifier).
 */
export function resolvesToFileLiteralConst(name: string, rootNode: TreeSitterNode): boolean {
  const valueNode = resolveFileConstValueNode(name, rootNode);
  if (!valueNode) return false;
  return isFixedUrlLiteralExpr(valueNode);
}

/**
 * Resolves `name` to the initializer value node of its *single, clean*
 * file-local `const` declarator, or `null` when resolution must be refused.
 *
 * Refusal (returns `null`) on any of: no declarator; more than one
 * declarator (shadowed/ambiguous — don't guess); a `let`/`var` binding for
 * the same name anywhere; or a reassignment (`name = ...`) anywhere in the
 * file. This is the shared, provenance-safe gate used by every "provably
 * fixed value" check; callers inspect the returned value node themselves.
 */
function resolveFileConstValueNode(name: string, rootNode: TreeSitterNode): TreeSitterNode | null {
  const constDeclarators: TreeSitterNode[] = [];
  let hasNonConstBinding = false;
  let hasReassignment = false;

  const stack: TreeSitterNode[] = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === "variable_declarator") {
      const nameNode = node.childForFieldName?.("name");
      if (nameNode?.type === "identifier" && nameNode.text === name) {
        const decl = node.parent;
        const isConst =
          decl?.type === "lexical_declaration" &&
          (decl.children ?? []).some((c) => c.type === "const");
        if (isConst) {
          constDeclarators.push(node);
        } else {
          hasNonConstBinding = true;
        }
      }
    } else if (
      node.type === "assignment_expression" ||
      node.type === "augmented_assignment_expression"
    ) {
      const left = node.childForFieldName?.("left");
      if (left?.type === "identifier" && left.text === name) {
        hasReassignment = true;
      } else if (
        (left?.type === "member_expression" || left?.type === "subscript_expression") &&
        left.childForFieldName?.("object")?.type === "identifier" &&
        left.childForFieldName?.("object")?.text === name
      ) {
        // Property/subscript write to the bound receiver
        // (`name.<prop> = …` / `name[…] = …`). Any origin/host/path/
        // protocol/port/href mutation re-taints the destination after
        // construction, so fail closed and treat it as a reassignment
        // (#1008). The ONE safe exception is a query-string-only write
        // (`name.search = …`), which never alters the origin;
        // `name.searchParams.<method>(…)` is a call_expression (not an
        // assignment) and so never reaches this branch, staying exempt.
        const searchOnly =
          left.type === "member_expression" &&
          left.childForFieldName?.("property")?.text === "search";
        if (!searchOnly) {
          hasReassignment = true;
        }
      }
    }
    for (const child of node.children ?? []) stack.push(child);
  }

  // Ambiguous (shadowed/duplicated), reassigned anywhere, or backed by a
  // non-const binding somewhere in the file: refuse to resolve.
  if (hasNonConstBinding || hasReassignment || constDeclarators.length !== 1) {
    return null;
  }
  return constDeclarators[0].childForFieldName?.("value") ?? null;
}

/**
 * True when `node` is a self-contained fixed URL string: a plain string
 * literal, or a template literal with no `${...}` substitutions.
 */
function isFixedUrlLiteralExpr(node: TreeSitterNode): boolean {
  if (node.type === "string") return true;
  if (node.type === "template_string") {
    return !(node.children ?? []).some((c) => c.type === "template_substitution");
  }
  return false;
}

/**
 * True when `name` is a binding introduced by an `import` in this file
 * (named/aliased/default/namespace). An import binding is immutable and its
 * value is fixed at module-load time from source — it is never request- or
 * attacker-scoped, so an imported base URL is treated as fixed. (Limitation:
 * we cannot see the exporting module, so an imported value that is itself
 * `process.env.X` in another file is not distinguished — an accepted, bounded
 * gap; direct env/param/request taint at the sink still fires.)
 */
function isImportedBinding(name: string, rootNode: TreeSitterNode): boolean {
  return importedAs(name, rootNode) !== null;
}

/**
 * If `name` is an import binding, returns the *imported* name (e.g. `URL`
 * for `import { URL as NodeURL }` → `importedAs("NodeURL") === "URL"`, and
 * `importedAs("URL") === "URL"`). Returns `null` when `name` is not imported.
 */
function importedAs(name: string, rootNode: TreeSitterNode): string | null {
  const stack: TreeSitterNode[] = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === "import_specifier") {
      const nameNode = node.childForFieldName?.("name");
      const aliasNode = node.childForFieldName?.("alias");
      const local = (aliasNode ?? nameNode)?.text;
      if (local === name) return nameNode?.text ?? null;
    } else if (node.type === "namespace_import" || node.type === "import_clause") {
      // `import X from …` / `import * as X from …` — default/namespace
      // local binding is a direct identifier child.
      for (const c of node.children ?? []) {
        if (c.type === "identifier" && c.text === name) return name;
      }
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  return null;
}

/**
 * True when `base` (the second argument of `new URL(path, base)`) is a
 * provably fixed origin: a literal/substitution-free template, an identifier
 * resolving to a file-local literal `const` or an import binding, or a
 * template whose every `${…}` substitution is such an identifier. Anything
 * else (function params, `process.env.X`, member expressions, calls) fails.
 */
function isFixedUrlBaseExpr(base: TreeSitterNode, rootNode: TreeSitterNode): boolean {
  if (base.type === "string") return true;
  if (base.type === "identifier") {
    return isFixedBaseIdentifier(base, rootNode);
  }
  if (base.type === "template_string") {
    for (const child of base.children ?? []) {
      if (child.type !== "template_substitution") continue;
      const inner = (child.children ?? []).find((c) => c.isNamed);
      if (!inner || inner.type !== "identifier" || !isFixedBaseIdentifier(inner, rootNode)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * True when the identifier `ident` (used as, or inside, a `new URL` base) is
 * a provably fixed origin AT ITS USE SITE. A file-local literal `const` is
 * only trusted when no nearer binding shadows it: `resolveFileConstValueNode`
 * already fails closed on any `let`/`var` of the same name and on multiple
 * `const` declarators, but function/method PARAMETERS are not variable
 * declarators and so slip past that gate — a request-tainted parameter base
 * would otherwise be exempted merely because an unrelated same-named
 * module-level `const` literal exists (#1008). So we additionally refuse the
 * file-const path when an enclosing function on the path from the use site to
 * the module root binds a parameter of the same name. Imported bindings stay
 * trusted unconditionally (imported-base-as-fixed is sound; see #1000).
 */
function isFixedBaseIdentifier(ident: TreeSitterNode, rootNode: TreeSitterNode): boolean {
  const name = ident.text;
  if (!isShadowedByEnclosingParam(ident, name) && resolvesToFileLiteralConst(name, rootNode)) {
    return true;
  }
  return isImportedBinding(name, rootNode);
}

/**
 * True when some function/method/arrow on the ancestor chain of `node` (up to
 * the module root) binds a PARAMETER named `name` — i.e. `name` at `node`'s
 * location resolves to a parameter, not to an outer `const`. Only binding
 * positions are inspected (a parameter's `pattern`, including destructured
 * bindings); default-value expressions (`= expr`) are uses, not bindings, and
 * are skipped so an outer const referenced in a default is not mistaken for a
 * shadow. Fail-closed bias: unknown parameter shapes that surface a matching
 * identifier in a binding position are treated as a shadow.
 */
function isShadowedByEnclosingParam(node: TreeSitterNode, name: string): boolean {
  const FUNCTION_TYPES = new Set([
    "function_declaration",
    "function_expression",
    "generator_function",
    "generator_function_declaration",
    "arrow_function",
    "method_definition",
  ]);
  let current: TreeSitterNode | null | undefined = node.parent;
  while (current) {
    if (FUNCTION_TYPES.has(current.type)) {
      // Bare-identifier arrow parameter: `name => …`.
      const bare = current.childForFieldName?.("parameter");
      if (bare?.type === "identifier" && bare.text === name) return true;
      const params = current.childForFieldName?.("parameters");
      if (params && paramsBindName(params, name)) return true;
    }
    current = current.parent;
  }
  return false;
}

/** True when a `formal_parameters` node binds `name` in any binding position. */
function paramsBindName(params: TreeSitterNode, name: string): boolean {
  for (const param of params.children ?? []) {
    if (!param.isNamed) continue;
    // required_parameter / optional_parameter carry the binding in `pattern`
    // and the default (a use, not a binding) in `value`.
    const pattern =
      param.type === "required_parameter" || param.type === "optional_parameter"
        ? param.childForFieldName?.("pattern")
        : param;
    if (pattern && patternBindsName(pattern, name)) return true;
  }
  return false;
}

/**
 * True when a binding pattern (`identifier`, or a destructuring
 * object/array/rest pattern) introduces `name`. Walks the pattern but skips
 * `assignment_pattern` default values (`= expr`), which are uses.
 */
function patternBindsName(pattern: TreeSitterNode, name: string): boolean {
  if (pattern.type === "identifier") return pattern.text === name;
  const stack: TreeSitterNode[] = [pattern];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (
      (n.type === "identifier" || n.type === "shorthand_property_identifier_pattern") &&
      n.text === name
    ) {
      return true;
    }
    if (n.type === "assignment_pattern") {
      // Only the left (binding) side introduces names; skip the default.
      const left = n.childForFieldName?.("left") ?? n.children?.[0];
      if (left) stack.push(left);
      continue;
    }
    for (const c of n.children ?? []) stack.push(c);
  }
  return false;
}

/**
 * True when `name` resolves (same file) to a `const` initialized with
 * `new URL(<literalPath>, <fixedBase>)` — a fully fixed destination origin
 * and path. Query parameters added later via `url.searchParams.set(...)` do
 * not alter origin/path, so they never taint the destination. The `URL`
 * constructor may be imported under an alias (e.g. `NodeURL`).
 */
export function resolvesToFixedNewUrlConst(name: string, rootNode: TreeSitterNode): boolean {
  const value = resolveFileConstValueNode(name, rootNode);
  if (!value || value.type !== "new_expression") return false;

  const ctor = value.childForFieldName?.("constructor");
  const ctorName = ctor?.text ?? "";
  const isUrlCtor =
    ctorName === "URL" || (ctor?.type === "identifier" && importedAs(ctorName, rootNode) === "URL");
  if (!isUrlCtor) return false;

  const args = (value.childForFieldName?.("arguments")?.children ?? []).filter(
    (c) => c.isNamed && c.type !== "comment",
  );
  if (args.length === 0) return false;
  // First arg (relative path / full URL) must be a literal.
  if (!isFixedUrlLiteralExpr(args[0])) return false;
  // Single-arg form: `new URL("https://host/path")` — already fully fixed.
  if (args.length === 1) return true;
  // Two-arg form: base must resolve to a fixed origin.
  return isFixedUrlBaseExpr(args[1], rootNode);
}

/**
 * For a fetch URL argument of the form `u.toString()` (call_expression) or
 * `u.href` (member_expression), returns the receiver identifier name `u`
 * (only for the `toString`/`href` accessors a `URL` yields). Returns `null`
 * for any other shape so the caller falls through to taint heuristics.
 */
export function newUrlBaseVarName(urlNode: TreeSitterNode): string | null {
  let member: TreeSitterNode | null | undefined;
  if (urlNode.type === "call_expression") {
    member = urlNode.childForFieldName?.("function");
  } else if (urlNode.type === "member_expression") {
    member = urlNode;
  }
  if (!member || member.type !== "member_expression") return null;
  const prop = member.childForFieldName?.("property")?.text;
  if (prop !== "toString" && prop !== "href") return null;
  const object = member.childForFieldName?.("object");
  if (object?.type !== "identifier") return null;
  return object.text;
}

export function isSafeSqlAlchemyExpressionCall(node: TreeSitterNode): boolean {
  if (node.type !== "call") return false;
  const callee = node.children?.[0]?.text ?? "";
  const expression = node.text;
  return ["select", "insert", "update", "delete"].some(
    (name) => callee === name || expression.startsWith(`${name}(`),
  );
}
