import { describe, it, expect } from "vite-plus/test"
import { syncClone } from "json-crawl"

import { createMerger, createResolutionIndex, jsonSchemaMergeRules, openApiMergeRules } from "../../src/index.ts"
import { ErrorMessage } from "../../src/errors.ts"
import { merge, clone, compile, deepFreeze, expectIdempotent, expectSameValidation, hasNoAllOf, mergeReport } from "./helpers.ts"

// B12 - additive API of the 1.0.0 redesign

describe("B12.1 unsatisfiable option", () => {
  it("B12.1.1 writes contradictions as false by default", () => {
    expect(merge({ allOf: [{ type: "string" }, { type: "number" }] })).toBe(false)
    expect(merge({ properties: { a: { allOf: [{ const: 1 }, { const: 2 }] } } })).toEqual({ properties: { a: false } })
  })

  it("B12.1.2 writes contradictions as { not: {} } with unsatisfiable: 'not-empty'", () => {
    const options = { unsatisfiable: "not-empty" as const }
    expect(merge({ allOf: [{ type: "string" }, { type: "number" }] }, options)).toEqual({ not: {} })
    expect(merge({ allOf: [{ type: "string" }, false] }, options)).toEqual({ not: {} })
    const result = merge({ properties: { a: { allOf: [{ enum: [1] }, { enum: [2] }] } } }, options)
    expect(result).toEqual({ properties: { a: { not: {} } } })
    expect(compile(result)({ a: 1 })).toBe(false)
    expect(compile(result)({})).toBe(true)
  })

  it("B12.1.3 reports a combinary whose every branch is unsatisfiable in both representations", () => {
    for (const unsatisfiable of ["false", "not-empty"] as const) {
      const { result, mergeErrors } = mergeReport({ anyOf: [{ allOf: [{ type: "string" }, { type: "number" }] }] }, { unsatisfiable })
      expect(mergeErrors.map((e) => e.path)).toEqual([["anyOf"]])
      // every branch impossible: the node is the contradiction (dropFalseBranches, default), reported once
      expect(result).toEqual(unsatisfiable === "false" ? false : { not: {} })
      const kept = mergeReport({ anyOf: [{ allOf: [{ type: "string" }, { type: "number" }] }] }, { unsatisfiable, dropFalseBranches: false })
      expect(kept.mergeErrors.map((e) => e.path)).toEqual([["anyOf"]])
      expect(kept.result.anyOf).toHaveLength(1)
    }
  })

  it("B12.1.4 the branch itself is not reported when other branches survive", () => {
    const { mergeErrors } = mergeReport({ anyOf: [{ allOf: [{ type: "string" }, { type: "number" }] }, { type: "null" }] })
    expect(mergeErrors).toEqual([])
  })
})

describe("B12.2 branch budget", () => {
  const data = { allOf: [
    { oneOf: [{ minLength: 1 }, { minLength: 2 }, { minLength: 3 }] },
    { oneOf: [{ maxLength: 9 }, { maxLength: 8 }, { maxLength: 7 }] },
    { description: "d" },
  ] }

  it("B12.2.1 merges combinary products within the default budget", () => {
    const result = merge(clone(data))
    expect(result.oneOf).toHaveLength(9)
    expect(result.description).toBe("d")
    expect(hasNoAllOf(result)).toBe(true)
  })

  it("B12.2.2 leaves the node unchanged and reports when the product exceeds the budget", () => {
    const { result, mergeErrors } = mergeReport(clone(data), { branchBudget: 4 })
    expect(result).toEqual(data)
    expect(mergeErrors).toHaveLength(1)
    expect(mergeErrors[0].message).toBe(ErrorMessage.branchBudgetExceeded(9, 4))
    expect(mergeErrors[0].path).toEqual([])
  })

  it("B12.2.3 a product exactly at the budget is merged", () => {
    const { result, mergeErrors } = mergeReport(clone(data), { branchBudget: 9 })
    expect(result.oneOf).toHaveLength(9)
    expect(mergeErrors).toEqual([])
  })

  it("B12.2.4 the budget applies per combinary keyword across the items of one allOf", () => {
    const wide = { allOf: [
      { anyOf: Array.from({ length: 40 }, (_, i) => ({ minLength: i })) },
      { anyOf: Array.from({ length: 40 }, (_, i) => ({ maxLength: 100 + i })) },
    ] }
    const { result, mergeErrors } = mergeReport(clone(wide))
    expect(result).toEqual(wide)
    expect(mergeErrors[0].message).toBe(ErrorMessage.branchBudgetExceeded(1600, 1024))
  })
})

