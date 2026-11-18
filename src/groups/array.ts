import type { GroupContext, KeywordGroup } from "../types.ts"
import { deepEqual } from "../utils.ts"
import { hasOwn, safeAssign } from "../safe.ts"
import { combineSchemas, isSchemaValue } from "./common.ts"
import { ISSUE_MESSAGES } from "../issues.ts"

const KEYS = ["items", "additionalItems", "prefixItems", "contains", "minContains", "maxContains"] as const

// which keyword is the tuple (D-18): "items" (draft-04/06/07: array `items` + `additionalItems`, `prefixItems` is an
// unknown keyword), "prefixItems" (2020-12: `prefixItems` + `items` schema as the rest, an array `items` is legacy and
// kept as an allOf fragment), undefined (rule sets that do not say: both forms are read, as in 1.0 betas)
export type TupleKeyword = "items" | "prefixItems"

// the tuple keyword of a rule set: the `tuple` field of its schema rules (set by jsonSchemaMergeRules)
export const tupleKeywordOf = (rules: unknown): TupleKeyword | undefined => {
  const tuple = rules && typeof rules === "object" ? (rules as Record<string, unknown>).tuple : undefined
  return tuple === "items" || tuple === "prefixItems" ? tuple : undefined
}

interface ArrayShape {
  tuple?: unknown[]   // positional schemas (items array or prefixItems)
  tail?: unknown      // schema for positions >= tuple.length (additionalItems, items schema or 2020-12 items)
  prefix: boolean     // 2020-12 style (prefixItems / items)
}

const shapeOf = (item: Record<string, any>, mode: TupleKeyword | undefined): ArrayShape => {
  if (mode !== "items" && Array.isArray(item.prefixItems)) {
    return { tuple: item.prefixItems, tail: isSchemaValue(item.items) ? item.items : undefined, prefix: true }
  }
  if (mode !== "prefixItems" && Array.isArray(item.items)) {
    return { tuple: item.items, tail: isSchemaValue(item.additionalItems) ? item.additionalItems : undefined, prefix: false }
  }
  if (isSchemaValue(item.items)) {
    return { tuple: [], tail: item.items, prefix: mode === "prefixItems" }
  }
  return { prefix: false }
}

// 2020-12 rules: an item with an array `items` is a legacy tuple, kept whole (with its additionalItems) as a fragment
const isLegacyTuple = (item: Record<string, any>, mode: TupleKeyword | undefined): boolean => mode === "prefixItems" && Array.isArray(item.items)

const legacyFragment = (item: Record<string, any>): Record<string, unknown> => {
  const fragment: Record<string, unknown> = { items: item.items }
  if (hasOwn(item, "additionalItems")) { fragment.additionalItems = item.additionalItems }
  return fragment
}

// the shape keywords of a mode (an unknown keyword is not part of the shape)
export const shapeKeysOf = (mode: TupleKeyword | undefined): string[] =>
  mode === "items" ? ["items", "additionalItems"] : ["items", "additionalItems", "prefixItems"]

/**
 * items / additionalItems / prefixItems
 *
 * Every item is read as a tuple of positional schemas plus a tail schema for the remaining positions
 * (`items` schema = empty tuple with that tail). Position j of the result is the conjunction of each item's
 * schema for j (positional or tail); a `false` tail truncates the result tuple; the merged tail is the
 * conjunction of all tails. The tuple keyword depends on the rule set (`mode`, D-18): draft-04/06/07 write
 * `items` / `additionalItems` and ignore `prefixItems`; 2020-12 writes `prefixItems` / `items`, keeps each item with
 * an array `items` as an `allOf` fragment (`{ items, additionalItems? }`, reported through `report`) and keeps a stray
 * `additionalItems` (no 2020-12 meaning) last-wins; without a mode the `prefixItems` form is used when any item uses it.
 */
export const mergeArrayShape = (items: Record<string, any>[], mode?: TupleKeyword, report?: GroupContext["report"]): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  const legacy = items.filter((item) => isLegacyTuple(item, mode))
  const regular = legacy.length ? items.filter((item) => !isLegacyTuple(item, mode)) : items
  if (legacy.length) {
    report?.("Array-valued items is not a tuple keyword under 2020-12, kept as allOf", legacy.map((item) => item.items), { code: "tuple-kept", keyword: "items" })
    result.allOf = legacy.map(legacyFragment)
  }
  if (mode === "prefixItems") {
    const stray = regular.filter((item) => hasOwn(item, "additionalItems"))
    if (stray.length) { result.additionalItems = stray[stray.length - 1].additionalItems }
  }

  const shapes = regular.map((item) => shapeOf(item, mode)).filter((shape) => shape.tuple)
  if (!shapes.length) { return result }

  const prefix = shapes.some((shape) => shape.prefix)
  const hasTuple = regular.some((item) => (mode !== "items" && Array.isArray(item.prefixItems)) || (mode !== "prefixItems" && Array.isArray(item.items)))

  let maxLength = 0
  let limit = Infinity
  for (const shape of shapes) {
    maxLength = Math.max(maxLength, shape.tuple!.length)
    if (shape.tail === false) { limit = Math.min(limit, shape.tuple!.length) }
  }
  const length = Math.min(maxLength, limit)

  const positions: unknown[] = []
  for (let j = 0; j < length; j++) {
    const collected: unknown[] = []
    for (const shape of shapes) {
      collected.push(j < shape.tuple!.length ? shape.tuple![j] : shape.tail)
    }
    positions.push(combineSchemas(collected))
  }

  const tails = shapes.filter((shape) => shape.tail !== undefined).map((shape) => shape.tail)
  const tail = tails.length ? combineSchemas(tails) : undefined

  if (prefix) {
    if (positions.length) { result.prefixItems = positions }
    if (tail !== undefined) { result.items = tail }
  } else if (hasTuple) {
    result.items = positions
    if (tail !== undefined) { result.additionalItems = tail }
  } else if (tail !== undefined) {
    result.items = tail
  }

  return result
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0

