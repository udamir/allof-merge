/*
 * B20 — simplifications. The four always-safe ones are options of their own,
 * default true: dedupeAnyOf (S1, never oneOf), dedupeFragments (S2), dedupeCombinaryGroups (S3, order-sensitive),
 * dropFalseBranches (S10/S11). `simplify` (default off) adds the exact, type-guarded, form-changing rules S4b, S4c, S5,
 * S6a, S6b, S7, S9. Every case is checked for equivalence with the cfworker oracle of test/fuzz (draft-07 / 2020-12
 * profiles; draft-07 `$ref` siblings read as applying, D-24).
 */
import { describe, it, expect } from "vite-plus/test"
import { createMerger, jsonSchemaMergeRules, openApiMergeRules, graphapiMergeRules, type MergeOptions } from "../../src/index.ts"
import { checkCase, type CaseOptions, type FuzzCase, type Profile } from "../fuzz/oracle.ts"
import { clone, merge, mergeReport } from "./helpers.ts"

const S = { type: "string" }
const N = { type: "number" }
const B = { type: "boolean" }
const Nl = { type: "null" }

const rulesOf = (profile: Profile) => jsonSchemaMergeRules(profile)

// merged output under a profile's rules, after checking equivalence with the cfworker oracle
const exact = (schema: unknown, options: CaseOptions = {}, profile: Profile = "draft-07", extraInstances: unknown[] = []) => {
  const c: FuzzCase = { profile, schema: clone(schema), options }
  expect(checkCase(c, { extraInstances })).toBeUndefined()
  return merge(clone(schema), { ...options, rules: rulesOf(profile) })
}

const SIMPLIFY: CaseOptions = { simplify: true }

describe("B20.1 dedupeAnyOf (S1, F3.1, F3.2)", () => {
  it("B20.1.1 identical anyOf branches of the input are kept once, first-seen order", () => {
    expect(exact({ allOf: [{ anyOf: [S, N, S] }, { minLength: 1 }] })).toEqual({ minLength: 1, anyOf: [S, N] })
    expect(exact({ anyOf: [S, S] })).toEqual({ anyOf: [S] })
  })

  it("B20.1.2 product branches with equal merged results are kept once", () => {
    const data = { allOf: [{ anyOf: [{ type: ["string", "null"] }, { type: ["string", "number"] }] }, { anyOf: [S] }] }
    expect(exact(data)).toEqual({ anyOf: [S] })
    expect(exact(data, { dedupeAnyOf: false })).toEqual({ anyOf: [S, S] })
  })

  it("B20.1.3 oneOf branches are never deduped (oneOf [A, A, B] ≡ ¬A ∧ B)", () => {
    expect(exact({ oneOf: [S, N, S] }, {}, "2020-12", ["a", 1])).toEqual({ oneOf: [S, N, S] })
    const product = { allOf: [{ oneOf: [{ type: ["string", "null"] }, { type: ["string", "number"] }] }, { oneOf: [S] }] }
    expect(exact(product, {}, "draft-07", ["a"])).toEqual({ oneOf: [S, S] })
  })

  it("B20.1.4 dedupeAnyOf: false keeps the duplicates", () => {
    expect(exact({ anyOf: [S, S] }, { dedupeAnyOf: false })).toEqual({ anyOf: [S, S] })
  })
})