describe("B12.3 createMerger", () => {
  it("B12.3.1 merge of a merger behaves like merge()", () => {
    const merger = createMerger({ mergeRefSibling: true })
    const data = { definitions: { A: { type: "string" } }, properties: { a: { $ref: "#/definitions/A", minLength: 1 } }, allOf: [{ type: "object" }, { required: ["a"] }] }
    expect(merger.merge(data)).toEqual(merge(data, { mergeRefSibling: true }))
  })

  it("B12.3.2 the hook of a merger can be used with syncClone", () => {
    const { hook } = createMerger()
    const result: any = syncClone({ allOf: [{ type: "string" }, { minLength: 1 }] }, hook, { rules: jsonSchemaMergeRules() })
    expect(result).toEqual({ type: "string", minLength: 1 })
  })

  it("B12.3.3 repeated merges of the same conjunction share the merged instance", () => {
    const merger = createMerger()
    const shared = { type: "object", properties: { x: { type: "string" } } }
    const extra = { required: ["x"] }
    const first: any = merger.merge({ allOf: [shared, extra] })
    const second: any = merger.merge({ properties: { p: { allOf: [shared, extra] } } })
    expect(first).toEqual({ type: "object", properties: { x: { type: "string" } }, required: ["x"] })
    expect(second.properties.p).toBe(first)
  })

  it("B12.3.4 merge-on-every-node with a reused merger equals a single merge", () => {
    const build = (d: number): any => d === 0
      ? { allOf: [{ type: "string" }, { minLength: 1 }] }
      : { type: "object", properties: Object.fromEntries(Array.from({ length: 3 }, (_, i) => ["p" + i, build(d - 1)])) }
    const root = build(3)
    const whole = merge(root)
    const merger = createMerger({ source: root })
    const visit = (node: any, merged: any) => {
      if (!node || typeof node !== "object") { return }
      expect(merger.merge(node)).toEqual(merged)
      for (const key of Object.keys(node.properties ?? {})) {
        visit(node.properties[key], merged.properties[key])
      }
    }
    visit(root, whole)
  })

  it("B12.3.5 per-call source and rules overrides", () => {
    const merger = createMerger()
    const source = { components: { schemas: { A: { type: "string" } } } }
    expect(merger.merge({ allOf: [{ $ref: "#/components/schemas/A" }, { minLength: 1 }] }, { source })).toEqual({ type: "string", minLength: 1 })
    const data = { allOf: [{ type: "string" }, { minLength: 1 }] }
    expect(merger.merge(data, { rules: { "/foo": { $: () => 1 } } })).toEqual(data)
    expect(merger.merge(data)).toEqual({ type: "string", minLength: 1 })
  })

  it("B12.3.6 a throwing hook does not poison the memo of the merger", () => {
    const merger = createMerger({ onMergeError: () => { throw new Error("boom") } })
    const shared = { type: "string" }
    expect(() => merger.merge({ properties: { a: { allOf: [shared, { type: "number" }] } } })).toThrow("boom")
    expect(merger.merge({ allOf: [shared, { minLength: 1 }] })).toEqual({ type: "string", minLength: 1 })
  })
})

