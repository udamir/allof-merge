import type { GroupContext, KeywordGroup } from "../types.ts"
import { isPlainObject, uniqueConcat } from "../utils.ts"
import { hasOwn, safeSet } from "../safe.ts"
import { combineSchemas, isSchemaValue } from "./common.ts"

const KEYS = ["dependencies", "dependentRequired", "dependentSchemas"] as const

type Report = GroupContext["report"]

const isNameList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string")

// own member names of the containers, first-seen order
const memberNames = (values: Record<string, any>[]): string[] => uniqueConcat(values.map((v) => Object.keys(v)))

// draft-04..07 `dependencies`: per property, arrays are united; a schema and arrays become one schema conjunction
const mergeDependencies = (values: Record<string, any>[], report: Report): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const name of memberNames(values)) {
    const entries: unknown[] = []
    for (const value of values) {
      if (!hasOwn(value, name)) { continue }
      const entry = value[name]
      if (isNameList(entry) || isSchemaValue(entry)) {
        entries.push(entry)
      } else {
        report?.("Malformed dependencies member is ignored", [entry], { code: "malformed-value", keyword: "dependencies" })
      }
    }
    if (!entries.length) { continue }
    if (entries.every((e) => Array.isArray(e))) {
      safeSet(result, name, entries.length === 1 ? entries[0] : uniqueConcat(entries as string[][]))
    } else {
      safeSet(result, name, combineSchemas(entries.map((e) => Array.isArray(e) ? { required: e } : e)))
    }
  }
  return result
}

const mergeDependentRequired = (values: Record<string, any>[], report: Report): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const name of memberNames(values)) {
    const entries: string[][] = []
    for (const value of values) {
      if (!hasOwn(value, name)) { continue }
      if (isNameList(value[name])) {
        entries.push(value[name])
      } else {
        report?.("Malformed dependentRequired member is ignored", [value[name]], { code: "malformed-value", keyword: "dependentRequired" })
      }
    }
    if (entries.length) { safeSet(result, name, entries.length === 1 ? entries[0] : uniqueConcat(entries)) }
  }
  return result
}

const mergeDependentSchemas = (values: Record<string, any>[], report: Report): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const name of memberNames(values)) {
    const entries: unknown[] = []
    for (const value of values) {
      if (!hasOwn(value, name)) { continue }
      if (isSchemaValue(value[name])) {
        entries.push(value[name])
      } else {
        report?.("Malformed dependentSchemas member is ignored", [value[name]], { code: "malformed-value", keyword: "dependentSchemas" })
      }
    }
    if (entries.length) { safeSet(result, name, combineSchemas(entries)) }
  }
  return result
}

const mergers: Record<string, (values: Record<string, any>[], report: Report) => Record<string, unknown>> = {
  dependencies: mergeDependencies,
  dependentRequired: mergeDependentRequired,
  dependentSchemas: mergeDependentSchemas,
}

/**
 * dependencies / dependentRequired / dependentSchemas
 *
 * Each keyword is merged property by property: required lists are united (first-seen order, no duplicates),
 * schemas are conjoined. Values that are not objects and malformed members are ignored and reported.
 */
export const dependenciesGroup: KeywordGroup = {
  name: "dependencies",
  keys: KEYS,
  resolve: ({ values, report }) => {
    const result: Record<string, unknown> = {}
    for (const key of KEYS) {
      if (!hasOwn(values, key)) { continue }
      const list: Record<string, any>[] = []
      for (const value of values[key]) {
        if (isPlainObject(value)) {
          list.push(value)
        } else {
          report?.(`Malformed ${key} value is ignored`, [value], { code: "malformed-value", keyword: key })
        }
      }
      if (!list.length) { continue }
      result[key] = list.length === 1 ? list[0] : mergers[key](list, report)
    }
    return result
  },
}
