import { getPatternPropertiesForMerge, getPropertiesForMerge } from "./properties"
import type { JsonSchema, MergeResolver } from "../types"
import { jsonSchemaMergeRules } from "../rules"

export const getAllOfItemsMap = (allOfItems: JsonSchema[]): Record<string, any[]> => {
  const result: Record<string, any[]> = {}

  for (const schema of allOfItems) {
    for (const key of Object.keys(schema)) {
      if (Array.isArray(result[key])) {
        result[key].push(schema[key])
      } else {
        result[key] = [schema[key]]
      }
    }
  }
  return result
}

export const jsonSchemaMergeResolver: MergeResolver = (args: any[], ctx) => {
  if (args.includes(false)) { return false }
  
  const result: Record<string, any> = {}
  const keys = getAllOfItemsMap(args)

  if ("properties" in keys) {
    keys.properties = getPropertiesForMerge(args)
    if (!keys.properties.length) {
      delete keys.properties
    }
  }

  if ("patternProperties" in keys) {
    keys.patternProperties = getPatternPropertiesForMerge(args)
    if (!keys.patternProperties.length) {
      delete keys.patternProperties
    }
  }

  for (let [key, _args] of Object.entries(keys)) {
    const rules: any = jsonSchemaMergeRules()

    let rule = `/${key}` in rules ? rules[`/${key}`] : rules["/*"]
    rule = (!("$" in rule) && "/" in rule) ? rule["/"] : rule
    rule = typeof rule === "function" ? rule() : rule
    const mergeFunc =  "$" in rule ? rule["$"] : undefined

    if (!mergeFunc) {
      throw new Error(`Merge rule not found for key: ${key}`)
    }

    const merged = _args.length > 1 ? mergeFunc(_args, { ...ctx, allOfItems: args }) : _args[0]

    if (merged === undefined) {
      throw new Error('Could not merge values of :"' + key + '". They are probably incompatible. Values: \n' + JSON.stringify(_args))
    }

    result[key] = merged
  }

  return result
}
