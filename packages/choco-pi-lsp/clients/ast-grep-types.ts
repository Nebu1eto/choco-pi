export interface RuleDescription {
  id: string;
  message: string;
  note?: string;
  fix?: string;
  severity: "error" | "warning" | "info" | "hint";
  grade?: number;
}

export interface SgMatch {
  file: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  text: string;
  replacement?: string;
}

export interface SgResult {
  matches: SgMatch[];
  error?: string;
}

interface AstGrepMetaVarNode {
  text: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

export interface AstGrepMatch {
  file: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  text: string;
  lines?: string;
  language?: string;
  replacement?: string;
  metaVariables?: {
    single: Record<string, AstGrepMetaVarNode>;
    multi: Record<string, AstGrepMetaVarNode[]>;
    transformed: Record<string, string>;
  };
  labels?: Array<{
    range: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
  }>;
}

export interface AstGrepDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  rule: string;
  ruleDescription?: RuleDescription;
  file: string;
  fix?: string;
  note?: string;
}

export interface AstGrepJsonDiagnostic {
  ruleId: string;
  severity: string;
  message: string;
  note?: string;
  labels: Array<{
    text: string;
    range: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
    file?: string;
    style: string;
  }>;
  Message?: { text: string };
  Severity?: string;
  spans?: Array<{
    context: string;
    range: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
    file: string;
  }>;
  name?: string;
}
