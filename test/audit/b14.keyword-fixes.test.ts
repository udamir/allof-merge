import { describe, it, expect } from "vite-plus/test"
import {
  calculateGCD, calculateLCM, deepEqual, findCombinations, findMultiplierForInteger, graphapiMergeRules, hasNestedQuantifier,
  jsonSchemaMergeRules, keywordGroups, lcmOf, mergeValues, openApiJsonSchemaMergeRules, openApiMergeRules, regexpCacheSize,
  testPattern, uniqueConcat, REGEXP_CACHE_SIZE,
} from "../../src/index.ts"
import * as allResolvers from "../../src/resolvers/index.ts"
const resolvers: any = allResolvers
import { clone, compile, deepFreeze, expectSameValidation, merge, mergeReport } from "./helpers.ts"
import { expectSameObjectValidation } from "./b14.oracle.ts"

// merges a deep-frozen copy, checks it against ajv on object instances and returns the result
const mergeChecked = (schema: any, options: any = {}, draft: "07" | "2020" = "07") => {
  const result = merge(deepFreeze(clone(schema)), options)
  expectSameObjectValidation(schema, result, draft)
  return result
}

const timed = <T>(fn: () => T): { value: T, ms: number } => {
  const start = performance.now()
  const value = fn()
  return { value, ms: performance.now() - start }
}

const oas30 = (schema: any, options: any = {}) => merge({ openapi: "3.0.0", components: { schemas: { A: schema } } }, options).components.schemas.A
const oas30Report = (schema: any) => {
  const report = mergeReport({ openapi: "3.0.0", components: { schemas: { A: schema } } })
  return { ...report, result: report.result.components.schemas.A }
}

describe("B14.1 patternProperties x additionalProperties", () => {
  it("B14.1.1 another item's additionalProperties schema is conjoined into kept patterns", () => {
    const schema = { allOf: [{ patternProperties: { "^x": { type: "string" } } }, { additionalProperties: { minLength: 2 } }] }
    const result = mergeChecked(schema)
    expect(result).toEqual({ patternProperties: { "^x": { type: "string", minLength: 2 } }, additionalProperties: { minLength: 2 } })
    expect(compile(result)({ x: "a" })).toBe(false)
  })

  it("B14.1.2 additionalProperties next to properties applies to the pattern when no listed name matches it", () => {
    const schema = { allOf: [{ patternProperties: { "^x": { type: "number" } } }, { properties: { a: {} }, additionalProperties: { type: "string" } }] }
    const result = mergeChecked(schema)
    expect(compile(result)({ xa: 1 })).toBe(false)
    expect(result.patternProperties["^x"]).toEqual(false)
  })

  it("B14.1.3 a listed name matching the pattern keeps the shapes as fragments", () => {
    const schema = { allOf: [{ patternProperties: { "^x": { type: "string" } } }, { properties: { xa: { type: "string" } }, additionalProperties: { minLength: 2 } }] }
    const result = mergeChecked(schema)
    expect(result.allOf).toHaveLength(2)
    expect(compile(result)({ xa: "a" })).toBe(true)
  })

  it("B14.1.4 patterns of two closed items are kept as fragments (no synthesized lookahead)", () => {
    const schema = { allOf: [{ patternProperties: { "^a": {} }, additionalProperties: false }, { patternProperties: { "b$": {} }, additionalProperties: false }] }
    const result = mergeChecked(schema)
    expect(result).toEqual({ allOf: [
      { patternProperties: { "^a": {} }, additionalProperties: false },
      { patternProperties: { "b$": {} }, additionalProperties: false },
    ] })
    expect(compile(result)({ ab: 1 })).toBe(true)
    expect(JSON.stringify(result)).not.toContain("(?=")
  })

  it("B14.1.5 identical patterns of closed items merge their schemas", () => {
    const schema = { allOf: [
      { properties: { a: {} }, patternProperties: { "^x": { type: "string" } }, additionalProperties: false },
      { properties: { xb: {} }, patternProperties: { "^x": { minLength: 1 } }, additionalProperties: false },
    ] }
    const result = mergeChecked(schema)
    expect(result).toEqual({ properties: { xb: {} }, patternProperties: { "^x": { type: "string", minLength: 1 } }, additionalProperties: false })
  })

  it("B14.1.6 additionalProperties: false without patterns applies the pattern schemas to listed names", () => {
    const schema = { allOf: [{ properties: { x1: {}, y: {} }, additionalProperties: false }, { patternProperties: { "^x": { type: "string" } }, additionalProperties: { type: "number" } }] }
    const result = mergeChecked(schema)
    expect(result).toEqual({ properties: { x1: { type: "string" }, y: { type: "number" } }, additionalProperties: false })
  })

  it("B14.1.7 a schema additionalProperties next to own patterns keeps fragments", () => {
    const schema = { allOf: [{ patternProperties: { "^a": { type: "string" } }, additionalProperties: { type: "number" } }, { patternProperties: { "^b": { minLength: 1 } } }] }
    const result = mergeChecked(schema)
    expect(result.allOf).toHaveLength(2)
  })
})

