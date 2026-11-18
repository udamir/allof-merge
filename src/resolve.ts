import { isObject } from "json-crawl"

import { buildPointer, isAnchorPointer, isRefNode, parsePointer, parseRef } from "./pointer.ts"
import { hasOwn } from "./safe.ts"

export type ResolveResult =
  | { ok: true, target: unknown }
  | { ok: false, reason: ResolveErrorReason }

export type ResolveErrorReason = "external" | "not-found" | "cycle" | "invalid"

export interface ResolutionIndex {
  // the document every pointer is resolved against
  readonly source: unknown
  // resolves a $ref string (normalized and cached per index); the direct target is returned, ref -> ref chains are not followed
  resolve($ref: string): ResolveResult
  // resolves a JSON pointer; intermediate $ref nodes are followed and the remaining segments are applied to their targets
  resolvePointer(pointer: string): unknown
  // JSON pointer (without "#") of the first location of `node` in `source` (breadth-first, own members only), or undefined
  pointerOf(node: object): string | undefined
}

interface WalkResult {
  ok: boolean
  value?: unknown
  reason?: ResolveErrorReason
}

const EXTERNAL: ResolveResult = { ok: false, reason: "external" }
const NOT_FOUND: ResolveResult = { ok: false, reason: "not-found" }

const decodeName = (name: string): string => {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/**
 * Resolution index: one place that knows how to turn a `$ref` into a node of `source`.
 * Every distinct ref is parsed and resolved once; results (incl. failures) are cached per index instance.
 * A pointer walk continues through intermediate `$ref` nodes with the remaining segments and
 * detects ref -> ref cycles with an identity set, so it always terminates. Only own members are followed:
 * `#/__proto__` or `#/definitions/constructor` never resolve to `Object.prototype` / `Object`.
 * Plain-name fragments (`#foo`) resolve to the node with `$anchor`/`$dynamicAnchor: "foo"` or `$id`/`id: "#foo"`
 * an unknown name is `not-found`, never the root.
 */
export const createResolutionIndex = (source: unknown): ResolutionIndex => {
  const cache = new Map<string, ResolveResult>()
  let anchors: Map<string, unknown> | undefined
  let parents: Map<object, { parent: object | undefined, key: string | number }> | undefined

  // a pointer segment that meets a $ref node re-applies itself to the (followed) target
  const walk = (pointer: string, visiting: Set<object>): WalkResult => {
    if (isAnchorPointer(pointer)) { return findAnchor(pointer) }
    const segments = parsePointer(pointer)
    let value: any = source

    for (let i = 0; i < segments.length; i++) {
      const key = segments[i]
      if (Array.isArray(value)) {
        const index = Number(key)
        if (key === "" || !Number.isInteger(index) || index < 0 || index >= value.length) { return { ok: false, reason: "not-found" } }
        value = value[index]
      } else if (isObject(value) && hasOwn(value, key)) {
        value = value[key]
      } else if (isRefNode(value)) {
        // intermediate $ref: resolve it and re-apply the current segment to the target
        const followed = follow(value, visiting)
        if (!followed.ok) { return followed }
        value = followed.value
        i--
      } else {
        return { ok: false, reason: "not-found" }
      }
    }

    return { ok: true, value }
  }

  // follows a ref -> ref chain until a non-ref node, a failure or a cycle (a loop over the chain, not recursion)
  const follow = (node: { $ref: string }, visiting: Set<object>): WalkResult => {
    let current: { $ref: string } = node
    for (;;) {
      if (visiting.has(current)) { return { ok: false, reason: "cycle" } }
      const { filePath, pointer } = parseRef(current.$ref)
      if (filePath) { return { ok: false, reason: "external" } }
      visiting.add(current)
      const result = walk(pointer, visiting)
      // the final value of a chain may itself be a $ref node: keep following until a non-ref node or a cycle
      if (result.ok && isRefNode(result.value)) {
        current = result.value
        continue
      }
      return result
    }
  }

  // nested intermediate refs recurse (walk -> follow -> walk); a pathological depth is reported as invalid
  const safeWalk = (pointer: string): WalkResult => {
    try {
      return walk(pointer, new Set())
    } catch (error) {
      if (error instanceof RangeError) { return { ok: false, reason: "invalid" } }
      throw error
    }
  }

  // breadth-first walk over own members of `source` (cycle safe), calling visit for every object
  const scan = (visit: (node: object, parent: object | undefined, key: string | number) => void) => {
    if (!isObject(source)) { return }
    const seen = new Set<object>([source])
    let queue: object[] = [source]
    visit(source, undefined, "")
    while (queue.length) {
      const next: object[] = []
      for (const node of queue) {
        const keys: (string | number)[] = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node)
        for (const key of keys) {
          const child = (node as any)[key]
          if (typeof child !== "object" || child === null || seen.has(child)) { continue }
          seen.add(child)
          visit(child, node, key)
          next.push(child)
        }
      }
      queue = next
    }
  }

  const findAnchor = (pointer: string): WalkResult => {
    if (!anchors) {
      const found = new Map<string, unknown>()
      const add = (name: unknown, node: object) => {
        if (typeof name === "string" && name && !found.has(name)) { found.set(name, node) }
      }
      scan((node) => {
        if (Array.isArray(node)) { return }
        const record = node as Record<string, unknown>
        if (hasOwn(record, "$anchor")) { add(record.$anchor, node) }
        if (hasOwn(record, "$dynamicAnchor")) { add(record.$dynamicAnchor, node) }
        for (const key of ["$id", "id"]) {
          const id = hasOwn(record, key) ? record[key] : undefined
          if (typeof id === "string" && id.length > 1 && id.charAt(0) === "#") { add(id.slice(1), node) }
        }
      })
      anchors = found
    }
    const name = decodeName(pointer)
    return anchors.has(name) ? { ok: true, value: anchors.get(name) } : { ok: false, reason: "not-found" }
  }

  const resolvePointer = (pointer: string): unknown => {
    if (!isObject(source)) { return undefined }
    const result = safeWalk(pointer)
    return result.ok ? result.value : undefined
  }

  const resolve = ($ref: string): ResolveResult => {
    let result = cache.get($ref)
    if (result) { return result }

    const { filePath, pointer, normalized } = parseRef($ref)
    result = cache.get(normalized)
    if (!result) {
      if (filePath) {
        result = EXTERNAL
      } else if (!isObject(source)) {
        result = NOT_FOUND
      } else {
        const walked = safeWalk(pointer)
        result = walked.ok ? { ok: true, target: walked.value } : { ok: false, reason: walked.reason ?? "not-found" }
      }
      cache.set(normalized, result)
    }
    cache.set($ref, result)
    return result
  }

  const pointerOf = (node: object): string | undefined => {
    if (!isObject(source)) { return undefined }
    if (!parents) {
      const map = new Map<object, { parent: object | undefined, key: string | number }>()
      scan((child, parent, key) => { map.set(child, { parent, key }) })
      parents = map
    }
    if (!parents.has(node)) { return undefined }
    const path: (string | number)[] = []
    let current: object | undefined = node
    for (;;) {
      const link = parents.get(current as object)
      if (!link || !link.parent) { break }
      path.push(link.key)
      current = link.parent
    }
    return buildPointer(path.reverse())
  }

  return { source, resolve, resolvePointer, pointerOf }
}
