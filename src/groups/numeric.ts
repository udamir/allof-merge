import type { GroupContext, KeywordGroup } from "../types.ts"
import { isValidMultipleOf, lcmOf } from "../utils.ts"
import { hasOwn, safeAssign } from "../safe.ts"

const KEYS = ["minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum", "multipleOf"] as const

type Report = GroupContext["report"]

interface Bound {
  value: number
  exclusive: boolean
}

interface Side {
  bound?: Bound          // minimum/maximum with its draft-04 boolean flag
  flagSeen: boolean      // some item carried the boolean flag
  flagOnly: boolean      // some item carried the boolean flag without a bound (OR fallback)
  numeric?: number       // draft-06+ numeric exclusive bound
}

// a lower bound is tighter when larger; an upper bound when smaller; equal values are exclusive if any is
const tighter = (current: Bound | undefined, next: Bound, lower: boolean): Bound => {
  if (!current) { return next }
  if (next.value === current.value) { return current.exclusive || next.exclusive ? { value: next.value, exclusive: true } : current }
  return (lower ? next.value > current.value : next.value < current.value) ? next : current
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

const collect = (items: Record<string, any>[], boundKey: string, exclusiveKey: string, lower: boolean, report?: Report): Side => {
  const side: Side = { flagSeen: false, flagOnly: false }
  for (const item of items) {
    let value = hasOwn(item, boundKey) ? item[boundKey] : undefined
    let exclusive = hasOwn(item, exclusiveKey) ? item[exclusiveKey] : undefined
    if (value !== undefined && !isFiniteNumber(value)) {
      report?.(`Malformed ${boundKey} value is ignored`, [value], { code: "malformed-value", keyword: boundKey })
      value = undefined
    }
    if (exclusive !== undefined && !isFiniteNumber(exclusive) && typeof exclusive !== "boolean") {
      report?.(`Malformed ${exclusiveKey} value is ignored`, [exclusive], { code: "malformed-value", keyword: exclusiveKey })
      exclusive = undefined
    }
    if (typeof exclusive === "number") {
      side.numeric = side.numeric === undefined ? exclusive : lower ? Math.max(side.numeric, exclusive) : Math.min(side.numeric, exclusive)
    }
    if (typeof exclusive === "boolean") { side.flagSeen = true }
    if (typeof value === "number") {
      side.bound = tighter(side.bound, { value, exclusive: exclusive === true }, lower)
    } else if (exclusive === true) {
      side.flagOnly = true
    }
  }
  return side
}

const write = (result: Record<string, unknown>, side: Side, boundKey: string, exclusiveKey: string) => {
  if (side.bound) {
    result[boundKey] = side.bound.value
    if (side.numeric === undefined && side.flagSeen) { result[exclusiveKey] = side.bound.exclusive }
  }
  if (side.numeric !== undefined) {
    result[exclusiveKey] = side.numeric
  } else if (!side.bound && side.flagSeen) {
    result[exclusiveKey] = side.flagOnly
  }
}

/**
 * multipleOf: the least common multiple when it can be computed exactly (finite positive values, at most 15
 * decimal digits, safe-integer arithmetic); otherwise the distinct values are kept as allOf fragments and the
 * problem is reported. Values that are not finite positive numbers are ignored and reported (VR-01, D-6).
 */
export const mergeMultipleOfValues = (values: unknown[], report?: Report): Record<string, unknown> => {
  const valid: number[] = []
  for (const value of values) {
    if (isValidMultipleOf(value)) {
      if (!valid.includes(value)) { valid.push(value) }
    } else {
      report?.("Malformed multipleOf value is ignored", [value], { code: "malformed-value", keyword: "multipleOf" })
    }
  }
  if (!valid.length) { return {} }
  if (valid.length === 1) { return { multipleOf: valid[0] } }
  const lcm = lcmOf(valid)
  if (lcm !== undefined) { return { multipleOf: lcm } }
  report?.("Could not compute the least common multiple of multipleOf values exactly, kept as allOf", valid, { code: "multipleof-kept", keyword: "multipleOf" })
  return { allOf: valid.map((multipleOf) => ({ multipleOf })) }
}

// minimum/maximum with draft-04 boolean flags or draft-06+ numeric exclusive bounds (see numericBoundsGroup)
export const mergeNumericBounds = (items: Record<string, any>[], report?: Report): Record<string, unknown> => {
  const lower = collect(items, "minimum", "exclusiveMinimum", true, report)
  const upper = collect(items, "maximum", "exclusiveMaximum", false, report)

  const result: Record<string, unknown> = {}
  write(result, lower, "minimum", "exclusiveMinimum")
  write(result, upper, "maximum", "exclusiveMaximum")
  return result
}

/**
 * minimum / exclusiveMinimum / maximum / exclusiveMaximum / multipleOf
 *
 * Draft-06+ numeric exclusive bounds are merged as independent keywords (tightest value); draft-04 boolean
 * flags travel with the bound they belong to, so the flag of a bound that lost is not applied to the winner.
 * An empty interval (minimum > maximum) is kept as it is: it is equivalent and keeps the other keywords visible.
 * Malformed values are ignored and reported.
 */
export const numericBoundsGroup: KeywordGroup = {
  name: "numericBounds",
  keys: KEYS,
  resolve: ({ items, values, report }) => {
    const result = mergeNumericBounds(items, report)
    if (hasOwn(values, "multipleOf")) { safeAssign(result, mergeMultipleOfValues(values.multipleOf, report)) }
    return result
  },
}
