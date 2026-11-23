import { arr, obj, opt, str, compile } from "@earendil-works/pi-schema";
import { normalizeRuleId } from "./rule-id-normalize.ts";

export interface RulePolicyEntry {
  disable?: string[];
  select?: string[];
}

export type RulePolicyMap = Record<string, RulePolicyEntry | undefined>;

interface RulePolicyEvaluation {
  dropped: boolean;
}

interface RulePolicyScan {
  matched: boolean;
  sawEntry: boolean;
}

const RulePolicyEntrySchema = obj(
  {
    disable: opt(arr(str())),
    select: opt(arr(str())),
  },
  { open: true },
);
const isRulePolicyEntry = compile(RulePolicyEntrySchema).check;
const RulePolicyContainerSchema = obj({}, { open: true });
const isRulePolicyContainer = compile(RulePolicyContainerSchema).check;

function parseRulePolicyMap<T>(value: T): RulePolicyMap | undefined {
  if (!isRulePolicyContainer(value)) return undefined;
  const policyMap: RulePolicyMap = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isRulePolicyEntry(entry)) policyMap[key] = entry;
  }
  return policyMap;
}

export function evaluateRulePolicy(
  ruleId: string,
  policyMap: RulePolicyMap | undefined,
): RulePolicyEvaluation {
  if (!policyMap) return { dropped: false };
  const raw = ruleId || "";
  const norm = normalizeRuleId(raw);

  if (scanList(policyMap, (e) => e.disable, raw, norm).matched) {
    return { dropped: true };
  }
  const select = scanList(policyMap, (e) => e.select, raw, norm);
  return { dropped: select.sawEntry && !select.matched };
}

function scanList(
  policyMap: RulePolicyMap,
  pick: (entry: RulePolicyEntry) => string[] | undefined,
  raw: string,
  norm: string,
): RulePolicyScan {
  let sawEntry = false;
  for (const entry of Object.values(policyMap)) {
    for (const candidate of (entry && pick(entry)) ?? []) {
      sawEntry = true;
      if (matchesRule(candidate, raw, norm)) return { matched: true, sawEntry };
    }
  }
  return { matched: false, sawEntry };
}

function matchesRule(entry: string, raw: string, normalized: string): boolean {
  if (entry === raw) return true;
  return normalizeRuleId(entry) === normalized;
}

export function applyRulePolicy<T extends { rule?: string; code?: string }, P>(
  diagnostics: T[],
  rawPolicyMap: P | undefined,
): T[] {
  if (!rawPolicyMap) return diagnostics;
  const policyMap = parseRulePolicyMap(rawPolicyMap);
  if (!policyMap) return diagnostics;
  let hasFilter = false;
  for (const entry of Object.values(policyMap)) {
    if ((entry?.disable?.length ?? 0) > 0 || (entry?.select?.length ?? 0) > 0) {
      hasFilter = true;
      break;
    }
  }
  if (!hasFilter) return diagnostics;

  return diagnostics.filter((d) => {
    const ruleId = d.rule ?? d.code;
    if (!ruleId) return true;
    const { dropped } = evaluateRulePolicy(ruleId, policyMap);
    return !dropped;
  });
}

export function rulePolicyMapFromConfig<T>(rules: T | undefined): RulePolicyMap | undefined {
  if (!rules) return undefined;
  const parsed = parseRulePolicyMap(rules);
  if (!parsed) return undefined;
  let built: RulePolicyMap | undefined;
  for (const [key, entry] of Object.entries(parsed)) {
    if (!entry) continue;
    const hasDisable = (entry.disable?.length ?? 0) > 0;
    const hasSelect = (entry.select?.length ?? 0) > 0;
    if (!hasDisable && !hasSelect) continue;
    built ??= {};
    const policy: RulePolicyEntry = {};
    if (hasDisable) policy.disable = entry.disable;
    if (hasSelect) policy.select = entry.select;
    built[key] = policy;
  }
  return built;
}
