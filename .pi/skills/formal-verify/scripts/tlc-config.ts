// Reads the parts of a TLC model config (.cfg) that the wrapper controls:
// INVARIANT, PROPERTY and CHECK_DEADLOCK. Every other section is kept as the
// user wrote it, so TLC itself remains the parser of CONSTANT values and the
// rest of the grammar. Anything ambiguous in the controlled sections is an
// error rather than a guess.

const KEYWORDS: ReadonlySet<string> = new Set([
  "CONSTANT",
  "CONSTANTS",
  "CONSTRAINT",
  "CONSTRAINTS",
  "ACTION_CONSTRAINT",
  "ACTION_CONSTRAINTS",
  "INVARIANT",
  "INVARIANTS",
  "INIT",
  "NEXT",
  "VIEW",
  "SYMMETRY",
  "SPECIFICATION",
  "PROPERTY",
  "PROPERTIES",
  "TYPE",
  "TYPE_CONSTRAINT",
  "ALIAS",
  "POSTCONDITION",
  "CHECK_DEADLOCK",
]);

type Token = { text: string; start: number; end: number };

export type ModelConfig = {
  /** The config with the INVARIANT, PROPERTY and CHECK_DEADLOCK sections removed. */
  kept: string;
  invariants: string[];
  properties: string[];
  /** The CHECK_DEADLOCK value the config sets, if any. */
  checkDeadlock: boolean | undefined;
  /** True when the config declares its own CONSTRAINT or ACTION_CONSTRAINT. */
  constrained: boolean;
};

export class ConfigError extends Error {}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (/\s/.test(c)) {
      i++;
    } else if (text.startsWith("\\*", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
    } else if (text.startsWith("(*", i)) {
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        if (text.startsWith("(*", j)) {
          depth++;
          j++;
        } else if (text.startsWith("*)", j)) {
          depth--;
          j++;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) throw new ConfigError("the config has an unclosed (* comment");
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text.charAt(j) !== '"'; j++) if (text.charAt(j) === "\\") j++;
      if (j >= text.length) throw new ConfigError("the config has an unclosed string");
      tokens.push({ text: text.slice(i, j + 1), start: i, end: j + 1 });
      i = j + 1;
    } else if (/\w/.test(c)) {
      let j = i;
      while (j < text.length && /\w/.test(text.charAt(j))) j++;
      tokens.push({ text: text.slice(i, j), start: i, end: j });
      i = j;
    } else {
      tokens.push({ text: c, start: i, end: i + 1 });
      i++;
    }
  }
  return tokens;
}

const NAME = /^\w*[A-Za-z]\w*$/;

export function readModelConfig(text: string): ModelConfig {
  if (text.charCodeAt(0) === 0xfeff)
    throw new ConfigError("the config starts with a byte-order mark");
  const tokens = tokenize(text);
  const sections: { keyword: string; start: number; items: Token[] }[] = [];
  for (const token of tokens) {
    if (KEYWORDS.has(token.text))
      sections.push({ keyword: token.text, start: token.start, items: [] });
    else {
      const current = sections.at(-1);
      if (!current) throw new ConfigError(`the config starts with "${token.text}", not a keyword`);
      current.items.push(token);
    }
  }
  const invariants: string[] = [];
  const properties: string[] = [];
  let checkDeadlock: boolean | undefined;
  let constrained = false;
  const removed: [number, number][] = [];
  sections.forEach((section, k) => {
    const end = sections[k + 1]?.start ?? text.length;
    const names = () => {
      if (section.items.length === 0)
        throw new ConfigError(`${section.keyword} in the config names nothing`);
      const out: string[] = [];
      for (const item of section.items) {
        if (!NAME.test(item.text))
          throw new ConfigError(
            `${section.keyword} in the config contains "${item.text}"; list operator names separated by spaces`,
          );
        out.push(item.text);
      }
      return out;
    };
    switch (section.keyword) {
      case "INVARIANT":
      case "INVARIANTS":
        invariants.push(...names());
        removed.push([section.start, end]);
        break;
      case "PROPERTY":
      case "PROPERTIES":
        properties.push(...names());
        removed.push([section.start, end]);
        break;
      case "CHECK_DEADLOCK": {
        const value = section.items.length === 1 ? section.items[0]?.text : undefined;
        if (value !== "TRUE" && value !== "FALSE")
          throw new ConfigError("CHECK_DEADLOCK in the config must be followed by TRUE or FALSE");
        if (checkDeadlock !== undefined)
          throw new ConfigError("the config sets CHECK_DEADLOCK more than once");
        checkDeadlock = value === "TRUE";
        removed.push([section.start, end]);
        break;
      }
      case "CONSTRAINT":
      case "CONSTRAINTS":
      case "ACTION_CONSTRAINT":
      case "ACTION_CONSTRAINTS":
        constrained = true;
        break;
    }
  });
  for (const list of [invariants, properties]) {
    const seen = new Set<string>();
    for (const name of list) {
      if (seen.has(name)) throw new ConfigError(`the config lists ${name} twice`);
      seen.add(name);
    }
  }
  let kept = "";
  let from = 0;
  for (const [start, end] of removed) {
    kept += text.slice(from, start);
    from = end;
  }
  kept += text.slice(from);
  return { kept, invariants, properties, checkDeadlock, constrained };
}

/** The config TLC runs: the kept sections plus the rules and constraint chosen for one run. */
export function runConfig(
  config: ModelConfig,
  invariants: readonly string[],
  properties: readonly string[],
  boundConstraint: string,
): string {
  const lines = [config.kept.trimEnd(), ""];
  if (invariants.length) lines.push(`INVARIANT ${invariants.join(" ")}`);
  if (properties.length) lines.push(`PROPERTY ${properties.join(" ")}`);
  lines.push(`CONSTRAINT ${boundConstraint}`, "");
  return lines.join("\n");
}
