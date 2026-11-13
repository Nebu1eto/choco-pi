// Structured agent output: reviewer and verifier agents end their final message with a fenced JSON block. Code parses
// that block instead of trusting prose. Parsing never throws and never treats a malformed block as a pass.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  arr,
  bool,
  compile,
  int,
  lit,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";
import { isString, type RuntimeValue } from "./runtime-values.ts";
import { parseStrictJson } from "./strict-json.ts";
export const VERDICT_INFO = "choco-pi-verdict";
export const REVIEW_INFO = "choco-pi-review";
export const WORK_TASK_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
/** Agent ids name record files, so they must be a single safe path segment. */
export const AGENT_ID_PATTERN = "^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$";
/** A block larger than this is rejected before JSON parsing. */
export const MAX_BLOCK_BYTES = 1024 * 1024;

const claimSchema = obj({
  id: str({ minLength: 1 }),
  outcome: oneOf(["CONFIRMED", "REFUTED", "UNPROVEN"]),
  reproduction: opt(obj({ path: str(), cmd: str(), exit: int() })),
  note: opt(str()),
});
export type VerdictClaim = Static<typeof claimSchema>;

export const VerdictBlockSchema = obj({
  schema: lit(1),
  kind: lit("claims"),
  workTask: str({ pattern: WORK_TASK_PATTERN }),
  // The checkout the claims were checked against; diffDigest identifies a dirty tree's changes.
  snapshot: obj({
    head: str({ minLength: 1 }),
    clean: bool(),
    diffDigest: opt(str({ minLength: 1 })),
  }),
  claims: arr(claimSchema, { minItems: 1 }),
});
export type VerdictBlock = Static<typeof VerdictBlockSchema>;

const findingSchema = obj({
  id: str({ minLength: 1 }),
  class: oneOf(["finding", "candidate"]),
  severity: oneOf(["critical", "high", "medium", "low"]),
  path: str({ minLength: 1 }),
  startLine: opt(int({ minimum: 1 })),
  endLine: opt(int({ minimum: 1 })),
  invariant: str({ minLength: 1 }),
  evidence: oneOf(["reproduction", "code_path"]),
  reproduction: str(),
  angle: opt(str()),
});
export type ReviewFinding = Static<typeof findingSchema>;

export const ReviewBlockSchema = obj({
  schema: lit(1),
  verdict: oneOf(["FINDINGS", "NO_FINDINGS", "INCOMPLETE"]),
  bundleDigest: str({ minLength: 1 }),
  findings: arr(findingSchema),
  // The contract names the field only; a single description or a list of missing items are both accepted.
  incomplete: opt(
    obj({ missing: union([str({ minLength: 1 }), arr(str({ minLength: 1 }), { minItems: 1 })]) }),
  ),
});
export type ReviewBlock = Static<typeof ReviewBlockSchema>;

export const AgentParseRecordSchema = obj({
  schema: lit(1),
  agentId: str({ pattern: AGENT_ID_PATTERN }),
  agentType: str({ minLength: 1 }),
  workTask: str({ pattern: WORK_TASK_PATTERN }),
  completedAt: str({ minLength: 1 }),
  status: oneOf(["parsed", "missing", "invalid"]),
  error: opt(str()),
  verdict: opt(VerdictBlockSchema),
  review: opt(ReviewBlockSchema),
});
export type AgentParseRecord = Static<typeof AgentParseRecordSchema>;

const verdictValidator = compile(VerdictBlockSchema);
const reviewValidator = compile(ReviewBlockSchema);
const agentRecordValidator = compile(AgentParseRecordSchema);
const isAgentId = compile(str({ pattern: AGENT_ID_PATTERN })).check;

export type BlockParse<Value> =
  | { status: "parsed"; value: Value }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

export type Validation<Value> = { ok: true; value: Value } | { ok: false; errors: string[] };

