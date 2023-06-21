import * as resolvers from "../resolvers"
import { MergeRules } from "../types"

export const jsonSchemaMergeRules = (draft: string = "06"): MergeRules => ({
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
    "/*": () => jsonSchemaMergeRules(draft),
    $: resolvers.mergeArray,
  },
  "/not": { $: resolvers.mergeNot },
  "/oneOf": {
    "/*": () => jsonSchemaMergeRules(draft),
    $: resolvers.mergeArray,
  },
  "/anyOf": {
    "/*": () => jsonSchemaMergeRules(draft),
    $: resolvers.mergeArray,
  },
  "/properties": {
    "/*": () => jsonSchemaMergeRules(draft),
    $: resolvers.propertiesMergeResolver,
  },
  "/items": {
    "/": () => ({
      ...jsonSchemaMergeRules(draft),
      "$": resolvers.itemsMergeResolver,
    }),
    "/*": () => jsonSchemaMergeRules(draft),
  },
  "/additionalProperties": () => ({ 
    ...jsonSchemaMergeRules(draft),
    "$": resolvers.additionalPropertiesMergeResolver 
  }),
  "/additionalItems": () => ({ 
    ...jsonSchemaMergeRules(draft), 
    "$": resolvers.additionalItemsMergeResolver 
  }),
  "/patternProperties": { 
    "/*": () => jsonSchemaMergeRules(draft),
    $: resolvers.propertiesMergeResolver,
  },
  "/pattern": { $: resolvers.mergePattern },
  "/nullable": { $: resolvers.alternative },
  "/discriminator": { $: resolvers.mergeObjects },
  "/readOnly": { $: resolvers.alternative },
  "/writeOnly": { $: resolvers.alternative },
  "/example": { $: resolvers.mergeObjects },
  "/examples": { $: resolvers.mergeObjects },
  "/deprecated": { $: resolvers.alternative },
  ...draft === "06" ? { 
    "/propertyNames": () => jsonSchemaMergeRules(draft),
    "/contains": () => jsonSchemaMergeRules(draft),
    "/dependencies": { 
      "/*": () => jsonSchemaMergeRules(draft),
      $: resolvers.dependenciesMergeResolver
    },
    "/const": { $: resolvers.equal },
    "/exclusiveMaximum": { $: resolvers.minValue },
    "/exclusiveMinimum": { $: resolvers.maxValue },
    "/definitions": {
      '/*': () => jsonSchemaMergeRules(draft),
    },
  } : {},
  "/xml": { $: resolvers.mergeObjects },
  // "/externalDocs": { $: last },
  // "/description": { $: last },
  // "/title": { $: last },
  // "/format": { $: last },
  // "/default": { $: last },
  "/*": { $: resolvers.last },
  "/defs": {
    '/*': () => jsonSchemaMergeRules(draft),
  },
  $: resolvers.jsonSchemaMergeResolver,
})