describe("B14.2 bounded pattern matching", () => {
  const evil = "^(a+)+$"
  const name = "a".repeat(30) + "!"

  it("B14.2.1 an evil pattern against a 30-char name finishes quickly and is kept as fragments", () => {
    const schema = { allOf: [{ patternProperties: { [evil]: {} }, additionalProperties: false }, { properties: { [name]: {} } }] }
    const { value, ms } = timed(() => merge(clone(schema)))
    expect(ms).toBeLessThan(1000)
    expect(value.allOf).toHaveLength(2)
  })

  it("B14.2.2 nested quantifier heuristic", () => {
    for (const p of ["^(a+)+$", "(a*)*", "(a|aa)+", "(.*a){10}", "((a+))+", "(?:a+)+"]) { expect([p, hasNestedQuantifier(p)]).toEqual([p, true]) }
    for (const p of ["^x-", "^[a-z]+$", "(ab)+", "\\(a+\\)+", "[(a+)]+", ".+\\d{2,}$", "(a+)?"]) { expect([p, hasNestedQuantifier(p)]).toEqual([p, false]) }
  })

  it("B14.2.3 matchPatterns: false and length caps fall back to fragments", () => {
    const schema = { allOf: [{ properties: { x1: {} }, additionalProperties: false }, { patternProperties: { "^x": { type: "string" } } }] }
    const fallback = (options: any) => {
      const result = merge(clone(schema), options)
      expectSameObjectValidation(schema, result)
      return result
    }
    expect(fallback({}).properties).toEqual({ x1: { type: "string" } })
    expect(fallback({ matchPatterns: false }).allOf).toHaveLength(2)
    expect(fallback({ matchPatterns: { maxPatternLength: 1 } }).allOf).toHaveLength(2)
    expect(fallback({ matchPatterns: { maxNameLength: 1 } }).allOf).toHaveLength(2)
  })

  it("B14.2.5 10k patterns x 10k names stays within the per-node test budget", () => {
    const patternProperties: any = {}
    const properties: any = {}
    for (let i = 0; i < 10000; i++) {
      patternProperties[`^q${i}$`] = {}
      properties[`n${i}`] = {}
    }
    const { value, ms } = timed(() => merge({ allOf: [{ patternProperties }, { properties, additionalProperties: false }] }))
    expect(value.allOf).toHaveLength(2)
    expect(ms).toBeLessThan(3000)
  })

  it("B14.2.4 the compiled pattern cache is bounded (LRU)", () => {
    for (let i = 0; i < REGEXP_CACHE_SIZE + 500; i++) { testPattern(`^p${i}$`, "x") }
    expect(regexpCacheSize()).toBeLessThanOrEqual(REGEXP_CACHE_SIZE)
    expect(testPattern("^a", "ab")).toBe(true)
  })
})