/** startLine is the opening fence's line index; endLine is the closing fence's, or the last line when unclosed. */
type FencedBlock = {
  info: string;
  body: string;
  closed: boolean;
  startLine: number;
  endLine: number;
};

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** Any fence-like line, including one indented, inside a blockquote, or after a byte-order mark. */
const FENCE_LIKE = /^[\s>]*(`{3,}|~{3,})(.*)$/;
const STRUCTURED_INFOS: readonly string[] = [VERDICT_INFO, REVIEW_INFO];

/**
 * CommonMark-style fenced block scan. A closing fence uses the opening character and is at least as long, so a
 * block opened with four backticks may contain three-backtick lines. An unclosed block runs to the end.
 */
function fencedBlocks(lines: string[]): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: { fence: string; info: string; lines: string[]; startLine: number } | undefined;
  for (const [index, line] of lines.entries()) {
    if (open) {
      const closing = CLOSING_FENCE.exec(line);
      if (closing && closing[1][0] === open.fence[0] && closing[1].length >= open.fence.length) {
        blocks.push({
          info: open.info,
          body: open.lines.join("\n"),
          closed: true,
          startLine: open.startLine,
          endLine: index,
        });
        open = undefined;
      } else {
        open.lines.push(line);
      }
      continue;
    }
    const opening = OPENING_FENCE.exec(line);
    if (!opening) continue;
    const info = opening[2].trim();
    // A backtick fence's info string cannot contain a backtick; such a line is inline code, not a fence.
    if (opening[1][0] === "`" && info.includes("`")) continue;
    open = { fence: opening[1], info, lines: [], startLine: index };
  }
  if (open) {
    blocks.push({
      info: open.info,
      body: open.lines.join("\n"),
      closed: false,
      startLine: open.startLine,
      endLine: lines.length - 1,
    });
  }
  return blocks;
}

/**
 * Line indexes of fence-like lines that name `info` (case-insensitively, possibly among other words) anywhere in the
 * message: nested in another block, quoted, indented, or with a near-miss info string. The caller excludes the one
 * top-level block it reads; any other such line makes the message ambiguous.
 */
function fenceMentions(lines: string[], info: string): number[] {
  const mentions: number[] = [];
  for (const [index, line] of lines.entries()) {
    const lower = line.toLowerCase();
    if (!lower.includes(info)) continue;
    const fence = FENCE_LIKE.exec(lower);
    if (!fence) continue;
    const rest = fence[2];
    if (fence[1][0] === "`" && rest.includes("`")) continue;
    if (rest.includes(info)) mentions.push(index);
  }
  return mentions;
}

function schemaErrors(errors: { path: string; message: string }[]): string[] {
  return errors.slice(0, 8).map((error) => `${error.path || "/"}: ${error.message}`);
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

/** Shape plus cross-field rules for a choco-pi-verdict block. */
export function validateVerdictBlock(value: RuntimeValue): Validation<VerdictBlock> {
  if (!verdictValidator.check(value)) {
    return { ok: false, errors: schemaErrors(verdictValidator.errors(value)) };
  }
  const errors: string[] = [];
  if (value.snapshot.clean && value.snapshot.diffDigest !== undefined) {
    errors.push("snapshot: a clean snapshot must not carry diffDigest");
  }
  for (const id of duplicates(value.claims.map((claim) => claim.id))) {
    errors.push(`duplicate claim id ${id}`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Shape plus verdict/findings consistency for a choco-pi-review block. */
export function validateReviewBlock(value: RuntimeValue): Validation<ReviewBlock> {
  if (!reviewValidator.check(value)) {
    return { ok: false, errors: schemaErrors(reviewValidator.errors(value)) };
  }
  const errors: string[] = [];
  if (value.verdict === "NO_FINDINGS" && value.findings.length > 0) {
    errors.push("NO_FINDINGS requires an empty findings array");
  }
  if (value.verdict === "FINDINGS" && value.findings.length === 0) {
    errors.push("FINDINGS requires at least one finding");
  }
  if (value.verdict === "INCOMPLETE" && !value.incomplete) {
    errors.push("INCOMPLETE requires incomplete.missing");
  }
  if (value.verdict !== "INCOMPLETE" && value.incomplete !== undefined) {
    errors.push("incomplete is allowed only with verdict INCOMPLETE");
  }
  for (const finding of value.findings) {
    if (
      finding.startLine !== undefined &&
      finding.endLine !== undefined &&
      finding.endLine < finding.startLine
    ) {
      errors.push(`finding ${finding.id}: endLine is before startLine`);
    }
  }
  for (const id of duplicates(value.findings.map((finding) => finding.id))) {
    errors.push(`duplicate finding id ${id}`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/**
 * Reads the one block with info string `info`. The message is invalid, never read as a pass, when: more than one
 * top-level block has that info string; any other fence-like line names it (nested in another block, quoted,
 * indented, or with a different case or extra words); the block is unclosed; or anything but blank lines and other
 * closed structured blocks follows it. A single leading byte-order mark is ignored and CRLF line endings are accepted.
 */
function parseSingleBlock<Value>(
  text: RuntimeValue,
  info: string,
  validate: (value: RuntimeValue) => Validation<Value>,
): BlockParse<Value> {
  try {
    if (!isString(text)) return { status: "invalid", reason: "message text is not a string" };
    const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text)
      .split("\n")
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    const blocks = fencedBlocks(lines);
    const matching = blocks.filter((block) => block.info === info);
    const openers = new Set(matching.map((block) => block.startLine));
    const stray = fenceMentions(lines, info).filter((index) => !openers.has(index));
    if (matching.length > 1) {
      return {
        status: "invalid",
        reason: `the message has more than one ${info} block (${matching.length}); exactly one is required`,
      };
    }
    if (stray.length > 0) {
      return {
        status: "invalid",
        reason: `line ${stray[0] + 1} names ${info} but is not the one top-level block with exactly that info string`,
      };
    }
    const block = matching.at(0);
    if (!block) return { status: "missing" };
    if (!block.closed) return { status: "invalid", reason: `the ${info} block is not closed` };
    const covered = new Set<number>();
    for (const other of blocks) {
      if (
        other.closed &&
        other.startLine > block.endLine &&
        STRUCTURED_INFOS.includes(other.info)
      ) {
        for (let index = other.startLine; index <= other.endLine; index += 1) covered.add(index);
      }
    }
    for (let index = block.endLine + 1; index < lines.length; index += 1) {
      if (lines[index].trim() !== "" && !covered.has(index)) {
        return {
          status: "invalid",
          reason: `text follows the ${info} block (line ${index + 1}); the block must end the message`,
        };
      }
    }
    if (Buffer.byteLength(block.body, "utf8") > MAX_BLOCK_BYTES) {
      return { status: "invalid", reason: `the ${info} block exceeds ${MAX_BLOCK_BYTES} bytes` };
    }
    const parsed = parseStrictJson(block.body);
    if (!parsed.ok) {
      return { status: "invalid", reason: `the ${info} block is not valid JSON: ${parsed.error}` };
    }
    const result = validate(parsed.value);
    if (!result.ok) return { status: "invalid", reason: result.errors.join("; ") };
    return { status: "parsed", value: result.value };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected failure";
    return { status: "invalid", reason: `could not parse the ${info} block: ${message}` };
  }
}

/** Finds the single fenced block whose info string is exactly `info` and validates it for that info string. */
export function parseStructuredBlock(
  text: RuntimeValue,
  info: typeof VERDICT_INFO,
): BlockParse<VerdictBlock>;
export function parseStructuredBlock(
  text: RuntimeValue,
  info: typeof REVIEW_INFO,
): BlockParse<ReviewBlock>;
export function parseStructuredBlock(
  text: RuntimeValue,
  info: typeof VERDICT_INFO | typeof REVIEW_INFO,
): BlockParse<VerdictBlock> | BlockParse<ReviewBlock> {
  return info === VERDICT_INFO
    ? parseSingleBlock(text, info, validateVerdictBlock)
    : parseSingleBlock(text, info, validateReviewBlock);
}

export function parseVerdictBlock(text: RuntimeValue): BlockParse<VerdictBlock> {
  return parseSingleBlock(text, VERDICT_INFO, validateVerdictBlock);
}

export function parseReviewBlock(text: RuntimeValue): BlockParse<ReviewBlock> {
  return parseSingleBlock(text, REVIEW_INFO, validateReviewBlock);
}

/** Shape plus status consistency for a <agentId>.json verdict record. */
export function validateAgentParseRecord(value: RuntimeValue): Validation<AgentParseRecord> {
  if (!agentRecordValidator.check(value)) {
    return { ok: false, errors: schemaErrors(agentRecordValidator.errors(value)) };
  }
  const errors: string[] = [];
  if (value.status === "parsed" && !value.verdict && !value.review) {
    errors.push('status "parsed" requires verdict or review');
  }
  if (value.status === "invalid" && !value.error) errors.push('status "invalid" requires error');
  if (value.status !== "parsed" && (value.verdict || value.review)) {
    errors.push(`status "${value.status}" must not carry parsed data`);
  }
  if (value.verdict) {
    const verdict = validateVerdictBlock(value.verdict);
    if (!verdict.ok) errors.push(...verdict.errors.map((error) => `verdict: ${error}`));
  }
  if (value.review) {
    const review = validateReviewBlock(value.review);
    if (!review.ok) errors.push(...review.errors.map((error) => `review: ${error}`));
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

export type AgentRecordIdentity = {
  agentId: string;
  agentType: string;
  workTask: string;
  completedAt: string;
};

/**
 * Builds the parse record for an agent's final message. Any invalid block makes the record invalid, so a malformed
 * block next to a valid one is never read as a pass. With no block at all the status is "missing".
 */
export function buildAgentParseRecord(
  text: RuntimeValue,
  identity: AgentRecordIdentity,
): AgentParseRecord {
  const base = {
    schema: 1 as const,
    agentId: identity.agentId,
    agentType: identity.agentType,
    workTask: identity.workTask,
    completedAt: identity.completedAt,
  };
  const verdict = parseVerdictBlock(text);
  const review = parseReviewBlock(text);
  const reasons: string[] = [];
  if (verdict.status === "invalid") reasons.push(`${VERDICT_INFO}: ${verdict.reason}`);
  if (review.status === "invalid") reasons.push(`${REVIEW_INFO}: ${review.reason}`);
  if (verdict.status === "parsed" && verdict.value.workTask !== identity.workTask) {
    reasons.push(
      `${VERDICT_INFO}: workTask ${verdict.value.workTask} does not match ${identity.workTask}`,
    );
  }
  if (reasons.length > 0) return { ...base, status: "invalid", error: reasons.join("; ") };
  if (verdict.status === "missing" && review.status === "missing") {
    return { ...base, status: "missing" };
  }
  const record: AgentParseRecord = { ...base, status: "parsed" };
  if (verdict.status === "parsed") record.verdict = verdict.value;
  if (review.status === "parsed") record.review = review.value;
  return record;
}

/** The directory holding every work task's verdict records: `<scratch>/verdicts`. */
export function verdictRecordsRoot(scratchDir: string): string {
  return path.join(scratchDir, "verdicts");
}

/** One work task's verdict records: `<scratch>/verdicts/<workTask>/<agentId>.json`. */
export function verdictRecordsDirectory(scratchDir: string, workTask: string): string {
  return path.join(verdictRecordsRoot(scratchDir), workTask);
}

export function agentRecordPath(recordsDir: string, agentId: string): string {
  if (!isAgentId(agentId)) throw new Error(`agent id is not a safe file name: ${agentId}`);
  return path.join(recordsDir, `${agentId}.json`);
}

/** Writes <agentId>.json atomically (same-directory temporary file, then rename). */
export async function writeAgentParseRecord(
  recordsDir: string,
  record: AgentParseRecord,
): Promise<string> {
  const validation = validateAgentParseRecord(record);
  if (!validation.ok)
    throw new Error(`invalid agent parse record: ${validation.errors.join("; ")}`);
  const target = agentRecordPath(recordsDir, record.agentId);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

export type RecordRead<Value> =
  | { status: "valid"; value: Value }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

function isMissingError(error: RuntimeValue): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readAgentParseRecord(
  recordsDir: string,
  agentId: string,
): Promise<RecordRead<AgentParseRecord>> {
  let contents: string;
  try {
    contents = await readFile(agentRecordPath(recordsDir, agentId), "utf8");
  } catch (error) {
    if (isMissingError(error)) return { status: "missing" };
    return { status: "invalid", reason: error instanceof Error ? error.message : "unreadable" };
  }
  const parsed = parseStrictJson(contents);
  if (!parsed.ok) return { status: "invalid", reason: `not valid JSON: ${parsed.error}` };
  const validation = validateAgentParseRecord(parsed.value);
  if (!validation.ok) return { status: "invalid", reason: validation.errors.join("; ") };
  if (validation.value.agentId !== agentId) {
    return { status: "invalid", reason: "agentId does not match the file name" };
  }
  return { status: "valid", value: validation.value };
}

export type AgentRecordListing = {
  records: AgentParseRecord[];
  invalid: { file: string; reason: string }[];
};

/** Reads every *.json record of one work task; unreadable or invalid files are reported, never dropped silently. */
export async function readAgentParseRecords(recordsDir: string): Promise<AgentRecordListing> {
  let entries: string[];
  try {
    entries = await readdir(recordsDir);
  } catch (error) {
    if (isMissingError(error)) return { records: [], invalid: [] };
    throw error;
  }
  const listing: AgentRecordListing = { records: [], invalid: [] };
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const agentId = entry.slice(0, -".json".length);
    if (!isAgentId(agentId)) {
      listing.invalid.push({ file: entry, reason: "file name is not a valid agent id" });
      continue;
    }
    const read = await readAgentParseRecord(recordsDir, agentId);
    if (read.status === "valid") listing.records.push(read.value);
    else if (read.status === "invalid") listing.invalid.push({ file: entry, reason: read.reason });
  }
  return listing;
}
