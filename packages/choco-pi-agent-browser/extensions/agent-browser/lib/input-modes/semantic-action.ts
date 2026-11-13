import {
  type CompilationResult,
  getSelectValues,
  isInputRecord,
  isNonEmptyString,
  isOneOf,
  isString,
} from "./shared.ts";
import {
  AGENT_BROWSER_SEMANTIC_ACTIONS,
  AGENT_BROWSER_SEMANTIC_LOCATORS,
  type CompiledAgentBrowserSemanticAction,
} from "./types.ts";

export function getCompiledSemanticActionCommandIndex(
  compiled: CompiledAgentBrowserSemanticAction,
): number {
  return compiled.args[0] === "--session" ? 2 : 0;
}

export function getCompiledSemanticActionSessionPrefix(
  compiled: CompiledAgentBrowserSemanticAction,
): string[] {
  const commandIndex = getCompiledSemanticActionCommandIndex(compiled);
  return commandIndex > 0 ? compiled.args.slice(0, commandIndex) : [];
}

export function isCompiledSemanticActionFindCommand(
  compiled: CompiledAgentBrowserSemanticAction | undefined,
): boolean {
  if (!compiled || compiled.action === "select") return false;
  return compiled.args[getCompiledSemanticActionCommandIndex(compiled)] === "find";
}

