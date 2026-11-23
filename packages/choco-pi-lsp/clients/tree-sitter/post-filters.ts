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

export function applyPostFilter(
  core: TreeSitterClientInternals,
  postFilter: string,
  postFilterParams: any,
  captures: Record<string, TreeSitterNode>,
  rootNode?: TreeSitterNode,
): boolean {
  function extractSlots(classNode: any): string[] | null {
    const classText = classNode.text ?? "";
    if (!classText.includes("__slots__")) return null;
    const body = classNode.children?.find((c: any) => c.type === "block");
    if (!body) return null;
    const slots: string[] = [];
    for (const stmt of body.children ?? []) {
      if (stmt.type !== "expression_statement") continue;
      const assignment = stmt.children?.find((c: any) => c.type === "assignment");
      if (!assignment) continue;
      const lhsText = (assignment.children?.[0]?.text ?? "").trim();
      if (lhsText !== "__slots__") continue;
      const rhs = assignment.children?.[2];
      if (!rhs) continue;
      if (rhs.type === "string") {
        const s = (rhs.text ?? "").replace(/^["']|["']$/g, "");
        if (s) slots.push(s);
      } else if (rhs.type === "tuple" || rhs.type === "list") {
        for (const el of rhs.children ?? []) {
          if (!el.isNamed) continue;
          if (el.type === "string") {
            slots.push((el.text ?? "").replace(/^["']|["']$/g, ""));
          }
        }
      }
      break;
    }
    return slots;
  }

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  switch (postFilter) {
    case "no_nested_anchor_chain": {
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
        const scope =
          core.navigator.findParent(declaration, [
            "method_declaration",
            "constructor_declaration",
            "block",
          ]) ?? rootNode;
        if (!scope) return true;
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
      try {
        const interpolationNode = captures.INTERPOLATION;
        const interpolation = interpolationNode?.text ?? "";
        const identifier = interpolation.match(/^\$\{\s*([A-Za-z_$][\w$]*)\s*\}$/)?.[1];
        if (!identifier || !rootNode || !interpolationNode) return true;
        const useRow = interpolationNode.startPosition.row;

        const hasEscapeSignal = (text: string): boolean =>
          /\b(?:escape|Escape)\w*\s*\(/.test(text) || /\.\s*replace\s*\(\s*\//.test(text);

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
      if (hasChildToken(functionNode, "async")) return false;
      return containsYieldInFunctionBody(functionNode);
    }
    case "count_params": {
      const paramsNode = captures.PARAMS;
      if (!paramsNode) return true;
      const paramCount = paramsNode.children.filter((c: any) => {
        if (c.type !== "required_parameter") return false;
        if (c.text.includes("=")) return false;
        if (c.children?.some((ch: any) => ch.text === "?")) return false;
        return true;
      }).length;
      return paramCount >= (postFilterParams?.min_params ?? 6);
    }
    case "empty_body": {
      const bodyNode = captures.BODY;
      if (!bodyNode) return true;
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
      const caseNode = captures.CASE;
      if (!caseNode) return false;
      if (switchCaseBodyStatements(caseNode).length > 0) return false;
      return !nextSiblingIsSwitchLabel(caseNode);
    }
    case "no_break_or_return_in_body": {
      const bodyNode = captures.BODY;
      if (!bodyNode) return false;
      return !bodyHasLoopExit(bodyNode, false);
    }
    case "same_param_name": {
      const first = bindingNames(captures.PARAM1);
      const second = bindingNames(captures.NAME);
      return [...first].some((name) => second.has(name));
    }
    case "no_terminating_statement": {
      const caseNode = captures.CASE;
      if (!caseNode) return false;
      if (hasFallthroughMarker(caseNode)) return false;
      const body = switchCaseBodyStatements(caseNode);
      if (body.length === 0) return false;
      return !statementTerminates(body[body.length - 1]);
    }
    case "no_break_or_return": {
      const bodyNode = captures.BODY;
      if (!bodyNode) return false;
      return !bodyHasLoopExit(bodyNode, false);
    }
    case "is_double_checked_locking": {
      const outer = captures.FIELD?.text;
      const inner = captures.FIELD2?.text;
      return !!outer && outer === inner;
    }
    case "shadows_parent_field": {
      const parentName = captures.PARENT?.text;
      const fieldName = captures.NAME?.text;
      if (!parentName || !fieldName) return false;
      let root: any = captures.NAME;
      while (root.parent) root = root.parent;
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
      const decl = captures.DECL;
      if (!decl) return false;
      for (const sibling of decl.parent?.children ?? []) {
        if (sibling.type === "argument_list") return false;
      }
      return true;
    }
    case "calc_missing_spaces": {
      const text = captures.EXPR?.text ?? "";
      return /[\w%)][+-][\w.(]/.test(text);
    }
    case "bare_except_only": {
      const clauseNode = captures.CLAUSE;
      if (!clauseNode) return true;
      const hasExceptionSpec = clauseNode.children.some((c: any) => {
        if (!c.isNamed) return false;
        return c.type !== "block";
      });
      return !hasExceptionSpec;
    }
    case "eq_mod_fn": {
      const mod = captures.MOD?.text ?? "";
      const fn = captures.FN?.text ?? "";
      return mod === "threading" && fn === "Thread";
    }
    case "regex_first_arg_identifier": {
      const mod = captures.MOD?.text ?? "";
      if (mod !== "re") return false;
      const func = captures.FUNC?.text ?? "";
      if (!/^(compile|match|search|fullmatch|findall|finditer|sub|subn|split)$/.test(func)) {
        return false;
      }
      const argsNode = captures.ARGS;
      if (!argsNode) return false;
      const firstNamed = (argsNode.children ?? []).find((c: any) => c.isNamed);
      if (!firstNamed) return false;
      return firstNamed.type === "identifier";
    }
    case "open_mode_invalid": {
      const modeNode = captures.MODE;
      if (!modeNode) return false;
      const text = modeNode.text ?? "";
      const stripped = text.replace(/^["']|["']$/g, "");
      if (stripped.length === 0) return false;
      if (stripped.length === 1) return false;
      if (!/^[rwxabt+]+$/.test(stripped)) return true;

      const validFileMode = /^[rwax][bt]?\+?$/;

      if (!validFileMode.test(stripped)) return true;
      return false;
    }
    case "status_204_with_value_return": {
      const funcNode = captures.FUNC;
      const valNode = captures.VAL;
      if (!funcNode || !valNode) return false;
      if (Number(valNode.text ?? 0) !== 204) return false;
      const queue: any[] = [funcNode];
      while (queue.length > 0) {
        const node = queue.shift();
        if (node.type === "return_statement") {
          const hasValue = node.children.some((c: any) => c.isNamed && c.type !== "comment");
          if (hasValue) return true;
        }
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
      const fmtText = (formatNode.text ?? "").replace(/^["']|["']$/g, "");
      const fmt = fmtText;
      let placeholderCount = 0;
      const namedKeys: string[] = [];
      const positionalRegex = /%(?:\([^)]+\))?[#0\- +]*\d*(?:\.\d+)?[hlL]?[diouxXeEfFgGcrs%]/g;
      const positionalMatches = fmt.match(positionalRegex) ?? [];
      for (const m of positionalMatches) {
        if (m === "%%") continue;
        placeholderCount++;
        const namedMatch = m.match(/^%\(([^)]+)\)/);
        if (namedMatch) namedKeys.push(namedMatch[1]);
      }
      if (namedKeys.length > 0) {
        if (argsNode.type === "dictionary") {
          const dictKeys: string[] = [];
          for (const child of argsNode.children ?? []) {
            if (child.type === "pair" && child.children?.[0]) {
              dictKeys.push((child.children[0].text ?? "").replace(/^["']|["']$/g, ""));
            }
          }
          const missing = namedKeys.filter((k) => !dictKeys.includes(k));
          return missing.length > 0;
        }
        return true;
      }
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
      const patterns = [
        /"Principal"\s*:\s*"\*"/,
        /"Principal"\s*:\s*\{\s*"AWS"\s*:\s*"\*"\s*\}/,
        /"Effect"\s*:\s*"Allow"[\s\S]*?"Action"\s*:\s*"\*"[\s\S]*?"Resource"\s*:\s*"\*"/,
        /"Principal"\s*:\s*"\*"/,
      ];
      return patterns.some((p) => p.test(text));
    }
    case "slots_attribute_mismatch": {
      const selfNode = captures.SELF;
      const attrNode = captures.ATTR;
      const methodNode = captures.METHOD;
      if (!selfNode || !attrNode || !methodNode) return false;
      if (selfNode.text !== "self") return false;
      const attrName = attrNode.text ?? "";
      let parent = methodNode.parent;
      while (parent && parent.type !== "class_definition") {
        parent = parent.parent;
      }
      if (!parent) return false;
      const slots = extractSlots(parent);
      if (slots === null || slots.length === 0) return false;
      return !slots.includes(attrName);
    }
    case "special_method_arity": {
      const nameNode = captures.NAME;
      const paramsNode = captures.PARAMS;
      if (!nameNode || !paramsNode) return false;
      const name = nameNode.text ?? "";

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
      if (expectedCount === undefined) return false;
      const paramCount = (paramsNode.children ?? []).filter((c: any) => {
        if (c.type !== "identifier" && c.type !== "typed_parameter") return false;
        if (c.text.includes("=")) return false;
        return true;
      }).length;
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
      return !bodyNode.children.some(
        (c: any) => c.isNamed && c.type !== "pass_statement" && c.type !== "comment",
      );
    }
    case "check_in_operator_types": {
      const target = captures.TARGET;
      if (!target) return false;
      return ["none", "true", "false", "integer", "float"].includes(target.type);
    }
    case "torchscript_super_call": {
      const call = captures.CALL;
      if (!call) return false;
      const isTorchScriptDecorated = (node: TreeSitterNode | null | undefined): boolean => {
        const decorated = node?.parent;
        if (!decorated || decorated.type !== "decorated_definition") return false;
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
      const params = captures.PARAMS;
      if (!params) return true;
      const named = (params.children ?? []).filter((c: any) => c.isNamed);
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
      if (
        rootNode &&
        captures.URL?.type === "identifier" &&
        resolvesToFileLiteralConst(urlText, rootNode)
      ) {
        return false;
      }
      if (rootNode && captures.URL) {
        const urlVar = newUrlBaseVarName(captures.URL);
        if (urlVar && resolvesToFixedNewUrlConst(urlVar, rootNode)) {
          return false;
        }
      }
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
      let current: TreeSitterNode | null | undefined = expectNode.parent;
      if (!current) return false;
      current = current.parent;
      if (!current) return false;
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
      const argList = callNode.children?.find((c: any) => c.type === "argument_list");
      if (!argList) return false;
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
      reportMissingPostFilter(core, postFilter);
      return false;
  }
}

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
