import { expectSameValidation, type Schema } from "./helpers.ts"

// property names that exercise the patterns used by the object-shape tests
const SAMPLE_NAMES = ["a", "ab", "b", "x", "xa", "x1", "x12", "foo", "foo1", "foo123", "bar", "barx", "barx1", "bar123", "common", "root",
  "allof1", "allowed123", "allowed456", "allowed789", "z99", "name", "name1", "foo_long", "x_long", "$x", "$", "constructor", "__proto__"]
const SAMPLE_VALUES: unknown[] = [null, "", "a", "abcdefg", "abcdefghi", "abcdefghijk", 0, 1, 6, 8, 1.5, true, {}, []]

const collectNames = (value: unknown, names: Set<string>, seen = new Set<unknown>()) => {
  if (!value || typeof value !== "object" || seen.has(value)) { return }
  seen.add(value)
  for (const key of ["properties", "patternProperties", "dependencies", "dependentSchemas", "dependentRequired"]) {
    const container = (value as any)[key]
    if (container && typeof container === "object" && !Array.isArray(container)) {
      for (const name of Object.keys(container)) { names.add(name) }
    }
  }
  if (Array.isArray((value as any).required)) {
    for (const name of (value as any).required) { if (typeof name === "string") { names.add(name) } }
  }
  for (const child of Object.values(value as any)) { collectNames(child, names, seen) }
}

const instance = (entries: [string, unknown][]): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return result
}

// object instances: {}, every name with every sample value, and every pair of names
export const objectInstances = (schema: Schema): unknown[] => {
  const names = new Set<string>(SAMPLE_NAMES)
  collectNames(schema, names)
  const list = [...names]
  const result: unknown[] = [{}, null, "a", 1, []]
  for (const name of list) {
    for (const value of SAMPLE_VALUES) { result.push(instance([[name, value]])) }
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      result.push(instance([[list[i], "abcdefghi"], [list[j], 8]]))
    }
  }
  return result
}

// merged ≡ original over generated object instances (ajv draft-07 unless told otherwise)
export const expectSameObjectValidation = (original: Schema, merged: Schema, draft: "07" | "2020" = "07") => {
  expectSameValidation(original, merged, objectInstances(original), draft)
}
