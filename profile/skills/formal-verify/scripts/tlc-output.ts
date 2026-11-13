// Parsers for TLC's `-tool` message output.
//
// Ported from pstack's `statechart` skill by Lauren Tan, MIT licence
// (Copyright (c) 2026 Lauren Tan; full text in ../THIRD_PARTY.md). Sources:
// - readMessages, textOf, messageState: skills/statechart/scripts/frontends/messages.ts
// - parseState: skills/statechart/scripts/frontends/dot.ts
// - readBreak: skills/statechart/scripts/frontends/verdict.ts
// - readTrace: skills/statechart/scripts/frontends/trace.ts
// - parseValue and its tokenizer: skills/statechart/scripts/frontends/value.ts
// - message codes and the Value type: skills/statechart/scripts/ir.ts
//
// Changes from the original: lines and messages are a tagged union instead of
// `string | Message`; input is one string instead of a synchronous file-descriptor
// generator; an unterminated message is reported instead of returned as a
// partial result; trace steps keep TLC's state numbers and a raw fallback for
// values the parser cannot read; run statistics and the TLC version are read
// here as well.

export type TlaValue =
  | boolean
  | number
  | string
  | { kind: "model"; name: string }
  | { kind: "set"; members: TlaValue[] }
  | { kind: "interval"; lo: number; hi: number }
  | {
      kind: "function";
      printedAs: "tuple" | "record" | "pairs";
      keys: TlaValue[];
      values: TlaValue[];
    };

/** A state variable's value: structured when the parser can read it, else TLC's text. */
export type StateValue = TlaValue | { kind: "raw"; text: string };

export type TlcState = Record<string, StateValue>;

export type TlcLine = { kind: "line"; text: string };
export type TlcMessage = { kind: "message"; code: number; level: number; body: TlcPart[] };
export type TlcPart = TlcLine | TlcMessage;

export const EC = {
  TLC_INVARIANT_VIOLATED_INITIAL: 2107,
  TLC_PROPERTY_VIOLATED_INITIAL: 2108,
  TLC_INVARIANT_VIOLATED_BEHAVIOR: 2110,
  TLC_ACTION_PROPERTY_VIOLATED_BEHAVIOR: 2112,
  TLC_DEADLOCK_REACHED: 2114,
  TLC_TEMPORAL_PROPERTY_VIOLATED: 2116,
  TLC_BEHAVIOR_UP_TO_THIS_POINT: 2121,
  TLC_BACK_TO_STATE: 2122,
  TLC_FINISHED: 2186,
  TLC_INIT_GENERATED1: 2190,
  TLC_INIT_GENERATED2: 2191,
  TLC_SUCCESS: 2193,
  TLC_SEARCH_DEPTH: 2194,
  TLC_STATS: 2199,
  TLC_STATE_PRINT2: 2217,
  TLC_STATE_PRINT3: 2218,
  TLC_VERSION: 2262,
  TLC_COUNTER_EXAMPLE: 2264,
} as const;

export const LEVEL = { NONE: 0, ERROR: 1, TLCBUG: 2, WARNING: 3, STATE: 4 } as const;

/** Error-level codes that belong to a reported violation rather than a failure of the run. */
const VIOLATION_CODES: ReadonlySet<number> = new Set([
  EC.TLC_INVARIANT_VIOLATED_INITIAL,
  EC.TLC_PROPERTY_VIOLATED_INITIAL,
  EC.TLC_INVARIANT_VIOLATED_BEHAVIOR,
  EC.TLC_ACTION_PROPERTY_VIOLATED_BEHAVIOR,
  EC.TLC_DEADLOCK_REACHED,
  EC.TLC_TEMPORAL_PROPERTY_VIOLATED,
  EC.TLC_BEHAVIOR_UP_TO_THIS_POINT,
  EC.TLC_COUNTER_EXAMPLE,
]);

// ---------------------------------------------------------------------------
// Messages (messages.ts)