describe("B12.4 draft-07 and 2020-12 rule sets", () => {
  const rules2020 = jsonSchemaMergeRules("2020-12")
  const rules07 = jsonSchemaMergeRules("draft-07")

  it("B12.4.1 jsonSchemaMergeRules accepts the new versions and memoizes per draft", () => {
    expect(jsonSchemaMergeRules("2020-12")).toBe(rules2020)
    expect(jsonSchemaMergeRules("draft-07")).toBe(rules07)
    expect(jsonSchemaMergeRules()).toBe(jsonSchemaMergeRules("draft-06"))
    expect(jsonSchemaMergeRules("draft-04")).not.toBe(jsonSchemaMergeRules("draft-06"))
    expect(Object.isFrozen(rules2020)).toBe(true)
    expect(openApiMergeRules("3.1.x")).toBe(openApiMergeRules("3.1.x"))
  })

  it("B12.4.2 merges prefixItems with an items tail (2020-12)", () => {
    const data = { allOf: [{ prefixItems: [{ type: "string" }], items: { type: "number" } }, { prefixItems: [{ minLength: 1 }, { minimum: 0 }] }] }
    const result = merge(data, { rules: rules2020 })
    expect(result).toEqual({ prefixItems: [{ type: "string", minLength: 1 }, { type: "number", minimum: 0 }], items: { type: "number" } })
    expectSameValidation(data, result, [["a", 1], ["", 1], ["a", -1], ["a", 1, 2], ["a", 1, "b"]], "2020")
  })

  it("B12.4.3 merges dependentSchemas and dependentRequired (2020-12)", () => {
    const data = { allOf: [
      { dependentRequired: { a: ["b"] }, dependentSchemas: { a: { properties: { c: { type: "string" } } } } },
      { dependentRequired: { a: ["c"], d: ["e"] }, dependentSchemas: { a: { required: ["c"] } } },
    ] }
    const result = merge(data, { rules: rules2020 })
    expect(result.dependentRequired).toEqual({ a: ["b", "c"], d: ["e"] })
    expect(result.dependentSchemas.a).toEqual({ properties: { c: { type: "string" } }, required: ["c"] })
    expectSameValidation(data, result, [{ a: 1, b: 1, c: "x" }, { a: 1, b: 1 }, { a: 1, b: 1, c: 1 }, { d: 1 }], "2020")
  })

  it("B12.4.4 unevaluatedProperties: false wins, schemas are conjoined (2020-12)", () => {
    //: items carrying their own unevaluated* stay whole allOf fragments
    expect(merge({ allOf: [{ unevaluatedProperties: false }, { unevaluatedProperties: { type: "string" } }] }, { rules: rules2020 })).toEqual({ allOf: [{ unevaluatedProperties: false }, { unevaluatedProperties: { type: "string" } }] })
    expect(merge({ allOf: [{ unevaluatedItems: { type: "string" } }, { unevaluatedItems: { minLength: 1 } }] }, { rules: rules2020 })).toEqual({ allOf: [{ unevaluatedItems: { type: "string" } }, { unevaluatedItems: { minLength: 1 } }] })
    // node-level unevaluated* (the node's own sibling) is still merged with the items
    expect(merge({ unevaluatedProperties: false, allOf: [{ properties: { a: {} } }, { properties: { b: {} } }] }, { rules: rules2020 })).toEqual({ properties: { a: {}, b: {} }, unevaluatedProperties: false })
  })

  it("B12.4.5 minContains / maxContains take the tightest value with a single contains (2020-12)", () => {
    const data = { allOf: [{ contains: { type: "string" }, minContains: 1, maxContains: 5 }, { contains: { type: "string" }, minContains: 2, maxContains: 3 }] }
    const result = merge(data, { rules: rules2020 })
    expect(result).toEqual({ contains: { type: "string" }, minContains: 2, maxContains: 3 })
    expectSameValidation(data, result, [["a"], ["a", "b"], ["a", "b", "c", "d"], [1]], "2020")
    // minContains without contains in the same schema has no effect and must not tighten the merged value
    const loose = { allOf: [{ contains: { type: "string" }, minContains: 1 }, { minContains: 2 }] }
    const looseResult = merge(loose, { rules: rules2020 })
    expect(looseResult.minContains).toBe(1)
    expectSameValidation(loose, looseResult, [["a"], ["a", "b"], []], "2020")
  })

  it("B12.4.6 several if/then/else are kept as allOf fragments (draft-07)", () => {
    const data = { allOf: [
      { if: { properties: { a: { const: 1 } } }, then: { required: ["b"] } },
      { if: { properties: { a: { const: 2 } } }, then: { required: ["c"] }, else: { required: ["d"] } },
    ] }
    const result = merge(data, { rules: rules07 })
    expect(result.allOf).toHaveLength(2)
    expect(result.if).toBeUndefined()
    expectSameValidation(data, result, [{ a: 1, b: 1, d: 1 }, { a: 1, b: 1 }, { a: 2, c: 1 }, { a: 2 }, { a: 3, d: 1 }])
    expectIdempotent(data, { rules: rules07 })
  })

  it("B12.4.7 a single if/then/else and nested allOf inside it are merged (draft-07)", () => {
    const result = merge({ allOf: [{ if: { allOf: [{ type: "object" }, { required: ["a"] }] }, then: { allOf: [{ required: ["b"] }, { required: ["c"] }] } }, { description: "d" }] }, { rules: rules07 })
    expect(result).toEqual({ if: { type: "object", required: ["a"] }, then: { required: ["b", "c"] }, description: "d" })
  })

  it("B12.4.8 OpenAPI 3.1 schemas use the 2020-12 keywords", () => {
    const result = merge({ openapi: "3.1.0", components: { schemas: { A: { allOf: [{ prefixItems: [{ type: "string" }] }, { prefixItems: [{ minLength: 1 }] }] } } } })
    expect(result.components.schemas.A).toEqual({ prefixItems: [{ type: "string", minLength: 1 }] })
  })
})

