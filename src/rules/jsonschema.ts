import * as resolvers from "../resolvers"
import { MergeRules } from "../types"

export const jsonSchemaVersion = ["draft-04", "draft-06"] as const

export type JsonSchemaVersion = typeof jsonSchemaVersion[number]

export const jsonSchemaMergeRules = (customRules: MergeRules = {}, draft: JsonSchemaVersion = "draft-06"): MergeRules => ({
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
    "/*": () => jsonSchemaMergeRules(customRules, draft),
    $: resolvers.mergeArray,
  },
  "/not": { $: resolvers.mergeNot },
  "/oneOf": {
    "/*": () => jsonSchemaMergeRules(customRules, draft),
    $: resolvers.mergeArray,
    sibling: ["definitions", "$defs", "$id", "$schema"],
  },
  "/anyOf": {
    "/*": () => jsonSchemaMergeRules(customRules, draft),
    $: resolvers.mergeArray,
    sibling: ["definitions", "$defs", "$id", "$schema"],
  },
  "/properties": {
    "/*": () => jsonSchemaMergeRules(customRules, draft),
    $: resolvers.propertiesMergeResolver,
  },
  "/items": () => ({
    ...jsonSchemaMergeRules(customRules, draft),
    $: resolvers.itemsMergeResolver,
    "/*": ({ key }) => typeof key === 'number' ? jsonSchemaMergeRules(customRules, draft) : {},
  }),
  "/additionalProperties": () => ({ 
    ...jsonSchemaMergeRules(customRules, draft),
    "$": resolvers.additionalPropertiesMergeResolver 
  }),
  "/additionalItems": () => ({ 
    ...jsonSchemaMergeRules(customRules, draft), 
    "$": resolvers.additionalItemsMergeResolver 
  }),
  "/patternProperties": { 
    "/*": () => jsonSchemaMergeRules(customRules, draft),
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
    "/propertyNames": () => jsonSchemaMergeRules(customRules, draft),
    "/contains": () => jsonSchemaMergeRules(customRules, draft),
    "/dependencies": { 
      "/*": () => jsonSchemaMergeRules(customRules, draft),
      $: resolvers.dependenciesMergeResolver
    },
    "/const": { $: resolvers.equal },
    "/exclusiveMaximum": { $: resolvers.minValue },
    "/exclusiveMinimum": { $: resolvers.maxValue },
    "/$defs": {
      '/*': () => jsonSchemaMergeRules(customRules, draft),
      $: resolvers.mergeObjects
    },
  } : {},
  "/definitions": {
    '/*': () => jsonSchemaMergeRules(customRules, draft),
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