const START = /@!@!@STARTMSG (\d+):(\d+) @!@!@$/;
const END = /^@!@!@ENDMSG (\d+) @!@!@$/;
const MARKER = /@!@!@/;
const MAX_LEVEL = 4;

export type TlcMessages = {
  parts: TlcPart[];
  /**
   * Why the framing is invalid, or undefined when it is valid. Valid framing is a flat
   * sequence: each STARTMSG is closed by an ENDMSG with the same code before the next
   * STARTMSG, levels are 0-4, and no other line contains a marker. Output that ends
   * inside a message is malformed too, since the run's output was cut.
   */
  malformed: string | undefined;
};

/**
 * Splits TLC's `-tool` output into lines and messages. Parsing stops at the first
 * framing error, so a caller can never act on messages read past a malformed one.
 */
export function readMessages(output: string): TlcMessages {
  const parts: TlcPart[] = [];
  let open: TlcMessage | undefined;
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const bad = (lineNumber: number, why: string): TlcMessages => ({
    parts,
    malformed: `TLC output line ${lineNumber}: ${why}`,
  });
  for (const [i, line] of lines.entries()) {
    const start = START.exec(line);
    const end = END.exec(line);
    if (start) {
      if (open) return bad(i + 1, `message ${start[1]} starts inside message ${open.code}`);
      const before = line.slice(0, start.index);
      if (MARKER.test(before)) return bad(i + 1, "two markers on one line");
      if (before) parts.push({ kind: "line", text: before });
      const level = Number(start[2]);
      if (level > MAX_LEVEL) return bad(i + 1, `message ${start[1]} has unknown level ${level}`);
      open = { kind: "message", code: Number(start[1]), level, body: [] };
    } else if (end) {
      if (!open) return bad(i + 1, `ENDMSG ${end[1]} closes no message`);
      if (Number(end[1]) !== open.code)
        return bad(i + 1, `ENDMSG ${end[1]} closes message ${open.code}`);
      parts.push(open);
      open = undefined;
    } else if (MARKER.test(line)) {
      return bad(i + 1, "unrecognised message marker");
    } else if (open) {
      open.body.push({ kind: "line", text: line });
    } else {
      parts.push({ kind: "line", text: line });
    }
  }
  if (open) return bad(lines.length, `output ends inside message ${open.code}`);
  return { parts, malformed: undefined };
}

export function textOf(message: TlcMessage): string {
  const lines: string[] = [];
  for (const part of message.body) if (part.kind === "line") lines.push(part.text);
  return lines.join("\n");
}

export function* messagesIn(parts: Iterable<TlcPart>): Generator<TlcMessage> {
  for (const part of parts) if (part.kind === "message") yield part;
}

// ---------------------------------------------------------------------------
// TLA+ values (value.ts)

const BRACKET = new Int8Array(128);
for (const c of "<{[(") BRACKET[c.charCodeAt(0)] = 1;
for (const c of ">}])") BRACKET[c.charCodeAt(0)] = -1;
const PUNCT = new Map([
  [60, "<<"],
  [62, ">>"],
  [124, "|->"],
  [58, ":>"],
  [64, "@@"],
  [46, ".."],
]);
const SPACE = /\s/;
const isSpace = (c: number) =>
  c === 32 || (c >= 9 && c <= 13) || (c > 127 && SPACE.test(String.fromCharCode(c)));
const isDigit = (c: number) => c >= 48 && c <= 57;
const isWord = (c: number) =>
  isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isLineEnd = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