describe("B20.2 dedupeFragments (S2, F3.3)", () => {
  it("B20.2.1 identical contains fragments are kept once", () => {
    const data = { allOf: [{ contains: N }, { contains: S }, { contains: N }] }
    expect(exact(data)).toEqual({ allOf: [{ contains: N }, { contains: S }] })
    expect(exact(data, { dedupeFragments: false })).toEqual({ allOf: [{ contains: N }, { contains: S }, { contains: N }] })
  })

  it("B20.2.2 identical if/then fragments; repeated formats", () => {
    const cond = { if: { minLength: 2 }, then: { maxLength: 4 } }
    const other = { if: { minLength: 5 }, then: { maxLength: 8 } }
    expect(exact({ allOf: [cond, other, cond] })).toEqual({ allOf: [cond, other] })
    expect(exact({ allOf: [{ format: "date" }, { format: "date" }] })).toEqual({ format: "date" })
    // Q1: different formats are a contradiction (no longer kept as fragments; not equivalent for an annotation-only
    // validator, which is why the oracle is not used here)
    expect(merge({ allOf: [{ format: "date" }, { format: "email" }, { format: "date" }] })).toBe(false)
  })

  it("B20.2.3 identical { $ref } fragments (items with their own unevaluated*) are kept once", () => {
    const data = {
      $defs: { U: { properties: { a: N }, unevaluatedProperties: false } },
      allOf: [{ $ref: "#/$defs/U" }, { minProperties: 1 }, { $ref: "#/$defs/U" }],
    }
    expect(exact(data, {}, "2020-12")).toEqual({ $defs: data.$defs, minProperties: 1, allOf: [{ $ref: "#/$defs/U" }] })
  })
})

describe("B20.3 dedupeCombinaryGroups (S3, F3.4–F3.6)", () => {
  it("B20.3.1 three identical oneOf groups merge into the group (was 27 branches, 24 false)", () => {
    // three equal copies (a bundler inlined the same schema three times; one shared instance is collected once anyway)
    const G = () => ({ oneOf: [S, N, B] })
    expect(exact({ allOf: [G(), G(), G()] })).toEqual({ oneOf: [S, N, B] })
    // without the group dedupe the product is computed; its impossible branches are dropped (dropFalseBranches)
    const product = merge({ allOf: [G(), G(), G()] }, { dedupeCombinaryGroups: false })
    expect(product.oneOf).toHaveLength(3)
    expect(merge({ allOf: [G(), G(), G()] }, { dedupeCombinaryGroups: false, dropFalseBranches: false }).oneOf).toHaveLength(27)
  })

  it("B20.3.2 six copies of a 4-branch group: 4 branches, no budget report (was 4096 > 1024)", () => {
    const six = () => [1, 2, 3, 4, 5, 6].map(() => ({ oneOf: [S, N, B, Nl] }))
    const { result, mergeErrors } = mergeReport({ allOf: six() })
    expect(result).toEqual({ oneOf: [S, N, B, Nl] })
    expect(mergeErrors).toEqual([])
    const off = mergeReport({ allOf: six() }, { dedupeCombinaryGroups: false })
    expect(off.mergeErrors.map((e) => e.message)).toEqual(["Could not merge combinaries: 4096 combinations exceed the branch budget of 1024"])
  })

  it("B20.3.3 groups equal up to order are different groups (order-sensitive, Q3-3)", () => {
    const result = exact({ allOf: [{ oneOf: [S, N] }, { oneOf: [N, S] }] })
    expect(result).toEqual({ oneOf: [S, N] })
    // the product was computed: four branches, the two impossible ones dropped
    expect(merge({ allOf: [{ oneOf: [S, N] }, { oneOf: [N, S] }] }, { dropFalseBranches: false }).oneOf).toHaveLength(4)
  })

  it("B20.3.4 budget accounting: 5 distinct groups of 4 plus 1 duplicate count 1024, not 4096", () => {
    const groups = [1, 2, 3, 4, 5].map((n) => ({ anyOf: [{ minLength: n }, { maxLength: n + 10 }, { pattern: `^${n}` }, { format: `f${n}` }] }))
    const { mergeErrors } = mergeReport({ allOf: [...groups, clone(groups[0])] })
    expect(mergeErrors.filter((e) => e.message.startsWith("Could not merge combinaries"))).toEqual([])
    const off = mergeReport({ allOf: [...groups, clone(groups[0])] }, { dedupeCombinaryGroups: false })
    expect(off.mergeErrors.some((e) => e.message.includes("4096 combinations"))).toBe(true)
  })

  it("B20.3.5 a group equal to an anyOf group of the other key is not mixed (oneOf vs anyOf)", () => {
    expect(exact({ allOf: [{ oneOf: [S, N] }, { anyOf: [S, N] }] })).toEqual({ oneOf: [S, N], anyOf: [S, N] })
  })
})

