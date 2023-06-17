import { JsonPath, SyncCloneHook, isObject, syncClone } from "json-crawl"

import { buildPointer, isEqual, isRefNode, resolveRefNode } from "./utils"
import { jsonSchemaMergeResolver } from "./resolvers"
import { MergeContext, MergeOptions } from "./types"
import { jsonSchemaMergeRules } from "./rules"

const flattenAllOf = (items: any[], source: any): any[] => {
  // allOf: [{ allOf: [a,b], c }] => allOf: [a, b, c]

  const result: any[] = []
  for (const item of items) {
    if (!isObject(item)) {
      // error, object expected
      continue
    }

    if (!item.allOf || !Array.isArray(item.allOf)) { 
      // TODO skip non-array allOf 
      result.push(item)
      continue
    }

    const { allOf, ...sibling } = item
    const allOfItems = Object.keys(sibling).length ? [sibling, ...allOf] : allOf
    const resolvedAllOfItems = allOfItems.map((item) => isRefNode(item) ? resolveRefNode(source, item) : item)
    result.push(...flattenAllOf(resolvedAllOfItems, source))
  }

  return result
}

export const removeDuplicates = <T>(array: T[]): T[] => {
  const uniqueItems: T[] = [];

  for (const item of array) {
    if (!uniqueItems.some((uniqueItem) => isEqual(uniqueItem, item))) {
      uniqueItems.push(item);
    }
  }

  return uniqueItems;
}

const getAllOfRule = (path: JsonPath, rules: any) => {

  for (const key of path) {
    let _key = `/${key}`
    if (!(_key in rules)) {
      _key = "/*"
    }

    rules = rules[_key]
    rules = typeof rules === "function" ? rules() : rules
    
    if (!rules) { return }
  }

  if ("/" in rules) {
    rules = rules["/"]
    rules = typeof rules === "function" ? rules() : rules
  }

  return rules["/allOf"]
} 

const findNodeToDelete = (path: JsonPath): [string, number] | undefined => {
  for (let i = path.length - 2; i >= 0; i--) {
    if ((path[i] === "anyOf" || path[i] === "oneOf")) {
      const _path = path.slice(0, i+1)
      return [JSON.stringify(_path), path[i+1] as number]
    }
  }
  return
}

export const allOfResolverHook = (options?: MergeOptions): SyncCloneHook<{}> => {

  const resolvedCache = new Map<string, any>() 
  const nodeToDelete: Map<string, number> = new Map()
  let source = options?.source
  const mergeRules = options?.rules || jsonSchemaMergeRules()

  return (value, ctx) => {
    // save root value as source if source is not defined
    if (!ctx.path.length && !options?.source) {
      source = value
    }

    // check if current node is JsonSchema 
    const rules = getAllOfRule(ctx.path, mergeRules)

    // console.log(ctx.path, `JsonSchema: ${!!rules}`)

    const exitHook = () => {
      const { node } = ctx.state
      const strPath = JSON.stringify(ctx.path)
      if (nodeToDelete.has(strPath)) {
        const key = nodeToDelete.get(strPath)!
        if (Array.isArray(node[ctx.key])) {
          if (node[ctx.key].length < 2) {
            throw new Error('Could not merge values of :"' + key + '". They are probably incompatible')
            // options?.onMergeError?.('Could not merge values. They are probably incompatible', ctx.path, (value as any)?.allOf)
          }
          node[ctx.key].splice(key, 1)
        }
      }
      if ("anyOf" in node) {
        node.anyOf = removeDuplicates(node.anyOf)
      }
      if ("oneOf" in node) {
        node.oneOf = removeDuplicates(node.oneOf)
      }
    }

    if (!rules) { return { value, exitHook } }

    // skip if no allOf
    if (!isObject(value) || !value.allOf) { 
      return { value, exitHook }
    }

    const pointer = buildPointer(ctx.path)
    if (resolvedCache.has(pointer)) {
      return { value: resolvedCache.get(pointer) }
    }

    const { allOf, ...sibling } = value

    // remove allOf from scheam if is wrong type or empty
    if (!Array.isArray(allOf) || !allOf.length) {
      return { value: sibling, exitHook }
    }

    const allOfItems = Object.keys(sibling).length ? [...allOf, sibling] : allOf
    const resolvedAllOfItems = allOfItems.map((item) => isRefNode(item) ? resolveRefNode(source, item) : item)

    try {
      const _ctx: MergeContext = {
        allOfItems: [],
        mergeRules,
        mergeError: (msg, values) => options?.onMergeError?.(msg, ctx.path, values)
      }
      const mergedNode = jsonSchemaMergeResolver(flattenAllOf(resolvedAllOfItems, source), _ctx)
      return { value: mergedNode, exitHook }
    } catch (error) {
      const args = findNodeToDelete(ctx.path)
      if (args) {
        nodeToDelete.set(...args)
        return { exitHook }
      }
      throw error
    }
  }
}

export const merge = (value: any, options?: MergeOptions) => {

  const hook = allOfResolverHook(options)

  return syncClone(value, hook, {})
}