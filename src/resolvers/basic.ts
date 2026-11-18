import { ValueSet, asFragments, deepEqual, findCombinations, isValidMultipleOf, mergeValues, uniqueConcat } from "../utils.ts"
import { getAllOfItemsMap } from "./jsonschema.ts"
import type { GroupContext, MergeContext, MergeResolver } from "../types.ts"
import { ErrorMessage } from "../errors.ts"
import { ISSUE_MESSAGES } from "../issues.ts"
import { getOwn, hasOwn, safeSet } from "../safe.ts"
import { getNodeRules } from "json-crawl"
import { mergeMultipleOfValues, mergeNumericBounds } from "../groups/numeric.ts"
import { mergeFormats } from "../groups/format.ts"

// report a malformed value through the resolver context (direct callers may pass no context): a "malformed-value"
// issue when the engine provides `report`, the plain `mergeError` otherwise
const malformed = (ctx: MergeContext | undefined, values: unknown[]) => {
  if (!values.length || !ctx) { return }
  if (ctx.report) {
    ctx.report("malformed-value", values, { message: ErrorMessage.malformedValue(ctx.key ?? "keyword"), keyword: ctx.key })
  } else {
    ctx.mergeError?.(values)
  }
}

/**
 * The group-style `report(message, values, hint)` of a resolver context, for resolvers that run a keyword group's
 * algorithm: an issue with the hint's code through `ctx.report`, or the plain `mergeError` (direct callers).
 */
export const groupReport = (ctx: MergeContext | undefined): GroupContext["report"] => {
  if (!ctx) { return undefined }
  return (message, values, hint) => {
    if (ctx.report) {
      ctx.report(hint?.code ?? "merge-conflict", values, { message, keyword: hint?.keyword ?? ctx.key, reason: hint?.reason })
    } else {
      ctx.mergeError?.(values)
    }
  }
}

// a per-key resolver result that drops the key (every value was malformed)
const dropKey = () => asFragments([])

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

