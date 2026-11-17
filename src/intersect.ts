import { type JsonPath, getNodeRules } from "json-crawl"

import type { GroupContext, KeywordGroup, MergeContext, MergeOptions, MergeResolver, MergeRule, MergeRules, ResolvedMergeSettings, SimplifyOptions } from "./types"
import { countCombinations, dedupeValues, fragmentsOf, fragmentsValue, isFragments, isPlainObject } from "./utils"
import { last, mergeArray, mergeSchemas, singleValueValidators } from "./resolvers/basic"
import { keywordGroups } from "./groups"
import { isAllOfMergeRule, jsonSchemaMergeResolver } from "./resolvers/conjunction"
import { ErrorMessage } from "./errors"
import { hasOwn, safeSet } from "./safe"
import type { IssueHint, MergeIssue } from "./issues"

// key -> the group that owns it (built once)
const groupOfKey = new Map<string, KeywordGroup>()
for (const group of keywordGroups) {
  for (const key of group.keys) { groupOfKey.set(key, group) }
}

// returned by intersect when the node must be left as it is (branch budget exceeded)
export const UNCHANGED: unique symbol = Symbol("allof-merge/unchanged")

export const DEFAULT_BRANCH_BUDGET = 1024
export const DEFAULT_MAX_REF_EXPANSION = 10_000
export const DEFAULT_EXPANSION_BUDGET = 2_000_000
export const DEFAULT_MAX_DEPTH = 2000
export const DEFAULT_PATTERN_LIMITS = Object.freeze({ maxPatternLength: 256, maxNameLength: 256 })

// MergeOptions with every default applied (the settings handed to keyword groups)
export const resolveMergeSettings = (options: MergeOptions = {}): ResolvedMergeSettings => {
  const { matchPatterns } = options
  return {
    unsatisfiable: options.unsatisfiable === "not-empty" ? "not-empty" : "false",
    branchBudget: options.branchBudget ?? DEFAULT_BRANCH_BUDGET,
    matchPatterns: matchPatterns === false
      ? false
      : { ...DEFAULT_PATTERN_LIMITS, ...(typeof matchPatterns === "object" && matchPatterns ? matchPatterns : {}) },
    maxRefExpansion: options.maxRefExpansion ?? DEFAULT_MAX_REF_EXPANSION,
    expansionBudget: options.expansionBudget ?? DEFAULT_EXPANSION_BUDGET,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    dedupeAnyOf: options.dedupeAnyOf !== false,
    dedupeFragments: options.dedupeFragments !== false,
    dedupeCombinaryGroups: options.dedupeCombinaryGroups !== false,
    dropFalseBranches: options.dropFalseBranches !== false,
    simplify: resolveSimplify(options.simplify),
  }
}

const SIMPLIFY_RULES = ["enumByType", "contradictions", "redundantBounds", "containsToMinItems"] as const

// `simplify: true` turns every rule on; an object turns on the rules set to true; anything else is off
const resolveSimplify = (option: MergeOptions["simplify"]): Required<SimplifyOptions> | false => {
  if (!option) { return false }
  const all = option === true
  const resolved = {} as Required<SimplifyOptions>
  let any = false
  for (const rule of SIMPLIFY_RULES) {
    resolved[rule] = all || (typeof option === "object" && option[rule] === true)
    any ||= resolved[rule]
  }
  return any ? Object.freeze(resolved) : false
}

const DEFAULT_SETTINGS: ResolvedMergeSettings = resolveMergeSettings()

// the `reason` of an unsatisfiable issue raised by a keyword group or a keyword's resolver
const GROUP_REASONS: Readonly<Record<string, string>> = Object.freeze({ type: "type", numericBounds: "bounds", string: "format" })
const KEY_REASONS: Readonly<Record<string, string>> = Object.freeze({ type: "type", enum: "enum", const: "const", format: "format" })

const groupReason = (group: KeywordGroup, values: Record<string, any[]>): string | undefined => {
  if (group.name === "enumConst") { return values.const && values.const.length > 1 ? "const" : "enum" }
  return hasOwn(GROUP_REASONS, group.name) ? GROUP_REASONS[group.name] : undefined
}

export interface IntersectContext {
  mergeRules: MergeRules
  path: JsonPath
  // max number of combinations of one oneOf/anyOf product (used when `budget` is absent)
  branchBudget: number
  // budget shared by every product of one merge() call; decremented by each product
  budget?: { remaining: number }
  // resolved merge options handed to the keyword groups (defaults when absent)
  settings?: ResolvedMergeSettings
  // called for every contradiction (values are the conflicting keyword values, no message) and for a budget overflow /
  // malformed value / kept part (with a message); `hint` carries the issue code
  report: (values: any[], message?: string, hint?: IssueHint) => void
  // issues of nested merges run by resolvers, their path relative to the node
  forward?: (issue: MergeIssue) => void
  // full (eager) merge of schema values whose location rules do not merge allOf (custom `$: jsonSchemaMergeResolver`)
  mergeNested?: (schemas: unknown[], rules: MergeRules) => unknown
}