function tokenEnd(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c === 34) {
    for (let j = i + 1; j < s.length; j++) {
      const d = s.charCodeAt(j);
      if (d === 34) return j + 1;
      if (d === 92) {
        j++;
        if (j >= s.length || isLineEnd(s.charCodeAt(j))) return -1;
      }
    }
    return -1;
  }
  const punct = PUNCT.get(c);
  if (punct) return s.startsWith(punct, i) ? i + punct.length : -1;
  if ((c < 128 && BRACKET[c] !== 0) || c === 44) return i + 1;
  let j = i + 1;
  if (c === 45 || isDigit(c)) {
    while (isDigit(s.charCodeAt(j))) j++;
    return c === 45 && j === i + 1 ? -1 : j;
  }
  if (!isWord(c)) return -1;
  while (isWord(s.charCodeAt(j))) j++;
  return j;
}

const unreadable = (text: string, pos: number) =>
  new Error(`cannot read TLA+ value at "${text.slice(pos, pos + 20)}"`);

const INT = /^-?\d+$/;
const NAME = /^\w*[A-Za-z]\w*$/;
const UNESCAPED = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["f", "\f"],
]);

/** Parses one TLA+ value as TLC prints it. Throws on anything it does not recognise. */
export function parseValue(text: string): TlaValue {
  const tokens: string[] = [];
  const starts: number[] = [];
  for (let pos = 0; ;) {
    while (pos < text.length && isSpace(text.charCodeAt(pos))) pos++;
    if (pos === text.length) break;
    const end = tokenEnd(text, pos);
    if (end === -1) throw unreadable(text, pos);
    tokens.push(text.slice(pos, end));
    starts.push(pos);
    pos = end;
  }
  let i = 0;
  const fail = (): never => {
    throw unreadable(text, i < starts.length ? (starts[Math.max(i - 1, 0)] ?? 0) : text.length);
  };
  const next = (): string => {
    const token = tokens[i];
    if (token === undefined) return fail();
    i++;
    return token;
  };
  const eat = (expected: string) => {
    if (next() !== expected) fail();
  };
  const items = <T>(close: string, item: () => T): T[] => {
    const out: T[] = [];
    if (tokens[i] === close) {
      i++;
      return out;
    }
    for (;;) {
      out.push(item());
      const t = next();
      if (t === close) return out;
      if (t !== ",") fail();
    }
  };
  const string = (t: string): string => {
    let s = "";
    for (let j = 1, from = 1; ;) {
      const k = t.indexOf("\\", j);
      if (k === -1 || k >= t.length - 1) return s + t.slice(from, -1);
      const c = UNESCAPED.get(t.charAt(k + 1));
      if (c === undefined) return fail();
      s += t.slice(from, k) + c;
      j = from = k + 2;
    }
  };
  const value = (): TlaValue => {
    const t = next();
    switch (t) {
      case "TRUE":
        return true;
      case "FALSE":
        return false;
      case "{":
        return { kind: "set", members: items("}", value) };
      case "<<": {
        const values = items(">>", value);
        const keys: TlaValue[] = [];
        for (let k = 1; k <= values.length; k++) keys.push(k);
        return { kind: "function", printedAs: "tuple", keys, values };
      }
      case "[": {
        const keys: TlaValue[] = [];
        const values: TlaValue[] = [];
        items("]", () => {
          const name = next();
          if (!NAME.test(name)) fail();
          eat("|->");
          keys.push(name);
          values.push(value());
        });
        return { kind: "function", printedAs: "record", keys, values };
      }
      case "(": {
        const keys: TlaValue[] = [];
        const values: TlaValue[] = [];
        do {
          keys.push(value());
          eat(":>");
          values.push(value());
        } while (next() === "@@");
        if (tokens[i - 1] !== ")") fail();
        return { kind: "function", printedAs: "pairs", keys, values };
      }
    }
    if (t.charCodeAt(0) === 34) return string(t);
    if (INT.test(t)) {
      if (tokens[i] !== "..") return Number(t);
      i++;
      const hi = next();
      if (!INT.test(hi)) fail();
      return { kind: "interval", lo: Number(t), hi: Number(hi) };
    }
    if (NAME.test(t)) return { kind: "model", name: t };
    return fail();
  };
  const out = value();
  if (i < tokens.length) {
    i++;
    fail();
  }
  return out;
}

