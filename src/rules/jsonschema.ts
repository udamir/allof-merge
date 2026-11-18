import type { MergeRules } from "../types.ts"
import * as resolvers from "../resolvers/index.ts"
import { engine } from "../engine.ts"
import { keyOnlyRule } from "../rule-lookup.ts"

export const jsonSchemaVersion = ["draft-04", "draft-06", "draft-07", "2020-12"] as const

export type JsonSchemaVersion = typeof jsonSchemaVersion[number]

const defaultCustomRules: MergeRules = {}
const cache = new Map<JsonSchemaVersion, WeakMap<object, MergeRules>>()

const siblingKeys = ["definitions", "$defs", "$id", "$schema"]

// json-crawl < 0.6 copied a rules object (spread) for every node reached through a `/*` rule; 0.6 returns a `/*`-only
// match by reference but still spreads when an exact rule meets `/*`. An object rebuilt with Object.fromEntries keeps
// V8 fast properties, so such a copy costs ~0.1 µs instead of several µs
const fastFrozen = <T extends object>(value: T): T => Object.freeze(Object.fromEntries(Object.entries(value))) as T

/**
 * Deep-freezes a rule tree (VR-26): every plain object / array reachable through object values is frozen;
 * functions (resolvers and lazy rule thunks) are not entered, so recursive rule trees built with thunks are safe.
 * Thunks must return frozen objects themselves (the built-in ones do). An object that is already frozen is not
 * entered: it is a finished rule set (e.g. jsonSchemaMergeRules with caller-owned custom rules, which are only
 * referenced and never frozen).
 */
export const freezeRules = <T>(value: T, seen: WeakSet<object> = new WeakSet()): T => {
  if (typeof value !== "object" || value === null || seen.has(value) || Object.isFrozen(value)) { return value }
  seen.add(value)
  for (const child of Object.values(value)) { freezeRules(child, seen) }
  return Object.freeze(value)
}

const EMPTY_RULES: MergeRules = Object.freeze({})