describe("B12.5 keyword groups and custom rules", () => {
  it("B12.5.1 a custom resolver on a grouped key hands the group's keys back to the per-key table", () => {
    const rules = jsonSchemaMergeRules("draft-04", { "/minimum": { $: (args: number[]) => Math.min(...args) } })
    const result = merge({ allOf: [{ minimum: 1, exclusiveMinimum: true }, { minimum: 5 }] }, { rules })
    // custom minimum (min instead of max) and the 0.x per-key OR for the flag
    expect(result).toEqual({ minimum: 1, exclusiveMinimum: true })
  })

  it("B12.5.2 a custom rule tagged with the group keeps the group active", () => {
    const rules = jsonSchemaMergeRules("draft-04", { "/minimum": { $: (args: number[]) => Math.min(...args), group: "numericBounds" } })
    expect(merge({ allOf: [{ minimum: 1, exclusiveMinimum: true }, { minimum: 5 }] }, { rules })).toEqual({ minimum: 5, exclusiveMinimum: false })
  })

  it("B12.5.3 pattern conjunction falls back to allOf fragments for backreferences", () => {
    const data = { allOf: [{ pattern: "^(a)\\1" }, { pattern: "b$" }] }
    const result = merge(data)
    expect(result).toEqual({ allOf: [{ pattern: "^(a)\\1" }, { pattern: "b$" }] })
    expectSameValidation(data, result, ["aab", "aa", "ab", "aaxb"])
    expectIdempotent(data)
  })

  it("B12.5.4 enum and required keep the first-seen order without duplicates", () => {
    const result = merge({ allOf: [{ enum: [1, 10, 2, "a"], required: ["b", "a", "b"] }, { enum: [2, 10, 1], required: ["c", "a"] }] })
    expect(result).toEqual({ enum: [1, 10, 2], required: ["b", "a", "c"] })
  })

  it("B12.5.5 integer ∧ number inside type arrays keeps the order of the first item", () => {
    expect(merge({ allOf: [{ type: ["number", "string", "null"] }, { type: ["null", "integer"] }] })).toEqual({ type: ["integer", "null"] })
  })

  it("B12.5.6 a false tail truncates the merged tuple and a single contains is kept", () => {
    const result = merge({ allOf: [{ items: false }, { items: [{ type: "string" }], contains: { type: "string" } }] })
    expect(result).toEqual({ items: [], additionalItems: false, contains: { type: "string" } })
  })

  it("B12.5.7 input is never mutated by the groups", () => {
    const data = { allOf: [
      { properties: { a: { type: "string" } }, patternProperties: { "^x": { minLength: 1 } }, items: [{ type: "string" }], additionalItems: { type: "string" }, contains: { type: "string" } },
      { properties: { b: {} }, additionalProperties: false, items: { minLength: 1 }, contains: { type: "number" }, dependencies: { a: ["b"] } },
      { dependencies: { a: { required: ["c"] } } },
    ] }
    const frozen = deepFreeze(clone(data))
    expect(() => merge(frozen)).not.toThrow()
    const copy = clone(data)
    merge(copy)
    expect(copy).toEqual(data)
  })
})

describe("B12.6 resolution index", () => {
  const source = { definitions: { A: { type: "string" }, B: { $ref: "#/definitions/A" }, C: { $ref: "#/definitions/C" } }, list: [{ x: 1 }] }
  const index = createResolutionIndex(source)

  it("B12.6.1 resolves local refs to the direct target", () => {
    expect(index.resolve("#/definitions/A")).toEqual({ ok: true, target: source.definitions.A })
    expect(index.resolve("#/definitions/B")).toEqual({ ok: true, target: source.definitions.B })
    expect(index.resolve("#")).toEqual({ ok: true, target: source })
    expect(index.resolve("#/list/0/x")).toEqual({ ok: true, target: 1 })
  })

  it("B12.6.2 reports broken, external and cyclic refs with a reason", () => {
    expect(index.resolve("#/definitions/Nope")).toEqual({ ok: false, reason: "not-found" })
    expect(index.resolve("other.json#/A")).toEqual({ ok: false, reason: "external" })
    expect(index.resolve("#/definitions/C/x")).toEqual({ ok: false, reason: "cycle" })
    expect(index.resolve("#/list/5")).toEqual({ ok: false, reason: "not-found" })
  })

  it("B12.6.3 walks through intermediate refs", () => {
    expect(index.resolvePointer("/definitions/B/type")).toBe("string")
    expect(index.resolvePointer("/definitions/C/type")).toBeUndefined()
  })

  it("B12.6.4 caches results per index and per normalized ref", () => {
    expect(index.resolve("#/definitions/A")).toBe(index.resolve("#/definitions/A"))
    expect(index.resolve("#")).toBe(index.resolve("#"))
    // `#/` is the member "" (absent here), not the root
    expect(index.resolve("#/")).toEqual({ ok: false, reason: "not-found" })
  })
})
