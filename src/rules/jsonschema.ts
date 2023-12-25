import type { MergeRules } from "../types"
import * as resolvers from "../resolvers"

export const jsonSchemaVersion = ["draft-04", "draft-06"] as const

export type JsonSchemaVersion = typeof jsonSchemaVersion[number]

export const jsonSchemaMergeRules = (draft: JsonSchemaVersion = "draft-06", customRules: MergeRules = {}): MergeRules => ({
  "/maximum": { $: resolvers.minValue },
  "/exclusiveMaximum": { $: resolvers.alternative },
  "/minimum": { $: resolvers.maxValue },
  "/exclusiveMinimum": { $: resolvers.alternative },
  "/maxLength": { $: resolvers.minValue },
  "/minLength": { $: resolvers.maxValue },
  "/maxItems": { $: resolvers.minValue },
  "/minItems": { $: resolvers.maxValue },
  "/uniqueItems": { $: resolvers.alternative },
  "/maxProperties": { $: resolvers.minValue },
  "/minProperties": { $: resolvers.maxValue },
  "/required": { $: resolvers.mergeStringItems },
  "/multipleOf": { $: resolvers.mergeMultipleOf },
  "/enum": { $: resolvers.mergeEnum },
  "/type": { $: resolvers.mergeTypes },
  "/allOf": {
    "/*": () => jsonSchemaMergeRules(draft, customRules),
    $: resolvers.mergeArray,
  },
  "/not": { $: resolvers.mergeNot },
  "/oneOf": {
    "/*": () => jsonSchemaMergeRules(draft, customRules),
    $: resolvers.mergeArray,
    sibling: ["definitions", "$defs", "$id", "$schema"],
  },
  "/anyOf": {
    "/*": () => jsonSchemaMergeRules(draft, customRules),
    $: resolvers.mergeArray,
    sibling: ["definitions", "$defs", "$id", "$schema"],
  },
  "/properties": {
    "/*": () => jsonSchemaMergeRules(draft, customRules),
    $: resolvers.propertiesMergeResolver,
  },
  "/items": () => ({
    ...jsonSchemaMergeRules(draft, customRules),
    $: resolvers.itemsMergeResolver,
    "/*": ({ key }) => typeof key === 'number' ? jsonSchemaMergeRules(draft, customRules) : {},
  }),
  "/additionalProperties": () => ({ 
    ...jsonSchemaMergeRules(draft, customRules),
    "$": resolvers.additionalPropertiesMergeResolver 
  }),
  "/additionalItems": () => ({ 
    ...jsonSchemaMergeRules(draft, customRules), 
    "$": resolvers.additionalItemsMergeResolver 
  }),
  "/patternProperties": { 
    "/*": () => jsonSchemaMergeRules(draft, customRules),
    $: resolvers.propertiesMergeResolver,
  },
  "/pattern": { $: resolvers.mergePattern },
  // "/nullable": { $: resolvers.alternative },
  "/readOnly": { $: resolvers.alternative },
  "/writeOnly": { $: resolvers.alternative },
  "/example": { $: resolvers.mergeObjects },
  "/examples": { $: resolvers.mergeObjects },
  "/deprecated": { $: resolvers.alternative },
  ...draft !== "draft-04" ? { 
    "/propertyNames": () => jsonSchemaMergeRules(draft, customRules),
    "/contains": () => jsonSchemaMergeRules(draft, customRules),
    "/dependencies": { 
      "/*": () => jsonSchemaMergeRules(draft, customRules),
      $: resolvers.dependenciesMergeResolver
    },
    "/const": { $: resolvers.equal },
    "/exclusiveMaximum": { $: resolvers.minValue },
    "/exclusiveMinimum": { $: resolvers.maxValue },
    "/$defs": {
      '/*': () => jsonSchemaMergeRules(draft, customRules),
      $: resolvers.mergeObjects
    },
  } : {},
  "/definitions": {
    '/*': () => jsonSchemaMergeRules(draft, customRules),
    $: resolvers.mergeObjects
  },
  "/xml": { $: resolvers.mergeObjects },
  "/externalDocs": { $: resolvers.last },
  "/description": { $: resolvers.last },
  "/title": { $: resolvers.last },
  "/format": { $: resolvers.last },
  "/default": { $: resolvers.last }, 
  "/?": { $: resolvers.last },
  ...customRules,

  $: resolvers.jsonSchemaMergeResolver,
})
