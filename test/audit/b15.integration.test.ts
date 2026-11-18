import { describe, it, expect } from "vite-plus/test"
import { additionalPropertiesMergeResolver, jsonSchemaMergeRules } from "../../src/index.ts"
import { mergeCombinarySibling } from "../../src/resolvers/combinary.ts"
import { clone, expectSameValidation, findKeys, isJsonSerializable, merge, mergeReport } from "./helpers.ts"

describe("B15.1 draft-04 exclusive flags follow the bound selected by a custom rule", () => {
  const draft04 = (custom: any) => jsonSchemaMergeRules("draft-04", custom)

  it("B15.1.1 custom /minimum = min: the flag of the item carrying the selected bound", () => {
    const rules = draft04({ "/minimum": { $: (args: number[]) => Math.min(...args) } })
    expect(merge({ allOf: [{ minimum: 1, exclusiveMinimum: true }, { minimum: 5 }] }, { rules })).toEqual({ minimum: 1, exclusiveMinimum: true })
    expect(merge({ allOf: [{ minimum: 1 }, { minimum: 5, exclusiveMinimum: true }] }, { rules })).toEqual({ minimum: 1 })
    expect(merge({ allOf: [{ minimum: 1, exclusiveMinimum: false }, { minimum: 5, exclusiveMinimum: true }] }, { rules })).toEqual({ minimum: 1, exclusiveMinimum: false })
  })

  it("B15.1.2 several items with the selected bound: exclusive if any of them is (tightest)", () => {
    const rules = draft04({ "/minimum": { $: (args: number[]) => Math.min(...args) } })
    const result = merge({ allOf: [{ minimum: 1, exclusiveMinimum: false }, { minimum: 1, exclusiveMinimum: true }, { minimum: 5 }] }, { rules })
    expect(result).toEqual({ minimum: 1, exclusiveMinimum: true })
  })

  it("B15.1.3 custom /maximum = max: same rule on the upper side; the untouched lower side keeps its built-in resolver", () => {
    const rules = draft04({ "/maximum": { $: (args: number[]) => Math.max(...args) } })
    const result = merge({ allOf: [{ maximum: 10, exclusiveMaximum: true, minimum: 1, exclusiveMinimum: true }, { maximum: 3, minimum: 2 }] }, { rules })
    expect(result).toEqual({ maximum: 10, exclusiveMaximum: true, minimum: 2 })
  })

  it("B15.1.4 the default group mode is unchanged (tightest bound, its flag)", () => {
    expect(merge({ allOf: [{ minimum: 1, exclusiveMinimum: true }, { minimum: 5 }] }, { rules: draft04({}) })).toEqual({ minimum: 5, exclusiveMinimum: false })
    expect(merge({ allOf: [{ minimum: 5, exclusiveMinimum: true }, { minimum: 5 }] }, { rules: draft04({}) })).toEqual({ minimum: 5, exclusiveMinimum: true })
  })
})

describe("B15.2 per-key object-shape fallbacks use the call's matchPatterns setting", () => {
  it("B15.2.1 matchPatterns: false makes the handed-back properties fallback keep fragments instead of matching", () => {
    const rules = jsonSchemaMergeRules("draft-07", { "/additionalProperties": { $: additionalPropertiesMergeResolver } })
    const schema = { allOf: [{ patternProperties: { "^a": { type: "string" } }, additionalProperties: false }, { properties: { ab: { minLength: 1 }, b: {} } }] }
    // matching (default): `ab` is allowed by the pattern, `b` is forbidden and dropped
    const matched = merge(clone(schema), { rules })
    expect(matched).toEqual({ patternProperties: { "^a": { type: "string" } }, additionalProperties: false, properties: { ab: { minLength: 1 } } })
    // no matching: the object shapes stay allOf fragments, exactly as in group mode
    const unmatched = merge(clone(schema), { rules, matchPatterns: false })
    expect(unmatched).toEqual(merge(clone(schema), { matchPatterns: false }))
    expect(unmatched.allOf).toHaveLength(2)
    for (const result of [matched, unmatched]) {
      expectSameValidation(schema, result, [{}, { ab: "" }, { ab: "x" }, { ab: 1 }, { b: 1 }, { ac: "x" }, { c: 1 }])
    }
  })
})