export { isAllOfMergeRule }

// the rule the rule set defines for a key (json-crawl precedence: exact key > longest `"/<prefix>*"` prefix > `/*`; function
// rules are invoked with the crawl context), or undefined when it defines none with a `$` (an unknown keyword)
export const knownKeyRule = (rules: MergeRules, key: string, path: JsonPath, value: unknown): MergeRule | undefined => {
  const rule: any = getNodeRules(rules as any, key, path, value)
  return rule && typeof rule === "object" && "$" in rule ? rule : undefined
}

// last-wins: the resolver of an unknown keyword when the rule set has no `/?` fallback either (D-19; 0.6.8 threw)
const UNKNOWN_KEY_RULE: MergeRule = Object.freeze({ $: last })

// rule of a key: the rule the rule set defines for it (exact > longest prefix > `/*`), else the `/?` fallback, else
// last-wins (D-19)
export const findKeyRule = (rules: MergeRules, key: string, path: JsonPath, value: unknown): MergeRule | undefined => {
  const known = knownKeyRule(rules, key, path, value)
  if (known) { return known }
  let rule: any = (rules as any)["/?"]
  rule = typeof rule === "function" ? rule({ key, path, value }) : rule
  return rule && typeof rule === "object" && "$" in rule ? rule : UNKNOWN_KEY_RULE
}

// key -> values of that key in every item that carries it (item order); a null-prototype map, so that
// `__proto__` / `constructor` are ordinary keys (VR-21)
const itemsMap = (items: Record<string, any>[]): Record<string, any[]> => {
  const map: Record<string, any[]> = Object.create(null)
  for (const item of items) {
    for (const key of Object.keys(item)) {
      const list = map[key]
      if (list) {
        list.push(item[key])
      } else {
        map[key] = [item[key]]
      }
    }
  }
  return map
}

/**
 * Intersection engine: the conjunction of schema items as one schema.
 *
 * 1. `false` items make the result `false`; `true` and empty items are dropped (done by the caller)
 * 2. values are grouped by key
 * 3. keyword groups run first (a group owns its keys when every present key is tagged with the group; a custom `$` on any of them hands the keys back to the per-key table)
 * 4. remaining keys go through the per-key rule table (`/key.$`, `/?` fallback); schema-valued keys become allOf nodes merged by the clone pass
 * 5. any `undefined` from a group or a resolver is a contradiction: the result is `false` and `report` is called
 * 6. `enum`/`required` keep first-seen order; annotations keep their last/mergeObjects behaviour
 *
 * The items must not carry `allOf` (the caller flattens them). The engine never returns `undefined`.
 */