/**
 * contains / minContains / maxContains
 *
 * `contains: A` and `contains: B` have no closed intersection form, so different `contains` are kept as
 * allOf fragments (each with its own min/maxContains). Equal `contains` keep the tightest min/maxContains; a
 * missing `minContains` counts as 1 (its default) once another item sets one (VR-15). Malformed counts are
 * ignored and reported.
 */
export const mergeContains = (items: Record<string, any>[], report?: GroupContext["report"]): Record<string, unknown> => {
  // minContains / maxContains only have an effect next to a `contains` in the same schema
  const owners = items.filter((item) => hasOwn(item, "contains"))
  const result: Record<string, unknown> = {}
  if (!owners.length) { return result }

  const count = (item: Record<string, any>, key: string): number | undefined => {
    if (!hasOwn(item, key)) { return undefined }
    if (isCount(item[key])) { return item[key] }
    report?.(`Malformed ${key} value is ignored`, [item[key]], { code: "malformed-value", keyword: key })
    return undefined
  }

  const same = owners.every((item) => deepEqual(item.contains, owners[0].contains))
  if (!same) {
    report?.(ISSUE_MESSAGES["contains-kept"]!, owners.map((item) => item.contains), { code: "contains-kept", keyword: "contains" })
    result.allOf = owners.map((item) => {
      const fragment: Record<string, unknown> = { contains: item.contains }
      const min = count(item, "minContains")
      const max = count(item, "maxContains")
      if (min !== undefined) { fragment.minContains = min }
      if (max !== undefined) { fragment.maxContains = max }
      return fragment
    })
    return result
  }

  result.contains = owners[0].contains
  const minContains = owners.map((item) => count(item, "minContains"))
  const maxContains = owners.map((item) => count(item, "maxContains")).filter((value): value is number => value !== undefined)
  if (minContains.some((value) => value !== undefined)) { result.minContains = Math.max(...minContains.map((value) => value ?? 1)) }
  if (maxContains.length) { result.maxContains = Math.min(...maxContains) }
  return result
}

export const arrayShapeGroup: KeywordGroup = {
  name: "arrayShape",
  keys: KEYS,
  resolve: ({ items, values, report, mergeRules }) => {
    const result: Record<string, unknown> = {}

    const mode = tupleKeywordOf(mergeRules)
    const shapeKeys = shapeKeysOf(mode)
    const shapeOwners = items.filter((item) => shapeKeys.some((key) => hasOwn(item, key)))
    if (shapeOwners.length === 1) {
      // tuple containers are rebuilt (positions are kept by instance), see objectShapeGroup
      for (const key of shapeKeys) {
        if (!hasOwn(values, key)) { continue }
        const value = values[key][0]
        result[key] = Array.isArray(value) ? [...value] : value
      }
    } else if (shapeOwners.length) {
      // a value that is neither a schema nor (items / prefixItems) a tuple is ignored by mergeArrayShape (D-6)
      for (const key of shapeKeys) {
        if (!hasOwn(values, key)) { continue }
        if (key === "additionalItems" && mode === "prefixItems") { continue }
        const malformed = values[key].filter((value) => !isSchemaValue(value) && !(key !== "additionalItems" && Array.isArray(value)))
        if (malformed.length) { report?.(`Malformed ${key} value is ignored`, malformed, { code: "malformed-value", keyword: key }) }
      }
      safeAssign(result, mergeArrayShape(items, mode, report))
    }

    if (hasOwn(values, "contains") || hasOwn(values, "minContains") || hasOwn(values, "maxContains")) {
      const contains = mergeContains(items, report)
      // both parts may hand back allOf fragments (legacy 2020-12 tuples, different contains)
      const fragments = [...(Array.isArray(result.allOf) ? result.allOf : []), ...(Array.isArray(contains.allOf) ? contains.allOf : [])]
      safeAssign(result, contains)
      if (fragments.length) { result.allOf = fragments }
    }

    return result
  },
}
