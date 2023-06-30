import { JsonPath, SyncCloneHook, isObject, syncClone } from "json-crawl"

import { buildPointer, isRefNode, removeDuplicates, resolveRefNode } from "./utils"
import { MergeError, MergeOptions, MergeRules } from "./types"
import { jsonSchemaMergeResolver } from "./resolvers"
import { jsonSchemaMergeRules } from "./rules"
import { ErrorMessage } from "./errors"

export const merge = (value: any, options?: MergeOptions) => {
  const rules: MergeRules = options?.rules || jsonSchemaMergeRules() 
  return syncClone(value, allOfResolverHook(options), { rules })
}

interface AllOfRef {
  pointer: string
  data: string
  refs: string[]
}

export const allOfResolverHook = (options?: MergeOptions): SyncCloneHook<{}> => {
 
  const nodeToDelete: Map<string, number> = new Map()
  let source = options?.source

  /**
   * Map of cycle nodes paths (used for enableCircular mode)
   * key    - pointer to source node
   * value  - path to cycle node
   */
  const allOfRefs: AllOfRef[] = []

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
      const strPath = buildPointer(ctx.path)
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
    if (!ctx.rules || !ctx.rules["/allOf"] || !( "$" in ctx.rules["/allOf"])) { return { value, exitHook } }

    const { allOf, ...sibling } = value

    // remove allOf from scheam if is wrong type or empty
    if (!Array.isArray(allOf) || !allOf.length) {
      return { value: sibling, exitHook }
    }

    const allOfItems = normalizeAllOfItems(value, source, allOfRefs, buildPointer(ctx.path))
    const mergedNode = jsonSchemaMergeResolver(allOfItems, { allOfItems, mergeRules: ctx.rules, mergeError })
    
    return { value: mergedNode, exitHook }
  }
}

const normalizeAllOfItems = (item: any, source: any, allOfRefs: AllOfRef[], pointer: string): any[] => {
  const { allOf, ...sibling } = item
  const allOfItems = Object.keys(sibling).length ? [...allOf, sibling] : allOf as any[]
  const resolvedAllOfItems = []
  
  const _allOfRef: AllOfRef = { pointer, data: "", refs: [] }

  for (const item of allOfItems) {
    if (isRefNode(item)) {

      if (_allOfRef.data === "") {
        _allOfRef.data = JSON.stringify(allOfItems)
      }

      const ref = allOfRefs.find((allOfRef) => allOfRef.refs.includes(item.$ref) && allOfRef.data === _allOfRef.data && pointer !== allOfRef.pointer)
      if (ref) { return [{ $ref: "#" + ref.pointer }] }

      _allOfRef.refs.push(item.$ref)
      resolvedAllOfItems.push(resolveRefNode(source, item))
    } else {
      resolvedAllOfItems.push(item)
    }
  }

  if (_allOfRef.refs.length) {
    allOfRefs.push(_allOfRef)
  }

  const items = flattenAllOf(resolvedAllOfItems, source)
  if (items.find((item) => isRefNode(item))) {
    return normalizeAllOfItems({ allOf: items }, source, allOfRefs, pointer)
  }

  return items
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
      const { allOf, ...sibling } = item
      const allOfItems = Object.keys(sibling).length ? [...allOf, sibling] : allOf as any[]
      result.push(...flattenAllOf(allOfItems, source))
    }
  }

  return result
}

const findNodeToDelete = (path: JsonPath): [string, number] | undefined => {
  for (let i = path.length - 2; i >= 0; i--) {
    if ((path[i] === "anyOf" || path[i] === "oneOf")) {
      const _path = path.slice(0, i+1)
      return [buildPointer(_path), path[i+1] as number]
    }
  }
  return
}