// ---------------------------------------------------------------------------
// States (dot.ts parseState, messages.ts messageState)

const STATE_LINE = /^(\w+)\s*=\s*([\s\S]*)$/;

/**
 * Parses a state printed as `/\ x = 1\n/\ y = 2` (or `x = 1` for one variable).
 * Throws when the text is not a list of `name = value` pairs; a value the
 * value parser cannot read is kept as raw text.
 */
export function parseState(text: string) {
  const entries: [string, StateValue][] = [];
  const seen = new Set<string>();
  const body = text.startsWith("/\\ ") ? text.slice(3) : text;
  for (const part of body.split("\n/\\ ")) {
    const match = STATE_LINE.exec(part);
    const name = match?.[1];
    const raw = match?.[2];
    if (name === undefined || raw === undefined)
      throw new Error(`cannot read the TLC state line "${part.slice(0, 80)}"`);
    if (seen.has(name)) throw new Error(`TLC state repeats the variable ${name}`);
    seen.add(name);
    let value: StateValue;
    try {
      value = parseValue(raw);
    } catch {
      value = { kind: "raw", text: raw.trim() };
    }
    entries.push([name, value]);
  }
  // fromEntries defines own data properties, so a variable named __proto__ stays data.
  return Object.fromEntries(entries);
}

/** The state that follows a message's first line, up to the first blank line. */
export function messageState(message: TlcMessage): TlcState {
  const lines = textOf(message).split("\n");
  const body: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) break;
    body.push(line);
  }
  if (body.length === 0) throw new Error(`TLC message ${message.code} has no state`);
  return parseState(body.join("\n"));
}

// ---------------------------------------------------------------------------
// Verdicts (verdict.ts)

export type TlcBreak =
  | { kind: "deadlock" }
  | { kind: "temporal" }
  | { kind: "invariant" | "property"; name: string };

const NAMED = new Map<number, ["invariant" | "property", RegExp]>([
  [EC.TLC_INVARIANT_VIOLATED_INITIAL, ["invariant", /^Invariant (\S+) is violated by the initial/]],
  [EC.TLC_INVARIANT_VIOLATED_BEHAVIOR, ["invariant", /^Invariant (\S+) is violated\.$/m]],
  [EC.TLC_PROPERTY_VIOLATED_INITIAL, ["property", /^Property (\S+) is violated by the initial/]],
  [
    EC.TLC_ACTION_PROPERTY_VIOLATED_BEHAVIOR,
    ["property", /^Action property (\S+) is violated\.$/m],
  ],
]);

/**
 * The violation TLC reports, or undefined. Throws when a violation message does not
 * name its rule, or when a run reports more than one violation (TLC stops at the first).
 */
export function readBreak(parts: Iterable<TlcPart>): TlcBreak | undefined {
  let found: TlcBreak | undefined;
  for (const m of messagesIn(parts)) {
    let current: TlcBreak | undefined;
    if (m.code === EC.TLC_DEADLOCK_REACHED) current = { kind: "deadlock" };
    else if (m.code === EC.TLC_TEMPORAL_PROPERTY_VIOLATED) current = { kind: "temporal" };
    else {
      const named = NAMED.get(m.code);
      if (named) {
        const name = named[1].exec(textOf(m))?.[1];
        if (!name) throw new Error(`TLC message ${m.code} does not name the rule it reports`);
        current = { kind: named[0], name };
      }
    }
    if (current && found) throw new Error("TLC reported more than one violation in one run");
    found ??= current;
  }
  return found;
}

export type TlcStats = {
  generated: number | undefined;
  distinct: number | undefined;
  depth: number | undefined;
};

const count = (text: string) => Number(text.replaceAll(",", ""));

