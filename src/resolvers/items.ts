import { mergeArrayShape, mergeContains, tupleKeywordOf } from "../groups/array"
import { combineSchemas } from "../groups/common"
import type { MergeContext, MergeResolver } from "../types"
import { asFragments } from "../utils"
import { hasOwn } from "../safe"
import { groupReport } from "./basic"

/*
 * Per-key fallbacks, used when a custom `$` on one of the array-shape keys hands the group back to the per-key
 * table (VR-39). The whole item list is consulted (`items` cannot be merged without the other items'
 * `additionalItems`, `minContains` belongs to its `contains`), so the result is the group's for the keys without
 * a custom rule.
 */
const fromItems = (ctx: MergeContext | undefined) => ctx && Array.isArray(ctx.allOfItems) ? ctx.allOfItems : undefined

// the shape merge of one item list, shared by the per-key fallbacks of that list (fragments are handed out once)
const shaped = new WeakMap<object, Record<string, unknown>>()

const arrayShapeKey = (key: string, args: any[], ctx: MergeContext | undefined, legacy: () => unknown) => {
  const items = fromItems(ctx)
  if (!items) { return legacy() }
  let merged = shaped.get(items)
  if (!merged) {
    merged = mergeArrayShape(items, tupleKeywordOf(ctx?.mergeRules), groupReport(ctx))
    shaped.set(items, merged)
  }
  // 2020-12 legacy tuple fragments (D-18) travel with `items` (present whenever an item has an array `items`)
  const fragments = key === "items" && Array.isArray(merged.allOf) ? merged.allOf : []
  if (hasOwn(merged, key)) { return fragments.length ? asFragments(fragments, { value: merged[key] }) : merged[key] }
  return asFragments(fragments)
}

export const itemsMergeResolver: MergeResolver = (args, ctx) => arrayShapeKey("items", args, ctx, () => combineSchemas(args))

export const prefixItemsMergeResolver: MergeResolver = (args, ctx) => arrayShapeKey("prefixItems", args, ctx, () => args[args.length - 1])

export const additionalItemsMergeResolver: MergeResolver = (args, ctx) => arrayShapeKey("additionalItems", args, ctx, () => combineSchemas(args))

// contains: different `contains` are kept as allOf fragments (with their own min/maxContains)
const contained = new WeakMap<object, Record<string, unknown>>()
const containsOf = (items: Record<string, any>[], ctx: MergeContext | undefined) => {
  let merged = contained.get(items)
  if (!merged) {
    merged = mergeContains(items, groupReport(ctx))
    contained.set(items, merged)
  }
  return merged
}

export const containsMergeResolver: MergeResolver = (args, ctx) => {
  const items = fromItems(ctx)
  if (!items) { return args.length === 1 ? args[0] : asFragments(args.map((contains) => ({ contains }))) }
  const merged = containsOf(items, ctx)
  return hasOwn(merged, "allOf") ? asFragments(merged.allOf as unknown[]) : hasOwn(merged, "contains") ? merged.contains : asFragments([])
}

const containsCount = (key: "minContains" | "maxContains", legacy: MergeResolver): MergeResolver => (args, ctx) => {
  const items = fromItems(ctx)
  if (!items) { return legacy(args, ctx) }
  const merged = containsOf(items, ctx)
  // in fragment mode the counts travel with their `contains`
  return hasOwn(merged, key) ? merged[key] : asFragments([])
}

export const minContainsMergeResolver: MergeResolver = containsCount("minContains", (args) => Math.max(...args))
export const maxContainsMergeResolver: MergeResolver = containsCount("maxContains", (args) => Math.min(...args))
