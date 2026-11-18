import { describe, it, test, expect } from "vite-plus/test"
import { jsonSchemaMergeRules } from "../../src/index.ts"
import { merge, expectSameValidation } from "./helpers.ts"

// B6 - draft-04 vs draft-06 vs 2020-12 rule sets

describe("B6.1 draft-06 (default rule set)", () => {
  it("B6.1.1 jsonSchemaMergeRules() defaults to draft-06 and merges const", () => {
    expect(merge({ allOf: [{ const: 1 }, { const: 1 }] }, { rules: jsonSchemaMergeRules() })).toEqual({ const: 1 })
    expect(merge({ allOf: [{ const: 1 }, { const: 1 }] })).toEqual({ const: 1 })
  })

  it("B6.1.2 treats exclusiveMinimum / exclusiveMaximum as numbers", () => {
    expect(merge({ allOf: [{ exclusiveMinimum: 1, exclusiveMaximum: 10 }, { exclusiveMinimum: 5, exclusiveMaximum: 7 }] })).toEqual({ exclusiveMinimum: 5, exclusiveMaximum: 7 })
  })

  it("B6.1.3 merges $defs and definitions as objects", () => {
    expect(merge({ allOf: [{ $defs: { A: {} }, definitions: { C: {} } }, { $defs: { B: {} }, definitions: { D: {} } }] })).toEqual({ $defs: { A: {}, B: {} }, definitions: { C: {}, D: {} } })
  })

  it("B6.1.4 merges propertyNames, contains and dependencies", () => {
    expect(merge({ allOf: [{ propertyNames: { pattern: "^a" } }, { propertyNames: { maxLength: 3 } }] })).toEqual({ propertyNames: { pattern: "^a", maxLength: 3 } })
    expect(merge({ allOf: [{ dependencies: { a: ["b"] } }, { dependencies: { a: ["c"] } } ] }).dependencies.a.sort()).toEqual(["b", "c"])
  })
})

describe("B6.2 draft-04 rule set", () => {
  const rules = jsonSchemaMergeRules("draft-04")

  it("B6.2.1 treats exclusiveMinimum / exclusiveMaximum as booleans (OR when the bounds are equal)", () => {
    expect(merge({ allOf: [{ minimum: 5, exclusiveMinimum: false }, { minimum: 5, exclusiveMinimum: true }] }, { rules })).toEqual({ minimum: 5, exclusiveMinimum: true })
    expect(merge({ allOf: [{ maximum: 5, exclusiveMaximum: false }, { maximum: 5, exclusiveMaximum: false }] }, { rules })).toEqual({ maximum: 5, exclusiveMaximum: false })
  })

  it("B6.2.2 const is not a draft-04 keyword: the generic last-wins rule applies", () => {
    expect(merge({ allOf: [{ const: 1 }, { const: 2 }] }, { rules })).toEqual({ const: 2 })
  })

  it("B6.2.3 $defs is not a draft-04 keyword: the generic last-wins rule applies, definitions are merged", () => {
    expect(merge({ allOf: [{ $defs: { A: {} }, definitions: { C: {} } }, { $defs: { B: {} }, definitions: { D: {} } }] }, { rules })).toEqual({ $defs: { B: {} }, definitions: { C: {}, D: {} } })
  })

  // 0.x bug, fixed: "dependencies" exists in draft-04 but the rule is only registered for draft-06+, so the generic last-wins rule drops the first dependency list (the merged schema accepts { a: 1, c: 1 })
  test("B6.2.4 merges dependencies under draft-04", () => {
    const data = { allOf: [{ dependencies: { a: ["b"] } }, { dependencies: { a: ["c"] } }] }
    const result = merge(data, { rules })
    expect([...result.dependencies.a].sort()).toEqual(["b", "c"])
    expectSameValidation(data, result, [{ a: 1, b: 1, c: 1 }, { a: 1, c: 1 }, { a: 1, b: 1 }])
  })

  it("B6.2.5 still merges the common keywords (type, properties, required, items)", () => {
    const data = { allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { properties: { a: { minLength: 1 } }, required: ["b"], items: { type: "number" } }] }
    const result = merge(data, { rules })
    expect(result).toEqual({ type: "object", properties: { a: { type: "string", minLength: 1 } }, required: ["a", "b"], items: { type: "number" } })
  })
})

