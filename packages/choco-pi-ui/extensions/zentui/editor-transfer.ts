import { type BoundaryValue, isCallable, isString } from "./runtime-values";
export type EditorComponentFactory = (...args: never[]) => BoundaryValue;

export type EditorTransferUi<Factory = EditorComponentFactory> = {
  getEditorText?: () => BoundaryValue;
  setEditorText?: (text: string) => void;
  setEditorComponent?: (factory: Factory | undefined) => void;
  getEditorComponent?: () => Factory | undefined;
};

export type EditorTransferFailureReason =
  | "unsupported-transfer-api"
  | "editor-factory-snapshot-failed"
  | "editor-text-snapshot-failed"
  | "editor-text-preparation-failed"
  | "editor-replacement-failed-with-rollback"
  | "editor-replacement-rollback-failed";

export type EditorTransferResult =
  | { ok: true }
  | { ok: false; reason: EditorTransferFailureReason };

/**
 * Prepare the active editor's public expanded text before Pi replaces its factory.
 * This intentionally transfers prompt contents only; editor-private state is never inspected.
 */
export function replaceEditorComponentWithExpandedText<Factory>(
  ui: EditorTransferUi<Factory>,
  factory: Factory | undefined,
): EditorTransferResult {
  if (
    !isCallable(ui.getEditorText) ||
    !isCallable(ui.setEditorText) ||
    !isCallable(ui.setEditorComponent) ||
    !isCallable(ui.getEditorComponent)
  ) {
    return { ok: false, reason: "unsupported-transfer-api" };
  }

  let previousFactory: Factory | undefined;
  try {
    previousFactory = ui.getEditorComponent();
  } catch {
    return { ok: false, reason: "editor-factory-snapshot-failed" };
  }

  let expandedText: BoundaryValue;
  try {
    expandedText = ui.getEditorText();
  } catch {
    return { ok: false, reason: "editor-text-snapshot-failed" };
  }
  if (!isString(expandedText)) {
    return { ok: false, reason: "editor-text-snapshot-failed" };
  }

  try {
    ui.setEditorText(expandedText);
  } catch {
    return { ok: false, reason: "editor-text-preparation-failed" };
  }

  try {
    ui.setEditorComponent(factory);
  } catch {
    try {
      ui.setEditorComponent(previousFactory);
      return { ok: false, reason: "editor-replacement-failed-with-rollback" };
    } catch {
      return { ok: false, reason: "editor-replacement-rollback-failed" };
    }
  }
  return { ok: true };
}