describe("B20.4 dropFalseBranches (S10, S11, F3.13)", () => {
  it("B20.4.1 impossible branches are removed, also impossible branches written in the input", () => {
    expect(exact({ oneOf: [S, false, { allOf: [S, N] }, N] })).toEqual({ oneOf: [S, N] })
    expect(exact({ allOf: [{ anyOf: [S, false] }, { minLength: 1 }] })).toEqual({ minLength: 1, anyOf: [S] })
  })

  it("B20.4.2 every branch impossible: the node is a contradiction, container siblings kept (D-10), reported once", () => {
    const data = { $defs: { d: S }, allOf: [{ oneOf: [S, N] }, { oneOf: [B] }] }
    const { result, mergeErrors } = mergeReport(clone(data), { rules: rulesOf("2020-12") })
    expect(result).toEqual({ allOf: [false], $defs: { d: S } })
    expect(mergeErrors.length).toBe(1)
    expect(exact(data, {}, "2020-12")).toEqual({ allOf: [false], $defs: { d: S } })
    expect(exact({ oneOf: [{ allOf: [S, N] }, { allOf: [B, N] }] })).toBe(false)
  })

  it("B20.4.3 an input combinary that is already all-false is a contradiction, not reported (VR-41)", () => {
    const { result, mergeErrors } = mergeReport({ anyOf: [false, false], title: "t" })
    expect(result).toBe(false)
    expect(mergeErrors).toEqual([])
  })

  it("B20.4.4 unsatisfiable: \"not-empty\" branches are dropped too", () => {
    const { result } = mergeReport({ oneOf: [{ allOf: [S, N] }, B] }, { unsatisfiable: "not-empty" })
    expect(result).toEqual({ oneOf: [B] })
  })

  it("B20.4.5 dropFalseBranches: false keeps the documented 0.x/1.0.0-pre contract (impossible branches as false)", () => {
    expect(exact({ oneOf: [S, false, { allOf: [S, N] }, N] }, { dropFalseBranches: false })).toEqual({ oneOf: [S, false, false, N] })
  })

  it("B20.4.6 a $ref into a branch whose index shifts keeps its meaning (a link to the branch's new index, D-27)", () => {
    const doc = {
      definitions: { X: { oneOf: [{ allOf: [S, N] }, { type: "integer" }, B] } },
      properties: { p: { $ref: "#/definitions/X/oneOf/2" }, q: { $ref: "#/definitions/X/oneOf/1" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.X).toEqual({ oneOf: [{ type: "integer" }, B] })
    expect(result.properties.p).toEqual({ $ref: "#/definitions/X/oneOf/1" })
    expect(result.properties.q).toEqual({ $ref: "#/definitions/X/oneOf/0" })
    // a pointer before the removed branch is not shifted and stays a link
    const before = merge({ definitions: { X: { anyOf: [S, { allOf: [S, N] }] } }, properties: { p: { $ref: "#/definitions/X/anyOf/0" } } })
    expect(before.properties.p).toEqual({ $ref: "#/definitions/X/anyOf/0" })
    expect(checkCase({ profile: "draft-07", schema: doc })).toBeUndefined()
  })
})

describe("B20.5 simplify: enum / const by type (S5, F3.9)", () => {
  it("B20.5.1 string / integer members", () => {
    expect(exact({ allOf: [{ type: "string" }, { enum: ["a", 1, null] }] }, SIMPLIFY)).toEqual({ type: "string", enum: ["a"] })
    expect(exact({ allOf: [{ type: "integer" }, { enum: [1.5, 2, "2"] }] }, SIMPLIFY, "draft-07", [2, 1.5])).toEqual({ type: "integer", enum: [2] })
    expect(exact({ allOf: [{ type: ["number", "null"] }, { enum: [1.5, null, true] }] }, SIMPLIFY)).toEqual({ type: ["number", "null"], enum: [1.5, null] })
  })

  it("B20.5.2 empty result and a const of another kind: false", () => {
    expect(exact({ allOf: [{ type: "string" }, { enum: [1, 2] }] }, SIMPLIFY)).toBe(false)
    expect(exact({ allOf: [{ type: "null" }, { const: 0 }] }, SIMPLIFY)).toBe(false)
    expect(exact({ allOf: [{ type: "integer" }, { const: 2 }] }, SIMPLIFY)).toEqual({ type: "integer", const: 2 })
  })

  it("B20.5.3 untyped: unchanged", () => {
    expect(exact({ allOf: [{ enum: ["a", 1] }, { minLength: 1 }] }, SIMPLIFY)).toEqual({ enum: ["a", 1], minLength: 1 })
  })

  it("B20.5.4 OpenAPI 3.0: nullable: true admits a null member; without it null is filtered (D-13)", () => {
    const doc = (schema: unknown) => ({ openapi: "3.0.3", info: { title: "t", version: "1" }, paths: {}, components: { schemas: { A: schema } } })
    const a = merge(doc({ allOf: [{ type: "string", nullable: true }, { enum: ["a", null, 1], nullable: true }] }), { simplify: true }).components.schemas.A
    expect(a).toEqual({ type: "string", nullable: true, enum: ["a", null] })
    const b = merge(doc({ allOf: [{ type: "string" }, { enum: ["a", null] }] }), { simplify: true, rules: openApiMergeRules("3.0.x") }).components.schemas.A
    expect(b).toEqual({ type: "string", enum: ["a"] })
  })

  it("B20.5.5 GraphApi rules are excluded", () => {
    const doc = { graphapi: "0.1.2", components: { objects: { A: { allOf: [{ type: "string" }, { enum: ["a", 1] }] } } } }
    expect(merge(clone(doc), { rules: graphapiMergeRules, simplify: true }).components.objects.A).toEqual({ type: "string", enum: ["a", 1] })
  })
})

describe("B20.6 simplify: bounds contradictions (S6a, S6b, S6c, F3.10)", () => {
  it("B20.6.1 numeric interval empty with a number-only type: false, reported", () => {
    const { result, mergeErrors } = mergeReport({ allOf: [{ type: "number", minimum: 15 }, { maximum: 10 }] }, { simplify: true })
    expect(result).toBe(false)
    expect(mergeErrors.length).toBe(1)
    expect(exact({ allOf: [{ type: "number", exclusiveMinimum: 3 }, { maximum: 3 }] }, SIMPLIFY)).toBe(false)
  })

  it("B20.6.2 integer type, interval without an integer: false; with an integer: unchanged", () => {
    expect(exact({ allOf: [{ type: "integer", exclusiveMinimum: 1 }, { exclusiveMaximum: 2 }] }, SIMPLIFY)).toBe(false)
    expect(exact({ allOf: [{ type: "integer", minimum: 1.2 }, { maximum: 1.8 }] }, SIMPLIFY, "draft-07", [1.5])).toBe(false)
    expect(exact({ allOf: [{ type: "integer", minimum: 1 }, { maximum: 1 }] }, SIMPLIFY)).toEqual({ type: "integer", minimum: 1, maximum: 1 })
    // number admits 1.5: unchanged
    expect(exact({ allOf: [{ type: "number", minimum: 1.2 }, { maximum: 1.8 }] }, SIMPLIFY, "draft-07", [1.5])).toEqual({ type: "number", minimum: 1.2, maximum: 1.8 })
  })

  it("B20.6.3 string lengths, array counts, object counts", () => {
    expect(exact({ allOf: [{ type: "string", minLength: 3 }, { maxLength: 2 }] }, SIMPLIFY)).toBe(false)
    expect(exact({ allOf: [{ type: "array", minItems: 3 }, { maxItems: 2 }] }, SIMPLIFY)).toBe(false)
    expect(exact({ allOf: [{ type: "object", minProperties: 3 }, { maxProperties: 2 }] }, SIMPLIFY)).toBe(false)
    expect(exact({ allOf: [{ type: "object", required: ["a", "b"] }, { maxProperties: 1 }] }, SIMPLIFY)).toBe(false)
  })

  it("B20.6.4 minContains > maxContains with contains (2020-12) is a contradiction; draft-07 ignores the keywords", () => {
    const data = { allOf: [{ type: "array", contains: N, minContains: 3 }, { contains: N, maxContains: 2 }] }
    expect(exact(data, SIMPLIFY, "2020-12")).toBe(false)
    expect(exact(data, SIMPLIFY, "draft-07")).toEqual({ type: "array", contains: N, minContains: 3, maxContains: 2 })
    // a minContains / maxContains of an item without contains restricts nothing (the merge drops it)
    expect(exact({ allOf: [{ type: "array", contains: N, minContains: 3 }, { maxContains: 2 }] }, SIMPLIFY, "2020-12")).toEqual({ type: "array", contains: N, minContains: 3 })
  })

  it("B20.6.5 multi-type: the impossible kind is removed with its bounds (S6b)", () => {
    expect(exact({ allOf: [{ type: ["number", "string"], minimum: 15 }, { maximum: 10 }] }, SIMPLIFY)).toEqual({ type: "string" })
    expect(exact({ allOf: [{ type: ["integer", "string", "null"], minimum: 1.2 }, { maximum: 1.8, minLength: 1 }] }, SIMPLIFY)).toEqual({ type: ["string", "null"], minLength: 1 })
    expect(exact({ allOf: [{ type: ["string", "array"], minLength: 3, minItems: 2 }, { maxLength: 1, maxItems: 1 }] }, SIMPLIFY)).toBe(false)
  })

  it("B20.6.6 untyped contradictions are kept silently (S6c, Q3-4)", () => {
    const { result, mergeErrors } = mergeReport({ allOf: [{ minimum: 15 }, { maximum: 10 }] }, { simplify: true })
    expect(result).toEqual({ minimum: 15, maximum: 10 })
    expect(mergeErrors).toEqual([])
    expect(exact({ allOf: [{ minimum: 15 }, { maximum: 10 }] }, SIMPLIFY, "draft-07", ["x"])).toEqual({ minimum: 15, maximum: 10 })
  })

  it("B20.6.7 the design example: { type: [number, string], minimum: 15 } ∧ { maximum: 10, enum: [a, 12, 20] } → { type: string, enum: [a] }", () => {
    const data = { allOf: [{ type: ["number", "string"], minimum: 15 }, { maximum: 10, enum: ["a", 12, 20] }] }
    expect(exact(data, SIMPLIFY)).toEqual({ type: "string", enum: ["a"] })
    expect(exact(data)).toEqual({ type: ["number", "string"], minimum: 15, maximum: 10, enum: ["a", 12, 20] })
  })

  it("B20.6.8 draft-04 boolean exclusive bounds (OpenAPI 3.0)", () => {
    const doc = { openapi: "3.0.3", info: { title: "t", version: "1" }, paths: {}, components: { schemas: {
      A: { allOf: [{ type: "number", minimum: 3, exclusiveMinimum: true }, { maximum: 3 }] },
      B: { allOf: [{ type: "number", minimum: 3 }, { maximum: 3 }] },
      C: { allOf: [{ type: "number", nullable: true, minimum: 5 }, { maximum: 3, nullable: true }] },
    } } }
    const result = merge(clone(doc), { simplify: true }).components.schemas
    expect(result.A).toBe(false)
    expect(result.B).toEqual({ type: "number", minimum: 3, maximum: 3 })
    // nullable nodes keep their bounds (null is still valid)
    expect(result.C).toEqual({ type: "number", nullable: true, minimum: 5, maximum: 3 })
  })
})

describe("B20.7 simplify: required + false property (S7, F3.11) and contains (S4b, S4c, F3.7, F3.8)", () => {
  it("B20.7.1 typed object: false; untyped: unchanged", () => {
    expect(exact({ allOf: [{ type: "object", required: ["a"] }, { properties: { a: false } }] }, SIMPLIFY)).toBe(false)
    expect(exact({ allOf: [{ type: "object", required: ["a"] }, { properties: { a: { allOf: [S, N] } } }] }, SIMPLIFY)).toBe(false)
    expect(exact({ allOf: [{ required: ["a"] }, { properties: { a: false } }] }, SIMPLIFY, "draft-07", ["x"])).toEqual({ required: ["a"], properties: { a: false } })
  })

  it("B20.7.2 required name that additionalProperties: false rejects (no patternProperties)", () => {
    expect(exact({ allOf: [{ type: "object", required: ["b"] }, { properties: { a: S }, additionalProperties: false }] }, SIMPLIFY)).toBe(false)
    const withPatterns = { allOf: [{ type: "object", required: ["b"] }, { patternProperties: { "^b": S }, additionalProperties: false }] }
    expect(exact(withPatterns, SIMPLIFY, "draft-07", [{ b: "x" }])).not.toBe(false)
  })

  it("B20.7.3 S4b: contains: true / {} → minItems ≥ 1 under draft-07; unchanged under 2020-12 (unevaluatedItems)", () => {
    expect(exact({ allOf: [{ type: "array", contains: true }, { minItems: 0 }] }, SIMPLIFY)).toEqual({ type: "array", minItems: 1 })
    expect(exact({ allOf: [{ contains: {} }, { minItems: 2 }] }, SIMPLIFY)).toEqual({ minItems: 2 })
    expect(exact({ allOf: [{ type: "array", contains: true }, { minItems: 0 }] }, SIMPLIFY, "2020-12")).toEqual({ type: "array", contains: true, minItems: 0 })
  })

  it("B20.7.4 S4c: contains: false with an array-only type → false; with minContains: 0 or untyped unchanged", () => {
    expect(exact({ allOf: [{ type: "array" }, { contains: false }] }, SIMPLIFY)).toBe(false)
    expect(exact({ allOf: [{ type: "array" }, { contains: { allOf: [S, N] } }] }, SIMPLIFY)).toBe(false)
    expect(exact({ allOf: [{ type: "array" }, { contains: false, minContains: 0 }] }, SIMPLIFY, "2020-12", [[], [1]])).toEqual({ type: "array", contains: false, minContains: 0 })
    expect(exact({ allOf: [{ minItems: 0 }, { contains: false }] }, SIMPLIFY, "draft-07", ["x", []])).toEqual({ minItems: 0, contains: false })
  })
})

describe("B20.8 simplify: redundant bounds (S9, F3.12)", () => {
  it.each([
    [{ minimum: 5, exclusiveMinimum: 3 }, { minimum: 5 }],
    [{ minimum: 3, exclusiveMinimum: 5 }, { exclusiveMinimum: 5 }],
    [{ minimum: 5, exclusiveMinimum: 5 }, { exclusiveMinimum: 5 }],
    [{ maximum: 10, exclusiveMaximum: 10 }, { exclusiveMaximum: 10 }],
    [{ maximum: 8, exclusiveMaximum: 10 }, { maximum: 8 }],
    [{ maximum: 12, exclusiveMaximum: 10 }, { exclusiveMaximum: 10 }],
  ])("B20.8.1 %j keeps the tighter bound", (bounds, expected) => {
    const [first, ...rest] = Object.entries(bounds)
    const data = { allOf: [Object.fromEntries([first]), Object.fromEntries(rest)] }
    expect(exact(data, SIMPLIFY, "draft-07", [3, 4, 5, 6, 8, 9, 10, 11])).toEqual(expected)
    expect(exact(data, SIMPLIFY, "2020-12", [3, 5, 10])).toEqual(expected)
  })

  it("B20.8.2 the design example and draft-04 untouched", () => {
    expect(exact({ allOf: [{ minimum: 5, exclusiveMinimum: 3 }, { maximum: 10, exclusiveMaximum: 10 }] }, SIMPLIFY)).toEqual({ minimum: 5, exclusiveMaximum: 10 })
    const draft04 = merge({ allOf: [{ minimum: 5, exclusiveMinimum: true }, { maximum: 10 }] }, { simplify: true, rules: jsonSchemaMergeRules("draft-04") })
    expect(draft04).toEqual({ minimum: 5, exclusiveMinimum: true, maximum: 10 })
  })
})

describe("B20.9 options and counterexamples (F3.14, F3.15)", () => {
  it("B20.9.1 simplify selections: only the selected rules run", () => {
    const data = { allOf: [{ type: ["number", "string"], minimum: 15, exclusiveMinimum: 3 }, { maximum: 10, enum: ["a", 12, 20, true] }] }
    expect(exact(data, { simplify: { enumByType: true } })).toEqual({ type: ["number", "string"], minimum: 15, exclusiveMinimum: 3, maximum: 10, enum: ["a", 12, 20] })
    expect(exact(data, { simplify: { redundantBounds: true } })).toEqual({ type: ["number", "string"], minimum: 15, maximum: 10, enum: ["a", 12, 20, true] })
    expect(exact(data, { simplify: { contradictions: true } })).toEqual({ type: "string", enum: ["a", 12, 20, true] })
    expect(exact(data, { simplify: {} })).toEqual(exact(data))
  })

  it("B20.9.2 the counterexamples are not applied: oneOf twins, contains: true with unevaluatedItems, if without then, untyped bounds", () => {
    expect(exact({ oneOf: [S, N, S] }, SIMPLIFY, "2020-12", ["a"])).toEqual({ oneOf: [S, N, S] })
    const unevaluated = { allOf: [{ type: "array", contains: true }, { unevaluatedItems: false }] }
    expect(exact(unevaluated, SIMPLIFY, "2020-12", [[1], []])).toEqual({ type: "array", contains: true, allOf: [{ unevaluatedItems: false }] })
    expect(exact({ allOf: [{ type: "string" }, { if: { minLength: 3 } }] }, SIMPLIFY)).toEqual({ type: "string", if: { minLength: 3 } })
    expect(exact({ allOf: [{ minLength: 3 }, { maxLength: 2 }] }, SIMPLIFY, "draft-07", [1])).toEqual({ minLength: 3, maxLength: 2 })
  })

  it("B20.9.3 simplify applies to merged nodes only (a written node is not rewritten)", () => {
    expect(merge({ type: "string", enum: ["a", 1] }, { simplify: true })).toEqual({ type: "string", enum: ["a", 1] })
    expect(merge({ properties: { p: { type: "number", minimum: 3, maximum: 1 } }, allOf: [{ minProperties: 0 }] }, { simplify: true }))
      .toEqual({ properties: { p: { type: "number", minimum: 3, maximum: 1 } }, minProperties: 0 })
  })

  it("B20.9.4 a contradiction inside a oneOf branch is dropped, not reported", () => {
    const { result, mergeErrors } = mergeReport({ oneOf: [{ allOf: [{ type: "string" }, { enum: [1] }] }, N] }, { simplify: true })
    expect(result).toEqual({ oneOf: [N] })
    expect(mergeErrors).toEqual([])
  })

  it("B20.9.5 one merger per option set: the memo never mixes results of different options", () => {
    const data = { definitions: { X: { allOf: [{ type: "string" }, { enum: ["a", 1] }] } }, properties: { p: { $ref: "#/definitions/X" } } }
    const plain = createMerger()
    const simple = createMerger({ simplify: true })
    expect((plain.merge(data) as any).definitions.X).toEqual({ type: "string", enum: ["a", 1] })
    expect((simple.merge(data) as any).definitions.X).toEqual({ type: "string", enum: ["a"] })
    expect((plain.merge(data) as any).definitions.X).toEqual({ type: "string", enum: ["a", 1] })
  })

  it("B20.9.6 all safe options off: the former output form", () => {
    const off: MergeOptions = { dedupeAnyOf: false, dedupeFragments: false, dedupeCombinaryGroups: false, dropFalseBranches: false }
    const result = merge({ allOf: [{ oneOf: [S, N, B] }, { oneOf: [S, N, B] }, { oneOf: [S, N, B] }] }, off)
    expect(result.oneOf).toHaveLength(27)
    expect(result.oneOf.filter((branch: unknown) => branch === false)).toHaveLength(24)
  })
})
