import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type TreeNode = {
  /** Display label for this node */
  label: string | Component;
  /** Style function for this node's label. Overrides Tree default. */
  labelStyle?: (text: string) => string;
  /** Child nodes */
  children?: TreeNode[];
};

export type TreeOptions = {
  /** Root nodes */
  nodes: TreeNode[];
  /** Style for guide lines (├──, └──, │). Default: dim */
  guideStyle?: (text: string) => string;
  /** Default style for node labels. Overridden per-node by TreeNode.labelStyle. Default: passthrough */
  labelStyle?: (text: string) => string;
  /** Whether to show root-level connectors (├──/└──). Default: false */
  rootConnectors?: boolean;
  /** Suffix appended to nodes that have children. Default: "/" */
  dirSuffix?: string;
};

/**
 * Tree component — renders nested TreeNode data with box-drawing characters.
 *
 * This is a **pure render component**. It has no internal expand/collapse
 * or selection state. Callers manage what nodes are visible by providing
 * already-expanded/sliced tree data.
 *
 * Guide chars (├──, └──, │) are rendered in guideStyle.
 * Each node's label is rendered in its own labelStyle (or the tree default).
 * Long labels are word-wrapped, with continuation lines indented to
 * align with the label start.
 */
export class Tree implements Component {
  private nodes: TreeNode[];
  private guideStyle: (text: string) => string;
  private labelStyle: (text: string) => string;
  private rootConnectors: boolean;
  private dirSuffix: string;

  constructor(options: TreeOptions) {
    this.nodes = options.nodes;
    this.guideStyle =
      options.guideStyle ?? ((t: string) => `\x1b[2m${t}\x1b[0m`);
    this.labelStyle = options.labelStyle ?? ((t: string) => t);
    this.rootConnectors = options.rootConnectors ?? false;
    this.dirSuffix = options.dirSuffix ?? "/";
  }

  setNodes(nodes: TreeNode[]): void {
    this.nodes = nodes;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];

    for (const [i, node] of this.nodes.entries()) {
      const isLast = i === this.nodes.length - 1;

      if (this.rootConnectors) {
        renderChild(
          node,
          isLast,
          [],
          width,
          this.guideStyle,
          this.labelStyle,
          this.dirSuffix,
          lines,
        );
      } else {
        renderRoot(
          node,
          width,
          this.guideStyle,
          this.labelStyle,
          this.dirSuffix,
          lines,
        );
      }
    }

    return lines;
  }
}

/** Render a root node (no connector prefix). */
function renderRoot(
  node: TreeNode,
  width: number,
  guideStyle: (t: string) => string,
  defaultLabelStyle: (t: string) => string,
  dirSuffix: string,
  lines: string[],
): void {
  const hasChildren = node.children && node.children.length > 0;
  const labelStr = resolveLabel(node.label, width);
  const label = hasChildren ? `${labelStr}${dirSuffix}` : labelStr;
  const styleFn = node.labelStyle ?? defaultLabelStyle;

  const wrapped = wrapTextWithAnsi(label, width);
  for (const line of wrapped) {
    lines.push(styleFn(line));
  }

  if (!node.children || node.children.length === 0) return;

  for (const [i, child] of node.children.entries()) {
    const isLast = i === node.children.length - 1;
    renderChild(
      child,
      isLast,
      [],
      width,
      guideStyle,
      defaultLabelStyle,
      dirSuffix,
      lines,
    );
  }
}

/**
 * Render a child node with a connector prefix.
 * `ancestorBars` tracks whether each ancestor level has a continuation bar (│).
 */
function renderChild(
  node: TreeNode,
  isLast: boolean,
  ancestorBars: boolean[],
  width: number,
  guideStyle: (t: string) => string,
  defaultLabelStyle: (t: string) => string,
  dirSuffix: string,
  lines: string[],
): void {
  // Build prefix: ancestor continuation bars + connector
  let prefix = "";
  for (const hasBar of ancestorBars) {
    prefix += hasBar ? "│   " : "    ";
  }
  prefix += isLast ? "└── " : "├── ";

  const hasChildren = node.children && node.children.length > 0;
  const labelStr = resolveLabel(node.label, width);
  const label = hasChildren ? `${labelStr}${dirSuffix}` : labelStr;
  const styleFn = node.labelStyle ?? defaultLabelStyle;

  const prefixVisible = visibleWidth(prefix);
  const available = Math.max(1, width - prefixVisible);

  // Wrap the label, then indent continuation lines to align with label start
  const wrapIndent = " ".repeat(prefixVisible);
  const wrapped = wrapTextWithAnsi(label, available);

  for (const [i, line] of wrapped.entries()) {
    if (i === 0) {
      lines.push(`${guideStyle(prefix)}${styleFn(line)}`);
    } else {
      lines.push(`${wrapIndent}${styleFn(line)}`);
    }
  }

  if (!node.children || node.children.length === 0) return;

  const childBars = [...ancestorBars, !isLast];

  for (const [i, child] of node.children.entries()) {
    const childIsLast = i === node.children.length - 1;
    renderChild(
      child,
      childIsLast,
      childBars,
      width,
      guideStyle,
      defaultLabelStyle,
      dirSuffix,
      lines,
    );
  }
}

/** Resolve a string | Component label to a string. */
function resolveLabel(label: string | Component, width: number): string {
  if (typeof label === "string") return label;
  return label.render(width).join(" ");
}