export const first: MergeResolver = ([a]) => a
export const last: MergeResolver = (args) => args[args.length - 1]
// boolean OR / AND; values that are not booleans are ignored and reported (D-6)
const booleans = (args: unknown[], ctx: MergeContext | undefined): boolean[] => {
  malformed(ctx, args.filter((v) => typeof v !== "boolean"))
  return args.filter((v): v is boolean => typeof v === "boolean")
}
export const alternative: MergeResolver = (args, ctx) => {
  const flags = booleans(args, ctx)
  return flags.length ? flags.some(Boolean) : dropKey()
}
export const and: MergeResolver = (args, ctx) => {
  const flags = booleans(args, ctx)
  return flags.length ? flags.every(Boolean) : dropKey()
}
// smallest / largest number; values that are not finite numbers are ignored and reported (D-6)
export const minValue: MergeResolver = (args, ctx) => {
  const numbers = args.filter(isFiniteNumber)
  malformed(ctx, args.filter((v) => !isFiniteNumber(v)))
  return numbers.length ? Math.min(...numbers) : dropKey()
}
export const maxValue: MergeResolver = (args, ctx) => {
  const numbers = args.filter(isFiniteNumber)
  malformed(ctx, args.filter((v) => !isFiniteNumber(v)))
  return numbers.length ? Math.max(...numbers) : dropKey()
}
export const intersectItems: MergeResolver = ([a, ...args]) => args.reduce((r, v) => r.filter((t: string) => v.includes(t)), a)
// structural equality; undefined (contradiction) when the values differ
export const equal: MergeResolver = ([a, ...args]) => args.some((v) => !deepEqual(v, a)) ? undefined : a
export const mergeObjects: MergeResolver = ([a, ...args]) => args.reduce((r, v) => mergeValues(r, v), a)
// the branches mergeArray creates: a product branch's components are branches of their own, so a `$ref` component
// keeps its target's annotations under refAnnotations (D-26)
export const productBranches = new WeakSet<object>()
// cartesian product of oneOf/anyOf lists; values that are not arrays are ignored
export const mergeArray: MergeResolver = (args) => findCombinations(args).map((v) => {
  const branch = { allOf: v }
  productBranches.add(branch)
  return branch
})
const isSchema = (value: unknown): boolean => typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
// not A ∧ not B = not (A ∨ B); values that are not schemas are ignored and reported (D-6)
export const mergeNot: MergeResolver = (args, ctx) => {
  const schemas = args.filter(isSchema)
  malformed(ctx, args.filter((v) => !isSchema(v)))
  if (!schemas.length) { return dropKey() }
  return schemas.length === 1 ? schemas[0] : { anyOf: schemas }
}
// least common multiple, or allOf fragments when it cannot be computed exactly (VR-01)
export const mergeMultipleOf: MergeResolver = (args, ctx) => {
  const merged = mergeMultipleOfValues(args, groupReport(ctx))
  if (hasOwn(merged, "multipleOf")) { return merged.multipleOf }
  return asFragments((merged.allOf as unknown[] | undefined) ?? [])
}
const formatResolver = (lattice: boolean): MergeResolver => (args, ctx) => {
  const merged = mergeFormats(args, groupReport(ctx), lattice)
  if (!merged) { return undefined }
  return hasOwn(merged, "format") ? merged.format : dropKey()
}
// format (D-14, Q1, JSON Schema / GraphApi rules): equal formats are kept, differing formats are a contradiction
export const mergeFormat: MergeResolver = formatResolver(false)
// format with the OpenAPI numeric lattice (D-14): int32 ∧ int64 → int32, float ∧ double → float, other differing
// formats are a contradiction
export const mergeOpenApiFormat: MergeResolver = formatResolver(true)
// draft-04 boolean exclusive bounds as per-key fallbacks (numeric group handed back by a custom rule, VR-39, AM-10):
// the flag travels with the selected bound value. The bound's own rule (custom or built-in) selects the value from
// the items' bounds; the flag is the one of the item(s) carrying that value (exclusive if any of them is - tightest).
// Without a usable bound rule/value the group algorithm decides (the flag of the tightest bound).
const draft04Flag = (boundKey: "minimum" | "maximum", flagKey: "exclusiveMinimum" | "exclusiveMaximum"): MergeResolver => (_args, ctx) => {
  const items: unknown[] = Array.isArray(ctx?.allOfItems) ? ctx.allOfItems : []
  const bounded = items.filter((item) => isFiniteNumber(getOwn(item, boundKey)))
  const fallback = () => {
    const merged = mergeNumericBounds(items as Record<string, any>[])
    return hasOwn(merged, flagKey) ? merged[flagKey] : dropKey()
  }
  if (!bounded.length || !ctx?.mergeRules) { return fallback() }
  const bounds = bounded.map((item) => getOwn(item, boundKey) as number)
  const rule: any = getNodeRules(ctx.mergeRules as any, boundKey, ctx.path ?? [], bounds[0])
  const resolver: MergeResolver | undefined = rule && typeof rule === "object" && typeof rule.$ === "function" ? rule.$ : undefined
  if (!resolver) { return fallback() }
  // a resolver that reports is not asked twice for the same malformed values: bounds are finite numbers here
  const selected = bounds.length === 1 ? bounds[0] : resolver(bounds, { ...ctx, mergeError: () => {} })
  const winners = bounded.filter((item) => getOwn(item, boundKey) === selected)
  if (!winners.length) { return fallback() }
  const flags = winners.map((item) => getOwn(item, flagKey))
  if (!flags.some((flag) => typeof flag === "boolean")) { return dropKey() }
  return flags.some((flag) => flag === true)
}
export const draft04ExclusiveMinimum: MergeResolver = draft04Flag("minimum", "exclusiveMinimum")
export const draft04ExclusiveMaximum: MergeResolver = draft04Flag("maximum", "exclusiveMaximum")
// the conjunction of several schemas, merged by the clone pass with the rules of the key (lazy)
export const mergeSchemas: MergeResolver = (args) => ({ allOf: args })

