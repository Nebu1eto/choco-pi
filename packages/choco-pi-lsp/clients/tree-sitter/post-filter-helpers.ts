import type { TreeSitterNode } from "./shared.ts";

export function hasChildToken(node: TreeSitterNode, token: string): boolean {
  return node.children?.some((child) => child.type === token || child.text === token);
}

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

export function switchCaseBodyStatements(caseNode: TreeSitterNode): TreeSitterNode[] {
  const named = (caseNode.children ?? []).filter(
    (c: any) => c.isNamed && !c.type.includes("comment"),
  );
  return named.slice(1);
}

export function hasFallthroughMarker(caseNode: TreeSitterNode): boolean {
  const comments: TreeSitterNode[] = [];
  const body = switchCaseBodyStatements(caseNode);
  const last = body[body.length - 1];
  const lastEnd = last?.endIndex ?? caseNode.startIndex;
  for (const c of caseNode.children ?? []) {
    if (c.type.includes("comment") && c.startIndex >= lastEnd) {
      comments.push(c);
    }
  }
  const siblings = (caseNode.parent?.children ?? []).filter((c) => c.isNamed);
  const index = siblings.findIndex((c) => c.startIndex === caseNode.startIndex);
  const next = index >= 0 ? siblings[index + 1] : undefined;
  if (next?.type.includes("comment")) comments.push(next);
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
  if (
    t === "statement_block" ||
    t === "else_clause" ||
    t === "catch_clause" ||
    t === "finally_clause"
  ) {
    const inner = (node.children ?? []).filter((c) => c.isNamed && !c.type.includes("comment"));
    const last = inner[inner.length - 1];
    if (!last) return false;
    return statementTerminates(last, depth + 1);
  }
  if (t === "try_statement") {
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
    const named = (node.children ?? []).filter((c) => c.isNamed && !c.type.includes("comment"));
    const consequence = named[1];
    const alternative = named[2];
    if (!consequence || !alternative) return false;
    return (
      statementTerminates(consequence, depth + 1) && statementTerminates(alternative, depth + 1)
    );
  }
  return false;
}

export function nextSiblingIsSwitchLabel(caseNode: TreeSitterNode): boolean {
  const siblings = (caseNode.parent?.children ?? []).filter(
    (c) => c.isNamed && !c.type.includes("comment"),
  );
  const index = siblings.findIndex((c) => c.startIndex === caseNode.startIndex);
  const next = index >= 0 ? siblings[index + 1] : undefined;
  return next?.type === "switch_case" || next?.type === "switch_default";
}

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

export function resolvesToFileLiteralConst(name: string, rootNode: TreeSitterNode): boolean {
  const valueNode = resolveFileConstValueNode(name, rootNode);
  if (!valueNode) return false;
  return isFixedUrlLiteralExpr(valueNode);
}

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

  if (hasNonConstBinding || hasReassignment || constDeclarators.length !== 1) {
    return null;
  }
  return constDeclarators[0].childForFieldName?.("value") ?? null;
}

function isFixedUrlLiteralExpr(node: TreeSitterNode): boolean {
  if (node.type === "string") return true;
  if (node.type === "template_string") {
    return !(node.children ?? []).some((c) => c.type === "template_substitution");
  }
  return false;
}

function isImportedBinding(name: string, rootNode: TreeSitterNode): boolean {
  return importedAs(name, rootNode) !== null;
}

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
      for (const c of node.children ?? []) {
        if (c.type === "identifier" && c.text === name) return name;
      }
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  return null;
}

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

function isFixedBaseIdentifier(ident: TreeSitterNode, rootNode: TreeSitterNode): boolean {
  const name = ident.text;
  if (!isShadowedByEnclosingParam(ident, name) && resolvesToFileLiteralConst(name, rootNode)) {
    return true;
  }
  return isImportedBinding(name, rootNode);
}

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
      const bare = current.childForFieldName?.("parameter");
      if (bare?.type === "identifier" && bare.text === name) return true;
      const params = current.childForFieldName?.("parameters");
      if (params && paramsBindName(params, name)) return true;
    }
    current = current.parent;
  }
  return false;
}

function paramsBindName(params: TreeSitterNode, name: string): boolean {
  for (const param of params.children ?? []) {
    if (!param.isNamed) continue;
    const pattern =
      param.type === "required_parameter" || param.type === "optional_parameter"
        ? param.childForFieldName?.("pattern")
        : param;
    if (pattern && patternBindsName(pattern, name)) return true;
  }
  return false;
}

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
      const left = n.childForFieldName?.("left") ?? n.children?.[0];
      if (left) stack.push(left);
      continue;
    }
    for (const c of n.children ?? []) stack.push(c);
  }
  return false;
}

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
  if (!isFixedUrlLiteralExpr(args[0])) return false;
  if (args.length === 1) return true;
  return isFixedUrlBaseExpr(args[1], rootNode);
}

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