export function compileAgentBrowserSemanticAction<Input>(
  input: Input,
): CompilationResult<CompiledAgentBrowserSemanticAction> {
  if (!isInputRecord(input)) {
    return { error: "semantic_action must be an object." };
  }
  const action = input.action;
  const locator = input.locator;
  const value = input.value;
  const values = input.values;
  const selector = input.selector;
  const text = input.text;
  const role = input.role;
  const rawName = input.name;
  const name = isString(rawName) && rawName.trim().length === 0 ? undefined : rawName;
  const session = input.session;
  if (!isOneOf(action, AGENT_BROWSER_SEMANTIC_ACTIONS)) {
    return {
      error: `semantic_action.action must be one of: ${AGENT_BROWSER_SEMANTIC_ACTIONS.join(", ")}.`,
    };
  }
  if (session !== undefined && !isNonEmptyString(session)) {
    return { error: "semantic_action.session must be a non-empty string when provided." };
  }
  const sessionPrefix = isString(session) ? ["--session", session] : [];
  if (action === "select") {
    if (text !== undefined) {
      return {
        error:
          "semantic_action.text is not supported for select; use value or values for option values.",
      };
    }
    if (isNonEmptyString(selector)) {
      if (locator !== undefined || role !== undefined || name !== undefined) {
        return {
          error:
            "semantic_action.selector cannot be combined with locator, role, or name for select; use selector plus value/values, or locator fields plus values.",
        };
      }
      const selectedValues = getSelectValues(input, "semantic_action");
      if ("error" in selectedValues) return { error: selectedValues.error };
      const args = [...sessionPrefix, "select", selector, ...selectedValues.values];
      return { compiled: { action: "select", selector, values: selectedValues.values, args } };
    }
    if (selector !== undefined) {
      return { error: "semantic_action.selector must be a non-empty string when provided." };
    }
    if (locator === undefined) {
      return {
        error: "semantic_action.selector or semantic_action.locator is required for select.",
      };
    }
    if (locator !== "role" && locator !== "label") {
      return {
        error:
          "semantic_action select locator must be role or label; use selector plus value/values for other targets.",
      };
    }
    if (locator === "role") {
      if (!isString(role) || !/^(?:combobox|listbox)$/i.test(role)) {
        return {
          error: "semantic_action.role must be combobox or listbox for locator=role select.",
        };
      }
      if (!isNonEmptyString(name)) {
        return { error: "semantic_action.name is required for locator=role select." };
      }
      const optionValues = getSelectValues({ value, values }, "semantic_action");
      if ("error" in optionValues) return { error: optionValues.error };
      const args = [
        ...sessionPrefix,
        "find",
        "role",
        role,
        "select",
        ...optionValues.values,
        "--name",
        name,
      ];
      return { compiled: { action: "select", locator: "role", values: optionValues.values, args } };
    }
    if (!isNonEmptyString(value)) {
      return {
        error: "semantic_action.value must be the accessible label text for locator=label select.",
      };
    }
    if (role !== undefined || name !== undefined) {
      return { error: "semantic_action.role and name are only supported for locator=role select." };
    }
    const optionValues = getSelectValues({ values }, "semantic_action");
    if ("error" in optionValues) {
      return {
        error: optionValues.error.includes("required")
          ? "semantic_action.values is required for locator=label select (value is the label text)."
          : optionValues.error,
      };
    }
    const args = [...sessionPrefix, "find", "label", value, "select", ...optionValues.values];
    return { compiled: { action: "select", locator: "label", values: optionValues.values, args } };
  }
  if (values !== undefined) {
    return { error: "semantic_action.values is only supported for select actions." };
  }
  if (selector !== undefined) {
    if (!isNonEmptyString(selector)) {
      return { error: "semantic_action.selector must be a non-empty string when provided." };
    }
    if (locator !== undefined || value !== undefined || role !== undefined || name !== undefined) {
      return {
        error:
          "semantic_action.selector cannot be combined with locator, value, role, or name; use selector for a direct click/check/fill target or locator fields for find-based actions.",
      };
    }
    if (text !== undefined && !isString(text)) {
      return { error: "semantic_action.text must be a string when provided." };
    }
    if (action === "fill" && (!isString(text) || text.length === 0)) {
      return { error: `semantic_action.text is required for ${action}.` };
    }
    if (action !== "fill" && text !== undefined) {
      return { error: "semantic_action.text is only supported for fill actions." };
    }
    const directArgs = [...sessionPrefix, action, selector];
    if (action === "fill" && isString(text)) directArgs.push(text);
    return { compiled: { action, selector, args: directArgs } };
  }
  if (!isOneOf(locator, AGENT_BROWSER_SEMANTIC_LOCATORS)) {
    return {
      error: `semantic_action.locator must be one of: ${AGENT_BROWSER_SEMANTIC_LOCATORS.join(", ")}.`,
    };
  }
  if (value !== undefined && !isNonEmptyString(value)) {
    return { error: "semantic_action.value must be a non-empty string when provided." };
  }
  if (role !== undefined && !isNonEmptyString(role)) {
    return { error: "semantic_action.role must be a non-empty string when provided." };
  }
  const locatorValue = locator === "role" && isString(role) ? role : value;
  if (!isNonEmptyString(locatorValue)) {
    return {
      error:
        locator === "role"
          ? "semantic_action.value or semantic_action.role must be a non-empty string for locator=role."
          : "semantic_action.value must be a non-empty string.",
    };
  }
  if (text !== undefined && !isString(text)) {
    return { error: "semantic_action.text must be a string when provided." };
  }
  if (action === "fill" && (!isString(text) || text.length === 0)) {
    return { error: `semantic_action.text is required for ${action}.` };
  }
  if (action !== "fill" && text !== undefined) {
    return { error: "semantic_action.text is only supported for fill actions." };
  }
  if (role !== undefined && locator !== "role") {
    return { error: "semantic_action.role is only supported for locator=role." };
  }
  if (role !== undefined && value !== undefined && role !== value) {
    return {
      error: "semantic_action.role must match value when both are provided for locator=role.",
    };
  }
  if (name !== undefined && (locator !== "role" || !isNonEmptyString(name))) {
    return {
      error: "semantic_action.name is only supported as a non-empty string for locator=role.",
    };
  }
  const args = [...sessionPrefix, "find", locator, locatorValue, action];
  if (action === "fill" && isString(text)) {
    args.push(text);
  }
  if (locator === "role" && isString(name)) {
    args.push("--name", name);
  }
  return { compiled: { action, locator, args } };
}