describe("B14.3 OpenAPI 3.0 nullable", () => {
  it("B14.3.1 nullable true ∧ typed item without nullable is not nullable", () => {
    expect(oas30({ allOf: [{ type: "string", nullable: true }, { type: "string" }] })).toEqual({ type: "string" })
  })

  it("B14.3.2 an item without type does not restrict null (OAS 3.0.3)", () => {
    expect(oas30({ allOf: [{ type: "string", nullable: true }, { minLength: 1 }] })).toEqual({ type: "string", nullable: true, minLength: 1 })
    expect(oas30({ allOf: [{ type: "string", nullable: true }, { nullable: true }] })).toEqual({ type: "string", nullable: true })
  })

  it("B14.3.3 the allOf-$ref + nullable sibling idiom no longer yields a nullable result", () => {
    const doc = { openapi: "3.0.0", components: { schemas: {
      Base: { type: "object", properties: { a: { type: "string" } } },
      A: { allOf: [{ $ref: "#/components/schemas/Base" }], nullable: true },
    } } }
    expect(merge(doc).components.schemas.A).toEqual({ type: "object", properties: { a: { type: "string" } } })
  })

  it("B14.3.4 both nullable with conflicting types: only null remains", () => {
    expect(oas30({ allOf: [{ type: "string", nullable: true }, { type: "number", nullable: true }] })).toEqual({ type: "string", nullable: true, enum: [null] })
    expect(oas30({ allOf: [{ type: "string", nullable: true, enum: ["a", null] }, { type: "number", nullable: true }] }))
      .toEqual({ type: "string", nullable: true, enum: ["a", null], allOf: [{ enum: [null] }] })
  })

  it("B14.3.5 conflicting types with one non-nullable item are a contradiction", () => {
    const { result, mergeErrors } = oas30Report({ allOf: [{ type: "string", nullable: true }, { type: "number" }] })
    expect(result).toBe(false)
    expect(mergeErrors.length).toBeGreaterThan(0)
  })

  it("B14.3.6 integer ∧ nullable number", () => {
    expect(oas30({ allOf: [{ type: "integer", nullable: true }, { type: "number", nullable: true }] })).toEqual({ type: "integer", nullable: true })
    expect(oas30({ allOf: [{ type: "integer", nullable: true }, { type: "number", nullable: false }] })).toEqual({ type: "integer", nullable: false })
  })

  it("B14.3.7 JSON Schema and GraphApi rules keep their nullable semantics", () => {
    expect(merge({ allOf: [{ type: "string", nullable: true }, { type: "string" }] })).toEqual({ type: "string", nullable: true })
    const graph = merge({ graphapi: "1.0", components: { schemas: { A: { allOf: [{ type: "string", nullable: false }, { nullable: true }] } } } })
    expect(graph.components.schemas.A).toEqual({ type: "string", nullable: true })
  })
})

describe("B14.4 format", () => {
  it("B14.4.1 numeric lattice picks the narrower format (OpenAPI rule sets only)", () => {
    expect(oas30({ allOf: [{ type: "integer", format: "int64" }, { format: "int32" }] })).toEqual({ type: "integer", format: "int32" })
    expect(oas30({ allOf: [{ type: "number", format: "float" }, { format: "double" }] })).toEqual({ type: "number", format: "float" })
    // the JSON Schema rules treat int32 vs int64 as a contradiction
    expect(merge({ allOf: [{ format: "int32" }, { format: "int64" }] })).toBe(false)
  })

  it("B14.4.2 other differing formats are a contradiction and reported", () => {
    const { result, mergeErrors } = mergeReport({ allOf: [{ type: "string", format: "email" }, { format: "date" }] })
    expect(result).toBe(false)
    expect(mergeErrors).toHaveLength(1)
    expect(mergeErrors[0].values).toEqual(["email", "date"])
    expect(merge({ allOf: [{ format: "uuid" }, { format: "uuid" }] })).toEqual({ format: "uuid" })
  })
})

describe("B14.5 minContains default", () => {
  it("B14.5.1 missing minContains counts as 1 when contains are equal", () => {
    const schema = { allOf: [{ contains: { type: "number" }, minContains: 0 }, { contains: { type: "number" } }] }
    const result = merge(clone(schema), { rules: jsonSchemaMergeRules("2020-12") })
    expect(result).toEqual({ contains: { type: "number" }, minContains: 1 })
    // checked by hand: ajv 2020 on plain arrays without tuple items is reliable
    expectSameValidation(schema, result, [[], [1], ["a"], [1, 2]], "2020")
  })
})

