/*
 * Draft-07 reading of `$ref` siblings shared by the oracle of the test suite and the benchmark (no dependencies).
 */

// keywords whose values are instances, not schemas: never rewritten
const INSTANCE_KEYWORDS = new Set(["enum", "const", "default", "examples", "example"])

/**
 * The library reads the siblings of `$ref` as applying next to the reference in every draft (D-24, author intent),
 * while a draft-04/06/07 validator ignores them. Before a draft-07 schema is validated, every schema object with a
 * `$ref` and other members is rewritten into the same reading: the `$ref` moves to the end of the node's `allOf`
 * (`{ $ref: A, maxLength: 3 }` -> `{ maxLength: 3, allOf: [{ $ref: A }] }`). Members stay where they were, so every
 * pointer into the node (siblings, earlier allOf items) still resolves. Applied to the original and to the merged
 * output alike (the output may keep a `$ref` with siblings, read the same way). Returns a new value.
 */
export const withRefSiblingsApplied = (schema: unknown): unknown => {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) { return value.map(walk) }
    if (typeof value !== "object" || value === null) { return value }
    const node = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    const keys = Object.keys(node)
    const ref = typeof node.$ref === "string" && keys.length > 1 ? node.$ref : undefined
    for (const key of keys) {
      if (ref !== undefined && key === "$ref") { continue }
      const child = INSTANCE_KEYWORDS.has(key) ? node[key] : walk(node[key])
      Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true })
    }
    if (ref !== undefined) {
      const allOf = Array.isArray(result.allOf) ? [...result.allOf, { $ref: ref }] : [{ $ref: ref }]
      Object.defineProperty(result, "allOf", { value: allOf, enumerable: true, writable: true, configurable: true })
    }
    return result
  }
  return walk(schema)
}
