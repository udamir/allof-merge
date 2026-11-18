import { getNodeRules, type JsonPath } from "json-crawl"

import type { MergeRules } from "./types.ts"

/*
 * Rule lookups of the merge (the rule of a keyword at a schema node), cached where the result cannot depend on the
 * node's path or value, and contexts whose `path` is built only when it is read: json-crawl keeps deep paths lazy and
 * rebuilds them from parent links on every first read, so reading the path of every merged node made deep documents
 * O(nodes × depth).
 */

// marks a function rule whose result depends on the crawl context's `key` at most (the built-in child-rule thunks)
export const KEY_ONLY_RULE: unique symbol = Symbol("allof-merge/key-only-rule")

/** Marks a function rule whose result depends only on `ctx.key` (never on `path` or `value`), so lookups can be cached. */
export const keyOnlyRule = <T extends (...args: any[]) => unknown>(rule: T): T => {
  Object.defineProperty(rule, KEY_ONLY_RULE, { value: true })
  return rule
}

export const isKeyOnlyRule = (rule: unknown): boolean => typeof rule === "function" && (rule as any)[KEY_ONLY_RULE] === true

export const EMPTY_PATH: JsonPath = Object.freeze([]) as unknown as JsonPath

// cached keys per rules object before the table starts over (keyword names, including vendor and unknown keys)
const LOOKUP_LIMIT = 1024

// rules object -> keyword -> its rule; null when a lookup may depend on the path or value: a rules object that is not
// frozen (it may still change) or one with a function rule that is not key-only
const lookups = new WeakMap<object, Map<string, unknown> | null>()

const lookupTable = (rules: object): Map<string, unknown> | null => {
  let table = lookups.get(rules)
  if (table !== undefined) { return table }
  table = null
  if (Object.isFrozen(rules)) {
    let cacheable = true
    for (const key of Object.keys(rules)) {
      const rule = (rules as Record<string, unknown>)[key]
      if (key.charCodeAt(0) === 47 && typeof rule === "function" && !isKeyOnlyRule(rule)) {
        cacheable = false
        break
      }
    }
    if (cacheable) { table = new Map() }
  }
  lookups.set(rules, table)
  return table
}

/** json-crawl's `getNodeRules` for a keyword of a schema node; `pathOf` is called only when the result can depend on it. */
export const nodeRule = (rules: MergeRules, key: string, pathOf: () => JsonPath, value: unknown): unknown => {
  const table = lookupTable(rules)
  if (!table) { return getNodeRules(rules as any, key, pathOf(), value) }
  let rule = table.get(key)
  if (rule === undefined && !table.has(key)) {
    if (table.size >= LOOKUP_LIMIT) { table.clear() }
    rule = getNodeRules(rules as any, key, EMPTY_PATH, value)
    table.set(key, rule)
  }
  return rule
}

// where a context reads its path from: the crawl context of the node (whose `path` is lazy) or a plain object
export interface PathSource {
  readonly path?: JsonPath
}

// an own, enumerable `path` that reads the source's path on first access and can be overwritten like a data property;
// one shared accessor pair, so every context of a class keeps one hidden class
const lazyPath = <T extends object>(read: (self: T) => JsonPath): PropertyDescriptor => ({
  get(this: T) {
    const path = read(this)
    Object.defineProperty(this, "path", { value: path, writable: true, enumerable: true, configurable: true })
    return path
  },
  set(this: T, value: JsonPath) {
    Object.defineProperty(this, "path", { value, writable: true, enumerable: true, configurable: true })
  },
  enumerable: true,
  configurable: true,
})

export const pathOfSource = (source: PathSource): JsonPath => source.path ?? EMPTY_PATH

export { lazyPath }