describe("B14.6 multipleOf", () => {
  const mo = (a: unknown, b: unknown) => {
    const { value, ms } = timed(() => mergeReport({ allOf: [{ multipleOf: a }, { multipleOf: b }] }))
    expect(ms).toBeLessThan(1000)
    return value
  }

  it("B14.6.1 malformed values are ignored and reported (terminates)", () => {
    for (const bad of ["abc", {}, true, null, 0, -2, NaN, Infinity]) {
      const { result, mergeErrors } = mo(bad, 2)
      expect(result).toEqual({ multipleOf: 2 })
      expect(mergeErrors.length).toBeGreaterThan(0)
    }
  })

  it("B14.6.2 values that cannot be combined exactly are kept as fragments", () => {
    for (const [a, b] of [[0.5, 1e308], [1e200, 3e200], [1e-300, 2], [2, 1 / 3], [5e-324, 2], [2 ** 53, 3]]) {
      const { result, mergeErrors } = mo(a, b)
      expect(result).toEqual({ allOf: [{ multipleOf: a }, { multipleOf: b }] })
      expect(mergeErrors).toHaveLength(1)
    }
  })

  it("B14.6.3 exact decimal and integer least common multiples", () => {
    expect(mo(0.07, 0.03).result).toEqual({ multipleOf: 0.21 })
    expect(merge({ allOf: [{ multipleOf: 0.5 }, { multipleOf: 0.75 }, { multipleOf: 1.25 }] })).toEqual({ multipleOf: 7.5 })
    expect(mo(4, 6).result).toEqual({ multipleOf: 12 })
    expect(mo(3, 3).result).toEqual({ multipleOf: 3 })
  })

  it("B14.6.4 utils never loop and never throw", () => {
    expect(findMultiplierForInteger(5e-324)).toBe(Infinity)
    expect(findMultiplierForInteger(NaN)).toBe(Infinity)
    expect(findMultiplierForInteger(0.25)).toBe(100)
    expect(calculateLCM([0.5, 1e308])).toBeNaN()
    expect(calculateLCM([2, 3])).toBe(6)
    expect(calculateGCD(12, 18)).toBe(6)
    expect(lcmOf([0, 2])).toBeUndefined()
    expect(lcmOf([-2, 3])).toBeUndefined()
  })
})

describe("B14.7 malformed keyword values", () => {
  const cases: [string, any, any][] = [
    ["required: true", { allOf: [{ required: true }, { required: ["a"] }] }, { required: ["a"] }],
    ["required: null", { allOf: [{ required: ["a"] }, { required: null }] }, { required: ["a"] }],
    ["enum: null", { allOf: [{ enum: [1, 2] }, { enum: null }] }, { enum: [1, 2] }],
    ["not: null", { allOf: [{ not: { type: "string" } }, { not: null }] }, { not: { type: "string" } }],
    ["pattern: true", { allOf: [{ pattern: "^a" }, { pattern: true }] }, { pattern: "^a" }],
    ["multipleOf: true", { allOf: [{ multipleOf: 3 }, { multipleOf: true }] }, { multipleOf: 3 }],
    ["minLength: 'x'", { allOf: [{ minLength: 2 }, { minLength: "x" }] }, { minLength: 2 }],
    ["minimum: '1'", { allOf: [{ minimum: 2 }, { minimum: "1" }] }, { minimum: 2 }],
    ["maxItems: null", { allOf: [{ maxItems: 2 }, { maxItems: null }] }, { maxItems: 2 }],
    ["type: []", { allOf: [{ type: "string" }, { type: [] }] }, { type: "string" }],
    ["properties: null", { allOf: [{ properties: { a: { type: "string" } } }, { properties: null }] }, { properties: { a: { type: "string" } } }],
    ["dependencies: 1", { allOf: [{ dependencies: { a: ["b"] } }, { dependencies: 1 }] }, { dependencies: { a: ["b"] } }],
    ["format: 1", { allOf: [{ format: "date" }, { format: 1 }] }, { format: "date" }],
  ]
  for (const [name, schema, expected] of cases) {
    it(`B14.7 ${name}: ignored, valid parts merged, reported`, () => {
      const { result, mergeErrors } = mergeReport(clone(schema))
      expect(result).toEqual(expected)
      expect(mergeErrors.length).toBeGreaterThan(0)
    })
  }

  it("B14.7 anyOf/oneOf: true | null | {} never throw in the utils", () => {
    expect(findCombinations([[1, 2], true as any, [3]])).toEqual([[1, 3], [2, 3]])
    expect(findCombinations([null as any, {} as any])).toEqual([[]])
    for (const bad of [true, null, {}]) {
      expect(() => merge({ allOf: [{ anyOf: [{ type: "string" }] }, { anyOf: bad }, { oneOf: bad }, { oneOf: [{ minLength: 1 }] }] })).not.toThrow()
    }
  })
})

