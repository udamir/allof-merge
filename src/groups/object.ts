import type { GroupContext, KeywordGroup, PatternMatchLimits, ResolvedMergeSettings } from "../types"
import { isEmptyObject, isPlainObject, matchPattern, patternLimits } from "../utils"
import { hasOwn, safeSet } from "../safe"
import { combineSchemas, copyContainer, isSchemaValue } from "./common"

const KEYS = ["properties", "patternProperties", "additionalProperties"] as const

type Report = GroupContext["report"]

interface ObjectShape {
  properties?: Record<string, unknown>
  patternProperties?: Record<string, unknown>
  patterns: string[]
  additionalProperties: unknown // undefined when absent (defaults to true)
}

// a schema container (`properties` / `patternProperties`): members that are not schemas are dropped and reported
const containerOf = (item: Record<string, any>, key: string, report: Report): Record<string, unknown> | undefined => {
  if (!hasOwn(item, key)) { return undefined }
  const value = item[key]
  if (!isPlainObject(value)) {
    report?.(`Malformed ${key} value is ignored`, [value])
    return undefined
  }
  const names = Object.keys(value)
  if (names.every((name) => isSchemaValue(value[name]))) { return value }
  const container: Record<string, unknown> = {}
  for (const name of names) {
    if (isSchemaValue(value[name])) {
      safeSet(container, name, value[name])
    } else {
      report?.(`Malformed ${key} member is ignored`, [value[name]])
    }
  }
  return container
}

const shapeOf = (item: Record<string, any>, report: Report): ObjectShape => {
  const properties = containerOf(item, "properties", report)
  const patternProperties = containerOf(item, "patternProperties", report)
  let additionalProperties: unknown
  if (hasOwn(item, "additionalProperties")) {
    additionalProperties = item.additionalProperties
    if (!isSchemaValue(additionalProperties)) {
      report?.("Malformed additionalProperties value is ignored", [additionalProperties])
      additionalProperties = undefined
    }
  }
  return {
    properties,
    patternProperties,
    patterns: patternProperties ? Object.keys(patternProperties) : [],
    additionalProperties,
  }
}

// additionalProperties that does not constrain anything (absent, true or {})
const isOpen = (value: unknown): boolean => value === undefined || value === true || isEmptyObject(value)

const isListed = (shape: ObjectShape, name: string): boolean => !!shape.properties && hasOwn(shape.properties, name)

// budget of property-name x pattern tests per merged node
export const MAX_PATTERN_TESTS = 100_000

// marker: a name could not be matched against a pattern (matching disabled, length caps, unsafe pattern)
const UNKNOWN: unique symbol = Symbol("unknown")

// the object shapes of the items that carry object-shape keywords, kept as exact allOf fragments
const objectShapeFragments = (shapes: ObjectShape[]): Record<string, unknown> => {
  const fragments = shapes.map((shape) => {
    const fragment: Record<string, unknown> = {}
    if (shape.properties) { fragment.properties = shape.properties }
    if (shape.patternProperties) { fragment.patternProperties = shape.patternProperties }
    if (shape.additionalProperties !== undefined) { fragment.additionalProperties = shape.additionalProperties }
    return fragment
  })
  return { allOf: fragments }
}

/**
 * properties x patternProperties x additionalProperties (D-5, D-3)
 *
 * The result is exact (validates the same instances as the conjunction of the items):
 *
 * - patterns are kept in the merged `patternProperties`; identical patterns conjoin their schemas. For an item that
 *   lacks a pattern `p` nothing is needed when its additionalProperties is absent/true/{}; when the item has an
 *   additionalProperties schema and no patterns (and none of its listed names matches `p`), that schema is
 *   conjoined into `p`'s schema (VR-10).
 * - when some item has `additionalProperties: false` and no patterns, nothing outside its listed names is allowed:
 *   no pattern is kept and the pattern schemas are applied to the listed names directly.
 * - every other interaction of patterns with another item's additionalProperties (`false` or a schema next to
 *   other patterns, VR-11) has no closed form without synthesized lookahead/difference patterns, so the object
 *   shapes are kept as `allOf` fragments.
 * - a listed name receives, per item, its own property schema, the item's matching pattern schemas when those
 *   are not kept, else the item's additionalProperties schema; a name forbidden by an item is dropped (the merged
 *   additionalProperties is `false` and no kept pattern matches it).
 *
 * Property names are matched against patterns only within the limits of `settings.matchPatterns` and never for
 * patterns with nested quantifiers (ReDoS, VR-02); when a needed match cannot be run, the shapes are kept as
 * `allOf` fragments too.
 */
