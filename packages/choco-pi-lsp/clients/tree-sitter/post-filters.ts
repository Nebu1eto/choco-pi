/**
 * Rule post-filters (applyPostFilter) and their failure/missing-filter diagnostics.
 */
import { logTreeSitterDiagnostic } from "../tree-sitter-logger.ts";
import type { TreeSitterClientInternals } from "./internals.ts";
import {
  bindingNames,
  bodyHasLoopExit,
  containsYieldInFunctionBody,
  enclosingBindingName,
  hasChildToken,
  hasFallthroughMarker,
  isLikelySqlAlchemyReceiver,
  isSafeSqlAlchemyExpressionCall,
  newUrlBaseVarName,
  nextSiblingIsSwitchLabel,
  resolvesToFileLiteralConst,
  resolvesToFixedNewUrlConst,
  statementTerminates,
  switchCaseBodyStatements,
} from "./post-filter-helpers.ts";
import { NO_NESTED_ANCHOR_VISIT_CAP, type TreeSitterNode } from "./shared.ts";

/**
 * Post-filter predicate: returns true if the match should be kept, false to skip.
 * Each branch is an independent filter identified by name — flat dispatch, no nesting.
 */
// biome-ignore lint/suspicious/noExplicitAny: postFilterParams is untyped per-filter config
export function applyPostFilter(
  core: TreeSitterClientInternals,
  postFilter: string,
  postFilterParams: any,
  captures: Record<string, TreeSitterNode>,
  rootNode?: TreeSitterNode,
): boolean {
  /**
   * Extract the list of declared slot names from a class_definition's
   * `__slots__` assignment. Returns:
   *   - `null` if the class has no `__slots__` declaration
   *   - an array of slot names (strings) otherwise
   *
   * Handles both common shapes:
   *   - string tuple/list: `__slots__ = ("a", "b")` or `['a', 'b']`
   *   - single string:     `__slots__ = "a"` (Python's quirky single-slot form)
   *   - parent inheritance: returns null (we don't follow MRO)
   */
  function extractSlots(classNode: any): string[] | null {
    const classText = classNode.text ?? "";
    if (!classText.includes("__slots__")) return null;
    // biome-ignore lint/suspicious/noExplicitAny: AST iteration
    const body = classNode.children?.find((c: any) => c.type === "block");
    if (!body) return null;
    const slots: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: AST iteration
    for (const stmt of body.children ?? []) {
      if (stmt.type !== "expression_statement") continue;
      // biome-ignore lint/suspicious/noExplicitAny: AST traversal
      const assignment = stmt.children?.find((c: any) => c.type === "assignment");
      if (!assignment) continue;
      // biome-ignore lint/suspicious/noExplicitAny: LHS check
      // LHS text may include a leading whitespace token from the AST
      // (tree-sitter separates the space before the LHS identifier).
      const lhsText = (assignment.children?.[0]?.text ?? "").trim();
      if (lhsText !== "__slots__") continue;
      // biome-ignore lint/suspicious/noExplicitAny: RHS extraction
      // children layout: [LHS identifier, `=` operator, RHS expression]
      const rhs = assignment.children?.[2];
      if (!rhs) continue;
      if (rhs.type === "string") {
        // __slots__ = "a" — single string form (Python quirk)
        const s = (rhs.text ?? "").replace(/^["']|["']$/g, "");
        if (s) slots.push(s);
      } else if (rhs.type === "tuple" || rhs.type === "list") {
        // biome-ignore lint/suspicious/noExplicitAny: list element extraction
        for (const el of rhs.children ?? []) {
          if (!el.isNamed) continue; // skip "," punctuation
          if (el.type === "string") {
            slots.push((el.text ?? "").replace(/^["']|["']$/g, ""));
          }
        }
      }
      break; // first __slots__ wins
    }
    return slots;
  }

  /**
   * Escape a string for safe interpolation into a `RegExp` source —
   * needed anywhere an identifier's raw text is combined with regex
   * metacharacters like `\b` word boundaries (see
   * "not_closed_or_try_with_resources" below; #1089 P2).
   */
  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  switch (postFilter) {
    case "no_nested_anchor_chain": {
      // Tree-sitter queries can express the opening-tag shape, but they
      // cannot express both an arbitrary-depth descendant relationship and
      // an ancestor exclusion. Walk the captured JSX element here so the
      // TSX path agrees with the ast-grep rule: keep exactly the outermost
      // anchor that contains another anchor, including through wrappers.
      // This post-filter runs inside a batched query walk. It must never
      // abort that walk or turn a malformed tree into a false negative.
      try {
        const outer = captures.OUTER_ELEMENT;
        if (!outer) {
          reportPostFilterFailure(core, postFilter, "missing OUTER_ELEMENT capture");
          return true;
        }
        const isAnchorElement = (node: TreeSitterNode): boolean => {
          if (node.type !== "jsx_element") return false;
          const opening =
            node.childForFieldName?.("open_tag") ??
            node.children?.find((child) => child.type === "jsx_opening_element");
          const name =
            opening?.childForFieldName?.("name") ??
            opening?.children?.find((child) => child.type === "identifier");
          return name?.text === "a";
        };

        let visited = 0;
        let ancestor = outer.parent;
        while (ancestor) {
          if (++visited > NO_NESTED_ANCHOR_VISIT_CAP) {
            reportPostFilterFailure(
              core,
              postFilter,
              `ancestor walk exceeded ${NO_NESTED_ANCHOR_VISIT_CAP} nodes`,
            );
            return true;
          }
          if (isAnchorElement(ancestor)) return false;
          ancestor = ancestor.parent;
        }

        const pending = [...(outer.children ?? [])];
        while (pending.length > 0) {
          const node = pending.pop();
          if (!node) continue;
          if (++visited > NO_NESTED_ANCHOR_VISIT_CAP) {
            reportPostFilterFailure(
              core,
              postFilter,
              `descendant walk exceeded ${NO_NESTED_ANCHOR_VISIT_CAP} nodes`,
            );
            return true;
          }
          if (isAnchorElement(node)) return true;
          pending.push(...(node.children ?? []));
        }
        return false;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        reportPostFilterFailure(core, postFilter, `tree walk failed${reason ? `: ${reason}` : ""}`);
        return true;
      }
    }
    case "differs_only_by_case": {
      try {
        const field = captures.FIELD?.text ?? "";
        const method = captures.METHOD?.text ?? "";
        return field !== method && field.toLocaleLowerCase() === method.toLocaleLowerCase();
      } catch {
        return true;
      }
    }
    case "in_default_package": {
      try {
        if (!rootNode) return true;
        return !(rootNode.children ?? []).some((node) => node.type === "package_declaration");
      } catch {
        return true;
      }
    }
    case "missing_mimetype_and_download_name": {
      try {
        const firstArg = captures.FIRST_ARG;
        if (!firstArg) return true;
        // Flask can infer a MIME type from a filesystem path. The warning
        // is for file-like objects, where it needs an explicit MIME type or
        // download name.
        if (firstArg.type === "string") return false;
        const args = firstArg.parent;
        if (!args) return true;
        return !(args.children ?? []).some((node) => {
          if (node.type !== "keyword_argument") return false;
          const name = node.childForFieldName?.("name")?.text;
          return name === "mimetype" || name === "download_name";
        });
      } catch {
        return true;
      }
    }
    case "missing_super_call": {
      try {
        const body = captures.BODY;
        const method = captures.METHOD?.text ?? "";
        if (!body || !method) return true;
        const stack = [body];
        for (let visited = 0; stack.length > 0 && visited < 10_000; visited++) {
          const node = stack.pop();
          if (!node) break;
          if (
            node.type === "method_invocation" &&
            node.childForFieldName?.("object")?.text === "super" &&
            node.childForFieldName?.("name")?.text === method
          ) {
            return false;
          }
          stack.push(...(node.children ?? []));
        }
        return true;
      } catch {
        return true;
      }
    }
    case "no_assertion_call": {
      try {
        const body = captures.BODY;
        if (!body) return true;
        const assertionNames = /^(?:assert\w*|fail|verify|expect|check|assume\w*)$/i;
        const stack = [body];
        for (let visited = 0; stack.length > 0 && visited < 10_000; visited++) {
          const node = stack.pop();
          if (!node) break;
          if (node.type === "method_invocation") {
            const name = node.childForFieldName?.("name")?.text ?? "";
            if (assertionNames.test(name)) return false;
          }
          stack.push(...(node.children ?? []));
        }
        return true;
      } catch {
        return true;
      }
    }
    case "not_closed_or_try_with_resources": {
      try {
        const declaration = captures.DECL;
        const resource = captures.RESOURCE?.text ?? "";
        if (!declaration || !resource) return true;
        // (#956 review: the old resource_specification ANCESTOR walk was
        // dead code — the query only matches local_variable_declaration,
        // which the Java grammar never places inside a try header. The
        // real try-with-resources shapes are handled in the scope scan
        // below: a `resource` node naming this variable covers both
        // `try (Type x = …)` and the Java 9 `try (x)` form.)
        const scope =
          core.navigator.findParent(declaration, [
            "method_declaration",
            "constructor_declaration",
            "block",
          ]) ?? rootNode;
        if (!scope) return true;
        // `\b` in a template literal is the BACKSPACE control char
        // (U+0008), not a regex word-boundary escape — that requires
        // the literal two-character sequence `\\b`. The identifier
        // itself must also be regex-escaped (#1089 P2).
        const resourceWord = new RegExp(`\\b${escapeRegExp(resource)}\\b`);
        const stack = [scope];
        for (let visited = 0; stack.length > 0 && visited < 10_000; visited++) {
          const node = stack.pop();
          if (!node) break;
          if (
            node.type === "method_invocation" &&
            node.childForFieldName?.("object")?.text === resource &&
            node.childForFieldName?.("name")?.text === "close"
          ) {
            return false;
          }
          if (node.type === "resource" && resourceWord.test(node.text ?? "")) {
            return false;
          }
          stack.push(...(node.children ?? []));
        }
        return true;
      } catch {
        return true;
      }
    }
    case "same_method_no_base_case": {
      try {
        const method = captures.NAME?.text ?? "";
        if (!method || captures.RECURSE?.text !== method) return false;
        const call = captures.CALL;
        const declaration = call
          ? core.navigator.findParent(call, ["method_declaration"])
          : undefined;
        if (!declaration) return true;
        const stack = [declaration];
        for (let visited = 0; stack.length > 0 && visited < 10_000; visited++) {
          const node = stack.pop();
          if (!node) break;
          // Any conditional or loop construct is a plausible base-case
          // guard (#956 review: while/for-guarded recursion and ternary
          // base cases are common). This errs toward suppressing a
          // blocking diagnostic, never inventing one.
          if (
            node.type === "if_statement" ||
            node.type === "switch_expression" ||
            node.type === "switch_statement" ||
            node.type === "while_statement" ||
            node.type === "do_statement" ||
            node.type === "for_statement" ||
            node.type === "enhanced_for_statement" ||
            node.type === "ternary_expression"
          ) {
            return false;
          }
          stack.push(...(node.children ?? []));
        }
        // Cap exhausted without a verdict: this rule is BLOCKING, so a
        // >10k-node method whose guard sits beyond the budget must not
        // become a silent blocking FP — suppress instead (#956 review;
        // the advisory filters keep their keep-the-diagnostic default).
        return stack.length > 0 ? false : true;
      } catch {
        return true;
      }
    }
    case "memset_for_sensitive_data": {
      try {
        const destination = captures.DEST?.text ?? "";
        const value = captures.VALUE?.text?.trim() ?? "";
        if (!/^(?:0|0x0+|NULL|nullptr)$/.test(value)) return false;
        return /(?:pass(?:word)?|passwd|secret|token|api_?key|private_?key|credential|auth|pin)/i.test(
          destination,
        );
      } catch {
        return true;
      }
    }
    case "unsafe_regex_dynamic_identifier": {
      // unsafe-regex is intentionally a coarse advisory heuristic. When the
      // interpolation is a plain identifier, recover the common safe-before-
      // assignment pattern without pretending to perform whole-program
      // dataflow. #949 review hardening: the LAST write (declarator or
      // assignment) textually BEFORE the use decides — a later reassignment
      // to user input un-suppresses, and an unrelated declaration after the
      // use never suppresses. Initializers come from the "value" field (a
      // type annotation is not an initializer), and bare .replace("a","b")
      // is not escaping — only escape-named callees or .replace(/regex/
      // count. Any internal error keeps the diagnostic: never silently
      // suppress via a filter crash, and a throw here would abort the whole
      // file's batch.
      try {
        const interpolationNode = captures.INTERPOLATION;
        const interpolation = interpolationNode?.text ?? "";
        const identifier = interpolation.match(/^\$\{\s*([A-Za-z_$][\w$]*)\s*\}$/)?.[1];
        if (!identifier || !rootNode || !interpolationNode) return true;
        const useRow = interpolationNode.startPosition.row;

        const hasEscapeSignal = (text: string): boolean =>
          /\b(?:escape|Escape)\w*\s*\(/.test(text) || /\.\s*replace\s*\(\s*\//.test(text);

        // Track the last write to the identifier before the use site.
        let lastWriteRow = -1;
        let lastWriteSafe = false;
        const consider = (row: number, valueText: string | undefined): void => {
          if (row >= useRow || row < lastWriteRow) return;
          lastWriteRow = row;
          lastWriteSafe = valueText !== undefined && hasEscapeSignal(valueText);
        };

        const stack: TreeSitterNode[] = [rootNode];
        while (stack.length > 0) {
          const node = stack.pop();
          if (!node) continue;
          if (node.type === "variable_declarator") {
            const name = node.childForFieldName?.("name");
            if (name?.text === identifier) {
              const initializer = node.childForFieldName?.("value");
              consider(node.startPosition.row, initializer?.text);
            }
          } else if (node.type === "assignment_expression") {
            const left = node.childForFieldName?.("left");
            if (left?.type === "identifier" && left.text === identifier) {
              const right = node.childForFieldName?.("right");
              consider(node.startPosition.row, right?.text);
            }
          }
          stack.push(...node.children);
        }
        return lastWriteRow >= 0 && lastWriteSafe ? false : true;
      } catch {
        return true;
      }
    }
    case "is_generator_with_valued_return": {
      const returnNode = captures.RETURN;
      const functionNode =
        captures.FUNCTION ??
        (returnNode ? core.navigator.findParent(returnNode, ["function_definition"]) : undefined);
      if (!functionNode) return false;
      // In the Python grammar, `async def` is also a function_definition with
      // an anonymous `async` child. Coroutines may return values normally;
      // only synchronous generator functions should be flagged.
      if (hasChildToken(functionNode, "async")) return false;
      return containsYieldInFunctionBody(functionNode);
    }
    case "count_params": {
      const paramsNode = captures.PARAMS;
      if (!paramsNode) return true;
      // Count only truly required params — exclude:
      //   • optional_parameter nodes (foo?: T) if the grammar uses that type
      //   • required_parameter nodes that have a "?" child (same semantic,
      //     different grammar version — web-tree-sitter-typescript collapses
      //     both into required_parameter with a "?" token child)
      //   • params with a default value (text contains "=")
      // biome-ignore lint/suspicious/noExplicitAny: Count parameter nodes
      const paramCount = paramsNode.children.filter((c: any) => {
        if (c.type !== "required_parameter") return false;
        if (c.text.includes("=")) return false;
        // biome-ignore lint/suspicious/noExplicitAny: child node check
        if (c.children?.some((ch: any) => ch.text === "?")) return false;
        return true;
      }).length;
      return paramCount >= (postFilterParams?.min_params ?? 6);
    }
    case "empty_body": {
      const bodyNode = captures.BODY;
      if (!bodyNode) return true;
      // biome-ignore lint/suspicious/noExplicitAny: Check for meaningful statements
      const meaningful = bodyNode.children.filter(
        (c: any) =>
          c.isNamed &&
          c.type !== "comment" &&
          c.type !== "line_comment" &&
          c.type !== "block_comment",
      );
      return meaningful.length === 0;
    }
    case "is_empty_block": {
      // empty-switch-case: keep a `switch_case` that has no body statements.
      // A switch_case's named children are `[value, ...body statements]`
      // (the case's statements are direct children, not a statement_block),
      // so an empty case is one whose only named child is its `case <value>`.
      // An empty case followed by another label is a fall-through group, not
      // a dead case — only the last label of a group carries the body.
      const caseNode = captures.CASE;
      if (!caseNode) return false;
      if (switchCaseBodyStatements(caseNode).length > 0) return false;
      return !nextSiblingIsSwitchLabel(caseNode);
    }
    case "no_break_or_return_in_body": {
      // infinite-loop: keep a `while(true)`/`for(;;)` whose body contains no
      // statement that can terminate the loop (break/return/throw). `continue`
      // does not count — it keeps the loop running.
      const bodyNode = captures.BODY;
      if (!bodyNode) return false;
      return !bodyHasLoopExit(bodyNode, false);
    }
    case "same_param_name": {
      // duplicate-function-arg: keep the pair when the captured binding
      // patterns share any name.
      const first = bindingNames(captures.PARAM1);
      const second = bindingNames(captures.NAME);
      return [...first].some((name) => second.has(name));
    }
    case "no_terminating_statement": {
      // switch-case-termination: keep a non-empty case (already known to be
      // followed by another case via the query) whose last body statement
      // does not terminate, i.e. it falls through. Empty cases are handled
      // by empty-switch-case, so require at least one body statement here.
      // An intentional `// fallthrough` marker suppresses the finding.
      const caseNode = captures.CASE;
      if (!caseNode) return false;
      if (hasFallthroughMarker(caseNode)) return false;
      const body = switchCaseBodyStatements(caseNode);
      if (body.length === 0) return false;
      return !statementTerminates(body[body.length - 1]);
    }
    case "no_break_or_return": {
      // infinite-loop-java: keep a `while(true)`/`for(;;)` whose body has no
      // break/return/throw reachable in this loop's scope.
      const bodyNode = captures.BODY;
      if (!bodyNode) return false;
      return !bodyHasLoopExit(bodyNode, false);
    }
    case "is_double_checked_locking": {
      // no-double-checked-locking: the query pins the if→synchronized→if
      // shape; keep it only when both null-checks test the same field.
      const outer = captures.FIELD?.text;
      const inner = captures.FIELD2?.text;
      return !!outer && outer === inner;
    }
    case "shadows_parent_field": {
      // no-field-shadowing: keep only when the named parent class is
      // declared in the same file and it declares a field with the same
      // name. Cross-file inheritance can't be resolved here — fail closed.
      const parentName = captures.PARENT?.text;
      const fieldName = captures.NAME?.text;
      if (!parentName || !fieldName) return false;
      // biome-ignore lint/suspicious/noExplicitAny: AST traversal
      let root: any = captures.NAME;
      while (root.parent) root = root.parent;
      // biome-ignore lint/suspicious/noExplicitAny: AST traversal
      const stack: any[] = [root];
      while (stack.length) {
        const node = stack.pop();
        if (
          node.type === "class_declaration" &&
          node.childForFieldName?.("name")?.text === parentName
        ) {
          const body = node.childForFieldName?.("body");
          for (const member of body?.children ?? []) {
            if (member.type !== "field_declaration") continue;
            for (const declarator of member.children ?? []) {
              if (
                declarator.type === "variable_declarator" &&
                declarator.childForFieldName?.("name")?.text === fieldName
              ) {
                return true;
              }
            }
          }
        }
        for (const child of node.children ?? []) stack.push(child);
      }
      return false;
    }
    case "missing_break_between_cases": {
      // switch-fall-through: keep when the labeled statement group contains
      // no terminating statement at all — its control flow reaches the next
      // case. The query already requires a following group.
      const label = captures.LABEL;
      const group = label?.parent;
      if (!group) return false;
      const TERMINATORS = new Set([
        "break_statement",
        "return_statement",
        "throw_statement",
        "continue_statement",
        "yield_statement",
      ]);
      for (const child of group.children ?? []) {
        if (TERMINATORS.has(child.type)) return false;
      }
      return true;
    }
    case "scoped_lock_empty_args": {
      // no-scoped-lock-without-args: the query only matches a bare
      // `declarator: (identifier)` — an arg-taking declaration parses as an
      // init/function declarator instead — so a match IS the defect. Keep it
      // as long as the captured declarator has no sibling argument list.
      const decl = captures.DECL;
      if (!decl) return false;
      for (const sibling of decl.parent?.children ?? []) {
        if (sibling.type === "argument_list") return false;
      }
      return true;
    }
    case "calc_missing_spaces": {
      // calc-spacing: keep a calc() whose +/- has an operand directly on
      // both sides (e.g. `100%-20px`). A leading sign after `(` or a comma
      // is legitimate and stays allowed.
      const text = captures.EXPR?.text ?? "";
      return /[\w%)][+-][\w.(]/.test(text);
    }
    case "bare_except_only": {
      const clauseNode = captures.CLAUSE;
      if (!clauseNode) return true;
      // A typed `except` clause has a named child for the exception
      // spec — one of: identifier (e.g. `except ValueError`),
      // attribute (e.g. `except asyncio.TimeoutError` — dotted name),
      // tuple (e.g. `except (E, F)`), as_pattern (e.g. `except E as e`),
      // parenthesized_expression (e.g. `except (E)`), or subscript
      // (e.g. `except dict[str, int]` — #1244, mirrors the ast-grep
      // rule's shape space).
      // Bare `except:` has NO named children (just the `except` keyword,
      // the `:` colon, and the body block).
      // biome-ignore lint/suspicious/noExplicitAny: AST iteration
      const hasExceptionSpec = clauseNode.children.some((c: any) => {
        if (!c.isNamed) return false;
        return c.type !== "block";
      });
      // Fire ONLY when bare (no exception spec)
      return !hasExceptionSpec;
    }
    case "eq_mod_fn": {
      // Belt-and-braces re-check of the #eq? predicates that
      // evaluatePredicates already enforces (clients/tree-sitter/query-search.ts).
      // This filter re-applies the #eq? checks at post_filter time.
      const mod = captures.MOD?.text ?? "";
      const fn = captures.FN?.text ?? "";
      return mod === "threading" && fn === "Thread";
    }
    case "regex_first_arg_identifier": {
      // Belt-and-braces re-check of the #eq?/#match? predicates that
      // evaluatePredicates already enforces, plus the first-argument
      // check that predicates can't express. This post_filter re-applies
      // both predicate checks AND the first-argument check:
      // 1. MOD must be "re"  (would-be #eq? @MOD "re")
      // 2. FUNC must match the regex method pattern (#match? @FUNC ...)
      // 3. First arg must be an identifier (dynamic pattern)
      //    String literals (r"...", "...") are safe static patterns.
      const mod = captures.MOD?.text ?? "";
      if (mod !== "re") return false;
      const func = captures.FUNC?.text ?? "";
      if (!/^(compile|match|search|fullmatch|findall|finditer|sub|subn|split)$/.test(func)) {
        return false;
      }
      const argsNode = captures.ARGS;
      if (!argsNode) return false;
      // biome-ignore lint/suspicious/noExplicitAny: AST iteration
      const firstNamed = (argsNode.children ?? []).find((c: any) => c.isNamed);
      if (!firstNamed) return false;
      return firstNamed.type === "identifier";
    }
    case "open_mode_invalid": {
      const modeNode = captures.MODE;
      if (!modeNode) return false;
      // Python's open() mode accepts: r, w, a, x (basic), b/t/+ (suffix).
      // Strip surrounding quotes from the string literal text.
      const text = modeNode.text ?? "";
      const stripped = text.replace(/^["']|["']$/g, "");
      // Skip empty mode (defaults to 'r')
      if (stripped.length === 0) return false;
      // Skip single-char modes (r/w/a/x — always valid)
      if (stripped.length === 1) return false;
      // Must contain only valid characters
      if (!/^[rwxabt+]+$/.test(stripped)) return true;
      // Multi-char must be exactly: basic + optional (b|t) + optional +
      // Examples valid: "rb", "rb+", "r+", "ab", "rt"
      // Examples invalid: "rwb", "rrr", "rw", "rbb" (no + between r and w is invalid)
      // The "rw" case (basic mode followed by another basic mode without +) is invalid
      // Allow: [basic][bt]?[+]

      const validFileMode = /^[rwax][bt]?\+?$/;

      if (!validFileMode.test(stripped)) return true;
      return false;
    }
    case "status_204_with_value_return": {
      const funcNode = captures.FUNC;
      const valNode = captures.VAL;
      if (!funcNode || !valNode) return false;
      // Only fire if status_code=204
      if (Number(valNode.text ?? 0) !== 204) return false;
      // Walk the function subtree looking for return_statement nodes.
      // Manual BFS because web-tree-sitter doesn't expose
      // descendantsOfType directly.
      // biome-ignore lint/suspicious/noExplicitAny: tree-sitter node iteration
      const queue: any[] = [funcNode];
      while (queue.length > 0) {
        const node = queue.shift();
        if (node.type === "return_statement") {
          // Has a value child (not just the `return` keyword)
          // biome-ignore lint/suspicious/noExplicitAny: child check
          const hasValue = node.children.some((c: any) => c.isNamed && c.type !== "comment");
          if (hasValue) return true;
        }
        // biome-ignore lint/suspicious/noExplicitAny: child queue
        if (node.children) queue.push(...node.children);
      }
      return false;
    }
    case "has_mixed_async": {
      const bodyNode = captures.BODY;
      if (!bodyNode) return true;
      const bodyText = bodyNode.text;
      return bodyText.includes("await") && /\.\s*(then|catch)\s*\(/.test(bodyText);
    }
    case "format_arity_mismatch": {
      const formatNode = captures.FORMAT;
      const argsNode = captures.ARGS;
      if (!formatNode || !argsNode) return false;
      // Strip quotes from format string
      const fmtText = (formatNode.text ?? "").replace(/^["']|["']$/g, "");
      // Don't strip a leading "%" — the format string's contents are
      // intact after stripping only the surrounding quotes. The original
      // code stripped the first "%" thinking it was the operator, but
      // the operator is a separate binary_operator node, not part of
      // the string literal's text.
      const fmt = fmtText;
      // Count placeholders: %s, %d, %f, %(name)s, %i, etc.
      // The simple %s/%d style: each %X counts as 1
      // The %(name)s style: counts as 1 with name
      // The %% escape: doesn't count
      let placeholderCount = 0;
      const namedKeys: string[] = [];
      // biome-ignore lint/suspicious/noExplicitAny: regex match
      const positionalRegex = /%(?:\([^)]+\))?[#0\- +]*\d*(?:\.\d+)?[hlL]?[diouxXeEfFgGcrs%]/g;
      // biome-ignore lint/suspicious/noExplicitAny: regex match
      const positionalMatches = fmt.match(positionalRegex) ?? [];
      for (const m of positionalMatches) {
        if (m === "%%") continue;
        placeholderCount++;
        // biome-ignore lint/suspicious/noExplicitAny: capture group
        const namedMatch = m.match(/^%\(([^)]+)\)/);
        if (namedMatch) namedKeys.push(namedMatch[1]);
      }
      // If format uses named placeholders, RHS should be a dict
      if (namedKeys.length > 0) {
        // Check if dict contains all named keys
        if (argsNode.type === "dictionary") {
          // biome-ignore lint/suspicious/noExplicitAny: AST iteration
          const dictKeys: string[] = [];
          for (const child of argsNode.children ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: child check
            if (child.type === "pair" && child.children?.[0]) {
              // biome-ignore lint/suspicious/noExplicitAny: child text
              // Strip quotes — child is a string literal node,
              // text includes the surrounding "...".
              dictKeys.push((child.children[0].text ?? "").replace(/^["']|["']$/g, ""));
            }
          }
          const missing = namedKeys.filter((k) => !dictKeys.includes(k));
          return missing.length > 0;
        }
        // Format uses named but RHS isn't a dict — definitely wrong
        return true;
      }
      // Positional: count tuple args
      if (argsNode.type === "tuple") {
        const argCount = (argsNode.children ?? []).filter((c: any) => c.isNamed).length;
        if (argCount !== placeholderCount) return true;
      }
      return false;
    }
    case "aws_policy_public": {
      const policyNode = captures.POLICY;
      if (!policyNode) return false;
      const text = policyNode.text ?? "";
      // Match patterns indicating public access
      const patterns = [
        /"Principal"\s*:\s*"\*"/, // direct wildcard
        /"Principal"\s*:\s*\{\s*"AWS"\s*:\s*"\*"\s*\}/, // AWS wildcard
        /"Effect"\s*:\s*"Allow"[\s\S]*?"Action"\s*:\s*"\*"[\s\S]*?"Resource"\s*:\s*"\*"/, // full admin
        /"Principal"\s*:\s*"\*"/,
      ];
      return patterns.some((p) => p.test(text));
    }
    case "slots_attribute_mismatch": {
      const selfNode = captures.SELF;
      const attrNode = captures.ATTR;
      const methodNode = captures.METHOD;
      if (!selfNode || !attrNode || !methodNode) return false;
      // Only consider self.X = (not other.X)
      if (selfNode.text !== "self") return false;
      const attrName = attrNode.text ?? "";
      // Find parent class_definition
      // biome-ignore lint/suspicious/noExplicitAny: AST navigation
      let parent = methodNode.parent;
      while (parent && parent.type !== "class_definition") {
        parent = parent.parent;
      }
      if (!parent) return false;
      // Parse the class's __slots__ list and check if attrName is in it.
      // Fires ONLY when self.X = ... assigns to an attribute NOT in __slots__
      // (a real S8494 violation — the assignment will raise AttributeError).
      const slots = extractSlots(parent);
      // null = no __slots__ declared in this class. [] = __slots__ declared
      // but we couldn't parse it (treat as null to avoid FPs on inner-class
      // parent walks where the parent text mentions __slots__ but the
      // direct children don't contain the assignment).
      if (slots === null || slots.length === 0) return false;
      return !slots.includes(attrName);
    }
    case "special_method_arity": {
      const nameNode = captures.NAME;
      const paramsNode = captures.PARAMS;
      if (!nameNode || !paramsNode) return false;
      const name = nameNode.text ?? "";
      // Expected arities: {method_name: expected_arg_count}
      // (excluding `self`/`cls` which is always 1)

      interface ExpectedValues extends Record<string, number> {}
      const expected: ExpectedValues = {
        __del__: 0,
        __repr__: 0,
        __str__: 0,
        __hash__: 0,
        __bool__: 0,
        __len__: 0,
        __eq__: 1,
        __lt__: 1,
        __le__: 1,
        __gt__: 1,
        __ge__: 1,
        __ne__: 1,
      };
      const expectedCount = expected[name];
      if (expectedCount === undefined) return false; // not in our list
      // Count required params (excluding defaults)
      // biome-ignore lint/suspicious/noExplicitAny: AST iteration
      const paramCount = (paramsNode.children ?? []).filter((c: any) => {
        if (c.type !== "identifier" && c.type !== "typed_parameter") return false;
        if (c.text.includes("=")) return false;
        return true;
      }).length;
      // Expected total = expectedCount + 1 (for self/cls)
      return paramCount !== expectedCount + 1;
    }
    case "no_super_call": {
      const bodyNode = captures.BODY;
      if (!bodyNode) return true;
      return !/(?<!\/\/.*)super\s*\(/.test(bodyNode.text);
    }
    case "in_test_block": {
      const first = Object.values(captures)[0];
      return !!first && core.navigator.isInTestBlock(first);
    }
    case "not_in_test_block": {
      const first = Object.values(captures)[0];
      return !first || !core.navigator.isInTestBlock(first);
    }
    case "not_in_try_catch": {
      const first = Object.values(captures)[0];
      return !first || !core.navigator.isInTryCatch(first);
    }
    case "in_try_catch": {
      const first = Object.values(captures)[0];
      return !!first && core.navigator.isInTryCatch(first);
    }
    case "name_matches_param": {
      const nameNode = captures.NAME;
      const paramNode = captures.PARAM;
      return !!nameNode && !!paramNode && nameNode.text === paramNode.text;
    }
    case "not_in_function": {
      const first = Object.values(captures)[0];
      return (
        !first ||
        !core.navigator.isInside(first, [
          "function_definition",
          "function_declaration",
          "method_definition",
          "arrow_function",
        ])
      );
    }
    case "check_secret_pattern": {
      const varName = captures.VARNAME?.text ?? "";
      const varNameLower = varName.toLowerCase();
      // Skip UPPER_CASE constants — they're module-level constants
      // (e.g. `GITHUB_TYPE_FOR_PERSONAL_API_KEY = "..."`), not secrets.
      // A constant has no lowercase letters in its name.
      if (varName === varName.toUpperCase() && /[A-Z]/.test(varName)) {
        return false;
      }
      return [
        /api[_-]?key/,
        /api[_-]?secret/,
        /password/,
        /passwd/,
        /secret/,
        /token/,
        /auth/,
        /private[_-]?key/,
        /access[_-]?token/,
        /credentials/,
        /aws[_-]?secret/,
        /github[_-]?token/,
        /client[_-]?secret/,
      ].some((p) => p.test(varNameLower));
    }
    case "returns_error": {
      const first = Object.values(captures)[0];
      if (!first) return false;
      const funcNode = core.navigator.findParent(first, [
        "function_declaration",
        "method_declaration",
      ]);
      if (!funcNode) return false;
      const signature =
        String(funcNode.text ?? "")
          .split("{", 1)[0]
          ?.trim() ?? "";
      const returnPart =
        signature.match(/func\s*(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\([^)]*\)\s*(.*)$/s)?.[1]?.trim() ??
        "";
      return returnPart.length > 0 && /\berror\b/.test(returnPart);
    }
    case "python_empty_except": {
      const bodyNode = captures.BODY;
      if (!bodyNode) return true;
      // biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
      return !bodyNode.children.some(
        (c: any) => c.isNamed && c.type !== "pass_statement" && c.type !== "comment",
      );
    }
    case "check_in_operator_types": {
      // `in`/`not in` require __contains__, __iter__ or __getitem__. We can't
      // do real type inference from a bare identifier, so only flag when the
      // right-hand side is a literal of a type known NOT to support
      // containment (None, bool, int, float) — identifiers, strings, lists,
      // dicts, sets, tuples etc. are left alone to avoid false positives.
      const target = captures.TARGET;
      if (!target) return false;
      return ["none", "true", "false", "integer", "float"].includes(target.type);
    }
    case "torchscript_super_call": {
      // The query only anchors on the `super()` call itself (so it can find
      // it at any nesting depth inside the method body); this filter walks
      // back up to confirm the enclosing method OR its class actually carries
      // a @torch.jit.script / @jit.script decorator.
      const call = captures.CALL;
      if (!call) return false;
      const isTorchScriptDecorated = (node: TreeSitterNode | null | undefined): boolean => {
        const decorated = node?.parent;
        if (!decorated || decorated.type !== "decorated_definition") return false;
        // biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
        return (decorated.children ?? []).some(
          (c: any) =>
            c.type === "decorator" && /^@(torch\.jit\.script|jit\.script)$/.test(c.text ?? ""),
        );
      };
      const methodNode = core.navigator.findParent(call, ["function_definition"]);
      if (!methodNode) return false;
      const classNode = core.navigator.findParent(methodNode, ["class_definition"]);
      return isTorchScriptDecorated(methodNode) || isTorchScriptDecorated(classNode);
    }
    case "exit_params_insufficient": {
      // __exit__ must accept (self, exc_type, exc_value, traceback) — 4 named
      // parameters total. The query captures the whole `parameters` node
      // rather than binding each slot individually: tree-sitter's optional
      // (`?`) quantifiers on consecutive anchored siblings match every valid
      // sub-alignment (e.g. self+exc_type alone, or self+exc_type+exc_value),
      // not just the maximal one, so per-slot captures produce spurious
      // duplicate/partial matches for a single, fully-correct signature.
      // Counting named children of the whole node sidesteps that entirely.
      const params = captures.PARAMS;
      if (!params) return true;
      // biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
      const named = (params.children ?? []).filter((c: any) => c.isNamed);
      // `def __exit__(self, *args)` / `(self, *exc_info)` are valid: the splat
      // absorbs the whole exception triple, so it satisfies every remaining
      // slot no matter how few named children the node has.
      if (
        named.some((c) => c.type === "list_splat_pattern" || c.type === "dictionary_splat_pattern")
      ) {
        return false;
      }
      return named.length < 4;
    }
    case "ruby_empty_rescue": {
      const bodyNode = captures.BODY;
      if (!bodyNode) return true;
      // biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
      return !bodyNode.children.some(
        (c: any) => c.isNamed && !["comment", "nil", "nil_literal"].includes(c.type),
      );
    }
    case "ts_command_injection_sink":
      return (
        captures.MOD?.text === "child_process" && /^(exec|execSync)$/.test(captures.FN?.text ?? "")
      );
    case "ts_ssrf_sink": {
      const fn = captures.FN?.text ?? "";
      const obj = captures.OBJ?.text ?? "";
      const urlText = captures.URL?.text ?? "";
      const allowedFns = new Set(["fetch", "request", "get", "post", "put", "patch", "delete"]);
      if (!allowedFns.has(fn)) return false;
      // A bare identifier that provably resolves (in this file) to a
      // `const` initialized with a fixed string/template literal is a
      // genuinely fixed URL — exempt it regardless of naming
      // convention (SCREAMING_SNAKE_CASE proves nothing about
      // provenance; see #963). Anything we cannot definitively prove
      // falls through to the existing broad heuristic below, so
      // member expressions, non-literal consts, reassigned
      // bindings, and unresolved identifiers all keep being
      // evaluated for taint as before — a false positive here is
      // acceptable, a missed SSRF is not.
      if (
        rootNode &&
        captures.URL?.type === "identifier" &&
        resolvesToFileLiteralConst(urlText, rootNode)
      ) {
        return false;
      }
      // `fetch(u.toString())` / `fetch(u.href)` where `u` is a file-local
      // `const u = new URL(<literalPath>, <fixedBase>)`. The origin+path are
      // fully fixed; dynamic query params set later via
      // `u.searchParams.set(...)` don't control the destination. Anything we
      // cannot prove fixed (param/env/member/tainted base) falls through to
      // the broad heuristic and still fires. See #1000.
      if (rootNode && captures.URL) {
        const urlVar = newUrlBaseVarName(captures.URL);
        if (urlVar && resolvesToFixedNewUrlConst(urlVar, rootNode)) {
          return false;
        }
      }
      // Only flag when the URL argument looks like it could carry external
      // input: member expressions (req.url, ctx.query.x) or identifiers
      // whose names suggest user/external provenance. Plain generic names
      // like `url` or `path` in internal download utilities produce too
      // many false positives — those need data-flow analysis to resolve.
      const looksLikeExternalInput =
        urlText.includes(".") ||
        /user|external|remote|input|target|webhook|callback|redirect|untrusted|arbitrary/i.test(
          urlText,
        );
      if (!looksLikeExternalInput) return false;
      if (!obj) return fn === "fetch";
      return new Set(["axios", "http", "https", "got", "request", "superagent", "undici"]).has(obj);
    }
    case "ts_weak_hash_algorithm":
      return captures.FN?.text === "createHash" && /^(md5|sha1)$/i.test(captures.ALG?.text ?? "");
    case "ts_insecure_random_source": {
      if (captures.OBJ?.text !== "Math" || captures.FN?.text !== "random") return false;
      // Only flag when the result flows into a security-sensitive binding.
      // Walk up from the `Math.random()` call so chained forms such as
      // `Math.random().toString(36)` are still attributed to their binding.
      const varName = enclosingBindingName(captures.CALL ?? captures.VAR);
      return /token|secret|password|key|nonce|salt|csrf|auth|session|credential|hash|otp|pin/i.test(
        varName,
      );
    }
    case "ts_detached_async_call":
      return /(Async$|fetch$|request$)/.test(captures.FN?.text ?? "");
    case "incomplete_assertion": {
      const expectNode = captures.EXPECT;
      if (!expectNode) return false;
      const CHAI_PROPERTY_ASSERTIONS = new Set([
        "true",
        "false",
        "null",
        "undefined",
        "empty",
        "NaN",
        "finite",
        "exist",
        "arguments",
        "extensible",
        "sealed",
        "frozen",
        "locked",
      ]);
      // The expect identifier is inside a call_expression. Walk up past that
      // call_expression to the container that determines if it's a complete
      // assertion or an incomplete one.
      let current: TreeSitterNode | null | undefined = expectNode.parent;
      if (!current) return false;
      current = current.parent; // skip the expect(...) call_expression
      if (!current) return false;
      // Bare expect(foo); or return expect(foo);
      if (current.type === "expression_statement" || current.type === "return_statement")
        return true;
      let lastPropertyName: string | null = null;
      while (current && current.type === "member_expression") {
        const propNode = current.children?.find((c: any) => c.type === "property_identifier");
        if (propNode) lastPropertyName = propNode.text;
        const parent: TreeSitterNode | null | undefined = current.parent;
        if (!parent) return false;
        if (parent.type === "expression_statement" || parent.type === "return_statement") {
          if (lastPropertyName && CHAI_PROPERTY_ASSERTIONS.has(lastPropertyName)) return false;
          return true;
        }
        if (parent.type === "call_expression") return false;
        current = parent;
      }
      return false;
    }
    case "py_command_injection_sink": {
      const mod = captures.MOD?.text ?? "";
      const fn = captures.FN?.text ?? "";
      const kw = captures.KW?.text ?? "";
      return (
        (mod === "os" && /^(system|popen)$/.test(fn)) ||
        (mod === "subprocess" &&
          /^(run|Popen|call|check_output|check_call)$/.test(fn) &&
          kw === "shell")
      );
    }
    case "go_command_injection_sink":
      return (
        captures.PKG?.text === "exec" &&
        /^(Command|CommandContext)$/.test(captures.FN?.text ?? "") &&
        /^"(sh|bash|zsh|cmd|powershell|pwsh)"$/.test(captures.SHELL?.text ?? "") &&
        /^"(-c|\/c)"$/.test(captures.FLAG?.text ?? "")
      );
    case "ruby_command_injection_sink":
      return /^(system|exec|spawn|popen|capture3|capture2|capture2e)$/.test(
        captures.FN?.text ?? "",
      );
    case "py_ssrf_sink":
      return (
        captures.MOD?.text === "requests" &&
        /^(get|post|put|patch|delete|request|head|options)$/.test(captures.FN?.text ?? "")
      );
    case "py_path_traversal_sink":
      return /^(open|read_text|read_bytes|write_text|write_bytes|remove|unlink|rmdir)$/.test(
        captures.FN?.text ?? "",
      );
    case "go_path_traversal_sink":
      return (
        /^(os|ioutil)$/.test(captures.PKG?.text ?? "") &&
        /^(Open|OpenFile|ReadFile|WriteFile|Create|Remove|RemoveAll)$/.test(captures.FN?.text ?? "")
      );
    case "py_sql_injection_sink": {
      const fn = captures.FN?.text ?? "";
      if (!new Set(["execute", "executemany", "query", "raw"]).has(fn)) {
        return false;
      }

      const sqlNode = captures.SQL;
      const receiver = captures.OBJ?.text ?? "";

      // SQLAlchemy ORM sessions execute expression objects, not raw SQL
      // strings. `session.execute(stmt)` and `session.execute(select(...))`
      // are parameterized by construction and were too noisy as blockers.
      if (fn === "execute" && isLikelySqlAlchemyReceiver(receiver)) {
        return false;
      }
      if (sqlNode && isSafeSqlAlchemyExpressionCall(sqlNode)) {
        return false;
      }

      return true;
    }
    case "go_sql_injection_sink":
      return (
        /^(Query|QueryContext|QueryRow|QueryRowContext|Exec|ExecContext)$/.test(
          captures.DBFN?.text ?? "",
        ) &&
        captures.FMTPKG?.text === "fmt" &&
        captures.FMTFN?.text === "Sprintf"
      );
    case "py_insecure_deserialization_sink":
      return (
        /^(pickle|yaml)$/.test(captures.MOD?.text ?? "") &&
        /^(load|loads|unsafe_load)$/.test(captures.FN?.text ?? "")
      );
    case "ruby_insecure_deserialization_sink":
      return (
        /^(Marshal|YAML|Psych)$/.test(captures.MOD?.text ?? "") &&
        /^(load|unsafe_load)$/.test(captures.FN?.text ?? "")
      );
    case "match_captures": {
      // Generic filter: each key in postFilterParams is a capture name,
      // value is a regex string. All must match.
      for (const [captureName, pattern] of Object.entries(postFilterParams ?? {})) {
        const node = captures[captureName];
        if (!node) return false;

        // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
        if (!new RegExp(pattern as string).test(node.text)) return false;
      }
      return true;
    }
    case "case_range_single_value": {
      const start = captures.START?.text ?? "";
      const end = captures.END?.text ?? "";
      return start === end;
    }
    case "goto_jumps_backward": {
      const label = captures.LABEL;
      const gotoNode = captures.GOTO;
      if (!label || !gotoNode) return false;
      return label.startIndex < gotoNode.startIndex;
    }
    case "goto_targets_inner_block": {
      const target = captures.TARGET;
      if (!target) return false;
      // A goto targets an inner block if its label is inside a
      // compound_statement that is nested inside another compound_statement.
      let depth = 0;
      let node: TreeSitterNode | null | undefined = target.parent;
      while (node) {
        if (node.type === "compound_statement") depth++;
        node = node.parent;
      }
      return depth >= 2;
    }
    case "c_memset_sensitive_arg": {
      const callNode = captures.CALL;
      if (!callNode || callNode.type !== "call_expression") return false;
      // Find the first argument in the argument_list
      const argList = callNode.children?.find((c: any) => c.type === "argument_list");
      if (!argList) return false;
      // First named child after the opening paren is the first arg
      const firstArg = argList.children?.find((c: any) => c.isNamed);
      if (!firstArg) return false;
      const argName = firstArg.text ?? "";
      return /password|secret|key|token|credential|auth|private|passwd|pin|salt|nonce|iv|seed/i.test(
        argName,
      );
    }
    case "c_stdlib_name": {
      const name = captures.NAME?.text ?? "";
      const STDLIB_NAMES = new Set([
        "malloc",
        "calloc",
        "realloc",
        "free",
        "alloca",
        "printf",
        "fprintf",
        "sprintf",
        "snprintf",
        "vprintf",
        "vfprintf",
        "vsprintf",
        "vsnprintf",
        "scanf",
        "fscanf",
        "sscanf",
        "vscanf",
        "vfscanf",
        "vsscanf",
        "strcpy",
        "strncpy",
        "strcat",
        "strncat",
        "strcmp",
        "strncmp",
        "strlen",
        "strchr",
        "strrchr",
        "strstr",
        "strerror",
        "memcpy",
        "memmove",
        "memset",
        "memcmp",
        "memchr",
        "fopen",
        "fclose",
        "fread",
        "fwrite",
        "fgets",
        "fputs",
        "getc",
        "putc",
        "getchar",
        "putchar",
        "exit",
        "abort",
        "assert",
        "errno",
        "abs",
        "labs",
        "llabs",
        "div",
        "ldiv",
        "lldiv",
        "atoi",
        "atol",
        "atoll",
        "strtol",
        "strtoll",
        "strtoul",
        "strtoull",
        "strtod",
        "strtof",
        "strtold",
        "qsort",
        "bsearch",
        "time",
        "clock",
        "difftime",
        "mktime",
        "strftime",
        "getenv",
        "setenv",
        "putenv",
        "system",
        "isalpha",
        "isdigit",
        "isalnum",
        "isspace",
        "isupper",
        "islower",
        "toupper",
        "tolower",
        "sizeof",
        "offsetof",
        "NULL",
        "EXIT_SUCCESS",
        "EXIT_FAILURE",
      ]);
      return STDLIB_NAMES.has(name);
    }
    case "c_octal_literal": {
      const num = captures.NUM?.text ?? "";
      return /^0[0-7]+$/.test(num);
    }
    case "c_noreturn_attr": {
      const attr = captures.ATTR?.text ?? "";
      return attr === "noreturn";
    }
    case "c_label_in_switch": {
      const stmt = captures.STMT;
      if (!stmt) return false;
      let node: TreeSitterNode | null | undefined = stmt.parent;
      while (node) {
        if (node.type === "switch_statement") return true;
        node = node.parent;
      }
      return false;
    }
    default:
      // A rule whose post_filter has no implementation cannot honour its
      // own definition, so DROP the match instead of reporting every raw
      // structural hit. Failing open here made `duplicate-function-arg`
      // (`same_param_name`, unimplemented) fire on 59 of 60 files that
      // contain no duplicate parameter at all.
      reportMissingPostFilter(core, postFilter);
      return false;
  }
}

/** Keep a failed post-filter match and leave a bounded diagnostic trail. */
function reportPostFilterFailure(
  core: TreeSitterClientInternals,
  postFilter: string,
  reason: string,
): void {
  if (core.reportedPostFilterFailures.has(postFilter)) return;
  core.reportedPostFilterFailures.add(postFilter);
  logTreeSitterDiagnostic({
    subsystem: "tree-sitter-client",
    message:
      `tree-sitter rule post_filter '${postFilter}' failed — ` +
      `keeping the diagnostic (fail-open): ${reason}.`,
    metadata: { postFilter },
  });
}

/** Warn once per unimplemented post_filter — a silent rule needs a trail. */
function reportMissingPostFilter(core: TreeSitterClientInternals, postFilter: string): void {
  if (core.reportedMissingPostFilters.has(postFilter)) return;
  core.reportedMissingPostFilters.add(postFilter);
  logTreeSitterDiagnostic({
    subsystem: "tree-sitter-client",
    message:
      `tree-sitter rule post_filter '${postFilter}' is not implemented — ` +
      `matches for the rules using it are suppressed rather than reported unfiltered. ` +
      `Implement it in applyPostFilter (clients/tree-sitter/post-filters.ts) to re-enable them.`,
    metadata: { postFilter },
  });
}
