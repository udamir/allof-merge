import { isPlainObject } from "../utils.ts"
import { safeClone } from "../safe.ts"
import { freshNode } from "../fresh.ts"

// conjunction of schema values: `false` wins, `true` is absorbed, a single schema is kept by instance,
// several schemas become an allOf node that the clone pass merges with the rules of its location
export const combineSchemas = (schemas: unknown[]): unknown => {
  const list: unknown[] = []
  for (const schema of schemas) {
    if (schema === false) { return false }
    if (schema === true || schema === undefined) { continue }
    if (!list.includes(schema)) { list.push(schema) }
  }
  if (!list.length) { return true }
  if (list.length === 1) { return list[0] }
  return freshNode({ allOf: list })
}

export const isSchemaValue = (value: unknown): boolean => typeof value === "boolean" || isPlainObject(value)

// copy container -> original container; set by the single-owner fast paths so that the merge hook can clone a
// copy from the original's finished output instead of re-walking every member
export const containerOrigin = new WeakMap<object, object>()

// shallow copy of a `properties`-like container, remembered as a copy of `original`
export const copyContainer = <T extends Record<string, unknown>>(original: T): T => {
  const copy = safeClone(original)
  containerOrigin.set(copy, original)
  return copy
}