export const mergeObjectShape = (
  items: Record<string, any>[],
  settings?: Pick<ResolvedMergeSettings, "matchPatterns">,
  report?: Report,
): Record<string, unknown> => {
  const shapes = items.map((item) => shapeOf(item, report)).filter((shape) =>
    shape.properties || shape.patternProperties || shape.additionalProperties !== undefined)
  const result: Record<string, unknown> = {}
  if (!shapes.length) { return result }
  const limits: false | Required<PatternMatchLimits> = patternLimits(settings)

  // at most MAX_PATTERN_TESTS name x pattern tests per node (VR-07); beyond that the shapes are kept as fragments
  let tests = 0
  const match = (pattern: string, name: string): boolean | typeof UNKNOWN => {
    if (++tests > MAX_PATTERN_TESTS) { return UNKNOWN }
    return matchPattern(pattern, name, limits) ?? UNKNOWN
  }

  const hasPatterns = shapes.some((shape) => shape.patterns.length)
  // some item forbids every name it does not list and has no patterns: no pattern survives
  const closed = hasPatterns && shapes.some((shape) => shape.additionalProperties === false && !shape.patterns.length)

  // patternProperties
  const patternSchemas = new Map<string, unknown[]>()
  if (hasPatterns && !closed) {
    for (const shape of shapes) {
      for (const pattern of shape.patterns) {
        const list = patternSchemas.get(pattern)
        if (list) {
          list.push(shape.patternProperties![pattern])
        } else {
          patternSchemas.set(pattern, [shape.patternProperties![pattern]])
        }
      }
    }
    for (const [pattern, schemas] of patternSchemas) {
      for (const shape of shapes) {
        if (shape.patterns.includes(pattern) || isOpen(shape.additionalProperties)) { continue }
        // `false` or a schema next to other patterns: no exact single-shape form
        if (shape.patterns.length || shape.additionalProperties === false) { return objectShapeFragments(shapes) }
        for (const name of shape.properties ? Object.keys(shape.properties) : []) {
          const matched = match(pattern, name)
          if (matched === UNKNOWN || matched) { return objectShapeFragments(shapes) }
        }
        schemas.push(shape.additionalProperties)
      }
    }
  }

  // properties: per name only the items that list it and the items whose additionalProperties (or, in the closed
  // case, whose patterns) can affect it are visited, so many single-property items merge in linear time (VR-07)
  const listing = new Map<string, number[]>()
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i]
    if (!shape.properties) { continue }
    for (const name of Object.keys(shape.properties)) {
      const list = listing.get(name)
      if (list) {
        list.push(i)
      } else {
        listing.set(name, [i])
      }
    }
  }
  const constraining: number[] = []
  for (let i = 0; i < shapes.length; i++) {
    if (!isOpen(shapes[i].additionalProperties) || (closed && shapes[i].patterns.length)) { constraining.push(i) }
  }

  const properties: Record<string, unknown> = {}
  let count = 0
  for (const [name, listedBy] of listing) {
    const collected: unknown[] = []
    let forbidden = false
    // listedBy and constraining are ascending: visit their union in item order
    let a = 0
    let b = 0
    while (a < listedBy.length || b < constraining.length) {
      let index: number
      if (b >= constraining.length || (a < listedBy.length && listedBy[a] <= constraining[b])) {
        index = listedBy[a++]
        if (b < constraining.length && constraining[b] === index) { b++ }
      } else {
        index = constraining[b++]
      }
      const shape = shapes[index]
      const listed = isListed(shape, name)
      if (listed) { collected.push(shape.properties![name]) }
      // kept patterns apply through the merged patternProperties; the item's additionalProperties only matters for
      // names it does not list, and only when it constrains something
      if (!closed && (listed || isOpen(shape.additionalProperties))) { continue }
      let matched = false
      for (const pattern of shape.patterns) {
        const found = match(pattern, name)
        if (found === UNKNOWN) { return objectShapeFragments(shapes) }
        if (!found) { continue }
        matched = true
        // no pattern is kept in the closed case: apply it to the name directly
        if (closed) { collected.push(shape.patternProperties![pattern]) }
      }
      if (matched || listed) { continue }
      if (shape.additionalProperties === false) {
        forbidden = true
        break
      }
      if (!isOpen(shape.additionalProperties)) {
        collected.push(shape.additionalProperties)
      }
    }
    if (forbidden) { continue }
    safeSet(properties, name, combineSchemas(collected))
    count++
  }

  if (count) { result.properties = properties }
  if (patternSchemas.size) {
    const patternProperties: Record<string, unknown> = {}
    for (const [pattern, schemas] of patternSchemas) {
      safeSet(patternProperties, pattern, combineSchemas(schemas))
    }
    result.patternProperties = patternProperties
  }

  // additionalProperties
  const additional = shapes.filter((shape) => shape.additionalProperties !== undefined).map((shape) => shape.additionalProperties)
  if (additional.length) {
    result.additionalProperties = combineSchemas(additional)
  }

  return result
}

export const objectShapeGroup: KeywordGroup = {
  name: "objectShape",
  keys: KEYS,
  resolve: ({ items, values, settings, report }) => {
    // fast path: a single item owns all object-shape keys, nothing to combine
    let owner = -1
    let owners = 0
    for (let i = 0; i < items.length; i++) {
      if (KEYS.some((key) => hasOwn(items[i], key))) {
        owner = i
        owners++
      }
    }
    if (owners === 1) {
      // the containers are rebuilt (their members are kept by instance) so that a merged node never shares its
      // `properties` object with the node it was merged from
      const result: Record<string, unknown> = {}
      for (const key of KEYS) {
        if (!hasOwn(values, key)) { continue }
        const value = items[owner][key]
        result[key] = key !== "additionalProperties" && isPlainObject(value) ? copyContainer(value) : value
      }
      return result
    }
    return mergeObjectShape(items, settings, report)
  },
}