describe("B6.3 draft 2020-12 keywords", () => {
  // 0.x bug, fixed: 2020-12 keywords (prefixItems, dependentRequired, dependentSchemas, unevaluated*) have no rule and fall back to last-wins, silently dropping constraints
  test("B6.3.1 merges prefixItems position by position", () => {
    const data = { allOf: [{ prefixItems: [{ type: "string" }] }, { prefixItems: [{ minLength: 1 }, { type: "number" }] }] }
    // (contract change): prefixItems is a tuple keyword under the 2020-12 rules only (draft-06 default: unknown keyword)
    const result = merge(data, { rules: jsonSchemaMergeRules("2020-12") })
    expect(result).toEqual({ prefixItems: [{ type: "string", minLength: 1 }, { type: "number" }] })
    expectSameValidation(data, result, [["a", 1], ["", 1], [1, 1]], "2020")
  })

  // (fixed)
  test("B6.3.2 unions dependentRequired", () => {
    const data = { allOf: [{ dependentRequired: { a: ["b"] } }, { dependentRequired: { a: ["c"] } }] }
    const result = merge(data)
    expectSameValidation(data, result, [{ a: 1, b: 1, c: 1 }, { a: 1, b: 1 }, { a: 1, c: 1 }], "2020")
  })

  // schema-valued keywords are merged by the clone pass, so the $ref inside the merged items is resolved (0.x kept `{ $ref, maxLength }`, which draft-06/07 validators read as the bare $ref)
  it("B6.3.3 merges $defs and keeps items as schema in 2020-12 documents", () => {
    const data = { $defs: { A: { allOf: [{ type: "string" }, { minLength: 1 }] } }, allOf: [{ items: { $ref: "#/$defs/A" } }, { items: { maxLength: 5 } }] }
    const result = merge(data)
    expect(result.$defs.A).toEqual({ type: "string", minLength: 1 })
    expect(result.items).toEqual({ type: "string", minLength: 1, maxLength: 5 })
    expectSameValidation(data, result, [["a"], [""], ["abcdef"], [1]], "2020")
  })
})

describe("B6.4 custom rules", () => {
  it("B6.4.1 custom rules extend the JSON Schema rules", () => {
    const rules = jsonSchemaMergeRules("draft-06", { "/x-tags": { $: (args: any[]) => args.flat() } })
    expect(merge({ allOf: [{ "x-tags": ["a"] }, { "x-tags": ["b"] }] }, { rules })).toEqual({ "x-tags": ["a", "b"] })
  })

  it("B6.4.2 custom rules override built-in resolvers", () => {
    const rules = jsonSchemaMergeRules("draft-06", { "/type": { $: (args: any[]) => args } })
    expect(merge({ allOf: [{ type: "string" }, { type: "number" }] }, { rules })).toEqual({ type: ["string", "number"] })
  })

  it("B6.4.3 custom rules are propagated into nested schemas", () => {
    const rules = jsonSchemaMergeRules("draft-06", { "/x-tags": { $: (args: any[]) => args.flat() } })
    const result = merge({ properties: { a: { items: { allOf: [{ "x-tags": ["a"] }, { "x-tags": ["b"] }] } } } }, { rules })
    expect(result.properties.a.items).toEqual({ "x-tags": ["a", "b"] })
  })

  it("B6.4.4 rules without an allOf resolver leave the document untouched", () => {
    const data = { allOf: [{ type: "string" }, { minLength: 1 }] }
    expect(merge(data, { rules: { "/foo": { $: () => 1 } } })).toEqual(data)
  })

  it("B6.4.5 explicit rules bypass auto-detection", () => {
    const data = { openapi: "3.0.0", components: { schemas: { A: { allOf: [{ type: "string" }, { minLength: 1 }] } } } }
    expect(merge(data, { rules: jsonSchemaMergeRules() })).toEqual(data)
  })
})