export const intersect = (items: Record<string, any>[], ctx: IntersectContext): Record<string, any> | false | typeof UNCHANGED => {
  const { mergeRules, path } = ctx
  const settings = ctx.settings ?? DEFAULT_SETTINGS
  // a group report without a hint is a custom group's conflict
  const report: GroupContext["report"] = (message, values, hint) => ctx.report(values, message, hint ?? { code: "merge-conflict" })
  const map = itemsMap(items)
  const result: Record<string, any> = {}
  const allOfFragments: unknown[] = []
  // grouped keys a custom `$` handed back to the per-key table: their resolver runs even for a single value
  let handedBack: Set<string> | undefined

  // groups that own at least one present key, in group order
  let groups: KeywordGroup[] | undefined
  for (const key in map) {
    const group = groupOfKey.get(key)
    if (group && !(groups ??= []).includes(group)) { groups.push(group) }
  }

  for (const group of groups ?? []) {
    const present: string[] = []
    const values: Record<string, any[]> = Object.create(null)
    let owned = true
    for (const key of group.keys) {
      if (!(key in map)) { continue }
      const rule = knownKeyRule(mergeRules, key, path, map[key][0])
      // a key the rule set has no rule for is an unknown keyword there (e.g. `prefixItems` under draft-07, D-18): it
      // is left to the `/?` fallback instead of taking the group away from the other keys
      if (!rule) { continue }
      present.push(key)
      values[key] = map[key]
      if (rule.group !== group.name) { owned = false }
    }
    if (!present.length) { continue }
    if (!owned) {
      handedBack ??= new Set()
      for (const key of present) { handedBack.add(key) }
      continue
    }

    for (const key of present) { delete map[key] }
    const merged = group.resolve({ items, values, mergeRules, path, settings, report })
    if (merged === undefined) {
      ctx.report(present.length === 1 ? values[present[0]] : present.flatMap((key) => values[key]), undefined, { code: "unsatisfiable", keyword: present.length === 1 ? present[0] : undefined, reason: groupReason(group, values) })
      return false
    }
    for (const key of Object.keys(merged)) {
      if (key === "allOf") {
        if (Array.isArray(merged.allOf)) { allOfFragments.push(...merged.allOf) }
      } else {
        safeSet(result, key, merged[key])
      }
    }
  }

  for (const key of Object.keys(map)) {
    let values = map[key]

    const rule = findKeyRule(mergeRules, key, path, values[0])
    // a rule whose `$` is not a function falls back to last-wins as well
    const resolver: MergeResolver = rule && typeof rule.$ === "function" ? rule.$ : last

    if (values.length === 1 && !handedBack?.has(key)) {
      // Q9: a lone malformed value of a validated keyword is dropped and reported
      const valid = singleValueValidators.get(resolver)
      if (valid && !valid(values[0])) {
        ctx.report(values, ErrorMessage.malformedValue(key), { code: "malformed-value", keyword: key })
        continue
      }
      safeSet(result, key, values[0])
      continue
    }

    if (resolver === mergeArray && values.length > 1) {
      // oneOf / anyOf: a malformed (non-array) value is ignored and reported (VR-37, D-6)
      const arrays = values.filter(Array.isArray)
      if (arrays.length < values.length) {
        ctx.report(values.filter((value) => !Array.isArray(value)), ErrorMessage.malformedValue(key), { code: "malformed-value", keyword: key })
        if (!arrays.length) { continue }
        if (arrays.length === 1) {
          safeSet(result, key, arrays[0])
          continue
        }
        values = arrays
      }
      if (settings.dedupeCombinaryGroups && (key === "oneOf" || key === "anyOf")) {
        // X ∧ X ≡ X: an identical (order-sensitive) group is combined once, before the product is counted
        values = dedupeValues(values)
        if (values.length === 1) {
          safeSet(result, key, values[0])
          continue
        }
      }
      const count = countCombinations(values)
      const limit = ctx.budget ? ctx.budget.remaining : ctx.branchBudget
      if (count > limit) {
        ctx.report(values, ErrorMessage.branchBudgetExceeded(count, ctx.budget ? settings.branchBudget : ctx.branchBudget), { code: "branch-budget", keyword: key })
        return UNCHANGED
      }
      if (ctx.budget) { ctx.budget.remaining -= count }
    }

    // the context of the key's resolver: `mergeError` is a custom resolver's conflict, `report` carries an issue code
    const mergeContext: MergeContext = {
      allOfItems: items,
      mergeRules,
      path,
      settings,
      key,
      mergeError: (conflict) => ctx.report(conflict, undefined, { code: "merge-conflict", keyword: key }),
      report: (code, conflict, details) => ctx.report(conflict, details?.message ?? (code === "malformed-value" ? ErrorMessage.malformedValue(key) : undefined), { code, keyword: details?.keyword ?? key, reason: details?.reason }),
      forward: ctx.forward,
    }

    let merged: unknown
    if (resolver === jsonSchemaMergeResolver || resolver === mergeSchemas) {
      if (isAllOfMergeRule(rule)) {
        // schema-valued keyword: merged lazily by the clone pass with the rules of its location
        merged = { allOf: values }
      } else {
        // the location has no allOf rule (e.g. a custom `"/x": { $: jsonSchemaMergeResolver }`): merge eagerly with the
        // rules of the node, as 0.6.8 did (VR-38)
        merged = ctx.mergeNested
          ? ctx.mergeNested(values, mergeRules)
          : jsonSchemaMergeResolver(values, mergeContext)
      }
    } else {
      merged = resolver(values, mergeContext)
    }

    // per-key resolvers may hand back fragments that cannot be merged into one keyword (they end up in `allOf`)
    if (isFragments(merged)) {
      allOfFragments.push(...fragmentsOf(merged))
      const kept = fragmentsValue(merged)
      if (kept) { safeSet(result, key, kept.value) }
      continue
    }

    if (merged === undefined) {
      ctx.report(values, undefined, { code: "unsatisfiable", keyword: key, reason: hasOwn(KEY_REASONS, key) ? KEY_REASONS[key] : undefined })
      return false
    }
    safeSet(result, key, merged)
  }

  if (allOfFragments.length) {
    // A ∧ A ≡ A: identical kept parts once
    safeSet(result, "allOf", settings.dedupeFragments ? dedupeValues(allOfFragments) : allOfFragments)
  }

  return result
}
