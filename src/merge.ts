import { JsonPath, SyncCloneHook, isObject, syncClone } from "json-crawl"

import { buildPointer, isAnyOfNode, isOneOfNode, isRefNode, parseRef, removeDuplicates, resolvePointer } from "./utils"
import { MergeError, MergeOptions, MergeRules } from "./types"
import { mergeCombinarySibling } from "./resolvers/combinary"
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

    // skip if not object
    if (!isObject(value)) { 
      return { value, exitHook }
    }
    
    // check if in current node extected allOf merge in rules
    if (!ctx.rules || !ctx.rules["/allOf"] || !( "$" in ctx.rules["/allOf"])) { return { value, exitHook } }

    const { allOf = [], ...sibling } = value

    // remove allOf from scheam if is wrong type
    if (!Array.isArray(allOf)) {
      return { value: sibling, exitHook }
    }

    const _allOf = [...allOf]

    if (!_allOf.length) {
      if (options?.mergeRefSibling && isRefNode(sibling)) {
        // create allOf from $ref and sibling if mergeRefSibling option
        Object.keys(sibling).length > 1 && _allOf.push(sibling)
      } else if (options?.mergeCombinarySibling && isAnyOfNode(sibling) && ctx.rules["/anyOf"]) {
        return { value: mergeCombinarySibling(sibling, "anyOf", ctx.rules["/anyOf"]), exitHook }
      } else if (options?.mergeCombinarySibling && isOneOfNode(sibling) && ctx.rules["/oneOf"]) {
        return { value: mergeCombinarySibling(sibling, "oneOf", ctx.rules["/oneOf"]), exitHook }
      }
    } else if (Object.keys(sibling).length) {
      // include sibling to allOf
      _allOf.push(sibling)
    }

    if (!_allOf.length) {
      return { value, exitHook }
    }
    
    const allOfItems = normalizeAllOfItems(_allOf, source, allOfRefs, buildPointer(ctx.path))

    // remove allOf from schema if it is empty or has single item
    if (allOfItems.length < 2) {
      return { value: allOfItems.length ? allOfItems[0] : {}, exitHook }
    }

    const mergedNode = jsonSchemaMergeResolver(allOfItems, { allOfItems, mergeRules: ctx.rules, mergeError })

    if (options?.mergeCombinarySibling && isAnyOfNode(mergedNode)) {
      return { value: mergeCombinarySibling(mergedNode, "anyOf", ctx.rules["/anyOf"]), exitHook }
    } else if (options?.mergeCombinarySibling && isOneOfNode(mergedNode)) {
      return { value: mergeCombinarySibling(mergedNode, "oneOf", ctx.rules["/oneOf"]), exitHook }
    } else {
      return { value: mergedNode, exitHook }
    }
  }
}

const normalizeAllOfItems = (allOfItems: any[], source: any, allOfRefs: AllOfRef[], pointer: string): any[] => {
  const resolvedAllOfItems = []
  
  const _allOfRef: AllOfRef = { pointer, data: "", refs: [] }

  for (const item of allOfItems) {
    // resolve $ref
    if (isRefNode(item)) {

      if (_allOfRef.data === "") {
        _allOfRef.data = JSON.stringify(allOfItems)
      }

      const ref = allOfRefs.find((allOfRef) => allOfRef.refs.includes(item.$ref) && allOfRef.data === _allOfRef.data && pointer !== allOfRef.pointer)
      if (ref) { return [{ $ref: "#" + ref.pointer }] }

      const { $ref, ...rest } = item

      _allOfRef.refs.push($ref)

      const _ref = parseRef($ref)
      const value = !_ref.filePath ? resolvePointer(source, _ref.pointer) : undefined

      if (value !== undefined) {
        // TODO: raise $ref resolve error
        resolvedAllOfItems.push(value)
      } 

      if (Object.keys(rest).length) {
        resolvedAllOfItems.push(rest)
      }
    } else {
      resolvedAllOfItems.push(item)
    }
  }

  if (_allOfRef.refs.length) {
    allOfRefs.push(_allOfRef)
  }

  const items = flattenAllOf(resolvedAllOfItems)
  if (items.find((item) => isRefNode(item))) {
    return normalizeAllOfItems(items, source, allOfRefs, pointer)
  }

  return items
}

const flattenAllOf = (items: any[]): any[] => {
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
      result.push(...flattenAllOf(allOfItems))
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
