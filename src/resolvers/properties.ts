import { mergeObjectShape } from "../groups/object"
import { combineSchemas } from "../groups/common"
import { getAllOfItemsMap } from "./jsonschema"
import type { JsonSchema, MergeContext, MergeResolver } from "../types"
import { asFragments, type Fragments } from "../utils"
import { hasOwn, safeSet } from "../safe"
import { groupReport } from "./basic"

// merged `properties` of the items as a one-element list (compatibility export; empty when no property survives)
export const getPropertiesForMerge = (allOfItems: JsonSchema[]): any[] => {
  const { properties } = mergeObjectShape(allOfItems)
  return properties ? [properties] : []
}

// merged `patternProperties` of the items as a one-element list (compatibility export)
export const getPatternPropertiesForMerge = (allOfItems: JsonSchema[]): any[] => {
  const { patternProperties } = mergeObjectShape(allOfItems)
  return patternProperties ? [patternProperties] : []
}

/*
 * Per-key fallbacks, used when a custom `$` on one of properties / patternProperties / additionalProperties hands
 * the object-shape group back to the per-key table (VR-39). They consult every item of the node (ctx.allOfItems)
 * through the group algorithm, so the result is the same as the group's for the keys without a custom rule
 * (patterns are matched within the limits of the call's `matchPatterns` setting). When the group keeps the object shapes as allOf fragments, the
 * first fallback that runs for the node emits them and the others drop their key.
 */
const shapes = new WeakMap<object, { merged: Record<string, unknown>, emitted: boolean }>()

const objectShapeOf = (items: Record<string, any>[], ctx: MergeContext) => {
  let entry = shapes.get(items)
  if (!entry) {
    entry = { merged: mergeObjectShape(items, ctx.settings, groupReport(ctx)), emitted: false }
    shapes.set(items, entry)
  }
  return entry
}

const shapeKey = (key: string, args: any[], ctx: MergeContext | undefined, legacy: () => unknown): unknown | Fragments => {
  if (!ctx || !Array.isArray(ctx.allOfItems)) { return legacy() }
  const entry = objectShapeOf(ctx.allOfItems, ctx)
  if (hasOwn(entry.merged, "allOf")) {
    if (entry.emitted) { return asFragments([]) }
    entry.emitted = true
    return asFragments(entry.merged.allOf as unknown[])
  }
  return hasOwn(entry.merged, key) ? entry.merged[key] : asFragments([])
}

// property-wise conjunction (direct calls without a context)
const memberwise = (args: any[]): Record<string, any> => {
  const result: Record<string, any> = {}
  const props = getAllOfItemsMap(args.filter((v) => typeof v === "object" && v !== null && !Array.isArray(v)))
  for (const prop of Object.keys(props)) {
    safeSet(result, prop, combineSchemas(props[prop]))
  }
  return result
}

export const propertiesMergeResolver: MergeResolver = (args, ctx) => shapeKey("properties", args, ctx, () => memberwise(args))

export const patternPropertiesMergeResolver: MergeResolver = (args, ctx) => shapeKey("patternProperties", args, ctx, () => memberwise(args))

// `false` wins, `true` is absorbed, schemas are conjoined (with a context: the object-shape group's value)
export const additionalPropertiesMergeResolver: MergeResolver = (args, ctx) => shapeKey("additionalProperties", args, ctx, () => combineSchemas(args))
