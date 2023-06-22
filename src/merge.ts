import { JsonPath, SyncCloneHook, isObject, syncClone } from "json-crawl"

import { buildPointer, findMergeRules, isRefNode, removeDuplicates, resolveRefNode } from "./utils"
import { MergeError, MergeOptions, MergeRules } from "./types"
import { jsonSchemaMergeResolver } from "./resolvers"
import { jsonSchemaMergeRules } from "./rules"
import { ErrorMessage } from "./errors"

export const merge = (value: any, options?: MergeOptions) => {
  return syncClone(value, allOfResolverHook(options), {})
}

export const allOfResolverHook = (options?: MergeOptions): SyncCloneHook<{}> => {

  const resolvedCache = new Map<string, any>() 
  const nodeToDelete: Map<string, number> = new Map()
  let source = options?.source
  const rules: MergeRules = options?.rules || jsonSchemaMergeRules() 

  return (value, ctx) => {
    // save root value as source if source is not defined
    if (!ctx.path.length && !options?.source) {
      source = value
    }

    const mergeError: MergeError = (values) => {
      // check if merge error in anyOf/oneOf combination node
      const args = findNodeToDelete(ctx.path)
      if (args) {
        nodeToDelete.set(...args)
      } else {
        options?.onMergeError?.(ErrorMessage.mergeError(), ctx.path, values)
      }
    }

    const exitHook = () => {
      const { node } = ctx.state
      const strPath = JSON.stringify(ctx.path)
      if (nodeToDelete.has(strPath)) {
        const key = nodeToDelete.get(strPath)!
        if (Array.isArray(node[ctx.key])) {
          if (node[ctx.key].length < 2) {
            mergeError((<any>value)?.allOf || [])
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

    // skip if no allOf
    if (!isObject(value) || !value.allOf) { 
      return { value, exitHook }
    }
    
    // check if in current node extected allOf merge in rules
    const mergeRules = findMergeRules(ctx.path, rules)
    if (!mergeRules || !mergeRules["/allOf"] || !mergeRules["/allOf"].$) { return { value, exitHook } }

    const pointer = buildPointer(ctx.path)
    if (resolvedCache.has(pointer)) {
      return { value: resolvedCache.get(pointer) }
    }

    const { allOf, ...sibling } = value

    // remove allOf from scheam if is wrong type or empty
    if (!Array.isArray(allOf) || !allOf.length) {
      return { value: sibling, exitHook }
    }

    const allOfItems = normalizeAllOfItems(value, source)
    const mergedNode = jsonSchemaMergeResolver(allOfItems, { allOfItems, mergeRules, mergeError })
    
    return { value: mergedNode, exitHook }
  }
}

const normalizeAllOfItems = (item: any, source: any) => {
  const { allOf, ...sibling } = item
  const allOfItems = Object.keys(sibling).length ? [...allOf, sibling] : allOf as any[]
  const resolvedAllOfItems = allOfItems.map((item) => isRefNode(item) ? resolveRefNode(source, item) : item)
  return flattenAllOf(resolvedAllOfItems, source)
}

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
    } else {
      result.push(...normalizeAllOfItems(item, source))
    }
  }

  return result
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
