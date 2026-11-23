export type ASTNode = any;

export interface ScopeContext {
  isTestBlock: boolean;
  isLoop: boolean;
  isAsync: boolean;
  functionDepth: number;
  scopeChain: string[];
}

export class TreeSitterNavigator {
  findParent(node: ASTNode, type: string | string[]): ASTNode | null {
    let current = node.parent;
    const types = Array.isArray(type) ? type : [type];

    while (current) {
      if (types.includes(current.type)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  isInside(node: ASTNode, type: string | string[]): boolean {
    return this.findParent(node, type) !== null;
  }

  getAncestors(node: ASTNode): ASTNode[] {
    const ancestors: ASTNode[] = [];
    let current = node.parent;

    while (current) {
      ancestors.push(current);
      current = current.parent;
    }

    return ancestors;
  }

  isInTestBlock(node: ASTNode): boolean {
    const testPatterns = ["call_expression"];

    let current = node.parent;
    while (current) {
      if (testPatterns.includes(current.type)) {
        const callName = this.getCallName(current);
        if (
          callName &&
          /^\b(it|describe|test|before|after|beforeEach|afterEach)\b/.test(callName)
        ) {
          return true;
        }
      }
      current = current.parent;
    }
    return false;
  }

  getCallName(node: ASTNode): string | null {
    if (node.type !== "call_expression") return null;

    const func = node.children[0];
    if (!func) return null;

    if (func.type === "identifier") {
      return func.text;
    }

    if (func.type === "member_expression") {
      const parts: string[] = [];
      for (const child of func.children) {
        if (child.type === "identifier" || child.type === "property_identifier") {
          parts.push(child.text);
        }
      }
      return parts.join(".");
    }

    return null;
  }

  isInTryCatch(node: ASTNode): boolean {
    return this.isInside(node, ["try_statement", "begin", "rescue"]);
  }

  isInLoop(node: ASTNode): boolean {
    return this.isInside(node, [
      "for_statement",
      "while_statement",
      "do_statement",
      "for_in_statement",
      "for_of_statement",
    ]);
  }

  isInAsyncContext(node: ASTNode): boolean {
    const functionTypes = [
      "function_declaration",
      "function_expression",
      "arrow_function",
      "method_definition",
    ];

    let current = node.parent;
    while (current) {
      if (functionTypes.includes(current.type)) {
        if (current.children?.some((c: ASTNode) => c.text === "async")) {
          return true;
        }
      }
      current = current.parent;
    }
    return false;
  }

  getScopeChain(node: ASTNode): string[] {
    const chain: string[] = [];
    let current = node.parent;

    while (current) {
      if (
        [
          "function_declaration",
          "function_expression",
          "arrow_function",
          "method_definition",
          "block",
          "statement_block",
        ].includes(current.type)
      ) {
        const name = this.getNodeName(current);
        if (name) {
          chain.push(name);
        } else {
          chain.push(`<${current.type}>`);
        }
      }
      current = current.parent;
    }

    return chain;
  }

  getNodeName(node: ASTNode): string | null {
    for (const child of node.children || []) {
      if (child.type === "identifier" && child.isNamed) {
        return child.text;
      }
    }

    if (node.type === "method_definition") {
      const nameNode = node.children?.find((c: ASTNode) => c.type === "property_identifier");
      return nameNode?.text || null;
    }

    return null;
  }

  isShadowed(node: ASTNode, varName: string): boolean {
    let current = node.parent;

    while (current) {
      if (["variable_declaration", "lexical_declaration"].includes(current.type)) {
        const declarator = current.children?.find((c: ASTNode) => c.type === "variable_declarator");
        if (declarator) {
          const idNode = declarator.children?.find((c: ASTNode) => c.type === "identifier");
          if (idNode?.text === varName) {
            return true;
          }
        }
      }

      if (
        [
          "function_declaration",
          "function_expression",
          "arrow_function",
          "method_definition",
        ].includes(current.type)
      ) {
        const params = current.children?.find((c: ASTNode) => c.type === "formal_parameters");
        if (params) {
          for (const param of params.children || []) {
            if (param.type === "identifier" && param.text === varName) {
              return true;
            }
          }
        }
      }

      current = current.parent;
    }

    return false;
  }

  getScopeContext(node: ASTNode): ScopeContext {
    const ancestors = this.getAncestors(node);
    const functionDepth = ancestors.filter((a) =>
      [
        "function_declaration",
        "function_expression",
        "arrow_function",
        "method_definition",
      ].includes(a.type),
    ).length;

    return {
      isTestBlock: this.isInTestBlock(node),
      isLoop: this.isInLoop(node),
      isAsync: this.isInAsyncContext(node),
      functionDepth,
      scopeChain: this.getScopeChain(node),
    };
  }

  getSiblings(node: ASTNode): ASTNode[] {
    if (!node.parent) return [];
    return node.parent.children?.filter((c: ASTNode) => c !== node) || [];
  }

  getPreviousSibling(node: ASTNode): ASTNode | null {
    if (!node.parent) return null;
    const siblings = node.parent.children || [];
    const index = siblings.indexOf(node);
    if (index > 0) {
      return siblings[index - 1];
    }
    return null;
  }

  getNextSibling(node: ASTNode): ASTNode | null {
    if (!node.parent) return null;
    const siblings = node.parent.children || [];
    const index = siblings.indexOf(node);
    if (index >= 0 && index < siblings.length - 1) {
      return siblings[index + 1];
    }
    return null;
  }
}