describe("B15.3 identity keywords of $ref-inlined items are not copied", () => {
  it("B15.3.1 $id / $anchor / $schema of a ref target do not appear in the merged node", () => {
    const doc = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Base: { $id: "https://example.com/base", $anchor: "base", $dynamicAnchor: "node", type: "object", properties: { a: { type: "string" } } },
      },
      properties: { x: { allOf: [{ $ref: "#/$defs/Base" }, { required: ["a"] }] } },
    }
    const result = merge(clone(doc))
    expect(result.properties.x).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })
    // the target itself keeps its identity, exactly once
    expect(result.$defs.Base.$id).toBe("https://example.com/base")
    expect(findKeys(result, "$anchor")).toHaveLength(1)
    expect(findKeys(result, "$id")).toHaveLength(1)
    expect(findKeys(result, "$dynamicAnchor")).toHaveLength(1)
    expect(findKeys(result, "$schema")).toEqual(["$schema"])
  })

  it("B15.3.2 the node's own identity keywords survive; a single inlined target is copied without its ids", () => {
    const doc = {
      definitions: { A: { id: "a.json", $id: "a", type: "string" } },
      properties: {
        own: { $id: "own", allOf: [{ $ref: "#/definitions/A" }, { minLength: 1 }] },
        single: { allOf: [{ $ref: "#/definitions/A" }] },
      },
    }
    const result = merge(clone(doc))
    expect(result.properties.own).toEqual({ $id: "own", type: "string", minLength: 1 })
    expect(result.properties.single).toEqual({ type: "string" })
  })

  it("B15.3.3 identity keywords of allOf items nested in a ref target and of the root (`$ref: \"#\"`) are not copied", () => {
    const doc = {
      $id: "root",
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: { A: { allOf: [{ $id: "inner", minimum: 1 }, { $anchor: "x", maximum: 5 }] } },
      properties: {
        n: { allOf: [{ $ref: "#/definitions/A" }, { type: "integer" }] },
        r: { allOf: [{ $ref: "#" }, { title: "r" }] },
      },
    }
    const result = merge(clone(doc))
    expect(result.properties.n).toEqual({ minimum: 1, maximum: 5, type: "integer" })
    expect(result.properties.r.$id).toBeUndefined()
    expect(result.properties.r.$schema).toBeUndefined()
    expect(result.properties.r.title).toBe("r")
    expect(isJsonSerializable(result)).toBe(true)
  })

  it("B15.3.4 a draft-04 `id` that is not a string (e.g. a property schema named id) is not an identity keyword", () => {
    const doc = { definitions: { A: { properties: { id: { type: "string" } } } }, allOf: [{ $ref: "#/definitions/A" }, { required: ["id"] }] }
    expect(merge(clone(doc)).properties).toEqual({ id: { type: "string" } })
    const odd = { definitions: { A: { id: { type: "string" }, type: "object" } }, allOf: [{ $ref: "#/definitions/A" }, { minProperties: 1 }] }
    expect(merge(clone(odd)).id).toEqual({ type: "string" })
  })

  it("B15.3.5 a recursive target with an $id: the cycle is still a $ref to the source location", () => {
    const doc = { definitions: { T: { $id: "t", type: "object", properties: { next: { allOf: [{ $ref: "#/definitions/T" }] } } } } }
    const { result, mergeErrors } = mergeReport(clone(doc))
    expect(result.definitions.T.properties.next).toEqual({ $ref: "#/definitions/T" })
    expect(mergeErrors).toEqual([])
  })
})

