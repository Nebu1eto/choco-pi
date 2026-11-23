import type { FactProvider } from "../fact-provider-types.ts";
import { isJstsFactFile } from "../../file-kinds.ts";
import { findOwnerName } from "../../symbol-containment.ts";
import { extractFactsFromTree, firstChildOfType, type TsNode, walk } from "./tree-sitter-facts.ts";

const BOUNDARY_PREFIXES = ["fetch", "fs.", "db.", "http", "axios", "got", "req.", "res."];

export interface MemberCallSite {
  receiver: string;
  method: string;
}

export interface FunctionSummary {
  name: string;
  line: number;
  column: number;
  endLine?: number;
  isAsync: boolean;
  hasAwait: boolean;
  hasReturnAwaitCall: boolean;
  statementCount: number;
  parameterCount: number;
  isPassThroughWrapper: boolean;
  passThroughTarget?: string;
  isBoundaryWrapper: boolean;
  hasExplicitPromiseReturnType?: boolean;
  cyclomaticComplexity: number;
  maxNestingDepth: number;
  outgoingCalls: string[];
  owner?: string;
  memberCallSites?: MemberCallSite[];
  receiverTypes?: Record<string, string>;
}

const FUNCTION_TYPES = new Set([
  "function_declaration",
  "method_definition",
  "function_expression",
  "arrow_function",
]);

const COMPLEXITY_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "catch_clause",
  "ternary_expression",
]);

const NESTING_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "try_statement",
]);

const LOGICAL_OPERATORS = new Set(["&&", "||", "??"]);

function namedChildren(node: TsNode): TsNode[] {
  return (node.children ?? []).filter((c: TsNode) => c && c.isNamed && c.type !== "comment");
}

function firstNamedChild(node: TsNode): TsNode | undefined {
  return namedChildren(node)[0];
}

function getBody(node: TsNode): TsNode | undefined {
  return firstChildOfType(node, "statement_block");
}

function getParameters(node: TsNode): TsNode[] {
  const fp = firstChildOfType(node, "formal_parameters");
  if (!fp) return [];
  return (fp.children ?? []).filter(
    (c: TsNode) =>
      c &&
      (c.type === "identifier" ||
        c.type === "required_parameter" ||
        c.type === "optional_parameter" ||
        c.type === "rest_pattern" ||
        c.type === "assignment_pattern" ||
        c.type === "object_pattern" ||
        c.type === "array_pattern"),
  );
}

function parameterName(param: TsNode): string {
  return param.type === "identifier" ? param.text : (firstNamedChild(param)?.text ?? "");
}

function getFunctionName(node: TsNode): string {
  if (node.type === "function_declaration") {
    return firstChildOfType(node, "identifier")?.text ?? "<anonymous>";
  }
  if (node.type === "method_definition") {
    const kids = node.children ?? [];
    const paramsIdx = kids.findIndex((c: TsNode) => c?.type === "formal_parameters");
    for (let i = paramsIdx - 1; i >= 0; i -= 1) {
      const t = kids[i]?.type;
      if (
        t === "property_identifier" ||
        t === "private_property_identifier" ||
        t === "computed_property_name" ||
        t === "string" ||
        t === "number"
      ) {
        return kids[i].text;
      }
    }
    return "<anonymous>";
  }
  if (node.type === "arrow_function" || node.type === "function_expression") {
    const parent = node.parent;
    if (parent?.type === "variable_declarator") {
      const id = firstChildOfType(parent, "identifier");
      if (id) return id.text;
    } else if (parent?.type === "pair") {
      const key = (parent.children ?? [])[0];
      if (key) return key.text;
    }
    return "<anonymous>";
  }
  return "<unknown>";
}

interface PassThroughResult {
  pass: boolean;
  target?: string;
}

function isCallPassThrough(stmt: TsNode, paramNames: string[]): PassThroughResult {
  if (stmt.type !== "return_statement") return { pass: false };
  const expr = firstNamedChild(stmt);
  if (!expr || expr.type !== "call_expression") return { pass: false };

  const argsNode = firstChildOfType(expr, "arguments");
  const args = argsNode ? namedChildren(argsNode).map((a) => a.text) : [];
  if (args.length !== paramNames.length) return { pass: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== paramNames[i]) return { pass: false };
  }
  return { pass: true, target: (expr.children ?? [])[0]?.text };
}

function calcCyclomaticComplexity(body: TsNode): number {
  let cc = 1;
  walk(body, (node) => {
    if (COMPLEXITY_TYPES.has(node.type)) {
      cc++;
    } else if (node.type === "binary_expression") {
      if ((node.children ?? []).some((c: TsNode) => LOGICAL_OPERATORS.has(c?.type))) {
        cc++;
      }
    }
  });
  return cc;
}

function calcMaxNestingDepth(body: TsNode): number {
  let maxDepth = 0;
  const walkDepth = (node: TsNode, depth: number): void => {
    if (depth > maxDepth) maxDepth = depth;
    const next = NESTING_TYPES.has(node.type) ? depth + 1 : depth;
    for (const child of node.children ?? []) {
      if (child) walkDepth(child, next);
    }
  };
  for (const child of body.children ?? []) {
    if (child) walkDepth(child, 0);
  }
  return maxDepth;
}