export function readStats(parts: Iterable<TlcPart>): TlcStats {
  const stats: TlcStats = { generated: undefined, distinct: undefined, depth: undefined };
  for (const m of messagesIn(parts)) {
    const text = textOf(m);
    if (m.code === EC.TLC_STATS) {
      const found = /^([\d,]+) states? generated, ([\d,]+) distinct states? found/.exec(text);
      if (found?.[1] && found[2]) {
        stats.generated = count(found[1]);
        stats.distinct = count(found[2]);
      }
    } else if (m.code === EC.TLC_SEARCH_DEPTH) {
      const depth = /depth of the complete state graph search is ([\d,]+)/.exec(text);
      if (depth?.[1]) stats.depth = count(depth[1]);
    }
  }
  return stats;
}

export function readVersion(parts: Iterable<TlcPart>): string | undefined {
  for (const m of messagesIn(parts))
    if (m.code === EC.TLC_VERSION) return /^TLC2 Version .+$/m.exec(textOf(m))?.[0];
  return undefined;
}

export function hasMessage(parts: Iterable<TlcPart>, code: number): boolean {
  for (const m of messagesIn(parts)) if (m.code === code) return true;
  return false;
}

function countOf(parts: Iterable<TlcPart>, code: number): number {
  let n = 0;
  for (const m of messagesIn(parts)) if (m.code === code) n++;
  return n;
}

/**
 * Why a run's output does not end the way TLC ends a run, or undefined: exactly one
 * "Finished" message (2186), and nothing but blank lines after it.
 */
export function endingProblem(parts: readonly TlcPart[]): string | undefined {
  const finished = countOf(parts, EC.TLC_FINISHED);
  if (finished !== 1) return `TLC reported finishing ${finished} times`;
  let last = parts.length - 1;
  while (last >= 0) {
    const part = parts[last];
    if (part?.kind === "line" && !part.text.trim()) last--;
    else break;
  }
  const tail = parts[last];
  if (tail?.kind !== "message" || tail.code !== EC.TLC_FINISHED)
    return "TLC printed output after its Finished message";
  return undefined;
}

const TRACE_CODES: ReadonlySet<number> = new Set([
  EC.TLC_STATE_PRINT2,
  EC.TLC_STATE_PRINT3,
  EC.TLC_BACK_TO_STATE,
]);

/**
 * Why the output is not positive evidence of a complete, error-free run, or undefined.
 * A complete run has well-formed framing (the caller checks readMessages first), one
 * success message (2193) before one Finished message (2186) that ends the output, one
 * readable statistics message (2199), at most one readable depth message (2194), and
 * no error, violation or counterexample message.
 */
export function completeRunProblem(parts: readonly TlcPart[]): string | undefined {
  const ending = endingProblem(parts);
  if (ending) return ending;
  const success = countOf(parts, EC.TLC_SUCCESS);
  if (success !== 1) return `TLC reported completing model checking ${success} times`;
  const order = [...messagesIn(parts)].map((m) => m.code);
  if (order.indexOf(EC.TLC_SUCCESS) > order.indexOf(EC.TLC_FINISHED))
    return "TLC reported completing model checking after it finished";
  if (countOf(parts, EC.TLC_STATS) !== 1)
    return `TLC printed ${countOf(parts, EC.TLC_STATS)} final statistics messages, not 1`;
  if (countOf(parts, EC.TLC_SEARCH_DEPTH) > 1) return "TLC printed the search depth twice";
  const stats = readStats(parts);
  if (stats.generated === undefined || stats.distinct === undefined)
    return "TLC's final statistics are unreadable";
  if (hasMessage(parts, EC.TLC_SEARCH_DEPTH) && stats.depth === undefined)
    return "TLC's search depth is unreadable";
  for (const m of messagesIn(parts)) {
    if (m.level === LEVEL.ERROR || m.level === LEVEL.TLCBUG || VIOLATION_CODES.has(m.code))
      return `TLC message ${m.code} contradicts a complete run`;
    if (TRACE_CODES.has(m.code))
      return `TLC printed a counterexample state (${m.code}) without a violation`;
  }
  return undefined;
}