describe("B15.4 own-property safety leftovers", () => {
  it("B15.4.1 mergeCombinarySibling copies `__proto__` siblings as own data", () => {
    const node = JSON.parse('{"oneOf":[{"type":"string"}],"__proto__":{"polluted":true},"title":"t"}')
    const result: any = mergeCombinarySibling(node, "oneOf", { sibling: ["title"] })
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(result.title).toBe("t")
    expect(Object.prototype.hasOwnProperty.call(result.oneOf[0].allOf[0], "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(result.oneOf[0].allOf[0])).toBe(Object.prototype)
    expect(({} as any).polluted).toBeUndefined()
  })
})

describe("B15.5 expansionBudget: total schema nodes copied in by $ref inlining per call", () => {
  // a fat target (1000 properties) reached through 5 levels of 10-fold fan-out: 100 000 logical inlinings of L0
  const fatDocument = () => {
    const props: any = {}
    for (let i = 0; i < 1000; i++) { props["k" + i] = { type: "string" } }
    const definitions: any = { L0: { type: "object", properties: props } }
    for (let level = 1; level <= 5; level++) {
      const properties: any = {}
      for (let j = 0; j < 10; j++) { properties["f" + j] = { allOf: [{ $ref: "#/definitions/L" + (level - 1) }, { description: "d" + j }] } }
      definitions["L" + level] = { type: "object", properties }
    }
    return { definitions }
  }

  it("B15.5.1 a fat target fanned out below maxRefExpansion is still bounded by the default budget, reported once", () => {
    const start = performance.now()
    const { result, mergeErrors } = mergeReport(fatDocument())
    expect(performance.now() - start).toBeLessThan(5000)
    expect(JSON.stringify(result).length).toBeLessThan(100_000_000)
    const budgetErrors = mergeErrors.filter((e) => e.message.includes("expansionBudget"))
    expect(budgetErrors).toHaveLength(1)
    // the kept nodes are the original allOf with the $ref
    expect(JSON.stringify(result)).toContain('"$ref":"#/definitions/L')
  })

  it("B15.5.2 a small budget keeps the $ref of the node that would exceed it", () => {
    const doc = { definitions: { S: { type: "object", properties: { a: { type: "string" } } } }, properties: {
      p0: { allOf: [{ $ref: "#/definitions/S" }, { description: "0" }] },
      p1: { allOf: [{ $ref: "#/definitions/S" }, { description: "1" }] },
      p2: { allOf: [{ $ref: "#/definitions/S" }, { description: "2" }] },
    } }
    // S weighs 3 nodes (S, S.properties, S.properties.a): two inlinings fit into 6
    const { result, mergeErrors } = mergeReport(clone(doc), { expansionBudget: 6 })
    expect(result.properties.p1).toEqual({ type: "object", properties: { a: { type: "string" } }, description: "1" })
    expect(result.properties.p2).toEqual({ allOf: [{ $ref: "#/definitions/S" }, { description: "2" }] })
    expect(mergeErrors.map((e) => e.path)).toEqual([["properties", "p2"]])
    expectSameValidation(doc, result, [{ p2: { a: "x" } }, { p2: { a: 1 } }, { p1: { a: 1 } }, { p0: "x" }])
  })

  it("B15.5.3 real-world shaped documents stay far below both defaults (4000 usages of one target merge fully)", () => {
    const properties: any = {}
    for (let i = 0; i < 4000; i++) { properties["p" + i] = { allOf: [{ $ref: "#/definitions/S" }, { description: "d" + i }] } }
    const { result, mergeErrors } = mergeReport({ definitions: { S: { type: "object", properties: { x: { type: "string" } } } }, properties })
    expect(mergeErrors).toEqual([])
    expect(result.properties.p3999).toEqual({ type: "object", properties: { x: { type: "string" } }, description: "d3999" })
  })
})

describe("B15.6 unresolvable $ref values", () => {
  it("B15.6.1 an empty or non-string $ref inside allOf is a broken ref: the node is kept and reported", () => {
    const empty = mergeReport({ allOf: [{ $ref: "" }, { minLength: 1 }] })
    expect(empty.result).toEqual({ allOf: [{ $ref: "" }, { minLength: 1 }] })
    expect(empty.refErrors.map((e) => e.ref)).toEqual([""])
    const numeric = mergeReport({ properties: { a: { allOf: [{ $ref: 5 }, { type: "string" }] } } })
    expect(numeric.result.properties.a).toEqual({ allOf: [{ $ref: 5 }, { type: "string" }] })
    expect(numeric.refErrors.map((e) => e.ref)).toEqual(["5"])
  })
})

describe("B15.7 replay findings", () => {
  it("B15.7.1 a bare $ref into an allOf that is merged away does not dangle: it links the matching merged location", () => {
    const doc = { allOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { $ref: "#/allOf/0/properties/a" } } }] }
    const { result, refErrors, mergeErrors } = mergeReport(clone(doc))
    // the merged a is equal to the original target, so b is a link to its matching location (was a copy)
    expect(result).toEqual({ properties: { a: { type: "string" }, b: { $ref: "#/properties/a" } } })
    expect(refErrors).toEqual([])
    expect(mergeErrors).toEqual([])
    expectSameValidation(doc, result, [{}, { b: "x" }, { b: 1 }, { a: 1 }])
    // a $ref outside allOf that does not point into an allOf is still never touched
    expect(merge({ definitions: { S: { type: "string" } }, properties: { x: { $ref: "#/definitions/S" } } }).properties.x).toEqual({ $ref: "#/definitions/S" })
    // a broken one is left as it is
    expect(merge({ type: "object", properties: { x: { $ref: "#/allOf/5" } }, allOf: [{ minProperties: 1 }] }).properties.x).toEqual({ $ref: "#/allOf/5" })
  })

  it("B15.7.2 a long allOf -> $ref chain counts each inlining once (shared outputs keep their own counts)", () => {
    const definitions: any = { d0: { type: "string" } }
    for (let i = 1; i <= 1000; i++) { definitions["d" + i] = { allOf: [{ $ref: "#/definitions/d" + (i - 1) }] } }
    const { result, mergeErrors } = mergeReport({ definitions, allOf: [{ $ref: "#/definitions/d1000" }, { minLength: 1 }] })
    expect(mergeErrors).toEqual([])
    expect(result.definitions.d1000).toEqual({ type: "string" })
    expect(result.minLength).toBe(1)
  })

  it("B15.7.3 malformed boolean keywords, tuple values and invalid patterns are reported", () => {
    const unique = mergeReport({ allOf: [{ uniqueItems: "hi" }, { uniqueItems: true }] })
    expect(unique.result).toEqual({ uniqueItems: true })
    expect(unique.mergeErrors).toHaveLength(1)
    const items = mergeReport({ allOf: [{ items: null }, { items: { type: "string" } }] })
    expect(items.result).toEqual({ items: { type: "string" } })
    expect(items.mergeErrors).toHaveLength(1)
    const pattern = mergeReport({ allOf: [{ pattern: "(" }, { pattern: "^a" }] })
    expect(pattern.result).toEqual({ allOf: [{ pattern: "(" }, { pattern: "^a" }] })
    expect(pattern.mergeErrors.map((e) => e.values)).toEqual([["("]])
  })
})