const buildJsonSchemaMergeRules = (draft: JsonSchemaVersion, customRules: MergeRules): MergeRules => {
  // `rules` is reassigned once to the final frozen object below; the thunks close over the variable
  let rules: Record<string, any>
  // every schema-valued child shares the same (this) rules object
  const child = keyOnlyRule(() => rules)
  // a schema-valued child whose node needs its own `$`/group: built once on first use, after `rules` is complete
  const derive = (extra: Record<string, unknown>) => {
    let derived: MergeRules | undefined
    return keyOnlyRule(() => derived ?? (derived = fastFrozen({ ...rules, ...extra }) as MergeRules))
  }
  const itemsChild = keyOnlyRule(({ key }: { key: string | number }) => typeof key === "number" ? rules : EMPTY_RULES)

  // draft-04 has its own keyword table (boolean exclusive bounds, no const/propertyNames/contains/$defs);
  // draft-06, draft-07 and 2020-12 share one table that is the superset of their keywords, so a document
  // using a newer keyword than its declared draft is still merged instead of falling back to last-wins, except for
  // the tuple keywords, which are read per draft (D-18)
  const draft04 = draft === "draft-04"
  const modern = !draft04

  const builtIn: Record<string, any> = freezeRules({
    "/maximum": { $: resolvers.minValue, group: "numericBounds" },
    "/exclusiveMaximum": { $: draft04 ? resolvers.draft04ExclusiveMaximum : resolvers.minValue, group: "numericBounds" },
    "/minimum": { $: resolvers.maxValue, group: "numericBounds" },
    "/exclusiveMinimum": { $: draft04 ? resolvers.draft04ExclusiveMinimum : resolvers.maxValue, group: "numericBounds" },
    "/maxLength": { $: resolvers.minValue, group: "string" },
    "/minLength": { $: resolvers.maxValue, group: "string" },
    "/pattern": { $: resolvers.mergePattern, group: "string" },
    "/maxItems": { $: resolvers.minValue },
    "/minItems": { $: resolvers.maxValue },
    "/uniqueItems": { $: resolvers.alternative },
    "/maxProperties": { $: resolvers.minValue },
    "/minProperties": { $: resolvers.maxValue },
    "/required": { $: resolvers.mergeStringItems },
    "/multipleOf": { $: resolvers.mergeMultipleOf, group: "numericBounds" },
    "/enum": { $: resolvers.mergeEnum, group: "enumConst" },
    "/type": { $: resolvers.mergeTypes, group: "type" },
    "/allOf": {
      "/*": child,
      $: resolvers.mergeArray,
    },
    "/not": derive({ $: resolvers.mergeNot }),
    "/oneOf": {
      "/*": child,
      $: resolvers.mergeArray,
      sibling: siblingKeys,
    },
    "/anyOf": {
      "/*": child,
      $: resolvers.mergeArray,
      sibling: siblingKeys,
    },
    "/properties": {
      "/*": child,
      $: resolvers.propertiesMergeResolver,
      group: "objectShape",
    },
    "/patternProperties": {
      "/*": child,
      $: resolvers.patternPropertiesMergeResolver,
      group: "objectShape",
    },
    "/additionalProperties": derive({ $: resolvers.additionalPropertiesMergeResolver, group: "objectShape" }),
    "/items": derive({ $: resolvers.itemsMergeResolver, group: "arrayShape", "/*": itemsChild }),
    "/additionalItems": derive({ $: resolvers.additionalItemsMergeResolver, group: "arrayShape" }),
    "/dependencies": {
      "/*": child,
      $: resolvers.dependenciesMergeResolver,
      group: "dependencies",
    },
    "/nullable": { $: resolvers.and },
    "/readOnly": { $: resolvers.alternative },
    "/writeOnly": { $: resolvers.alternative },
    "/deprecated": { $: resolvers.alternative },
    "/example": { $: resolvers.mergeObjects },
    "/examples": { $: resolvers.mergeObjects },
    ...!draft04 ? {
      "/propertyNames": child,
      "/contains": derive({ $: resolvers.containsMergeResolver, group: "arrayShape" }),
      "/const": { $: resolvers.equal, group: "enumConst" },
      "/$defs": {
        "/*": child,
        $: resolvers.mergeObjects,
      },
    } : {},
    ...modern ? {
      "/if": derive({ $: resolvers.conditionalMergeResolver, group: "conditional" }),
      "/then": derive({ $: resolvers.conditionalMergeResolver, group: "conditional" }),
      "/else": derive({ $: resolvers.conditionalMergeResolver, group: "conditional" }),
      "/$comment": { $: resolvers.last },
      "/contentMediaType": { $: resolvers.last },
      "/contentEncoding": { $: resolvers.last },
    } : {},
    // D-18: `prefixItems` is the tuple keyword of 2020-12 only; draft-04/06/07 read an array `items` as the tuple and
    // `prefixItems` as an unknown keyword (the `/?` rule)
    ...draft === "2020-12" ? {
      "/prefixItems": {
        "/*": child,
        $: resolvers.prefixItemsMergeResolver,
        group: "arrayShape",
      },
    } : {},
    ...modern ? {
      "/minContains": { $: resolvers.minContainsMergeResolver, group: "arrayShape" },
      "/maxContains": { $: resolvers.maxContainsMergeResolver, group: "arrayShape" },
      "/dependentRequired": { $: resolvers.dependenciesMergeResolver, group: "dependencies" },
      "/dependentSchemas": {
        "/*": child,
        $: resolvers.dependenciesMergeResolver,
        group: "dependencies",
      },
      "/unevaluatedProperties": derive({ $: resolvers.mergeConjunction }),
      "/unevaluatedItems": derive({ $: resolvers.mergeConjunction }),
      "/contentSchema": child,
      "/$anchor": { $: resolvers.last },
      "/$dynamicAnchor": { $: resolvers.last },
      "/$dynamicRef": { $: resolvers.last },
      "/$vocabulary": { $: resolvers.mergeObjects },
    } : {},
    "/definitions": {
      "/*": child,
      $: resolvers.mergeObjects,
    },
    "/xml": { $: resolvers.mergeObjects },
    "/externalDocs": { $: resolvers.last },
    "/description": { $: resolvers.last },
    "/title": { $: resolvers.last },
    "/format": { $: resolvers.mergeFormat, group: "string" },
    "/default": { $: resolvers.last },
    "/?": { $: resolvers.last },
  })

  // the built-in entries are deep-frozen; custom rule objects belong to the caller and are only referenced
  rules = fastFrozen({
    ...builtIn,
    ...customRules,

    $: resolvers.jsonSchemaMergeResolver,
    // the tuple keyword of the draft (D-18), read by the array-shape group
    tuple: draft === "2020-12" ? "prefixItems" : "items",
    // the draft of the keyword table, read by the `simplify` rules
    draft,
  })

  return rules as MergeRules
}

// memoized per (draft, customRules) identity and frozen: the same rules object is returned for the same inputs
export const jsonSchemaMergeRules = (draft: JsonSchemaVersion = "draft-06", customRules: MergeRules = defaultCustomRules): MergeRules => {
  let byCustomRules = cache.get(draft)
  if (!byCustomRules) {
    byCustomRules = new WeakMap()
    cache.set(draft, byCustomRules)
  }
  let rules = byCustomRules.get(customRules)
  if (!rules) {
    rules = buildJsonSchemaMergeRules(draft, customRules)
    byCustomRules.set(customRules, rules)
  }
  return rules
}

// the default rules of the exported jsonSchemaMergeResolver (late-bound, see engine.ts)
engine.defaultSchemaRules = () => jsonSchemaMergeRules()
