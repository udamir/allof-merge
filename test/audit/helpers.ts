import { expect } from "vite-plus/test"
import Ajv from "ajv"
import Ajv2020 from "ajv/dist/2020.js"
import type { JsonPath } from "json-crawl"

import { merge as mergeSource, type MergeOptions } from "../../src/index.ts"

// typed wrapper: merge() returns unknown, tests want to inspect the result freely
export const merge = (data: unknown, options?: MergeOptions): any => mergeSource(data, options)

export type Schema = any

export interface MergeReport {
  result: any
  mergeErrors: { message: string, path: JsonPath, values: any[] }[]
  refErrors: { message: string, path: JsonPath, ref: string }[]
}

// merge wrapper that records every onMergeError / onRefResolveError call
export const mergeReport = (data: unknown, options: MergeOptions = {}): MergeReport => {
  const report: MergeReport = { result: undefined, mergeErrors: [], refErrors: [] }
  report.result = merge(data, {
    onMergeError: (message, path, values) => report.mergeErrors.push({ message, path, values }),
    onRefResolveError: (message, path, ref) => report.refErrors.push({ message, path, ref }),
    ...options,
  })
  return report
}

// ajv is used as the semantic oracle: the merged schema must accept and reject exactly the same instances as the original
const ajvOptions = { strict: false, allErrors: false, validateSchema: false, validateFormats: false }

export const compile = (schema: Schema, draft: "07" | "2020" = "07") => {
  const ajv = draft === "2020" ? new Ajv2020(ajvOptions) : new Ajv(ajvOptions)
  return ajv.compile(schema)
}

export const expectSameValidation = (original: Schema, merged: Schema, instances: unknown[], draft: "07" | "2020" = "07") => {
  const validateOriginal = compile(original, draft)
  const validateMerged = compile(merged, draft)
  for (const instance of instances) {
    expect({ instance, valid: validateMerged(instance) }).toEqual({ instance, valid: validateOriginal(instance) })
  }
}

export const expectAccepts = (schema: Schema, instances: unknown[], draft: "07" | "2020" = "07") => {
  const validate = compile(schema, draft)
  for (const instance of instances) {
    expect({ instance, valid: validate(instance) }).toEqual({ instance, valid: true })
  }
}

export const expectRejects = (schema: Schema, instances: unknown[], draft: "07" | "2020" = "07") => {
  const validate = compile(schema, draft)
  for (const instance of instances) {
    expect({ instance, valid: validate(instance) }).toEqual({ instance, valid: false })
  }
}

// merge + check equivalence against the original in one call
export const expectMergeEquivalent = (original: Schema, instances: unknown[], options: MergeOptions = {}, draft: "07" | "2020" = "07") => {
  const result = merge(clone(original), options)
  expectSameValidation(original, result, instances, draft)
  return result
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

export const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as any)) {
      deepFreeze(child)
    }
  }
  return value
}

// walks a (possibly cyclic) value and returns every path whose key matches
export const findKeys = (value: unknown, key: string, path: string[] = [], seen = new Set<unknown>(), found: string[] = []): string[] => {
  if (!value || typeof value !== "object" || seen.has(value)) { return found }
  seen.add(value)
  for (const [k, v] of Object.entries(value as any)) {
    if (k === key) { found.push([...path, k].join("/")) }
    findKeys(v, key, [...path, k], seen, found)
  }
  return found
}

export const hasNoAllOf = (value: unknown): boolean => findKeys(value, "allOf").length === 0

// collects every object reachable from value (cycle safe)
export const collectObjects = (value: unknown, seen = new Set<object>()): Set<object> => {
  if (!value || typeof value !== "object" || seen.has(value)) { return seen }
  seen.add(value)
  for (const child of Object.values(value as any)) {
    collectObjects(child, seen)
  }
  return seen
}

export const sharesReferences = (a: unknown, b: unknown): boolean => {
  const objectsOfA = collectObjects(a)
  for (const obj of collectObjects(b)) {
    if (objectsOfA.has(obj)) { return true }
  }
  return false
}

export const isJsonSerializable = (value: unknown): boolean => {
  try {
    JSON.stringify(value)
    return true
  } catch {
    return false
  }
}

export const expectIdempotent = (data: Schema, options: MergeOptions = {}) => {
  const once = merge(clone(data), options)
  const twice = merge(clone(once), options)
  expect(twice).toEqual(once)
  return once
}