describe("B14.8 deep values (utils part)", () => {
  const nested = (depth: number, leaf: any) => {
    let value: any = leaf
    for (let i = 0; i < depth; i++) { value = { a: value } }
    return value
  }

  it("B14.8.1 deepEqual and mergeValues handle 10 000 levels", () => {
    expect(deepEqual(nested(10000, 1), nested(10000, 1))).toBe(true)
    expect(deepEqual(nested(10000, 1), nested(10000, 2))).toBe(false)
    const merged = mergeValues(nested(10000, { x: 1 }), nested(10000, { y: 2 }))
    let node = merged
    for (let i = 0; i < 10000; i++) { node = node.a }
    expect(node).toEqual({ x: 1, y: 2 })
  })

  it("B14.8.2 deep enum / const / example values merge", () => {
    expect(() => merge({ allOf: [{ enum: [nested(10000, 1)] }, { enum: [nested(10000, 1)] }] })).not.toThrow()
    expect(() => merge({ allOf: [{ const: nested(10000, 1) }, { const: nested(10000, 1) }] })).not.toThrow()
    expect(() => merge({ allOf: [{ example: nested(10000, 1) }, { example: nested(10000, 2) }] })).not.toThrow()
  })

  it("B14.8.3 deepEqual is cycle safe", () => {
    const a: any = { x: 1 }
    a.self = a
    const b: any = { x: 1 }
    b.self = b
    expect(deepEqual(a, b)).toBe(true)
  })
})

describe("B14.9 linear enum / required / properties merges", () => {
  it("B14.9.1 20k object enum members intersect quickly", () => {
    const list = Array.from({ length: 20000 }, (_, i) => ({ id: i }))
    const { value, ms } = timed(() => merge({ allOf: [{ enum: list }, { enum: clone(list).reverse() }] }))
    expect(value.enum).toHaveLength(20000)
    expect(ms).toBeLessThan(2000)
  })

  it("B14.9.2 20k required names unite quickly", () => {
    const a = Array.from({ length: 20000 }, (_, i) => `p${i}`)
    const b = Array.from({ length: 20000 }, (_, i) => `p${i + 10000}`)
    const { value, ms } = timed(() => merge({ allOf: [{ required: a }, { required: b }] }))
    expect(value.required).toHaveLength(30000)
    expect(ms).toBeLessThan(2000)
    const objects = timed(() => uniqueConcat([a.map((id) => ({ id })), b.map((id) => ({ id }))]))
    expect(objects.value).toHaveLength(30000)
    expect(objects.ms).toBeLessThan(2000)
  })

  it("B14.9.3 10k allOf items with one property each", () => {
    const allOf = Array.from({ length: 10000 }, (_, i) => ({ properties: { [`p${i}`]: { type: "string" } } }))
    const { value, ms } = timed(() => merge({ allOf }))
    expect(Object.keys(value.properties)).toHaveLength(10000)
    expect(ms).toBeLessThan(3000)
  })
})