function collectOutgoingCalls(body: TsNode): string[] {
  const calls = new Set<string>();
  walk(body, (node) => {
    if (node.type === "call_expression") {
      const callee = (node.children ?? [])[0]?.text ?? "";
      if (callee.length < 80) calls.add(callee);
    }
  });
  return [...calls];
}

function collectMemberCallSites(body: TsNode): MemberCallSite[] {
  const sites: MemberCallSite[] = [];
  walk(body, (node) => {
    if (node.type !== "call_expression") return;
    const callee = (node.children ?? [])[0];
    if (!callee || callee.type !== "member_expression") return;
    const object = (callee.children ?? [])[0];
    const property = (callee.children ?? []).find((c: TsNode) => c?.type === "property_identifier");
    if (!object || object.type !== "identifier" || !property) return;
    sites.push({ receiver: object.text, method: property.text });
  });
  return sites;
}

interface ReceiverTypes {
  [receiver: string]: string;
}

function collectReceiverTypes(body: TsNode, params: TsNode[]): ReceiverTypes {
  const types: ReceiverTypes = {};
  for (const param of params) {
    const id = firstNamedChild(param);
    if (!id || id.type !== "identifier") continue;
    const typeAnnotation = (param.children ?? []).find(
      (c: TsNode) => c?.type === "type_annotation",
    );
    const typeId = typeAnnotation ? firstChildOfType(typeAnnotation, "type_identifier") : undefined;
    if (typeId) types[id.text] = typeId.text;
  }
  walk(body, (node) => {
    if (node.type !== "variable_declarator") return;
    const id = firstChildOfType(node, "identifier");
    if (!id) return;
    const value = (node.children ?? []).find((c: TsNode) => c?.type === "new_expression");
    if (!value) return;
    const ctor = firstNamedChild(value);
    if (ctor?.type === "identifier") types[id.text] = ctor.text;
  });
  return types;
}

function hasExplicitPromiseReturnType(node: TsNode): boolean {
  const returnType = firstChildOfType(node, "type_annotation");
  if (!returnType) return false;
  return /:\s*Promise\b/.test(returnType.text);
}

function hasAwaitInNode(node: TsNode): boolean {
  let found = false;
  walk(node, (n) => {
    if (n.type === "await_expression") found = true;
  });
  return found;
}

function hasReturnAwaitCall(node: TsNode): boolean {
  let found = false;
  walk(node, (n) => {
    if (n.type !== "return_statement") return;
    const ret = firstNamedChild(n);
    if (ret?.type !== "await_expression") return;
    const awaited = firstNamedChild(ret);
    if (awaited?.type === "call_expression") found = true;
  });
  return found;
}

export const functionFactProvider: FactProvider = {
  id: "fact.file.functions",
  provides: ["file.functionSummaries", "file.functionFactsCoverage"],
  requires: ["file.content"],
  appliesTo(ctx) {
    return isJstsFactFile(ctx.filePath);
  },
  async run(ctx, store) {
    await extractFactsFromTree(
      ctx,
      store,
      { "file.functionSummaries": [] },
      (root) => {
        const summaries: FunctionSummary[] = [];
        const containers: { name: string; startLine: number; endLine: number }[] = [];

        const addSummary = (node: TsNode): void => {
          const body = getBody(node);
          if (!body) return;

          const params = getParameters(node);
          const paramNames = params.map(parameterName);
          const statements = namedChildren(body);
          const statementCount = statements.length;

          const passThrough =
            statementCount === 1
              ? isCallPassThrough(statements[0], paramNames)
              : { pass: false as const };
          const target = passThrough.target ?? "";
          const lowerTarget = target.toLowerCase();
          const isBoundaryWrapper = BOUNDARY_PREFIXES.some((prefix) =>
            lowerTarget.startsWith(prefix),
          );

          summaries.push({
            name: getFunctionName(node),
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
            endLine: body.endPosition.row + 1,
            isAsync: Boolean(firstChildOfType(node, "async")),
            hasAwait: hasAwaitInNode(body),
            hasReturnAwaitCall: hasReturnAwaitCall(body),
            statementCount,
            parameterCount: params.length,
            isPassThroughWrapper: passThrough.pass,
            passThroughTarget: passThrough.target,
            isBoundaryWrapper,
            hasExplicitPromiseReturnType: hasExplicitPromiseReturnType(node),
            cyclomaticComplexity: calcCyclomaticComplexity(body),
            maxNestingDepth: calcMaxNestingDepth(body),
            outgoingCalls: collectOutgoingCalls(body),
            memberCallSites: collectMemberCallSites(body),
            receiverTypes: collectReceiverTypes(body, params),
          });
        };

        walk(root, (node) => {
          if (FUNCTION_TYPES.has(node.type)) addSummary(node);
          if (node.type === "class_declaration" || node.type === "interface_declaration") {
            const nameNode =
              firstChildOfType(node, "type_identifier") ?? firstChildOfType(node, "identifier");
            if (nameNode) {
              containers.push({
                name: nameNode.text,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
              });
            }
          }
        });

        for (const summary of summaries) {
          const owner = findOwnerName(containers, summary.line, summary.endLine ?? summary.line);
          if (owner) summary.owner = owner;
        }

        return { "file.functionSummaries": summaries };
      },
      "file.functionFactsCoverage",
    );
  },
};
