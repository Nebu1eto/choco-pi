import { hasRuntimeType } from "../parsing.ts";

const EDITABLE_REF_EVIDENCE_KEYS = [
  "editable",
  "contentEditable",
  "contenteditable",
  "isContentEditable",
] as const;
const EDITABLE_FALSE_TEXT_PATTERN = /\b(?:contenteditable|editable)\s*=\s*["']?(?:false|0)["']?/i;
const EDITABLE_ASSIGNMENT_TEXT_PATTERN =
  /\b(contenteditable|editable)\s*=\s*("[^"]*"|'[^']*'|[^\s,\]]+)/gi;
const EDITABLE_BARE_TEXT_PATTERN = /\b(?:contenteditable|editable)\b(?!\s*=)/i;

function parseEditableEvidenceValue<Value>(value: Value): boolean | undefined {
  if (hasRuntimeType(value, "boolean")) return value;
  if (hasRuntimeType(value, "number")) {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (!hasRuntimeType(value, "string")) return undefined;
  const normalized = value
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  if (["false", "0", "no"].includes(normalized)) return false;
  if (["", "true", "1", "yes", "plaintext-only"].includes(normalized)) return true;
  return undefined;
}

function stripLeadingSnapshotAccessibleName(text: string): string {
  return text.replace(/^(\s*[-*]\s+\S+\s+)(?:"[^"]*"|'[^']*')/, "$1");
}

function parseEditableEvidenceText(text: string | undefined): boolean | undefined {
  if (!text) return undefined;
  const markerText = stripLeadingSnapshotAccessibleName(text);
  if (EDITABLE_FALSE_TEXT_PATTERN.test(markerText)) return false;
  let hasPositiveAssignment = false;
  for (const match of markerText.matchAll(EDITABLE_ASSIGNMENT_TEXT_PATTERN)) {
    const key = match[1]?.toLowerCase();
    const evidence = parseEditableEvidenceValue(match[2]);
    if (evidence === false) return false;
    if (evidence === true && (key === "contenteditable" || key === "editable")) {
      hasPositiveAssignment = true;
    }
  }
  if (hasPositiveAssignment) return true;
  return EDITABLE_BARE_TEXT_PATTERN.test(markerText) ? true : undefined;
}

export function getEditableRefEvidence<Value>(options: {
  ref?: Record<string, Value>;
  text?: string;
}): boolean | undefined {
  let hasPositiveEvidence = false;
  if (options.ref) {
    for (const key of EDITABLE_REF_EVIDENCE_KEYS) {
      const evidence = parseEditableEvidenceValue(options.ref[key]);
      if (evidence === false) return false;
      if (evidence === true) hasPositiveEvidence = true;
    }
  }
  const textEvidence = parseEditableEvidenceText(options.text);
  if (textEvidence === false) return false;
  if (textEvidence === true) hasPositiveEvidence = true;
  return hasPositiveEvidence ? true : undefined;
}