// backreferences and named groups cannot be combined into one expression
const unsafePattern = /\\[1-9]|\\k<|\(\?<[^=!]/

export const isUnsafePattern = (pattern: string): boolean => unsafePattern.test(pattern)

const isValidPattern = (pattern: string): boolean => {
  try {
    new RegExp(pattern, "u")
    return true
  } catch {
    try {
      new RegExp(pattern)
      return true
    } catch {
      return false
    }
  }
}

// returns the single pattern equivalent to the conjunction of all patterns, or undefined when it cannot be built safely
export const conjunctPatterns = (patterns: string[]): string | undefined => {
  const unique = [...new Set(patterns)]
  if (unique.length === 1) { return unique[0] }
  if (unique.some((p) => unsafePattern.test(p) || !isValidPattern(p))) { return undefined }
  return `^${unique.map((p) => `(?=[\\s\\S]*?(?:${p}))`).join("")}[\\s\\S]*$`
}

// pattern conjunction; patterns that cannot be conjoined are kept as allOf fragments (never last-wins)
export const mergePattern: MergeResolver = (args, ctx) => {
  const patterns = args.filter((p): p is string => typeof p === "string")
  malformed(ctx, args.filter((p) => typeof p !== "string"))
  if (!patterns.length) { return dropKey() }
  const conjunction = conjunctPatterns(patterns)
  if (conjunction !== undefined) { return conjunction }
  const report = groupReport(ctx)
  const unique = [...new Set(patterns)]
  const invalid = unique.filter((p) => !isValidPattern(p))
  if (invalid.length) { report?.("Invalid pattern is kept as an allOf fragment", invalid, { code: "pattern-invalid", keyword: "pattern" }) }
  const unsafe = unique.filter((p) => isValidPattern(p) && unsafePattern.test(p))
  if (unsafe.length) { report?.(ISSUE_MESSAGES["pattern-kept"]!, unsafe, { code: "pattern-kept", keyword: "pattern" }) }
  return asFragments(unique.map((pattern) => ({ pattern })))
}

// enum intersection with structural equality, first-seen order; undefined (contradiction) when empty.
// Linear: members are looked up in a structural set per list (VR-07). Values that are not arrays are ignored.
export const mergeEnum: MergeResolver = (args, ctx) => {
  const lists: unknown[][] = args.filter(Array.isArray)
  malformed(ctx, args.filter((v) => !Array.isArray(v)))
  if (!lists.length) { return dropKey() }
  const [first, ...rest] = lists
  const sets = rest.map((list) => {
    const set = new ValueSet()
    for (const member of list) { set.add(member) }
    return set
  })
  const result: unknown[] = []
  const seen = new ValueSet()
  for (const member of first) {
    if (!seen.add(member)) { continue }
    if (sets.every((set) => set.has(member))) { result.push(member) }
  }
  return result.length ? result : undefined
}

const asTypeArray = (type: unknown): string[] | undefined => {
  if (typeof type === "string") { return [type] }
  return Array.isArray(type) && type.length && type.every((t) => typeof t === "string") ? type : undefined
}

// type intersection over the JSON Schema type lattice (integer is a subtype of number)
export const intersectTypes = (a: string[], b: string[]): string[] => {
  const result: string[] = []
  for (const type of a) {
    let found: string | undefined
    if (b.includes(type)) {
      found = type
    } else if (type === "number" && b.includes("integer")) {
      found = "integer"
    } else if (type === "integer" && b.includes("number")) {
      found = "integer"
    }
    if (found && !result.includes(found)) {
      result.push(found)
    }
  }
  return result
}

// undefined (contradiction) when no type is left
// malformed `type` values are ignored and reported (D-6)
export const mergeTypes: MergeResolver = (args, ctx) => {
  const lists = args.map(asTypeArray)
  malformed(ctx, args.filter((_, i) => !lists[i]))
  const valid = lists.filter((list): list is string[] => !!list)
  if (!valid.length) { return dropKey() }
  const types = valid.reduce((r, v) => intersectTypes(r, v))
  return types.length === 1 ? types[0] : types.length ? types : undefined
}

// union without duplicates, first-seen order (`required`); values that are not arrays are ignored and reported
export const mergeStringItems: MergeResolver = (args, ctx) => {
  const lists = args.filter(Array.isArray)
  malformed(ctx, args.filter((v) => !Array.isArray(v)))
  return lists.length ? uniqueConcat(lists) : dropKey()
}

// compatibility export (per-key fallback of the dependencies group)
export const dependenciesMergeResolver: MergeResolver = (args) => {
  const result: Record<string, any> = {}
  const props = getAllOfItemsMap(args.filter((v) => typeof v === "object" && v !== null && !Array.isArray(v)))

  for (const prop of Object.keys(props)) {
    const items = props[prop]
    const required = items.every((v) => Array.isArray(v))

    if (required) {
      safeSet(result, prop, uniqueConcat(items))
    } else {
      const _items = items.map((v) => Array.isArray(v) ? { required: v } : v)
      safeSet(result, prop, _items.length > 1 ? { allOf: _items } : _items[0])
    }
  }

  return result
}

// plain schema conjunction: `false` wins, `true` is absorbed (unevaluatedProperties / unevaluatedItems)
export const mergeConjunction: MergeResolver = (args) => {
  if (args.includes(false)) { return false }
  const schemas = args.filter((v) => v !== true && v !== undefined)
  return !schemas.length ? true : schemas.length === 1 ? schemas[0] : { allOf: schemas }
}

const CONDITIONAL_KEYS = ["if", "then", "else"]
const conditionalEmitted = new WeakSet<object>()

// per-key fallback of the conditional group (if/then/else handed back by a custom rule, VR-39): two conditionals
// have no closed conjunction, so every item's triple is kept as an allOf fragment (emitted once per node)
export const conditionalMergeResolver: MergeResolver = (args, ctx) => {
  const items: Record<string, any>[] | undefined = ctx && Array.isArray(ctx.allOfItems) ? ctx.allOfItems : undefined
  if (!items) { return args[args.length - 1] }
  if (conditionalEmitted.has(items)) { return dropKey() }
  conditionalEmitted.add(items)
  const owners = items.filter((item) => CONDITIONAL_KEYS.some((key) => hasOwn(item, key)))
  if (owners.length > 1) { groupReport(ctx)?.(ISSUE_MESSAGES["conditional-kept"]!, owners.map((item) => item.if), { code: "conditional-kept", keyword: "if" }) }
  return asFragments(owners.map((item) => {
    const fragment: Record<string, unknown> = {}
    for (const key of CONDITIONAL_KEYS) {
      if (hasOwn(item, key)) { fragment[key] = item[key] }
    }
    return fragment
  }))
}

// Q9 (user decision 2026-11-18): a lone value of a keyword whose resolver validates its values is validated too; a
// malformed lone value is dropped and reported like a malformed value next to others. Resolver -> predicate of a
// well-formed value
export const singleValueValidators: ReadonlyMap<MergeResolver, (value: unknown) => boolean> = new Map<MergeResolver, (value: unknown) => boolean>([
  [alternative, (v) => typeof v === "boolean"],
  [and, (v) => typeof v === "boolean"],
  [minValue, isFiniteNumber],
  [maxValue, isFiniteNumber],
  [mergeNot, isSchema],
  [mergeMultipleOf, isValidMultipleOf],
  [mergeFormat, (v) => typeof v === "string"],
  [mergeOpenApiFormat, (v) => typeof v === "string"],
  [mergePattern, (v) => typeof v === "string"],
  [mergeEnum, Array.isArray],
  [mergeTypes, (v) => asTypeArray(v) !== undefined],
  [mergeStringItems, Array.isArray],
])