const JVM_NOTICE = /^Picked up (?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS): /;

/** Stderr lines other than the JVM's option notices; TLC itself writes nothing there. */
export function unexpectedStderr(stderr: string): string[] {
  return stderr.split(/\r?\n/).filter((line) => line.trim() && !JVM_NOTICE.test(line));
}

/** Error and TLC-bug level messages that are not part of a violation report. */
export function readFailures(parts: Iterable<TlcPart>): string[] {
  const failures: string[] = [];
  for (const m of messagesIn(parts))
    if ((m.level === LEVEL.ERROR || m.level === LEVEL.TLCBUG) && !VIOLATION_CODES.has(m.code))
      failures.push(`TLC message ${m.code}: ${textOf(m).trim().slice(0, 2000)}`);
  return failures;
}

export function readWarnings(parts: Iterable<TlcPart>): { code: number; text: string }[] {
  const warnings: { code: number; text: string }[] = [];
  for (const m of messagesIn(parts))
    if (m.level === LEVEL.WARNING) warnings.push({ code: m.code, text: textOf(m).trim() });
  return warnings;
}

// ---------------------------------------------------------------------------
// Traces (trace.ts)

export type TraceStep = { index: number; action: string; state: TlcState };

/** How a liveness counterexample repeats: it stutters forever, or `action` leads back to state `toIndex`. */
export type TraceLoop = { kind: "stuttering" } | { kind: "back"; toIndex: number; action: string };

export type TlcTrace = { steps: TraceStep[]; loop: TraceLoop | undefined };

const STEP_HEADER = /^(\d+): <(.*)>\s*$/;

/** The action name of a step header such as `2: <Inc line 7, col 8 to ... of module M>`. */
function actionName(label: string): string {
  if (label === "Initial predicate") return label;
  const name = /^(\S+?)(?: line \d+, col \d+ to line \d+, col \d+ of module \S+)?$/.exec(label);
  return name?.[1] ?? label;
}

/** Reads the counterexample in a run's messages. Throws on a step it cannot place. */
export function readTrace(parts: Iterable<TlcPart>): TlcTrace {
  const steps: TraceStep[] = [];
  const checked = (loop: TraceLoop | undefined): TlcTrace => {
    steps.forEach((step, i) => {
      if (step.index !== i + 1)
        throw new Error(`TLC's trace numbers state ${step.index} where state ${i + 1} belongs`);
    });
    return { steps, loop };
  };
  for (const m of messagesIn(parts)) {
    if (m.code === EC.TLC_STATE_PRINT3) return checked({ kind: "stuttering" });
    if (m.code === EC.TLC_BACK_TO_STATE) {
      const back = /^(\d+): Back to state: <(.*)>\s*$/.exec(textOf(m).split("\n", 1)[0] ?? "");
      if (!back?.[1] || back[2] === undefined)
        throw new Error("cannot read TLC's back-to-state step");
      const toIndex = Number(back[1]);
      if (!steps.some((step) => step.index === toIndex))
        throw new Error(`TLC's trace loops back to state ${toIndex}, which it never printed`);
      return checked({ kind: "back", toIndex, action: actionName(back[2]) });
    }
    if (m.code === EC.TLC_STATE_PRINT2) {
      const header = STEP_HEADER.exec(textOf(m).split("\n", 1)[0] ?? "");
      if (!header?.[1] || header[2] === undefined)
        throw new Error(`cannot read the TLC trace step "${textOf(m).slice(0, 80)}"`);
      steps.push({
        index: Number(header[1]),
        action: actionName(header[2]),
        state: messageState(m),
      });
    } else if (
      m.code === EC.TLC_INVARIANT_VIOLATED_INITIAL ||
      m.code === EC.TLC_PROPERTY_VIOLATED_INITIAL
    ) {
      steps.push({ index: 1, action: "Initial predicate", state: messageState(m) });
    }
  }
  return checked(undefined);
}