describe("B14.10 own-property safety (keyword part)", () => {
  const parse = (json: string) => JSON.parse(json)

  it("B14.10.1 `constructor` does not bypass additionalProperties: false", () => {
    const schema: any = { allOf: [{ properties: { constructor: { type: "string" } } }, { properties: { a: {} }, additionalProperties: false }] }
    const result = merge(clone(schema))
    expect(result).toEqual({ properties: { a: {} }, additionalProperties: false })
    expect(compile(result)({ constructor: "x" })).toBe(false)
  })

  it("B14.10.2 `__proto__` properties survive as own data", () => {
    const result = merge(parse('{"allOf":[{"properties":{"__proto__":{"minLength":1}},"additionalProperties":false},{"properties":{"__proto__":{"type":"string"}}}]}'))
    expect(Object.prototype.hasOwnProperty.call(result.properties, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(result.properties)).toBe(Object.prototype)
    expect(result.properties.__proto__).toEqual({ minLength: 1, type: "string" })
  })

  it("B14.10.3 `__proto__` in patternProperties, dependencies, example and enum objects", () => {
    const result = merge(parse(`{"allOf":[
      {"patternProperties":{"__proto__":{"minLength":1}},"dependencies":{"__proto__":["a"]},"example":{"__proto__":{"x":1}},"enum":[{"__proto__":1}]},
      {"patternProperties":{"__proto__":{"maxLength":3}},"dependencies":{"__proto__":["b"]},"example":{"__proto__":{"y":2}},"enum":[{"__proto__":1}]}
    ]}`))
    expect(Object.prototype.hasOwnProperty.call(result.patternProperties, "__proto__")).toBe(true)
    expect(Object.getOwnPropertyDescriptor(result.patternProperties, "__proto__")!.value).toEqual({ minLength: 1, maxLength: 3 })
    expect(Object.getOwnPropertyDescriptor(result.dependencies, "__proto__")!.value).toEqual(["a", "b"])
    expect(Object.getOwnPropertyDescriptor(result.example, "__proto__")!.value).toEqual({ x: 1, y: 2 })
    expect(result.enum).toHaveLength(1)
    expect(({} as any).x).toBeUndefined()
  })
})

describe("B14.11 frozen rule sets", () => {
  it("B14.11.1 built-in rule objects cannot be modified", () => {
    const rules: any = jsonSchemaMergeRules()
    expect(Object.isFrozen(rules["/minItems"])).toBe(true)
    expect(() => { "use strict"; rules["/minItems"].$ = () => 999 }).toThrow()
    expect(Object.isFrozen(rules["/allOf"])).toBe(true)
    const oas: any = openApiMergeRules("3.0.x")
    expect(Object.isFrozen(oas)).toBe(true)
    expect(Object.isFrozen(oas["/components"]["/schemas"])).toBe(true)
    const schema: any = openApiJsonSchemaMergeRules("3.0.x")
    expect(Object.isFrozen(schema["/discriminator"])).toBe(true)
    const graph: any = graphapiMergeRules
    expect(Object.isFrozen(graph["/components"])).toBe(true)
  })

  it("B14.11.2 lazily derived rules are frozen too", () => {
    const rules: any = jsonSchemaMergeRules("2020-12")
    const derived = rules["/additionalProperties"]({ key: "additionalProperties", path: [], value: {} })
    expect(Object.isFrozen(derived)).toBe(true)
    expect(Object.isFrozen(rules["/items"]({ key: "items", path: [], value: {} })["/*"]({ key: "x", path: [], value: {} }))).toBe(true)
  })
})

describe("B14.12 per-key fallbacks when a custom rule hands a group back", () => {
  const withRules = (draft: any, custom: any) => jsonSchemaMergeRules(draft, custom)

  it("B14.12.1 custom /additionalProperties: properties still see the other items' additionalProperties", () => {
    const rules = withRules("draft-07", { "/additionalProperties": { $: resolvers.additionalPropertiesMergeResolver } })
    const schema = { allOf: [{ properties: { a: { type: "string" } }, additionalProperties: false }, { properties: { b: {} } }] }
    const result = merge(clone(schema), { rules })
    expect(result).toEqual({ properties: { a: { type: "string" } }, additionalProperties: false })
    expectSameObjectValidation(schema, result)
  })

  it("B14.12.2 custom /additionalProperties with interacting patterns keeps the fragments once", () => {
    const rules = withRules("draft-07", { "/additionalProperties": { $: resolvers.additionalPropertiesMergeResolver } })
    const schema = { allOf: [{ patternProperties: { "^a": {} }, additionalProperties: false }, { patternProperties: { "b$": {} }, additionalProperties: false }] }
    const result = merge(clone(schema), { rules })
    expectSameObjectValidation(schema, result)
    expect(result.allOf).toHaveLength(2)
  })

  it("B14.12.3 custom /items: additionalItems still combines with the other tuple", () => {
    const rules = withRules("draft-07", { "/items": { $: resolvers.itemsMergeResolver } })
    const schema = { allOf: [{ items: [{ type: "string" }], additionalItems: false }, { items: { minLength: 1 } }] }
    const result = merge(clone(schema), { rules })
    // the custom rule has no child rules, so the position stays an allOf conjunction (equivalent)
    expect(result).toEqual({ items: [{ allOf: [{ type: "string" }, { minLength: 1 }] }], additionalItems: false })
    expectSameValidation(schema, result, [[], ["a"], [""], ["a", "b"], [1]])
  })

  it("B14.12.4 custom /minimum under draft-04: the exclusive flag travels with the bound the custom rule selects", () => {
    const rules = withRules("draft-04", { "/minimum": { $: resolvers.maxValue } })
    // (a flag carried by a single item is copied by the engine without calling the resolver)
    const result = merge({ allOf: [{ minimum: 1, exclusiveMinimum: true }, { minimum: 5, exclusiveMinimum: false }] }, { rules })
    expect(result).toEqual({ minimum: 5, exclusiveMinimum: false })
    expect(merge({ allOf: [{ maximum: 1, exclusiveMaximum: true }, { maximum: 5, exclusiveMaximum: false }] }, { rules })).toEqual({ maximum: 1, exclusiveMaximum: true })
  })

  it("B14.12.5 custom /pattern, /contains and /if: unsafe patterns, different contains and conditionals become fragments", () => {
    const rules = withRules("2020-12", {
      "/pattern": { $: resolvers.mergePattern },
      "/minContains": { $: resolvers.minContainsMergeResolver },
      "/if": { $: resolvers.conditionalMergeResolver },
    })
    expect(merge({ allOf: [{ pattern: "(a)\\1" }, { pattern: "^b" }] }, { rules })).toEqual({ allOf: [{ pattern: "(a)\\1" }, { pattern: "^b" }] })
    expect(merge({ allOf: [{ contains: { type: "string" }, minContains: 2 }, { contains: { type: "number" }, minContains: 3 }] }, { rules }))
      .toEqual({ allOf: [{ contains: { type: "string" }, minContains: 2 }, { contains: { type: "number" }, minContains: 3 }] })
    expect(merge({ allOf: [{ if: { type: "string" }, then: { minLength: 1 } }, { if: { type: "number" }, then: { minimum: 1 } }] }, { rules }))
      .toEqual({ allOf: [{ if: { type: "string" }, then: { minLength: 1 } }, { if: { type: "number" }, then: { minimum: 1 } }] })
  })
})

describe("B14.13 #232 number vs integer", () => {
  it("B14.13.1 #232: nested property number ∧ integer is integer", () => {
    const { result, mergeErrors } = mergeReport({ type: "object", allOf: [
      { properties: { count: { type: "number", minimum: 0 } } },
      { properties: { count: { type: "integer" } } },
    ] })
    expect(result).toEqual({ type: "object", properties: { count: { type: "integer", minimum: 0 } } })
    expect(mergeErrors).toEqual([])
  })

  it("B14.13.2 #232: [number, null] ∧ [integer, null] is [integer, null]", () => {
    const { result, mergeErrors } = mergeReport({ allOf: [{ type: ["number", "null"] }, { type: ["integer", "null"] }] })
    expect(result).toEqual({ type: ["integer", "null"] })
    expect(mergeErrors).toEqual([])
  })
})

describe("B14.14 exports", () => {
  it("B14.14.1 new resolvers are exported and the keyword groups own the new keys", () => {
    for (const name of ["mergeFormat", "draft04ExclusiveMinimum", "draft04ExclusiveMaximum", "patternPropertiesMergeResolver",
      "containsMergeResolver", "minContainsMergeResolver", "maxContainsMergeResolver", "conditionalMergeResolver", "mergeConjunction"]) {
      expect(typeof (allResolvers as any)[name]).toBe("function")
    }
    const keys = keywordGroups.flatMap((group) => [...group.keys])
    for (const key of ["nullable", "format", "multipleOf"]) { expect(keys).toContain(key) }
  })
})
